'use strict';
// The forum (SPEC §1, §4), main-process side: the forum window on its own session (PARTITION, which keeps the sign-in), the
// hidden worker windows, the inject.js scripts run on the forum's pages, and the import's downloads. main.js registers the
// forum.* channels through register(); this module never calls ipcMain itself.
const { BrowserWindow, dialog, nativeTheme, session, WebContentsView } = require('electron');
const { buildPushScript, describeThreadsScript, postsScript, STATUS_SCRIPT } = require('./inject.js');

const PARTITION = 'persist:daf';
const LOGGED_OUT = { loggedIn: false, memberId: 0, name: null, profileUrl: null };
// A topic URL of any forum (src/thread-url.mjs THREAD_KEY without the project half); isTopicOf adds the site check.
const TOPIC_RE = /^https:\/\/[^/\s]+\/topic\/\d+\S*$/;

const opts = { getSettings: null, icon: undefined, focusApp: null }; // from register()
let forumWin = null;

const forumWebPreferences = () => ({
  partition: PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

// The spinner over the forum window while a page loads, in the app's colours (#1a1a1a / #e6e6e6 dark, white / #1f1f1f light).
const coverPage = (dark) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${dark ? '#1a1a1a' : '#ffffff'};color:${dark ? '#e6e6e6' : '#1f1f1f'};font:13px system-ui,sans-serif}
body{display:grid;place-items:center}div{display:grid;justify-items:center;gap:12px;opacity:.75}
i{width:28px;height:28px;border:3px solid currentColor;border-right-color:transparent;border-radius:50%;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){i{animation:none}}
</style><div><i></i>Loading the forum…</div>`)}`;

/** Lays the spinner over `win` from the start of each main-frame navigation until its page has loaded or failed (the user,
 * 2026-10-27: the sign-in sat on a blank page for about 10 s). A child view, so the forum page itself is never touched. */
function coverWhileLoading(win) {
  const cover = new WebContentsView();
  cover.webContents.loadURL(coverPage(nativeTheme.shouldUseDarkColors)).catch(() => {});
  const wc = win.webContents;
  let on = false;
  const fit = () => {
    const [width, height] = win.getContentSize();
    cover.setBounds({ x: 0, y: 0, width, height });
  };
  const set = (show) => {
    if (show === on || win.isDestroyed()) return;
    on = show;
    if (show) {
      fit();
      win.contentView.addChildView(cover);
    } else win.contentView.removeChildView(cover);
  };
  wc.on('did-start-navigation', (d) => d.isMainFrame && !d.isSameDocument && set(true));
  wc.on('did-finish-load', () => set(false));
  wc.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => isMainFrame && set(false));
  wc.on('did-stop-loading', () => set(false));
  win.on('resize', fit);
  win.on('closed', () => cover.webContents.close());
}

function getForumWindow() {
  if (forumWin && !forumWin.isDestroyed()) return forumWin;
  // Hidden until present(), in the app's background, with the spinner while its pages load.
  const win = new BrowserWindow({ width: 1500, height: 1000, title: 'Forum', icon: opts.icon, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff', webPreferences: forumWebPreferences() });
  coverWhileLoading(win);
  // SSO popups open as child windows; they inherit the opener's session (persist:daf).
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { parent: win } }));
  // A forum beforeunload handler would otherwise silently cancel loadURL and window close (and app.quit).
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'The forum page has unsaved changes. Leave anyway?',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => {
    if (forumWin === win) forumWin = null;
  });
  forumWin = win;
  return win;
}

/** Shows the forum window and brings it forward; the spinner covers it until the page about to load is there. */
function present(win) {
  win.show();
  win.focus();
}

// Loads url and resolves on the main frame's did-finish-load (aborted loads, e.g. redirects, keep waiting).
function loadAndWait(win, url, timeoutMs = 60000) {
  const wc = win.webContents;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      wc.off('did-finish-load', onLoad);
      wc.off('did-fail-load', onFail);
      wc.off('destroyed', onDestroyed);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onFail = (_e, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      cleanup();
      reject(new Error(`could not load ${url}: ${description}`));
    };
    const onDestroyed = () => {
      cleanup();
      reject(new Error('forum window was closed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out loading ${url}`));
    }, timeoutMs);
    wc.on('did-finish-load', onLoad);
    wc.on('did-fail-load', onFail);
    wc.once('destroyed', onDestroyed);
    wc.loadURL(url).catch(() => {});
  });
}

// The forum's origin (settings.forumUrl, set by the first linked forum thread); without one no forum page is ever loaded.
async function forumSite() {
  const s = await opts.getSettings();
  if (!s.forumUrl) throw new Error('No forum is set. Link a forum thread to a project first.');
  return s.forumUrl;
}
// A page of the forum at origin `site`, with or without www. (a forum may redirect to either, and its links are of that one).
const hostOf = (url) => new URL(url).host.toLowerCase().replace(/^www\./, '');
const onForum = (site, url) => typeof url === 'string' && url.startsWith('https://') && URL.canParse(url) && hostOf(url) === hostOf(site);
const isTopicOf = (site, url) => onForum(site, url) && TOPIC_RE.test(url);

// Runs work(webContents) in a hidden window on the forum home page, then destroys the window.
async function withWorker(work, timeoutMs) {
  const site = await forumSite();
  const win = new BrowserWindow({ show: false, webPreferences: forumWebPreferences() });
  let timer;
  try {
    const done = loadAndWait(win, `${site}/`, timeoutMs).then(() => work(win.webContents));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('forum request timed out')), timeoutMs);
    });
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

const runInWorker = (script, timeoutMs) => withWorker((wc) => wc.executeJavaScript(script, true), timeoutMs);

async function forumStatus() {
  try {
    return await runInWorker(STATUS_SCRIPT, 20000);
  } catch (e) {
    return { ...LOGGED_OUT, error: String(e.message || e) };
  }
}

// Title, subject, year and forum of up to 50 topic URLs; topics whose page could not be read are left out.
async function forumDescribe(urls) {
  const site = await forumSite();
  if (!Array.isArray(urls) || urls.length > 50 || !urls.every((u) => isTopicOf(site, u))) throw new Error('urls must be at most 50 forum topic URLs');
  const result = await runInWorker(describeThreadsScript(urls), 45000);
  if (result && result.error) throw new Error(result.error);
  return { threads: (result && result.threads) || [] };
}

/** The signed-in member's own posts in up to 50 topic URLs (docs/plans/onboarding.md Forum import) → {threads: [{url, posts:
 * [{id, url, date, html, media}]} | {url, error}]}: a topic it cannot read is reported, not thrown. Throws when nobody is
 * signed in. */
async function forumPosts(urls) {
  const site = await forumSite();
  if (!Array.isArray(urls) || !urls.length || urls.length > 50 || !urls.every((u) => isTopicOf(site, u))) throw new Error('urls must be 1 to 50 forum topic URLs');
  return withWorker(async (wc) => {
    const status = await wc.executeJavaScript(STATUS_SCRIPT, true);
    if (!status?.loggedIn) throw new Error('Not signed in to the forum. Sign in, then import again.');
    const threads = [];
    for (const url of urls) {
      const r = await wc.executeJavaScript(postsScript(url, status.memberId), true).catch((e) => ({ error: String(e.message || e) }));
      threads.push(r?.posts ? { url, posts: r.posts } : { url, error: r?.error || 'The topic could not be read' });
    }
    return { threads };
  }, 60000 + 180000 * urls.length);
}

// The import's downloads (docs/plans/onboarding.md Forum import): a picture or video of a post, at most DOWNLOADS at a time. A
// file on the forum's host or one under it (its upload host) is fetched with the forum's sign-in (the PARTITION session); any
// other host (a picture linked from elsewhere, or a placeholder pasted or written by an agent) through MEDIA_PARTITION, an
// in-memory session with no cookies. The renderer keeps what is left to fetch in the drafts' placeholders.
const MEDIA_PARTITION = 'forum-media';
const DOWNLOADS = 3;
const MAX_FILE = 100 * 1024 * 1024; // the forum's own limit per file
let downloading = 0;
const waiting = [];
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg' };

/** `url` (https) → {type, data: Uint8Array}; throws on an HTTP error, a file that is no picture or video, or one over 100 MB. */
async function forumDownload(url) {
  if (typeof url !== 'string' || !URL.canParse(url) || new URL(url).protocol !== 'https:') throw new Error('url must be an https URL');
  if (downloading >= DOWNLOADS) await new Promise((resolve) => waiting.push(resolve));
  downloading++;
  try {
    const site = hostOf((await opts.getSettings()).forumUrl || 'https://invalid');
    const host = hostOf(url);
    const signedIn = host === site || host.endsWith(`.${site}`);
    const res = await session.fromPartition(signedIn ? PARTITION : MEDIA_PARTITION).fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10 * 60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_FILE) throw new Error('the file is over 100 MB');
    let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^(image|video)\/[a-z0-9.+-]+$/.test(type)) type = MIME[new URL(url).pathname.split('.').pop().toLowerCase()] || '';
    if (!type) throw new Error('not a picture or video');
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length > MAX_FILE) throw new Error('the file is over 100 MB');
    return { type, data };
  } finally {
    downloading--;
    waiting.shift()?.();
  }
}

async function forumLogin() {
  const site = await forumSite();
  const win = getForumWindow();
  const wc = win.webContents;
  return new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      clearInterval(interval);
      win.off('closed', onClosed);
      if (!wc.isDestroyed()) {
        wc.off('did-finish-load', check);
        wc.off('did-navigate', check);
      }
      resolve(status);
    };
    const check = async () => {
      if (done || wc.isDestroyed()) return;
      try {
        const status = await wc.executeJavaScript(STATUS_SCRIPT, true);
        if (status && status.loggedIn && onForum(site, wc.getURL()) && !done) {
          finish(status);
          // Signed in and back on the forum: the window closes by itself and the app comes back to the front (the user,
          // 2026-10-26: nobody knows to close it).
          win.close();
          opts.focusApp?.();
        }
      } catch {
        // Page mid-navigation; the next tick or load event retries.
      }
    };
    // Closed by stop() (the forum was turned off): no status check loads the forum after that.
    const onClosed = async () => {
      const s = await opts.getSettings().catch(() => null);
      finish(s?.integrations?.forum?.enabled === true ? await forumStatus() : LOGGED_OUT);
    };
    const interval = setInterval(check, 2000);
    win.on('closed', onClosed);
    wc.on('did-finish-load', check);
    wc.on('did-navigate', check);
    present(win);
    wc.loadURL(`${site}/login/`).catch(() => {});
  });
}

async function forumPush(payload) {
  try {
    const site = await forumSite();
    if (!payload || !isTopicOf(site, payload.threadUrl)) {
      return { ok: false, error: 'invalid thread URL' };
    }
    const win = getForumWindow();
    present(win);
    await loadAndWait(win, payload.threadUrl);
    const wc = win.webContents;
    // Logged out → redirected to SSO (never run the draft there) or the guest view.
    if (!onForum(site, wc.getURL()) || !(await wc.executeJavaScript(STATUS_SCRIPT)).loggedIn) {
      return { ok: false, error: 'Not logged in to the forum. Use Log in, then push again.' };
    }
    const script = buildPushScript({ html: String(payload.html ?? ''), images: Array.isArray(payload.images) ? payload.images : [] });
    // executeJavaScript never settles if the page navigates or crashes, so race it against those events.
    let onClosed, onNav, onGone;
    const aborted = new Promise((_, reject) => {
      onClosed = () => reject(new Error('forum window was closed'));
      onNav = (d) => {
        if (d.isMainFrame && !d.isSameDocument) reject(new Error('forum page navigated away during push'));
      };
      onGone = () => reject(new Error('forum page crashed during push'));
      win.once('closed', onClosed);
      wc.on('did-start-navigation', onNav);
      wc.on('render-process-gone', onGone);
    });
    let result;
    try {
      result = await Promise.race([wc.executeJavaScript(script, true), aborted]);
    } finally {
      win.off('closed', onClosed);
      if (!wc.isDestroyed()) {
        wc.off('did-start-navigation', onNav);
        wc.off('render-process-gone', onGone);
      }
    }
    if (!win.isDestroyed()) win.focus();
    return result;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

async function forumOpen(url) {
  const site = await forumSite();
  if (!onForum(site, url)) throw new Error('not a URL of the forum site');
  const win = getForumWindow();
  present(win);
  await loadAndWait(win, url);
  return true;
}

/** Registers the forum.* channels through `handle(channel, fn)` (main.js's sender check). `getSettings` reads settings.json;
 * `icon` is the forum window's icon. */
function register(handle, { getSettings, icon, focusApp }) {
  Object.assign(opts, { getSettings, icon, focusApp });
  handle('forum.status', forumStatus);
  handle('forum.login', forumLogin);
  handle('forum.describe', forumDescribe);
  handle('forum.push', forumPush);
  handle('forum.open', forumOpen);
  handle('forum.posts', forumPosts);
  handle('forum.download', forumDownload);
}

// close(), not destroy(): the forum page's unsaved-reply prompt (will-prevent-unload) still shows.
const stop = () => forumWin?.close();

/** Throws when settings.set `partial` holds a forum value main must not store: forumUrl decides which pages load in the
 * signed-in session, so it is '' or an https origin. */
async function checkSettings(partial) {
  const { forumOrigin } = await import('./topic.mjs');
  if ('forumUrl' in partial && partial.forumUrl !== '' && forumOrigin(partial.forumUrl) !== partial.forumUrl) throw new Error('forumUrl must be an https origin or empty');
}

module.exports = { register, stop, checkSettings, PARTITION, MEDIA_PARTITION };

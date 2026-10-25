'use strict';
// The forum (SPEC §1, §4), main-process side: the forum window on its own session (PARTITION, which keeps the sign-in), the
// hidden worker windows, and the inject.js scripts run on the forum's pages. main.js registers the five forum.* channels
// through register(); this module never calls ipcMain itself.
const { BrowserWindow, dialog } = require('electron');
const { buildPushScript, describeThreadsScript, STATUS_SCRIPT } = require('./inject.js');

const PARTITION = 'persist:daf';
const LOGGED_OUT = { loggedIn: false, memberId: 0, name: null, profileUrl: null };
// A topic URL of any forum (src/thread-url.mjs THREAD_KEY without the project half); isTopicOf adds the site check.
const TOPIC_RE = /^https:\/\/[^/\s]+\/topic\/\d+\S*$/;

const opts = { getSettings: null, icon: undefined }; // from register()
let forumWin = null;

const forumWebPreferences = () => ({
  partition: PARTITION,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

function getForumWindow() {
  if (forumWin && !forumWin.isDestroyed()) return forumWin;
  const win = new BrowserWindow({ width: 1500, height: 1000, title: 'Forum', icon: opts.icon, webPreferences: forumWebPreferences() });
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

// Runs script in a hidden window on the forum home page, then destroys the window.
async function runInWorker(script, timeoutMs) {
  const site = await forumSite();
  const win = new BrowserWindow({ show: false, webPreferences: forumWebPreferences() });
  let timer;
  try {
    const work = loadAndWait(win, `${site}/`, timeoutMs).then(() => win.webContents.executeJavaScript(script, true));
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('forum request timed out')), timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
  }
}

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
        if (status && status.loggedIn && !done) {
          finish(status);
          wc.loadURL(`${site}/`).catch(() => {});
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
    win.show();
    win.focus();
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
    win.show();
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
  win.show();
  win.focus();
  await loadAndWait(win, url);
  return true;
}

/** Registers the forum.* channels through `handle(channel, fn)` (main.js's sender check). `getSettings` reads settings.json;
 * `icon` is the forum window's icon. */
function register(handle, { getSettings, icon }) {
  Object.assign(opts, { getSettings, icon });
  handle('forum.status', forumStatus);
  handle('forum.login', forumLogin);
  handle('forum.describe', forumDescribe);
  handle('forum.push', forumPush);
  handle('forum.open', forumOpen);
}

// close(), not destroy(): the forum page's unsaved-reply prompt (will-prevent-unload) still shows.
const stop = () => forumWin?.close();

/** Throws when settings.set `partial` holds a forum value main must not store: forumUrl decides which pages load in the
 * signed-in session, so it is '' or an https origin. */
async function checkSettings(partial) {
  const { forumOrigin } = await import('./topic.mjs');
  if ('forumUrl' in partial && partial.forumUrl !== '' && forumOrigin(partial.forumUrl) !== partial.forumUrl) throw new Error('forumUrl must be an https origin or empty');
}

module.exports = { register, stop, checkSettings, PARTITION };

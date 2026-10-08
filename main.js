'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const { fileFamily, isPlainObject, readJson, serialized, setAside, writeJsonAtomic } = require('./src/file-family.js');
const { buildPushScript, describeThreadsScript, STATUS_SCRIPT, DISCOVER_SCRIPT } = require('./src/forum-inject.js');
const dictation = require('./src/dictation-main.js');
const assistant = require('./src/assistant-main.js');
const computer = require('./src/computer-main.js');
const chromeSignIn = require('./src/chrome-signin.js');
const agentServer = require('./src/agent-server.js');
const github = require('./src/github-sync.js');
const { autoUpdater } = require('electron-updater');
const fsSync = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const FORUM = 'https://daf.staffs.ac.uk';
const FORUM_URL_RE = /^https:\/\/daf\.staffs\.ac\.uk\//;
const TOPIC_URL_RE = /^https:\/\/daf\.staffs\.ac\.uk\/topic\/\d+[^\s]*$/;
const SMOKE = process.argv.includes('--smoke');
const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const SCRIPT = argValue('script'); // smoke: run this command script (SPEC §8) instead of the sample
const DATA_DIR = argValue('data-dir'); // a profile of its own (smoke:agent's throwaway one); set before ready
// A portable copy (the zip, for PCs that block installers) keeps everything in its own folder. The NSIS install has an
// uninstaller next to the exe and an unzipped copy does not. Dev runs are never portable.
const EXE_DIR = path.dirname(process.execPath);
const PORTABLE = app.isPackaged && !fsSync.existsSync(path.join(EXE_DIR, 'Uninstall EasyWriter.exe'));
const DATA = path.join(EXE_DIR, 'data');
if (DATA_DIR) {
  require('fs').mkdirSync(path.resolve(DATA_DIR), { recursive: true });
  app.setPath('userData', path.resolve(DATA_DIR));
} else if (SCRIPT) { // a script writes drafts and settings (smoke runs destructive steps): never into the real profile
  console.error('--script needs --data-dir=<a throwaway folder>');
  process.exit(1);
} else if (PORTABLE) {
  fsSync.mkdirSync(DATA, { recursive: true });
  app.setPath('userData', DATA);
  app.setPath('sessionData', DATA);
  app.setPath('logs', path.join(DATA, 'logs'));
  app.setPath('crashDumps', path.join(DATA, 'crashes'));
} else {
  const old = path.join(app.getPath('appData'), 'daf-writer'); // the data folder from before the rename to EasyWriter
  if (!fsSync.existsSync(app.getPath('userData')) && fsSync.existsSync(old)) {
    try { fsSync.renameSync(old, app.getPath('userData')); } catch { app.setPath('userData', old); } // still open elsewhere: keep using it
  }
}
const INDEX_FILE = path.join(__dirname, 'index.html');
const INDEX_URL = pathToFileURL(INDEX_FILE).href;
const ICON = path.join(__dirname, 'build', 'icon.ico');
const LOGGED_OUT = { loggedIn: false, memberId: 0, name: null, profileUrl: null };

const DEFAULT_SETTINGS = {
  forumWidth: 1454,
  theme: 'dark',
  baseFont: '',
  baseSize: 100,
  presets: [
    { id: 'p1', name: 'Key term', fontFamily: '', size: 100, color: 'blue', highlight: '', bold: true, italic: false, underline: false },
    { id: 'p2', name: 'Caption', fontFamily: '', size: 90, color: 'soft', highlight: '', bold: false, italic: true, underline: false },
    { id: 'p3', name: 'Highlight', fontFamily: '', size: 100, color: 'root', highlight: 'yellow', bold: false, italic: false, underline: false },
    { id: 'p4', name: 'Statement', fontFamily: '', size: 150, color: 'hard', highlight: '', bold: true, italic: false, underline: false },
  ],
  threads: [],
  selectedThread: null,
  lastDraftId: null,
  historyLimit: 50,
  // Local assistant (docs/plans/agent-automation.md §13.2): installed doubles as enabled; off = nothing runs.
  assistant: {
    installed: false, backend: 'auto', serverPath: '', modelPath: '', mmprojPath: '', serverUrl: '',
    warmAtStart: true, sleepMinutes: 10, idleUnloadMinutes: 30, step: 0, permission: 'standard', uiControl: true, pictureAfterWrite: true,
  },
  agent: { enabled: false, port: agentServer.PORT }, // the MCP server (SPEC §8 Agents): its pipe and http://127.0.0.1:<port>/mcp
  // In-app browser (§7j): the floating pane's state and its opacity (percent) while it does not have the focus.
  browserPane: { open: false, place: null },
  browserIdleOpacity: 70,
  browserNotchFloor: true, // the unfocused pane's notch stays at 40% or more
  browserAutoTab: false, // the browser page opens a Google tab when it has none
  keybinds: {}, // §7k: {bindingId: [chord]} for the bindings changed from their defaults (src/app/keys.mjs)
  github: github.DEFAULTS, // the GitHub backup (SPEC §4b)
  demoSeeded: false, // the demo draft was created on the first start (actions.js init)
};

// SSO providers block embedded browsers: drop the Electron and app tokens from the UA.
app.userAgentFallback = app.userAgentFallback.replace(/ (?:Electron|daf-writer|EasyWriter)\/\S+/g, '');

let mainWin = null;
let forumWin = null;

// ---------------------------------------------------------------------------------------------
// Storage

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const userDir = (name) => () => path.join(app.getPath('userData'), name);

async function getSettings() {
  let stored;
  try {
    stored = await readJson(settingsFile());
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    // Corrupt file: set it aside and start from defaults instead of failing every read and write.
    await setAside(settingsFile());
    stored = null;
  }
  return { ...structuredClone(DEFAULT_SETTINGS), ...(isPlainObject(stored) ? stored : {}) };
}

function setSettings(partial) {
  if (!isPlainObject(partial)) throw new Error('settings must be an object');
  return serialized(async () => {
    const merged = { ...(await getSettings()), ...partial };
    await writeJsonAtomic(settingsFile(), merged);
    if ('keybinds' in partial) refreshKeys(merged);
    if ('agent' in partial && !SMOKE) agentServer.sync(merged); // Settings > Local AI agents turns the gateway on or off live
    if ('github' in partial && !SMOKE) github.configure(merged);
    if (github.SETTINGS_KEYS.some((k) => k in partial)) github.touch();
    return merged;
  });
}

// Drafts (`drafts/<id>.json`, list = summaries), each with its persistent undo history (§7e) next to it.
const drafts = fileFamily(userDir('drafts'), {
  summary: (d) => ({ id: d.id, title: d.title, threadUrl: d.threadUrl ?? null, updated: d.updated, pushedAt: d.pushedAt ?? null }),
  siblings: (id) => [historyFile(id)],
});
const historyFile = (id) => drafts.file(id).replace(/\.json$/, '.history.json');

function saveDraft(draft) {
  if (!isPlainObject(draft)) throw new Error('draft must be an object');
  return drafts.save({ threadUrl: null, pushedAt: null, ...draft }).then(({ id, updated }) => ({ id, updated }));
}

async function loadHistory(id) {
  return readJson(historyFile(id));
}

function saveHistory(id, data) {
  const file = historyFile(id);
  if (data !== null && !isPlainObject(data)) throw new Error('history must be an object or null');
  return serialized(() => writeJsonAtomic(file, data));
}

// Plans (Gantt plan §4) and the flowchart library (flowchart plan §4): main checks the envelope, the renderer the rest.
const MB = 1024 * 1024;
const isThread = (url) => typeof url === 'string' && TOPIC_URL_RE.test(url);

const plans = fileFamily(userDir('plans'), {
  keepPrevious: true,
  maxBytes: 8 * MB,
  validate: (p) => {
    if (!isThread(p.threadUrl)) throw new Error('plan threadUrl must be a forum topic URL');
  },
});

const flows = fileFamily(userDir('flowcharts'), {
  keepPrevious: true,
  maxBytes: 32 * MB, // a board may hold images (data URLs)
  summary: (f) => ({
    id: f.id, threadUrl: f.threadUrl ?? null, title: f.title, created: f.created, updated: f.updated, rev: f.rev,
    items: Array.isArray(f.board?.items) ? f.board.items.length : 0,
  }),
  validate: (f) => {
    if (typeof f.title !== 'string' || f.title.length > 120) throw new Error('flowchart title must be a string of at most 120 characters');
    if (f.threadUrl != null && !isThread(f.threadUrl)) throw new Error('flowchart threadUrl must be null or a forum topic URL');
    if (!isPlainObject(f.board)) throw new Error('flowchart board must be an object');
    if (!Number.isInteger(f.rev) || f.rev < 1) throw new Error('flowchart rev must be an integer of at least 1');
  },
});

// Prefabs (flowchart plan §3.10): the user's own, no thread; the list carries thumbnails but no items.
const prefabs = fileFamily(userDir('prefabs'), {
  keepPrevious: true,
  maxBytes: 32 * MB, // a prefab may hold images (data URLs)
  summary: (p) => ({
    id: p.id, name: p.name, keywords: Array.isArray(p.keywords) ? p.keywords : [], w: p.w, h: p.h,
    items: Array.isArray(p.items) ? p.items.length : 0, thumb: p.thumb ?? null, created: p.created, updated: p.updated,
  }),
  validate: (p) => {
    if (typeof p.name !== 'string' || p.name.length > 80) throw new Error('prefab name must be a string of at most 80 characters');
    if (!Array.isArray(p.items)) throw new Error('prefab items must be an array');
    if (!Number.isFinite(p.w) || !Number.isFinite(p.h)) throw new Error('prefab w and h must be numbers');
  },
});

// ---------------------------------------------------------------------------------------------
// Forum

const forumWebPreferences = () => ({
  partition: 'persist:daf',
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

function getForumWindow() {
  if (forumWin && !forumWin.isDestroyed()) return forumWin;
  const win = new BrowserWindow({ width: 1500, height: 1000, title: 'Digital Academy Forum', icon: ICON, webPreferences: forumWebPreferences() });
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

// Runs script in a hidden window on the forum home page, then destroys the window.
async function runInWorker(script, timeoutMs) {
  const win = new BrowserWindow({ show: false, webPreferences: forumWebPreferences() });
  let timer;
  try {
    const work = loadAndWait(win, `${FORUM}/`, timeoutMs).then(() => win.webContents.executeJavaScript(script, true));
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

async function forumDiscover() {
  const result = await runInWorker(DISCOVER_SCRIPT, 45000);
  if (result && result.error) throw new Error(result.error);
  return { threads: (result && result.threads) || [] };
}

// Title, subject, year and forum of up to 50 topic URLs; topics whose page could not be read are left out.
async function forumDescribe(urls) {
  if (!Array.isArray(urls) || urls.length > 50 || !urls.every(isThread)) throw new Error('urls must be at most 50 forum topic URLs');
  const result = await runInWorker(describeThreadsScript(urls), 45000);
  if (result && result.error) throw new Error(result.error);
  return { threads: (result && result.threads) || [] };
}

function forumLogin() {
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
          wc.loadURL(`${FORUM}/`).catch(() => {});
        }
      } catch {
        // Page mid-navigation; the next tick or load event retries.
      }
    };
    const onClosed = () => {
      forumStatus().then(finish);
    };
    const interval = setInterval(check, 2000);
    win.on('closed', onClosed);
    wc.on('did-finish-load', check);
    wc.on('did-navigate', check);
    win.show();
    win.focus();
    wc.loadURL(`${FORUM}/login/`).catch(() => {});
  });
}

async function forumPush(payload) {
  try {
    if (!payload || typeof payload.threadUrl !== 'string' || !TOPIC_URL_RE.test(payload.threadUrl)) {
      return { ok: false, error: 'invalid thread URL' };
    }
    const win = getForumWindow();
    win.show();
    await loadAndWait(win, payload.threadUrl);
    const wc = win.webContents;
    // Logged out → redirected to SSO (never run the draft there) or the guest view.
    if (new URL(wc.getURL()).origin !== FORUM || !(await wc.executeJavaScript(STATUS_SCRIPT)).loggedIn) {
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
  if (typeof url !== 'string' || !FORUM_URL_RE.test(url)) throw new Error('not a daf.staffs.ac.uk URL');
  const win = getForumWindow();
  win.show();
  win.focus();
  await loadAndWait(win, url);
  return true;
}

// ---------------------------------------------------------------------------------------------
// IPC (only the main window may call; the background window of computer use only reads and saves its own draft)

// The writes of the files the GitHub backup syncs (SPEC §4b): the next tick pushes.
const SYNCED = /^(drafts|plans|flows|prefabs)\.(save|saveHistory|remove)$/;

function handle(channel, fn) {
  if (SYNCED.test(channel)) {
    const write = fn;
    fn = (...args) => {
      github.touch();
      return write(...args);
    };
  }
  ipcMain.handle(channel, (event, ...args) => {
    if (mainWin && event.sender === mainWin.webContents) return fn(...args);
    if (computer.isWorker(event.sender)) return computer.fromWorker(event.sender, channel, args, fn);
    throw new Error('unauthorized sender');
  });
}

handle('settings.get', getSettings);
handle('settings.set', setSettings);
handle('drafts.list', drafts.list);
handle('drafts.load', drafts.load);
handle('drafts.save', saveDraft);
handle('drafts.remove', drafts.remove);
handle('drafts.loadHistory', loadHistory);
handle('drafts.saveHistory', saveHistory);
handle('plans.list', plans.list);
handle('plans.load', plans.load);
handle('plans.save', plans.save);
handle('plans.remove', plans.remove);
handle('flows.list', flows.list);
handle('flows.load', flows.load);
handle('flows.save', flows.save);
handle('flows.remove', flows.remove);
handle('prefabs.list', prefabs.list);
handle('prefabs.load', prefabs.load);
handle('prefabs.save', prefabs.save);
handle('prefabs.remove', prefabs.remove);
handle('forum.status', forumStatus);
handle('forum.login', forumLogin);
handle('forum.discover', forumDiscover);
handle('forum.describe', forumDescribe);
handle('forum.push', forumPush);
handle('forum.open', forumOpen);
// Window zoom by Electron's old View menu step: dir 1 in, -1 out, 0 reset. The renderer sends it for Ctrl+= / Ctrl+- / Ctrl+0
// (the main window has no menu). The window controls scale with the title strip.
handle('window.zoom', (dir) => {
  const wc = mainWin.webContents;
  wc.setZoomLevel(dir ? Math.max(-3, Math.min(5, wc.getZoomLevel() + 0.5 * Math.sign(dir))) : 0);
  mainWin.setTitleBarOverlay({ height: Math.round(TITLE_BAR.height * wc.getZoomFactor()) });
});
// The title strip's colours (#rrggbb, §7): the window controls' background and symbols follow them.
const HEX = /^#[0-9a-f]{6}$/i;
handle('window.titleBar', ({ color, symbolColor } = {}) => {
  if (!HEX.test(color) || !HEX.test(symbolColor)) throw new Error('title bar colours must be #rrggbb');
  mainWin.setTitleBarOverlay({ color, symbolColor });
});
// The page as the user sees it (§8 view.render): the whole window's content as PNG bytes; the renderer crops its viewport.
handle('window.capture', () => mainWin.webContents.capturePage().then((img) => img.toPNG()));
// Push-to-talk dictation (§7h): dictation.status|install|cancel|warm|transcribe, the local whisper server, mic permission.
dictation.register(handle, getSettings, () => mainWin);
// Local assistant (agent-automation plan §13.2): assistant.status|install|cancel|warm|stop|delete|chat|cancelChat, llama-server.
assistant.register(handle, getSettings, () => mainWin, setSettings);
// Computer use (§7i): computer.act|open|close|pane, screenshots and input for this window and the offscreen background window.
computer.register(handle, () => mainWin, { index: INDEX_FILE, preload: path.join(__dirname, 'preload.js') });
// Sign in with Chrome (§7j): a real Chrome/Edge signs in, then its cookies go into persist:browser. See src/chrome-signin.js.
handle('browser.chromeSignIn', () => chromeSignIn.chromeSignIn()); // no renderer arguments reach the flow
// Local AI agents (SPEC §8 Agents): the pipe bin/daf-agent.js (the MCP bridge) connects to; agent.disconnect, agent.ready|reply.
agentServer.register(handle, () => mainWin);
// GitHub backup (SPEC §4b): github.status|login|loginWait|logout|repos|checkRepo|syncNow|start. Before it merges files from GitHub,
// the background window and the renderer save (window.__sync.flush), and the renderer reloads after (window.__sync.reload).
const inRenderer = (js) => (mainWin && !mainWin.isDestroyed() ? mainWin.webContents.executeJavaScript(js, true) : Promise.resolve());
github.register(handle, {
  getSettings,
  setSettings,
  win: () => mainWin,
  // A renderer that does not answer in 15 s counts as not saved (false): nothing is merged, and closing does not wait for it.
  flush: () => Promise.race([computer.close().then(() => inRenderer('window.__sync?.flush()')), new Promise((r) => setTimeout(r, 15000, false))]),
  reload: () => { inRenderer('window.__sync?.reload()').catch(() => {}); },
  busy: (text) => { inRenderer(`window.__sync?.busy(${JSON.stringify(text)})`).catch(() => {}); },
});
let updating = false; // Restart for an update closes the window without the GitHub question
// The renderer saved its draft; the background window saves its own, then a silent install relaunches.
handle('update.install', () => {
  updating = true;
  return computer.close().finally(() => (PORTABLE ? applyPortableUpdate() : autoUpdater.quitAndInstall(true, true))).catch((e) => {
    updating = false;
    throw e;
  });
});

// ---------------------------------------------------------------------------------------------
// In-app browser (§7j): the pages are <webview>s of the main window in persist:browser. A link to a new tab becomes a tab
// (browser.event open); a popup (window.open: SSO logins) is a child window in the same session. The browser's chords pressed in
// a page (the user's keybinds, §7k) go to the renderer, which has the tabs (browser.event key {chord}); so does Ctrl+wheel
// (browser.event zoom). Isolated zoom: a tab's zoom is its own, not its site's.

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  wc.setZoomMode('isolated');
  const send = (ev) => wc.hostWebContents?.send('browser.event', ev);
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'new-window') return { action: 'allow', overrideBrowserWindowOptions: { parent: mainWin } };
    if (/^https?:\/\//i.test(url)) send({ type: 'open', url });
    return { action: 'deny' };
  });
  wc.on('zoom-changed', (_ev, direction) => send({ type: 'zoom', wcId: wc.id, dir: direction === 'in' ? 1 : -1 }));
  wc.on('before-input-event', (event, input) => {
    const chord = input.type === 'keyDown' && keys?.chordOf(input);
    if (!chord || !chords.browser.has(chord)) return;
    event.preventDefault();
    send({ type: 'key', chord, wcId: wc.id });
  });
});

// Keybinds (§7k, src/app/keys.mjs): the chords main acts on, from settings.keybinds; loaded before the window, again on a change.
let keys = null;
let chords = { devtools: new Set(), browser: new Set() };
function refreshKeys(settings) {
  if (!keys) return;
  const b = keys.effective(keys.DEFS, settings.keybinds);
  chords = {
    devtools: new Set(b['app.devtools']),
    browser: new Set(Object.entries(b).filter(([id]) => id.startsWith('browser.')).flatMap(([, c]) => c)),
  };
}
async function loadKeys() {
  keys = await import(pathToFileURL(path.join(__dirname, 'src', 'app', 'keys.mjs')).href);
  refreshKeys(await getSettings());
}

// ---------------------------------------------------------------------------------------------
// Main window

// Custom frame (§4): no native title bar and no menu. The renderer's title strip (34 px with its 1 px bottom border, app.css
// .titlebar) is the drag region; the Window Controls Overlay draws the native minimize / maximize / close buttons over its
// right end, 33 px tall so the border runs on under them. Colours: the always-dark chrome's --background / --foreground until
// the renderer sends the strip's own (window.titleBar).
const TITLE_BAR = { color: '#0a0a0a', symbolColor: '#f5f5f5', height: 33 };

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    title: 'EasyWriter',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: TITLE_BAR,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      webviewTag: true, // the in-app browser (§7j)
    },
  });
  const wc = win.webContents;
  // No menu, so Alt, Alt+key and F10 open nothing. Of its accelerators Blink handles the Edit keys (Ctrl+Z / Y / X / C / V / A)
  // itself and the renderer the window zoom (§7); Reload has no key (it would run beforeunload, which saves and closes the
  // window). DevTools has its keybind (default Ctrl+Shift+I, §7k).
  win.removeMenu();
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && chords.devtools.has(keys?.chordOf(input))) { // the Developer tools keybind (§7k)
      event.preventDefault();
      wc.toggleDevTools();
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event) => {
    if (event.url.split('#')[0] !== INDEX_URL) event.preventDefault();
  });

  wc.on('context-menu', (_event, params) => {
    const template = params.dictionarySuggestions.map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) }));
    if (params.misspelledWord) {
      template.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
    }
    if (template.length) template.push({ type: 'separator' });
    template.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' },
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Logged in to GitHub with the backup on: unpushed changes are pushed (or the user is asked) before the window closes.
  let closeState = null; // 'checking' while it asks or pushes, 'done' once the window may close
  win.on('close', (e) => {
    if (closeState === 'done' || SMOKE || updating || !github.closeCheck()) return;
    e.preventDefault();
    if (closeState) return;
    closeState = 'checking';
    github.beforeClose(win).catch(() => true).then((ok) => {
      closeState = ok ? 'done' : null;
      if (ok) win.close();
    });
  });

  win.on('closed', () => {
    mainWin = null;
    computer.close().finally(() => app.quit()); // the background window saves its draft first
  });
  return win;
}

// Self-update from GitHub Releases (packaged builds only): downloads in the background, installs on quit or on the
// renderer's Restart.
function checkForUpdates() {
  if (PORTABLE) {
    checkPortableUpdate();
    setInterval(checkPortableUpdate, 4 * 60 * 60 * 1000).unref();
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => mainWin?.webContents.send('update.ready', info.version));
  autoUpdater.on('error', (e) => console.error('update', e));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 4 * 60 * 60 * 1000).unref();
}

// Portable copies: electron-updater cannot update a zip, so this downloads the release zip and extracts it into
// data/update/new. On Restart, a script waits for this process to exit and copies the new files over the app folder.
const RELEASES = 'https://github.com/DashingNights/EasyWriter/releases/latest/download/';
const UPDATE_DIR = path.join(DATA, 'update');
let portableBusy = false;
let portableReady = null; // the version waiting in data/update/new

function newerVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function checkPortableUpdate() {
  if (portableBusy || portableReady) return;
  portableBusy = true;
  try {
    // net.fetch uses the system proxy, which school networks often need. The /latest/download/ links have no API rate limit.
    const yml = await (await net.fetch(RELEASES + 'latest.yml')).text();
    const version = /^version:\s*(\S+)/m.exec(yml)?.[1];
    // fs.rmSync, not fs/promises: Electron's patched fs.rm treats the extracted app.asar as a folder and fails.
    if (!version || !newerVersion(version, app.getVersion())) { // up to date: clears what the last update left (the script cannot delete itself)
      fsSync.rmSync(UPDATE_DIR, { recursive: true, force: true });
      return;
    }
    const marker = path.join(UPDATE_DIR, 'version'); // written after a full extraction, so a quit without Restart does not download it again
    if (fsSync.existsSync(marker) && fsSync.readFileSync(marker, 'utf8') === version) {
      portableReady = version;
      mainWin?.webContents.send('update.ready', version);
      return;
    }
    fsSync.rmSync(UPDATE_DIR, { recursive: true, force: true }); // any half download or an older extracted update
    const name = `EasyWriter-${version}-win.zip`;
    const zip = path.join(UPDATE_DIR, name);
    const fresh = path.join(UPDATE_DIR, 'new');
    fsSync.mkdirSync(fresh, { recursive: true });
    const res = await net.fetch(RELEASES + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fsSync.createWriteStream(zip));
    const at = yml.indexOf(`url: ${name}`);
    const sha512 = at < 0 ? null : /sha512:\s*(\S+)/.exec(yml.slice(at))?.[1];
    if (sha512) {
      const hash = crypto.createHash('sha512');
      for await (const chunk of fsSync.createReadStream(zip)) hash.update(chunk);
      if (hash.digest('base64') !== sha512) throw new Error(`${name} is damaged (checksum mismatch)`);
    }
    await new Promise((resolve, reject) => {
      // Windows' own bsdtar reads zip files (a Git Bash tar on PATH would not).
      execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', fresh], { windowsHide: true }, (e) => (e ? reject(e) : resolve()));
    });
    fsSync.writeFileSync(marker, version);
    portableReady = version;
    mainWin?.webContents.send('update.ready', version);
  } catch (e) {
    console.error('update', e);
  } finally {
    portableBusy = false;
  }
}

// Runs after the background window saved its draft. The script waits up to a minute until it can open EasyWriter.exe
// for writing, which is when every process of this copy has exited. The detached cmd has no console, so tasklist, find
// and timeout do not work in it. The paths are relative to the script (%~dp0 is data\update\), because cmd misreads a
// batch file with non-ASCII text in it (a user name like José).
function applyPortableUpdate() {
  const script = path.join(UPDATE_DIR, 'apply.cmd');
  fsSync.writeFileSync(script, [
    '@echo off',
    'set tries=0',
    ':wait',
    '2>nul (>>"%~dp0..\\..\\EasyWriter.exe" echo off) && goto copy',
    'set /a tries+=1',
    'if %tries% geq 60 goto run', // still locked after a minute (an agent bridge, a relaunch): relaunch untouched, the next start offers it again
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':copy',
    'robocopy "%~dp0new" "%~dp0..\\.." /E /XD "%~dp0.." /R:10 /W:3 /NFL /NDL /NJH /NJS /NP >nul',
    ':run',
    'start "" "%~dp0..\\..\\EasyWriter.exe"',
    '',
  ].join('\r\n'));
  // shell: true runs cmd /d /s /c with the quotes kept, so a folder like "EasyWriter (1)" works.
  spawn(`"${script}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  app.quit();
}

// ---------------------------------------------------------------------------------------------
// Smoke mode: render the sample doc, write outputs into process.cwd(), exit.

function runSmoke(win) {
  const outDir = process.cwd();
  setTimeout(() => app.exit(2), 60000);
  win.webContents.once('did-finish-load', async () => {
    try {
      if (SCRIPT) return await runScript(win, outDir);
      const result = await win.webContents.executeJavaScript('window.__smoke()', true);
      const images = result.images || [];
      const summary = {
        ...result,
        images: images.map(({ base64, ...rest }) => ({ ...rest, base64: Buffer.from(base64, 'base64').length })),
      };
      await fs.writeFile(path.join(outDir, 'smoke-output.json'), JSON.stringify(summary, null, 2));
      for (const [i, image] of images.entries()) await fs.writeFile(path.join(outDir, `smoke-wb-${i}.png`), Buffer.from(image.base64, 'base64'));
      const shot = await win.webContents.capturePage();
      await fs.writeFile(path.join(outDir, 'smoke-ui.png'), shot.toPNG());
      app.exit(0);
    } catch (e) {
      await fs.writeFile(path.join(outDir, 'smoke-error.txt'), String((e && e.stack) || e)).catch(() => {});
      app.exit(1);
    }
  });
}

// --script=<file>: window.__agent.script(steps) once the app has started; per-step {req, res, pass} into smoke-agent.json;
// exit 1 when a step fails its expect. Drafts persist into the data dir (only __smoke() sets state.smoke).
// A step {"shot": "<file>.png"} (docs/screenshots.json, npm run shots) saves the 1440 x 900 window as that file: the steps
// before it run as one script, so "$steps[n]" counts from the last shot.
async function runScript(win, outDir) {
  const steps = JSON.parse(await fs.readFile(path.resolve(SCRIPT), 'utf8'));
  if (steps.some((s) => s.shot)) win.setContentSize(1440, 900);
  const out = [];
  for (let rest = steps; ;) {
    const i = rest.findIndex((s) => s.shot);
    out.push(...await win.webContents.executeJavaScript(`(async () => {
      while (!window.__agent) await new Promise((r) => setTimeout(r, 50));
      return window.__agent.script(${JSON.stringify(i < 0 ? rest : rest.slice(0, i))});
    })()`, true));
    if (i < 0) break;
    await new Promise((r) => setTimeout(r, 1000)); // pictures decoded and charts laid out before the capture
    await fs.writeFile(path.join(outDir, rest[i].shot), (await win.webContents.capturePage()).toPNG());
    rest = rest.slice(i + 1);
  }
  await fs.writeFile(path.join(outDir, 'smoke-agent.json'), JSON.stringify(out, null, 2));
  app.exit(out.every((s) => s.pass) ? 0 : 1);
}

// One instance only: two processes would overwrite each other's drafts and settings. Smoke never saves.
app.setAppUserModelId('com.dashingnights.easywriter');
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
  app.whenReady().then(async () => {
    await loadKeys();
    // Electron grants every permission by default; forum pages and their popups get none beyond these.
    const allowed = (p) => ['clipboard-sanitized-write', 'fullscreen'].includes(p);
    // The in-app browser's pages (§7j, persist:browser) get the same.
    for (const s of [session.fromPartition('persist:daf'), session.fromPartition('persist:browser')]) {
      s.setPermissionRequestHandler((_wc, p, cb) => cb(allowed(p)));
      s.setPermissionCheckHandler((_wc, p) => allowed(p));
    }
    mainWin = createMainWindow();
    if (SMOKE) {
      mainWin.showInactive();
      runSmoke(mainWin);
    } else {
      mainWin.once('ready-to-show', () => {
        mainWin.show();
        dictation.warmAtStart();
        setTimeout(() => assistant.autoWarm(), 10000); // §13.2 Warm-up and idle: after whisper, once the window has painted
        if (app.isPackaged) checkForUpdates();
      });
      agentServer.sync(await getSettings());
      github.configure(await getSettings());
    }
    mainWin.loadFile(INDEX_FILE, SMOKE && !SCRIPT ? { query: { smoke: '1' } } : {});
  });
}

'use strict';
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const { externalize, fileFamily, inline, isPlainObject, readJson, serialized, setAside, writeJsonAtomic } = require('./src/file-family.js');
const { buildPushScript, describeThreadsScript, STATUS_SCRIPT } = require('./src/forum-inject.js');
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

// What drafts, plans and flowcharts link to (src/thread-url.mjs): a topic URL of any forum (the forum site can change) or a project.
const THREAD_KEY_RE = /^(?:https:\/\/[^/\s]+\/topic\/\d+\S*|project:[0-9a-f-]{36})$/;
const threadUrl = import('./src/thread-url.mjs');
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
  // The data folder from before the rename to EasyWriter. Electron creates the new folder (empty) before this runs, so the
  // check is for settings.json, and the entries move one by one. A locked entry (that copy still open) moves everything back.
  const target = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'daf-writer');
  if (!fsSync.existsSync(path.join(target, 'settings.json')) && fsSync.existsSync(path.join(old, 'settings.json'))) {
    const moved = [];
    try {
      for (const name of fsSync.readdirSync(old)) {
        fsSync.rmSync(path.join(target, name), { recursive: true, force: true });
        fsSync.renameSync(path.join(old, name), path.join(target, name));
        moved.push(name);
      }
      fsSync.rmSync(old, { recursive: true, force: true });
    } catch {
      for (const name of moved) { try { fsSync.renameSync(path.join(target, name), path.join(old, name)); } catch {} }
      app.setPath('userData', old);
    }
  }
}
const INDEX_FILE = path.join(__dirname, 'index.html');
const INDEX_URL = pathToFileURL(INDEX_FILE).href;
const ICON = app.isPackaged ? undefined : path.join(__dirname, 'build', 'icon.ico'); // packaged: Windows takes the exe's icon; an .ico inside app.asar does not load
const LOGGED_OUT = { loggedIn: false, memberId: 0, name: null, profileUrl: null };

const DEFAULT_SETTINGS = {
  forumWidth: 1454,
  theme: 'light',
  baseFont: '',
  baseSize: 100,
  presets: [
    { id: 'p1', name: 'Key term', fontFamily: '', size: 100, color: 'blue', highlight: '', bold: true, italic: false, underline: false },
    { id: 'p2', name: 'Caption', fontFamily: '', size: 90, color: 'soft', highlight: '', bold: false, italic: true, underline: false },
    { id: 'p3', name: 'Highlight', fontFamily: '', size: 100, color: 'root', highlight: 'yellow', bold: false, italic: false, underline: false },
    { id: 'p4', name: 'Statement', fontFamily: '', size: 150, color: 'hard', highlight: '', bold: true, italic: false, underline: false },
  ],
  forumUrl: '', // the Invision Community site (https origin) of the projects' forum threads: its sign-in and Push; '' = none
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
  autoUpdate: false, // updates download in the background and install on quit; off: the update toast offers them (checkForUpdates)
  uiScale: 0, // the main window's zoom level (Settings > General UI scale, Ctrl+= / Ctrl+- / Ctrl+0): applyUiScale
};

// SSO providers block embedded browsers: drop the Electron and app tokens from the UA.
app.userAgentFallback = app.userAgentFallback.replace(/ (?:Electron|daf-writer|EasyWriter)\/\S+/g, '');

let mainWin = null;
let forumWin = null;

// ---------------------------------------------------------------------------------------------
// Storage

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const userDir = (name) => () => path.join(app.getPath('userData'), name);
const images = userDir('images'); // the records' pictures, one file each (src/file-family.js externalize)

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
  const { migrateSettings } = await threadUrl;
  return { ...structuredClone(DEFAULT_SETTINGS), ...(isPlainObject(stored) ? migrateSettings(stored) : {}) };
}

function setSettings(partial) {
  if (!isPlainObject(partial)) throw new Error('settings must be an object');
  return serialized(async () => {
    const { forumOrigin } = await threadUrl;
    if ('forumUrl' in partial && partial.forumUrl !== '' && forumOrigin(partial.forumUrl) !== partial.forumUrl) throw new Error('forumUrl must be an https origin or empty');
    if ('uiScale' in partial) partial = { ...partial, uiScale: zoomLevel(partial.uiScale) };
    const merged = { ...(await getSettings()), ...partial };
    await writeJsonAtomic(settingsFile(), merged);
    if ('uiScale' in partial) applyUiScale(mainWin, merged.uiScale);
    if ('keybinds' in partial) refreshKeys(merged);
    // Settings > MCP turns the gateway on or off live; the assistant on Claude Code or Codex keeps its pipe open
    if (('agent' in partial || 'assistant' in partial) && !SMOKE) agentServer.sync(merged);
    if ('github' in partial && !SMOKE) github.configure(merged);
    if ('autoUpdate' in partial) applyAutoUpdate(merged.autoUpdate);
    if (github.SETTINGS_KEYS.some((k) => k in partial)) github.touch();
    return merged;
  });
}

// Drafts (`drafts/<id>.json`, list = summaries), each with its persistent undo history (§7e) next to it.
const drafts = fileFamily(userDir('drafts'), {
  summary: (d) => ({ id: d.id, title: d.title, threadUrl: d.threadUrl ?? null, updated: d.updated, pushedAt: d.pushedAt ?? null }),
  siblings: (id) => [historyFile(id)],
  images,
});
const historyFile = (id) => drafts.file(id).replace(/\.json$/, '.history.json');

function saveDraft(draft) {
  if (!isPlainObject(draft)) throw new Error('draft must be an object');
  return drafts.save({ threadUrl: null, pushedAt: null, ...draft }).then(({ id, updated }) => ({ id, updated }));
}

async function loadHistory(id) {
  const data = await readJson(historyFile(id));
  return data && inline(images(), data);
}

function saveHistory(id, data) {
  const file = historyFile(id);
  if (data !== null && !isPlainObject(data)) throw new Error('history must be an object or null');
  return serialized(async () => writeJsonAtomic(file, data && (await externalize(images(), data))));
}

// Plans (Gantt plan §4) and the flowchart library (flowchart plan §4): main checks the envelope, the renderer the rest.
const MB = 1024 * 1024;
const isThread = (url) => typeof url === 'string' && THREAD_KEY_RE.test(url);

const plans = fileFamily(userDir('plans'), {
  keepPrevious: true,
  maxBytes: 8 * MB,
  images,
  validate: (p) => {
    if (!isThread(p.threadUrl)) throw new Error('plan threadUrl must be a forum topic URL or a project key');
  },
});

const flows = fileFamily(userDir('flowcharts'), {
  keepPrevious: true,
  maxBytes: 32 * MB, // without its pictures, which are files of their own
  images,
  summary: (f) => ({
    id: f.id, threadUrl: f.threadUrl ?? null, title: f.title, created: f.created, updated: f.updated, rev: f.rev,
    items: Array.isArray(f.board?.items) ? f.board.items.length : 0,
  }),
  validate: (f) => {
    if (typeof f.title !== 'string' || f.title.length > 120) throw new Error('flowchart title must be a string of at most 120 characters');
    if (f.threadUrl != null && !isThread(f.threadUrl)) throw new Error('flowchart threadUrl must be null, a forum topic URL or a project key');
    if (!isPlainObject(f.board)) throw new Error('flowchart board must be an object');
    if (!Number.isInteger(f.rev) || f.rev < 1) throw new Error('flowchart rev must be an integer of at least 1');
  },
});

// Prefabs (flowchart plan §3.10): the user's own, no thread; the list carries thumbnails but no items.
const prefabs = fileFamily(userDir('prefabs'), {
  keepPrevious: true,
  maxBytes: 32 * MB, // without its pictures, which are files of their own
  images,
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
  const win = new BrowserWindow({ width: 1500, height: 1000, title: 'Forum', icon: ICON, webPreferences: forumWebPreferences() });
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
  const s = await getSettings();
  if (!s.forumUrl) throw new Error('No forum is set. Link a forum thread to a project first.');
  return s.forumUrl;
}
// A page of the forum at origin `site`, with or without www. (a forum may redirect to either, and its links are of that one).
const hostOf = (url) => new URL(url).host.toLowerCase().replace(/^www\./, '');
const onForum = (site, url) => typeof url === 'string' && url.startsWith('https://') && URL.canParse(url) && hostOf(url) === hostOf(site);
const isTopicOf = (site, url) => onForum(site, url) && THREAD_KEY_RE.test(url);

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
    const onClosed = () => {
      forumStatus().then(finish);
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
handle('forum.describe', forumDescribe);
handle('forum.push', forumPush);
handle('forum.open', forumOpen);
// Window zoom (settings.uiScale): a Chromium zoom level in Electron's old View menu steps of 0.5, -3…5 (0 = 100 %). The window
// controls scale with the title strip.
const zoomLevel = (v) => Math.max(-3, Math.min(5, Math.round(Number(v) * 2) / 2 || 0));
function applyUiScale(win, level) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomLevel(zoomLevel(level));
  win.setTitleBarOverlay({ height: Math.round(TITLE_BAR.height * win.webContents.getZoomFactor()) });
}
// dir 1 in, -1 out, 0 reset: the renderer sends it for Ctrl+= / Ctrl+- / Ctrl+0 (the main window has no menu). Saved as
// settings.uiScale, so Settings shows it and the next start opens at it. → the new settings.
handle('window.zoom', (dir) => setSettings({ uiScale: dir ? mainWin.webContents.getZoomLevel() + 0.5 * Math.sign(dir) : 0 }));
// The title strip's colours (#rrggbb, §7): the window controls' background and symbols follow them.
const HEX = /^#[0-9a-f]{6}$/i;
handle('window.titleBar', ({ color, symbolColor } = {}) => {
  if (!HEX.test(color) || !HEX.test(symbolColor)) throw new Error('title bar colours must be #rrggbb');
  mainWin.setTitleBarOverlay({ color, symbolColor });
});
// The page as the user sees it (§8 view.render): the whole window's content as PNG bytes; the renderer crops its viewport.
handle('window.capture', () => mainWin.webContents.capturePage().then((img) => img.toPNG()));
// The draft menu's entries on the last right-click (editMenuAct): native | learn (Add to dictionary) | copyLink | an edit command.
handle('editMenu.act', (act) => menuParams && editMenuAct(act));
// Push-to-talk dictation (§7h): dictation.status|install|cancel|warm|transcribe, the local whisper server, mic permission.
dictation.register(handle, getSettings, () => mainWin);
// Local assistant (agent-automation plan §13.2): assistant.status|install|cancel|warm|stop|delete|chat|cancelChat, llama-server.
assistant.register(handle, getSettings, () => mainWin, setSettings);
// Computer use (§7i): computer.act|open|close|pane, screenshots and input for this window and the offscreen background window.
computer.register(handle, () => mainWin, { index: INDEX_FILE, preload: path.join(__dirname, 'preload.js') });
// Sign in with Chrome (§7j): a real Chrome/Edge signs in, then its cookies go into persist:browser. See src/chrome-signin.js.
handle('browser.chromeSignIn', () => chromeSignIn.chromeSignIn()); // no renderer arguments reach the flow
// Local AI agents (SPEC §8 Agents): the pipe bin/easywriter-agent.js (the MCP bridge) connects to; agent.disconnect, agent.ready|reply.
agentServer.register(handle, () => mainWin, getSettings);
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
// The update toast's download: resolves once the update is ready to install (update.event progress meanwhile).
handle('update.download', () => (PORTABLE ? downloadPortable() : autoUpdater.downloadUpdate()));
// The renderer saved its draft; the background window saves its own, then a silent install relaunches.
handle('update.install', () => {
  updating = true;
  assistant.killRuns();
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
  // Right-click: link / image items, Back / Forward / Reload on the bare page, then the edit menu.
  wc.on('context-menu', (_event, params) => {
    const extra = [];
    if (params.linkURL) {
      extra.push(
        { label: 'Open link in new tab', click: () => send({ type: 'open', url: params.linkURL }) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      );
    }
    if (params.mediaType === 'image') {
      extra.push(
        { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      );
    }
    if (!extra.length && !params.isEditable && !params.selectionText) {
      const nav = wc.navigationHistory;
      extra.push(
        { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
        { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
        { label: 'Reload', click: () => wc.reload() },
      );
    }
    popupEditMenu(wc, params, mainWin, extra);
  });
  wc.on('before-input-event', (event, input) => {
    const chord = input.type === 'keyDown' && keys?.chordOf(input);
    if (!chord || !chords.browser.has(chord)) return;
    event.preventDefault();
    send({ type: 'key', chord, wcId: wc.id });
  });
});

// The main window's right-click: main sends its spelling and edit state to the renderer (editMenu.open), which shows the draft
// menu over the editor area (DraftMenu.jsx) and asks for the native menu anywhere else (editMenu.act 'native').
let menuParams = null; // the main window's last right-click
const EDIT_ACTS = ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'];
function editMenuAct(act) {
  const wc = mainWin.webContents;
  if (act === 'native') popupEditMenu(wc, menuParams, mainWin);
  else if (act === 'learn' && menuParams.misspelledWord) wc.session.addWordToSpellCheckerDictionary(menuParams.misspelledWord);
  else if (act === 'copyLink' && menuParams.linkURL) clipboard.writeText(menuParams.linkURL);
  else if (EDIT_ACTS.includes(act)) wc[act]();
}

// Native right-click menu (main window and browser pages): `extra` items, spelling suggestions, then Cut / Copy / Paste / Select
// All on `wc` (explicit, so a page's menu acts on the page, not the focused window's own webContents).
function popupEditMenu(wc, params, win, extra = []) {
  const template = [...extra];
  if (template.length) template.push({ type: 'separator' });
  for (const word of params.dictionarySuggestions) template.push({ label: word, click: () => wc.replaceMisspelling(word) });
  if (params.misspelledWord) {
    template.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) });
  }
  if (template.length && template.at(-1).type !== 'separator') template.push({ type: 'separator' });
  template.push(
    { label: 'Cut', enabled: params.editFlags.canCut, click: () => wc.cut() },
    { label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() },
    { label: 'Paste', enabled: params.editFlags.canPaste, click: () => wc.paste() },
    { label: 'Select All', click: () => wc.selectAll() },
  );
  Menu.buildFromTemplate(template).popup({ window: win });
}

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
    menuParams = params;
    const { misspelledWord, dictionarySuggestions: suggestions, linkURL, editFlags } = params;
    wc.send('editMenu.open', { misspelledWord, suggestions, linkURL, editFlags });
  });
  wc.on('did-finish-load', () => getSettings().then((s) => applyUiScale(win, s.uiScale)));
  // A reload (GitHub sync) or a crash leaves no chat panel to stop the assistant's CLI runs.
  wc.on('did-navigate', assistant.killRuns);
  wc.on('render-process-gone', assistant.killRuns);

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

// Self-update from GitHub Releases (packaged builds only): checks at start and every 4 hours. update.event tells the renderer
// {type: 'available', version} (settings.autoUpdate off: the toast offers it and update.download fetches it), {type: 'progress',
// percent} while downloading and {type: 'ready', version} once a background download is done (autoUpdate on: installs on quit or
// on the renderer's Restart).
// The last offer or ready event is kept: update.last replays it to a renderer that subscribed after it was sent.
let lastUpdate = null;
const sendUpdate = (ev) => {
  if (ev.type !== 'progress') lastUpdate = ev;
  mainWin?.webContents.send('update.event', ev);
};
handle('update.last', () => lastUpdate);
let checkUpdate = null; // set by checkForUpdates
function checkForUpdates() {
  checkUpdate = PORTABLE ? checkPortableUpdate : () => autoUpdater.checkForUpdates().catch(() => {});
  if (!PORTABLE) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false; // until applyAutoUpdate reads the setting
    autoUpdater.on('update-available', async (info) => {
      if ((await getSettings()).autoUpdate) autoUpdater.downloadUpdate().then(() => sendUpdate({ type: 'ready', version: info.version }), () => {});
      else sendUpdate({ type: 'available', version: info.version });
    });
    autoUpdater.on('download-progress', (p) => sendUpdate({ type: 'progress', percent: p.percent }));
    autoUpdater.on('error', (e) => console.error('update', e));
  }
  getSettings().then((s) => applyAutoUpdate(s.autoUpdate));
  checkUpdate();
  setInterval(checkUpdate, 4 * 60 * 60 * 1000).unref();
}

// Settings > General's switch applies live: on checks again, so a waiting update downloads now.
function applyAutoUpdate(on) {
  if (!checkUpdate) return;
  if (!PORTABLE) autoUpdater.autoInstallOnAppQuit = !!on;
  if (on) checkUpdate();
}

// Portable copies: electron-updater cannot update a zip, so this downloads the release zip and extracts it into
// data/update/new. On Restart, a script waits for this process to exit and copies the new files over the app folder.
const RELEASES = 'https://github.com/DashingNights/EasyWriter/releases/latest/download/';
const UPDATE_DIR = path.join(DATA, 'update');
let portableBusy = false;
let portableReady = null; // the version waiting in data/update/new
let portableOffer = null; // {version, yml} of the newer release not downloaded yet
let portableDownload = null; // the download under way

function newerVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function checkPortableUpdate() {
  if (portableBusy || portableDownload || portableReady) return;
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
      sendUpdate({ type: 'ready', version });
      return;
    }
    portableOffer = { version, yml };
    if ((await getSettings()).autoUpdate) {
      await downloadPortable();
      sendUpdate({ type: 'ready', version });
    } else sendUpdate({ type: 'available', version });
  } catch (e) {
    console.error('update', e);
  } finally {
    portableBusy = false;
  }
}

// Downloads and extracts portableOffer into data/update/new. Throws on a failure, which leaves the app as it was.
function downloadPortable() {
  if (portableReady) return Promise.resolve();
  if (!portableOffer) return Promise.reject(new Error('No update to download'));
  return portableDownload ??= (async () => {
    const { version, yml } = portableOffer;
    fsSync.rmSync(UPDATE_DIR, { recursive: true, force: true }); // any half download or an older extracted update
    const name = `EasyWriter-${version}-win.zip`;
    const zip = path.join(UPDATE_DIR, name);
    const fresh = path.join(UPDATE_DIR, 'new');
    const marker = path.join(UPDATE_DIR, 'version');
    fsSync.mkdirSync(fresh, { recursive: true });
    const res = await net.fetch(RELEASES + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let got = 0;
    let sent = -1;
    await pipeline(Readable.fromWeb(res.body), async function* (chunks) {
      for await (const chunk of chunks) {
        got += chunk.length;
        const percent = total ? Math.floor((got * 100) / total) : 0;
        if (percent !== sent) sendUpdate({ type: 'progress', percent: (sent = percent) });
        yield chunk;
      }
    }, fsSync.createWriteStream(zip));
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
  })().catch((e) => {
    console.error('update', e);
    throw e;
  }).finally(() => { portableDownload = null; });
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
// A step {"shot": "<file>.png"} (docs/screenshots.json, npm run shots) saves the 1600 x 900 window as that file: the steps
// before it run as one script, so "$steps[n]" counts from the last shot. It waits 1 s first, or "wait" ms (a notice fading out).
async function runScript(win, outDir) {
  const steps = JSON.parse(await fs.readFile(path.resolve(SCRIPT), 'utf8'));
  if (steps.some((s) => s.shot)) { // the window shows inactive, so focusin never fires and the board tools never take over: emulate the focus
    win.setContentSize(1600, 900);
    try { win.webContents.debugger.attach(); } catch {}
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  }
  const out = [];
  for (let rest = steps; ;) {
    const i = rest.findIndex((s) => s.shot);
    out.push(...await win.webContents.executeJavaScript(`(async () => {
      while (!window.__agent) await new Promise((r) => setTimeout(r, 50));
      return window.__agent.script(${JSON.stringify(i < 0 ? rest : rest.slice(0, i))});
    })()`, true));
    if (i < 0) break;
    await new Promise((r) => setTimeout(r, rest[i].wait ?? 1000)); // pictures decoded and charts laid out before the capture
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

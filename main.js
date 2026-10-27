'use strict';
const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const { externalize, fileFamily, inline, isPlainObject, readJson, serialized, setAside, writeJsonAtomic } = require('./src/file-family.js');
const dictation = require('./src/dictation-main.js');
const assistant = require('./src/assistant-main.js');
const computer = require('./src/computer-main.js');
const { draftMarks } = require('./src/draft-marks.js');
const chromeSignIn = require('./src/chrome-signin.js');
const agentServer = require('./src/agent-server.js');
const github = require('./src/github-sync.js');
const forum = require('./src/integrations/forum/main.js');
const { autoUpdater } = require('electron-updater');
const fsSync = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// What drafts, plans and flowcharts link to (src/thread-url.mjs): a topic URL of any forum (the forum site can change) or a project.
const THREAD_KEY_RE = /^(?:https:\/\/[^/\s]+\/topic\/\d+\S*|project:[0-9a-f-]{36})$/;
const integrations = import('./src/integrations/index.mjs');
const SMOKE = process.argv.includes('--smoke');
const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const SCRIPT = argValue('script'); // smoke: run this command script (SPEC §8) instead of the sample
const DATA_DIR = argValue('data-dir'); // a profile of its own (smoke:agent's throwaway one); set before ready
// A portable copy (the zip, for PCs that block installers) keeps everything in its own folder. The NSIS install has an
// uninstaller next to the exe and an unzipped copy does not. Dev runs are never portable.
const EXE_DIR = path.dirname(process.execPath);
const PORTABLE = app.isPackaged && !fsSync.existsSync(path.join(EXE_DIR, 'Uninstall EasyWriter.exe'));
const DATA = path.join(EXE_DIR, 'data');
// Test runs (smoke, and harnesses with a throwaway --data-dir) stay behind the user's windows (src/test-window.js).
const testWindow = (SMOKE || DATA_DIR) && require('./src/test-window.js');
if (testWindow) testWindow.prepare();
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

// The integrations add theirs (src/integrations/index.mjs DEFAULTS: the forum's forumUrl and forumWidth, all switched off).
const DEFAULT_SETTINGS = {
  theme: 'light', // the core page theme (Settings > General Page theme)
  pageWidth: 1454, // the core page's content width, 320-4000 (src/formats.mjs PAGE; Settings > General Page width)
  paper: 'a4', // a new Document's paper, per device: 'letter' or 'a4' from the Windows region (localPaper, at read)
  lastFormat: 'document', // the New draft dialog's last pick, preselected next time, per device (src/formats.mjs defaultFormat)
  uiTheme: 'system', // the app's own colours (Settings > General Theme): dark | light | system (actions.js applyUiTheme)
  palette: {}, // {dark, light}: the user's colours over each theme's (Settings > General Palette, actions.js PALETTE)
  reduceMotion: 'system', // Settings > Motion: off | system | on | custom (src/app/motion.js)
  motion: {}, // {name: false} turns one animation off when reduceMotion is custom (src/app/motion.js MOTION)
  defaultTag: 'todo', // the tag a new draft gets on its first save ('' none; Settings > Tags, drafts-meta.js defaultTag)
  hideBackupWarning: false, // the sidebar's red warning of a GitHub backup that is not set up is turned off (Sidebar.jsx BackupWarning)
  layersPanel: true, // a board's layers panel shows its rows; off: only its title bar (LayersPanel.jsx toggleLayers)
  spellCheck: true, // the main window's spell checker (the status bar's Spell check button; session.setSpellCheckerEnabled)
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
    warmAtStart: true, sleepMinutes: 10, idleUnloadMinutes: 30, step: 0, permission: 'standard', uiControl: true, pictureAfterWrite: true, humanWriting: true,
    autoApproveEdits: false, // off: agent edits wait in the draft as suggestions (docs/plans/suggestions.md); read as === true
  },
  agent: { enabled: false, port: agentServer.PORT }, // the MCP server (SPEC §8 Agents): its pipe and http://127.0.0.1:<port>/mcp
  // In-app browser (§7j): the floating pane's state and its opacity (percent) while it does not have the focus.
  browserPane: { open: false, place: null },
  browserIdleOpacity: 70,
  browserNotchFloor: true, // the unfocused pane's notch stays at 40% or more
  browserAutoTab: false, // the browser page opens a Google tab when it has none
  keybinds: {}, // §7k: {bindingId: [chord]} for the bindings changed from their defaults (src/app/keys.mjs)
  github: github.DEFAULTS, // the GitHub backup (SPEC §4b)
  demoSeeded: false, // set once on the first start (actions.js init); no longer seeds the demo draft, so an older build does not either
  // On by default (the user, 2026-10-26): updates download in the background and install on quit (a portable copy on Restart);
  // off: the update toast offers them (checkForUpdates). A saved choice stays.
  autoUpdate: true,
  uiScale: 0, // the main window's zoom level (Settings > General UI scale, Ctrl+= / Ctrl+- / Ctrl+0): applyUiScale
};

// SSO providers block embedded browsers: drop the Electron and app tokens from the UA.
app.userAgentFallback = app.userAgentFallback.replace(/ (?:Electron|daf-writer|EasyWriter)\/\S+/g, '');

let mainWin = null;

// ---------------------------------------------------------------------------------------------
// Storage

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const userDir = (name) => () => path.join(app.getPath('userData'), name);
const images = userDir('images'); // the records' pictures, one file each (src/file-family.js externalize)

// Word's paper by region: Letter in the US, Canada, Mexico and the Philippines, A4 elsewhere (docs/plans/document.md Fonts and paper).
const localPaper = () => (['US', 'CA', 'MX', 'PH'].includes(app.getLocaleCountryCode()) ? 'letter' : 'a4');

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
  // A missing file is not migrated: a new install starts with every integration off.
  const { DEFAULTS, migrateSettings } = await integrations;
  // A smoke run (--smoke, the sample and every --script) counts as onboarded unless its profile says otherwise: the first
  // start's setup would cover the app its steps drive.
  return { ...structuredClone(DEFAULT_SETTINGS), paper: localPaper(), ...(SMOKE && { onboarded: true }), ...structuredClone(DEFAULTS), ...(isPlainObject(stored) ? migrateSettings(stored) : {}) };
}

function setSettings(partial) {
  if (!isPlainObject(partial)) throw new Error('settings must be an object');
  return serialized(async () => {
    const { checkIntegrations, enabled } = await integrations;
    if ('integrations' in partial) checkIntegrations(partial.integrations);
    await forum.checkSettings(partial);
    if ('uiScale' in partial) partial = { ...partial, uiScale: zoomLevel(partial.uiScale) };
    const current = await getSettings();
    // integrations merges by id, so a flag stored by a newer build (an id this one rejects on write) is kept.
    if ('integrations' in partial) partial = { ...partial, integrations: { ...current.integrations, ...partial.integrations } };
    const merged = { ...current, ...partial };
    await writeJsonAtomic(settingsFile(), merged);
    if ('integrations' in partial && !enabled(merged, 'forum')) forum.stop();
    if ('uiScale' in partial) applyUiScale(mainWin, merged.uiScale);
    if ('spellCheck' in partial && mainWin && !mainWin.isDestroyed()) mainWin.webContents.session.setSpellCheckerEnabled(merged.spellCheck !== false);
    if ('uiTheme' in partial) applyNativeTheme(merged.uiTheme);
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
  summary: (d) => ({ id: d.id, title: d.title, threadUrl: d.threadUrl ?? null, updated: d.updated, pushedAt: d.pushedAt ?? null,
    format: d.format ?? null, ...draftMarks(d.doc) }),
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
    if (!isThread(p.threadUrl)) throw new Error('plan threadUrl must be a project key or an older topic URL');
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
    if (f.threadUrl != null && !isThread(f.threadUrl)) throw new Error('flowchart threadUrl must be null, a project key or an older topic URL');
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
// IPC (only the main window may call; the background window of computer use only reads and saves its own draft)

// The writes of the files the GitHub backup syncs (SPEC §4b): the next tick pushes.
const SYNCED = /^(drafts|plans|flows|prefabs)\.(save|saveHistory|remove)$/;

function handle(channel, fn) {
  if (SYNCED.test(channel)) {
    const write = fn;
    fn = async (...args) => {
      const result = await write(...args);
      github.touch(); // after the write, so a sync that counts it reads it
      return result;
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
// An integration's channels refuse every call while it is off (Settings > Integrations). The check is here in main because
// window.api is fixed at preload time, so the renderer cannot be trusted to hide them.
const onlyIf = (id) => (channel, fn) => handle(channel, async (...args) => {
  if (!(await integrations).enabled(await getSettings(), id)) throw new Error(`The ${id} integration is off. Turn it on in Settings > Integrations.`);
  return fn(...args);
});
forum.register(onlyIf('forum'), { getSettings, icon: ICON, focusApp: () => mainWin && !mainWin.isDestroyed() && mainWin.focus() });
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
  mainWin.setBackgroundColor(color); // what shows in a resize or restore before the page repaints
});
// The page as the user sees it (§8 view.render): the whole window's content as PNG bytes; the renderer crops its viewport.
handle('window.capture', () => mainWin.webContents.capturePage().then((img) => img.toPNG()));
// References (docs/plans/references.md): one GET of a pasted link or of doi.org for a source's details → {ok, status, url, type,
// body}. A session of its own, in memory, so no sign-in of the app's other pages goes along; http and https only, 15 s, at most
// 2 MB of text read. Its user agent is Chrome's without the Electron and app names, which some sites refuse (unity.com: 403).
// `url` is where the redirects ended: session.fetch leaves res.url empty, so they are followed through webRequest.
let refsSession = null;
const refsMoved = new Map(); // a redirected link → where it went
handle('references.fetch', async ({ url, accept } = {}) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https links can be read');
  if (!refsSession) {
    refsSession = session.fromPartition('references');
    refsSession.setUserAgent(refsSession.getUserAgent().replace(/ (?:Electron|EasyWriter)\/\S+/gi, ''));
    refsSession.webRequest.onBeforeRedirect((d) => refsMoved.set(d.url, d.redirectURL));
  }
  const landed = () => {
    let at = u.href;
    for (let i = 0; i < 20 && refsMoved.has(at); i++) {
      const next = refsMoved.get(at);
      refsMoved.delete(at);
      at = next;
    }
    return at;
  };
  try {
    const res = await refsSession.fetch(u.href, { cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { accept: typeof accept === 'string' ? accept : 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    const type = res.headers.get('content-type') ?? '';
    const chunks = [];
    if (/html|xml|json|text/i.test(type) && res.body) {
      const reader = res.body.getReader();
      for (let size = 0; size < 2 * MB;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      reader.cancel().catch(() => {});
    }
    return { ok: res.ok, status: res.status, url: res.url || landed(), type, body: Buffer.concat(chunks).toString('utf8') };
  } catch (e) {
    return { ok: false, status: 0, url: u.href, type: '', body: '', error: e.message };
  }
});
// The draft menu's entries on the last right-click (editMenuAct): native | learn (Add to dictionary) | copyLink | an edit command.
// The edit commands need no right-click: a Document's ribbon and tool search run Cut, Copy and Paste through them too.
handle('editMenu.act', (act) => (menuParams || EDIT_ACTS.includes(act)) && editMenuAct(act));
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
    { label: 'Select all', click: () => wc.selectAll() },
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
// right end, 33 px tall so the border runs on under them. Colours: the theme's --card / --card-foreground (app.css) until the
// renderer sends the strip's own (window.titleBar).
const TITLE_BAR = { color: '#262626', symbolColor: '#e6e6e6', height: 33 };
const TITLE_BAR_LIGHT = { color: '#ffffff', symbolColor: '#1f1f1f' };

// The app's colours (settings.uiTheme: dark | light | system) for what Chromium and Windows draw: native menus and dialogs,
// and prefers-color-scheme in every page (the in-app browser's too, and the renderer's first frame, main.jsx).
function applyNativeTheme(uiTheme) {
  nativeTheme.themeSource = uiTheme === 'light' || uiTheme === 'system' ? uiTheme : 'dark';
}

function createMainWindow() {
  const bar = { ...TITLE_BAR, ...(!nativeTheme.shouldUseDarkColors && TITLE_BAR_LIGHT) };
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    title: 'EasyWriter',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: bar,
    backgroundColor: bar.color,
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
  wc.on('did-finish-load', () => getSettings().then((s) => {
    applyUiScale(win, s.uiScale);
    wc.session.setSpellCheckerEnabled(s.spellCheck !== false);
  }));
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
// Settings > General shows it at the top (the user, 2026-10-26). From this app's package.json, not app.getVersion(): started as
// `electron <script>` (the harnesses), that answers Electron's own version.
handle('app.version', () => require('./package.json').version);
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
    for (const s of [session.fromPartition(forum.PARTITION), session.fromPartition('persist:browser')]) {
      s.setPermissionRequestHandler((_wc, p, cb) => cb(allowed(p)));
      s.setPermissionCheckHandler((_wc, p) => allowed(p));
    }
    applyNativeTheme((await getSettings()).uiTheme);
    mainWin = createMainWindow();
    if (testWindow) testWindow.keepBehind(mainWin);
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

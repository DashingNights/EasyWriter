'use strict';
const { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, ipcMain, Menu, nativeTheme, net, session, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const { externalize, fileFamily, inline, isPlainObject, readJson, serialized, setAside, verifySha512, writeJsonAtomic } = require('./src/file-family.js');
const dictation = require('./src/dictation-main.js');
const assistant = require('./src/assistant-main.js');
const computer = require('./src/computer-main.js');
const { recordMarks } = require('./src/draft-marks.js');
const chromeSignIn = require('./src/chrome-signin.js');
const agentServer = require('./src/agent-server.js');
const github = require('./src/github-sync.js');
const providerKeys = require('./src/provider-keys.js');
const forum = require('./src/integrations/forum/main.js');
const metafiles = require('./src/metafile-main.js');
const engineFonts = require('./electron/fonts-main.js');
const { autoUpdater } = require('electron-updater');
const fsSync = require('fs');
const os = require('os');
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
// uninstaller next to the exe and an unzipped copy does not. Dev runs are never portable, and neither is the Mac (its data
// would land inside the signed app bundle; it updates through electron-updater only).
const EXE_DIR = path.dirname(process.execPath);
const PORTABLE = app.isPackaged && process.platform === 'win32' && !fsSync.existsSync(path.join(EXE_DIR, 'Uninstall EasyWriter.exe'));
const DATA = path.join(EXE_DIR, 'data');
// After a key, Chromium holds every renderer task until the next frame (DeferRendererTasksAfterInput), the engine worker's
// reply included, so a letter typed in the canvas editor showed a frame late (engine-keystroke in docs/plans/word/bench.log).
// Chromium keeps one value per switch: src/test-window.js adds to this list rather than replacing it.
app.commandLine.appendSwitch('disable-features', 'DeferRendererTasksAfterInput');
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
  // The assistant (SPEC §7i): off until a provider is picked.
  assistant: {
    serverUrl: '', permission: 'standard', uiControl: true, pictureAfterWrite: true, humanWriting: true,
    autoApproveEdits: false, // off: agent edits wait in the draft as suggestions (docs/wiki/suggestions.md); read as === true
  },
  agent: { enabled: false, port: agentServer.PORT }, // the MCP server (SPEC §8 Agents): its pipe and http://127.0.0.1:<port>/mcp
  // In-app browser (§7j): the floating pane's state and its opacity (percent) while it does not have the focus.
  browserPane: { open: false, place: null },
  browserIdleOpacity: 70,
  browserNotchFloor: true, // the unfocused pane's notch stays at 40% or more
  browserAutoTab: false, // the browser page opens a Google tab when it has none
  keybinds: {}, // §7k: {bindingId: [chord]} for the bindings changed from their defaults (src/app/keys.mjs); a Mac's are keybindsMac
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
  // The assistant providers' keys come from provider-keys.json (src/provider-keys.js).
  return providerKeys.reveal({ ...structuredClone(DEFAULT_SETTINGS), paper: localPaper(), ...(SMOKE && { onboarded: true }), ...structuredClone(DEFAULTS), ...(isPlainObject(stored) ? migrateSettings(stored) : {}) });
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
    // word merges by key too (docs/plans/word plan.md §1.12): two saveWord calls in flight each send only their keys, and both stay.
    if (isPlainObject(partial.word)) partial = { ...partial, word: { ...(isPlainObject(current.word) ? current.word : {}), ...partial.word } };
    const merged = { ...current, ...partial };
    await writeJsonAtomic(settingsFile(), await providerKeys.hide(merged));
    if ('integrations' in partial && !enabled(merged, 'forum')) forum.stop();
    if ('uiScale' in partial) applyUiScale(mainWin, merged.uiScale);
    if ('spellCheck' in partial && mainWin && !mainWin.isDestroyed()) mainWin.webContents.session.setSpellCheckerEnabled(merged.spellCheck !== false);
    if ('uiTheme' in partial) applyNativeTheme(merged.uiTheme);
    if ('keybinds' in partial || 'keybindsMac' in partial) refreshKeys(merged);
    // Settings > MCP turns the gateway on or off live; the assistant on Claude Code or Codex keeps its pipe open
    if (('agent' in partial || 'assistant' in partial) && !SMOKE) agentServer.sync(merged);
    if ('github' in partial && !SMOKE) github.configure(merged);
    if ('autoUpdate' in partial) applyAutoUpdate(merged.autoUpdate);
    if (github.SETTINGS_KEYS.some((k) => k in partial)) github.touch();
    return merged;
  });
}

/** A whiteboard's placed drafts (the sidebar's board tree): its live doc items' draft ids in board order, each once. */
function placedDrafts(board) {
  const items = Object.values(board?.items ?? {}).filter((i) => i && !i.gone && i.type);
  const keyOf = (i) => i.at?.[1] ?? '';
  const byOrder = (a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const out = [];
  const walk = (parent) => {
    for (const item of items.filter((i) => (i.at?.[0] ?? null) === parent).sort(byOrder)) {
      if (item.type === 'doc' && item.draft && !out.includes(item.draft)) out.push(item.draft);
      walk(item.id);
    }
  };
  walk(null);
  return out;
}

// Drafts (`drafts/<id>.json`, list = summaries), each with its persistent undo history (§7e) next to it.
const drafts = fileFamily(userDir('drafts'), {
  // uid: a board's doc item names its draft by it (bd-instance findDraft); engine: the Place list shows engine drafts only.
  summary: (d) => ({ id: d.id, title: d.title, threadUrl: d.threadUrl ?? null, updated: d.updated, pushedAt: d.pushedAt ?? null,
    format: d.format ?? null, uid: d.uid ?? null, engine: d.engine != null, ...recordMarks(d),
    ...(d.format === 'board' && { placed: placedDrafts(d.board) }) }),
  siblings: (id) => [historyFile(id), layoutFile(id)],
  images,
});
const historyFile = (id) => drafts.file(id).replace(/\.json$/, '.history.json');
// A Document's layout cache (src/document/layout-cache.mjs): beside the record, so writing it changes neither `updated` nor the backup.
const layoutFile = (id) => drafts.file(id).replace(/\.json$/, '.layout.json');

/** Writes `draft` (the record or its JSON text) → {id, updated}, and for a canvas draft its list marks (`marks`, from the engine
 * model's boxes: about 4 ms for the Word fixture's), which the renderer cannot read without parsing the model. A canvas record keeps
 * no DOM `doc` (src/engine/model/form.mjs): one saved before drops its stale doc at its next save, whichever path saves it. A
 * board's pictures are externalised on this save (file-family): `media` returns their stored reference form, so the board sends
 * those references from then on and only a new picture's bytes reach the disk. */
const MEDIA_REF = /^data:(?:image|video)\/[a-z0-9.+-]+;sha256,[a-f0-9]{64}$/i;
function saveDraft(draft) {
  if (typeof draft === 'string') draft = JSON.parse(draft); // the main window sends its JSON text (actions.js doSave)
  if (!isPlainObject(draft)) throw new Error('draft must be an object');
  if (draft.engine != null) delete draft.doc;
  const marks = draft.engine != null ? recordMarks(draft) : null;
  return drafts.save({ threadUrl: null, pushedAt: null, ...draft }).then(({ id, updated }) => {
    const media = draft.board?.media && Object.fromEntries(Object.entries(draft.board.media).filter(([, v]) => MEDIA_REF.test(v)));
    return { id, updated, ...(marks && { marks }), ...(media && Object.keys(media).length && { media }) };
  });
}

// A canvas draft's record or undo history as JSON text in pieces (src/engine/model/autosave.mjs): copying a canvas draft's 7 MB in
// one call held the page for 7 to 9 ms, a typed key's whole budget. Pieces 0 to n - 1 of a run arrive in order under one key: the
// draft's id for its record, `history:<id>` for its history, so the two runs never cut each other off. The last piece → the
// joined text, the others → null. A new piece 0 drops an unfinished run under the same key.
const draftParts = new Map();
function joinPieces(key, i, n, text) {
  if (typeof key !== 'string' || typeof text !== 'string' || !Number.isInteger(n) || !Number.isInteger(i) || i < 0 || i >= n) {
    throw new Error('bad draft piece');
  }
  if (i === 0) draftParts.set(key, []);
  const got = draftParts.get(key);
  if (got?.length !== i) {
    draftParts.delete(key);
    throw new Error('draft pieces out of order');
  }
  got.push(text);
  if (i < n - 1) return null;
  draftParts.delete(key);
  return got.join('');
}

/** A piece of draft `id`'s record → saveDraft's {id, updated} at the last piece, else null. */
function saveDraftPart(id, i, n, text) {
  const all = joinPieces(id, i, n, text);
  return all === null ? null : saveDraft(all);
}

/** A piece of draft `id`'s undo history → written at the last piece (saveHistory), else null. */
function saveHistoryPart(id, i, n, text) {
  if (typeof id !== 'string') throw new Error('bad draft piece');
  const all = joinPieces(`history:${id}`, i, n, text);
  return all === null ? null : saveHistory(id, all).then(() => true);
}

/** Removes draft `id` (to the trash, with its history and layout) and any unfinished run of its pieces. */
function removeDraft(id, ...rest) {
  draftParts.delete(id);
  draftParts.delete(`history:${id}`);
  return drafts.remove(id, ...rest);
}

async function loadHistory(id) {
  const data = await readJson(historyFile(id));
  return data && inline(images(), data);
}

/** Writes draft `id`'s undo history: an object, null, or its JSON text (a canvas draft's, src/engine/model/autosave.mjs). */
function saveHistory(id, data) {
  const file = historyFile(id);
  if (typeof data === 'string') data = JSON.parse(data);
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
const SYNCED = /^(drafts|plans|flows|prefabs)\.(save|savePart|saveHistory|saveHistoryPart|remove)$/;

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
handle('drafts.savePart', saveDraftPart);
handle('drafts.remove', removeDraft);
handle('drafts.loadHistory', loadHistory);
handle('drafts.saveHistory', saveHistory);
handle('drafts.saveHistoryPart', saveHistoryPart);
handle('drafts.loadLayout', (id) => readJson(layoutFile(id)));
handle('drafts.saveLayout', (id, data) => {
  if (data !== null && !isPlainObject(data)) throw new Error('layout must be an object or null');
  return serialized(() => writeJsonAtomic(layoutFile(id), data));
});
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

// ---------------------------------------------------------------------------------------------
// Word parity (docs/plans/word plan.md §1.17): printing and PDF, files, screen capture, spelling, the clipboard, the word store,
// the region's unit and the backup's versions of a draft. The renderer reaches them as window.api.word (preload.js).

// print and printToPDF act on the calling window's page: the main window, or the background window printing its own draft.
function handleSender(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if ((mainWin && event.sender === mainWin.webContents) || computer.isWorker(event.sender)) return fn(event.sender, ...args);
    throw new Error('unauthorized sender');
  });
}
const PRINT_KEYS = ['silent', 'deviceName', 'copies', 'pageRanges', 'landscape', 'pageSize', 'margins', 'scaleFactor', 'collate', 'duplexMode', 'pagesPerSheet',
  'printBackground', 'color', 'dpi', 'header', 'footer'];
const pickKeys = (o, keys) => Object.fromEntries(keys.filter((k) => isPlainObject(o) && o[k] !== undefined).map((k) => [k, o[k]]));
// Cell shading and highlights print as on screen unless the caller says otherwise (plan.md §1.12 print copy).
handleSender('word.print', (wc, opts) => new Promise((resolve) => {
  wc.print({ printBackground: true, ...pickKeys(opts, PRINT_KEYS) }, (ok, error) => resolve({ ok, error: ok ? null : error || 'Printing failed' }));
}));
// The engine's print job (docs/plans/engine/viewport-design.md P14b): `bytes` is the PDF the engine made for it, printed with
// word.print's options from a hidden window's PDF viewer. A print job's PDF may embed fonts licensed for preview and print only,
// so it is never saved: its temporary file goes when the job ends.
handleSender('word.printPdf', async (_wc, bytes, opts) => {
  const pdf = ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  if (pdf?.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('printPdf takes the bytes of a PDF');
  const file = path.join(os.tmpdir(), `easywriter-print-${crypto.randomUUID()}.pdf`);
  const win = new BrowserWindow({ show: false, webPreferences: { plugins: true, sandbox: true, contextIsolation: true } });
  try {
    await fs.writeFile(file, pdf);
    await win.loadFile(file);
    if (!(await pdfLoaded(win.webContents))) return { ok: false, error: 'The pages were not ready to print after 30 seconds. Nothing was printed.' };
    return await new Promise((resolve) => {
      win.webContents.print({ printBackground: true, ...pickKeys(opts, PRINT_KEYS) }, (ok, error) => resolve({ ok, error: ok ? null : error || 'Printing failed' }));
    });
  } finally {
    win.destroy();
    await fs.rm(file, { force: true }).catch(() => {});
  }
});
const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'; // Chromium's PDF viewer
/** Whether the PDF viewer in `wc` has loaded its document, within `ms`. Printing it earlier prints the viewer's empty page. */
async function pdfLoaded(wc, ms = 30000) {
  // ponytail: reads the viewer's own load state (pdf-viewer's loadState_ in Electron 44's Chromium); a version that renames it
  // ends every job with the error above after `ms` rather than printing a blank page (the 963-page fixture loads in about 5 s).
  // Only the hand check in docs/plans/engine/measure.md shows that real paper prints.
  for (const end = Date.now() + ms; Date.now() < end && !wc.isDestroyed();) {
    const viewer = wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith(PDF_VIEWER));
    const state = await viewer?.executeJavaScript(`document.querySelector('pdf-viewer')?.loadState_ ?? null`).catch(() => null);
    if (state === 'success' || state === 'failed') return state === 'success';
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
handleSender('word.printToPDF', async (wc, opts) => (await wc.printToPDF({ printBackground: true, ...(isPlainObject(opts) ? opts : {}) })).toString('base64'));
handleSender('word.printers', async (wc) => (await wc.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName, isDefault: !!p.isDefault })));

// Text files are written as text, anything else from base64, unless `as` says which.
const TEXT_FILE = /\.(txt|md|html?|csv|tsv|json|xml|svg|css|js)$/i;
handle('word.saveFile', async ({ name, data, filters, as } = {}) => {
  const r = await dialog.showSaveDialog(mainWin, { defaultPath: typeof name === 'string' ? name : undefined, filters: Array.isArray(filters) ? filters : undefined });
  if (r.canceled || !r.filePath) return null;
  const text = as ? as === 'text' : TEXT_FILE.test(r.filePath);
  await fs.writeFile(r.filePath, text ? String(data ?? '') : Buffer.from(String(data ?? ''), 'base64'));
  return r.filePath;
});
handle('word.openFile', async ({ filters, as = 'text' } = {}) => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters: Array.isArray(filters) ? filters : undefined });
  if (r.canceled || !r.filePaths[0]) return null;
  const buf = await fs.readFile(r.filePaths[0]);
  return { name: path.basename(r.filePaths[0]), data: as === 'base64' ? buf.toString('base64') : buf.toString('utf8') };
});
// EMF and WMF pictures of an imported .docx drawn as PNGs by the system (metafile-main.js).
handle('word.metafiles', (list) => metafiles.toPng(list));
handle('fonts.families', engineFonts.families);
handle('fonts.family', engineFonts.family);
handle('fonts.file', engineFonts.file);
handle('word.captureSources', async ({ types = ['window', 'screen'], thumbnail = { width: 320, height: 200 } } = {}) => (
  await desktopCapturer.getSources({ types, thumbnailSize: thumbnail })).map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));

// Spelling: the checks themselves run in the renderer (preload's webFrame); languages and the dictionary are the session's.
const spellSession = () => mainWin.webContents.session;
handle('word.spell.languages', () => ({ current: spellSession().getSpellCheckerLanguages(), available: spellSession().availableSpellCheckerLanguages }));
handle('word.spell.setLanguages', (list) => {
  const available = new Set(spellSession().availableSpellCheckerLanguages);
  spellSession().setSpellCheckerLanguages((Array.isArray(list) ? list : []).filter((l) => available.has(l)));
  return spellSession().getSpellCheckerLanguages();
});
handle('word.spell.add', (word) => typeof word === 'string' && word.trim() !== '' && spellSession().addWordToSpellCheckerDictionary(word.trim()));

// Electron 44's clipboard is the async ClipboardItem one: each entry lists its MIME types, each read as a Blob.
handle('word.clipboard.read', async () => {
  const out = { text: '', html: '', image: null };
  for (const item of await clipboard.read()) {
    for (const type of item.types) {
      if (type === 'text/plain' && !out.text) out.text = await (await item.getType(type)).text();
      else if (type === 'text/html' && !out.html) out.html = await (await item.getType(type)).text();
      else if (type.startsWith('image/') && !out.image) {
        out.image = `data:${type};base64,${Buffer.from(await (await item.getType(type)).arrayBuffer()).toString('base64')}`;
      }
    }
  }
  return out;
});
handle('word.clipboard.write', async ({ text, html, rtf, image } = {}) => {
  const entry = {};
  if (text != null) entry['text/plain'] = String(text);
  if (html != null) entry['text/html'] = String(html);
  if (rtf) entry['text/rtf'] = String(rtf); // the canvas editor's copies, as Word's carry RTF beside the text and HTML
  const m = typeof image === 'string' && /^data:(image\/[\w.+-]+);base64,(.*)$/.exec(image);
  if (m) entry[m[1]] = new Blob([Buffer.from(m[2], 'base64')], { type: m[1] });
  if (Object.keys(entry).length) await clipboard.write([new ClipboardItem(entry)]);
  return true;
});

// The word store: one JSON file per name under userData/word/ (building blocks, style sets, sources), kept out of settings.json.
const STORE_NAME = /^[A-Za-z][\w-]{0,63}$/;
const storeFile = (name) => {
  if (typeof name !== 'string' || !STORE_NAME.test(name)) throw new Error('word store names are letters, digits, - and _');
  return path.join(app.getPath('userData'), 'word', `${name}.json`);
};
handle('word.store.get', (name) => readJson(storeFile(name)));
handle('word.store.set', (name, value) => serialized(() => writeJsonAtomic(storeFile(name), value ?? null)));

// Word follows the Windows region for its unit, not the paper: inches in the US, Liberia and Myanmar, else centimetres.
handle('word.region', () => {
  const country = /[-_]([A-Z]{2})\b/.exec(app.getSystemLocale())?.[1] ?? app.getLocaleCountryCode();
  return ['US', 'LR', 'MM'].includes(country) ? 'in' : 'cm';
});

// The OS account's name: Word's comment author while Word Options has no user name, as Office does. '' when the OS has none.
handle('word.userName', () => {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
});

// A draft's versions in the GitHub backup: the commits that touched drafts/<id>.json, newest first, and the draft at one of
// them. [] or null while the backup is off or not logged in. The backup repository holds real data: tests stub these.
const DRAFT_ID = /^[a-f0-9-]{36}$/;
const backupRepo = async () => {
  const g = (await getSettings()).github;
  return g?.enabled && g.repo ? g.repo : null;
};
handle('word.versions', async (draftId) => {
  const repo = await backupRepo();
  if (!repo || !DRAFT_ID.test(draftId ?? '')) return [];
  try {
    const list = await github.gh('GET', `/repos/${repo}/commits?path=${encodeURIComponent(`drafts/${draftId}.json`)}&per_page=100`);
    return list.map((c) => ({ ref: c.sha, date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null, message: c.commit?.message ?? '' }));
  } catch {
    return [];
  }
});
handle('word.versionAt', async (draftId, ref) => {
  const repo = await backupRepo();
  if (!repo || !DRAFT_ID.test(draftId ?? '') || !/^[0-9a-f]{7,40}$/i.test(ref ?? '')) return null;
  try {
    const buf = await github.gh('GET', `/repos/${repo}/contents/drafts/${draftId}.json?ref=${ref}`, null, { raw: true });
    return inline(images(), JSON.parse(buf.toString('utf8')));
  } catch {
    return null;
  }
});

// Document text focus (window.docText from the renderer's WordKeys): while it holds, the developer tools chord is left to the
// editor when it is one of the Word chords the renderer sent.
let docText = { on: false, chords: new Set() };
ipcMain.on('word.docText', (event, on, list) => {
  if (!mainWin || event.sender !== mainWin.webContents) return;
  docText = { on: !!on, chords: new Set(Array.isArray(list) ? list.filter((c) => typeof c === 'string') : []) };
});
// Window zoom (settings.uiScale): a Chromium zoom level in Electron's old View menu steps of 0.5, -3…5 (0 = 100 %). The window
// controls scale with the title strip (Windows; the Mac's traffic lights keep their place).
const zoomLevel = (v) => Math.max(-3, Math.min(5, Math.round(Number(v) * 2) / 2 || 0));
function applyUiScale(win, level) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomLevel(zoomLevel(level));
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ height: Math.round(TITLE_BAR.height * win.webContents.getZoomFactor()) });
}
// dir 1 in, -1 out, 0 reset: the renderer sends it for Ctrl+= / Ctrl+- / Ctrl+0 (the main window has no menu). Saved as
// settings.uiScale, so Settings shows it and the next start opens at it. → the new settings.
handle('window.zoom', (dir) => setSettings({ uiScale: dir ? mainWin.webContents.getZoomLevel() + 0.5 * Math.sign(dir) : 0 }));
// The title strip's colours (#rrggbb, §7): the window controls' background and symbols follow them.
const HEX = /^#[0-9a-f]{6}$/i;
handle('window.titleBar', ({ color, symbolColor } = {}) => {
  if (!HEX.test(color) || !HEX.test(symbolColor)) throw new Error('title bar colours must be #rrggbb');
  if (process.platform !== 'darwin') mainWin.setTitleBarOverlay({ color, symbolColor }); // the Mac has no overlay colours
  mainWin.setBackgroundColor(color); // what shows in a resize or restore before the page repaints
});
// The page as the user sees it (§8 view.render): the whole window's content as PNG bytes; the renderer crops its viewport.
handle('window.capture', () => mainWin.webContents.capturePage().then((img) => img.toPNG()));
// References (docs/wiki/references.md): one GET of a pasted link or of doi.org for a source's details → {ok, status, url, type,
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
// On the Mac, macOS Dictation in place of Whisper (§7h Mac): it types where the focus is. startDictation: / stopDictation: are
// undocumented NSApplication actions (kitty sends them the same way); untested here, as nobody has a Mac to run it on.
handle('dictation.system', (action) => process.platform === 'darwin'
  && Menu.sendActionToFirstResponder(action === 'stop' ? 'stopDictation:' : 'startDictation:'));
// The assistant (SPEC §7i): assistant.status|chat|cancelChat|cliRun|cliTest|checkKey|writingGuide.
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
  const b = keys.effective(keys.DEFS, settings[keys.keybindsKey()]); // keybindsMac on a Mac
  chords = {
    devtools: new Set(b['app.devtools']),
    browser: new Set(Object.entries(b).filter(([id]) => id.startsWith('browser.')).flatMap(([, c]) => c)),
  };
}
async function loadKeys() {
  keys = await import(pathToFileURL(path.join(__dirname, 'src', 'app', 'keys.mjs')).href);
  refreshKeys(await getSettings());
}

// Globe+Tab and Globe+Space on a Mac (§7k): Electron never sees the Globe key, so native/globe (an AppKit key monitor, built in CI
// and shipped as Resources/globe.node) reports them, and the renderer replays them as key events (actions.js globeKey). Without
// the addon only the second chords (Ctrl+Tab, Ctrl+Shift+Space) work.
// ponytail: only Tab and Space are watched, and they are swallowed even when unbound; add keys to globe.mm if a binding needs more.
function watchGlobe(win) {
  if (process.platform !== 'darwin') return;
  try {
    require(path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, 'native', 'globe'), 'globe.node')).start((packed) => {
      if (win.isDestroyed()) return;
      const bit = (n) => !!(packed & (1 << n));
      win.webContents.send('key.globe', { code: (packed & 0xff) === 48 ? 'Tab' : 'Space', shift: bit(8), ctrl: bit(9), alt: bit(10), meta: bit(11), repeat: bit(12) });
    });
  } catch (e) {
    console.error('globe', e);
  }
}

// ---------------------------------------------------------------------------------------------
// Main window

// Custom frame (§4): no native title bar and no menu. The renderer's title strip (34 px with its 1 px bottom border, app.css
// .titlebar) is the drag region; the Window Controls Overlay draws the native minimize / maximize / close buttons over its
// right end, 33 px tall so the border runs on under them. Colours: the theme's --card / --card-foreground (app.css) until the
// renderer sends the strip's own (window.titleBar). On the Mac the overlay only reports the room left of the traffic lights
// (env(titlebar-area-x)), which sit centred in the strip.
const TITLE_BAR = { color: '#262626', symbolColor: '#e6e6e6', height: 33 };
const TITLE_BAR_LIGHT = { color: '#ffffff', symbolColor: '#1f1f1f' };

// The app's colours (settings.uiTheme: dark | light | system) for what Chromium and Windows draw: native menus and dialogs,
// and prefers-color-scheme in every page (the in-app browser's too, and the renderer's first frame, main.jsx).
function applyNativeTheme(uiTheme) {
  nativeTheme.themeSource = uiTheme === 'light' || uiTheme === 'system' ? uiTheme : 'dark';
}

// The Mac's menu bar (removeMenu does nothing there): the app menu, Edit and Window. No View menu, so no Reload or DevTools
// keys, and no Close (Cmd+W closes the in-app browser's tab). The renderer's own keydown handlers run first.
function macMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', click: () => mainWin?.webContents.send('app.settings') },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [ // AppKit adds Start Dictation and Emoji & Symbols to a menu titled Edit
      { role: 'undo' }, { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
    ] },
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]));
}

// A Mac copy run from the DMG or a translocated folder: updates only install from /Applications, so ask to move it there.
// moveToApplicationsFolder relaunches the app; it returns false when the user cancels and throws when the move fails.
async function offerMoveToApplications() {
  if (process.platform !== 'darwin' || !app.isPackaged || SMOKE || DATA_DIR || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Move EasyWriter to Applications?',
    detail: 'Updates only install from the Applications folder.',
    buttons: ['Move', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try { app.moveToApplicationsFolder(); } catch (e) { console.error('move to Applications', e); }
}

function createMainWindow() {
  const bar = { ...TITLE_BAR, ...(!nativeTheme.shouldUseDarkColors && TITLE_BAR_LIGHT) };
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    // The narrowest window keeps the window controls (three 46 px buttons on Windows, the traffic lights on a Mac) and the
    // sidebar button left of them: the sidebar hides by itself under 990 px (actions.js NARROW).
    minWidth: 200,
    show: false,
    title: 'EasyWriter',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: bar,
    ...(process.platform === 'darwin' && { trafficLightPosition: { x: 12, y: 10 } }), // 14 px lights centred in 34 px
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
  // window). DevTools has its keybind (default Ctrl+Shift+I, §7k). The Mac keeps an application menu (macMenu).
  win.removeMenu();
  wc.on('before-input-event', (event, input) => {
    const chord = input.type === 'keyDown' && keys?.chordOf(input);
    if (chord && chords.devtools.has(chord) && !(docText.on && docText.chords.has(chord))) { // the Developer tools keybind (§7k)
      event.preventDefault();
      wc.toggleDevTools();
    } else if (process.platform === 'darwin' && input.type === 'keyDown' && keys?.chordOf(input) === 'Cmd+,') {
      // The Mac's Settings… (macMenu): the editor claims Cmd+, (TipTap's subscript Mod-,), so the menu would never see it.
      event.preventDefault();
      wc.send('app.settings');
    }
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event) => {
    if (event.url.split('#')[0] !== INDEX_URL) event.preventDefault();
  });
  // A reload (the GitHub sync's after a merge) or a crash loses the agent calls the page was running (src/agent-server.js reset).
  wc.on('did-navigate', () => agentServer.reset());
  wc.on('render-process-gone', () => agentServer.reset());

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
let portableOffer = null; // {version} of the newer release not downloaded yet
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
    portableOffer = { version };
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
    const { version } = portableOffer;
    fsSync.rmSync(UPDATE_DIR, { recursive: true, force: true }); // any half download or an older extracted update
    // One name in every release, so the README can link to it. Copies before it look for EasyWriter-<version>-win.zip, which
    // the release workflow uploads too.
    const name = 'EasyWriter-Portable.zip';
    const zip = path.join(UPDATE_DIR, name);
    const fresh = path.join(UPDATE_DIR, 'new');
    const marker = path.join(UPDATE_DIR, 'version');
    fsSync.mkdirSync(fresh, { recursive: true });
    // Its sha512 (the release workflow uploads it beside the zip; latest.yml lists only the installer). A release without it
    // installs nothing, and the zip is not even downloaded.
    const sums = await net.fetch(`${RELEASES}${name}.sha512`);
    const sha512 = sums.ok ? (await sums.text()).trim() : '';
    if (!sha512) throw new Error(`The release has no checksum for ${name}, so it was not installed.`);
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
    await verifySha512(zip, sha512);
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
// A step {"shot": "<file>.png"} saves the 1600 x 900 window as that file: the steps
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
  // A start that fails (a settings file another program keeps locked) says so and quits, which frees the single-instance
  // lock: a process left running without a window would make every later start exit silently.
  app.whenReady().then(async () => {
    try {
      await loadKeys();
      // Plaintext provider keys from an older build go to provider-keys.json; a failed move is tried again at the next start.
      await providerKeys.migrate(settingsFile()).catch(() => {});
      // Electron grants every permission by default; forum pages and their popups get none beyond these.
      const allowed = (p) => ['clipboard-sanitized-write', 'fullscreen'].includes(p);
      // The in-app browser's pages (§7j, persist:browser) get the same, and so do an agent's tabs (src/app/browser.js AGENT_PARTITION).
      for (const s of [session.fromPartition(forum.PARTITION), session.fromPartition('persist:browser'), session.fromPartition('assistant-web')]) {
        s.setPermissionRequestHandler((_wc, p, cb) => cb(allowed(p)));
        s.setPermissionCheckHandler((_wc, p) => allowed(p));
      }
      applyNativeTheme((await getSettings()).uiTheme);
      if (process.platform === 'darwin') {
        macMenu();
        await offerMoveToApplications();
      }
      mainWin = createMainWindow();
      watchGlobe(mainWin);
      if (testWindow) testWindow.keepBehind(mainWin);
      if (SMOKE) {
        mainWin.showInactive();
        runSmoke(mainWin);
      } else {
        mainWin.once('ready-to-show', () => {
          mainWin.show();
          if (process.platform !== 'darwin') dictation.warmAtStart(); // the Mac uses macOS Dictation (§7h Mac)
          if (app.isPackaged) checkForUpdates();
        });
        agentServer.sync(await getSettings());
        github.configure(await getSettings());
      }
      mainWin.loadFile(INDEX_FILE, SMOKE && !SCRIPT ? { query: { smoke: '1' } } : {});
    } catch (e) {
      console.error('start', e);
      if (!SMOKE) dialog.showErrorBox('EasyWriter could not start', `${e.message}\n\nClose any program that may be using EasyWriter's files, such as a virus scanner or OneDrive, and start EasyWriter again.`);
      app.exit(1);
    }
  });
}

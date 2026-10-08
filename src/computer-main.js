'use strict';
// Computer use (SPEC §7i Computer use, Background window): screenshots of a window and mouse and keyboard input sent into it
// (webContents.sendInputEvent), for the assistant's computer.act. Target 'main' is the user's window; 'background' is the
// background window, a second, offscreen copy of the app (webPreferences.offscreen: it paints and captures while never shown)
// that works on one draft while the user keeps working in theirs. Coordinates are pixels of the last screenshot sent for that
// target. The background window reads settings and drafts but saves only its own draft (fromWorker); the user's window hears
// on `computer.event` when it opens and closes ({type: 'worker', draftId, title}), when it saves ({type: 'saved', entry: the
// sidebar entry}) and, while the pane shows, its frames ({type: 'frame', url}, about 5 a second).
const { BrowserWindow } = require('electron');

const SIDE = 1344; // a screenshot's long side at most (px)
const WORKER_SIZE = { width: 1440, height: 900 };
const IDLE = { ms: 5 * 60 * 1000 }; // the background window closes this long after its last action (a harness shortens it)
const FRAME_MS = 200; // the pane's frames: about 5 a second
const FRAME_WIDTH = 960;
// Never pressed or typed into from computer.act: the assistant panel and its chat button, the approval card, the pane and what
// the app keeps from the assistant (its own settings), as for ui.invoke (ui-control.js INSIDE).
const DENY = '#assistant-panel, [data-chat-island], [data-agent-ask], [data-agent-deny], [data-background-pane]';
// What the background window may ask main for: reads, and saving its own draft (checked in fromWorker).
const WORKER_CALLS = new Set(['settings.get', 'drafts.list', 'drafts.load', 'drafts.loadHistory', 'drafts.save', 'drafts.saveHistory',
  'plans.list', 'plans.load', 'flows.list', 'flows.load', 'prefabs.list', 'prefabs.load', 'assistant.status', 'dictation.status', 'dictation.listModels']);

let getMain = () => null;
let files = { index: '', preload: '' };
let worker = null; // the background window now: {win, draftId, title, frame (its last paint)}
const workers = new Set(); // every background window still alive, a closing one too (its last save still goes through)
const shots = new Map(); // target → {k (screenshot px per window px), width, height} of its last screenshot
let idleTimer = 0;
let pane = false; // the user's window shows the pane: frames go to it
let frameTimer = 0;
let lastFrame = 0;
let queue = Promise.resolve(); // opens and closes, one at a time

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const coded = (code, message) => Object.assign(new Error(message), { code });
const serial = (fn) => (queue = queue.then(fn, fn));

function notify(payload) {
  const wc = getMain()?.webContents;
  if (wc && !wc.isDestroyed()) wc.send('computer.event', payload);
}

/** The window of target `t`, or a coded error. */
function windowOf(t) {
  if (t === 'background') {
    if (!worker || worker.win.isDestroyed()) throw coded('not_found', 'No draft is open in the background window. Call background_open first.');
    return worker.win;
  }
  const win = getMain();
  if (!win || win.isDestroyed()) throw coded('not_found', 'The main window is closed.');
  // A minimized window paints nothing new, so its screenshot would be out of date (its input still works).
  if (win.isMinimized()) throw coded('refused', 'The main window is minimized. Ask the user to bring it back, or work in the background window.');
  return win;
}

/** The page's size in window px (the input events' unit): its CSS viewport times the window zoom. A minimized window keeps it. */
async function viewSize(wc) {
  const [w, h] = await wc.executeJavaScript('[innerWidth, innerHeight]', true);
  const z = wc.getZoomFactor();
  return [Math.round(w * z), Math.round(h * z)];
}

/** A screenshot of target `t`: at most SIDE px on its long side, a JPEG data URL; its scale is kept for the next action. */
async function screenshot(t) {
  const win = windowOf(t);
  const [w, h] = await viewSize(win.webContents);
  let img = await win.webContents.capturePage();
  if (img.isEmpty() && t === 'background' && worker?.frame) img = worker.frame; // an offscreen window's last paint
  if (img.isEmpty()) throw coded('failed', `The ${t} window gave an empty picture.`);
  const k = Math.min(1, SIDE / Math.max(w, h, 1));
  const width = Math.round(w * k);
  const height = Math.round(h * k);
  const url = `data:image/jpeg;base64,${img.resize({ width, height, quality: 'better' }).toJPEG(80).toString('base64')}`;
  shots.set(t, { k, width, height });
  return { target: t, url, width, height, ...(t === 'background' && { draftId: worker.draftId, title: worker.title }) };
}

/** Screenshot px (x, y) of target `t` → window px, checked against its last screenshot. */
function toWindow(t, x, y) {
  const s = shots.get(t);
  if (!s) throw coded('invalid_args', `Take a screenshot of the ${t} window first. x and y are pixels of it.`);
  if (!(x >= 0 && y >= 0 && x <= s.width && y <= s.height)) throw coded('invalid_args', `x and y must be inside the ${s.width} x ${s.height} screenshot.`);
  return { x: Math.round(x / s.k), y: Math.round(y / s.k) };
}

/** Refuses a press at window point `p` (or, with no point, typing at the keyboard focus) inside DENY. */
async function guard(wc, p) {
  const z = wc.getZoomFactor();
  const el = p ? `document.elementFromPoint(${p.x / z}, ${p.y / z})` : 'document.activeElement';
  if (await wc.executeJavaScript(`!!${el}?.closest(${JSON.stringify(DENY)})`, true)) {
    throw coded('denied', p ? 'That point is on the assistant panel or a control kept from the assistant.'
      : 'The keyboard focus is in the assistant panel. Click where to type first.');
  }
}

const MODS = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', meta: 'meta', cmd: 'meta', command: 'meta' };
const KEY_NAMES = { arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', esc: 'Escape', return: 'Enter', del: 'Delete', spacebar: 'Space' };
const CHARS = { Enter: '\r', Space: ' ' }; // keys that also type a character (Tab moves the focus on its key down)

/** Presses `combo` ("Enter", "Control+Z", "Shift+ArrowDown"): key down, its character when it types one, key up. */
function press(wc, combo) {
  const parts = combo.split(/\+(?=.)/).map((s) => s.trim());
  const key = parts.pop();
  const modifiers = parts.map((m) => MODS[m.toLowerCase()] ?? (() => { throw coded('invalid_args', `${m} is not a modifier key. Use Control, Shift, Alt or Meta.`); })());
  const keyCode = KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key : key[0].toUpperCase() + key.slice(1));
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  const ch = CHARS[keyCode] ?? ([...keyCode].length === 1 ? keyCode : '');
  if (ch && modifiers.every((m) => m === 'shift')) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

/** After an action: two animation frames and at least 150 ms (a hidden page has no frames: at most 500 ms). */
const settle = (wc) => Promise.all([
  Promise.race([wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', true).catch(() => {}), delay(500)]),
  delay(150),
]);

/** computer.act {action, target, x?, y?, button?, path?, text?, keys?, dx?, dy?, ms?} → a fresh screenshot of the target. */
async function act(a = {}) {
  const t = a.target === 'background' ? 'background' : 'main';
  const win = windowOf(t);
  const wc = win.webContents;
  if (t === 'background') touch();
  const at = (x, y) => toWindow(t, x, y);
  const button = ['left', 'right', 'middle'].includes(a.button) ? a.button : 'left';
  const held = [`${button}ButtonDown`];
  switch (a.action) {
    case 'screenshot': break;
    case 'wait': await delay(Math.min(3000, Math.max(0, Number(a.ms) || 0))); break;
    case 'move': wc.sendInputEvent({ type: 'mouseMove', ...at(a.x, a.y) }); break;
    case 'click':
    case 'double_click': {
      const p = at(a.x, a.y);
      await guard(wc, p);
      wc.sendInputEvent({ type: 'mouseMove', ...p });
      for (let n = 1; n <= (a.action === 'double_click' ? 2 : 1); n++) {
        wc.sendInputEvent({ type: 'mouseDown', ...p, button, clickCount: n, modifiers: held });
        wc.sendInputEvent({ type: 'mouseUp', ...p, button, clickCount: n });
      }
      break;
    }
    case 'drag': {
      const pts = a.path.map(([x, y]) => at(x, y));
      await guard(wc, pts[0]);
      await guard(wc, pts.at(-1));
      wc.sendInputEvent({ type: 'mouseMove', ...pts[0] });
      wc.sendInputEvent({ type: 'mouseDown', ...pts[0], button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] });
      let prev = pts[0];
      for (const p of pts.slice(1)) { // in steps of about 10 px, so a board sees a real drag
        const n = Math.max(1, Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / 10));
        for (let i = 1; i <= n; i++) {
          wc.sendInputEvent({ type: 'mouseMove', x: Math.round(prev.x + ((p.x - prev.x) * i) / n), y: Math.round(prev.y + ((p.y - prev.y) * i) / n), button: 'left', modifiers: ['leftButtonDown'] });
          await delay(8);
        }
        prev = p;
      }
      wc.sendInputEvent({ type: 'mouseUp', ...prev, button: 'left', clickCount: 1 });
      break;
    }
    case 'type':
      await guard(wc, null);
      for (const ch of String(a.text).replace(/\r\n?/g, '\n')) {
        if (ch === '\n') press(wc, 'Enter');
        else wc.sendInputEvent({ type: 'char', keyCode: ch });
      }
      break;
    case 'key':
      await guard(wc, null);
      press(wc, String(a.keys));
      break;
    case 'scroll': {
      const k = shots.get(t)?.k ?? 1;
      wc.sendInputEvent({ type: 'mouseWheel', ...at(a.x, a.y), deltaX: -(Number(a.dx) || 0) / k, deltaY: -(Number(a.dy) || 0) / k, canScroll: true });
      break;
    }
    default: throw coded('invalid_args', `${a.action} is not an action.`);
  }
  await settle(wc);
  return screenshot(t);
}

// ---------------------------------------------------------------------------------------------
// The background window

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => close(), IDLE.ms);
}

function sendFrame() {
  frameTimer = 0;
  const img = worker?.frame;
  const wc = getMain()?.webContents;
  if (!pane || !img || img.isEmpty() || !wc || wc.isDestroyed()) return;
  lastFrame = Date.now();
  const size = img.getSize();
  const small = size.width > FRAME_WIDTH ? img.resize({ width: FRAME_WIDTH }) : img;
  wc.send('computer.event', { type: 'frame', url: `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}` });
}

/** A paint of the offscreen window: kept as its last frame, and sent to the pane at most every FRAME_MS (the last one too). */
function onPaint(rec, image) {
  rec.frame = image;
  if (rec === worker && pane && !frameTimer) frameTimer = setTimeout(sendFrame, Math.max(0, lastFrame + FRAME_MS - Date.now()));
}

/** A new background window on draft `draftId`: the app with ?worker=1&draft=<id>, offscreen, never shown. */
async function start(draftId, title) {
  const win = new BrowserWindow({
    ...WORKER_SIZE,
    useContentSize: true,
    show: false,
    webPreferences: { preload: files.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
  });
  const rec = { win, draftId, title: title || 'Untitled draft', frame: null };
  workers.add(rec);
  worker = rec;
  const wc = win.webContents;
  wc.setFrameRate(30);
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // a link never opens the user's browser from here
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('paint', (_e, _dirty, image) => onPaint(rec, image));
  // A file picker would open a native dialog on the user's screen: intercepted, so none ever shows.
  try {
    wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  } catch {}
  win.on('closed', () => {
    workers.delete(rec);
    if (worker !== rec) return;
    worker = null;
    shots.delete('background');
    notify({ type: 'worker', draftId: null });
  });
  await win.loadFile(files.index, { query: { worker: '1', draft: draftId } });
  // The renderer sets window.__worker once it has started; its draftId is the draft it opened (null: it could not load it).
  for (let i = 0; ; i++) {
    const id = await wc.executeJavaScript('window.__worker ? window.__worker.draftId ?? "" : null', true);
    if (id === draftId) return rec;
    if (id !== null || i >= 300) throw new Error(id === null ? 'it did not start' : 'the draft could not be loaded');
    await delay(100);
  }
}

/** background.open {draftId, title}: the background window on that draft (another one is saved and closed first) → its screenshot. */
function open({ draftId, title } = {}) {
  return serial(async () => {
    if (typeof draftId !== 'string' || !/^[a-f0-9-]{36}$/.test(draftId)) throw coded('invalid_args', 'draftId must be a draft id.');
    if (worker?.draftId !== draftId) {
      await closeNow();
      try {
        await start(draftId, title);
      } catch (e) {
        await closeNow();
        throw coded('failed', `The background window could not open that draft: ${e.message}.`);
      }
      notify({ type: 'worker', draftId, title: worker.title });
    }
    touch();
    return screenshot('background');
  });
}

/** Saves the background window's draft and closes the window → {closed: its draft id, or null}. */
async function closeNow() {
  const rec = worker;
  if (!rec) return { closed: null };
  worker = null;
  clearTimeout(idleTimer);
  shots.delete('background');
  try {
    await Promise.race([rec.win.webContents.executeJavaScript('window.__worker?.release()', true), delay(10000)]);
  } catch {}
  if (!rec.win.isDestroyed()) rec.win.destroy();
  workers.delete(rec);
  notify({ type: 'worker', draftId: null });
  return { closed: rec.draftId };
}

/** background.close, the user's open of that draft (the handover) and app quit. */
const close = () => serial(closeNow);

function setPane(on) {
  pane = !!on;
  if (pane && worker) {
    worker.win.webContents.invalidate(); // a fresh paint, so the pane gets a picture at once
    if (worker.frame) sendFrame();
  }
  return pane;
}

// ---------------------------------------------------------------------------------------------
// IPC

const workerOf = (sender) => [...workers].find((w) => !w.win.isDestroyed() && w.win.webContents === sender) ?? null;

/** Whether `sender` is a background window (main.js handle() lets it through fromWorker). */
const isWorker = (sender) => !!workerOf(sender);

/** Runs `fn(...args)` for a background window's call on `channel`: only WORKER_CALLS, and a save only of its own draft; after a
 * draft save the user's window hears of it. */
async function fromWorker(sender, channel, args, fn) {
  const rec = workerOf(sender);
  if (!rec || !WORKER_CALLS.has(channel)) throw new Error(`${channel} is not available in the background window`);
  if (channel === 'drafts.save' || channel === 'drafts.saveHistory') {
    const id = channel === 'drafts.save' ? args[0]?.id : args[0];
    if (id !== rec.draftId) throw new Error('The background window saves only its own draft');
  }
  const out = await fn(...args);
  if (channel === 'drafts.save') {
    const d = args[0];
    rec.title = String(d.title || 'Untitled draft');
    notify({ type: 'saved', entry: { id: d.id, title: d.title, threadUrl: d.threadUrl ?? null, updated: out.updated, pushedAt: d.pushedAt ?? null } });
  }
  return out;
}

/** The computer.* channels through main.js's handle() (the user's window only). Errors go back as {error, code}. */
function register(handle, main, paths) {
  getMain = main;
  files = paths;
  const answer = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      return { error: String(e.message || e), code: e.code ?? 'failed' };
    }
  };
  handle('computer.act', answer(act));
  handle('computer.open', answer(open));
  handle('computer.close', answer(close));
  handle('computer.pane', setPane);
}

module.exports = { register, isWorker, fromWorker, close, IDLE };

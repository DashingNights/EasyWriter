'use strict';
// Assistant eval (docs/plans/assistant-reliability.md §3 Wave 0; SPEC §7i): each case of prompts.json is typed into the real chat
// panel of the real app (temp userData, window off-screen, the fixture profile restored before every case) and answered by a
// real llama-server or by a stub; score.js scores the tool calls and the reply. Manual (the real model needs a GPU), never part
// of npm test.
//   npm run assistant:eval [-- <run name>]
//   electron <scratchpad>/run-harness.js <absolute path of this file> [run name]
// Environment:
//   DAF_EVAL_SERVER, DAF_EVAL_MODEL, DAF_EVAL_MMPROJ  llama-server.exe and the model and projector .gguf files, written into the
//     temp profile's settings.assistant serverPath / modelPath / mmprojPath, so the app starts the server as in production
//   DAF_EVAL_URL (+ DAF_EVAL_KEY)  a server already running on 127.0.0.1 instead
//   DAF_EVAL_PROVIDER=google (+ GEMINI_API_KEY or DAF_EVAL_KEY, DAF_EVAL_GOOGLE_MODEL)  Gemini through Google AI instead
//   DAF_EVAL_PROVIDER=deepseek | qwen (+ DEEPSEEK_API_KEY or DASHSCOPE_API_KEY, or DAF_EVAL_KEY)  DeepSeek or Qwen Cloud the same way
//   none of these, or DAF_EVAL_STUB=1  a stub server answering each case's `stub` script (the mechanics, no model)
//   DAF_EVAL_SAMPLING  JSON merged over runtime.js SAMPLING.fast and .think and over what runtime.js sampling() returns, so it
//     also holds on requests with tools (which send presence_penalty 0 otherwise), e.g. {"presence_penalty":1.5} for the A/B
//   DAF_EVAL_ONLY  case ids to run, comma-separated
//   DAF_EVAL_STUB_WRONG  a case id whose stub becomes its `stubWrong` script, or else a claim with no call (shows that the
//     scoring fails it, or scores it in part)
//   DAF_EVAL_OUT  the folder for <run name>/result.md, result.json, shapes.png, scene.png (default %TEMP%/daf-writer-eval)
//   DAF_EVAL_TURN_S  seconds one turn may take (default 300; stub 30)
//   DAF_EVAL_SHOW=0  move the window off screen (default: on screen; it ignores the mouse, the run drives it)
//   DAF_EVAL_THINKING  auto (default) | off | low | medium | high: settings.assistant.thinking for every case
//   DAF_EVAL_MODEL_ID  qwen9b (default) | fable9b | gemma12b: settings.assistant.model, so the launch line, the sampling preset
//     and the prompt family (src/app/assistant/prompts.mjs) follow the model under test; the result header names it, with the
//     server's /props model_path and a hash of its chat template when the server answers /props
// A case: {id, note?, view: editor | canvas | board | flows | plan, draft?: the draft open in the editor (default settings.json
// lastDraftId), selection?: ui.select args {path, ids?} (none: a caret in the title line, or with caret: 'end' at the end of the
// last text), typeWhileRunning?: [text, ...] (the first typed into the editor just before sending, then one more every 2 s while
// the turn runs and the draft is still open; result.json `typed` holds what was typed), settings?: merged over fixture/settings.json
// (the user's posts were drawn at forumWidth 1454, the app's default; a whiteboard keeps added items inside the forum width),
// permission: standard | ask | readonly,
// text, expectedFail?: a note (the case waits for a later wave: reported apart, not counted, a pass is flagged), expect: {calls:
// [{name, args?, result?, ok?}] in this order (other calls between are fine; args and the command's result match partially,
// score.js matches), anyOrder?, never: [tools that must not succeed], maxCalls, noClaimWithoutCall, replyMatches?, doc?: a pattern
// for the open draft's blocks [{type, text, firstBold?, flow?, items?}] after the turn (score.js blocks; read with drafts.get),
// draft?: a draft id whose blocks `doc` matches instead, boxes?: {fixture, minIoU}, mark?: {fixture, object, minIoU} and summary?:
// {fixture, sentences, names} (the annotation checks on the open draft's first whiteboard), steps?: [{name, check}] (each check
// one of these expects; the case scores the share of steps met, 0 to 100, and passes at threshold?, default 100; ordered?: a call
// step met out of order scores half; a step's expectedFail?: reported, not counted), shape? / line? / note?: the checks on a copy
// of the user's own board (fixture/*-truth.json), typed?: the draft ends with what typeWhileRunning typed, viewStays?: the open
// draft after the turn is the one before it (score.js)}, stub: [llama-stub.js script entries], stubWrong?: [entries]
// (DAF_EVAL_STUB_WRONG).
// The board items of the drafts read that their fixture files lack are recorded as `added` in result.json, the open draft before
// and after the turn as openBefore and openAfter, and the picture attached to the first request as <run>/<case id>.png.
// npm run assistant:matrix [-- <folder>] tabulates every <run>/result.json of the folder (matrix.js).
// The network stays on 127.0.0.1; the clipboard, the forum and %APPDATA%/daf-writer are never touched.
const { app, dialog, ipcMain, nativeImage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { blocks, score } = require('./score.js');

const ROOT = path.resolve(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixture');
const E = process.env;
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const MAIN_DRAFT = fixture('settings.json').lastDraftId;
const FLOW_ID = fs.readdirSync(path.join(FIX, 'flowcharts'))[0].replace(/\.json$/, '');
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts.json'), 'utf8'))
  .filter((c) => !E.DAF_EVAL_ONLY || E.DAF_EVAL_ONLY.split(',').includes(c.id));
// DAF_EVAL_PROVIDER=google (2026-10-07): Gemini through Google AI, the key in DAF_EVAL_KEY or GEMINI_API_KEY, the model in
// DAF_EVAL_GOOGLE_MODEL (default gemini-3.8-flash); main may then reach generativelanguage.googleapis.com and nothing else.
// DAF_EVAL_PROVIDER=deepseek (2026-10-08) the same way: DEEPSEEK_API_KEY or DAF_EVAL_KEY, DAF_EVAL_DEEPSEEK_MODEL (deepseek-flash).
// DAF_EVAL_PROVIDER=qwen (2026-10-08): Qwen Cloud, DASHSCOPE_API_KEY or DAF_EVAL_KEY, DAF_EVAL_QWEN_MODEL (qwen3.7-plus).
const CLOUD = {
  qwen: { host: 'maas.qwencloudapi.com', key: E.DAF_EVAL_KEY || E.DASHSCOPE_API_KEY || '', model: E.DAF_EVAL_QWEN_MODEL || 'qwen3.7-plus', keyField: 'qwenKey', modelField: 'qwenModel', label: 'Qwen Cloud', env: 'DASHSCOPE_API_KEY' },
  google: { host: 'generativelanguage.googleapis.com', key: E.DAF_EVAL_KEY || E.GEMINI_API_KEY || '', model: E.DAF_EVAL_GOOGLE_MODEL || 'gemini-3.8-flash', keyField: 'googleKey', modelField: 'googleModel', label: 'Google AI', env: 'GEMINI_API_KEY' },
  deepseek: { host: 'api.deepseek.com', key: E.DAF_EVAL_KEY || E.DEEPSEEK_API_KEY || '', model: E.DAF_EVAL_DEEPSEEK_MODEL || 'deepseek-flash', keyField: 'deepseekKey', modelField: 'deepseekModel', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
};
const PROVIDER = Object.hasOwn(CLOUD, E.DAF_EVAL_PROVIDER) ? E.DAF_EVAL_PROVIDER : null;
const GOOGLE_HOST = PROVIDER ? CLOUD[PROVIDER].host : '';
const GOOGLE_KEY = PROVIDER ? CLOUD[PROVIDER].key : '';
const GOOGLE_MODEL = PROVIDER ? CLOUD[PROVIDER].model : '';
const MODE = E.DAF_EVAL_STUB === '1' ? 'stub' : PROVIDER ? 'google'
  : !(E.DAF_EVAL_URL || E.DAF_EVAL_SERVER) ? 'stub' : E.DAF_EVAL_URL ? 'url' : 'local';
const SHOW = E.DAF_EVAL_SHOW !== '0'; // on screen unless DAF_EVAL_SHOW=0 (the user wants to watch the runs)
const THINKING = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(E.DAF_EVAL_THINKING) ? E.DAF_EVAL_THINKING : 'auto'; // settings.assistant.thinking
const MODEL_ID = E.DAF_EVAL_MODEL_ID || 'qwen9b'; // settings.assistant.model
const TURN_MS = (Number(E.DAF_EVAL_TURN_S) || (MODE === 'stub' ? 30 : 300)) * 1000;
const names = process.argv.slice(1).filter((a) => !a.startsWith('-') && !/\.js$/i.test(a) && a !== '.');
const RUN = (names.at(-1) || `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}-${MODE}`).replace(/[^\w.-]/g, '_');
const OUT = path.join(E.DAF_EVAL_OUT || path.join(os.tmpdir(), 'daf-writer-eval'), RUN);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const consoleErrors = [];
const external = [];
const blocked = [];
let header = {};
let serverProps = {}; // the chat server's /props: model_path and the chat template's hash (matrix.js names the .jinja it matches)
let done = false;
function finish(code, msg) {
  if (done) return;
  done = true;
  try {
    report();
  } catch (e) {
    msg += `\nreport failed: ${e.stack}`;
  }
  console.log(msg);
  app.exit(code);
}
dialog.showErrorBox = (title, message) => console.log(`EVAL ERRORBOX: ${title}: ${message}`);
process.on('uncaughtException', (e) => finish(1, `EVAL ERROR ${e.stack}`));
process.on('unhandledRejection', (e) => finish(1, `EVAL ERROR ${e?.stack ?? e}`));
setTimeout(() => finish(2, 'EVAL TIMEOUT'), (MODE === 'stub' ? 600 : 3 * 3600) * 1000);

if (MODE === 'local' && ![E.DAF_EVAL_SERVER, E.DAF_EVAL_MODEL, E.DAF_EVAL_MMPROJ].every((f) => f && fs.existsSync(f))) {
  finish(1, 'EVAL ERROR DAF_EVAL_SERVER, DAF_EVAL_MODEL and DAF_EVAL_MMPROJ must all name existing files');
}
if (MODE === 'url' && new URL(E.DAF_EVAL_URL).hostname !== '127.0.0.1') finish(1, 'EVAL ERROR DAF_EVAL_URL must be on 127.0.0.1');
if (MODE === 'google' && !GOOGLE_KEY) finish(1, `EVAL ERROR DAF_EVAL_PROVIDER=${PROVIDER} needs the API key in ${CLOUD[PROVIDER].env} or DAF_EVAL_KEY`);
// LOCAL LLM (commented out 2026-10-07 in the app): the app no longer starts llama-server, so the local mode cannot run.
if (MODE === 'local') finish(1, 'EVAL ERROR local models are off in the app (2026-10-07). Use DAF_EVAL_PROVIDER=google, DAF_EVAL_URL or the stub.');
if (!['qwen9b', 'fable9b', 'gemma12b'].includes(MODEL_ID)) finish(1, 'EVAL ERROR DAF_EVAL_MODEL_ID must be qwen9b, fable9b or gemma12b');

// Sampling A/B: patched on the module object main.js destructures, before main.js loads. runtime.js sampling() (presence_penalty
// 0 on requests with tools) is wrapped too, so the override is what every request sends.
const SAMPLING = E.DAF_EVAL_SAMPLING ? JSON.parse(E.DAF_EVAL_SAMPLING) : null;
const rtMod = require(path.join(ROOT, 'src', 'assistant', 'runtime.js'));
if (SAMPLING && rtMod.SAMPLING) { // the presets are commented out while local models are off
  const rt = rtMod;
  Object.assign(rt.SAMPLING.fast, SAMPLING);
  Object.assign(rt.SAMPLING.think, SAMPLING);
  const pick = rt.sampling;
  if (typeof pick === 'function') rt.sampling = (...a) => ({ ...pick(...a), ...SAMPLING });
}

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-eval-'));
app.setPath('userData', UD);
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('session-created', (s) => s.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (d, cb) => {
  const local = /^http:\/\/127\.0\.0\.1[:/]/.test(d.url);
  if (!local) blocked.push(d.url);
  cb({ cancel: !local });
}));

// Main's requests: 127.0.0.1 only. Each chat completion is recorded with the case it belongs to: its request body and, read from
// a clone of the stream, its text, tool calls and usage.
const net = { case: null, log: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1' && !(MODE === 'google' && u.hostname === GOOGLE_HOST)) {
    external.push(String(url));
    throw new Error('blocked in the eval');
  }
  if (!u.pathname.endsWith('/chat/completions')) return realFetch(url, opts);
  if (!serverProps.asked && MODE !== 'google') { // the first chat request names the server main uses (also the one it started) and its key
    serverProps = { asked: true };
    realFetch(`${u.origin}/props`, { headers: opts.headers }).then((r) => r.json()).then((p) => {
      if (p.model_path) serverProps.modelPath = String(p.model_path);
      if (p.chat_template) serverProps.template = crypto.createHash('sha256').update(String(p.chat_template)).digest('hex').slice(0, 12);
    }).catch(() => {});
  }
  const rec = { case: net.case, t0: Date.now(), body: JSON.parse(opts.body), text: '', calls: [], usage: null, timings: null, done: false };
  net.log.push(rec);
  let res;
  try {
    res = await realFetch(url, opts);
  } catch (e) {
    rec.done = true;
    throw e;
  }
  if (res.ok && res.body) readStream(res.clone(), rec);
  else rec.done = true;
  return res;
};

async function readStream(res, rec) {
  const take = (block) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      let c;
      try {
        c = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (c.usage) rec.usage = c.usage;
      if (c.timings) rec.timings = c.timings;
      const d = c.choices?.[0]?.delta ?? {};
      if (d.content) rec.text += d.content;
      for (const t of d.tool_calls ?? []) {
        const call = (rec.calls[t.index ?? 0] ??= { id: '', name: '', arguments: '' });
        if (t.id) call.id = t.id;
        if (t.function?.name) call.name = t.function.name;
        if (t.function?.arguments) call.arguments += t.function.arguments;
      }
    }
  };
  const dec = new TextDecoder();
  let buf = '';
  try {
    for await (const bytes of res.body) {
      buf = (buf + dec.decode(bytes, { stream: true })).replace(/\r\n/g, '\n');
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        take(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    take(buf);
  } catch {
    rec.aborted = true;
  }
  rec.ms = Date.now() - rec.t0;
  rec.done = true;
}

// The grounding pictures: white, with the shapes of fixture/shapes.json (or scene.json) filled at their boxes, in order.
function shapesPng({ size: [W, H], shapes }) {
  const buf = Buffer.alloc(W * H * 4, 255); // BGRA
  for (const s of shapes) {
    const [x1, y1, x2, y2] = s.box;
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(s.color.slice(k, k + 2), 16));
    const [cx, cy, rx, ry] = [(x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2];
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const [px, py] = [x + 0.5, y + 0.5];
        const inside = s.kind === 'circle' ? ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1
          : s.kind === 'triangle' ? Math.abs(px - cx) <= (rx * (py - y1)) / (y2 - y1) : true;
        if (inside) buf.set([b, g, r, 255], (y * W + x) * 4);
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG();
}

// Stub mode: llama-stub.js takes the next entry of `script` per request; this one serves the running case's entries, then "OK.".
const queue = [];
const script = { get length() { return 1; }, shift: () => queue.shift() ?? { text: 'OK.' } };
let stub = null;
const pics = {}; // fixture placeholder ("@shapes.png") → the picture's data URL

function assistantSettings(permission, step) {
  const base = { panel: null, thinking: THINKING, uiControl: true, permission, step, model: MODEL_ID, warmAtStart: false, sleepMinutes: 0, idleUnloadMinutes: 0, backend: 'auto' };
  if (MODE === 'stub') return { ...base, installed: false, backend: 'cpu', serverUrl: stub.url };
  if (MODE === 'url') return { ...base, installed: false, serverUrl: E.DAF_EVAL_URL, apiKey: E.DAF_EVAL_KEY ?? '' };
  if (MODE === 'google') return { ...base, installed: false, provider: PROVIDER, [CLOUD[PROVIDER].keyField]: GOOGLE_KEY, [CLOUD[PROVIDER].modelField]: GOOGLE_MODEL };
  return { ...base, installed: true, serverPath: E.DAF_EVAL_SERVER, modelPath: E.DAF_EVAL_MODEL, mmprojPath: E.DAF_EVAL_MMPROJ };
}

/** The fixture profile for case `c`: drafts and flowcharts as in fixture/, settings with the case's permission and page. The
 * degrade step main may have saved is kept (a reset step would restart the server on every case). */
function writeProfile(c) {
  let step = 0;
  try {
    step = JSON.parse(fs.readFileSync(path.join(UD, 'settings.json'), 'utf8')).assistant?.step ?? 0;
  } catch {}
  for (const d of ['drafts', 'flowcharts', 'plans']) fs.rmSync(path.join(UD, d), { recursive: true, force: true });
  for (const d of ['drafts', 'flowcharts']) {
    fs.mkdirSync(path.join(UD, d));
    for (const f of fs.readdirSync(path.join(FIX, d))) {
      const text = Object.entries(pics).reduce((t, [k, url]) => t.replaceAll(JSON.stringify(k), JSON.stringify(url)), fs.readFileSync(path.join(FIX, d, f), 'utf8'));
      fs.writeFileSync(path.join(UD, d, f), text);
    }
  }
  const lastView = c.view === 'flows' ? { type: 'flows', flowId: FLOW_ID } : c.view === 'plan' ? { type: 'plan' } : { type: 'editor' };
  fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ ...fixture('settings.json'), ...c.settings, ...(c.draft && { lastDraftId: c.draft }), lastView, assistant: assistantSettings(c.permission ?? 'standard', step) }));
}

let evalWin = null; // the app's window; the background window (background.open, computer-main.js) runs on its own
app.on('browser-window-created', (_, win) => {
  if (evalWin) return;
  evalWin = win;
  win.show = () => {
    win.showInactive();
    if (!SHOW) win.setPosition(-4000, 0);
  };
  win.on('close', (e) => e.preventDefault()); // the app's beforeunload may close the window during a reset; app.exit ends the run
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  win.webContents.once('did-finish-load', () => run(win).catch((e) => finish(1, `EVAL ERROR ${e.stack}`)));
});

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of ['shapes', 'scene']) {
    const png = shapesPng(fixture(`${name}.json`));
    fs.writeFileSync(path.join(OUT, `${name}.png`), png);
    pics[`@${name}.png`] = `data:image/png;base64,${png.toString('base64')}`;
  }
  if (MODE === 'stub') stub = await require(path.join(ROOT, 'test', 'fixtures', 'llama-stub.js')).start({ nCtx: 16384, script, vision: true });
  writeProfile(CASES[0] ?? {});
  require(path.join(ROOT, 'main.js'));
  for (const ch of ['forum.status', 'forum.login', 'forum.discover', 'forum.push', 'forum.open']) {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async () => { if (ch === 'forum.status') return { loggedIn: false }; throw new Error('blocked in the eval'); });
  }
});

async function run(win) {
  const wc = win.webContents;
  const js = (s) => wc.executeJavaScript(s);
  const J = async (s) => JSON.parse(await js(`Promise.resolve(${s}).then((v) => JSON.stringify(v) ?? 'null')`));
  const until = async (fn, ms, step = 100) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(step)) {
      const v = await fn();
      if (v) return v;
    }
    return null;
  };
  const R = Math.round;
  const click = async (x, y) => {
    wc.sendInputEvent({ type: 'mouseMove', x: R(x), y: R(y) });
    await wait(40);
    wc.sendInputEvent({ type: 'mouseDown', x: R(x), y: R(y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: R(x), y: R(y), button: 'left', clickCount: 1 });
    await wait(300);
  };
  const clickEl = async (expr) => {
    const r = await J(`(() => { const r = ${expr}?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (r) await click(r.x, r.y);
    return !!r;
  };
  const invoke = (id, args = {}) => J(`window.__agent.invoke({ id: ${JSON.stringify(id)}, args: ${JSON.stringify(args)}, source: 'ui' })`);
  const EDITOR = `document.querySelector('#editor .ProseMirror').editor`;
  const typeInEditor = async (text) => { // at its selection; view.focus is synchronous (commands.focus waits for a frame)
    await js(`${EDITOR}.view.focus(); true`);
    await wait(50);
    for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch });
  };
  const BOX = `document.querySelector('[data-assistant-panel] [data-chat-input]')`;
  const idle = () => J(`!!document.querySelector('[data-assistant-panel] [aria-label="Send"]')`);
  const ready = async () => {
    await until(() => J(`!!document.querySelector('#editor .ProseMirror')?.editor && !!window.__agent`), 20000);
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await js(`window.confirm = () => false; window.alert = () => {}; navigator.clipboard.writeText = () => Promise.resolve(); navigator.clipboard.write = () => Promise.resolve(); true`);
    await wait(800); // boards drawn, a workspace page restored
  };
  const openPanel = async () => {
    await clickEl(`document.querySelector('[data-chat-island] button')`);
    return until(() => J(`!!${BOX}`), 15000);
  };

  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) consoleErrors.push(String(e.message).slice(0, 300)); });
  win.setIgnoreMouseEvents(true);
  wc.setBackgroundThrottling(false);
  win.setContentSize(1600, 1000);
  win.showInactive();
  if (!SHOW) win.setPosition(-4000, 0);
  wc.debugger.attach('1.3');
  await ready();
  const risk = Object.fromEntries(await J(`window.__agent.catalogue().map((c) => [c.id.replaceAll('.', '_'), c.risk])`));
  if (!(await openPanel())) {
    return finish(1, `EVAL ERROR the chat box did not show: ${JSON.stringify(await J('window.api.assistant.status()'))}`);
  }
  if (MODE !== 'stub') { // the model loads before the first case, so its load time counts in no turn
    console.log('Waiting for the server to load the model...');
    const up = await until(async () => {
      const s = await J('window.api.assistant.status()');
      if (s.server?.state === 'error') throw new Error(`the server failed: ${s.server.error}`);
      return s.server?.state === 'ready';
    }, 300000, 1000);
    if (!up) return finish(1, 'EVAL ERROR the server did not get ready in 5 minutes');
  }
  header = { run: RUN, date: new Date().toISOString(), mode: MODE, server: MODE === 'url' ? E.DAF_EVAL_URL : MODE === 'local' ? path.basename(E.DAF_EVAL_SERVER) : MODE === 'google' ? CLOUD[PROVIDER].label : 'stub',
    model: MODE === 'local' ? path.basename(E.DAF_EVAL_MODEL) : MODE === 'url' ? '(the running server)' : MODE === 'google' ? GOOGLE_MODEL : 'stub', modelId: MODEL_ID, thinking: THINKING, samplingOverride: SAMPLING, userData: UD };

  for (const c of CASES) {
    const r = { id: c.id, view: c.view, permission: c.permission ?? 'standard', text: c.text, ...(c.expectedFail && { expectedFail: c.expectedFail }), pass: false, fails: [] };
    results.push(r);
    try {
      // The fixture again: the last case's writes and the chat go.
      await wait(1200); // the last case's autosave (800 ms)
      await wc.loadURL('about:blank');
      writeProfile(c);
      await win.loadFile(path.join(ROOT, 'index.html'));
      await ready();
      const ui = await invoke('ui.state');
      const page = c.view === 'flows' || c.view === 'plan' ? c.view : 'editor';
      if (ui.result?.view !== page) throw new Error(`setup: the page is ${ui.result?.view}, not ${page}`);
      if (page === 'editor' && (await invoke('app.info')).result?.draftId !== (c.draft ?? MAIN_DRAFT)) throw new Error('setup: the fixture draft is not open');
      if (!(await openPanel())) throw new Error('setup: the chat box did not show');
      const typing = [...(c.typeWhileRunning ?? [])];
      if (c.selection) {
        const s = await invoke('ui.select', c.selection);
        if (!s.ok) throw new Error(`setup: ui.select failed: ${s.error?.message}`);
      } else if (page === 'editor' && c.caret === 'end') { // the end of the last text block with text
        await js(`(() => { const ed = ${EDITOR}; let at = 1; ed.state.doc.descendants((n, p) => { if (n.isTextblock && n.textContent.trim()) at = p + n.nodeSize - 1; });
          ed.commands.setTextSelection(at); return true; })()`);
      } else if (page === 'editor') {
        await js(`${EDITOR}.commands.setTextSelection(3); true`);
      }
      if (typing.length) {
        await typeInEditor(typing[0]);
        Object.assign(r, { typed: [typing.shift()], typedAt: [] }); // typedAt: ms after sending, per entry typed during the turn
        await wait(300);
      }
      await clickEl(BOX); // the real focus path: the selection becomes the auto pill
      await js(`${BOX}.editor.commands.focus('end'); true`);
      wc.insertText(c.text);
      await wait(200);
      // The tray above the text box holds the attachments (2026-10-07); each item's label is its title.
      r.attached = await J(`[...document.querySelectorAll('[data-assistant-panel] [data-tray-item] [title]')].map((e) => e.title)`);
      if (c.selection && !r.attached.length) r.fails.push('setup: nothing was attached');

      queue.splice(0, queue.length, ...structuredClone(E.DAF_EVAL_STUB_WRONG !== c.id ? c.stub ?? [] : c.stubWrong ?? [{ text: "I've done it." }]));
      net.case = c.id;
      const users = () => J(`document.querySelectorAll('[data-chat-messages] > [data-role="user"]').length`);
      const before = await users();
      const openDraft = async () => (await invoke('app.info')).result?.draftId ?? null;
      r.openBefore = await openDraft();
      const t0 = Date.now();
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      if (!(await until(async () => (await users()) > before, 5000, 50))) throw new Error('setup: the message was not sent');
      r.approvals = 0;
      let typeAt = t0 + 2000;
      for (;;) {
        if (await J(`!!document.querySelector('[data-agent-ask]')`)) { // Standard asks before a destructive call: allowed
          await js(`[...document.querySelectorAll('[data-agent-ask] button')].find((b) => b.textContent.trim() === 'Allow')?.click(); true`);
          r.approvals++;
          await wait(300);
          continue;
        }
        if (await idle()) break;
        if (typing.length && Date.now() >= typeAt) { // the user types on in the draft, until the view leaves it
          typeAt += 2000;
          if (await openDraft() === r.openBefore) {
            await typeInEditor(typing[0]);
            r.typed.push(typing.shift());
            r.typedAt.push(Date.now() - t0);
          } else {
            r.typingStopped = `the open draft changed after ${r.typed.length} of ${c.typeWhileRunning.length} entries were typed`;
            typing.length = 0;
          }
        }
        if (Date.now() - t0 > TURN_MS) {
          r.fails.push(`timed out after ${TURN_MS / 1000} s`);
          await js(`document.querySelector('[data-assistant-panel] [aria-label="Stop"]')?.click(); true`);
          await until(idle, 10000);
          break;
        }
        await wait(150);
      }
      r.seconds = Math.round((Date.now() - t0) / 100) / 10;
      r.openAfter = await openDraft();
      net.case = null;
      const reqs = net.log.filter((x) => x.case === c.id);
      await until(() => reqs.every((x) => x.done), 5000);
      const pic = [reqs[0]?.body.messages.findLast((m) => m.role === 'user')?.content].flat().find((p) => p?.type === 'image_url')?.image_url.url;
      if (pic) fs.writeFileSync(path.join(OUT, `${c.id}.${pic.slice(11, pic.indexOf(';'))}`), Buffer.from(pic.slice(pic.indexOf(',') + 1), 'base64'));
      // Every other picture the model was shown during the turn (view_render answers, the picture after a board change), in order,
      // as <case id>-pic-N.png: what the model saw when it placed its items.
      const shown = new Set([pic]);
      for (const q of reqs) for (const m of q.body?.messages ?? []) for (const p of [m.content].flat()) {
        const u = m.role === 'user' && p?.type === 'image_url' ? p.image_url.url : null;
        if (!u || shown.has(u)) continue;
        shown.add(u);
        fs.writeFileSync(path.join(OUT, `${c.id}-pic-${shown.size - 1}.${u.slice(11, u.indexOf(';'))}`), Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
      }
      Object.assign(r, collect(reqs, await J(`(() => {
        const rows = [...document.querySelectorAll('[data-chat-messages] > [data-role]')];
        return rows.slice(rows.map((e) => e.dataset.role).lastIndexOf('user') + 1).map((e) => ({ role: e.dataset.role, ok: e.dataset.ok === 'true',
          text: (e.dataset.role === 'step' ? e.querySelector('span') : e.querySelector(':scope > div.break-words'))?.textContent ?? '',
          error: e.querySelector(':scope > p.text-destructive')?.textContent ?? '' }));
      })()`), risk));
      const checks = [c.expect, ...(c.expect.steps ?? []).map((s) => s.check)];
      if (checks.some((k) => k.doc || k.mark || k.summary || k.shape || k.line || k.note || k.typed)) await readDocs(r, checks.map((k) => k.draft), invoke);
      const s = score(c.expect, r, fixture);
      r.fails.push(...s.fails);
      if (s.boxes) r.boxes = s.boxes;
      if (s.steps) Object.assign(r, { score: s.score, steps: s.steps });
      r.pass = !r.fails.length;
    } catch (e) {
      net.case = null;
      r.fails.push(e.message);
    }
    console.log(`${r.expectedFail ? (r.pass ? 'XPASS' : 'XFAIL') : r.pass ? 'PASS' : 'FAIL'} ${c.id}${r.score !== undefined ? ` ${r.score}%` : ''} (${r.calls?.length ?? 0} calls, ${r.tokens ?? 0} tokens, ${r.seconds ?? 0} s)${r.fails.length ? `: ${r.fails.join('; ')}` : ''}`);
  }
  if (MODE === 'local') await js('window.api.assistant.stop()').catch(() => {});
  await stub?.close();
  const t = tally();
  finish(t.passed === t.total ? 0 : 3, `${t.passed} of ${t.total} passed.${t.xfail.length ? ` Expected fails: ${t.xfail.join(', ')}.` : ''}${t.xpass.length ? ` Passed although expected to fail: ${t.xpass.join(', ')}.` : ''} ${path.join(OUT, 'result.md')}`);
}

/** The drafts as the turn left them (drafts.get: the open one from the editor, the others as saved): `r.doc` the open draft's
 * blocks (score.js blocks), `r.docs` those of the drafts `ids` names, `r.added` the board items of these drafts that their
 * fixture files lack. */
async function readDocs(r, ids, invoke) {
  const added = [];
  const read = async (id) => {
    const d = await invoke('drafts.get', { draftId: id });
    if (!d.ok) return null;
    let had = new Set();
    try {
      had = new Set(fixture(`drafts/${id}.json`).doc.content.flatMap((n) => (n.attrs?.items ?? []).map((i) => i.id)));
    } catch {}
    const out = blocks(JSON.parse(JSON.stringify(d.result.draft.doc, (k, v) => (k === 'src' && typeof v === 'string' && v.length > 200
      ? `${v.slice(0, 32)}... (${v.length} characters)` : v)))); // the pictures of the eval set 4 posts would add megabytes to result.json
    added.push(...out.flatMap((b) => (b.items ?? []).filter((i) => !had.has(i.id))));
    return out;
  };
  const open = (await invoke('app.info')).result?.draftId;
  if (open) r.doc = await read(open);
  const named = [...new Set(ids.filter(Boolean))];
  if (named.length) r.docs = Object.fromEntries(await Promise.all(named.map(async (id) => [id, id === open ? r.doc : await read(id)])));
  if (added.length) r.added = added;
}

/** Pass counts without the expected-fail cases, which are listed apart: failed as expected (xfail) or passed (xpass). */
function tally() {
  const counted = results.filter((x) => !x.expectedFail);
  const xf = results.filter((x) => x.expectedFail);
  return { passed: counted.filter((x) => x.pass).length, total: counted.length, xfail: xf.filter((x) => !x.pass).map((x) => x.id), xpass: xf.filter((x) => x.pass).map((x) => x.id) };
}

/** The turn from the recorded requests `reqs` and the chat rows after the user's message: each tool call (the first of a
 * completion; the loop runs one) with its full arguments, whether it ran (its answer in the next request is a command answer,
 * or, for the last call, a step line is left) and its step line's result; the reply, the errors, tokens and the picture size. */
function collect(reqs, rows, risk) {
  const steps = rows.filter((x) => x.role === 'step');
  let s = 0;
  const calls = [];
  reqs.forEach((q, k) => {
    const call = q.calls[0];
    if (!call || q.aborted) return; // an aborted stream (a loop, Stop) runs no call
    let args;
    try {
      args = JSON.parse(call.arguments || '{}');
    } catch {
      args = call.arguments;
    }
    const answer = reqs[k + 1]?.body.messages.findLast((m) => m.role === 'tool')?.content; // the newest answer is this call's
    let res = null;
    try { // the answer's JSON, without the loop's calls-left line and circle note after it
      res = JSON.parse(answer.replace(/ Calls left in this reply: \d+\.$/, '').replace(/\n\nYou are going round in circles[^\n]*$/, ''));
    } catch {}
    const ran = answer === undefined ? s < steps.length : (res !== null && 'ok' in Object(res)) || /^\{"ok":/.test(answer);
    const step = ran ? steps[s++] : null;
    calls.push({ name: call.name, args, ran, ok: step ? step.ok : false, risk: risk[call.name] ?? null,
      ...(res?.error && { code: res.error.code }), ...(res?.ok && { result: res.result }), ...(step && { line: step.text }) });
  });
  const tok = (q) => (q.usage ? [q.usage.prompt_tokens ?? 0, q.usage.completion_tokens ?? 0]
    : q.timings ? [(q.timings.prompt_n ?? 0) + (q.timings.cache_n ?? 0), q.timings.predicted_n ?? 0] : [0, 0]);
  const first = reqs[0]?.body;
  const user = first?.messages.findLast((m) => m.role === 'user')?.content;
  const pic = Array.isArray(user) ? user.find((p) => p.type === 'image_url')?.image_url.url : null;
  const png = pic ? Buffer.from(pic.slice(pic.indexOf(',') + 1, pic.indexOf(',') + 65), 'base64') : null;
  return {
    calls,
    reply: rows.filter((x) => x.role === 'assistant').map((x) => x.text).filter(Boolean).join('\n'),
    errors: rows.map((x) => x.error).filter(Boolean),
    requests: reqs.length,
    tokens: reqs.reduce((n, q) => n + tok(q)[0] + tok(q)[1], 0),
    maxPrompt: Math.max(0, ...reqs.map((q) => tok(q)[0])),
    ...(png && { sent: [png.readUInt32BE(16), png.readUInt32BE(20)] }),
    offered: first?.tools?.map((t) => t.function.name) ?? [],
    sampling: first && Object.fromEntries(['temperature', 'top_p', 'top_k', 'presence_penalty', 'max_tokens'].map((k) => [k, first[k]])),
    prompt: (Array.isArray(user) ? user.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : user ?? '').slice(0, 4000),
  };
}

function report() {
  fs.mkdirSync(OUT, { recursive: true });
  const { passed, total, xfail, xpass } = tally();
  const sampling = results.find((x) => x.sampling)?.sampling;
  const { asked, ...props } = serverProps;
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ...header, ...props, passed, total, xfail, xpass, consoleErrors, external, blocked, results }, null, 1));
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# Assistant eval: ${RUN}`,
    '',
    `${header.date ?? new Date().toISOString()}. Server: ${header.server ?? MODE}. Model: ${header.model ?? '?'}. Model id: ${MODEL_ID}.${props.modelPath ? ` Model file (/props): ${props.modelPath}.` : ''}${props.template ? ` Chat template sha256: ${props.template}.` : ''}`,
    `Sampling sent: ${sampling ? Object.entries(sampling).map(([k, v]) => `${k} ${v}`).join(', ') : 'none recorded'}${SAMPLING ? ` (DAF_EVAL_SAMPLING ${JSON.stringify(SAMPLING)})` : ''}. Thinking: ${THINKING}.`,
    '',
    `Passed ${passed} of ${total}.${xfail.length ? ` Expected fails (not counted): ${xfail.join(', ')}.` : ''}${xpass.length ? ` Passed although expected to fail (not counted): ${xpass.join(', ')}.` : ''}${MODE === 'stub' ? ' Stub tokens are estimates (request characters / 4, pictures included).' : ''}`,
    '',
    '| Case | Pass | Score | Calls made | Tokens | Seconds | Note |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'}${r.expectedFail ? ' (expected fail)' : ''} | ${r.score !== undefined ? `${r.score}%` : ''} | ${cell((r.calls ?? []).map((c) => `${c.name} ${!c.ran ? 'not run' : c.ok ? 'ok' : `failed${c.code ? ` (${c.code})` : ''}`}`).join(', ') || 'none')} | ${r.tokens ?? ''} | ${r.seconds ?? ''} | ${cell([...r.fails, ...(r.pass && r.boxes ? [r.boxes.note] : []), ...(r.errors ?? [])].join('; '))} |`),
    '',
    `Console errors: ${consoleErrors.length}. Blocked requests: ${blocked.length + external.length}. Details per case (arguments, replies, the situation note sent, the drafts after the turn, the board items added): result.json.`,
    '',
    ...results.filter((r) => r.steps).flatMap((r) => [
      `## ${r.id}: ${r.score}%`,
      '',
      '| Step | Credit | Note |',
      '|---|---|---|',
      ...r.steps.map((s) => `| ${cell(s.name)}${s.expectedFail ? ' (expected fail, not counted)' : ''} | ${s.credit * 100}% | ${cell([s.note, s.expectedFail].filter(Boolean).join('; '))} |`),
      '',
    ]),
  ];
  fs.writeFileSync(path.join(OUT, 'result.md'), lines.join('\n'));
}

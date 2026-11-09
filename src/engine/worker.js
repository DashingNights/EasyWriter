// The document engine's worker (docs/plans/engine/plan.md sections 1 and 3, viewport-design.md section 8): one per window, it
// holds every open draft as a session (the engine's editing session: the document, its layout and undo history) in one
// WebAssembly instance (wasm/, built from engine/crates/wasm), with one font database and one command registry for all of them,
// and answers client.js. A module worker, so the wasm-bindgen glue finds ew_bg.wasm beside itself. Plain web APIs only: Worker,
// OffscreenCanvas, fetch.
//
// Messages in: {id, method, args, session}; `session` names the draft's session (0 when left out), which the first call to it
// opens on a blank document. Out: {id, result} or {id, error}, and events {event, data, session}: 'layout' {version, from, to,
// pages, steps} after any change to a session's layout (pages from..to, `to` not included, draw differently: an edit lays out
// only what it changes; `steps` {undo, redo} are the ids of its top undo and redo steps), then 'selection' {anchor, head,
// version, caret, rects, comp} after any change to its selection or layout (the wrapper crate's selectionEvent: what input
// draws, for that layout version, so a typed letter needs no call besides the edit; a highlight's rects cover the pages the
// session's views wish tiles of, and follow them), 'tiles' {list} with the tiles the host
// wished for (the tile queue below), and for the whole worker 'fonts.missing' {families: [{family, standIn, standIns}],
// scripts} when layout met fonts it lacks (fonts/provider.mjs answers with addFont, then fontsDone),
// 'data' {pending} when a fetch of the data files layout asked for starts or ends (`pending` fetches left), and 'crash' {message} when
// the engine stopped (a Rust panic traps the instance and ends every session): every later call fails, and the host starts a
// new worker.
// A session's 'command' {id} follows a command that left its selection where it was, so the tools read their state again.
import init, * as ew from './wasm/ew.js';

// Measuring only (docs/plans/engine/measure.md); the app sets neither. `worker.js?marks` times the start (fetch, compile,
// instantiate) and every call (the call, the relayout after it, the repaints) and posts each as a 'marks' event.
// `?build=<folder URL>` runs the ew crate's measure build from that folder instead of wasm/ and adds the `bench` call, which
// runs one of its measure functions. A call's marks hold `paint`, the time its relayout's tiles took to repaint in the same
// turn, and `repainted`, their surfaces.
const flags = new URL(import.meta.url).searchParams;
const MARKS = flags.has('marks') || flags.has('build');
const BUILD = flags.get('build');

let dead = null;
/** The glue module the sessions come from: wasm/ew.js, or the measure build's under ?build. */
let glue = ew;
/** The instance's memory, where a painted tile's pixels are read. */
let memory = null;
/** The compiled .wasm, which the helper worker instantiates too (client.js), so it is compiled once. */
let module = null;

/** Compiles the .wasm at `url`; from its bytes when the response is not served as application/wasm, as the glue does. */
async function compile(url) {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    return WebAssembly.compile(await (await fetch(url)).arrayBuffer());
  }
}

/** The engine's own fonts, which ship beside the .wasm rather than in it (fonts/bundled.mjs): added to the worker's font
 * database once, before the first session. Imported here, after the stamp check, so a copy of this worker elsewhere
 * (engine-build's check) still reports a foreign build. */
const addFonts = async () => (await import('./fonts/bundled.mjs')).addBundledFonts(glue);

/** tiles.mjs `untouched`: which wished tiles a layout's damage spared (noteChange). Loaded with the fonts, after the stamp check. */
let untouched = () => false;
/** The app's version for the files the engine writes (app-version.mjs), set before the first session. Without it they say
 * EasyWriter alone, so a failure here stops nothing. */
const setVersion = () => import('./app-version.mjs').then(async (m) => glue.setAppVersion(await m.appVersion())).catch(() => {});
const addParts = () => Promise.all([addFonts(), import('./view/tiles.mjs').then((m) => (untouched = m.untouched)), setVersion()]);

// The .wasm carries the hash of the sources it was built from, and STAMP beside it the hash this checkout's sources have
// (scripts/build-engine-wasm.mjs writes both). A stale or foreign build is refused here, before it runs against the wrong code.
// A measuring start skips the check: a ?build folder holds a measure build, whose sources differ by the measure feature.
const ready = MARKS ? start() : Promise.all([
  compile(new URL('wasm/ew_bg.wasm', import.meta.url)).then((m) => init({ module_or_path: (module = m) })),
  fetch(new URL('wasm/STAMP', import.meta.url)).then((r) => r.text()),
]).then(([wasm, text]) => {
  memory = wasm.memory;
  const want = text.trim();
  const have = ew.buildStamp?.() || 'none';
  if (have !== want) {
    throw new Error(`its .wasm is build ${have.slice(0, 12)} but STAMP expects ${want.slice(0, 12)}. Run npm run build to rebuild it.`);
  }
  return addParts();
});

/** init() in its parts, each timed. Compiling from bytes is what the glue falls back to when the response is not served as
 * application/wasm, as file:// may not be; `type` says which. */
async function start() {
  const t0 = performance.now();
  if (BUILD) glue = await import(new URL('ew.js', BUILD).href);
  const t1 = performance.now();
  const res = await fetch(BUILD ? new URL('ew_bg.wasm', BUILD) : new URL('wasm/ew_bg.wasm', import.meta.url));
  const bytes = await res.arrayBuffer();
  const t2 = performance.now();
  module = await WebAssembly.compile(bytes);
  const t3 = performance.now();
  memory = (await (BUILD ? glue.default : init)({ module_or_path: module })).memory;
  const t4 = performance.now();
  await addParts();
  const t5 = performance.now();
  session(0);
  const t6 = performance.now();
  postMessage({ event: 'marks', data: { start: { glue: t1 - t0, fetch: t2 - t1, compile: t3 - t2, instantiate: t4 - t3, fonts: t5 - t4,
    engine: t6 - t5, bytes: bytes.byteLength, type: res.headers.get('content-type') } } });
}

/** The open sessions: id → {id, engine, changed (surface → the layout version that last changed it), sel (the layout version
 * and selection its last selection event was for)}. Views show a session through tiles (the tile queue below); the whole-page
 * canvases of stage 1 (attach, detach, paint) went with engine-view. */
const sessions = new Map();

/** Session `id`, opened on a blank document the first time. */
function session(id) {
  let s = sessions.get(id);
  if (!s) sessions.set(id, (s = { id, engine: new glue.Engine(), changed: [], sel: null, ahead: null, unsettled: false, posted: 0, view: null, shown: [], wide: false, typed: -Infinity }));
  return s;
}

// ---------- Layout in slices (viewport-design.md section 8, engine-open) ----------
// After `ahead` (a session's call), a layout from the start (an open, new fonts, an edit that lays everything out again) lays
// out the pages up to the view's and pauses; its layout event says `settled: false`. The rest is laid out here, SLICE_MS at
// a time in turns of their own after the calls and the tile wishes, so input, scrolling and painting wait at most one slice.
// The pages a slice adds go out in a layout event at most every SLICE_EVENT_MS (each carries every page's size), and when
// the layout settles. Without `ahead` a session lays out whole, as before.
// engine-repaginate-2: while edits come (keys) a slice is SLICE_INPUT_MS, and the engine pauses between the blocks of a page
// once its time is up, so a key that arrives during one waits behind about that much layout (and the block under way), not
// 8 ms of it. A worker cannot see a message waiting for it, so a short slice is how it lets one in sooner. Once no edit has
// come for INPUT_MS the slices are long again: each slice costs about 0.5 ms of its own to start (the Word fixture's open in
// Node: the rest in 0.5 ms slices 4.3 s, in 8 ms ones 1.7 s), and the reads a page area makes while a document opens are not
// keys to wait for.
// engine-keys-final: the slices that end a pass or begin one (the engine's endsPassNext: the document's last block, then every
// page's headers and footers and the line index, a few pages a slice; or the start of a pass) wait while that draft is being
// edited, until no call has changed its document or moved its selection for INPUT_MS (`typed`, per session): an edit takes
// the pass back to its last mark, so that work done between keys would be done again after each. Once the typing pauses
// they go in SLICE_MS slices like the rest, so a key then waits behind one of those rather than a whole pass's end (in one
// piece, 25 to 31 ms of the Word fixture natively; on page 900, after Delete took a section break out, keys waited behind
// such slices up to 18 ms). Reads do not count: the page area's tools read the engine through exec while a document opens
// (fields.ranges and document.settings, 43 times in the fixture's 5.6 s open), and counted as edits they held the open's
// pass until engine-open's 120 s wait ran out.

/** Pages laid out before an open returns by default: the view's at the document's start, at any zoom up to two pages across. */
const AHEAD = 4;
const SLICE_MS = 8;
const SLICE_INPUT_MS = 0.5;
const INPUT_MS = 500;
const SLICE_EVENT_MS = 100;
/** When the last edit came. */
let called = -Infinity;
/** ?marks: the last slice, on the clock both threads share, and the paragraph layouts it looked up, so a call that came
 * during it can say how much layout it waited behind. */
let lastSlice = null;

/** Session `s` lays out from the start at least `pages` pages (AHEAD when not given) before it returns, or with null the whole
 * document at once. */
function ahead(s, pages = AHEAD) {
  s.ahead = pages == null ? null : Math.max(1, pages);
  s.engine.setAhead(s.ahead ?? undefined);
  return s.ahead;
}

/** Session `s`, laid out whole (no `ahead`), lays out in slices the layout from the start that the worker's new fonts or data
 * start, as an open does, up to its views' pages first: in one piece it held every draft's calls for the whole of it
 * (engine-main-thread-2: engine-helper's fixture session, which no view shows, after its fonts arrived). Any such session is
 * sliced, a view or not, so until it settles its pages() lists the pages done so far with settled: false. It lays out whole
 * again once that settles (flushSession). */
function sliceAgain(s) {
  if (s.ahead != null || s.quiet) return;
  s.sliced = true;
  s.engine.setAhead(Math.max(AHEAD, (s.view?.[1] ?? 0) + 1));
}

/** A session laying out ahead does so at least as far as page `page`, the last its views wish for. */
function lookAhead(s, page) {
  const pages = Math.max(AHEAD, page + 2);
  if (s.ahead != null && pages !== s.ahead) ahead(s, pages);
}

/** Session `s`'s next slice may run now: its layout is not settled, its draft is not being read (`live`), and the slice
 * neither ends a pass nor begins one while its draft is edited (`typed`: when a call last changed that document or moved
 * its selection). */
const mayRun = (s) => s.unsettled && live(s) && (performance.now() - s.typed >= INPUT_MS || !s.engine.endsPassNext());
/** The timer that lets a slice held back for the typing run once it pauses. */
let idle = 0;

/** Whether a slice is due: a session's next slice may run, and no font burst is arriving. A burst ends in one layout from
 * the start (fontsDone or its timer, below), which slices meanwhile would only begin again for each font file. A slice held
 * back while edits come is due again INPUT_MS after the last edit. */
function sliceDue() {
  if (flushTimer) return false;
  const open = [...sessions.values()].filter((s) => s.unsettled && live(s));
  if (open.some(mayRun)) return true;
  if (open.length && !idle) {
    // Each draft's own typing holds its own slices: a draft opened beside the one being typed in settles meanwhile.
    const last = Math.min(...open.map((s) => s.typed));
    idle = setTimeout(() => {
      idle = 0;
      schedule();
    }, Math.max(0, INPUT_MS - (performance.now() - last)) + 1);
  }
  return false;
}

/** One slice of the first session whose next slice may run, then its layout event when one is due. */
function settleSlice() {
  const s = !flushTimer && [...sessions.values()].find(mayRun);
  if (!s) return;
  const t0 = performance.now();
  const paras = MARKS ? s.engine.paragraphLayouts() : 0;
  const done = s.engine.settle(t0 - called < INPUT_MS ? SLICE_INPUT_MS : SLICE_MS);
  if (MARKS) lastSlice = { start: performance.timeOrigin + t0, end: performance.timeOrigin + performance.now(), paras: s.engine.paragraphLayouts() - paras };
  s.unsettled = !done;
  if (done || performance.now() - s.posted >= SLICE_EVENT_MS) flushSession(s, null);
  // Pages laid out later meet fonts and hyphenation data of their own.
  report();
}

const json = (s) => (s == null ? null : JSON.parse(s));
const str = (v) => JSON.stringify(v);

// Event batches (viewport-design.md section 4.4): the events one turn produces go to the page as one message {batch: [events]},
// so an edit's layout, its caret (the selection event) and its repainted tiles land in one task on the main thread, and so in
// one frame: the caret never runs ahead of the text.
// engine-keys-final measured the other order, the layout and caret sent before the paint and the tiles after them: at page
// 300 of the Word fixture (two runs each way) the caret reached the page 2 ms sooner at the median and the tiles 0.2 ms
// sooner (0.4 to 2.4 at p95), but a frame drawn between the two showed the caret alone, and the frame that showed the text
// came 6 ms later at the median (keystroke to frame 8.6 and 9.1 ms against 15.2 and 14.6; 107 and 102 keys of 240 over
// 16 ms against 29 and 36).
let batch = null;
/** ?marks: when the last batch left (batched). */
let lastPosted = null;
/** Paint time spent in the open batch's turn, against TURN_MS. */
let painted = 0;
const post = (event, data, s, transfer = []) => {
  const e = s ? { event, data, session: s.id } : { event, data };
  if (!batch) return postMessage(e, transfer);
  batch.events.push(e);
  batch.transfer.push(...transfer);
};

/** Runs `fn` with the events it posts sent as one message. */
function batched(fn) {
  if (batch) return fn();
  batch = { events: [], transfer: [] };
  painted = 0;
  try {
    return fn();
  } finally {
    const { events, transfer } = batch;
    batch = null;
    // ?marks: when the batch left, on the clock both threads share, so a call's marks and the page can time its way over.
    const posted = MARKS && events.length ? (lastPosted = performance.timeOrigin + performance.now()) : undefined;
    if (events.length > 1) postMessage(MARKS ? { batch: events, posted } : { batch: events }, transfer);
    else if (events.length) postMessage(MARKS ? { ...events[0], posted } : events[0], transfer);
  }
}

/** Ends session `s`: its document, layout and undo history go, and an open still being read fails. */
function close(s) {
  finishSave(s);
  const i = opening.findIndex((j) => j.s === s);
  if (i >= 0) postMessage({ id: opening.splice(i, 1)[0].id, error: 'The draft closed before it opened.' });
  sessions.delete(s.id);
  s.engine.free();
  return true;
}

// One engine clipboard (viewport-design.md section 8): the session that made the last engine copy, and the token written into
// that copy's HTML. A paste whose HTML carries the token takes the copy from that session itself (pasteFrom), so a copy in
// one draft pastes into another with nothing lost to HTML.
let lastCopy = null;
let copies = 0;
const TOKEN = /data-ew-clip="([^"]+)"/;

/** Notes `r` (an edit.copy or edit.cut result of session `s`) as the engine clipboard and marks its HTML with the token. The
 * copy's RTF joins its text and HTML, as Word puts all three on the clipboard. */
function noteCopy(s, r) {
  if (!r?.ok || typeof r.value?.html !== 'string') return r;
  r.value.rtf = s.engine.clipboardRtf();
  const token = `${Date.now().toString(36)}.${++copies}`;
  lastCopy = { session: s.id, token };
  const mark = `<span data-ew-clip="${token}"></span>`;
  const html = r.value.html;
  r.value.html = /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + mark) : mark + html;
  return r;
}

/** Pastes the engine copy `html` names into session `s` → the exec result, or null when the HTML carries no current token,
 * its session is gone, or it is `s` itself (whose own Paste picks its copy losslessly anyway): the caller pastes the HTML. */
function pasteFrom(s, html) {
  const token = TOKEN.exec(String(html ?? ''))?.[1];
  const from = token && lastCopy?.token === token ? sessions.get(lastCopy.session) : null;
  return from && from !== s ? json(s.engine.pasteFrom(from.engine)) : null;
}

// Calls on one session: each takes the session record first.
const calls = {
  // `beside`: other drafts are open here, so a session laid out whole lays the opened document out in slices (sliceAgain), as
  // new fonts do: in one piece the fixture's layout held their calls for 1.3 s (engine-print-bench). `sliced` tells the client
  // to wait for the layout to settle (SessionClient.open).
  open: (s, bytes, kind, beside = false) => {
    if (beside) sliceAgain(s);
    return { ...json(s.engine.open(bytes, kind)), sliced: !!s.sliced };
  },
  save: (s, kind) => s.engine.save(kind),
  // The document's revision number, read-only: execAs's ifRev, and a post's agent reads (C5).
  rev: (s) => s.engine.rev(),
  // → {bytes, outlined, why, ms}: the families drawn as outlines, whose text is not selectable, a line for each such face (which
  // face, and whether its licence or the subsetter put it there), and how long making it took (not the wait before it). `print: true` makes it a print job's PDF, in which
  // preview-and-print fonts embed (viewport-design.md section 8). It runs as a priority 5 job (`low` below).
  pdf: (s, options = {}) => {
    const t0 = performance.now();
    const r = s.engine.pdfNamed(str(options));
    try {
      return { bytes: r.bytes, outlined: json(r.outlined), why: json(r.why), ms: Math.round(performance.now() - t0) };
    } finally {
      r.free();
    }
  },
  pages: (s) => json(s.engine.pages()),
  surfaces: (s) => json(s.engine.surfaces()),
  sceneStats: (s) => json(s.engine.sceneStats()),
  close,
  hit: (s, page, x, y) => json(s.engine.hit(page, x, y)),
  caret: (s, pos) => json(s.engine.caret(str(pos))),
  rects: (s, anchor, head) => json(s.engine.rects(str(anchor), str(head))),
  move: (s, pos, unit, dir, goalX) => json(s.engine.move(str(pos), unit, dir, goalX ?? undefined)),
  select: (s, anchor, head) => s.engine.select(str(anchor), str(head)),
  selection: (s) => json(s.engine.selection()),
  selectionEvent: (s) => json(s.engine.selectionEvent(...(s.view ?? []))),
  exec: (s, id, args = {}) => {
    const r = json(s.engine.exec(id, str(args)));
    return id === 'edit.copy' || id === 'edit.cut' ? noteCopy(s, r) : r;
  },
  // Several commands as one undo step ([[id, args], ...]), and a pure command's value (a query never changes the document).
  execMany: (s, steps) => json(s.engine.execMany(str(steps ?? []))),
  // An assistant's edit: steps as one undo step, tracked as changes by `author` with suggestion group `tag`, refused when the
  // document changed since revision `ifRev` (docs/plans/engine/stage2b.md decision 4).
  execAs: (s, author, tag, steps, ifRev) => json(s.engine.execAs(author, tag ?? undefined, str(steps ?? []), ifRev ?? undefined)),
  // A session no view shows (an assistant's background session, stage2b.md decision 5) is quiet: nothing is laid out or sent
  // after its calls until quiet(false) or a view's tile wishes, when one layout event carries every change since. A call that
  // reads pages or positions still lays out what it reads.
  quiet: (s, on = true) => (s.quiet = !!on),
  query: (s, id, args = {}) => json(s.engine.query(id, str(args))),
  pasteFrom,
  // The last engine copy of session `sourceId` pasted into `s` at its selection → the exec result, or {ok: false} when there is no
  // such session or it is `s` (a drag between a page and a board item, src/board/transfer.js): one worker holds both.
  pasteSession: (s, sourceId) => { const from = sessions.get(sourceId); return from && from !== s ? json(s.engine.pasteFrom(from.engine)) : { ok: false, error: 'no source' }; },
  state: (s, ids) => json(s.engine.state(str(ids))),
  format: (s) => json(s.engine.format()),
  insertText: (s, text) => json(s.engine.insertText(text)),
  deleteBackward: (s, unit = 'character') => json(s.engine.deleteBackward(unit)),
  deleteForward: (s, unit = 'character') => json(s.engine.deleteForward(unit)),
  // The caret goes to the composition's end unless the input method places it.
  compose: (s, text, selStart = text.length, selEnd = selStart) => json(s.engine.compose(text, selStart, selEnd)),
  commit: (s) => s.engine.commit(),
  undo: (s) => json(s.engine.undo()),
  redo: (s) => json(s.engine.redo()),
  steps: (s) => json(s.engine.steps()),
  text: (s, anchor, head) => s.engine.text(str(anchor), str(head)),
  copy: (s, kind) => s.engine.copy(kind),
  paste: (s, kind, data) => json(s.engine.paste(kind, typeof data === 'string' ? new TextEncoder().encode(data) : data)),
  frames: (s, page) => json(s.engine.frames(page)),
  // The accessibility copy's and spelling's calls (src/engine/a11y/blocks.js).
  blocks: (s, page) => json(s.engine.blocks(page)),
  locate: (s, pos) => json(s.engine.locate(str(pos))),
  posAt: (s, id, offset) => json(s.engine.posAt(String(id), offset)),
  // Forced colours ({text, paper} or null): the session's tiles repaint in them (src/engine/a11y/index.js).
  colors: (s, c) => s.engine.setColors(c?.text ?? '', c?.paper ?? ''),
  missingFonts: (s) => json(s.engine.missingFonts()),
  // The fonts the helper worker loads before it lays this draft out for a PDF: {families, scripts}.
  fontsUsed: (s) => json(s.engine.fontsUsed()),
  stats: (s) => json(s.engine.stats()),
  layoutDigest: (s) => json(s.engine.layoutDigest()),
  // engine-open: lay out from the start only the view's pages, the rest in slices (null: whole), and whether all are laid out.
  ahead,
  settled: (s) => s.engine.settled(),
  // engine-undo-file: the undo history of the record the last save('engine', true) wrote, for the record stamped `stamp`, keeping
  // `limit` undo steps (undefined: none kept); and a saved history taken back after an open → {kept, steps}. The history comes as
  // its bytes, its JSON text or the file as loaded (an object), which is turned into text here, off the page's thread.
  saveHistory: (s, stamp, limit) => s.engine.saveHistory(String(stamp ?? ''), limit ?? 0) ?? null,
  openHistory: (s, history, stamp) => json(s.engine.openHistory(historyBytes(history), String(stamp ?? ''))),
  // A measure function of the ?build build: an Engine method on this session, else one of the module's.
  bench: (s, name, ...args) => json(typeof s.engine[name] === 'function' ? s.engine[name](...args) : glue[name](...args)),
  // Whiteboard sessions (docs/plans/board/design.md section 3): a board session's surfaces are item stamps, one for each handle.
  boardInit: (s) => s.engine.boardInit(),
  // list: [{handle, model, rot, flipX, flipY, opacity, text} | {handle, gone: true}], `model` the engine form as bytes and `text` the
  // width a text item lays out at (-1: not text) → [{handle, ok, ox, oy, w, h, textW, textH, error}]. Each stamp made marks its
  // surface changed at the new version and posts a layout event for that surface alone (noteChange would run its loop to the last
  // surface), all in one message; a stamp that failed keeps the old one and posts nothing.
  boardApply: (s, list) => {
    const out = [];
    batched(() => {
      for (const e of list) {
        let r = { ok: true };
        if (e.gone) s.engine.boardDrop(e.handle);
        else r = JSON.parse(s.engine.boardSet(e.handle, e.model, e.rot ?? 0, !!e.flipX, !!e.flipY, e.opacity ?? 1, e.text ?? -1, !!e.widthFit));
        out.push({ handle: e.handle, ...r });
        if (!r.ok) continue;
        s.changed[e.handle] = s.engine.version;
        post('layout', { version: s.engine.version, from: e.handle, to: e.handle + 1, count: Infinity }, s);
      }
    });
    schedule();
    return out;
  },
  boardHit: (s, handle, x, y, tol) => s.engine.boardHit(handle, x, y, tol),
  // The item session (the one a board's text is edited in): Web view `width` points wide, with tiles that have no paper.
  itemView: (s, width) => s.engine.itemView(width),
};

/** A saved undo history as the engine reads it: bytes, from its JSON text or from the file as loaded. */
function historyBytes(h) {
  if (h instanceof Uint8Array) return h;
  return new TextEncoder().encode(typeof h === 'string' ? h : JSON.stringify(h ?? null));
}

// Calls on the whole worker: no session is opened for them.
const shared = {
  // Fonts are the worker's: every session lays out again what a new font changes (at the next flush).
  addFont: (bytes) => {
    const added = glue.addFont(bytes);
    if (added) {
      for (const s of sessions.values()) {
        s.engine.fontsChanged();
        sliceAgain(s);
      }
    }
    return added;
  },
  // The provider's answer to a fonts.missing event is complete: like any call but addFont, it lays out what arrived.
  fontsDone: () => true,
  // The provider's fallback fonts per script ({code: [family]}): a session falls back to the first of them that is loaded.
  setScriptFonts: (lists) => glue.setScriptFonts(str(lists ?? {})),
  sessions: () => [...sessions.keys()],
  // The compiled .wasm, for the helper worker (a WebAssembly.Module crosses postMessage without being compiled again).
  module: () => module,
  want,
  forcePanic: () => glue.forcePanic(),
};

/** Marks the engine dead after a Rust panic, which traps: every session is left mid-change, so nothing more runs on any. */
function stopped(e) {
  if (dead || !(e instanceof WebAssembly.RuntimeError)) return;
  dead = `The engine stopped: ${e.message}`;
  post('crash', { message: dead });
}

// ---------- The tile queue (viewport-design.md sections 4.3 and 8) ----------
// The host's `want(list)` names the tiles its views show or show next, [{session, surface, scale, col, row, have}], in the order
// to paint them (the focused session's visible tiles first); `have` is the layout version of the tile a view holds, if any. A
// new list replaces the old one, so a wish that scrolled away is dropped. Calls go first: between them the worker paints the
// wishes whose tile is missing or older than its surface's last change, for at most TURN_MS a turn, and posts each session's
// as one 'tiles' event {list: [{surface, scale, col, row, version, bitmap}]}, the ImageBitmaps transferred and null where
// nothing is drawn (the slot's paper shows there). It keeps the list, so after an edit the wished tiles on the surfaces the
// layout event names repaint with no new want: in the edit's own turn, after its layout event, as many as fit TURN_MS (section
// 4.4), the rest in the next. Versions start again in a new worker: after 'reopened' a view paints its tiles again. A tile on
// screen (`visible`) is kept in the engine, so its repaint after an edit paints only the rows the edit changed and copies the
// rows whose lines only moved (engine-paint-damage, tiles.rs paintTile).

/** Paint time a turn before the queue lets the waiting calls in (section 4.4's 8 ms budget). */
const TURN_MS = 8;
let wishes = [];
/** ?marks: the pixels the engine painted for the tiles of the open turn (tileOf), the rest being kept or moved, and its time in
 * paintTile (the rest of a tile's time is the copy into its ImageBitmap). */
let paintedPx = 0;
let rasterMs = 0;
/** The one canvas every tile passes through into its ImageBitmap. Its context is a CPU one (willReadFrequently): a bitmap from
 * a GPU canvas belongs to this worker's GPU context and goes blank on the main thread when the worker ends, and the host keeps
 * showing its tiles while it starts a new worker (section 8). */
let scratch = null;
let pen = null;
const turns = new MessageChannel();
let queued = false;

// Priority 5 of section 8's queue: a PDF waits in `low` for a turn of its own, after the calls already waiting and the wished
// tiles, so a print never holds up an edit or a paint that came before it. A later call on the same draft (but its close) runs
// that draft's waiting PDF first, so the PDF holds the document as it was when Print was pressed, as Word prints it. Once it runs
// it holds the thread for seconds (the stall engine-print measured in docs/plans/word/bench.log), so the app's PDFs go to the
// helper worker (client.js `pdf`, helper.js), which takes this draft's engine form from save('engine'); this call stays for a
// page that runs the engine without a helper. Entries: {sid, run}.
const low = [];

/** Runs the PDFs session `sid` has waiting, in the order they came. */
function runPdfsOf(sid) {
  for (let i = 0; i < low.length;) {
    if (low[i].sid === sid) low.splice(i, 1)[0].run();
    else i++;
  }
}

/** Replaces the wish list → how many wishes it holds. */
function want(list = []) {
  wishes = list.map(({ session: id = 0, surface, scale, col, row, have = null, visible = true }) => ({ session: id, surface, scale, col, row, have, visible }));
  // Each session's wished pages: a layout ahead reaches the last, and a highlight's rectangles go out for them all. And the
  // pages on screen, the only ones a layout event works out damage for (engine-keys-final: tiles.rs setView).
  const view = new Map();
  const shown = new Map();
  const widen = (m, w) => {
    const v = m.get(w.session);
    m.set(w.session, v ? [Math.min(v[0], w.surface), Math.max(v[1], w.surface + 1)] : [w.surface, w.surface + 1]);
  };
  for (const w of wishes) {
    widen(view, w);
    if (w.visible) widen(shown, w);
  }
  for (const s of sessions.values()) {
    const v = shown.get(s.id) ?? [];
    if (String(v) === String(s.shown)) continue;
    s.shown = v;
    s.engine.setView(...v);
  }
  for (const [id, v] of view) {
    const s = sessions.get(id);
    if (!s) continue;
    // A view shows it now: what its quiet edits changed goes out.
    if (s.quiet) {
      s.quiet = false;
      due.add(s);
    }
    lookAhead(s, v[1] - 1);
    if (String(v) === String(s.view)) continue;
    s.view = v;
    if (s.wide) due.add(s);
  }
  schedule();
  return wishes.length;
}

/** Lays out the edits not yet laid out, paints wishes and runs autosave steps in a turn of their own, after the calls already
 * waiting. */
function schedule() {
  if (queued || dead || (!wishes.length && !due.size && !saving.length && !low.length && !opening.length && !sliceDue())) return;
  queued = true;
  turns.port2.postMessage(0);
}
turns.port1.onmessage = () => {
  queued = false;
  // ?marks: the turn's parts, timed, as a 'turn' mark (`at` on the clock both threads share), so a key that waited behind one
  // can name it.
  const tm = MARKS ? { method: 'turn', at: performance.timeOrigin + performance.now(), flush: 0, paint: 0, slice: 0, save: 0, low: 0 } : null;
  let t = tm && performance.now();
  const lap = (k) => {
    if (!tm) return;
    const n = performance.now();
    tm[k] += n - t;
    t = n;
  };
  batched(() => {
    // An edit's batch (its layout, its caret and its tiles on screen) goes by itself (section 4.4): the tiles off screen and a
    // slice of layout wait for the next turn, so a key's result is not held up by tiles nobody sees yet.
    if (flushDue()) {
      lap('flush');
      schedule();
      return;
    }
    paintWishes();
    lap('paint');
    // The rest of a layout once the wished tiles are painted: a slice, then the tiles it changed in the next turn. An open
    // being read takes the turn's slice first.
    if (!queued && !openStep()) {
      try {
        settleSlice();
      } catch (e) {
        stopped(e);
        if (!dead) console.error(e);
      }
    }
    lap('slice');
  });
  saveSteps();
  lap('save');
  // Tiles still to paint, autosave steps and the rest of a layout (section 8's priority 4) come first; paintWishes, saveSteps
  // and the line below have scheduled their turn.
  if (sliceDue() || opening.length) schedule();
  if (!queued && low.length) {
    low.shift().run();
    schedule();
  }
  lap('low');
  if (tm) postMessage({ event: 'marks', data: tm });
};

// engine-open-parse: an engine form opened beside other drafts (`open(bytes, 'engine', true)`, client.js open) is read in steps,
// a slice a turn as the layout's are (SLICE_MS, SLICE_INPUT_MS while edits come), so their calls wait for one step rather than the
// whole read: in one piece the Word fixture's 7.3 MB form held them about 90 ms. The turn after the read opens it and lays out
// its first pages (openEnd), then the reply and the layout event go. Any other call on that session finishes the open first,
// so it never sees the document the session had before; its close fails it.
/** The opens in progress, oldest first: {s, id, read}. */
const opening = [];
/** Whether session `s` is laid out, sliced, painted and sent: not quiet, and not being read. While an open is read, the session
 * still holds the document it had before, and a call on every session (fontsDone, a font burst's timer, new hyphenation data)
 * would send that document's layout first and, settled, end the slices the open set up (sliceAgain): finishOpen sends it. */
const live = (s) => !s.quiet && !s.opening;

/** The oldest open in progress takes this turn: a step of its read, or once read, its open → whether there was one. */
function openStep() {
  const job = opening[0];
  if (!job) return false;
  if (job.read) {
    finishOpen(job.s);
    return true;
  }
  try {
    job.read = job.s.engine.openStep(performance.now() - called < INPUT_MS ? SLICE_INPUT_MS : SLICE_MS);
  } catch (e) {
    opening.shift();
    job.s.opening = false;
    stopped(e);
    postMessage({ id: job.id, error: e?.message ?? String(e) });
  }
  return true;
}

/** Completes session `s`'s open in progress, if any: the rest of its read, the open, its reply and its layout event. */
function finishOpen(s) {
  const i = opening.findIndex((j) => j.s === s);
  if (i < 0) return;
  const [job] = opening.splice(i, 1);
  s.opening = false;
  let result;
  try {
    while (!s.engine.openStep(Infinity));
    result = { ...json(s.engine.openEnd()), sliced: !!s.sliced };
  } catch (e) {
    stopped(e);
    return postMessage({ id: job.id, error: e?.message ?? String(e) });
  }
  postMessage({ id: job.id, result });
  flush(s);
}

// Autosaves in steps (section 8: an autosave never holds up input). A save('engine') serialises all but the body at once, then
// adds body blocks a step at a time, for at most SAVE_MS a turn, so a key that comes meanwhile waits for one step rather than
// the whole save (the wrapper crate's save.rs; the fixture's whole save took about 6 ms in the worker, engine-keystroke). Its
// reply goes after the last step, behind the replies of calls that came during it.
const SAVE_MS = 2;
const STEP_BYTES = 256 * 1024;
/** The saves in progress, oldest first: {s, id}. */
const saving = [];

function saveSteps() {
  const t0 = performance.now();
  while (saving.length && performance.now() - t0 < SAVE_MS) {
    const job = saving[0];
    try {
      if (!job.s.engine.saveStep(STEP_BYTES)) continue;
    } catch (e) {
      saving.shift();
      stopped(e);
      postMessage({ id: job.id, error: e?.message ?? String(e) });
      continue;
    }
    finishSave(job.s);
  }
  if (saving.length) schedule();
}

/** Completes session `s`'s save in progress, if any, and replies to it. */
function finishSave(s) {
  const i = saving.findIndex((j) => j.s === s);
  if (i < 0) return;
  const [job] = saving.splice(i, 1);
  try {
    const bytes = s.engine.saveEnd();
    postMessage({ id: job.id, result: bytes }, [bytes.buffer]);
  } catch (e) {
    stopped(e);
    postMessage({ id: job.id, error: e?.message ?? String(e) });
  }
}

/** Notes layout event `e` of session `s`: its surfaces from..to, and any past a shorter end, changed at `e.version`. A wish the
 * event's damage spared holds what the new layout draws, so it takes the new version unpainted, as the view's tile does. */
function noteChange(s, e) {
  for (let i = e.from; i < Math.max(e.to, s.changed.length); i++) if (i < e.to || i >= e.count) s.changed[i] = e.version;
  for (const w of wishes) {
    if (w.session === s.id && w.surface >= e.from && w.surface < e.to && untouched(w, w.have, e)) w.have = e.version;
  }
}

/** One turn of the tile queue: session `only`'s wishes (every session's when null), timed into `marks`; with `shown`, only
 * the wishes on screen, the rest left for a later turn. The turn's paints together stop at TURN_MS (`painted`, reset with
 * each batch). */
function paintWishes(only = null, marks = null, shown = false) {
  if (dead) return;
  const t0 = performance.now();
  const spent = painted;
  const out = new Map();
  paintedPx = 0;
  rasterMs = 0;
  let more = false;
  let hidden = 0;
  try {
    for (const w of wishes) {
      if (only && w.session !== only.id) continue;
      const s = sessions.get(w.session);
      if (!s || s.opening || (w.have != null && w.have >= (s.changed[w.surface] ?? 0))) continue;
      if (shown && !w.visible) {
        more = true;
        continue;
      }
      if (spent + performance.now() - t0 >= TURN_MS) {
        more = true;
        break;
      }
      const tile = tileOf(s, w);
      if (!w.visible) hidden++;
      w.have = tile.version;
      if (!out.has(s)) out.set(s, []);
      out.get(s).push(tile);
    }
  } catch (e) {
    stopped(e);
    if (!dead) console.error(e);
  }
  painted = spent + performance.now() - t0;
  if (marks) {
    marks.paint = performance.now() - t0;
    marks.repainted = [...new Set([...out.values()].flat().map((t) => t.surface))];
    marks.tiles = [...out.values()].flat().length;
    marks.pixels = paintedPx;
    marks.raster = rasterMs;
    marks.hidden = hidden;
    marks.more = more;
  }
  batched(() => {
    for (const [s, list] of out) post('tiles', { list }, s, list.flatMap((t) => (t.bitmap ? [t.bitmap] : [])));
  });
  if (more) schedule();
}

/** Wish `w`'s tile of session `s` as the 'tiles' event carries it. The pixels stay in wasm memory until the scratch canvas copies
 * them, their one copy on the way into the ImageBitmap. */
function tileOf(s, { surface, scale, col, row, visible }) {
  const t0 = MARKS && performance.now();
  const v = s.engine.paintTile(surface, scale, col, row, visible);
  if (MARKS) rasterMs += performance.now() - t0;
  const tile = { surface, scale, col, row, version: s.engine.version, bitmap: null };
  if (!v) return tile;
  try {
    const { width, height } = v;
    paintedPx += v.painted;
    scratch ??= new OffscreenCanvas(width, height);
    pen ??= scratch.getContext('2d', { willReadFrequently: true });
    if (scratch.width !== width) scratch.width = width;
    if (scratch.height !== height) scratch.height = height;
    pen.putImageData(new ImageData(new Uint8ClampedArray(memory.buffer, v.ptr, width * height * 4), width, height), 0, 0);
    tile.bitmap = scratch.transferToImageBitmap();
  } finally {
    v.free();
  }
  return tile;
}

let flushTimer = 0;

// Edits are laid out in a turn after their reply (section 8's queue): keys that queued while the worker was busy are applied
// first and laid out once. Any other call lays out what is due before it runs, so its reply still follows the events of the
// edits sent before it (input's idle() relies on that).
const EDITS = new Set(['insertText', 'deleteBackward', 'deleteForward', 'compose', 'commit', 'exec', 'execMany', 'execAs', 'undo', 'redo', 'select', 'paste',
  'pasteFrom', 'pasteSession']);
/** Sessions with an edit not laid out yet. */
const due = new Set();

/** Lays out every session with an edit due → whether there was one. */
function flushDue() {
  const list = [...due];
  due.clear();
  for (const s of list) if (sessions.has(s.id)) flush(s);
  return list.length > 0;
}

/** Sends what changed in session `s` since the last call: the layout event, the selection event, then the wished tiles the
 * layout changed (section 4.4's order). The relayout runs here, after the reply, so a panic in it has no call left to fail:
 * it ends as a 'crash' event. */
function flushSession(s, marks) {
  const t1 = marks && performance.now();
  const change = s.engine.takeLayout();
  if (marks) marks.layout = performance.now() - t1;
  const event = change && JSON.parse(change);
  if (event) {
    post('layout', event, s);
    noteChange(s, event);
    s.posted = performance.now();
    s.unsettled = event.settled === false;
    if (s.sliced && !s.unsettled) {
      s.sliced = false;
      s.engine.setAhead(s.ahead ?? undefined);
    }
  }
  // The caret and highlight move with the selection and with the layout under it, and a highlight with the pages its views
  // show (engine-open: the event holds the rectangles on those pages only).
  const t2 = marks && performance.now();
  const range = s.engine.selection();
  const { anchor, head, ranges } = JSON.parse(range);
  // Reading Highlight's search: a new one, or turning it off, sends a selection event (its `found`).
  const find = s.engine.findMark();
  // Several ranges draw even when the active one is a caret, and Reading Highlight's matches with none (their rectangles too
  // are the view's pages only).
  s.wide = ranges > 1 || !!find || JSON.stringify(anchor) !== JSON.stringify(head);
  const sel = `${s.engine.version} ${range} ${find} ${s.wide ? s.view : ''}`;
  if (sel !== s.sel) {
    s.sel = sel;
    post('selection', json(s.engine.selectionEvent(...(s.view ?? []))), s);
  }
  if (marks) marks.select = performance.now() - t2;
  if (!event) return;
  // The views' tiles of the changed surfaces on screen follow in the same turn, without a round trip for each; the ones off
  // screen in the next.
  paintWishes(s, marks, true);
  schedule();
}

/** Flushes session `only` (every session when null), then reports the fonts the worker lacks. */
function flush(only = null, marks = null) {
  if (!only) {
    clearTimeout(flushTimer);
    flushTimer = 0;
  }
  if (dead) return;
  try {
    if (!only) due.clear();
    // The fonts the layout lacks go in the same message as its layout event, so a reader that hears the layout settle already
    // has the fonts on their way (client.js whenSettled): sent after it, they reached the provider after that reader went on.
    batched(() => {
      for (const s of only ? [only] : sessions.values()) if (live(s)) flushSession(s, marks);
      report();
    });
  } catch (e) {
    stopped(e);
    if (!dead) console.error(e);
  }
  // The slices a font burst held back (sliceDue) go on from the layout just made.
  if (!only) schedule();
}

/** Reports the fonts the worker lacks and fetches the data files layout asked for, as layout met them. */
function report() {
  const missing = sessions.values().next().value?.engine.takeMissingFonts();
  if (missing) post('fonts.missing', JSON.parse(missing));
  const wanted = glue.takeWantedData();
  if (!wanted) return;
  // In the message with the layout that asked for it, so a reader that hears that layout settle waits for the data too
  // (client.js whenSettled): the layout the data makes moves what that reader would read.
  post('data', { pending: ++fetching });
  fetchData(JSON.parse(wanted));
}

/** Data fetches on their way (fetchData). */
let fetching = 0;

/** Hands the worker the data files layout asked for (hyphenation, which the .wasm leaves out: wasm/data/ beside it). The data
 * is the whole worker's, so every session lays out again with it, and the layouts it changes are sent. A file that does not
 * arrive leaves hyphenation to the engine's heuristic. */
async function fetchData(names) {
  let added = false;
  for (const name of names) {
    try {
      const res = await fetch(new URL(`wasm/data/${name}`, import.meta.url));
      if (!res.ok) throw new Error(`${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (dead) return;
      added = glue.addData(name, bytes) || added;
    } catch (e) {
      stopped(e);
      if (!dead) console.error(`engine data ${name}: ${e?.message ?? e}`);
    }
  }
  if (dead) return;
  // The layout the data makes and the event that ends the wait for it go in one message.
  batched(() => {
    if (added) {
      try {
        for (const s of sessions.values()) {
          s.engine.dataChanged();
          sliceAgain(s);
        }
      } catch (e) {
        stopped(e);
      }
      flush();
    }
    post('data', { pending: --fetching });
  });
}

self.onmessage = async ({ data }) => {
  try {
    await ready;
  } catch (e) {
    dead ??= `The engine could not start: ${e?.message ?? e}`;
  }
  const sid = data.session ?? 0;
  if (data.method !== 'pdf' || dead) {
    if (calls[data.method] && data.method !== 'close') runPdfsOf(sid);
    return answer(data);
  }
  // A draft closed while its PDF waited is not opened again blank by it.
  const had = sessions.has(sid);
  low.push({ sid, run: () => (had && !sessions.has(sid) ? postMessage({ id: data.id, error: 'The draft closed before its PDF was made.' }) : answer(data)) });
  schedule();
};

/** Runs call `method` of message `id` and replies, then sends what it changed. */
function answer({ id, method, args = [], session: sid = 0, sent }) {
  if (dead) return postMessage({ id, error: dead });
  if (EDITS.has(method)) called = performance.now();
  const call = calls[method] ?? shared[method];
  if (!call) return postMessage({ id, error: `Unknown engine call ${method}.` });
  if (method === 'bench' && !BUILD) return postMessage({ id, error: 'bench needs a measure build (worker.js?build=).' });
  // A closed session is not opened again by its close.
  if (method === 'close' && !sessions.has(sid)) return postMessage({ id, result: false });
  if (due.size && !EDITS.has(method)) flushDue();
  const s = calls[method] ? session(sid) : null;
  if (s && method !== 'close') finishOpen(s);
  if (method === 'open' && args[1] === 'engine' && args[2] === true) {
    try {
      sliceAgain(s);
      s.engine.openBegin(args[0]);
    } catch (e) {
      stopped(e);
      return postMessage({ id, error: e?.message ?? String(e) });
    }
    s.opening = true;
    opening.push({ s, id, read: false });
    return schedule();
  }
  // An engine-form save runs in steps (saveSteps above). `save('engine', true)` is the draft's record: the undo history is noted
  // as the save finds it, for the saveHistory that follows.
  if (method === 'save' && args[0] === 'engine') {
    try {
      finishSave(s);
      s.engine.saveBegin(args[1] === true);
    } catch (e) {
      stopped(e);
      return postMessage({ id, error: e?.message ?? String(e) });
    }
    saving.push({ s, id });
    return schedule();
  }
  let result, sel;
  const t0 = MARKS && performance.now();
  // ?marks, engine-layout-key: the paragraph layouts looked up and the pages laid out before the call's batch went.
  const work = MARKS && s ? [s.engine.paragraphLayouts(), s.engine.pagesLaidOut()] : null;
  try {
    sel = s?.engine.selection();
    result = s ? call(s, ...args) : call(...args);
    // Typing and editing change the document or move the selection; a read made through exec does neither.
    if (s && EDITS.has(method) && (result?.changed || s.engine.selection() !== sel)) s.typed = performance.now();
  } catch (e) {
    stopped(e);
    return postMessage({ id, error: e?.message ?? String(e) });
  }
  // `sent`: when the reply left, on the clock both threads share (timeOrigin + now), so the page can time the transfer.
  const marks = MARKS ? { method, call: performance.now() - t0, layout: 0, paint: 0, repainted: [], at: performance.timeOrigin + t0 } : null;
  // engine-repaginate-2: the layout this call waited behind, the slice that ran after the page sent it (`sent`, on the same
  // clock): its milliseconds after the call was sent, and the paragraph layouts that slice looked up in all.
  if (marks && lastSlice && sent != null && lastSlice.end > sent) {
    marks.behind = lastSlice.end - Math.max(lastSlice.start, sent);
    marks.behindParas = lastSlice.paras;
  }
  if (marks) {
    marks.sent = performance.timeOrigin + performance.now();
    // When the page sent the call: from there to `at` it travelled and waited for the worker.
    marks.called = sent;
  }
  const bytes = result instanceof Uint8Array ? result : result?.bytes;
  postMessage({ id, result }, bytes instanceof Uint8Array ? [bytes.buffer] : []);
  // `ahead` changes no layout; on a new session it comes before the open, so the blank document's layout is not sent first.
  if (method === 'close' || method === 'forcePanic' || method === 'ahead' || s?.quiet) return;
  try {
    // The selection event follows in the flush below. The tools' state can change with neither the selection nor the layout
    // (Ctrl+B at a caret sets its typing format).
    if (s && (method === 'exec' || method === 'execMany' || method === 'execAs') && s.engine.selection() === sel) {
      post('command', { id: method === 'exec' ? args[0] : method === 'execAs' ? args[2]?.[0]?.[0] : args[0]?.[0]?.[0] }, s);
    }
  } catch (e) {
    stopped(e);
    if (!dead) console.error(e);
  }
  // A document's fonts arrive as a burst of files: one layout when the provider says fontsDone rather than one for each file
  // or family (reading a family from disk takes longer than a short timer). The timer only covers a provider that never says
  // it. Any other call in between lays out its own session at once; fontsDone and the timer lay out every session, and other
  // calls on the whole worker (a view's tile wishes) leave the burst to them: a draft that is not called is not laid out
  // again for each call (engine-helper: each selection call of a visible draft waited about 1.6 s for the fixture's layout
  // while the fixture's fonts came).
  // An edit is laid out in the next turn (EDITS above); measuring (?marks) lays it out at once, inside the call's marks.
  if (method === 'addFont') {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(), 1000);
  } else if (s && !MARKS && EDITS.has(method)) {
    due.add(s);
    schedule();
  } else if (s) {
    lastPosted = null;
    flush(s, marks);
    if (marks) marks.posted = lastPosted;
    if (marks && work && !dead) [marks.paras, marks.pages] = [s.engine.paragraphLayouts() - work[0], s.engine.pagesLaidOut() - work[1]];
  } else if (!flushTimer || method === 'fontsDone') {
    flush(null, marks);
  }
  // engine-paint-damage: the pixels the engine keeps of the tiles on screen, for the whole worker.
  if (marks && s && !dead) marks.kept = json(s.engine.sceneStats()).keptBytes;
  if (marks) postMessage({ event: 'marks', data: marks });
}

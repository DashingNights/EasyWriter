// The main thread's side of the document engine (docs/plans/engine/plan.md section 3, viewport-design.md sections 5.1 and 8): an
// EngineHost starts worker.js, one per window, which holds every open draft as a session; a SessionClient is one view's handle on
// one draft and turns the engine API into promises. Positions are the engine's own JSON values: pass them back as they came.
// Plain web APIs only.
//   const host = engineHost();
//   const draft = host.session(draftId);
//   draft.ahead();   // optional: an open lays out the first pages, the rest in slices (`settled` false until then)
//   await draft.open(bytes, 'docx');
//   draft.on('layout', ({ version, from, to, pages, steps }) => ...);
//   await draft.print({ range: 'all', copies: 2 }, { deviceName });
//   draft.release();
//   const pane = host.watch(draftId);   // any other reader: hears the session while a view holds it, never keeps it open
// `new EngineClient()` still works: a session on a host of its own, as stage 1 and the tests use it.
// Reading a .docx for an open and making a PDF run in a helper worker (helper.js, viewport-design.md section 8), so the drafts
// in the engine worker keep painting meanwhile: open() and pdf() below send them there.

import { startFonts } from './fonts/index.mjs';

/** The calls that pass their arguments through as they are. Pages show as tiles (host.call('want'), the 'tiles' event); open,
 * pdf and print are SessionClient's own. */
const CALLS = ['save', 'rev', 'pages', 'hit', 'caret', 'rects', 'move', 'select', 'selection', 'exec', 'execMany', 'execAs', 'query',
  'state', 'format', 'insertText', 'deleteBackward', 'deleteForward', 'compose', 'commit', 'undo', 'redo', 'text', 'copy',
  'paste', 'pasteFrom', 'frames', 'addFont', 'blocks', 'locate', 'posAt', 'missingFonts', 'steps', 'stats', 'layoutDigest', 'ahead',
  'settled', 'saveHistory', 'openHistory', 'quiet'];

/** How long a view handing its session over waits for the next view before it leaves anyway (SessionClient.handOff). */
const HAND_OFF = 15000;

/** A crash this soon after the last restart ends the engine for good: a draft that crashes it on open must not loop. */
const RESTART_GAP = 10000;

/** How long the helper worker stays without a job before it closes, its fonts and memory with it (EngineHost.helperIdle). */
const HELPER_IDLE = 30000;

/** EngineHost.dataReady while no data file is on its way. */
const NO_DATA = Promise.resolve();

/** One engine worker for a window and the drafts open in it. The font provider (`fonts`) is the host's, so a font loads once
 * for every draft. Events: each SessionClient hears its own session's and the worker's; `on` here hears every one, with the
 * session as the second argument. After a crash (a Rust panic ends every session) the host starts a new worker and opens each
 * session again from its last autosave (`saved`) or, before one, from what it opened, with the undo history saved for that
 * record (engine-undo-file), then emits 'reopened' {session, history, steps}: `history` whether the history came back, `steps`
 * the top step ids then. */
export class EngineHost {
  #url;
  #fonts;
  #worker = null;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();
  /** id → {last: {bytes, kind, stamp} | null, history: {stamp, history} | null, ahead: the args of its last `ahead` call or null,
   * quiet: whether it was last made quiet, views: Set of SessionClient}. */
  #sessions = new Map();
  /** id → Set of SessionClient made by `watch`: they hear the session's events whenever it is open, and do not keep it open. */
  #watchers = new Map();
  #restartedAt = -Infinity;
  /** The worker's data fetches on their way ('data' events) as Promise.withResolvers, or null while none is. */
  #data = null;
  /** The provider answering the worker's fonts.missing events, or null. */
  fonts = null;
  /** Bytes of font files sent to the worker so far. */
  fontBytes = 0;
  /** Why the engine stopped, while it is stopped. */
  dead = null;
  /** Milliseconds the helper worker waits without a job before it closes. */
  helperIdle = HELPER_IDLE;
  /** How long a helper warmEngine started waits for its first job before it closes. */
  warmIdle = WARM_IDLE;
  #helper = null;

  /** `url`: the worker script, src/engine/worker.js beside the page by default (helper.js beside it is the helper worker).
   * `fonts`: false leaves fonts.missing events unanswered (the engine draws with its bundled faces), the helper's too. */
  constructor(url = new URL('src/engine/worker.js', document.baseURI), { fonts = true } = {}) {
    this.#url = url;
    this.#fonts = fonts;
    this.#start();
  }

  #start() {
    this.dead = null;
    const w = (this.#worker = new Worker(this.#url, { type: 'module' }));
    w.onmessage = ({ data }) => {
      // One worker turn's events (viewport-design.md section 4.4), applied together in this task so they land in one frame.
      if (data.batch) {
        for (const e of data.batch) {
          this.#event(e);
          if (e.event === 'crash') break;
        }
        return;
      }
      if (data.event) return this.#event(data);
      const p = this.#pending.get(data.id);
      if (!p) return;
      this.#pending.delete(data.id);
      if ('error' in data) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    // A worker script that cannot load fails here, before any reply.
    w.onerror = (e) => {
      e.preventDefault();
      this.#crash(e.message || 'The engine worker could not start.');
    };
    this.fonts = this.#fonts ? startFonts(this) : null;
  }

  /** Calls `method` in the worker for session `session` (or the whole worker when undefined) → its result. `transfer`: objects
   * to move rather than copy. */
  call(method, args = [], transfer = [], session) {
    if (method === 'addFont') this.fontBytes += args[0]?.byteLength ?? 0;
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      this.#pending.set(id, { resolve, reject });
      // `sent`: when the call left, on the clock both threads share, so the worker's marks can say what it waited behind.
      const sent = performance.timeOrigin + performance.now();
      this.#worker.postMessage(session === undefined ? { id, method, args, sent } : { id, method, args, session, sent }, transfer);
    });
  }

  /** A client for draft `id`'s session (opened in the worker on its first call), counted as one view until its release(): the
   * session stays open while it holds it. Only the page area and an assistant's background session hold one
   * (test/word-engine-session-release.test.mjs); every other reader takes a watcher (`watch`). */
  session(id) {
    return new SessionClient(this, id, true);
  }

  /** A watcher of draft `id`'s session: it hears the session's events whenever a view holds it open and never keeps it open
   * itself; its calls fail while no view holds it, so it never opens a blank session for the id. How a pane, an overlay, a card
   * or a command reads a draft (engine-session-release), so a draft switch leaves one session. Release it when done. */
  watch(id) {
    return new SessionClient(this, id, false);
  }

  /** The open sessions' ids. */
  ids() {
    return [...this.#sessions.keys()];
  }

  /** The helper worker, started now if it is not running (it closes itself after `helperIdle` without a job). */
  helper() {
    if (!this.#helper) {
      const ended = () => this.#helper === h && (this.#helper = null);
      const h = (this.#helper = new Helper(this, new URL('helper.js', this.#url), this.#fonts, ended));
    }
    return this.#helper;
  }

  /** engine-canvas-read: engine form `model` (a Uint8Array, moved there, not copied) as `kind`, after engine commands `steps`
   * ([[id, args]]) when given, made in the helper worker (helper.js convert) → its bytes. Helper jobs run one at a time: it
   * waits behind a PDF export. */
  convert(model, kind, steps = null) {
    return this.helper().call('convert', [model, kind, steps], [model.buffer]);
  }

  /** Whether the helper worker is running. */
  get helperRunning() {
    return !!this.#helper;
  }

  /** Listens to every event ('layout', 'selection', 'fonts.missing', 'crash', 'reopened'): fn(data, session) → a function
   * that stops listening. */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }

  /** Resolves once the data files layout asked for (hyphenation, the word list) are in and laid out: the same promise until
   * then, a settled one while none is on its way. Rejects when the engine stops first. */
  dataReady() {
    return this.#data?.promise ?? NO_DATA;
  }

  /** Ends the worker and every session in it. */
  terminate() {
    this.fonts?.stop();
    this.#helper?.close();
    this.#worker.terminate();
    this.dead = 'The engine was closed.';
    this.#reject(this.dead);
  }

  // The SessionClient's side: views join and leave; the last to leave closes the session. Watchers (`watch`) come and go beside
  // them.
  join(view) {
    if (!view.hold) {
      if (!this.#watchers.has(view.id)) this.#watchers.set(view.id, new Set());
      this.#watchers.get(view.id).add(view);
      return;
    }
    if (!this.#sessions.has(view.id)) this.#sessions.set(view.id, { last: null, history: null, ahead: null, quiet: false, views: new Set() });
    const views = this.#sessions.get(view.id).views;
    views.add(view);
    // A view handing the session over (SessionClient.handOff) leaves now that another holds it.
    for (const v of [...views]) if (v !== view && v.handing) v.release();
  }

  /** How many views hold session `id`. */
  holders(id) {
    return this.#sessions.get(id)?.views.size ?? 0;
  }

  /** How many watchers of session `id` are not released yet. */
  watching(id) {
    return this.#watchers.get(id)?.size ?? 0;
  }

  leave(view) {
    if (!view.hold) {
      const set = this.#watchers.get(view.id);
      set?.delete(view);
      if (set?.size === 0) this.#watchers.delete(view.id);
      return;
    }
    const s = this.#sessions.get(view.id);
    if (!s?.views.delete(view) || s.views.size) return;
    this.#sessions.delete(view.id);
    // Its watchers hear no more of it (SessionClient's 'closed').
    for (const w of [...(this.#watchers.get(view.id) ?? [])]) w.emit('closed');
    // ponytail: closes at once; the board's rule (close after 5 minutes unshown, saved and without undo steps, and the memory
    // ceiling) waits for a view that keeps drafts open without showing them.
    this.call('close', [], [], view.id).catch(() => {});
  }

  /** Notes `bytes` of `kind` as what session `id` reopens from after a crash: the record stamped `stamp` (form.mjs adopt) when it
   * is the draft's engine form. */
  remember(id, bytes, kind, stamp = null) {
    const s = this.#sessions.get(id);
    if (s) s.last = { bytes, kind, stamp };
  }

  /** Notes `history` (the engine's saveHistory bytes, or the history file as loaded) as session `id`'s undo history for the record
   * stamped `stamp`: a crash's reopen takes it back when it reopens that record. */
  rememberHistory(id, stamp, history) {
    const s = this.#sessions.get(id);
    if (s) s.history = history == null ? null : { stamp, history };
  }

  /** Notes `args` of session `id`'s `ahead` call, which a crash's reopen sends again before the open (engine-open). */
  rememberAhead(id, args) {
    const s = this.#sessions.get(id);
    if (s) s.ahead = args;
  }

  /** Notes whether session `id` is quiet, which a crash's reopen makes it again before the open. */
  rememberQuiet(id, on) {
    const s = this.#sessions.get(id);
    if (s) s.quiet = on;
  }

  #emit(event, data, session) {
    for (const fn of this.#listeners.get(event) ?? []) fn(data, session);
  }

  /** A worker event: a session's goes to that session's views and watchers, the worker's to every view. */
  #event({ event, data, session }) {
    if (event === 'crash') return this.#crash(data.message);
    if (event === 'data') this.#fetching(data.pending);
    const views = session === undefined ? [...this.#sessions.values()].flatMap((s) => [...s.views]) : this.#viewsOf(session);
    for (const v of views) v.emit(event, data);
    this.#emit(event, data, session);
  }

  /** Session `id`'s views and watchers, a copy: a view that hears an event may open or release another. */
  #viewsOf(id) {
    return [...(this.#sessions.get(id)?.views ?? []), ...(this.#watchers.get(id) ?? [])];
  }

  #reject(message) {
    for (const p of this.#pending.values()) p.reject(new Error(message));
    this.#pending.clear();
    this.#data?.reject(new Error(message));
    this.#data = null;
  }

  /** A 'data' event: `pending` fetches are on their way. Its layout came in the same message, before it. */
  #fetching(pending) {
    if (pending && !this.#data) {
      this.#data = Promise.withResolvers();
      this.#data.promise.catch(() => {}); // a reader that never waited must not see the stop as unhandled
    } else if (!pending && this.#data) {
      this.#data.resolve();
      this.#data = null;
    }
  }

  /** The engine stopped: every view hears 'crash' {message, restarting}; unless it crashed again just after a restart, a new
   * worker opens each session again. Undo history, canvases and the selection do not survive. */
  #crash(message) {
    if (this.dead) return;
    this.dead = message;
    this.#reject(message);
    const now = performance.now();
    const restarting = now - this.#restartedAt > RESTART_GAP;
    const data = { message, restarting };
    for (const v of [...this.#sessions.values()].flatMap((s) => [...s.views])) v.emit('crash', data);
    this.#emit('crash', data);
    if (!restarting) return;
    this.#restartedAt = now;
    this.fonts?.stop();
    this.#worker.terminate();
    this.#start();
    for (const [id, s] of this.#sessions) {
      if (!s.last) continue;
      const { last, history } = s;
      // A session that laid out ahead does so again, so its first pages show before the rest are laid out.
      if (s.ahead) this.call('ahead', s.ahead, [], id).catch(() => {});
      if (s.quiet) this.call('quiet', [true], [], id).catch(() => {});
      this.call('open', [last.bytes, last.kind], [], id).then(async () => {
        // The undo history saved with that record comes back too; one saved with another is not tried.
        const kept = last.stamp && history?.stamp === last.stamp
          ? await this.call('openHistory', [history.history, last.stamp], [], id).catch(() => null) : null;
        const data = { session: id, history: !!kept?.kept, steps: kept?.steps ?? null };
        // A copy: a view that hears it may open a new view of the draft (session.js), which must not hear it too.
        for (const v of this.#viewsOf(id)) v.emit('reopened', data);
        this.#emit('reopened', data, id);
      }, () => {});
    }
  }
}

/** The helper worker (helper.js): reads .docx files for opens and makes PDFs away from the engine worker. It instantiates the
 * engine worker's compiled module, and its own font provider loads a PDF's fonts from the app's sources. `ended` runs when it
 * ends: after the host's helperIdle without a job, at terminate(), or when its engine stopped; the next job starts a new one. */
class Helper {
  #host;
  #fontsOn;
  #worker;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();
  #jobs = 0;
  #timer = 0;
  #ended;
  #dead = null;
  /** Its font provider, started with its first PDF (null with the host's fonts off). */
  fonts = null;

  constructor(host, url, fonts, ended) {
    this.#host = host;
    this.#fontsOn = fonts;
    this.#ended = ended;
    const w = (this.#worker = new Worker(url, { type: 'module' }));
    // The module goes first, so no call reaches the helper before its engine. Without one it compiles the .wasm itself.
    this.ready = host.call('module').catch(() => null).then((module) => w.postMessage({ module }));
    w.onmessage = ({ data }) => {
      if (data.event) return this.#emit(data.event, data.data);
      const p = this.#pending.get(data.id);
      if (!p) return;
      this.#pending.delete(data.id);
      if ('error' in data) p.reject(new Error(data.error));
      else p.resolve(data.result);
      if (data.dead) this.close(data.error);
    };
    w.onerror = (e) => {
      e.preventDefault();
      this.close(e.message || 'The helper worker could not start.');
    };
  }

  /** Calls `method` in the helper → its result. `transfer`: objects to move rather than copy. `job` false: a call that does
   * not count as work, so the helper's idle timer neither stops nor starts for it (warmEngine's). */
  call(method, args = [], transfer = [], job = true) {
    if (this.#dead) return Promise.reject(new Error(this.#dead));
    if (job) {
      clearTimeout(this.#timer);
      this.#jobs++;
    }
    const p = this.ready.then(() => new Promise((resolve, reject) => {
      const id = this.#next++;
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, method, args }, transfer);
    }));
    const idle = () => {
      if (--this.#jobs === 0 && !this.#dead) this.#timer = setTimeout(() => this.close(), this.#host.helperIdle);
    };
    if (job) p.then(idle, idle);
    return p;
  }

  /** The PDF of engine form `model` (moved here, not copied) with `options` → as SessionClient.pdf answers. `used`: the draft's
   * fonts ({families, scripts}, the engine worker's fontsUsed), loaded first so it lays out in the fonts it shows in. */
  async pdf(model, options, used) {
    if (this.#fontsOn) {
      this.fonts ??= startFonts(this);
      await this.fonts.request(used?.families ?? [], used?.scripts ?? []);
      await this.fonts.ready();
    }
    return this.call('pdf', [model, options, !!this.fonts], [model.buffer]);
  }

  /** Closes it after `ms` unless a job is running or comes first (warmEngine's helper, which no job has used yet). */
  idleFor(ms) {
    if (this.#jobs || this.#dead) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.close(), ms);
  }

  /** Listens to its 'fonts.missing' events (the font provider) → a function that stops listening. */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }

  #emit(event, data) {
    for (const fn of this.#listeners.get(event) ?? []) fn(data);
  }

  /** Ends the helper, its fonts and memory with it; calls in flight fail with `why`. */
  close(why = 'The helper worker closed.') {
    if (this.#dead) return;
    this.#dead = why;
    clearTimeout(this.#timer);
    this.fonts?.stop();
    this.#worker.terminate();
    for (const p of this.#pending.values()) p.reject(new Error(why));
    this.#pending.clear();
    this.#ended();
  }
}

/** One view's handle on one draft's session in `host`: the engine calls, sent to that session. `hold` false: a watcher, which
 * does not keep the session open (EngineHost.watch). */
export class SessionClient {
  #listeners = new Map();
  #released = false;
  /** The timer of a hand-over under way (handOff), or 0. */
  handing = 0;

  constructor(host, id, hold = true) {
    this.host = host;
    this.id = id;
    this.hold = hold;
    host.join(this);
  }

  /** The host's font provider. */
  get fonts() {
    return this.host.fonts;
  }

  /** Calls `method` in this session → its result. `transfer`: objects to move rather than copy. An open is what a crash
   * reopens from until the first autosave, and so is an `ahead` call. */
  call(method, args = [], transfer = []) {
    // A watcher, or a view released already, holds nothing: its call must not open a blank session for a draft no view shows.
    if ((!this.hold || this.#released) && !this.host.ids().includes(this.id)) return Promise.reject(new Error('The draft is not open in the engine.'));
    const p = this.host.call(method, args, transfer, this.id);
    if (method === 'open') p.then(() => this.host.remember(this.id, args[0], args[1] ?? 'docx'), () => {});
    if (method === 'ahead') this.host.rememberAhead(this.id, args);
    if (method === 'quiet') this.host.rememberQuiet(this.id, args[0] ?? true);
    return p;
  }

  /** The document's revision number (bumped by every change): the version execAs's ifRev is checked against. Read-only, so a
   * composition, a typing run or a selection is untouched. */
  async rev() {
    return Number(await this.call('rev'));
  }

  /** Notes `bytes` (the engine form, as autosave stored it, or as the draft opened) as this draft's last autosave, the record
   * stamped `stamp`: a crash reopens it from them. */
  saved(bytes, kind = 'engine', stamp = null) {
    this.host.remember(this.id, bytes, kind, stamp);
  }

  /** Notes `history` as the undo history saved for the record stamped `stamp` (autosave.mjs, or the history file the draft
   * opened with): a crash's reopen takes it back. */
  savedHistory(stamp, history) {
    this.host.rememberHistory(this.id, stamp, history);
  }

  /** Listens to 'layout', 'selection', 'fonts.missing', 'crash' or 'reopened' → a function that stops listening. */
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
    return () => this.#listeners.get(event)?.delete(fn);
  }

  /** The host's: delivers `event` to this view's listeners. */
  emit(event, data) {
    for (const fn of this.#listeners.get(event) ?? []) fn(data);
  }

  /** Resolves once this session is laid out as it will show: its layout settled (after `ahead` an open lays out the first pages
   * and the rest in slices), and the fonts and data files (hyphenation, the word list) asked for so far loaded and laid out.
   * Each font or data file that arrives lays the drafts out again, so a place read before them moves (engine-fixes-edit: a
   * caret read right after an open came back 50 pt above its line). Rejects when the engine stops first. */
  async whenSettled() {
    // Done when a layout settled after the provider's last answer and the last data file, and asked for neither since. The
    // worker sends the fonts and data a layout lacks with its layout event, so ready() and dataReady() cover them once the
    // layout settles. fontsDone's reply comes before the layout it starts, so the fonts that layout asks for are known only
    // once it has settled too (engine-font-arrival: reads after whenSettled came back in the stand-in's 15.9 pt lines while
    // the document's 14.6 pt font still loaded).
    for (let seen = [null, NO_DATA]; ;) {
      await this.#layoutSettled();
      const now = [this.fonts?.ready() ?? null, this.host.dataReady()];
      if (now[0] === seen[0] && now[1] === seen[1]) return;
      await Promise.all((seen = now));
    }
  }

  /** Resolves once this session's layout is settled: at once, or at the layout event that says so. Rejects when this view is
   * released or the session closes first: no layout event reaches it then, and the wait would never end. */
  #layoutSettled() {
    return new Promise((resolve, reject) => {
      const offs = [];
      const end = (fn, v) => {
        for (const off of offs) off();
        fn(v);
      };
      offs.push(this.on('layout', (e) => e.settled !== false && end(resolve)), this.on('crash', (d) => end(reject, new Error(d.message))),
        this.on('closed', () => end(reject, new Error('The draft closed before its layout settled.'))));
      this.settled().then((done) => done && end(resolve), (e) => end(reject, e));
    });
  }

  /** This view is done with the draft; the session closes once no view holds it. */
  release() {
    if (this.#released) return;
    clearTimeout(this.handing);
    this.handing = 0;
    this.#released = true;
    this.host.leave(this);
    this.emit('closed');
  }

  /** This view leaves once another view holds the session, or after `ms`: an assistant's background session handed to the page
   * area (stage2b.md decision 5), which takes the session as it is, unsaved edits and undo steps included, where a session closed
   * first would open again from its last save without them. */
  handOff(ms = HAND_OFF) {
    if (this.#released) return;
    if (this.host.holders(this.id) > 1) return this.release();
    this.handing = setTimeout(() => this.release(), ms);
  }

  /** Opens `bytes` of `kind` ('docx', 'doc' or 'engine') in this session → {pages}. While other drafts are open in the engine
   * worker, the helper worker reads a .docx or .doc into the engine form, which this session opens, so those drafts never wait
   * for the reading. Should the helper fail, the engine worker reads the file itself (a damaged file then fails there with its
   * reason). With no other draft open, the engine worker reads it at once (engine-warm-scope): no draft waits, and the window's
   * first open saves the hand-over through this thread, which is busy with the draft switch then (about 100 ms of 450). Beside
   * other drafts, a session without `ahead` is laid out in slices between their calls, and this resolves once that layout
   * settles, so {pages} counts every page as before. */
  async open(bytes, kind = 'docx') {
    const beside = this.host.ids().some((id) => id !== this.id && id !== WARM);
    let r;
    const model = (kind === 'docx' || kind === 'doc') && beside ? await this.host.helper().call('engineForm', [bytes, kind]).catch(() => null) : null;
    if (model) {
      // engine-open-parse: the helper's engine form goes to the worker moved rather than copied (the Word fixture's 7.3 MB took
      // this thread about 5 ms to copy, and the worker as long again before it answered anything), so a crash reopens the
      // draft from the file it came from.
      r = await this.call('open', [model, 'engine', beside], [model.buffer]);
      this.host.remember(this.id, bytes, kind);
    } else r = await this.call('open', [bytes, kind, beside]);
    if (!r?.sliced || r.settled) return r;
    await this.#layoutSettled();
    return { pages: (await this.pages()).pages.length, settled: true };
  }

  /** The draft as PDF → {bytes, outlined, why, ms}: `outlined` the font families drawn as outlines (their text is not
   * selectable), `why` a line for each such face, `ms` the export's own time. `options` is a print job as the engine's pdf
   * call takes it ({print: true} for a print job's PDF). The helper worker lays out and exports this session's engine form
   * (save('engine'), which runs here in steps) with the fonts this session used, so the drafts here keep painting. */
  async pdf(options = {}) {
    const [model, used] = await Promise.all([this.call('save', ['engine']), this.call('fontsUsed')]);
    return this.host.helper().pdf(model, options, used);
  }

  /** Prints the draft (viewport-design.md P14b): the engine makes a print job's PDF, `job` being its pages, copies and paper
   * as `pdf` takes them, which the desktop prints from a hidden window (window.api.word.printPdf, with word.print's `printer`
   * options) and the web from a hidden iframe. → {ok, error, outlined}: `outlined` names the font families drawn as outlines,
   * whose text is not selectable: either their licence forbids embedding them or the face could not be embedded (the subsetter
   * failed on it). A message about them names no reason ("Some fonts print as shapes"); `pdf`'s `why` has each face's. */
  async print(job = {}, printer = {}) {
    const { bytes, outlined } = await this.pdf({ ...job, print: true });
    const desktop = globalThis.__wordTest?.printPdf ?? globalThis.window?.api?.word?.printPdf;
    const r = await (desktop ? desktop(bytes, printer) : printFrame(bytes));
    return { ok: !!r?.ok, error: r?.error ?? null, outlined };
  }
}

/** The frame of the last web print: it stays until the next one, since the print dialog may still read it. */
let printing = null;

/** Prints PDF `bytes` from a hidden iframe: the browser's print dialog shows its pages. A test page replaces the frame's
 * print() through window.__wordTest.framePrint (plan.md section 1.16), so no dialog opens. */
function printFrame(bytes) {
  if (printing) {
    printing.frame.remove();
    URL.revokeObjectURL(printing.url);
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  printing = { frame, url };
  return new Promise((resolve) => {
    frame.onload = () => {
      try {
        (globalThis.__wordTest?.framePrint ?? ((w) => w.print()))(frame.contentWindow);
        resolve({ ok: true, error: null });
      } catch (e) {
        resolve({ ok: false, error: e?.message ?? String(e) });
      }
    };
    frame.src = url;
    document.body.append(frame);
  });
}

for (const m of CALLS) {
  SessionClient.prototype[m] = function (...args) {
    return this.call(m, args);
  };
}

/** A session on a host of its own: a worker for one draft, as stage 1 and the tests use it. */
export class EngineClient extends SessionClient {
  constructor(url, options) {
    super(new EngineHost(url, options), 0);
  }

  /** Ends the worker and the document in it. */
  terminate() {
    this.host.terminate();
  }
}

let shared = null;

/** The window's engine host, started on first use. */
export const engineHost = () => (shared ??= new EngineHost());

let warming = null;

/** How long a helper started by warmEngine waits for its first job before it closes (EngineHost.warmIdle): a window that opens
 * no Document in the canvas page area soon does not keep the helper's memory for the whole session. */
const WARM_IDLE = 120000;

/** The warm draft's content: headings, styled text, lists and a table, enough of it that the hot code paths of reading a
 * .docx, laying out and painting are compiled and optimised (the .wasm compiles each function on its first call and optimises
 * it once it has run a while). A blank draft left the first real open about 140 ms slower than the second. */
function warmHtml() {
  const para = '<p>The <b>engine</b> lays out <i>this</i> <u>paragraph</u> with <a href="https://example.com">a link</a>, '
    + '<span style="font-size:14pt;color:#2050a0">a styled run</span> and enough words to wrap over more than one line of the page.</p>';
  const cells = (tag) => `<tr>${[1, 2, 3, 4].map((n) => `<${tag}>Cell ${n}</${tag}>`).join('')}</tr>`;
  const block = `<h1>Heading</h1>${para}<h2>Subheading</h2>${para}<ul><li>One<ul><li>Two</li></ul></li><li>Three</li></ul>`
    + `<ol><li>First</li><li>Second</li></ol><table border="1">${cells('th')}${cells('td')}${cells('td')}</table>${para}`;
  return block.repeat(40);
}

/** Starts the window's engine before its first open (engine-gate-prep): the engine worker compiles and instantiates the .wasm
 * and adds its fonts, and the helper worker instantiates the compiled module, both off this thread. Then a warm draft (warmHtml)
 * goes once through an open's path and has a tile painted, so the first open of a Document runs code already compiled. The
 * first open paid for all of it (575 to 623 ms against 500). The helper closes after the host's warmIdle unless a job comes
 * first, then when idle as usual.
 * engine-warm-scope: `busy()` is true while a real open is under way (the page area opening a draft). The warm-up must never
 * compete with it, because the worker and the helper each run one call at a time: busy at the start, nothing starts (the open
 * starts the workers itself); busy later, or another session open, the warm draft is dropped at its next step and the workers
 * serve the open. Once per window → {at, worker, helper, ms, draft}: when it began (performance.now()), the ms until each worker
 * was ready and until the warm draft was done, and what became of the draft: 'painted', 'skipped', 'dropped' or 'failed'. */
export function warmEngine({ busy = () => false } = {}) {
  warming ??= (async () => {
    const at = performance.now();
    const taken = () => busy() || !!shared?.ids().some((id) => id !== WARM);
    if (taken()) return { at, ms: 0, draft: 'skipped' };
    const host = engineHost();
    // A worker-wide call: answered once the worker has started, and it opens no session.
    await host.call('sessions').catch(() => {});
    const worker = performance.now() - at;
    // Not a job: a job's end starts the helper's idle timer (helperIdle), too short for a late first open.
    const helper = host.helper();
    await helper.call('stats', [], [], false).catch(() => {});
    const helperAt = performance.now() - at;
    const s = host.session(WARM);
    const step = (fn) => (taken() ? Promise.reject(DROPPED) : fn());
    let draft = 'painted';
    try {
      await step(() => s.call('paste', ['html', warmHtml()]));
      const docx = await step(() => s.save('docx'));
      // The window's first open reads its file in the engine worker and a later one in the helper (SessionClient.open): the
      // warm draft is read in both, at the same time.
      // Not started once a real open came: the helper may soon read that open's file.
      const read = !taken() && helper.call('engineForm', [docx, 'docx'], [], false).catch(() => {});
      await step(() => s.call('ahead'));
      await step(() => s.call('open', [docx, 'docx']));
      await read;
      await step(() => s.pages());
      await step(() => paintOne(host));
      await host.fonts?.ready();
    } catch (e) {
      // Only a head start: the first open does the same work if this could not.
      draft = e === DROPPED ? 'dropped' : 'failed';
    } finally {
      s.release();
      helper.idleFor(host.warmIdle);
    }
    return { at, worker, helper: helperAt, ms: performance.now() - at, draft };
  })();
  return warming;
}

/** warmEngine's reason to stop: a real open came. */
const DROPPED = new Error('A draft is opening.');

/** The warm draft's session id: no draft id starts with U+0000. */
const WARM = '\u0000warm';

/** Has the engine worker paint page 1's first tile of the warm draft → once it came, or at once when another session is open:
 * the worker holds one wish list, which a page area's would be replaced with. A page area's next wish list replaces this one. */
function paintOne(host) {
  if (host.ids().some((id) => id !== WARM)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, 2000);
    const off = host.on('tiles', (data, session) => {
      if (session !== WARM) return; // a page area's tiles are its own
      for (const t of data?.list ?? []) t.bitmap?.close();
      done();
    });
    function done() {
      clearTimeout(timer);
      off();
      resolve();
    }
    host.call('want', [[{ session: WARM, surface: 0, scale: 4 / 3, col: 0, row: 0 }]]).catch(done);
  });
}

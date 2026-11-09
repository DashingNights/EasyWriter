// Saving a draft open in the canvas editor (docs/plans/engine/model.md, Autosave). The engine's worker serialises the model;
// this thread only decodes the bytes and splices them into the record's JSON text (adopt), and `store` writes it in pieces
// (window.api.drafts.savePart). The app saves through saveOnce from actions.js doSave, in its save chain and sync hold
// (src/document/canvas/session.js); `autosave` is the same save on a timer of its own, for callers without the app.
import { adopt, kindOfDraft, recordParts } from './form.mjs';

const CHUNK = 1 << 20;

/** Runs `fn` in this thread's idle time (requestIdleCallback; a timer where there is none, as in node tests) → its result. */
const whenIdle = (fn) => new Promise((resolve, reject) => {
  const run = () => {
    try {
      resolve(fn());
    } catch (e) {
      reject(e);
    }
  };
  if (globalThis.requestIdleCallback) requestIdleCallback(run, { timeout: 500 });
  else setTimeout(run, 0);
});

/** One save of `draft` (changed in place) held by `client` (its SessionClient) → the last store call's reply {id, updated, marks}
 * (marks: main.js saveDraft's list marks), merged into `draft` without its marks. `store(part, i, n)` takes the record's JSON text in `n` pieces, one call each in order
 * (window.api.drafts.savePart); main.js writes the record only when the last piece of an unbroken run arrives, so a run cut off
 * part way writes nothing. Throws when the engine or a store call fails. `last` gets the save's {workerMs, mainMs, longest,
 * chars}, mainMs being this thread's share (decode, splice and the store calls' synchronous IPC copies) and longest its longest
 * task. This thread's share runs in idle tasks of about a megabyte each: the decode, the join, then one store call a piece (about
 * 1 ms each, where one call for the fixture's 7 MB took 7 to 9 ms): a key's reply and frame go first, and a key that comes during
 * one waits for that task alone.
 * `history` {store, limit} (engine-undo-file): the draft's undo history is written after the record, as the engine save found
 * it, for the record's stamp (form.mjs adopt): `store(part, i, n)` as for the record (window.api.drafts.saveHistoryPart), keeping
 * `limit` undo steps (settings.historyLimit). Its failure leaves the history file as it was, which the stamp then drops at the
 * next open: the record is saved either way. `last.history` gets its {workerMs, mainMs, bytes}. What the engine writes is the
 * draft's own kind (form.mjs kindOfDraft): a Document's model form, or a forum post's JSON. */
export async function saveOnce(client, draft, store, last = {}, history = null) {
  const kind = kindOfDraft(draft);
  const t0 = performance.now();
  const bytes = await client.save(kind, !!history);
  const workerMs = performance.now() - t0;
  const ms = { main: 0, longest: 0 };
  const timed = timer(ms);
  const pieces = await decode(bytes, timed);
  const parts = await whenIdle(timed(() => (adopt(draft, pieces.join('')), recordParts(draft, pieces))));
  const saved = await send(parts, store, timed);
  Object.assign(last, { workerMs, mainMs: ms.main, longest: ms.longest, chars: parts.reduce((n, s) => n + s.length, 0) });
  const { marks, ...record } = saved ?? {};
  Object.assign(draft, record);
  // What a crash reopens the draft from (client.js SessionClient.saved): the form just stored.
  client.saved?.(bytes, kind, draft.engine.stamp);
  if (history) await saveHistory(client, draft, history, last);
  return saved;
}

/** saveOnce's undo history: never throws. The history is kept in memory too, so a crash's reopen takes it back. */
async function saveHistory(client, draft, { store, limit }, last) {
  const { stamp } = draft.engine;
  try {
    const t0 = performance.now();
    const bytes = await client.call('saveHistory', [stamp, limit]);
    const workerMs = performance.now() - t0;
    const ms = { main: 0, longest: 0 };
    const timed = timer(ms);
    // No step to keep: the file says so (null), and an older history in it goes.
    await send(bytes ? await decode(bytes, timed) : ['null'], store, timed);
    client.savedHistory?.(stamp, bytes);
    last.history = { workerMs, mainMs: ms.main, bytes: bytes?.length ?? 0 };
  } catch (e) {
    console.warn('The undo history was not saved.', e);
  }
}

/** A wrapper for this thread's work in a save: `fn` timed into `ms` {main, longest}. */
const timer = (ms) => (fn) => () => {
  const t = performance.now();
  const v = fn();
  const took = performance.now() - t;
  ms.main += took;
  ms.longest = Math.max(ms.longest, took);
  return v;
};

/** `bytes` (UTF-8 JSON) decoded a megabyte at a time in idle tasks (about 1 ms each) → the pieces of text. */
async function decode(bytes, timed) {
  const dec = new TextDecoder();
  const pieces = [];
  for (let at = 0; at < bytes.length; at += CHUNK) {
    pieces.push(await whenIdle(timed(() => dec.decode(bytes.subarray(at, at + CHUNK), { stream: at + CHUNK < bytes.length }))));
  }
  return pieces;
}

/** Sends `parts` to `store(part, i, n)`, each in its own idle task, since one call's copy of the fixture's 7 MB held the page 7 to
 * 9 ms → the last call's reply, once every call has answered. */
async function send(parts, store, timed) {
  const replies = [];
  for (let i = 0; i < parts.length; i++) {
    const { p } = await whenIdle(timed(() => ({ p: Promise.resolve(store(parts[i], i, parts.length)) })));
    p.catch(() => {}); // handled by the Promise.all below; this keeps an early failure from being reported as unhandled
    replies.push(p);
  }
  return (await Promise.all(replies)).at(-1);
}

/** Autosave for `draft` held by `client`: saveOnce on a timer. Call `changed()` after every edit: a save starts `idle` ms after
 * the last one, as actions.js markDirty's does. Saves run one at a time and an edit during one gets the next. A failed save
 * leaves the draft unsaved (onError) → {changed, flush, stop, dirty, last}, `last` being the last save's timings. */
export function autosave(client, draft, store, { idle = 800, onSaved = () => {}, onError = () => {} } = {}) {
  let timer = null;
  let dirty = false;
  let chain = Promise.resolve(true);
  const last = { workerMs: 0, mainMs: 0, longest: 0, chars: 0 };

  async function run() {
    if (!dirty) return true;
    dirty = false;
    try {
      await saveOnce(client, draft, store, last);
      onSaved(draft, last);
      return true;
    } catch (e) {
      dirty = true;
      onError(e);
      return false;
    }
  }

  /** Saves now if anything is unsaved → true once saved (or nothing to save). */
  function flush() {
    clearTimeout(timer);
    chain = chain.then(run, run);
    return chain;
  }

  return {
    changed() {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(flush, idle);
    },
    flush,
    /** No more timed saves; a flush still saves (a close does that last). */
    stop: () => clearTimeout(timer),
    get dirty() { return dirty; },
    last,
  };
}

/** A filter for one session's 'layout' events → edited(event): whether the event follows a change to the document (an edit, an
 * undo or a redo), which needs a save, rather than a layout of the same document again (fonts or hyphenation data arriving, an
 * open). An edit reports the blocks it changed (`changes`); a change outside blocks, such as page setup, still moves the top
 * undo or redo step. A new filter for each session open: an open starts with no steps. Steps the session got otherwise (a saved
 * history taken back, a session already open) are noted with edited({steps}), whose answer is then of no interest. */
export function editWatch() {
  let undo = null;
  let redo = null;
  return (e) => {
    const s = e?.steps ?? {};
    const moved = (s.undo ?? null) !== undo || (s.redo ?? null) !== redo;
    undo = s.undo ?? null;
    redo = s.redo ?? null;
    return e?.changes != null || moved;
  };
}

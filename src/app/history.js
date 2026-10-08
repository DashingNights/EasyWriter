import { Selection } from '@tiptap/pm/state';
import { Step } from '@tiptap/pm/transform';
import { closeHistory, isHistoryTransaction, redoDepth, undoDepth, undoNoScroll } from '@tiptap/pm/history';

// Persistent undo history (§7e). A log mirrors the newest steps of prosemirror-history's stacks for the open draft:
// `base` is the doc before its oldest step, `events` its steps (the undo stack, then the undone ones) as
// {sel: the selection JSON before the step, trs: [{steps, time}]}, `undone` how many of them are undone. `depth` / `redo`
// are the history's counts and `sel` the selection after the last transaction, to tell what the next one did.

export const newLog = (state) => restart({ depth: undoDepth(state), redo: redoDepth(state), sel: state.selection }, state);

function restart(log, state) {
  return Object.assign(log, { base: state.doc, events: [], undone: 0 });
}

/** Logs a dispatched transaction and the ones plugins appended to it; `state` is the editor state after them. */
export function record(log, tr, appended, state) {
  const depth = undoDepth(state);
  const redo = redoDepth(state);
  const changes = [tr, ...appended].filter((t) => t.docChanged);
  const kept = tr.getMeta('addToHistory') !== false;
  if (isHistoryTransaction(tr)) {
    // An undo or redo moves one step between the stacks; one from before the log restarts it.
    log.undone += redo > log.redo ? 1 : -1;
    if (log.undone < 0 || log.undone > log.events.length) restart(log, state);
  } else if (changes.some((t) => !kept || t.getMeta('addToHistory') === false)) {
    restart(log, state); // a change the history does not undo: the logged steps no longer replay onto the doc
  } else if (changes.length) {
    let event = log.events.at(-1);
    if (depth !== log.depth) {
      // A new step empties the redo stack; past the depth the history cuts off its oldest steps.
      log.events.length -= log.undone;
      log.undone = 0;
      fold(log, log.events.length + 1 - depth);
      log.events.push((event = { sel: log.sel.toJSON(), trs: [] }));
    }
    if (event) event.trs.push(...changes.map((t) => ({ steps: t.steps, time: t.time })));
    else log.base = state.doc; // more of a step that began before the log
  }
  Object.assign(log, { depth, redo, sel: state.selection });
}

// Applies the oldest n steps to the base and drops them from the log.
function fold(log, n) {
  for (const ev of log.events.splice(0, Math.max(0, n))) {
    for (const t of ev.trs) for (const s of t.steps) log.base = s.apply(log.base).doc;
  }
}

// A copy of the log that keeps its last n undo steps and the undone ones (n = 0: nothing).
function trim(log, n) {
  const t = { base: log.base, events: log.events.slice(), undone: log.undone };
  fold(t, t.events.length - t.undone - n);
  return n ? t : { ...t, events: [], undone: 0 };
}

let hashes = new Map(); // data URL → key, from the last encode: each picture is hashed once while it stays

/** The history file of the log keeping its last `limit` undo steps, or null when that is none. Image data URLs are stored
 * once in `images`, keyed by a hash, and referenced from the doc and the steps as {$img: key}. */
export function encode(log, limit) {
  const { base, events, undone } = trim(log, limit);
  if (!events.length) return null;
  const images = {};
  const seen = new Map();
  const pack = (json) => walk(json, (v) => {
    if (typeof v !== 'string' || !v.startsWith('data:')) return undefined;
    const key = seen.get(v) ?? hashes.get(v) ?? hash(v);
    seen.set(v, key);
    images[key] = v;
    return { $img: key };
  });
  const file = {
    version: 1,
    base: pack(base.toJSON()),
    events: events.map(({ sel, trs }) => ({ sel, trs: trs.map(({ steps, time }) => ({ steps: steps.map((s) => pack(s.toJSON())), time })) })),
    undone,
    images,
  };
  hashes = seen;
  return file;
}

function decode(file, schema) {
  if (file?.version !== 1) throw new Error('not a history file');
  const unpack = (json) => walk(json, (v) => {
    if (typeof v?.$img !== 'string') return undefined;
    if (!Object.hasOwn(file.images, v.$img)) throw new Error('missing image');
    return file.images[v.$img];
  });
  const base = schema.nodeFromJSON(unpack(file.base));
  base.check();
  return {
    base,
    events: file.events.map(({ sel, trs }) => ({ sel, trs: trs.map(({ steps, time }) => ({ steps: steps.map((s) => Step.fromJSON(schema, unpack(s))), time })) })),
    undone: file.undone,
  };
}

/** Rebuilds the history of `file`, keeping its last `keep` undo steps, on `state` (a fresh editor state holding the saved
 * doc): the steps replay through the history plugin with their times (each step's first transaction closes the history
 * before it, the others join it), then the undone ones are undone. Returns {state, log}, or null when the file is
 * unreadable or does not lead to the saved doc. */
export function rebuild(state, file, keep) {
  try {
    const log = trim(decode(file, state.schema), keep);
    if (!log.events.length) return null;
    // Recorded transactions apply as they are (applyInner: plugins do not append to them again); undo runs as it did.
    let st = state.applyInner(state.tr.replaceWith(0, state.doc.content.size, log.base.content).setMeta('addToHistory', false));
    for (const { sel, trs } of log.events) {
      st = st.applyInner(st.tr.setSelection(Selection.fromJSON(st.doc, sel)));
      let first = null;
      for (const { steps, time } of trs) {
        const tr = st.tr.setTime(time);
        for (const s of steps) tr.step(s);
        if (first) tr.setMeta('appendedTransaction', first);
        else closeHistory((first = tr));
        st = st.applyInner(tr);
      }
    }
    for (let i = 0; i < log.undone; i++) undoNoScroll(st, (tr) => { st = st.apply(tr); });
    if (!st.doc.eq(state.doc) || undoDepth(st) !== log.events.length - log.undone || redoDepth(st) !== log.undone) return null;
    // The saved selection, and the next change starts a new step.
    st = st.apply(closeHistory(st.tr.setSelection(Selection.fromJSON(st.doc, state.selection.toJSON()))));
    return { state: st, log: Object.assign(log, { depth: undoDepth(st), redo: redoDepth(st), sel: st.selection }) };
  } catch {
    return null;
  }
}

// Copies a JSON value, replacing each part for which `f` returns a value.
function walk(v, f) {
  const r = f(v);
  if (r !== undefined) return r;
  if (Array.isArray(v)) return v.map((x) => walk(x, f));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]));
  return v;
}

// 53-bit string hash (cyrb53).
function hash(s) {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

// The Suggestions extension (docs/plans/suggestions.md One converter, Display): both editor kits carry it (src/editors.js), so the
// open draft's editor, the assistant's background sessions and the background window record agent edits the same way. It runs
// last in each round (priority 1): an agent's round gets its records (core.convert) in the same dispatch and undo event, any
// other round keeps records whole (core.normalize), pastes drop records, and the page draws the waiting changes in yellow.
// Nothing touches the DOM at import, so Node tests load it.
import { Extension, getExtensionField } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import * as core from './core.mjs';

export const suggestKey = new PluginKey('suggestions');

// ---------- who a dispatch belongs to ----------
const exact = new Map(); // editor → the call whose builder is dispatching in it ('exact')
let windowScope = null; // {call, kind: 'ui' | 'computer'}: an agent run on the main window's current editor
let windowEditor = () => null;
let workerCall = null; // the background window's current call (computer.act sets it)
const editors = new Set(); // live editors, for the user's last input in each
const lastInput = new WeakMap(); // editor → ms of the last trusted input event inside it or its board layer

/** Runs `fn` (sync or async) with agent call `call` ({g, by, at, note?, ids}; null: nothing changes) attributed: kind 'exact' to every
 * transaction of `editor`, 'ui' and 'computer' to those of the main window's current editor (setWindowEditor). */
export function withCall(editor, call, kind, fn) {
  if (!call) return fn();
  let restore;
  if (kind === 'exact') {
    const prev = exact.get(editor);
    exact.set(editor, call);
    restore = () => (prev ? exact.set(editor, prev) : exact.delete(editor));
  } else {
    const prev = windowScope;
    windowScope = { call, kind };
    restore = () => { windowScope = prev; };
  }
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/** Whether an agent's 'ui' or 'computer' scope is open on the main window: its input may be arriving now. */
export const agentInputOpen = () => windowScope != null;

/** `getter` → the main window's current editor (actions.js: the open draft's). */
export function setWindowEditor(getter) {
  windowEditor = getter;
}

/** The background window's current call: every transaction there is that call's while it is set (null: none). */
export function setWorkerCall(call) {
  workerCall = call ?? null;
}

/** The changes the background window's current call recorded so far (computer-main.js reads them after each action). */
export const workerIds = () => [...(workerCall?.ids ?? [])];

const isHistory = (tr) => tr.getMeta('history$') != null; // prosemirror-history's PluginKey('history')

// The agent call a root transaction of `owner`'s belongs to, or null (the user's, or no agent scope).
function callFor(owner, root) {
  if (root.getMeta(core.META) || isHistory(root) || root.getMeta('addToHistory') === false) return null;
  const call = exact.get(owner);
  if (call) return call;
  if (windowScope && windowEditor() === owner) return windowAgent(owner) ? windowScope.call : null;
  return workerCall;
}

const windowAgent = (owner) => typeof window !== 'undefined'
  && core.attribute(windowScope.kind, window.event, lastInput.get(owner) ?? -Infinity, Date.now()) === 'agent';

// The user's own input: the time of the last trusted input event inside each editor (its view or, in Canvas Mode, its board).
let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const note = (e) => {
    if (!e.isTrusted || !(e.target instanceof Node)) return;
    for (const ed of editors) {
      if (ed.isDestroyed) continue;
      const dom = ed.view.dom;
      const board = dom.closest('.page')?.querySelector(':scope > .sce-art');
      if (dom.contains(e.target) || board?.contains(e.target)) lastInput.set(ed, Date.now());
    }
  };
  for (const type of core.INPUT_EVENTS) window.addEventListener(type, note, true);
}

// ---------- decorations ----------
const el = (view, tag, cls, text) => {
  const d = view.dom.ownerDocument.createElement(tag);
  d.className = cls;
  if (text != null) d.textContent = text;
  return d;
};

// A deleted run's widget: its blocks struck through, atoms as labelled placeholders; never editable or spell checked.
const deletedBlocks = (old, id) => (view) => {
  const box = el(view, 'div', 'sg-del-block');
  box.contentEditable = 'false';
  box.spellcheck = false;
  box.dataset.sg = id;
  for (const j of old) {
    const label = core.labelOf(j.type, j.attrs);
    const line = el(view, 'div', label ? 'sg-del-line sg-atom' : 'sg-del-line', label ?? textOf(j));
    box.append(line);
  }
  return box;
};
const textOf = (j) => (j?.type === 'text' ? j.text ?? '' : (j?.content ?? []).map(textOf).join(j?.type === 'paragraph' || j?.type === 'heading' ? '' : ' '));
// Deleted words at their place; `pid` (a place's id) and `cls` (' sg-place', ' sg-active') when the change is decided by place.
const deletedWords = (text, id, pid = null, cls = '') => (view) => {
  const s = el(view, 'span', `sg-del${cls}`, text);
  s.contentEditable = 'false';
  s.spellcheck = false;
  s.dataset.sg = id;
  if (pid) s.dataset.sgp = pid;
  return s;
};

const blockAttrs = (n) => JSON.stringify({ ...n.attrs, suggest: null });

/** The page decorations of the waiting changes of `state` (Display): inserted text underlined and filled, word changes in a
 * replaced run, deleted blocks as a struck widget, new objects outlined with a tag; the active change stronger. */
function decorate(state, active) {
  const { doc, schema } = state;
  const out = [];
  for (const e of core.entries(doc)) {
    if (e.kind === 'attr') continue; // page setup: the card anchors at the sheet top
    const on = e.id === active ? ' sg-active' : '';
    const attrs = (cls) => ({ class: cls + on, 'data-sg': e.id });
    if (e.kind === 'delete') {
      out.push(Decoration.widget(e.from, deletedBlocks(e.old, e.id), { side: 1, key: `sgd:${e.id}:${on}`, ignoreSelection: true, marks: [] }));
      continue;
    }
    // Each block of the change: its own node decoration (hover raises the whole block) and, in an insert, the fill.
    const blocks = e.nodes.map((n, k) => ({ n, pos: e.starts[k] }));
    let olds = null;
    if (e.kind === 'replace') {
      try {
        olds = e.old.map((j) => schema.nodeFromJSON(j));
      } catch {
        olds = [];
      }
    }
    const pairs = olds && olds.length === blocks.length;
    blocks.forEach(({ n, pos: at }, k) => {
      const end = at + n.nodeSize;
      const object = n.isLeaf || core.LABELS[n.type.name];
      const old = pairs ? olds[k] : null;
      if (e.kind === 'insert' || (old && old.type !== n.type && !n.isTextblock)) {
        if (object) out.push(Decoration.node(at, end, { ...attrs('sg-node'), 'data-sg-tag': 'Suggested' }));
        if (!n.isLeaf) out.push(Decoration.inline(at, end, attrs('sg-add')));
        if (!object) out.push(Decoration.node(at, end, { class: 'sg-block', 'data-sg': e.id }));
        return;
      }
      if (n.isLeaf) {
        out.push(Decoration.node(at, end, { ...attrs('sg-node'), 'data-sg-tag': 'Suggested' }));
        return;
      }
      out.push(Decoration.node(at, end, { class: old && old.content.eq(n.content) && old.type === n.type && old.attrs.level === n.attrs.level
        && blockAttrs(old) !== blockAttrs(n) ? `sg-block sg-fmt-block${on}` : 'sg-block', 'data-sg': e.id }));
      // A block type change (paragraph to heading) with the same text: a dotted underline over the block.
      if (old && old.textContent === n.textContent && (old.type !== n.type || old.attrs.level !== n.attrs.level)) out.push(Decoration.inline(at, end, attrs('sg-fmt')));
    });
    if (e.kind !== 'replace') continue;
    // A change decided place by place: each place carries its id (data-sgp), for its card's hover and the active one.
    const ps = core.places(e, schema);
    if (ps.length) {
      for (const p of ps) {
        const cls = ` sg-place${p.id === active ? ' sg-active' : ''}`;
        const pattrs = (c) => ({ class: c + cls, 'data-sg': e.id, 'data-sgp': p.id });
        if (p.kind === 'fmt') {
          out.push(Decoration.inline(p.from, p.to, pattrs('sg-fmt')));
          continue;
        }
        if (p.gone.trim()) out.push(Decoration.widget(p.from, deletedWords(p.gone, e.id, p.id, cls), { side: -1, key: `sgw:${p.id}:${p.gone}:${cls}`, marks: [], ignoreSelection: true }));
        if (p.to > p.from && p.added.trim()) out.push(Decoration.inline(p.from, p.to, pattrs('sg-add')));
      }
      continue;
    }
    core.diff(e, doc, schema).forEach((c, k) => {
      if (c.kind === 'del') out.push(Decoration.widget(c.from, deletedWords(c.text, e.id), { side: -1, key: `sgw:${e.id}:${k}:${c.text}:${on}`, marks: [], ignoreSelection: true }));
      else if (c.to > c.from) out.push(Decoration.inline(c.from, c.to, attrs(c.kind === 'add' ? 'sg-add' : 'sg-fmt')));
    });
  }
  return DecorationSet.create(doc, out);
}

// ---------- the plugin ----------
// A pasted or dropped slice never carries records (a drag-move's lost record comes back through normalize).
function cleanFragment(frag) {
  let changed = false;
  const out = [];
  frag.forEach((n) => {
    const content = n.content.size ? cleanFragment(n.content) : n.content;
    if (n.attrs.suggest || content !== n.content) {
      changed = true;
      out.push(n.type.create(n.attrs.suggest ? { ...n.attrs, suggest: null } : n.attrs, content, n.marks));
    } else out.push(n);
  });
  return changed ? Fragment.fromArray(out) : frag;
}

const converted = new WeakSet(); // roots already converted in their dispatch: later rounds of it are normalized

/** The ProseMirror plugin of editor `owner` (the key withCall 'exact' and the window editor getter compare). */
export function suggestPlugin(owner) {
  let last = { doc: null, active: undefined, set: DecorationSet.empty };
  return new Plugin({
    key: suggestKey,
    state: {
      init: (_, state) => ({ active: null, count: core.pendingCount(state.doc) }),
      apply(tr, v, _old, state) {
        const m = tr.getMeta(core.META);
        const active = m && typeof m === 'object' && 'active' in m ? m.active : v.active;
        if (!tr.docChanged && active === v.active) return v;
        return { active, count: tr.docChanged ? core.pendingCount(state.doc) : v.count };
      },
    },
    // An Undo pressed by an agent (ui.invoke, computer.act) would change the draft without a record: dropped. The background
    // window filters nothing (an undo there takes its own records with it).
    filterTransaction(tr) {
      if (!isHistory(tr) || !windowScope || windowEditor() !== owner) return true;
      return !windowAgent(owner);
    },
    appendTransaction(trs, oldState, newState) {
      const fresh = trs.filter((t) => !t.getMeta(core.META));
      if (!fresh.some((t) => t.docChanged)) return null;
      const root = trs[0].getMeta('appendedTransaction') ?? trs[0];
      if (root.getMeta(core.META) || isHistory(root)) return null; // undo restores records with the text
      const call = converted.has(root) ? null : callFor(owner, root);
      if (call) {
        converted.add(root);
        return core.convert(oldState, newState, call);
      }
      if (!suggestKey.getState(oldState)?.count && !suggestKey.getState(newState)?.count) return null;
      const mapping = new Mapping();
      for (const t of trs) mapping.appendMapping(t.mapping);
      const fixes = core.normalize(oldState.doc, newState.doc, mapping);
      if (!fixes.length) return null;
      const tr = newState.tr;
      for (const { pos, value } of fixes) tr.setNodeAttribute(pos, 'suggest', value);
      return tr.setMeta(core.META, 'normalize');
    },
    props: {
      transformPasted: (slice) => {
        const content = cleanFragment(slice.content);
        return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
      },
      decorations(state) {
        const { active, count } = suggestKey.getState(state);
        if (!count) return DecorationSet.empty;
        if (last.doc !== state.doc || last.active !== active) last = { doc: state.doc, active, set: decorate(state, active) };
        return last.set;
      },
    },
  });
}

// ---------- the editor API ----------
/** Makes change `id` the active one (null: none) in `editor`: its decorations draw stronger. */
export function setActive(editor, id) {
  editor.view.dispatch(editor.state.tr.setMeta(core.META, { active: id ?? null }).setMeta('addToHistory', false));
}

/** The active change of `state`, or null. */
export const activeOf = (state) => suggestKey.getState(state)?.active ?? null;

const log = []; // this session's decisions, the last 200

/** Accepts or rejects (`action`) the changes `sel` picks ({ids} | {group} | {all: true}) in `editor`, one transaction and one undo
 * step; logs {draftId, ids, g, author, by, action, at} per group. `by`: who decided (a source). → the ids it resolved. */
export function resolve(editor, sel, action, { by = null, draftId = null } = {}) {
  if (sel?.places?.length) return resolvePlaces(editor, sel.places, action, { by, draftId });
  const all = core.entries(editor.state.doc);
  const picked = sel?.all ? all : sel?.group ? all.filter((e) => e.g === sel.group) : all.filter((e) => sel?.ids?.includes(e.id));
  if (!picked.length) return [];
  const ids = picked.map((e) => e.id);
  const tr = (action === 'reject' ? core.reject : core.accept)(editor.state, ids);
  if (tr) editor.view.dispatch(tr);
  const at = Date.now();
  for (const g of new Set(picked.map((e) => e.g))) {
    const mine = picked.filter((e) => e.g === g);
    log.push({ draftId, ids: mine.map((e) => e.id), g, author: mine[0].by, by, action, at });
  }
  log.splice(0, Math.max(0, log.length - 200));
  return ids;
}

// Places `pids` (core.places ids) of `editor`'s changes, accepted or rejected in one transaction; logged per group like a change.
function resolvePlaces(editor, pids, action, { by, draftId }) {
  const { state } = editor;
  const picked = core.items(state.doc, state.schema).filter((it) => it.place && pids.includes(it.id));
  if (!picked.length) return [];
  const tr = (action === 'reject' ? core.rejectPlaces : core.acceptPlaces)(state, picked.map((it) => it.id));
  if (tr) editor.view.dispatch(tr);
  const at = Date.now();
  for (const g of new Set(picked.map((it) => it.e.g))) {
    const mine = picked.filter((it) => it.e.g === g);
    log.push({ draftId, ids: mine.map((it) => it.id), g, author: mine[0].e.by, by, action, at });
  }
  log.splice(0, Math.max(0, log.length - 200));
  return picked.map((it) => it.id);
}

/** This session's decisions, oldest first. */
export const decisions = () => [...log];

const notes = new Map(); // group → its metadata rows ("Rename to “Q3 notes”"), the last 50
/** Adds row `text` to group `g`'s card (draft metadata an agent changed). */
export function noteGroup(g, text) {
  const rows = notes.get(g) ?? [];
  rows.push(text);
  notes.set(g, rows.slice(-50));
}
/** Group `g`'s metadata rows. */
export const groupNotes = (g) => [...(notes.get(g) ?? [])];

/** The node types that may sit at the top level of a kit (group block) and the doc: the ones that carry `suggest`. */
function topLevelTypes(extensions) {
  return extensions.filter((e) => e.type === 'node').filter((e) => {
    if (e.name === 'doc' || getExtensionField(e, 'topNode')) return true;
    const group = getExtensionField(e, 'group', { name: e.name, options: e.options, storage: e.storage });
    return String(group ?? '').split(' ').includes('block');
  }).map((e) => e.name);
}

export const Suggestions = Extension.create({
  name: 'suggestions',
  priority: 1, // last: its appendTransaction sees every other plugin's appended transactions of the round
  addGlobalAttributes() {
    return [{
      types: topLevelTypes(this.extensions),
      attributes: {
        // Never in HTML (rendered false, parseHTML null), so never on the clipboard or in a push; not copied by a split at the end.
        suggest: { default: null, rendered: false, keepOnSplit: false, parseHTML: () => null },
      },
    }];
  },
  addProseMirrorPlugins() {
    return [suggestPlugin(this.editor)];
  },
  onCreate() {
    editors.add(this.editor);
    listen();
  },
  onDestroy() {
    editors.delete(this.editor);
  },
});

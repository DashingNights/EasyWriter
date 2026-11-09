// The clipboard package's renderer state (docs/plans/word plan.md §3 clipboard): the record of our last copy (where it came from,
// for the paste defaults), the paste in progress, the system clipboard snapshot the Paste menu reads, the Clipboard pane's items,
// the Format Painter's pick-up, and the actions that paste with a chosen option. The plugin (plugin.js) and the commands
// (index.js) share it; one record per renderer, as lists.js keeps its copiedFrom.
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import { getState, setState } from '../../../app/store.js';
import { paneOpen } from '../../../tooling/panes.jsx';
import { columnWidth, pictureSize } from '../../../whiteboard.js';
import { wordSettings } from '../../word/settings.mjs';
import { applyPlan, isFormatMark, nextPainter, pickUp, wordAt } from './painter.mjs';
import { addItem, removeItem, excerpt } from './ring.mjs';
import { sourceKind } from './modes.mjs';

/** The clipboard IPC (plan.md §1.17), stubbable in harness pages through window.__wordTest.clipboard. */
const ipc = () => globalThis.__wordTest?.clipboard ?? window.api?.word?.clipboard;
/** The word store (plan.md §1.17), stubbable through window.__wordTest.store. */
export const store = () => globalThis.__wordTest?.store ?? window.api?.word?.store;

/** The paste settings with their defaults (settings.word.paste). */
export const pasteSettings = () => wordSettings(getState().settings).paste;

// ---------------------------------------------------------------------------------------------
// Our copies and the paste in progress

export const mem = {
  copied: null, // {docKey, styles, theme, numbering, text}: the last copy or cut in a Document editor
  current: null, // {data, kind, mode, src?, table?}: the paste being parsed now, set by the paste event or pasteData
  snap: { text: '', html: '', image: null }, // the system clipboard as last read, for the Paste menu
  snapAt: 0,
};

/** The key that names the Document `view` shows (its draft id, as lists.js reads it). */
export const docKey = (view) => view.dom.getAttribute('data-doc-id') || null;

const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();

/** The copy record of clipboard `data` when it is our last copy (the same text), else null: then its styles and theme are known. */
export function sourceOf(data) {
  return mem.copied && sourceKind(data) === 'ours' && norm(mem.copied.text) === norm(data.text) ? mem.copied : null;
}

/** Reads the system clipboard → {text, html, image}, kept as the Paste menu's snapshot (which re-renders through the store). */
export async function readClipboard() {
  let data = { text: '', html: '', image: null };
  try {
    data = { ...data, ...(await ipc()?.read()) };
  } catch {
    // No clipboard access (a session editor's host, a Node test): an empty clipboard.
  }
  setSnap(data);
  return data;
}

function setSnap(data) {
  const was = mem.snap;
  mem.snap = { text: data.text ?? '', html: data.html ?? '', image: data.image ?? null };
  mem.snapAt = Date.now();
  // The menus draw from the snapshot: a change bumps the store, which re-renders useWordCtx readers.
  if (was.text !== mem.snap.text || was.html !== mem.snap.html || was.image !== mem.snap.image) setState({ wordClipboard: mem.snapAt });
}

/** The snapshot for the Paste menu; reads the clipboard again when it is older than a second. */
export function snapshot() {
  if (Date.now() - mem.snapAt > 1000) {
    mem.snapAt = Date.now();
    readClipboard();
  }
  return mem.snap;
}

/** Records a copy or cut of `slice` in Document editor `view`: the source record and, while the Clipboard pane collects, a pane item. */
export function recordCopy(view, slice) {
  const { dom, text } = view.serializeForClipboard(slice);
  const html = dom.innerHTML;
  const { styles, theme, numbering } = view.state.doc.attrs;
  mem.copied = { docKey: docKey(view), styles, theme, numbering, text };
  // null, not false, for more than one node: `false?.type` is undefined, and reading its name threw out of the copy handler, so
  // ProseMirror never filled the clipboard for a copy of several paragraphs.
  const only = slice.content.childCount === 1 ? slice.content.firstChild : null;
  const image = only?.type.name === 'image' ? only.attrs.src : only?.childCount === 1 && only.firstChild.type.name === 'image' ? only.firstChild.attrs.src : null;
  setSnap({ text, html, image: null });
  if (collecting()) addToRing({ html, text, image, kind: 'ours' });
}

// ---------------------------------------------------------------------------------------------
// The Clipboard pane's items

let ring = [];
let seq = 0;
const ringListeners = new Set();
const emitRing = () => { for (const fn of ringListeners) fn(); };

/** Whether copies go to the Clipboard pane: while it is open, or always with Collect Without Showing. */
export const collecting = () => paneOpen('clipboard') || !!pasteSettings().collectHidden;
/** The pane's items, newest first. */
export const ringItems = () => ring;
export const subscribeRing = (fn) => {
  ringListeners.add(fn);
  return () => ringListeners.delete(fn);
};
export function addToRing({ html = '', text = '', image = null, kind }) {
  const next = addItem(ring, { id: `c${++seq}`, html, text, image, kind: kind ?? sourceKind({ html, text, image }), excerpt: excerpt(text) });
  if (next !== ring) {
    ring = next;
    emitRing();
  }
}
export function deleteFromRing(id) {
  ring = removeItem(ring, id);
  emitRing();
}
export function clearRing() {
  ring = [];
  emitRing();
}

let lastSeen = null; // the system clipboard text and html last added on window focus
/** On window focus while collecting: the system clipboard joins the pane once when it changed (a copy in another program). */
export async function collectSystem() {
  if (!collecting()) return;
  const data = await readClipboard();
  const sig = `${data.text}\u0000${data.html}\u0000${data.image ?? ''}`;
  if (sig === lastSeen) return;
  lastSeen = sig;
  // Our own copy read back (Chromium adds a <meta charset> to its HTML, so addItem's exact match misses it).
  const top = ring[0];
  if (!data.image && top?.kind === 'ours' && top.text === data.text) return;
  if (data.text || data.html || data.image) addToRing(data);
}

// ---------------------------------------------------------------------------------------------
// Pasting with a chosen option

/** Pastes `data` ({html, text, image}) into editor `view` with paste option `mode` (null: the default for its source). A picture
 * goes in as an inline image; HTML and text go through the editor's own paste, so lists.js's hooks run first. */
export function pasteData(view, data, mode = null, extra = {}) {
  if (!view?.dom.isConnected) return false;
  const kind = sourceKind(data);
  if (!kind) return false;
  view.focus();
  if (kind === 'picture') {
    const image = view.state.schema.nodes.image;
    if (!image) return false;
    // Sized like the app's own picture paste (at most the text width), so it waits for the picture to decode.
    const img = new Image();
    img.onload = img.onerror = () => {
      if (view.isDestroyed) return;
      const size = img.naturalWidth && img.naturalHeight ? pictureSize({ w: img.naturalWidth, h: img.naturalHeight }, columnWidth(view)) : {};
      mem.current = { data, kind, mode: 'keepSourceFormatting', src: null };
      view.dispatch(view.state.tr.replaceSelectionWith(image.create({ src: data.image, ...size })).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
      mem.current = null;
    };
    img.src = data.image;
    return true;
  }
  mem.current = { data, kind, mode, ...extra };
  try {
    // Keep Text Only also parses the HTML: it works on the slice (cells to tabs, list labels typed).
    if (data.html && kind !== 'text') view.pasteHTML(data.html);
    else view.pasteText(data.text ?? '');
  } finally {
    mem.current = null;
  }
  return true;
}

/** Selects `from`..`to` in `view` as its own history step boundary, so the paste that follows is one undo step. */
export function selectRange(view, from, to, meta) {
  const max = view.state.doc.content.size;
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(from, max), Math.min(to, max)));
  closeHistory(tr);
  if (meta) tr.setMeta(meta.key, meta.value);
  view.dispatch(tr);
}

// ---------------------------------------------------------------------------------------------
// Format Painter, Copy Format and Paste Format

let pick = null; // {marks, para}: the formatting picked up last (the painter and Copy Format share it)
let armedAt = 0;

export const painterNow = () => getState().word?.painter ?? null;
export const picked = () => pick;

/** Picks up the formatting of `state`'s selection: the marks at the caret or of its first character, and its paragraph's. */
export function pickFrom(state) {
  const { selection: sel, doc } = state;
  let marks = sel.empty ? (state.storedMarks ?? sel.$from.marks()) : null;
  if (!marks) {
    doc.nodesBetween(sel.from, sel.to, (node) => {
      if (marks) return false;
      if (node.isText) marks = node.marks;
      return true;
    });
  }
  const para = sel.$from.parent;
  pick = pickUp((marks ?? []).map((m) => m.toJSON()), para.type.name, para.attrs);
  return pick;
}

/** Sets the painter's store value and redraws `editor`'s cursor (the plugin's attributes read it). */
export function setPainter(value, editor) {
  setState({ word: { ...getState().word, painter: value } });
  const view = editor?.view;
  if (view?.dom.isConnected) view.dispatch(view.state.tr.setMeta('wordPainter', value).setMeta('addToHistory', false));
}

/** Format Painter's run at time `now` on `editor`: arms it once, a quick second run makes it sticky, a later run turns it off. */
export function togglePainter(editor, now = Date.now()) {
  const next = nextPainter(painterNow(), armedAt, now);
  if (next === 'once') {
    if (!editor) return false;
    pickFrom(editor.state);
    armedAt = now;
  }
  setPainter(next, editor);
  return true;
}

/** Applies the picked formatting to `view`'s selection by Word's rules (painter.mjs applyPlan) → whether anything was applied. */
export function applyPick(view, p = pick) {
  if (!p || !view?.dom.isConnected) return false;
  const { state } = view;
  const { schema } = state;
  const sel = state.selection;
  const { $from, $to } = sel;
  const sameParagraph = $from.sameParent($to);
  const wholeParagraph = sameParagraph && $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size;
  const plan = applyPlan({ empty: sel.empty, sameParagraph, wholeParagraph });
  const tr = state.tr;
  let from = sel.from;
  let to = sel.to;
  if (plan.chars === 'word') {
    const start = $from.start();
    // Leaf nodes count as one character, so offsets in this text are positions from the paragraph's start.
    const w = wordAt(state.doc.textBetween(start, $from.end(), undefined, '￼'), $from.parentOffset);
    if (w) [from, to] = [start + w[0], start + w[1]];
  }
  const marks = p.marks.flatMap((m) => {
    try {
      return [schema.markFromJSON(m)];
    } catch {
      return [];
    }
  });
  if (from < to) {
    for (const type of Object.values(schema.marks)) if (isFormatMark(type.name)) tr.removeMark(from, to, type);
    for (const m of marks) tr.addMark(from, to, m);
  } else tr.setStoredMarks(marks);
  if (plan.para) {
    const type = schema.nodes[p.para.type];
    state.doc.nodesBetween(sel.from, sel.to, (node, pos) => {
      if (!node.isTextblock) return true;
      const target = type && (node.type.name === 'paragraph' || node.type.name === 'heading') ? type : node.type;
      const attrs = { ...node.attrs };
      for (const name of Object.keys(target.attrs)) if (name in p.para.attrs) attrs[name] = p.para.attrs[name];
      for (const name of Object.keys(attrs)) if (!(name in target.attrs)) delete attrs[name];
      tr.setNodeMarkup(pos, target, attrs);
      return false;
    });
  }
  if (!tr.docChanged && !tr.storedMarksSet) return false;
  view.dispatch(tr.scrollIntoView());
  return true;
}

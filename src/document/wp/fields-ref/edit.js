// Bookmark edits and link following on an editor (docs/plans/word/briefs/fields-ref.md): add, move, delete and go to bookmarks,
// wrap a cross-reference target in a hidden _Ref bookmark, and follow a link or a place with Word's back and forward stack.
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { toast } from '../../../app/actions.js';
import { openPane } from '../../../app/browser.js';
import { bookmarkNamed, bookmarksOf, newBookmarkId, refName } from './bookmarks.mjs';
import { safeDecode } from './refs.mjs';
import { refAround } from './xref.mjs';

/** The plugin key of fields-ref's plugin: its state holds the back and forward stacks of followed links. */
export const fieldsRefKey = new PluginKey('fieldsRef');

// An inline position at or next to `pos` (a bookmark sits in text, never between blocks).
function inlineAt(doc, pos, dir) {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($p.parent.inlineContent) return pos;
  return Selection.findFrom($p, dir, true)?.from ?? Selection.findFrom($p, -dir, true)?.from ?? pos;
}

/** Removes the markers of every bookmark named `name` (case-insensitive) in `tr`. */
function dropNamed(tr, name) {
  const doomed = bookmarksOf(tr.doc).filter((b) => b.name.toLowerCase() === name.toLowerCase());
  const at = doomed.flatMap((b) => [b.start, b.end]).filter((x) => x != null).sort((a, b) => b - a);
  for (const pos of at) tr.delete(pos, pos + 1);
}

/** Adds bookmark `name` around `range` ({from, to}; the selection by default) in a transaction of `state`; an existing bookmark of
 * that name moves there (Word's Add). → the transaction. */
export function bookmarkTr(state, name, range = state.selection) {
  const tr = state.tr;
  dropNamed(tr, name);
  let from = inlineAt(tr.doc, tr.mapping.map(range.from, -1), 1);
  let to = inlineAt(tr.doc, tr.mapping.map(range.to, 1), -1);
  if (to < from) to = from;
  const id = newBookmarkId(tr.doc);
  const type = state.schema.nodes.bookmark;
  tr.insert(to, type.create({ name, id, end: true }));
  tr.insert(from, type.create({ name, id, end: false }));
  return tr;
}

/** Adds (or moves) bookmark `name` around the selection of `editor`. */
export function addBookmark(editor, name, range) {
  editor.view.dispatch(closeHistory(bookmarkTr(editor.state, name, range)));
  return true;
}

/** Deletes bookmark `name` (its text stays). */
export function deleteBookmark(editor, name) {
  const tr = editor.state.tr;
  dropNamed(tr, name);
  if (tr.docChanged) editor.view.dispatch(tr);
  return tr.docChanged;
}

/** The name of a hidden _Ref bookmark around `range`, adding one when none wraps exactly that range. Word reuses one already there. */
export function ensureRef(editor, range) {
  const have = refAround(bookmarksOf(editor.state.doc), range);
  if (have) return have;
  const name = refName(editor.state.doc);
  editor.view.dispatch(bookmarkTr(editor.state, name, range));
  return name;
}

// ---------- going to places ----------
const selectionOf = (state) => ({ anchor: state.selection.anchor, head: state.selection.head });

/** Selects `from`..`to` in `editor`, scrolled into view; `push` keeps the old place on the back stack (Alt+Left returns); `focus`
 * false leaves the focus where it is (a dialog's Go To keeps it in the dialog, as Word's does). */
function select(editor, from, to, push, focus = true) {
  const { state } = editor;
  const max = state.doc.content.size;
  const sel = TextSelection.between(state.doc.resolve(Math.min(from, max)), state.doc.resolve(Math.min(to, max)));
  const tr = state.tr.setSelection(sel).scrollIntoView();
  if (push) tr.setMeta(fieldsRefKey, { push: selectionOf(state) });
  editor.view.dispatch(tr);
  if (focus) editor.view.focus();
  return true;
}

/** Goes to bookmark `name` (or "_top", the start of the document): selects its range. → false when it is not defined. */
export function goToPlace(editor, name, { push = false, focus = true } = {}) {
  if (String(name).toLowerCase() === '_top') return select(editor, 1, 1, push, focus);
  const b = bookmarkNamed(editor.state.doc, name);
  if (!b) return false;
  return select(editor, b.from, b.to, push, focus);
}

/** Goes to a GOTOBUTTON destination: a bookmark, or a Go To code (p N page, s N section, l N line, f N footnote, e N endnote, a N
 * comment), Word's Go To. Codes for parts this package does not draw go to the nearest place it knows (recorded). */
export function goToDestination(editor, dest, geometry) {
  if (goToPlace(editor, dest, { push: true })) return true;
  const m = /^([pslfea])\s*(\d+)$/i.exec(String(dest).trim());
  if (!m) return false;
  const n = Number(m[2]);
  const kind = m[1].toLowerCase();
  const { doc } = editor.state;
  if (kind === 'p' && geometry?.pages?.length) {
    const page = geometry.pages.find((p) => p.number === n) ?? geometry.pages[Math.min(n, geometry.pages.length) - 1];
    return select(editor, page.from + 1, page.from + 1, true);
  }
  if (kind === 's' && geometry?.sections?.length) {
    const s = geometry.sections[Math.min(n, geometry.sections.length) - 1];
    return select(editor, s.from + 1, s.from + 1, true);
  }
  // Footnote, endnote and comment numbers count their anchors in document order; l N counts paragraphs (Word counts lines).
  const want = { f: 'footnote', e: 'endnote' }[kind];
  let hit = null;
  let k = 0;
  doc.descendants((node, pos) => {
    if (hit != null) return false;
    if (kind === 'l' && node.isTextblock) {
      if (++k === n) hit = pos + 1;
      return false;
    }
    if (want && node.type.name === 'noteRef' && (node.attrs.kind === 'endnote' ? 'endnote' : 'footnote') === want && ++k === n) hit = pos;
    if (kind === 'a' && node.isInline && node.marks.some((x) => x.type.name === 'comment') && ++k === n) hit = pos;
    return true;
  });
  return hit == null ? false : select(editor, hit, hit, true);
}

/** Selects the field node at `pos` whole, so typing replaces it (a MACROBUTTON's NoMacro placeholder). */
export function selectField(view, pos) {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  return true;
}

/** Follows link attributes `link` ({href, anchor}) from `editor`: a place in the document goes there (back stack), a web address
 * opens in the app's browser pane. */
export function follow(editor, { href, anchor } = {}) {
  const place = anchor ?? (href?.startsWith('#') ? safeDecode(href.slice(1)) : null);
  if (place != null) {
    if (!goToPlace(editor, place, { push: true })) toast(`This document has no bookmark named ${place}.`);
    return true;
  }
  if (/^https?:/i.test(href ?? '')) {
    openPane(null, href);
    return true;
  }
  // E-mail and file links need the main process to hand them to another app, which it does not do yet (recorded).
  if (href) toast(/^mailto:/i.test(href) ? 'E-mail links cannot open from here yet.' : 'Links to files cannot open from here yet.');
  return !!href;
}

/** Web Go Back (dir -1) or Web Go Forward (+1): the place before or after the last followed link. → false when there is none. */
export function webGo(editor, dir) {
  const st = fieldsRefKey.getState(editor.state);
  const stack = dir < 0 ? st?.back : st?.fwd;
  if (!stack?.length) return false;
  const to = stack.at(-1);
  const tr = editor.state.tr.setMeta(fieldsRefKey, { [dir < 0 ? 'back' : 'fwd']: true, here: selectionOf(editor.state) });
  tr.setSelection(TextSelection.create(tr.doc, to.anchor, to.head)).scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** The link stack plugin state: {back, fwd} of {anchor, head}, mapped through every transaction. */
export const stackState = {
  init: () => ({ back: [], fwd: [] }),
  apply(tr, st) {
    const map = (list) => list.map(({ anchor, head }) => ({ anchor: tr.mapping.map(anchor), head: tr.mapping.map(head) }));
    let { back, fwd } = tr.docChanged ? { back: map(st.back), fwd: map(st.fwd) } : st;
    const m = tr.getMeta(fieldsRefKey);
    if (m?.push) return { back: [...back, m.push].slice(-50), fwd: [] };
    if (m?.back) return { back: back.slice(0, -1), fwd: [...fwd, m.here] };
    if (m?.fwd) return { back: [...back, m.here], fwd: fwd.slice(0, -1) };
    return back === st.back && fwd === st.fwd ? st : { back, fwd };
  },
};

// The Navigation pane's editor side: the search hits it highlights (its own decorations, so Find Options apply before find.js
// reads them) and collapsible headings (a triangle in the left margin of every heading; collapsed sections are hidden with node
// decorations, kept per session and mapped through transactions, starting from each paragraph's collapsed attribute).
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findMatches } from '../../../find.js';
import { collapsedRanges, headingsOf, hiddenAt, levelOf, sectionRange } from './headings.mjs';
import { narrow, objectHits } from './results.mjs';

export const navKey = new PluginKey('navpane');

const EMPTY = { collapsed: [], folded: [], hidden: [], query: '', opts: {}, kind: null, highlight: true, matches: [], index: 0 };

const initialCollapsed = (doc) => headingsOf(doc).filter((h) => h.collapsed).map((h) => h.pos);

// A transaction that swaps the whole document (opening a draft, setContent) starts over from the collapsed attributes.
const replacedAll = (tr) => tr.steps.length === 1 && tr.steps[0].from === 0 && tr.steps[0].to === tr.before.content.size;

function hitsOf(doc, s) {
  if (s.kind) return objectHits(doc, s.kind).filter((m) => !hiddenAt(s.hidden, m.from));
  if (!s.query) return [];
  return narrow(doc, findMatches(doc, s.query, { ...s.opts, codes: true }), s.query, s.opts, s.hidden);
}

/** The collapsed headings `collapsed` minus those whose hidden part holds `head` (the caret is never hidden). */
function uncover(doc, collapsed, head) {
  return collapsed.filter((p) => {
    const r = sectionRange(doc, p);
    return !r || head < p + doc.nodeAt(p).nodeSize || head >= r.to;
  });
}

function apply(tr, prev, _old, state) {
  const meta = tr.getMeta(navKey);
  if (!meta && !tr.docChanged && !tr.selectionSet) return prev;
  const { doc } = state;
  const head = state.selection.head;
  // Heading positions through the change, dropping those deleted or no longer headings.
  const remap = (list) => list.map((p) => tr.mapping.mapResult(p, 1)).filter((r) => !r.deletedAfter).map((r) => r.pos)
    .filter((p) => { const n = doc.nodeAt(p); return n && levelOf(doc, n); });
  let collapsed = prev.collapsed;
  let folded = prev.folded;
  if (replacedAll(tr)) {
    collapsed = initialCollapsed(doc);
    folded = [];
  } else if (tr.docChanged) {
    collapsed = remap(collapsed);
    folded = remap(folded);
  }
  if (meta?.collapsed) collapsed = meta.collapsed;
  if (meta?.folded) folded = meta.folded;
  if (meta?.toggle != null) collapsed = collapsed.includes(meta.toggle) ? collapsed.filter((p) => p !== meta.toggle) : [...collapsed, meta.toggle];
  let hidden = collapsed === prev.collapsed && !tr.docChanged ? prev.hidden : collapsedRanges(doc, collapsed);
  if (hiddenAt(hidden, head)) {
    collapsed = uncover(doc, collapsed, head);
    hidden = collapsedRanges(doc, collapsed);
  }
  if (!meta && !tr.docChanged && hidden === prev.hidden) return prev; // a caret move that uncovered nothing
  const next = { ...prev, ...(meta?.search ?? {}), collapsed, folded, hidden };
  if (meta?.search || tr.docChanged || hidden !== prev.hidden) next.matches = hitsOf(doc, next);
  const first = Math.max(0, next.matches.findIndex((m) => m.from >= state.selection.from));
  next.index = Math.max(0, Math.min(meta?.index ?? (meta?.search ? first : prev.index), next.matches.length - 1));
  return next;
}

/** The plugin state → {collapsed, folded (the Headings tab's folded branches), hidden, query, opts, kind, highlight, matches, index}. */
export const navState = (state) => navKey.getState(state) ?? EMPTY;

/** A transaction toggling the heading at `pos`; collapsing it with the caret in its hidden part moves the caret to the heading's
 * end first, as Word does (the caret is never hidden). */
function toggleTr(state, pos) {
  const tr = state.tr.setMeta(navKey, { toggle: pos });
  if (navState(state).collapsed.includes(pos)) return tr;
  const r = sectionRange(state.doc, pos);
  const end = pos + state.doc.nodeAt(pos).nodeSize;
  const { head } = state.selection;
  if (r && head >= end && head < r.to) tr.setSelection(TextSelection.create(tr.doc, end - 1));
  return tr;
}

function twisty(collapsed) {
  return (view, getPos) => {
    const el = document.createElement('span');
    el.contentEditable = 'false';
    el.dataset.navTwisty = '';
    if (collapsed) el.dataset.collapsed = '';
    el.setAttribute('aria-label', collapsed ? 'Expand heading' : 'Collapse heading');
    el.title = collapsed ? 'Expand' : 'Collapse';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = getPos();
      if (pos != null) view.dispatch(toggleTr(view.state, pos - 1));
    });
    return el;
  };
}

const decoMemo = new WeakMap();
function decorations(state) {
  const s = navState(state);
  let set = decoMemo.get(s);
  if (set && set.doc === state.doc) return set.decos;
  const { doc } = state;
  const out = [];
  for (const h of headingsOf(doc)) {
    const c = s.collapsed.includes(h.pos);
    out.push(Decoration.widget(h.pos + 1, twisty(c), { side: -1, ignoreSelection: true, key: c ? 'nav-tw-c' : 'nav-tw-e' }));
  }
  for (const r of s.hidden) doc.nodesBetween(r.from, r.to, (n, pos) => {
    if (pos >= r.from) out.push(Decoration.node(pos, pos + n.nodeSize, { style: 'display: none', 'data-nav-hidden': '' }));
    return false;
  });
  s.matches.forEach((m, i) => {
    if (!s.highlight && i !== s.index) return;
    const cls = i === s.index ? 'find-match find-current' : 'find-match';
    const node = doc.nodeAt(m.from);
    if (node && !node.isText && m.to - m.from === node.nodeSize) out.push(Decoration.node(m.from, m.to, { class: cls, 'data-nav-hit': '' }));
    else out.push(Decoration.inline(m.from, m.to, { class: cls }));
  });
  const decos = DecorationSet.create(doc, out);
  decoMemo.set(s, { doc, decos });
  return decos;
}

/** The collapsible headings and the pane's search highlights in every editor of the Document kit; story editors (headers, notes)
 * get neither. */
export const NavPaneText = Extension.create({
  name: 'navPaneText',
  addProseMirrorPlugins() {
    // mountStory marks a story editor in its editorProps, known before the view draws its first decorations.
    const story = !!this.editor?.options.editorProps?.attributes?.['data-story'];
    return [new Plugin({
      key: navKey,
      state: { init: (_, state) => ({ ...EMPTY, collapsed: initialCollapsed(state.doc), hidden: collapsedRanges(state.doc, initialCollapsed(state.doc)) }), apply },
      props: { decorations: (state) => (story ? null : decorations(state)) },
    })];
  },
});

// ---------------------------------------------------------------------------------------------
// Actions on a view

/** Searches: {query, opts, highlight} for text or {kind} for the search menu's objects; an empty query clears. */
export const search = (view, s) => view.dispatch(view.state.tr.setMeta(navKey, { search: { query: '', kind: null, ...s } }));

/** Scrolls `pos` into the middle of the page's viewport when it is out of view (by hand: the page's CSS zoom misleads
 * scrollIntoView). */
export function reveal(view, pos) {
  const area = view.dom.closest('[data-viewport]');
  if (!area) return;
  let c;
  try { c = view.coordsAtPos(pos); } catch { return; }
  const v = area.getBoundingClientRect();
  if (c.top < v.top + 40 || c.bottom > v.bottom - 40) area.scrollTop += c.top - v.top - v.height / 2;
}

/** Makes hit `index` current and selects it in the text (the focus stays where it is). */
export function select(view, index) {
  const { matches } = navState(view.state);
  const m = matches[index];
  if (!m) return;
  const { doc } = view.state;
  const node = doc.nodeAt(m.from);
  const sel = node && !node.isText && m.to - m.from === node.nodeSize && NodeSelection.isSelectable(node)
    ? NodeSelection.create(doc, m.from) : TextSelection.create(doc, m.from, m.to);
  view.dispatch(view.state.tr.setSelection(sel).setMeta(navKey, { index }));
  reveal(view, m.from);
}

/** The next hit (`dir` 1) or the previous one (-1), wrapping around. */
export function step(view, dir) {
  const { matches, index } = navState(view.state);
  if (matches.length) select(view, (index + dir + matches.length) % matches.length);
}

/** The heading block holding the selection → its position, or null in body text. */
export function headingAtCaret(state) {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  const pos = $from.before(1);
  return levelOf(state.doc, state.doc.nodeAt(pos)) ? pos : null;
}

/** Expands ('expand'), collapses ('collapse') or toggles the heading at `pos` in the text → false when there is no heading. */
export function setCollapsed(view, pos, op) {
  if (pos == null) return false;
  const { collapsed } = navState(view.state);
  const has = collapsed.includes(pos);
  const want = op === 'toggle' ? !has : op === 'collapse';
  if (want !== has) view.dispatch(toggleTr(view.state, pos));
  return true;
}

/** Sets the Headings tab's folded branches to the heading positions `folded`. */
export const setFolded = (view, folded) => view.dispatch(view.state.tr.setMeta(navKey, { folded }));

/** Collapses every heading (true) or expands them all (false). */
export function setAllCollapsed(view, on) {
  view.dispatch(view.state.tr.setMeta(navKey, { collapsed: on ? headingsOf(view.state.doc).map((h) => h.pos) : [] }));
}

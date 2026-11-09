// Newspaper columns, the pure part (docs/plans/word/briefs/columns.md): presets, limits, the More Columns dialog's arithmetic,
// the balance rule, Apply to scopes, and the transform that wraps blocks in columns nodes and unwraps them. Lengths are points.
// No DOM: index.js and pagination.js call these; node tests load this file.
import { TextSelection } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import { sectionAt, sectionsOf } from '../../model/sections.mjs';
import { startOf } from '../page-engine/layout.mjs';
import { colBoxes, columnWidthOf, SPACE } from '../../layout/width.mjs';

// The widths are pure page setup arithmetic (layout/width.mjs), shared with the layout predictor's worker.
export { colBoxes, SPACE };

/** Word's narrowest column and its largest column count (index-layout.md 187-189); SPACE is its default spacing. */
export const MIN_COL = 36;
export const MAX_COLS = 45;
export const MAX_SPACE = 1584;
/** The narrow column of the Left and Right presets: about 30 percent of the two columns' combined width (v). */
const NARROW = 0.3;

const r2 = (v) => Math.round(v * 100) / 100;
const sum = (a) => a.reduce((s, v) => s + v, 0);

/** The most columns `text` points hold: one per 36 pt, never more than 45. */
export const maxColumns = (text) => Math.max(1, Math.min(MAX_COLS, Math.floor(text / MIN_COL + 1e-9)));

/** Why `n` columns cannot go in `text` points, in our words, or null. */
export const countError = (n, text) => (Number.isInteger(n) && n >= 1 && n <= maxColumns(text) ? null
  : `Enter a number of columns from 1 to ${maxColumns(text)}.`);

/** `n` equal columns across `text` with `space` between them → [{w, space}]; the last column's space is 0. Word narrows the
 * spacing when n columns of at least 36 pt do not fit with it. */
export function equalCols(text, n, space = SPACE) {
  const s = n > 1 ? Math.max(0, Math.min(space, MAX_SPACE, (text - n * MIN_COL) / (n - 1))) : space;
  const w = r2((text - (n - 1) * s) / n);
  return Array.from({ length: n }, (_, i) => ({ w, space: i < n - 1 ? r2(s) : 0 }));
}

/** A columns node's attributes for preset `id` ('one' → null, 'two', 'three', 'left', 'right') across `text` points. */
export function preset(id, text) {
  if (id === 'one') return null;
  if (id === 'two' || id === 'three') {
    // A narrow text width narrows the spacing as Word does (equalCols), or drops columns that cannot be 36 pt wide.
    const count = Math.min(id === 'two' ? 2 : 3, maxColumns(text));
    return count < 2 ? null : { count, space: equalCols(text, count)[0].space, equal: true, widths: null };
  }
  if (id !== 'left' && id !== 'right') return undefined;
  const narrow = r2((text - SPACE) * NARROW);
  const wide = r2(text - SPACE - narrow);
  const widths = id === 'left' ? [{ w: narrow, space: SPACE }, { w: wide, space: 0 }] : [{ w: wide, space: SPACE }, { w: narrow, space: 0 }];
  return { count: 2, space: SPACE, equal: false, widths };
}

/** The preset a columns node's `attrs` show as (null attrs: 'one'), or null for a custom layout. */
export function presetOf(attrs) {
  if (!attrs) return 'one';
  if (attrs.equal !== false || !attrs.widths) return attrs.count === 2 ? 'two' : attrs.count === 3 ? 'three' : null;
  const [a, b] = attrs.widths;
  if (attrs.count !== 2 || !b) return null;
  return a.w < b.w ? 'left' : a.w > b.w ? 'right' : null;
}

// ---------- the More Columns dialog ----------
// Its state: {count, sep, equal, cols: [{w, space}] (every column, drawn in the Width and spacing rows)}.

/** The dialog's state for a columns node's `attrs` (null: one column) across `text` points. */
export function stateOf(attrs, text) {
  if (!attrs) return { count: 1, sep: false, equal: true, cols: equalCols(text, 1) };
  const cols = attrs.equal === false && attrs.widths?.length === attrs.count ? attrs.widths.map((c) => ({ ...c }))
    : equalCols(text, attrs.count, attrs.space ?? SPACE);
  return { count: attrs.count, sep: !!attrs.sep, equal: attrs.equal !== false, cols };
}

/** The node attributes the dialog's state `st` gives (null: one column). */
export const attrsOf = (st) => (st.count <= 1 ? null : {
  count: st.count, space: st.cols[0].space, sep: !!st.sep, equal: !!st.equal, widths: st.equal ? null : st.cols.map((c) => ({ ...c })),
});

/** The state with `n` columns: equal columns at the current spacing (Word starts unequal layouts over the same way). */
export function setCount(st, n, text) {
  const count = Math.max(1, Math.min(maxColumns(text), Math.round(n) || 1));
  return { ...st, count, sep: count > 1 && st.sep, cols: equalCols(text, count, st.cols[0]?.space || SPACE) };
}

/** Sets column `i`'s `key` ('w' or 'space') to `v`: equal columns all follow column 1; unequal ones give the difference to the last
 * column (to the one before it when the last changes), never leaving it under 36 pt. */
function setCol(st, i, key, v, text) {
  const n = st.count;
  if (st.equal) {
    const space = key === 'space' ? v : n > 1 ? (text - n * v) / (n - 1) : 0;
    return { ...st, cols: equalCols(text, n, Math.max(0, space)) };
  }
  const cols = st.cols.map((c) => ({ ...c }));
  const j = i === n - 1 ? n - 2 : n - 1;
  if (j < 0) return st;
  cols[i][key] = Math.max(key === 'w' ? MIN_COL : 0, v);
  const rest = () => text - sum(cols.map((c, k) => (k === j ? 0 : c.w))) - sum(cols.slice(0, -1).map((c) => c.space));
  const short = MIN_COL - rest();
  if (short > 0) cols[i][key] = Math.max(0, cols[i][key] - short);
  cols[j].w = r2(rest());
  cols[i][key] = r2(cols[i][key]);
  return { ...st, cols };
}
export const setWidth = (st, i, w, text) => setCol(st, i, 'w', w, text);
export const setSpace = (st, i, s, text) => setCol(st, i, 'space', Math.min(MAX_SPACE, s), text);

/** Equal column width on: equal columns at column 1's spacing; off: the columns as drawn, each editable. */
export const setEqual = (st, on, text) => ({ ...st, equal: !!on, cols: on ? equalCols(text, st.count, st.cols[0]?.space || SPACE) : st.cols });

// ---------- balancing ----------

const isEmptyDefault = (n) => n.type === n.type.schema.topNodeType.contentMatch.defaultType && !n.content.size;

/** How the columns node at top-level index `i` of `doc` fills its last page: 'balance' when more text follows it on that page (Word's
 * continuous break, index-layout.md 176), else 'fill' (column 1 first): at the document's end, or before a page break, a column break
 * in one column or a section break that starts a page. */
export function fillOf(doc, i) {
  // Empty default paragraphs at the end (TrailingNode's, as suggest/core.mjs reads them) are the document's end.
  let end = true;
  for (let k = i + 1; end && k < doc.childCount; k++) end = isEmptyDefault(doc.child(k));
  if (end) return 'fill';
  const next = doc.child(i + 1);
  if (next.type.name === 'pageBreak' || next.type.name === 'columnBreak') return 'fill';
  if (next.type.name !== 'sectionBreak') return 'balance';
  let pos = 0;
  for (let k = 0; k <= i; k++) pos += doc.child(k).nodeSize;
  const secs = sectionsOf(doc);
  const s = sectionAt(secs, pos);
  return startOf(next.attrs.kind, s.sect, secs[s.index + 1]?.sect) === 'none' ? 'balance' : 'fill';
}

// ---------- Apply to and the transform ----------

/** The blocks columns apply to, in order: each top-level block, or each block of a columns node with that node's attrs →
 * [{node, pos, top (top-level index), cols (attrs or null)}]. */
export function unitsOf(doc) {
  const out = [];
  doc.forEach((node, pos, top) => {
    if (node.type.name !== 'columns') return void out.push({ node, pos, top, cols: null });
    node.forEach((child, off) => out.push({ node: child, pos: pos + 1 + off, top, cols: node.attrs }));
  });
  return out;
}

/** The Apply to choices for the selection `sel` in `doc` ([[value, label]], the default first): Selected text or Selected sections
 * with a selection, else This section with several sections or Whole document with one, and This point forward (index-layout.md 186). */
export function applyToOptions(doc, sel) {
  const secs = sectionsOf(doc);
  const many = sectionAt(secs, sel.from).index !== sectionAt(secs, sel.to).index;
  if (!sel.empty) return [many ? ['sections', 'Selected sections'] : ['selected', 'Selected text'], ['whole', 'Whole document']];
  return secs.length > 1 ? [['section', 'This section'], ['forward', 'This point forward'], ['whole', 'Whole document']]
    : [['whole', 'Whole document'], ['forward', 'This point forward']];
}

/** The units `scope` covers for selection `sel` → [first, last] indices into `units` (unitsOf), or null. */
export function scopeOf(doc, units, sel, scope) {
  const at = (pos) => {
    const i = units.findIndex((u) => pos < u.pos + u.node.nodeSize);
    return i < 0 ? units.length - 1 : i;
  };
  const secs = sectionsOf(doc);
  const within = (from, to) => {
    const a = units.findIndex((u) => u.pos >= from);
    let b = units.findLastIndex((u) => u.pos < to);
    return a < 0 || b < a ? null : [a, b];
  };
  if (scope === 'whole') return units.length ? [0, units.length - 1] : null;
  if (scope === 'selected') return [at(sel.from), sel.empty ? at(sel.from) : at(Math.max(sel.from, sel.to - 1))];
  const s = sectionAt(secs, sel.from);
  if (scope === 'section') return within(s.from, s.to);
  if (scope === 'sections') return within(s.from, sectionAt(secs, sel.to).to);
  if (scope === 'forward') {
    const r = within(s.from, s.to);
    return r && [Math.max(r[0], at(sel.from)), r[1]];
  }
  return null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Sets the columns of units [a, b] (unitsOf) to `attrs` (null: one column) in `tr`: every columns node they touch is rebuilt, the
 * other blocks in it keeping their own layout; neighbouring blocks with equal layouts share one columns node; section breaks and
 * blocks a columns node cannot hold stay outside. A layout patches the attrs a block had ({...old, ...attrs}). `newColumn` (Start
 * new column) puts a column break before unit a, joining the columns node before it when that has the same layout. Keeps the
 * selection on the same text. → true when it changed tr. */
export function applyColumns(tr, a, b, attrs, { newColumn = false } = {}) {
  const { doc } = tr;
  const schema = doc.type.schema;
  const colsType = schema.nodes.columns;
  const units = unitsOf(doc);
  if (!units.length || a > b) return false;
  const patch = (u) => (attrs ? { ...colsType.create(null, schema.nodes.paragraph.create()).attrs, ...(u.cols ?? {}), ...attrs } : null);
  let t0 = units[a].top;
  const t1 = units[b].top;
  const firstNew = patch(units[a]);
  if (newColumn && a > 0 && attrs && same(units[a - 1].cols, firstNew)) t0 = units[a - 1].top;
  const lo = units.findIndex((u) => u.top === t0);
  const hi = units.findLastIndex((u) => u.top === t1);
  const want = [];
  for (let k = lo; k <= hi; k++) {
    const u = units[k];
    const cols = k >= a && k <= b ? patch(u) : u.cols;
    if (k === a && newColumn && attrs) want.push({ node: schema.nodes.columnBreak.create(), cols, k: -1 });
    want.push({ node: u.node, cols, k });
  }
  // Groups of neighbours with one layout, each a columns node; a column break never starts one.
  const out = [];
  const where = new Map(); // unit index → offset of its node in the new content
  let size = 0;
  let group = null;
  const flush = () => {
    if (!group) return;
    const kids = group.items.filter((w, i) => i > 0 || w.node.type.name !== 'columnBreak');
    if (kids.length) {
      let off = size + 1;
      for (const w of kids) {
        if (w.k >= 0) where.set(w.k, off);
        off += w.node.nodeSize;
      }
      const node = colsType.create(group.cols, kids.map((w) => w.node));
      out.push(node);
      size += node.nodeSize;
    }
    group = null;
  };
  for (const w of want) {
    const fits = w.cols && colsType.contentMatch.matchType(w.node.type);
    if (fits && group && same(group.cols, w.cols)) {
      group.items.push(w);
      continue;
    }
    flush();
    if (fits) group = { cols: w.cols, items: [w] };
    else if (w.k >= 0 || w.node.type.name !== 'columnBreak') {
      if (w.k >= 0) where.set(w.k, size);
      out.push(w.node);
      size += w.node.nodeSize;
    }
  }
  flush();
  const from = units[lo].pos - (units[lo].cols ? 1 : 0);
  const end = units[hi].pos + units[hi].node.nodeSize + (units[hi].cols ? 1 : 0);
  const old = Fragment.from(doc.slice(from, end).content);
  const next = Fragment.from(out);
  if (old.eq(next)) return false;
  // The selection's ends stay in their units at the same offset.
  const keep = (pos) => {
    const k = units.findIndex((u, i) => i >= lo && i <= hi && pos >= u.pos && pos <= u.pos + u.node.nodeSize);
    return k < 0 ? null : from + where.get(k) + (pos - units[k].pos);
  };
  const { anchor, head } = tr.selection;
  const [na, nh] = [keep(anchor), keep(head)];
  tr.replaceWith(from, end, next);
  if (na != null && nh != null) {
    try {
      tr.setSelection(TextSelection.between(tr.doc.resolve(na), tr.doc.resolve(nh)));
    } catch { /* the old selection stays mapped */ }
  }
  return true;
}

/** Inserts a column break at the caret in `tr` (Ctrl+Shift+Enter, Breaks > Column): the text after the caret goes to the next column
 * (the next page in one column); at a paragraph's start the break goes before it. Only in top-level text or a columns node's
 * (lists are top-level paragraphs here, and there are no quotes). → false elsewhere (a table, a text box, a block content control
 * or field, across blocks): recorded limit, Word breaks there too. */
export function insertColumnBreak(tr) {
  const { $from, $to } = tr.selection;
  const d = $from.depth;
  if (!$from.parent.isTextblock || !$from.sameParent($to) || !(d === 1 || (d === 2 && $from.node(1).type.name === 'columns'))) return false;
  tr.deleteSelection();
  const $p = tr.selection.$from;
  const end = $p.parentOffset === $p.parent.content.size;
  const types = end ? [{ type: $p.parent.type, attrs: { ...$p.parent.attrs, suggest: null } }] : undefined;
  const at = $p.parentOffset === 0 ? $p.before() : (tr.split($p.pos, 1, types), $p.pos + 1);
  const br = tr.doc.type.schema.nodes.columnBreak.create();
  tr.insert(at, br);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + br.nodeSize)));
  return true;
}

/** The columns attrs at resolved position `$p` (inside a columns node or one of its blocks), or null. */
const colsOf = ($p) => ($p.depth && $p.node(1).type.name === 'columns' ? $p.node(1).attrs : null);

/** The width (px) of the text column at `pos` in a Document's `doc`, from its page setup: the paper of the section holding `pos`
 * minus its left and right margins and a gutter at the side (paperOf), or one column's width inside newspaper columns, where Word
 * fits an object to the column. */
export function columnWidthAt(doc, pos) {
  const $p = doc.resolve(Math.min(pos, doc.content.size));
  return columnWidthOf(sectionAt(sectionsOf(doc), pos).sect, doc.attrs.settings, colsOf($p));
}

// ---------- objects in columns ----------

/** The depth of the text flow's blocks at `$p`: 2 inside newspaper columns, else 1 (the top level). An object inserted at the
 * caret goes before or after the block at this depth, so in columns it stays in the column holding the caret, as in Word, and
 * takes that column's width (columnWidthAt). Any format: a doc without columns always gives 1. */
export const flowDepth = ($p) => (colsOf($p) ? 2 : 1);

/** The position after (or, with `before`, before) the text flow's block holding `$p` (flowDepth); `$p.pos` itself when it lies
 * between the flow's blocks. */
export function flowPos($p, before = false) {
  const d = flowDepth($p);
  return $p.depth < d ? $p.pos : before ? $p.before(d) : $p.after(d);
}

const colsAt = new WeakMap(); // doc → Map pos → the attrs of the columns holding it: float layout asks per float and frame, and each
// resolve scans the top-level blocks from the start

/** The newspaper column an object anchored at `pos` in `doc` sits in → {left, width} px from the text's left edge, or null outside
 * columns. Which column holds the anchor is where the text flowed, so the caller passes its block's horizontal midpoint `x` (px
 * from the text's left): a paragraph outdented into the gap starts left of its column but its middle stays in it. The boxes come
 * from the page setup (colBoxes). Float layout measures an object's column-relative position from it. */
export function columnBoxAt(doc, pos, x) {
  let known = colsAt.get(doc);
  if (!known) colsAt.set(doc, (known = new Map()));
  if (!known.has(pos)) known.set(pos, colsOf(doc.resolve(Math.min(pos, doc.content.size))) ?? null);
  const cols = known.get(pos);
  if (!cols) return null;
  const boxes = colBoxes(cols, columnWidthOf(sectionAt(sectionsOf(doc), pos).sect, doc.attrs.settings));
  return boxes.findLast((b) => b.left <= x) ?? boxes[0];
}

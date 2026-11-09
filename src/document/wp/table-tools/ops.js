// Table tools' document changes (docs/plans/word/plan.md §3 table-tools): Insert Table and Convert Text to Table, the cell moves,
// row moves, Split Table, Update Table Style, and Draw Table's and Eraser's edits through tables.mjs's grid model. Each takes an
// EditorState (or a transaction) and works on the innermost table around the selection, so nested tables behave like any other.
import { Fragment } from '@tiptap/pm/model';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { cellNav, cellRanges, moveRows } from './tables.mjs';

// ---------- finding things ----------
/** The innermost table around `$pos` → {node, pos (before it), depth} or null. */
export function tableOf($pos) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'table') return { node: $pos.node(d), pos: $pos.before(d), depth: d };
  return null;
}

/** The selection's table and its current cell: {t, map, anchor, head} with anchor and head as table-relative cell positions. */
function cellsOf(state) {
  const sel = state.selection;
  const t = tableOf(sel instanceof CellSelection ? sel.$headCell : sel.$from);
  if (!t) return null;
  const rel = ($p) => ($p.depth >= t.depth + 2 && $p.node(t.depth) === t.node ? $p.before(t.depth + 2) - t.pos - 1 : null);
  const head = sel instanceof CellSelection ? sel.$headCell.pos - t.pos - 1 : rel(sel.$head);
  const anchor = sel instanceof CellSelection ? sel.$anchorCell.pos - t.pos - 1 : rel(sel.$anchor) ?? head;
  return head == null ? null : { t, map: TableMap.get(t.node), anchor, head };
}

/** The rows of `map` as cell positions (a spanning cell repeats). */
const gridOf = (map) => Array.from({ length: map.height }, (_, r) => map.map.slice(r * map.width, (r + 1) * map.width));

// ---------- cell moves (Alt+Home, Alt+End, Alt+PageUp, Alt+PageDown) ----------
/** Moves the caret to the cell `where` ('rowStart' | 'rowEnd' | 'colStart' | 'colEnd') of the current row or column; `extend`
 * selects the cells from the anchor's to it instead. → a transaction or null. */
export function cellMove(state, where, extend = false) {
  const at = cellsOf(state);
  if (!at) return null;
  const { t, map } = at;
  const { left, top } = map.findCell(at.head);
  const to = cellNav(gridOf(map), top, left, where);
  const rel = map.map[to.r * map.width + to.c];
  const start = t.pos + 1;
  const sel = extend ? CellSelection.create(state.doc, start + at.anchor, start + rel) : Selection.near(state.doc.resolve(start + rel + 1));
  return state.tr.setSelection(sel).scrollIntoView();
}

/** Selects the whole content of the cell holding the selection's head (Tab and Shift+Tab land like this). → whether it did. */
export function selectCellContent(tr) {
  const t = tableOf(tr.selection.$head);
  if (!t) return false;
  const $h = tr.selection.$head;
  const d = t.depth + 2;
  const cell = $h.before(d);
  const node = $h.node(d);
  tr.setSelection(TextSelection.between(tr.doc.resolve(cell + 1), tr.doc.resolve(cell + node.nodeSize - 1), 1));
  return true;
}

// ---------- rows ----------
/** The selection's row range in its table → {t, from, to}. */
function rowsOf(state) {
  const at = cellsOf(state);
  if (!at) return null;
  const a = at.map.findCell(at.anchor);
  const h = at.map.findCell(at.head);
  return { t: at.t, map: at.map, from: Math.min(a.top, h.top), to: Math.max(a.bottom, h.bottom) - 1 };
}

const rowStart = (table, i) => {
  let p = 0;
  for (let r = 0; r < i; r++) p += table.child(r).nodeSize;
  return p;
};

/** Moves the selected rows (or the caret's row) one place `dir` ('up' | 'down'); the selection moves with them. → a transaction,
 * or null at the table's edge or across a cell spanning rows. */
export function moveRow(state, dir) {
  const rows = rowsOf(state);
  if (!rows) return null;
  const { t, map, from, to } = rows;
  const order = moveRows(t.node.childCount, from, to, dir, gridOf(map));
  if (!order) return null;
  const next = t.node.copy(Fragment.from(order.map((i) => t.node.child(i))));
  const delta = rowStart(next, order.indexOf(from)) - rowStart(t.node, from);
  const tr = state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, next);
  // The moved rows keep their order inside the block, so every position in them shifts by one amount.
  const sel = state.selection;
  const shift = (p) => tr.doc.resolve(p + delta);
  tr.setSelection(sel instanceof CellSelection ? new CellSelection(shift(sel.$anchorCell.pos), shift(sel.$headCell.pos))
    : TextSelection.between(shift(sel.anchor), shift(sel.head)));
  return tr.scrollIntoView();
}

/** Whether the selected rows already sit at the table's edge in direction `dir`, which tells that refusal from a spanning cell's. */
export function rowAtEdge(state, dir) {
  const rows = rowsOf(state);
  return !rows || (dir === 'up' ? rows.from === 0 : rows.to === rows.map.height - 1);
}

/** Word's Ctrl+Shift+Enter: splits the table above the caret's row with an empty paragraph between (in the first row, a paragraph
 * goes above the table). With `brk` (a page break node, Word's Ctrl+Enter in a cell) that node goes between instead and the caret
 * stays in its column on the second table's first row. → a transaction, or null when a cell spans across that row's top. */
export function splitTable(state, brk = null) {
  const rows = rowsOf(state);
  if (!rows) return null;
  const { t, map } = rows;
  const { top: r, left: c } = map.findCell(cellsOf(state).head);
  const mid = brk ?? state.schema.nodes.paragraph.create();
  const tr = state.tr;
  let second = t.pos + mid.nodeSize; // where the table holding the caret's row starts afterwards
  if (r === 0) tr.insert(t.pos, mid);
  else {
    if (gridOf(map)[r].some((cell, col) => cell === map.map[(r - 1) * map.width + col])) return null;
    const rowsOfNode = [...Array(t.node.childCount).keys()].map((i) => t.node.child(i));
    const parts = [t.node.copy(Fragment.from(rowsOfNode.slice(0, r))), mid, t.node.copy(Fragment.from(rowsOfNode.slice(r)))];
    tr.replaceWith(t.pos, t.pos + t.node.nodeSize, parts);
    second += parts[0].nodeSize;
  }
  if (brk) {
    const m2 = TableMap.get(tr.doc.nodeAt(second));
    return tr.setSelection(Selection.near(tr.doc.resolve(second + 1 + m2.map[Math.min(c, m2.width - 1)] + 1))).scrollIntoView();
  }
  const p = r === 0 ? t.pos + 1 : t.pos + rowStart(t.node, r) + 2 + 1;
  return tr.setSelection(TextSelection.create(tr.doc, p)).scrollIntoView();
}

/** Ctrl+Alt+U: removes the direct cell shading and cell borders of the selection's table so its style draws again. → a transaction or null. */
export function updateAutoFormat(state) {
  const t = tableOf(state.selection.$from);
  if (!t) return null;
  const tr = state.tr;
  t.node.descendants((node, p) => {
    if (node.type.name === 'table') return false; // a nested table keeps its own
    if (node.type.spec.tableRole !== 'cell' && node.type.spec.tableRole !== 'header_cell') return true;
    if (node.attrs.shading != null || node.attrs.borders != null) tr.setNodeMarkup(t.pos + 1 + p, null, { ...node.attrs, shading: null, borders: null });
    return true;
  });
  return tr.docChanged ? tr : null;
}

// ---------- Insert Table and Convert Text to Table ----------
/** Table and column attributes of AutoFit choice `fit` ({kind: 'fixed', width: pt | null} | {kind: 'contents'} | {kind: 'window'})
 * for `cols` columns → {attrs, colwidth (px array or null)}. Fixed Auto splits the text width equally, which every column's equal
 * share already draws. ponytail: AutoFit to contents draws like the window until table-layout's AutoFit runs after the insert. */
function fitOf(fit, cols) {
  if (fit?.kind === 'window') return { attrs: { layout: 'autofit', width: { w: 100, type: 'pct' } }, colwidth: null };
  if (fit?.kind === 'contents') return { attrs: { layout: 'autofit', width: { w: 0, type: 'auto' } }, colwidth: null };
  const px = fit?.width ? Math.round((fit.width * 4) / 3) : null;
  return { attrs: { layout: 'fixed' }, colwidth: px ? Array(cols).fill(px) : null };
}

/** A table node of `rows` x `cols` empty cells with AutoFit `fit`; `cell(r, c)` may give a cell's paragraphs (an array of nodes). */
export function makeTable(schema, rows, cols, fit, cell = () => null) {
  const { table, tableRow, tableCell, paragraph } = schema.nodes;
  const f = fitOf(fit, cols);
  return table.create(f.attrs, Array.from({ length: rows }, (_, r) => tableRow.create(null, Array.from({ length: cols }, (_, c) =>
    tableCell.create({ colwidth: f.colwidth ? [f.colwidth[c]] : null }, cell(r, c) ?? paragraph.create())))));
}

/** Puts `table` at the selection (after a selected object, as an insert does) and the caret in its first cell. → `tr`. */
export function insertTableTr(tr, table) {
  if (tr.selection.node) tr.setSelection(Selection.near(tr.doc.resolve(tr.selection.to)));
  const at = tr.selection.from;
  tr.replaceSelectionWith(table);
  // The table starts at or just after `at` (a split paragraph comes first); find it from there.
  let start = null;
  tr.doc.nodesBetween(at, Math.min(tr.doc.content.size, at + table.nodeSize + 2), (node, p) => {
    if (start == null && node.type.name === 'table') start = p;
    return start == null;
  });
  if (start != null) tr.setSelection(Selection.near(tr.doc.resolve(start + 3)));
  return tr.scrollIntoView();
}

/** The textblocks Convert Text to Table takes: those in the selection that share the first one's parent → {blocks: [{node, pos}],
 * texts} or null. Null too when another block of that parent (a table, canvas or list) sits in the selection, because the
 * conversion replaces everything from the first paragraph to the last. Offsets in `texts` match the content offsets (an inline
 * object counts one character). */
export function convertSource(state) {
  const { from, to, $from, empty } = state.selection;
  if (empty) return null;
  const blocks = [];
  let mixed = false;
  const parent = $from.parent.isTextblock ? $from.node($from.depth - 1) : $from.parent; // Select All starts in the doc itself
  state.doc.nodesBetween(from, to, (node, pos, par) => {
    if (mixed) return false;
    if (par === parent && !node.isTextblock) mixed = true;
    if (!node.isTextblock) return !mixed;
    if (par === parent) blocks.push({ node, pos });
    return false;
  });
  if (mixed || !blocks.length) return null;
  return { blocks, texts: blocks.map(({ node }) => node.textBetween(0, node.content.size, '', '￼')) };
}

/** Replaces the source paragraphs with a table split at `sep` into `cols` columns, keeping each piece's formatting. → `tr`. */
export function convertTr(state, src, { sep, other, cols, fit }) {
  const rows = cellRanges(src.texts, sep, { other, cols });
  const n = rows[0]?.length ?? 1;
  const table = makeTable(state.schema, rows.length, n, fit, (r, c) => {
    const x = rows[r][c];
    if (!x) return null;
    const { node } = src.blocks[x[0]];
    return node.type.create(node.attrs, node.content.cut(x[1], x[2]));
  });
  const first = src.blocks[0].pos;
  const last = src.blocks.at(-1);
  const tr = state.tr.replaceWith(first, last.pos + last.node.nodeSize, table);
  return tr.setSelection(Selection.near(tr.doc.resolve(first + 3))).scrollIntoView();
}

// ---------- the grid model (Draw Table, Eraser, Border Painter) ----------
const CELL_ROLES = new Set(['cell', 'header_cell']);

/** The model (tables.mjs) of the `table` node at `pos`, with column widths `cols` and row heights `rows` in px (as drawn), and the
 * table's cells as {rel, node} in the model's cell order. */
export function modelOf(table, cols, rows) {
  const map = TableMap.get(table);
  const src = [...new Set(map.map)].map((rel) => ({ rel, node: table.nodeAt(rel), box: map.findCell(rel) }))
    .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
  return {
    src,
    model: {
      cols: cols ?? Array(map.width).fill(100),
      rows: rows ?? Array(map.height).fill(20),
      rowSrc: [...Array(map.height).keys()],
      cells: src.map(({ box }, i) => ({ r: box.top, c: box.left, rs: box.bottom - box.top, cs: box.right - box.left, src: [i] })),
    },
  };
}

const lonelyEmpty = (n) => n.childCount === 1 && n.firstChild.isTextblock && n.firstChild.content.size === 0;

/** The table node `model` describes, built from the original `table` and its cells `src` (modelOf). Every cell takes its columns'
 * widths, since a drawn table has explicit ones. */
export function tableOfModel(schema, table, model, src) {
  const { tableRow, tableCell, paragraph } = schema.nodes;
  const rows = model.rows.map((_, r) => {
    const cells = model.cells.filter((x) => x.r === r).map((x) => {
      const from = x.src.map((i) => src[i].node);
      const first = from[0];
      const parts = from.filter((n) => !lonelyEmpty(n));
      const content = (parts.length ? parts : from.slice(0, 1)).flatMap((n) => [...Array(n.childCount).keys()].map((i) => n.child(i)));
      const attrs = { ...(first?.attrs ?? {}), colspan: x.cs, rowspan: x.rs, colwidth: model.cols.slice(x.c, x.c + x.cs).map(Math.round) };
      return (first?.type ?? tableCell).create(attrs, content.length ? content : paragraph.create());
    });
    const like = table.maybeChild(model.rowSrc?.[r] ?? r);
    return tableRow.create(like?.attrs ?? null, cells);
  });
  return table.copy(Fragment.from(rows));
}

/** Sets border `border` (a border edge object) on `edge` (tables.mjs edgeAt) of the table at `pos`: both cells that share it. */
export function setEdge(tr, pos, src, edge, border) {
  for (const side of [edge.a, edge.b]) {
    if (!side) continue;
    const { rel } = src[side.id];
    const node = tr.doc.nodeAt(pos + 1 + rel);
    if (!node || !CELL_ROLES.has(node.type.spec.tableRole)) continue;
    tr.setNodeMarkup(pos + 1 + rel, null, { ...node.attrs, borders: { ...(node.attrs.borders ?? {}), [side.side]: border } });
  }
  return tr;
}

/** Word's pen (store word.pen: {style, width, color}) as a border edge object. */
export const penBorder = (pen) => ({ style: pen?.style ?? 'single', width: pen?.width ?? 0.5, space: 0, color: pen?.color ?? 'auto' });
/** No border, which Eraser leaves on an outer edge (beats the table style's line). */
export const NO_BORDER = { style: 'nil', width: 0, space: 0, color: 'auto' };

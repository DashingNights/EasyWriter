// Table Layout's editor side (docs/plans/word/briefs/table-layout.md): where the selection sits in its table, the drawn column
// widths and row heights, and the writes the commands share. Every write is one transaction, so one undo step.
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, isInTable, selectedRect, TableMap } from '@tiptap/pm/tables';
import { gridOf } from './grid.mjs';

export const PX = 4 / 3; // px per pt: the model keeps colwidth in px and every other length in pt

/** The table holding `state`'s selection → {pos, node, tableStart, map, top, left, bottom, right} (rect ends exclusive) or null. */
export function tableOf(state) {
  if (!state || !isInTable(state)) return null;
  const r = selectedRect(state);
  return { ...r, pos: r.tableStart - 1, node: r.table };
}

/** The positions of row `y`'s node in table `t`. */
export function rowPos(t, y) {
  let pos = t.tableStart;
  for (let i = 0; i < y; i++) pos += t.node.child(i).nodeSize;
  return pos;
}

/** The cells in `t`'s selected rectangle → [{pos, node}] (each once). */
export function selectedCells(t, state) {
  return t.map.cellsInRect(t).map((rel) => ({ pos: t.tableStart + rel, node: state.doc.nodeAt(t.tableStart + rel) }));
}

/** The cell at grid (`y`, `x`) of `t` → its position. */
export const cellPos = (t, y, x) => t.tableStart + t.map.map[y * t.map.width + x];

/** Selects grid rows `y0`..`y1` and columns `x0`..`x1` of `t` (inclusive) as a cell selection. */
export function selectRect(view, t, y0, x0, y1, x1) {
  const sel = CellSelection.create(view.state.doc, cellPos(t, y0, x0), cellPos(t, y1, x1));
  view.dispatch(view.state.tr.setSelection(sel));
  view.focus();
  return true;
}

/** Replaces `t`'s table with node JSON `json` (one step) and puts the caret in grid cell (`y`, `x`), clamped → whether it worked. */
export function replaceTable(view, t, json, y = 0, x = 0) {
  const { state } = view;
  let node;
  try {
    node = state.schema.nodeFromJSON(json);
    node.check();
  } catch (e) {
    console.error('Table Layout: the changed table does not fit the schema', e);
    return false;
  }
  const tr = state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, node);
  const map = TableMap.get(node);
  const at = map.map[Math.min(y, map.height - 1) * map.width + Math.min(x, map.width - 1)];
  tr.setSelection(TextSelection.near(tr.doc.resolve(t.pos + 1 + at + 1)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Patches the attributes of the nodes at `positions` with `patch(node)` in one transaction (attribute changes keep positions). */
export function patchNodes(view, positions, patch) {
  const tr = view.state.tr;
  for (const pos of positions) {
    const node = tr.doc.nodeAt(pos);
    if (node) tr.setNodeMarkup(pos, null, { ...node.attrs, ...patch(node) });
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

/** Each column's drawn width of `t` in layout px (zoom free), from a cell spanning one column, else a share of a wider one. */
export function drawnWidths(view, t) {
  const g = gridOf(t.node.toJSON());
  const out = Array(g.cols).fill(0);
  const cellDom = (c) => view.nodeDOM(cellPos(t, c.y, c.x));
  for (let x = 0; x < g.cols; x++) {
    const one = g.cells.find((c) => c.x === x && c.cs === 1);
    const c = one ?? g.cells[g.map[0][x]];
    out[x] = (cellDom(c)?.offsetWidth ?? 0) / (one ? 1 : c.cs);
  }
  return out;
}

/** The column widths (px) of `t`: each cell's colwidth, else the drawn width, so every column has one. */
export function widthsNow(view, t) {
  const drawn = drawnWidths(view, t);
  const own = Array(t.map.width).fill(null);
  for (const rel of new Set(t.map.map)) {
    const cell = t.node.nodeAt(rel);
    const r = t.map.findCell(rel);
    cell.attrs.colwidth?.forEach((w, i) => { if (w && own[r.left + i] == null) own[r.left + i] = w; });
  }
  return own.map((w, x) => w ?? Math.round(drawn[x] * 100) / 100);
}

/** Writes `widths` (px per column) into every cell's colwidth of `t`, with table attributes `tablePatch`, in one transaction. */
export function writeWidths(view, t, widths, tablePatch = null) {
  const tr = view.state.tr;
  for (const rel of new Set(t.map.map)) {
    const pos = t.tableStart + rel;
    const cell = tr.doc.nodeAt(pos);
    const r = t.map.findCell(rel);
    tr.setNodeMarkup(pos, null, { ...cell.attrs, colwidth: widths.slice(r.left, r.right).map((w) => Math.round(w * 100) / 100) });
  }
  if (tablePatch) tr.setNodeMarkup(t.pos, null, { ...tr.doc.nodeAt(t.pos).attrs, ...tablePatch });
  view.dispatch(tr);
  return true;
}

/** Row `y` of `t`'s drawn height in pt. */
export const drawnHeight = (view, t, y) => (view.nodeDOM(rowPos(t, y))?.offsetHeight ?? 0) / PX;

/** The max-content width (layout px) of each column of `t`, measured on a copy of its table laid out without set widths in a
 * hidden copy of the editor's root (so the document's styles apply), not in the live row grid. */
export function contentWidths(view, t) {
  const wrapper = view.nodeDOM(t.pos);
  const table = wrapper?.querySelector?.('table');
  if (!table) return null;
  const root = view.dom.cloneNode(false);
  root.removeAttribute('contenteditable');
  Object.assign(root.style, { position: 'absolute', left: '-100000px', top: '0', width: '100000px', visibility: 'hidden', pointerEvents: 'none' });
  const copy = table.cloneNode(true);
  copy.querySelector('colgroup')?.remove();
  copy.setAttribute('data-whole', '');
  copy.style.cssText = 'width: auto; table-layout: auto';
  const box = document.createElement('div');
  box.className = 'tableWrapper';
  box.append(copy);
  root.append(box);
  view.dom.parentElement.append(root);
  try {
    const g = gridOf(t.node.toJSON());
    const out = Array(g.cols).fill(0);
    for (const c of g.cells) {
      const el = copy.rows[c.row]?.cells[c.index];
      if (el && c.cs === 1) out[c.x] = Math.max(out[c.x], el.offsetWidth);
    }
    return { widths: out, text: wrapper.offsetWidth };
  } finally {
    root.remove();
  }
}

// Table pointers (docs/plans/word/briefs/table-tools.md): Draw Table, Eraser and Border Painter (store word.tableTool), the move
// and resize handles, the insert controls, the row, column and cell selection pointers, and the column border drag with Shift,
// Ctrl and Ctrl+Shift. The handles and zones live in the page overlay (geometry.js overlayOf), placed in layout px: every client
// coordinate is divided by the page zoom, measured as the editor's drawn width over its layout width.
// ponytail: the resize handle and the moved table show no live preview; draw one with the colgroup, as ColumnDrag does, if wanted.
import { Extension } from '@tiptap/core';
import { Plugin, Selection } from '@tiptap/pm/state';
import { addColumn, addRow, CellSelection, columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import { getState, setState, subscribe } from '../../../app/store.js';
import { drawnColumnWidths, setColumnWidths } from '../../../export.js';
import { run } from '../../../tooling/registry.js';
import { overlayOf } from '../../geometry.js';
import { makeTable, modelOf, NO_BORDER, penBorder, setEdge, tableOfModel } from './ops.js';
import { borderDrag, drawOp, eraseOp } from './tables.mjs';

const CELL_ZONE = 4; // px inside a cell's left edge that select the cell (Word's black arrow)
const RESIZE_ZONE = 5; // columnResizing's handle width: a cell after the first starts its zone past it
const MOVE = 3; // px a press may move and still be a click

/** Sets the table pointer tool ('draw' | 'erase' | 'paint' | null). */
export const setTool = (tool) => setState({ word: { ...getState().word, tableTool: tool } });
const toolNow = () => getState().word?.tableTool ?? null;

// ---------- geometry ----------
const scaleOf = (view) => view.dom.getBoundingClientRect().width / view.dom.offsetWidth || 1;

/** A converter from client px to layout px in .ProseMirror's coordinates (the overlay's). */
function layoutOf(view) {
  const r = view.dom.getBoundingClientRect();
  const s = scaleOf(view);
  return { s, x: (cx) => (cx - r.left) / s, y: (cy) => (cy - r.top) / s };
}

/** The tables drawn in `view`: [{el (wrapper), pos, node}], nested ones after their parents. */
function tablesIn(view) {
  const out = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true;
    const el = view.nodeDOM(pos);
    if (el?.isConnected) out.push({ el, pos, node });
    return true;
  });
  return out;
}

/** The client box of a table's drawn rows (a split table's wrapper holds row grids; its rows are what shows). */
function boxOf(t) {
  const rows = [...t.el.querySelectorAll(':scope > table > tbody > tr')].map((r) => r.getBoundingClientRect());
  if (!rows.length) return t.el.getBoundingClientRect();
  return { left: Math.min(...rows.map((r) => r.left)), right: Math.max(...rows.map((r) => r.right)), top: rows[0].top, bottom: rows.at(-1).bottom, rows };
}

/** The innermost table whose box, grown by `pad` ({l, t, r, b} px), holds client point (`x`, `y`) → {el, pos, node, box} or null. */
function tableAt(view, x, y, pad = { l: 0, t: 0, r: 0, b: 0 }) {
  let hit = null;
  for (const t of tablesIn(view)) {
    const box = boxOf(t);
    if (x >= box.left - pad.l && x <= box.right + pad.r && y >= box.top - pad.t && y <= box.bottom + pad.b) hit = { ...t, box };
  }
  return hit;
}

/** The grid model of table `t` with its drawn geometry in layout px from the table's top-left: {model, src, origin}. */
function drawnModel(view, t) {
  const L = layoutOf(view);
  const { model, src } = modelOf(t.node, null, null);
  const xs = Array(model.cols.length + 1).fill(null);
  const ys = Array(model.rows.length + 1).fill(null);
  const boxes = src.map(({ rel }) => view.nodeDOM(t.pos + 1 + rel)?.getBoundingClientRect());
  model.cells.forEach((cell, i) => {
    const b = boxes[i];
    if (!b) return;
    xs[cell.c] ??= L.x(b.left);
    xs[cell.c + cell.cs] ??= L.x(b.right);
    ys[cell.r] ??= L.y(b.top);
    ys[cell.r + cell.rs] ??= L.y(b.bottom);
  });
  // A boundary no cell starts or ends at (rare with spans) takes an even share between its known neighbours.
  const fill = (a) => a.map((v, i) => v ?? (a[i - 1] ?? 0) + 20);
  const X = fill(xs);
  const Y = fill(ys);
  model.cols = X.slice(1).map((v, i) => Math.max(1, v - X[i]));
  model.rows = Y.slice(1).map((v, i) => Math.max(1, v - Y[i]));
  return { model, src, origin: { x: X[0], y: Y[0] }, L };
}

// ---------- Draw Table, Eraser, Border Painter ----------
/** Applies one tool gesture from client point `a` to `b` in `view`. → whether the document changed. */
function applyTool(view, tool, a, b) {
  const { state } = view;
  const pen = penBorder(getState().word?.pen);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const t = tableAt(view, mid.x, mid.y, { l: 6, t: 6, r: 6, b: 6 }) ?? tableAt(view, a.x, a.y, { l: 6, t: 6, r: 6, b: 6 });
  if (!t) return tool === 'draw' ? drawRectangle(view, a, b) : false;
  const { model, src, origin, L } = drawnModel(view, t);
  const lx = (p) => L.x(p.x) - origin.x;
  const ly = (p) => L.y(p.y) - origin.y;
  const tr = state.tr;
  if (tool === 'erase') {
    // A click, or a drag whose end, start or middle lies on an edge.
    const hit = [b, a, mid].map((p) => eraseOp(model, lx(p), ly(p), 4)).find(Boolean);
    if (!hit) return false;
    if (hit.op.kind === 'clear') setEdge(tr, t.pos, src, hit.op.edge, NO_BORDER);
    else tr.replaceWith(t.pos, t.pos + t.node.nodeSize, tableOfModel(state.schema, t.node, hit.model, src));
  } else {
    const hit = drawOp(model, { x1: lx(a), y1: ly(a), x2: lx(b), y2: ly(b) }, { paint: tool === 'paint' });
    if (!hit) return false;
    const { op } = hit;
    if (op.kind === 'border') setEdge(tr, t.pos, src, op.edge, pen);
    else if (op.kind === 'diagonal') setEdge(tr, t.pos, src, { a: { id: op.cell, side: op.which }, b: null }, pen);
    else tr.replaceWith(t.pos, t.pos + t.node.nodeSize, tableOfModel(state.schema, t.node, hit.model, src));
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

/** Draw Table's rectangle outside a table: a one-cell table of the drawn width and height before the paragraph under its top. */
function drawRectangle(view, a, b) {
  const s = scaleOf(view);
  const w = Math.abs(b.x - a.x) / s;
  const h = Math.abs(b.y - a.y) / s;
  if (w < 12 || h < 8) return false;
  const { state } = view;
  const at = view.posAtCoords({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y) });
  let pos = state.doc.content.size;
  if (at) {
    const $p = state.doc.resolve(at.pos);
    let d = $p.depth;
    while (d > 0 && !$p.node(d).isTextblock) d--;
    if (d > 0) pos = $p.before(d);
    else if ($p.depth > 0) pos = $p.before(1);
  }
  const table = makeTable(state.schema, 1, 1, { kind: 'fixed', width: (w * 3) / 4 });
  const row = table.firstChild.type.create({ ...table.firstChild.attrs, height: { value: Math.round(h * 0.75), rule: 'atLeast' } }, table.firstChild.content);
  const tr = state.tr.insert(pos, table.copy(table.content.replaceChild(0, row)));
  tr.setSelection(Selection.near(tr.doc.resolve(pos + 3)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------- the overlay's handles and zones ----------
const SVG = (path) => `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const MOVE_ICON = SVG('<path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>');
const PLUS_ICON = SVG('<path d="M12 5v14M5 12h14"/>');

function makeParts(doc) {
  const el = (html = '') => Object.assign(doc.createElement('div'), { className: 'tt-part', innerHTML: html, hidden: true });
  const parts = { move: el(MOVE_ICON), resize: el(), rows: el(), cols: el(), plus: el(PLUS_ICON) };
  for (const [k, e] of Object.entries(parts)) e.dataset.tt = k;
  return parts;
}

const place = (e, left, top, width, height) => Object.assign(e.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });

/** Selects every cell of the table at `pos`. */
function selectTable(view, pos) {
  const t = view.state.doc.nodeAt(pos);
  const map = TableMap.get(t);
  const cells = map.map;
  view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, pos + 1 + cells[0], pos + 1 + cells.at(-1))));
  view.focus();
}

class TablePointers {
  constructor(view) {
    this.view = view;
    this.win = view.dom.ownerDocument.defaultView;
    this.hover = null; // {pos, box: layout px {left, top, right, bottom}, rows: [layout tops..., bottom], cols: [...]}
    this.parts = null;
    this.frame = 0;
    this.onMove = (e) => {
      this.last = e;
      if (!this.frame) this.frame = this.win.requestAnimationFrame(() => { this.frame = 0; this.track(this.last); });
    };
    this.onKey = (e) => {
      if (e.key === 'Escape' && toolNow()) {
        setTool(null);
        e.preventDefault();
        e.stopPropagation();
      }
    };
    this.unsub = subscribe(() => this.syncTool());
    this.win.addEventListener('mousemove', this.onMove, { passive: true });
    this.win.addEventListener('keydown', this.onKey, true);
    this.syncTool();
  }

  /** The tool marker on the editor (its pointer cursor in style.css); handles hide while a tool is on. */
  syncTool() {
    const tool = toolNow();
    if ((this.view.dom.dataset.tableTool ?? null) === tool) return;
    if (tool) this.view.dom.dataset.tableTool = tool;
    else delete this.view.dom.dataset.tableTool;
    if (tool) this.hide();
  }

  ensureParts() {
    const overlay = overlayOf(this.view);
    if (!overlay) return null;
    if (!this.parts || !this.parts.move.isConnected) {
      this.parts = makeParts(this.view.dom.ownerDocument);
      overlay.append(...Object.values(this.parts));
      this.parts.move.addEventListener('mousedown', (e) => this.pressMove(e));
      this.parts.resize.addEventListener('mousedown', (e) => this.pressResize(e));
      this.parts.rows.addEventListener('mousedown', (e) => this.pressZone(e, 'rows'));
      this.parts.cols.addEventListener('mousedown', (e) => this.pressZone(e, 'cols'));
      this.parts.plus.addEventListener('mousedown', (e) => this.pressPlus(e));
    }
    return this.parts;
  }

  hide() {
    this.hover = null;
    if (this.parts) for (const e of Object.values(this.parts)) e.hidden = true;
  }

  /** Shows the hovered table's handles and zones, and the insert control near a row or column boundary. */
  track(e) {
    // Only the open Document's own editor: the assistant's hidden session editors share the kit (codemap.md §7).
    if (this.drag || !this.view.dom.closest('#editor') || toolNow() || getState().draft?.format !== 'document') return;
    if (e.target instanceof Element && !e.target.closest('#editor-area')) return this.hide();
    const own = e.target instanceof Element && e.target.closest('[data-tt]');
    const t = tableAt(this.view, e.clientX, e.clientY, { l: 26, t: 20, r: 14, b: 14 });
    if (!t && !own) return this.hide();
    const parts = this.ensureParts();
    if (!parts) return;
    if (t) {
      const L = layoutOf(this.view);
      const { box } = t;
      const rows = (box.rows ?? [box]).map((r) => L.y(r.top)).concat(L.y(box.bottom));
      const map = TableMap.get(t.node);
      const widths = drawnColumnWidths(this.view, t.node, t.pos) ?? Array(map.width).fill((box.right - box.left) / L.s / map.width);
      const cols = widths.reduce((a, w) => [...a, a.at(-1) + w], [L.x(box.left)]);
      this.hover = { pos: t.pos, box: { left: L.x(box.left), right: L.x(box.right), top: L.y(box.top), bottom: L.y(box.bottom) }, rows, cols, L };
      const b = this.hover.box;
      place(parts.move, b.left - 17, b.top - 17, 14, 14);
      place(parts.resize, b.right + 1, b.bottom + 1, 8, 8);
      place(parts.rows, b.left - 24, b.top, 22, b.bottom - b.top);
      place(parts.cols, b.left, b.top - 12, b.right - b.left, 11);
      for (const k of ['move', 'resize', 'rows', 'cols']) parts[k].hidden = false;
    }
    const h = this.hover;
    if (!h) return;
    // The insert control: left of a row boundary, or above a column boundary (not the table's outer start).
    const x = h.L.x(e.clientX);
    const y = h.L.y(e.clientY);
    const near = (list, v) => list.findIndex((p, i) => i > 0 && Math.abs(p - v) <= 5);
    let plus = null;
    if (x < h.box.left && x >= h.box.left - 26) {
      const k = near(h.rows, y);
      if (k > 0) plus = { kind: 'row', at: k, left: h.box.left - 24, top: h.rows[k] - 7 };
    } else if (y < h.box.top && y >= h.box.top - 20) {
      const k = near(h.cols, x);
      if (k > 0) plus = { kind: 'col', at: k, left: h.cols[k] - 7, top: h.box.top - 26 };
    }
    this.plus = plus;
    parts.plus.hidden = !plus;
    if (plus) place(parts.plus, plus.left, plus.top, 14, 14);
  }

  /** Follows a press from `e` until release: `move(e)` while it moves, `up(e, moved)` once at the end. */
  follow(e, move, up) {
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    this.drag = true;
    const onMove = (m) => {
      moved ||= Math.hypot(m.clientX - start.x, m.clientY - start.y) > MOVE;
      if (moved) move?.(m);
    };
    const onUp = (u) => {
      this.win.removeEventListener('mousemove', onMove, true);
      this.win.removeEventListener('mouseup', onUp, true);
      this.drag = false;
      up?.(u, moved || Math.hypot(u.clientX - start.x, u.clientY - start.y) > MOVE);
    };
    this.win.addEventListener('mousemove', onMove, true);
    this.win.addEventListener('mouseup', onUp, true);
    e.preventDefault();
    e.stopPropagation();
  }

  /** The move handle: a click selects the table; a drag moves it to the paragraph boundary under the release point. */
  pressMove(e) {
    const pos = this.hover?.pos;
    if (pos == null || e.button !== 0) return;
    this.follow(e, null, (u, moved) => {
      if (!moved) return selectTable(this.view, pos);
      const { state } = this.view;
      const table = state.doc.nodeAt(pos);
      const at = this.view.posAtCoords({ left: u.clientX, top: u.clientY });
      if (!table || !at) return;
      const $p = state.doc.resolve(at.pos);
      let d = $p.depth;
      while (d > 0 && !$p.node(d).isTextblock) d--;
      if (d === 0) return;
      const box = this.view.nodeDOM($p.before(d))?.getBoundingClientRect?.();
      const target = box && u.clientY > (box.top + box.bottom) / 2 ? $p.after(d) : $p.before(d);
      if (target >= pos && target <= pos + table.nodeSize) return;
      const tr = state.tr.delete(pos, pos + table.nodeSize);
      const to = tr.mapping.map(target);
      tr.insert(to, table);
      const map = TableMap.get(table);
      tr.setSelection(CellSelection.create(tr.doc, to + 1 + map.map[0], to + 1 + map.map.at(-1)));
      this.view.dispatch(tr.scrollIntoView());
      this.view.focus();
    });
  }

  /** The resize handle: every column width and row height scales by the drag, in one step. */
  pressResize(e) {
    const h = this.hover;
    if (!h || e.button !== 0) return;
    const L = h.L;
    this.follow(e, null, (u, moved) => {
      if (!moved) return;
      const { state } = this.view;
      const table = state.doc.nodeAt(h.pos);
      const widths = table && drawnColumnWidths(this.view, table, h.pos);
      if (!widths) return;
      const w = h.box.right - h.box.left;
      const ht = h.box.bottom - h.box.top;
      const fx = Math.max(0.1, (w + (u.clientX - e.clientX) / L.s) / w);
      const fy = Math.max(0.1, (ht + (u.clientY - e.clientY) / L.s) / ht);
      const tr = setColumnWidths(state.tr, table, h.pos, widths.map((x) => Math.max(20, Math.round(x * fx))));
      let p = h.pos + 1;
      table.forEach((row, _o, i) => {
        const px = h.rows[i + 1] - h.rows[i];
        if (Math.abs(fy - 1) > 0.01) tr.setNodeMarkup(p, null, { ...row.attrs, height: { value: Math.round(px * fy * 0.75 * 10) / 10, rule: 'atLeast' } });
        p += row.nodeSize;
      });
      this.view.dispatch(tr);
    });
  }

  /** Left of the rows (`kind` 'rows') or above the columns ('cols'): a click selects that row or column, a drag extends it. */
  pressZone(e, kind) {
    const h = this.hover;
    if (!h || e.button !== 0) return;
    const list = kind === 'rows' ? h.rows : h.cols;
    // The row or column whose span holds the pointer; before the first is the first, past the last the last.
    const index = (ev) => {
      const v = kind === 'rows' ? h.L.y(ev.clientY) : h.L.x(ev.clientX);
      const next = list.findIndex((p) => p > v);
      return next < 0 ? list.length - 2 : Math.max(0, next - 1);
    };
    const table = this.view.state.doc.nodeAt(h.pos);
    if (!table) return;
    const map = TableMap.get(table);
    const cellAt = (i) => h.pos + 1 + (kind === 'rows' ? map.map[i * map.width] : map.map[i]);
    const pick = (a, b) => {
      const doc = this.view.state.doc;
      const $a = doc.resolve(cellAt(a));
      const $b = doc.resolve(cellAt(b));
      const sel = kind === 'rows' ? CellSelection.rowSelection($a, $b) : CellSelection.colSelection($a, $b);
      this.view.dispatch(this.view.state.tr.setSelection(sel));
    };
    const first = index(e);
    pick(first, first);
    this.view.focus();
    this.follow(e, (m) => pick(first, index(m)), null);
  }

  /** The insert control: a row (left of a row boundary) or column (above a column boundary) there. */
  pressPlus(e) {
    const h = this.hover;
    const plus = this.plus;
    if (!h || !plus || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { state } = this.view;
    const table = state.doc.nodeAt(h.pos);
    if (!table) return;
    const rect = { map: TableMap.get(table), tableStart: h.pos + 1, table };
    const tr = plus.kind === 'row' ? addRow(state.tr, rect, plus.at) : addColumn(state.tr, rect, plus.at);
    this.view.dispatch(tr);
    this.view.focus();
  }

  destroy() {
    this.unsub();
    this.win.removeEventListener('mousemove', this.onMove, { passive: true });
    this.win.removeEventListener('keydown', this.onKey, true);
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    if (this.parts) for (const e of Object.values(this.parts)) e.remove();
    delete this.view.dom.dataset.tableTool;
  }
}

// ---------- presses inside the text ----------
/** The cell `e` presses within its left-edge zone → the cell's position, or null. */
function cellZoneAt(view, e) {
  const td = e.target instanceof Element ? e.target.closest('td, th') : null;
  if (!td || !view.dom.contains(td)) return null;
  const s = scaleOf(view);
  const x = (e.clientX - td.getBoundingClientRect().left) / s;
  const first = !td.previousElementSibling;
  if (first ? x < 0 || x > CELL_ZONE : x <= RESIZE_ZONE || x > RESIZE_ZONE + CELL_ZONE) return null;
  const pos = view.posAtDOM(td, 0) - 1;
  return view.state.doc.nodeAt(pos)?.type.spec.tableRole?.includes('cell') ? pos : null;
}

/** A tool gesture: follow the press, draw its guide in the overlay, apply it on release. */
function toolPress(view, e, tool) {
  const overlay = overlayOf(view);
  const guide = view.dom.ownerDocument.createElement('div');
  guide.className = 'tt-guide';
  guide.dataset.tool = tool;
  overlay?.append(guide);
  const L = layoutOf(view);
  const a = { x: e.clientX, y: e.clientY };
  const draw = (m) => {
    const [x1, y1, x2, y2] = [L.x(a.x), L.y(a.y), L.x(m.clientX), L.y(m.clientY)];
    place(guide, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  };
  const win = view.dom.ownerDocument.defaultView;
  const move = (m) => draw(m);
  const up = (u) => {
    win.removeEventListener('mousemove', move, true);
    win.removeEventListener('mouseup', up, true);
    guide.remove();
    applyTool(view, tool, a, { x: u.clientX, y: u.clientY });
  };
  win.addEventListener('mousemove', move, true);
  win.addEventListener('mouseup', up, true);
  e.preventDefault();
  return true;
}

/** Shift, Ctrl and Ctrl+Shift drags of a column border (a plain drag is ColumnDrag's, src/extensions.js). */
function borderPress(view, e) {
  const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
  if (handle < 0 || !(e.shiftKey || e.ctrlKey)) return false;
  const $cell = view.state.doc.resolve(handle);
  const table = $cell.node(-1);
  const pos = $cell.before(-1);
  const widths = drawnColumnWidths(view, table, pos);
  const el = view.nodeDOM(pos)?.querySelector(':scope > table');
  if (!widths || !el) return false;
  const col = TableMap.get(table).colCount($cell.pos - $cell.start(-1)) + $cell.nodeAfter.attrs.colspan - 1;
  const mode = e.ctrlKey && e.shiftKey ? 'ctrlShift' : e.ctrlKey ? 'ctrl' : 'shift';
  const s = scaleOf(view);
  const doc = view.state.doc;
  const win = view.dom.ownerDocument.defaultView;
  const at = (x) => borderDrag(widths, col, (x - e.clientX) / s, mode);
  const move = (m) => {
    const next = at(m.clientX);
    el.querySelectorAll(':scope > colgroup > col').forEach((c, i) => Object.assign(c.style, { width: `${next[i]}px`, minWidth: '' }));
    Object.assign(el.style, { width: `${next.reduce((x, y) => x + y)}px`, minWidth: '' });
  };
  const up = (u) => {
    win.removeEventListener('mousemove', move, true);
    win.removeEventListener('mouseup', up, true);
    const tr = view.state.tr.setMeta(columnResizingPluginKey, { setDragging: null });
    view.dispatch(view.state.doc === doc ? setColumnWidths(tr, table, pos, at(u.clientX)) : tr);
  };
  view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setDragging: { startX: e.clientX, startWidth: widths[col] } }));
  win.addEventListener('mousemove', move, true);
  win.addEventListener('mouseup', up, true);
  e.preventDefault();
  return true;
}

/** The pointers plugin: ahead of ColumnDrag (101) and Table's own mousedown, so a tool or modifier press is ours. */
export const TablePointersExt = Extension.create({
  name: 'tableToolsPointers',
  priority: 110,
  addProseMirrorPlugins() {
    return [new Plugin({
      view: (view) => (view.dom.closest?.('[data-story]') ? {} : new TablePointers(view)),
      props: {
        handleDOMEvents: {
          mousedown(view, e) {
            if (e.button !== 0) return false;
            const tool = toolNow();
            if (tool && view.dom.closest('#editor')) return toolPress(view, e, tool);
            if (borderPress(view, e)) return true;
            const cell = cellZoneAt(view, e);
            if (cell == null) return false;
            view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cell)));
            e.preventDefault();
            return true;
          },
          mousemove(view, e) {
            // Word's black arrow inside a cell's left edge.
            const on = !toolNow() && cellZoneAt(view, e) != null;
            if (on) view.dom.dataset.ttCell = '';
            else delete view.dom.dataset.ttCell;
            return false;
          },
          dblclick(view, e) {
            const handle = columnResizingPluginKey.getState(view.state)?.activeHandle ?? -1;
            if (handle < 0) return false;
            const $cell = view.state.doc.resolve(handle);
            const column = TableMap.get($cell.node(-1)).colCount($cell.pos - $cell.start(-1)) + $cell.nodeAfter.attrs.colspan - 1;
            run('tableLayout.cellSize.autoFit.autoFitContents', { column });
            e.preventDefault();
            return true;
          },
        },
      },
    })];
  },
});


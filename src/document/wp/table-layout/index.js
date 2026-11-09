// Table Layout (docs/plans/word/plan.md §3 table-layout, briefs/table-layout.md): the Table Layout tab's commands and dialogs,
// Home > Sort, View Gridlines and Allow row to break across pages. Base (word/base.js) keeps the rows and columns buttons, Merge
// Cells, the Delete menu's row, column and table items and the nine alignments; this module extends them with the dialogs,
// cell size, AutoFit, Split Table, Text Direction, Sort, Repeat Header Rows and Convert to Text. Table structure changes go through
// the pure grid model (grid.mjs) and replace the table in one transaction, so each is one undo step.
import { mergeCells } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import { getState, subscribe } from '../../../app/store.js';
import { UNITS, unitOf } from '../../../tooling/kit/units.mjs';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { CellOptions, ConvertTableToText, DeleteCells, InsertCells, optionsPatch, optionsValue, SortDialog, SortOptions, SplitCells, TableOptions, TableProperties } from './dialogs.jsx';
import { deleteCells, gridOf, hasSpans, insertCells, sortRows, splitCell, tableToText } from './grid.mjs';
import { cellPos, contentWidths, drawnHeight, drawnWidths, patchNodes, PX, replaceTable, rowPos, selectedCells, selectRect, tableOf, widthsNow, writeWidths } from './table.js';

const MIN_COLUMN = 20; // px, the schema's narrowest column (schema.js)
const NEXT_DIR = { lrTb: 'tbRl', tbRl: 'btLr', btLr: 'lrTb' };
const SPANS = 'Not with merged cells in the way. Split them first.';

const viewOf = (ctx) => ctx.target?.view ?? null;
const tbl = (ctx) => tableOf(ctx.state);
const inTable = (ctx) => !!ctx.in.table && !!tbl(ctx);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** One step of the length unit the ribbon shows (0.1 cm or 0.1 inch) in pt. */
const tenth = (ctx) => UNITS[unitOf(ctx.settings, ctx.profile, ctx.T?.unit?.name)] / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const rowsOf = (t) => Array.from({ length: t.map.height }, (_, y) => y);
/** Rows (or columns) the selection covers; with one, Distribute takes the whole table, as Word does. */
const span = (from, to, all) => (to - from > 1 ? Array.from({ length: to - from }, (_, i) => from + i) : Array.from({ length: all }, (_, i) => i));

/** The text of every block in `node` (a cell), paragraphs joined by line breaks. */
const textOf = (node) => node.textBetween(0, node.content.size, '\n', ' ');

/** Commands that change the table's grid run on JSON; tables with merged cells refuse the shifts Word makes ragged. */
function shift(ctx, mode, fn) {
  const view = viewOf(ctx);
  const t = tbl(ctx);
  if (!view || !t) return false;
  const json = t.node.toJSON();
  if (hasSpans(json)) {
    ctx.toast(SPANS);
    return false;
  }
  const out = fn(json, { top: t.top, left: t.left, bottom: t.bottom, right: t.right }, mode);
  if (!out) return false;
  return replaceTable(view, t, out, t.top, t.left);
}

// ---------- dialogs and what they apply ----------

/** The values Table Properties shows for the selection's table. */
function propsValue(view, t) {
  const a = t.node.attrs;
  const cols = widthsNow(view, t).map((px) => round2(px / PX));
  const rows = rowsOf(t).map((y) => {
    const r = t.node.child(y).attrs;
    return { height: r.height ?? null, cantSplit: !!r.cantSplit, header: !!r.header, drawn: round2(drawnHeight(view, t, y)) };
  });
  let headerRun = 0;
  while (headerRun < rows.length && rows[headerRun].header) headerRun++;
  const cell = view.state.doc.nodeAt(cellPos(t, t.top, t.left)).attrs;
  const sel = cols.slice(t.left, t.right);
  const drawn = drawnWidths(view, t).reduce((s, w) => s + w, 0) / PX;
  return {
    table: { width: a.width ?? null, align: a.align ?? 'left', indent: a.indent ?? 0, cellMargin: a.cellMargin ?? null, cellSpacing: a.cellSpacing ?? 0,
      layout: a.layout ?? 'autofit', caption: a.caption ?? '', description: a.description ?? '', float: !!a.float },
    rows, headerRun, rowsAt: [t.top, t.bottom - 1], cols, colsAt: [t.left, t.right - 1],
    cell: { vAlign: cell.vAlign ?? 'top', margins: cell.margins ?? null, noWrap: !!cell.noWrap, fitText: !!cell.fitText,
      width: sel.every((w) => w === sel[0]) ? sel[0] : null },
    tableWidth: round2(cols.reduce((s, w) => s + w, 0)),
    // The Table tab's base: Word's percent is of the text column, and the table's own width is the drawn one (pt).
    textWidth: round2((view.nodeDOM(t.pos)?.offsetWidth ?? 0) / PX),
    drawnWidth: round2(drawn),
  };
}

/** Applies Table Properties' result `out` over `was` (what it opened with) to the table in one transaction. */
function applyProps(view, t, out, was) {
  const tr = view.state.tr;
  const patch = (pos, obj) => tr.setNodeMarkup(pos, null, { ...tr.doc.nodeAt(pos).attrs, ...obj });
  // Column widths first: the Column tab's, then the Cell tab's on each selected column.
  let cols = out.cols;
  if (!same(out.cell.width, was.cell.width) && out.cell.width) cols = cols.map((w, x) => (x >= t.left && x < t.right ? out.cell.width : w));
  if (!same(cols, was.cols)) {
    for (const rel of new Set(t.map.map)) {
      const r = t.map.findCell(rel);
      const ws = cols.slice(r.left, r.right);
      patch(t.tableStart + rel, { colwidth: ws.every((w) => w != null) ? ws.map((w) => round2(w * PX)) : null });
    }
  }
  const tp = Object.fromEntries(Object.entries(out.table).filter(([k, v]) => k !== 'float' && !same(v, was.table[k])));
  if (Object.keys(tp).length) patch(t.pos, { ...tp, ...('cellSpacing' in tp && { cellSpacing: tp.cellSpacing || null }) });
  out.rows.forEach((r, y) => {
    if (!same(r, was.rows[y])) patch(rowPos(t, y), { height: r.height, cantSplit: !!r.cantSplit, header: !!r.header });
  });
  const cp = Object.fromEntries(['vAlign', 'margins', 'noWrap', 'fitText'].filter((k) => !same(out.cell[k], was.cell[k])).map((k) => [k, out.cell[k]]));
  if (cp.vAlign) cp.vAlign = cp.vAlign === 'top' ? null : cp.vAlign;
  if (Object.keys(cp).length) for (const c of selectedCells(t, tr)) patch(c.pos, cp);
  if (!tr.docChanged) return true;
  view.dispatch(tr);
  return true;
}

/** Sort's fields for a table: Column 1 to n, or the first row's texts with a header row. */
function tableSortInfo(t) {
  const g = gridOf(t.node.toJSON());
  const first = t.node.child(0);
  const header = !!first.attrs.header || first.firstChild?.type.name === 'tableHeader';
  const heads = Array.from({ length: g.cols }, (_, x) => {
    const c = g.cells[g.map[0][x]];
    return textOf(first.child(c.index)).trim();
  });
  return { header, heads, cols: g.cols };
}

/** The blocks Home > Sort sorts: the selected ones of one parent, or the caret's parent's blocks with nothing selected. */
function sortBlocks(state) {
  const { $from, $to, empty } = state.selection;
  const range = empty ? null : $from.blockRange($to);
  const depth = range ? range.depth : Math.max(0, $from.depth - 1);
  const parent = range ? range.parent : $from.node(depth);
  const start = range ? range.startIndex : 0;
  const end = range ? range.endIndex : parent.childCount;
  const base = depth === 0 ? 0 : $from.start(depth);
  let from = base;
  for (let i = 0; i < start; i++) from += parent.child(i).nodeSize;
  const nodes = [];
  for (let i = start; i < end; i++) nodes.push(parent.child(i));
  return { from, to: from + nodes.reduce((s, n) => s + n.nodeSize, 0), nodes };
}

/** Sorts the table rows of `t` by the Sort dialog's result `o`. */
function sortTable(ctx, view, t, o) {
  const json = t.node.toJSON();
  const g = gridOf(json);
  if (g.cells.some((c) => c.rs > 1)) {
    ctx.toast(SPANS);
    return false;
  }
  const items = json.content.map((_, y) => Array.from({ length: g.cols }, (_, x) => textOf(t.node.child(y).child(g.cells[g.map[y][x]].index))));
  const order = sortRows(items, o.keys, o);
  if (o.columnOnly && g.cells.some((c) => c.cs > 1)) {
    ctx.toast(SPANS);
    return false;
  }
  if (o.columnOnly) {
    // The selected column's cells move; the keys still order them.
    const x = t.left;
    const col = json.content.map((r) => r.content[x]);
    json.content.forEach((r, y) => { r.content[x] = col[order[y]]; });
  } else {
    json.content = order.map((i) => json.content[i]);
  }
  return replaceTable(view, t, json, t.top, t.left);
}

/** Sorts the selected paragraphs by the Sort dialog's result `o` (Headings: each heading with the blocks under it). */
function sortText(view, o) {
  const { from, to, nodes } = sortBlocks(view.state);
  if (nodes.length < 2) return false;
  let groups = nodes.map((n) => [n]);
  let items;
  if (o.keys[0].field === 'headings') {
    groups = [];
    for (const n of nodes) {
      if (n.type.name === 'heading' || !groups.length) groups.push([n]);
      else groups.at(-1).push(n);
    }
    items = groups.map((g) => [g[0].type.name === 'heading' ? g[0].textContent : '']);
    o = { ...o, keys: [{ ...o.keys[0], field: 0 }] };
  } else {
    items = nodes.map((n) => [n.textContent, ...n.textContent.split(o.sep).map((s) => s.trim())]);
  }
  const order = sortRows(items, o.keys, o);
  const tr = view.state.tr.replaceWith(from, to, order.flatMap((i) => groups[i]));
  tr.setSelection(TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(tr.mapping.map(to, -1))));
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** Every paragraph (textblock) under a cell as JSON, in order, so nested tables and other containers flatten into their paragraphs. */
function cellParas(cell) {
  const out = [];
  cell.descendants((n) => {
    if (!n.isTextblock) return true;
    out.push(n.toJSON());
    return false;
  });
  return out;
}

/** A paragraph node from block JSON `p`; a block whose type cannot hold the joined content becomes a plain paragraph. */
function paraOf(schema, p) {
  try {
    const node = schema.nodeFromJSON(p);
    node.check();
    return node;
  } catch {
    return schema.nodeFromJSON({ type: 'paragraph', ...(p.content?.length && { content: p.content }) });
  }
}

// ---------- commands ----------

const table = (run, extra = {}) => ({ run, enabled: inTable, ...extra });
const select = (pick) => table((ctx) => {
  const t = tbl(ctx);
  const [y0, x0, y1, x1] = pick(t);
  return selectRect(viewOf(ctx), t, y0, x0, y1, x1);
});

/** Table Row Height's spinner value: the selected rows' height when they agree (the drawn one with none set), else blank. */
function rowHeight(ctx) {
  const t = tbl(ctx);
  if (!t) return null;
  const hs = Array.from({ length: t.bottom - t.top }, (_, i) => t.node.child(t.top + i).attrs.height?.value ?? null);
  if (hs.some((h) => h !== hs[0])) return null;
  return hs[0] ?? round2(drawnHeight(viewOf(ctx), t, t.top));
}
const setRowHeight = (ctx, pt) => {
  const t = tbl(ctx);
  if (!t || !Number.isFinite(Number(pt))) return false;
  const value = Math.max(0, round2(Number(pt)));
  return patchNodes(viewOf(ctx), Array.from({ length: t.bottom - t.top }, (_, i) => rowPos(t, t.top + i)),
    (row) => ({ height: { ...row.attrs.height, value, rule: 'atLeast' } }));
};
/** The columns as drawn when the table has a preferred width (the view scales them to it), else their set widths (px). */
const colBase = (view, t) => (t.node.attrs.width ? drawnWidths(view, t) : widthsNow(view, t));
const colWidth = (ctx) => {
  const t = tbl(ctx);
  return t ? round2(colBase(viewOf(ctx), t)[t.left] / PX) : null;
};
const setColWidth = (ctx, pt) => {
  const t = tbl(ctx);
  if (!t || !Number.isFinite(Number(pt))) return false;
  const view = viewOf(ctx);
  const ws = colBase(view, t).map((w, x) => (x >= t.left && x < t.right ? Math.max(MIN_COLUMN, Number(pt) * PX) : w));
  // A set column width ends the preferred table width, which would scale the column again; the others keep their drawn widths.
  return writeWidths(view, t, ws, t.node.attrs.width ? { width: null } : null);
};

const COMMANDS = {
  // Table
  'tableLayout.table.select.selectCell': select((t) => [t.top, t.left, t.top, t.left]),
  'tableLayout.table.select.selectRow': select((t) => [t.top, 0, t.bottom - 1, t.map.width - 1]),
  'tableLayout.table.select.selectColumn': select((t) => [0, t.left, t.map.height - 1, t.right - 1]),
  'tableLayout.table.select.selectTable': select((t) => [0, 0, t.map.height - 1, t.map.width - 1]),
  'tableLayout.table.viewGridlines': {
    run: (ctx) => saveWord({ tableGridlines: !ctx.settings.word?.tableGridlines }),
    active: (ctx) => !!ctx.settings.word?.tableGridlines,
  },
  'tableLayout.table.properties': table(async (ctx, tab) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const was = propsValue(view, t);
    // Imported here: the dialog registry imports every module, this one included, so a load-time import would be circular.
    const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
    const out = await ctx.dialog('tableProperties', { value: was, tab: typeof tab === 'string' ? tab : 'table', borders: !!WORD_DIALOGS.bordersAndShading });
    const now = tableOf(view.state);
    return !!out && !!now && applyProps(view, now, out, was);
  }),

  // Rows & Columns
  'tableLayout.rowsColumns.delete.deleteCells': table(async (ctx) => {
    const mode = await ctx.dialog('deleteCells', {});
    if (!mode) return false;
    if (mode === 'row' || mode === 'column') return ctx.chain((c) => (mode === 'row' ? c.deleteRow() : c.deleteColumn()));
    return shift(ctx, mode, deleteCells);
  }),
  'tableLayout.rowsColumns.launcher': table(async (ctx) => {
    const mode = await ctx.dialog('insertCells', {});
    if (!mode) return false;
    const t = tbl(ctx);
    if ((mode === 'row' || mode === 'column') && hasSpans(t.node.toJSON())) {
      return ctx.chain((c) => (mode === 'row' ? c.addRowBefore() : c.addColumnBefore()));
    }
    return shift(ctx, mode, insertCells);
  }),

  // Merge
  'tableLayout.merge.splitCells': table(async (ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const several = t.map.cellsInRect(t).length > 1;
    const o = await ctx.dialog('splitCells', { several });
    if (!o) return false;
    const { state } = view;
    let tr = state.tr;
    let cells = t.map.cellsInRect(t).map((rel) => t.map.findCell(rel));
    if (several && o.merge) {
      mergeCells(state, (m) => { tr = m; });
      cells = [{ top: t.top, left: t.left }];
    }
    let json = tr.doc.nodeAt(t.pos).toJSON();
    // Bottom right first, so the cells still to split keep their grid places.
    for (const c of cells.sort((a, b) => b.top - a.top || b.left - a.left)) json = splitCell(json, c.top, c.left, o.cols, o.rows) ?? json;
    const node = state.schema.nodeFromJSON(json);
    tr.replaceWith(t.pos, t.pos + tr.doc.nodeAt(t.pos).nodeSize, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(t.pos + 3)));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }),
  'tableLayout.merge.splitTable': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const { schema } = view.state;
    const para = schema.nodes.paragraph.create();
    const tr = view.state.tr;
    if (t.top === 0) {
      tr.insert(t.pos, para);
      tr.setSelection(TextSelection.near(tr.doc.resolve(t.pos + 1)));
    } else {
      const json = t.node.toJSON();
      if (gridOf(json).cells.some((c) => c.y < t.top && c.y + c.rs > t.top)) {
        ctx.toast(SPANS);
        return false;
      }
      const a = schema.nodeFromJSON({ ...json, content: json.content.slice(0, t.top) });
      const b = schema.nodeFromJSON({ ...json, content: json.content.slice(t.top) });
      tr.replaceWith(t.pos, t.pos + t.node.nodeSize, [a, para, b]);
      tr.setSelection(TextSelection.near(tr.doc.resolve(t.pos + a.nodeSize + 1)));
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }),

  // Cell Size
  'tableLayout.cellSize.autoFit.autoFitContents': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const m = contentWidths(view, t);
    if (!m) return false;
    let ws = m.widths.map((w) => Math.max(MIN_COLUMN, Math.ceil(w)));
    const total = ws.reduce((s, w) => s + w, 0);
    if (total > m.text) ws = ws.map((w) => Math.max(MIN_COLUMN, (w * m.text) / total));
    return writeWidths(view, t, ws, { layout: 'autofit', width: null });
  }),
  'tableLayout.cellSize.autoFit.autoFitWindow': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    // The columns keep their proportions: the table view draws them as shares of the width (table-view.js).
    return writeWidths(view, t, widthsNow(view, t), { layout: 'autofit', width: { w: 100, type: 'pct' } });
  }),
  'tableLayout.cellSize.autoFit.fixedColumnWidth': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    return writeWidths(view, t, drawnWidths(view, t), { layout: 'fixed', width: null });
  }),
  'tableLayout.cellSize.tableRowHeight': table(setRowHeight, { value: rowHeight }),
  'tableLayout.cellSize.tableRowHeight.more': table((ctx) => setRowHeight(ctx, (rowHeight(ctx) ?? 0) + tenth(ctx))),
  'tableLayout.cellSize.tableRowHeight.less': table((ctx) => setRowHeight(ctx, Math.max(0, (rowHeight(ctx) ?? 0) - tenth(ctx)))),
  'tableLayout.cellSize.tableColumnWidth': table(setColWidth, { value: colWidth }),
  'tableLayout.cellSize.tableColumnWidth.more': table((ctx) => setColWidth(ctx, colWidth(ctx) + tenth(ctx))),
  'tableLayout.cellSize.tableColumnWidth.less': table((ctx) => setColWidth(ctx, colWidth(ctx) - tenth(ctx))),
  'tableLayout.cellSize.distributeRows': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const rows = span(t.top, t.bottom, t.map.height);
    const avg = round2(rows.reduce((s, y) => s + drawnHeight(view, t, y), 0) / rows.length);
    return patchNodes(view, rows.map((y) => rowPos(t, y)), (row) => ({ height: { ...row.attrs.height, value: avg, rule: 'atLeast' } }));
  }),
  'tableLayout.cellSize.distributeColumns': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const cols = span(t.left, t.right, t.map.width);
    const ws = widthsNow(view, t);
    const avg = cols.reduce((s, x) => s + ws[x], 0) / cols.length;
    return writeWidths(view, t, ws.map((w, x) => (cols.includes(x) ? avg : w)));
  }),

  // Alignment
  'tableLayout.alignment.textDirection': table((ctx) => {
    const view = viewOf(ctx);
    const t = tbl(ctx);
    const cells = selectedCells(t, view.state);
    const next = NEXT_DIR[cells[0].node.attrs.textDir ?? 'lrTb'] ?? 'tbRl';
    return patchNodes(view, cells.map((c) => c.pos), () => ({ textDir: next === 'lrTb' ? null : next }));
  }, { value: (ctx) => { const t = tbl(ctx); return t ? ctx.state.doc.nodeAt(cellPos(t, t.top, t.left))?.attrs.textDir ?? 'lrTb' : null; } }),
  'tableLayout.alignment.cellMargins': table(async (ctx) => {
    const out = await ctx.dialog('tableOptions', { value: optionsValue(tbl(ctx).node.attrs) });
    const t = tableOf(viewOf(ctx).state);
    return !!out && !!t && patchNodes(viewOf(ctx), [t.pos], () => optionsPatch(out));
  }),

  // Data
  'home.paragraph.sort': {
    run: async (ctx) => {
      const view = viewOf(ctx);
      if (!view) return false;
      const t = tbl(ctx);
      const texts = t ? null : sortBlocks(view.state).nodes.map((n) => n.textContent);
      if (!t && texts.length < 2) {
        ctx.toast('Select the paragraphs to sort.');
        return false;
      }
      const info = t ? tableSortInfo(t) : null;
      // The sorting language: the caret's text language, else the document's proofing language.
      const lang = view.state.selection.$from.marks().map((m) => m.attrs.lang?.val).find(Boolean) ?? ctx.settings.word?.proofing?.languages?.[0] ?? 'en-US';
      const o = await ctx.dialog('sort', t
        ? { mode: 'table', lang, cols: info.cols, heads: info.heads, header: info.header, columnSel: t.bottom - t.top === t.map.height && t.right - t.left === 1 && t.map.height > 1, column: t.left }
        : { mode: 'text', lang, texts });
      if (!o) return false;
      const now = tableOf(view.state);
      return t ? !!now && sortTable(ctx, view, now, o) : sortText(view, o);
    },
  },
  'tableLayout.data.repeatHeaderRows': table((ctx) => {
    const t = tbl(ctx);
    const on = !t.node.child(t.top).attrs.header;
    return patchNodes(viewOf(ctx), Array.from({ length: t.bottom }, (_, y) => rowPos(t, y)), () => ({ header: on }));
  }, { active: (ctx) => { const t = tbl(ctx); return !!t && !!t.node.child(t.top).attrs.header; } }),
  'tableLayout.data.convertToText': table(async (ctx) => {
    let t = tbl(ctx);
    let nested = false;
    t.node.descendants((n) => { nested ||= n.type.name === 'table'; return !nested; });
    const o = await ctx.dialog('convertTableToText', { nested });
    const view = viewOf(ctx);
    t = tableOf(view.state);
    if (!o || !t) return false;
    const rows = [];
    t.node.forEach((row) => rows.push(Array.from({ length: row.childCount }, (_, i) => cellParas(row.child(i)))));
    const { schema } = view.state;
    const paras = tableToText(rows, o.sep).map((p) => paraOf(schema, p));
    const tr = view.state.tr.replaceWith(t.pos, t.pos + t.node.nodeSize, paras);
    tr.setSelection(TextSelection.near(tr.doc.resolve(t.pos + 1)));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return true;
  }),
};

/** View Gridlines: data-table-gridlines on #editor-area while settings.word.tableGridlines is on (style.css draws them). */
function setup() {
  const area = () => document.getElementById('editor-area');
  const sync = () => area()?.toggleAttribute('data-table-gridlines', !!wordSettings(getState().settings).tableGridlines);
  sync();
  const off = subscribe(sync);
  return () => {
    off();
    area()?.removeAttribute('data-table-gridlines');
  };
}

export default {
  id: 'table-layout',
  commands: COMMANDS,
  dialogs: { tableProperties: TableProperties, tableOptions: TableOptions, cellOptions: CellOptions, insertCells: InsertCells, deleteCells: DeleteCells,
    splitCells: SplitCells, sort: SortDialog, sortOptions: SortOptions, convertTableToText: ConvertTableToText },
  // Menus that open through their items, and the Row tab's check box (tables.rowBreak: tableRow.cantSplit).
  implements: ['tableLayout.table.select', 'tableLayout.rowsColumns.delete', 'tableLayout.cellSize.autoFit', 'tables.rowBreak'],
  setup,
};

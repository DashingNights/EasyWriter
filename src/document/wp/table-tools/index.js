// Table tools (docs/plans/word/plan.md §3 table-tools, briefs/table-tools.md): Insert Table and Convert Text to Table, Draw Table,
// Eraser and Border Painter, Word's table keys, the handles and selection pointers, border drag modifiers and nested tables.
// The Table grid itself stays base's (insert.tables.table); Quick Tables are building-blocks', Excel Spreadsheet a placeholder.
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { getState, setState } from '../../../app/store.js';
import { commandOf } from '../../../tooling/registry.js';
import { saveWord } from '../../word/settings.mjs';
import { ConvertTextToTableDialog, InsertTableDialog } from './dialogs.jsx';
import { TableTab } from './keys.js';
import { cellMove, convertSource, convertTr, insertTableTr, makeTable, moveRow, rowAtEdge, splitTable, tableOf, updateAutoFormat } from './ops.js';
import { setTool, TablePointersExt } from './pointer.js';

/** Dispatches `tr` on the command's target editor. → whether there was one (false lets a key go on). */
const apply = (ctx, tr) => {
  if (!tr || !ctx.target) return false;
  ctx.target.view.dispatch(tr);
  return true;
};
const inTable = (ctx) => ctx.in.table;
const NOT_IN_TABLE = 'Put the cursor in a table first.';
const SPAN_BLOCKS = 'A cell that spans rows is in the way.';
const tableCmd = (fn) => ({ run: (ctx, arg) => apply(ctx, ctx.state && fn(ctx.state, arg)), enabled: inTable, reason: () => NOT_IN_TABLE });

/** A pointer tool's toggle: on, or off when it is already the tool. Arg {pen} (table-design's pen pick) arms it with that pen. */
const tool = (name) => ({
  run: (_ctx, arg) => {
    if (arg?.pen) setState({ word: { ...getState().word, pen: { ...getState().word?.pen, ...arg.pen } } });
    setTool(arg?.pen || getState().word?.tableTool !== name ? name : null);
    return true;
  },
  active: () => getState().word?.tableTool === name,
});

const AUTOFIT_CONTENTS = 'tableLayout.cellSize.autoFit.autoFitContents';

/** Makes the table AutoFit to contents asked for, through table-layout's command once it exists. */
const fitContents = (ctx, fit) => {
  if (fit?.kind === 'contents' && commandOf(AUTOFIT_CONTENTS)) ctx.run(AUTOFIT_CONTENTS);
};

const commands = {
  'insert.tables.table.insertTable': {
    run: async (ctx) => {
      const ed = ctx.target;
      const r = await ctx.dialog('insertTable', { initial: ctx.settings?.word?.insertTable ?? null });
      if (!r || !ed || ed.isDestroyed) return false;
      saveWord({ insertTable: r.remember ? { cols: r.cols, rows: r.rows, autofit: r.fit } : null }).catch(() => {});
      ed.view.dispatch(insertTableTr(ed.state.tr, makeTable(ed.state.schema, r.rows, r.cols, r.fit)));
      ed.view.focus();
      fitContents(ctx, r.fit);
      return true;
    },
  },
  'insert.tables.table.convertTextToTable': {
    run: async (ctx) => {
      const ed = ctx.target;
      const src = ctx.state && convertSource(ctx.state);
      if (!src) return false;
      const r = await ctx.dialog('convertTextToTable', { texts: src.texts });
      const now = r && ed && !ed.isDestroyed && convertSource(ed.state);
      if (!now) return false;
      ed.view.dispatch(convertTr(ed.state, now, r));
      ed.view.focus();
      fitContents(ctx, r.fit);
      return true;
    },
    enabled: (ctx) => !!ctx.state && !!convertSource(ctx.state),
    reason: (ctx) => (ctx.state && !ctx.state.selection.empty
      ? 'Select paragraphs only. The selection holds a table or object.'
      : 'Select the text to turn into a table.'),
  },
  'insert.tables.table.drawTable': tool('draw'),
  'tableLayout.draw.drawTable': tool('draw'),
  'tableLayout.draw.eraser': tool('erase'),
  'tableDesign.borders.borderPainter': tool('paint'),

  // Keys (keymap.mjs rows; arg 'extend' with Shift selects cells to there).
  'tables.cellNavigation': tableCmd((s, arg) => cellMove(s, 'rowStart', arg === 'extend')),
  'tables.endOfRow': tableCmd((s, arg) => cellMove(s, 'rowEnd', arg === 'extend')),
  'tables.startOfColumn': tableCmd((s, arg) => cellMove(s, 'colStart', arg === 'extend')),
  'tables.endOfColumn': tableCmd((s, arg) => cellMove(s, 'colEnd', arg === 'extend')),
  // Word moves a row at the table's edge out of the table; here it stays (recorded deviation).
  'tables.moveRow': {
    run: (ctx, arg) => {
      const dir = arg === 'up' ? 'up' : 'down';
      if (!ctx.state) return false;
      if (apply(ctx, moveRow(ctx.state, dir))) return true;
      if (rowAtEdge(ctx.state, dir)) return false;
      ctx.toast(SPAN_BLOCKS);
      return true;
    },
    enabled: inTable,
    reason: () => NOT_IN_TABLE,
  },
  // splitTable refuses only when a cell spans across the caret's row.
  'tables.splitTableKey': {
    run: (ctx) => {
      if (!ctx.state || !inTable(ctx)) return false; // outside a table the key goes on
      if (!apply(ctx, splitTable(ctx.state))) ctx.toast(SPAN_BLOCKS);
      return true;
    },
    enabled: inTable,
    reason: () => NOT_IN_TABLE,
  },
  'tables.updateAutoFormat': tableCmd(updateAutoFormat),
  // Alt+Num5 is table-layout's Select Table; this alias finds it in tool search and selects the table itself until that lands.
  'tables.selectTable': {
    run: (ctx) => {
      if (commandOf('tableLayout.table.select.selectTable')) return ctx.run('tableLayout.table.select.selectTable');
      const t = ctx.state && tableOf(ctx.state.selection.$from);
      if (!t) return false;
      const { map } = TableMap.get(t.node);
      return apply(ctx, ctx.state.tr.setSelection(CellSelection.create(ctx.state.doc, t.pos + 1 + map[0], t.pos + 1 + map.at(-1))));
    },
    enabled: inTable,
    reason: () => NOT_IN_TABLE,
  },
};

export default {
  id: 'table-tools',
  extensions: [TableTab, TablePointersExt],
  commands,
  dialogs: { insertTable: InsertTableDialog, convertTextToTable: ConvertTextToTableDialog },
  // Behaviours with no command of their own.
  implements: ['tables.tabKeys', 'tables.handles', 'tables.columnBorderDrag', 'tables.nested', 'selection.tablePointers'],
};

// Newspaper columns (docs/plans/word/briefs/columns.md): the Columns menu and More Columns, column breaks (Ctrl+Shift+Enter, Breaks >
// Column) and the columns node's view. model.mjs holds the pure rules; pagination.js lays the columns out on pages.
import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';
import { ColumnsDialog } from './ColumnsDialog.jsx';
import { pxToPt } from '../../../office.mjs';
import { paperOf } from '../page-engine/layout.mjs';
import { applyColumns, applyToOptions, insertColumnBreak, preset, presetOf, scopeOf, stateOf, unitsOf } from './model.mjs';

/** The columns node's view: model.mjs attributes as CSS, and pagination's layout attributes (data-cols-mode, --cols-*) left alone. */
class ColumnsView {
  constructor(node) {
    this.dom = document.createElement('div');
    this.dom.dataset.columns = '';
    this.contentDOM = this.dom;
    this.node = node;
    this.draw(node);
  }

  draw(node) {
    const { count, space, sep, equal } = node.attrs;
    const s = this.dom.style;
    this.dom.dataset.count = String(count);
    s.columnCount = String(count);
    s.columnGap = `${space}pt`;
    s.columnRule = sep ? '0.75pt solid currentColor' : '';
    if (equal === false) this.dom.dataset.equal = 'false';
    else delete this.dom.dataset.equal;
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs) this.draw(node);
    this.node = node;
    return true;
  }

  ignoreMutation(m) {
    return m.type === 'attributes' && m.target === this.dom;
  }
}

const ColumnsViews = Extension.create({
  name: 'wordColumns',
  addProseMirrorPlugins: () => [new Plugin({ props: { nodeViews: { columns: (node) => new ColumnsView(node) } } })],
});

/** The text width of the selection's section in points. */
const textOf = (ctx) => pxToPt(paperOf(ctx.sect, { gutterAtTop: !!ctx.ed.state.doc.attrs.settings?.gutterAtTop }).text);

/** The columns attrs at the selection head, or null in one-column text. */
const colsAt = (state) => {
  const $h = state.selection.$head;
  return $h.depth >= 1 && $h.node(1).type.name === 'columns' ? $h.node(1).attrs : null;
};

const bodyOnly = (ctx) => !!ctx.ed && ctx.story === 'body' && ctx.target === ctx.ed;

/** Sets columns `attrs` (null: one column) over `scope` (model.mjs scopeOf) as one undo step. */
function apply(ctx, attrs, scope, opts) {
  const ed = ctx.ed;
  const { state } = ed;
  const range = scopeOf(state.doc, unitsOf(state.doc), state.selection, scope);
  const tr = state.tr;
  if (!range || !applyColumns(tr, range[0], range[1], attrs, opts)) return false;
  // Each layout change is its own undo step, as in Word, however soon it follows the last edit.
  ed.view.dispatch(closeHistory(tr).scrollIntoView());
  ed.view.focus();
  return true;
}

/** The scope of the Columns menu: the selection, else the section holding the caret (Word's own). */
const menuScope = (state) => {
  const { selection: sel } = state;
  if (sel.empty) return 'section';
  return applyToOptions(state.doc, sel)[0][0];
};

const setPreset = (ctx, id) => {
  if (!bodyOnly(ctx)) return false;
  const attrs = preset(id, textOf(ctx));
  return attrs !== undefined && apply(ctx, attrs, menuScope(ctx.ed.state));
};

const PRESET_IDS = ['one', 'two', 'three', 'left', 'right'];

const COMMANDS = {
  'layout.pageSetup.columns': { run: (ctx, id) => (PRESET_IDS.includes(id) ? setPreset(ctx, id) : false), enabled: bodyOnly,
    value: (ctx) => (ctx.ed ? presetOf(colsAt(ctx.ed.state)) : null) },
  ...Object.fromEntries(PRESET_IDS.map((id) => [`layout.pageSetup.columns.${id}`, {
    run: (ctx) => setPreset(ctx, id),
    enabled: bodyOnly,
    active: (ctx) => !!ctx.ed && presetOf(colsAt(ctx.ed.state)) === id,
  }])),
  'layout.pageSetup.columns.moreColumns': {
    enabled: bodyOnly,
    run: async (ctx) => {
      if (!bodyOnly(ctx)) return false;
      const text = textOf(ctx);
      const { state } = ctx.ed;
      const out = await ctx.dialog('columns', { value: stateOf(colsAt(state), text), text, applyTo: applyToOptions(state.doc, state.selection) });
      if (!out) return false;
      return apply(ctx, out.attrs, out.scope, { newColumn: out.newColumn });
    },
  },
  'layout.pageSetup.breaks.column': {
    // In a table Ctrl+Shift+Enter is table-tools' split (its keymap row wins there); this declines, so the key falls through.
    enabled: (ctx) => bodyOnly(ctx) && !ctx.in.table,
    run: (ctx) => {
      if (!bodyOnly(ctx) || ctx.in.table) return false;
      const tr = ctx.ed.state.tr;
      if (!insertColumnBreak(tr)) return false;
      ctx.ed.view.dispatch(tr.scrollIntoView());
      return true;
    },
  },
};

export default {
  id: 'columns',
  extensions: [ColumnsViews],
  commands: COMMANDS,
  dialogs: { columns: ColumnsDialog },
  // Recorded limits: a node flowing over pages fills column 1 first on its last page (Word balances it when text follows), so text after
  // it shares that page only when the last page's column text stays in column 1; one too long for the room left starts at the next
  // page top; a column break in a table, text box, block content control or field does nothing; Left, Right and custom widths keep their data but draw equal (CSS multicol), so
  // columns.unequalWidths is not claimed; a nextColumn section break starts a new page.
  implements: ['columns.flow', 'columns.balance', 'columns.lineBetween', 'columns.limits'],
};

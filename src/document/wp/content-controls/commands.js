// The Developer tab's commands, the Document Property items and Ctrl+Shift+X (plan.md §1.3, §3 content-controls).
import { closeHistory } from '@tiptap/pm/history';
import { paneOpen } from '../../../tooling/panes.jsx';
import { insertFormField, kindOf, resetFormFields } from './forms.jsx';
import { boundDate, DOC_PROPS, ffResult, newSdt, propValue } from './model.mjs';
import { controlAt, flags, insertControl, KEY, sdtOf, selectedControl, unwrapControl } from './ops.js';

const OPTIONS_DIALOG = { text: 'textFormFieldOptions', checkBox: 'checkBoxFormFieldOptions', dropDown: 'dropDownFormFieldOptions' };

/** Redraws every Document editor after a view flag changed (the flags reach the DOM through the plugin's attributes). */
function refresh(ctx) {
  for (const ed of new Set([ctx.ed, ctx.target])) if (ed?.view && !ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta(KEY, true));
}

const can = (ctx) => !!ctx.target;
const insert = (make, opts) => ({ run: (ctx) => insertControl(ctx.target, make(), opts), enabled: can });

/** Inserts a control of `kind` bound to props `path` (Document Property items, the XML Mapping pane) at the caret. */
export function insertBound(ctx, kind, path, label) {
  const type = kind === 'date' ? 'date' : kind;
  const sdt = newSdt(type, { binding: { prop: path }, ...(type !== 'checkbox' && type !== 'picture' && { placeholder: `[${label}]` }) });
  // The main editor owns the props; a header's story editor only mirrors them (extension.js storyProps).
  const value = propValue((ctx.ed ?? ctx.target).state.doc.attrs.props ?? {}, path);
  if (type === 'checkbox') {
    const on = value === 'true' || value === '1';
    return insertControl(ctx.target, { ...sdt, checked: on }, { wrap: false, content: on ? '☒' : '☐' });
  }
  if (type === 'date') {
    // Stored as Word stores PublishDate (yyyy-MM-dd), shown in the control's format.
    const shown = boundDate(sdt.date, value);
    sdt.date = { ...sdt.date, store: 'date', full: shown.full };
    return insertControl(ctx.target, sdt, { wrap: false, content: shown.text || undefined });
  }
  return insertControl(ctx.target, sdt, { wrap: false, content: value || undefined });
}

/** The Document Property command of a gallery: arg is the item id ('title'). */
const docProperty = {
  run: (ctx, arg) => {
    const hit = DOC_PROPS.find(([id]) => id === arg);
    if (!hit) return false;
    return insertBound(ctx, hit[0] === 'publishDate' ? 'date' : 'text', hit[2], hit[1]);
  },
  enabled: can,
};

/** Opens the options dialog of the form field at `pos` in `editor` and writes the result (its bookmark pair follows a rename). */
export async function formFieldOptions(ctx, editor, pos) {
  const node = editor.state.doc.nodeAt(pos);
  const kind = kindOf(node);
  if (!kind) return false;
  const ff = await ctx.dialog(OPTIONS_DIALOG[kind], { ff: node.attrs.ff });
  const now = editor.state.doc.nodeAt(pos);
  if (!ff || now !== node) return false;
  const tr = editor.state.tr;
  const oldName = node.attrs.ff?.name;
  if (ff.name && oldName && ff.name !== oldName) {
    tr.doc.descendants((n, p) => {
      if (n.type.name === 'bookmark' && n.attrs.name === oldName) tr.setNodeMarkup(p, null, { ...n.attrs, name: ff.name });
    });
  }
  const value = kind === 'text' ? (node.attrs.result?.trim() ? node.attrs.result : ff.default) : '';
  tr.setNodeMarkup(pos, null, { ...node.attrs, ff, result: ffResult(kind, ff, value) }, node.marks);
  editor.view.dispatch(closeHistory(tr));
  return true;
}

/** Properties: the form field options of a selected form field, else Content Control Properties for the control at the caret. */
async function properties(ctx) {
  const ed = ctx.target;
  const { state } = ed;
  if (kindOf(state.selection.node)) return formFieldOptions(ctx, ed, state.selection.from);
  const c = selectedControl(state);
  if (!c) return false;
  const sdt = await ctx.dialog('contentControlProperties', { sdt: c.node.attrs.sdt ?? {} });
  const node = ed.state.doc.nodeAt(c.pos);
  if (!sdt || node !== c.node) return false;
  const tr = ed.state.tr.setMeta(KEY, true); // a property change is the user's own, so a new lock does not refuse it
  const old = sdtOf(node);
  if (old.type === 'checkbox' && (sdt.checkedChar !== old.checkedChar || sdt.uncheckedChar !== old.uncheckedChar)) {
    tr.replaceWith(c.pos + 1, c.pos + node.nodeSize - 1, ed.state.schema.text(sdt.checked ? sdt.checkedChar : sdt.uncheckedChar));
  }
  tr.setNodeMarkup(c.pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, ...sdt } }, node.marks);
  ed.view.dispatch(closeHistory(tr));
  return true;
}

/** Group: wraps the selection in a group control (inline inside one paragraph, else around its paragraphs); Ungroup removes the
 * group around the caret. */
function group(ctx, arg = 'group') {
  const ed = ctx.target;
  if (arg === 'ungroup') {
    const g = ed.state.selection.node?.attrs.sdt?.type === 'group' ? { pos: ed.state.selection.from } : controlAt(ed.state.selection.$from, 'group');
    if (!g) return false;
    ed.view.dispatch(unwrapControl(ed.state.tr, g.pos).setMeta(KEY, true));
    return true;
  }
  const { $from, $to, empty } = ed.state.selection;
  return insertControl(ed, newSdt('group'), { block: empty || !$from.sameParent($to) || ($from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size) });
}

/** A Repeating Section around the selected paragraphs (the caret's paragraph when nothing is selected), holding one item. */
function repeating(ctx) {
  const ed = ctx.target;
  const { schema } = ed.state;
  const { $from, $to } = ed.state.selection;
  const range = $from.blockRange($to);
  if (!range) return false;
  const tr = ed.state.tr.wrap(range, [{ type: schema.nodes.sdtBlock, attrs: { sdt: newSdt('repeating') } },
    { type: schema.nodes.sdtBlock, attrs: { sdt: newSdt('repeatingItem') } }]);
  ed.view.dispatch(tr.scrollIntoView());
  return true;
}

export const COMMANDS = {
  'developer.controls.richTextContentControl': insert(() => newSdt('richText')),
  'developer.controls.plainTextContentControl': insert(() => newSdt('text')),
  'developer.controls.pictureContentControl': insert(() => newSdt('picture'), { wrap: false }),
  'developer.controls.buildingBlockGalleryContentControl': insert(() => newSdt('docPart', { docPart: { gallery: 'Quick Parts', category: null } }), { block: true }),
  'developer.controls.checkBoxContentControl': insert(() => newSdt('checkbox'), { wrap: false, content: '☐' }),
  'developer.controls.comboBoxContentControl': insert(() => newSdt('comboBox'), { wrap: false }),
  'developer.controls.dropDownListContentControl': insert(() => newSdt('dropDown'), { wrap: false }),
  'developer.controls.datePickerContentControl': insert(() => newSdt('date'), { wrap: false }),
  'developer.controls.repeatingSectionContentControl': { run: repeating, enabled: can },
  'developer.controls.designMode': {
    run: (ctx) => {
      flags.design = !flags.design;
      refresh(ctx);
      return true;
    },
    active: () => flags.design,
  },
  'developer.controls.properties': {
    run: properties,
    enabled: (ctx) => !!ctx.state && (!!kindOf(ctx.state.selection.node) || !!selectedControl(ctx.state)),
    reason: () => 'Put the caret in a content control or select a form field first.',
  },
  'developer.controls.group': { run: group, enabled: can },
  'developer.controls.legacyTools': { run: () => true, enabled: can }, // the control only opens its menu
  'developer.controls.legacyTools.textFormField': { run: (ctx) => insertFormField(ctx.target, 'text'), enabled: can },
  'developer.controls.legacyTools.checkBoxFormField': { run: (ctx) => insertFormField(ctx.target, 'checkBox'), enabled: can },
  'developer.controls.legacyTools.dropDownFormField': { run: (ctx) => insertFormField(ctx.target, 'dropDown'), enabled: can },
  'developer.controls.legacyTools.formFieldShading': {
    run: (ctx) => ctx.chain((c) => c.setDocSettings({ formShading: ctx.state.doc.attrs.settings?.formShading === false })),
    active: (ctx) => ctx.state?.doc.attrs.settings?.formShading !== false,
    enabled: can,
  },
  'developer.controls.legacyTools.resetFormFields': { run: (ctx) => resetFormFields(ctx.target.view), enabled: can },
  'developer.mapping.xmlMappingPane': { run: (ctx) => ctx.pane('xmlMapping'), active: () => paneOpen('xmlMapping') },
  'keys.xmlTags': {
    run: (ctx) => {
      flags.tags = !flags.tags;
      refresh(ctx);
      return true;
    },
    active: () => flags.tags,
  },
  'insert.text.quickParts.documentProperty': docProperty,
  'headerFooter.insert.documentInfo.documentProperty': docProperty,
  'headerFooter.insert.documentInfo.documentTitle': { run: (ctx) => docProperty.run(ctx, 'title'), enabled: can },
};

const docPropItems = () => DOC_PROPS.map(([id, label]) => ({ id, label }));

export const GALLERIES = {
  'insert.text.quickParts.documentProperty': docPropItems,
  'headerFooter.insert.documentInfo.documentProperty': docPropItems,
  'developer.controls.group': Object.assign(() => [{ id: 'group', label: 'Group' }, { id: 'ungroup', label: 'Ungroup' }], { engine: true }),
};

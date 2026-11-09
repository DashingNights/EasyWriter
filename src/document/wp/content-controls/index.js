// Content controls and legacy forms (docs/plans/word plan.md §3 content-controls): the Developer tab's controls, Content Control
// Properties, Document Property controls bound to doc.attrs.props, the XML Mapping pane, Ctrl+Shift+X, and the legacy FORMTEXT,
// FORMCHECKBOX and FORMDROPDOWN fields with their options dialogs.
import { COMMANDS, GALLERIES } from './commands.js';
import { CheckBoxFormFieldOptions, ContentControlChoice, ContentControlProperties, DropDownFormFieldOptions, FormFieldHelpText, TextFormFieldOptions } from './dialogs.jsx';
import { ContentControls, openFieldOptions } from './extension.js';
import { computeField } from '../../fields/engine.js';
import { computedCode, EN_SPACES } from './model.mjs';
import { XmlMappingPane } from './pane.jsx';
import './marks.jsx'; // field shading, form field shading and content control tags over a canvas draft's pages

/** A legacy form field type: the stored result stands (the user types it under protection), except that Current date, Current
 * time and Calculation text fields compute theirs through DATE, TIME and = (fields-core); a click opens the options. */
const formField = {
  category: '(code only)', // not in the Field dialog's lists (index-fields.md)
  updates: 'manual',
  compute: (f, ctx) => {
    const node = ctx.doc.nodeAt(ctx.pos);
    const code = computedCode(node?.attrs.ff);
    return (code && computeField(code, ctx)) ?? { text: node?.attrs.result ?? EN_SPACES, raw: true };
  },
  click: (f, ctx, api) => openFieldOptions(api.editor.view)(api.getPos()),
};

export default {
  id: 'content-controls',
  extensions: [ContentControls],
  commands: COMMANDS,
  galleries: GALLERIES,
  dialogs: {
    contentControlProperties: ContentControlProperties,
    contentControlChoice: ContentControlChoice,
    textFormFieldOptions: TextFormFieldOptions,
    checkBoxFormFieldOptions: CheckBoxFormFieldOptions,
    dropDownFormFieldOptions: DropDownFormFieldOptions,
    formFieldHelpText: FormFieldHelpText,
  },
  panes: { xmlMapping: { title: 'XML Mapping', side: 'right', Component: XmlMappingPane } },
  fields: { FORMTEXT: formField, FORMCHECKBOX: formField, FORMDROPDOWN: formField },
  implements: ['developer', 'fields.FORMTEXT', 'fields.FORMCHECKBOX', 'fields.FORMDROPDOWN'],
};

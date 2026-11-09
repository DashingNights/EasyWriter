// fields-core (docs/plans/word/plan.md §3 fields-core): the field engine's node views and keys, the Field and Date and Time
// dialogs, the general switches and the date, page, QUOTE, AUTONUM and legacy field types. Every other field package only
// registers its types into the engine (src/document/fields/engine.js).
import { confirmDialog } from '../../../app/actions.js';
import { getState, subscribe } from '../../../app/store.js';
import { layoutPass, updateFields } from '../../fields/engine.js';
import { parseField } from '../../fields/registry.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { COMMANDS, FieldRunMarks } from './commands.js';
import { DateTimeDialog } from './DateTimeDialog.jsx';
import { FieldDialog, FieldOptionsDialog } from './FieldDialog.jsx';
import { fieldTypes } from './types.mjs';
import { FieldsCore, fieldsMeta } from './view.js';

const FIELDS = fieldTypes(parseField);

/** On mount: a Document with dirty fields or settings.updateFields asks before refreshing them (Word asks the same on open), and a
 * change of the shading setting redraws the field shading. */
function setup(editor) {
  let dirty = !!editor.state.doc.attrs.settings?.updateFields;
  editor.state.doc.descendants((n) => {
    if (dirty) return false;
    if ((n.type.name === 'field' || n.type.name === 'fieldBlock') && n.attrs.dirty) dirty = true;
    return !dirty;
  });
  if (dirty) {
    // human: a mount is no trusted event, so without it the assistant's auto-confirm would answer for the user unseen.
    confirmDialog({ title: 'Update fields?', description: 'This document has fields that may read other files. Update them now?', confirmText: 'Update', human: true })
      .then((ok) => ok && !editor.isDestroyed && updateFields(editor, 'all', 'open'));
  }
  let shading = wordSettings(getState().settings).fieldShading;
  const off = subscribe(() => {
    const next = wordSettings(getState().settings).fieldShading;
    if (next === shading || editor.isDestroyed) return;
    shading = next;
    editor.view.dispatch(fieldsMeta(editor.state.tr, { redraw: true }));
  });
  return off;
}

export default {
  id: 'fields-core',
  extensions: [FieldsCore, FieldRunMarks],
  commands: COMMANDS,
  dialogs: { field: FieldDialog, fieldOptions: FieldOptionsDialog, dateAndTime: DateTimeDialog },
  fields: FIELDS,
  providers: {
    // DATE \l: the picture last chosen in Date and Time, else its default.
    lastDate: () => {
      const dt = wordSettings(getState().settings).dateTime ?? {};
      return dt.last ?? dt.format ?? null;
    },
  },
  passes: [layoutPass],
  // Behaviours without a command of their own (plan.md §1.2, §1.15): the general switches, nesting and whole-field selection.
  implements: ['fieldsUi.switches', 'fieldsUi.nesting', 'selection.fieldWhole'],
  setup,
};

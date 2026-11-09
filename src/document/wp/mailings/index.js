// Mail merge, envelopes and labels (docs/plans/word/plan.md §3 mailings, briefs/mailings.md): the Mailings tab's commands, its
// dialogs and the wizard pane, the merge field types with the `record` provider they read, and the preview and highlight view.
// The recipient list lives in the draft record, the user's choices in doc.attrs.merge, the record shown in the store (state.js).
import { activeSurface } from '../../../tooling/surface.js';
import { COMMANDS, mergeFieldGallery } from './commands.js';
import { CustomizeAddressList, FilterAndSort, FindDuplicates, FindEntry, MailMergeRecipients, TypeANewList } from './Lists.jsx';
import { CheckingAndReportingErrors, EditIndividualDocuments, InsertAddressBlock, InsertGreetingLine, InsertMergeField, MatchFields, PrintDocuments,
  RULE_DIALOGS } from './Fields.jsx';
import { EnvelopeOptions, EnvelopesAndLabels, LabelDetails, LabelOptions } from './Envelopes.jsx';
import { MailMergePane } from './Pane.jsx';
import { active } from './data.mjs';
import { FIELDS, makeCursor, MERGE_NAMES } from './fields.mjs';
import { MailingsView, watch } from './preview.js';
import { MERGE_DEFAULTS, previewOf, setPreview, sourceOf } from './state.js';
import './canvas.js';

/** The `record` provider (plan.md §1.10): a cursor at the previewed record, or null when Preview Results is off (merge fields then
 * show their chevrons). A merge seeds its own cursor into the update instead (merge.mjs). */
function record(ctx) {
  const n = previewOf();
  const source = sourceOf();
  if (n == null || !source) return null;
  // A story (a header, a note) has no merge attribute of its own: it merges with the main document's choices.
  const merge = { ...MERGE_DEFAULTS, ...(ctx.doc?.attrs?.merge ?? activeSurface()?.editor?.state.doc.attrs.merge ?? {}) };
  const list = active(source, merge);
  return list.length ? makeCursor(source, merge, list, Math.min(n, list.length) - 1) : null;
}

export default {
  id: 'mailings',
  extensions: [MailingsView],
  commands: COMMANDS,
  dialogs: {
    typeANewList: TypeANewList,
    customizeAddressList: CustomizeAddressList,
    mailMergeRecipients: MailMergeRecipients,
    filterAndSort: FilterAndSort,
    findDuplicates: FindDuplicates,
    findEntry: FindEntry,
    insertAddressBlock: InsertAddressBlock,
    insertGreetingLine: InsertGreetingLine,
    insertMergeField: InsertMergeField,
    matchFields: MatchFields,
    checkingAndReportingErrors: CheckingAndReportingErrors,
    editIndividualDocuments: EditIndividualDocuments,
    printDocuments: PrintDocuments,
    envelopesAndLabels: EnvelopesAndLabels,
    envelopeOptions: EnvelopeOptions,
    labelOptions: LabelOptions,
    labelDetails: LabelDetails,
    ...RULE_DIALOGS,
  },
  panes: { mailMerge: { title: 'Mail Merge', side: 'right', width: 18, Component: MailMergePane } },
  galleries: { 'mailings.writeInsertFields.insertMergeField': mergeFieldGallery },
  fields: FIELDS,
  providers: { record },
  implements: [
    'mailings', 'mailings.startMailMerge.startMailMerge', 'mailings.startMailMerge.selectRecipients', 'mailings.writeInsertFields.rules',
    'mailings.finish.finishMerge', 'keys.mailMergeKeys', ...MERGE_NAMES.map((n) => `fields.${n}`),
  ],
  setup(editor) {
    // A reopened merge previews where it was left (merge.preview); another draft starts without a preview.
    const kept = editor.state.doc.attrs.merge?.preview ?? null;
    setPreview(kept != null && sourceOf() ? kept : null);
    return watch(editor);
  },
};

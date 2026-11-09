// fields-info (docs/plans/word/briefs/fields-info.md): document properties (doc.attrs.props, only what the user types), File > Info's
// Properties column and the Advanced Properties dialog, the information and user fields, the FILLIN and ASK prompts, and Header &
// Footer > Document Info's Author, File Name and File Path. Statistics come from the draft record (plan.md §1.12), never the doc.
import { insertField } from '../../fields/engine.js';
import { ctxOf } from '../../../tooling/registry.js';
import { activeSurface } from '../../../tooling/surface.js';
import { bindPrompt, FIELDS } from './fields.mjs';
import { docInfo, linesOf, projectOf, savedBytes, writeProps } from './info.js';
import { InfoPropertiesPanel } from './InfoPanel.jsx';
import { AskDialog, FillInDialog } from './PromptDialog.jsx';
import { AdvancedPropertiesDialog } from './PropertiesDialog.jsx';

// The prompts open through the registry's dialog service (openDialog, stacked over an open dialog).
bindPrompt((id, props) => ctxOf().dialog(id, props));

/** Opens Advanced Properties on `tab` and merges its patch into the main editor's current props as one step. */
async function advanced(ed, tab) {
  const patch = await ctxOf().dialog('advancedProperties', { info: docInfo(ed), tab });
  if (patch) writeProps(ed, patch, { patch: true });
}

const hasDoc = (ctx) => !!ctx.ed;
/** A Document Info item: inserts field `code` into the story being edited (the header while it is open). */
const insert = (code) => ({ run: (ctx) => insertField(ctx.target, code), enabled: (ctx) => !!ctx.target });

export default {
  id: 'fields-info',
  fields: FIELDS,
  providers: {
    fileSize: () => savedBytes() || null,
    // Lines need the main view's line boxes: blank for any other doc or while the view is off screen.
    lines: (ctx) => {
      const ed = activeSurface()?.editor;
      return ed && ed.state.doc === ctx.doc ? linesOf(ed) : null;
    },
    project: () => projectOf() || null,
  },
  commands: {
    // Not awaited: run returns at once so callers (keys, the harness) are not held while the dialog is open.
    'file.info.properties': { run: (ctx, arg) => (void advanced(ctx.ed, arg?.tab), true), enabled: hasDoc },
    // A menu: registered so the dropdown draws enabled (Document Title and Document Property are content-controls').
    'headerFooter.insert.documentInfo': { run: () => true },
    'headerFooter.insert.documentInfo.author': insert('AUTHOR'),
    'headerFooter.insert.documentInfo.fileName': insert('FILENAME'),
    'headerFooter.insert.documentInfo.filePath': insert('FILENAME \\p'),
  },
  dialogs: { advancedProperties: AdvancedPropertiesDialog, fillIn: FillInDialog, ask: AskDialog },
  panels: { 'file.info.properties': InfoPropertiesPanel },
  implements: Object.keys(FIELDS).map((n) => `fields.${n}`),
};

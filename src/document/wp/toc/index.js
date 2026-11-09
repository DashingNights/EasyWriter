// toc: tables of contents, captions and tables of figures (docs/plans/word/briefs/toc.md). The pure builders are in toc.mjs, the
// editor operations in actions.js and the dialogs in dialogs.jsx.
import { createElement as h } from 'react';
import { Button } from '@/components/ui/button';
import { insertToc, inTable, rdProvider, removeToc, tableAt, tablesIn, TocKeys } from './actions.js';
import { askUpdate, DIALOGS } from './dialogs.jsx';
import { FIELDS } from './toc.mjs';

const TOC = 'references.tableOfContents.tableOfContents';
const body = (ctx) => !!ctx.ed && ctx.target === ctx.ed; // tables live in the main text, never in a header or a note
const hasToc = (ctx) => !!ctx.ed && tablesIn(ctx.ed.state.doc).some((t) => !t.figures);
const hasFieldToc = (ctx) => !!ctx.ed && tablesIn(ctx.ed.state.doc).some((t) => !t.figures && !t.manual); // a manual table has no field
const hasTof = (ctx) => !!ctx.ed && tablesIn(ctx.ed.state.doc).some((t) => t.figures);
const notInBody = () => 'Click in the main text first.';

const auto = (title) => ({ run: (ctx) => insertToc(ctx.ed, { title }), enabled: body, reason: notInBody });

const commands = {
  // The menu control itself runs from Alt+Shift+F12: Update Table inside a table of contents, nothing elsewhere.
  [TOC]: { run: (ctx) => (ctx.ed && inTable(ctx.ed.state) && !tableAt(ctx.ed.state)?.figures ? askUpdate() : false) },
  [`${TOC}.automaticTable1`]: auto('Contents'),
  [`${TOC}.automaticTable2`]: auto('Table of Contents'),
  [`${TOC}.manualTable`]: { run: (ctx) => insertToc(ctx.ed, { title: 'Table of Contents', manual: true }), enabled: body, reason: notInBody },
  [`${TOC}.customTableOfContents`]: { run: (ctx) => ctx.dialog('tableOfContents'), enabled: body, reason: notInBody },
  [`${TOC}.removeTableOfContents`]: { run: (ctx) => removeToc(ctx.ed), enabled: hasToc, reason: () => 'The document has no table of contents.' },
  'references.tableOfContents.updateTable': { run: () => askUpdate(), enabled: hasFieldToc, reason: () => 'The document has no table of contents with fields to update.' },
  'references.captions.insertCaption': { run: (ctx) => ctx.dialog('caption'), enabled: body, reason: notInBody },
  'references.captions.insertTableOfFigures': { run: (ctx) => ctx.dialog('tableOfFigures'), enabled: body, reason: notInBody },
  'references.captions.updateTable': { run: () => askUpdate({ figures: true }), enabled: hasTof, reason: () => 'The document has no table of figures.' },
  'fieldsUi.markTocEntry': {
    run: (ctx) => {
      const s = ctx.state;
      return ctx.dialog('markTableOfContentsEntry', { text: s ? s.doc.textBetween(s.selection.from, s.selection.to, ' ', '') : '' });
    },
    enabled: body,
    reason: notInBody,
  },
};

/** The table of contents control's title bar menu (content-controls draws it from panel 'sdt:Table of Contents', G7). */
function TocControlPanel({ close }) {
  return h(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: () => { close?.(); askUpdate(); } }, 'Update Table...');
}

export default {
  id: 'toc',
  extensions: [TocKeys],
  commands,
  dialogs: DIALOGS,
  fields: FIELDS,
  providers: { tocRd: rdProvider },
  panels: { 'sdt:Table of Contents': TocControlPanel },
};

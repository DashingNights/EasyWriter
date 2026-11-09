// Tab stops (docs/plans/word/plan.md §3 tabs, briefs/tabs.md): tab characters and alignment tabs laid out at Word's stops by a
// layout pass (plugin.js), the Tabs and Alignment Tab dialogs, and Ctrl+Tab where Tab does something else.
import { AlignmentTabDialog, TabsDialog } from './dialogs.jsx';
import { TabStops, tabPass } from './plugin.js';

export default {
  id: 'tabs',
  extensions: [TabStops],
  passes: [tabPass],
  dialogs: { tabs: TabsDialog, alignmentTab: AlignmentTabDialog },
  commands: {
    'tabs.dialog': { run: (ctx, arg) => ctx.dialog('tabs', arg) },
    'headerFooter.position.insertAlignmentTab': { run: (ctx) => ctx.dialog('alignmentTab'), enabled: (ctx) => !!ctx.target },
    // Ctrl+Tab (keymap row 'tabContext'): a tab character in a table cell, at a list item's start or in Outline view.
    'chars.tabInCell': { run: (ctx) => ctx.chain((c) => c.command(({ tr }) => !!tr.insertText('\t'))), enabled: (ctx) => !!ctx.target },
  },
  // tabs.inTables waits: a decimal stop in a cell does not align numbers without a tab yet (index.json gives it to the tables engine).
  implements: ['tabs.left', 'tabs.center', 'tabs.right', 'tabs.decimal', 'tabs.bar', 'tabs.leaders', 'tabs.defaultStops', 'tabs.measuredFromMargin',
    'tabs.hangingStop', 'tabs.wrapRules', 'tabs.limit', 'tabs.multipleChoice', 'lists.numberTab', 'indents.firstLine', 'indents.hanging'],
};

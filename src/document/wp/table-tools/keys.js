// Tab and Shift+Tab in a table (docs/plans/word/index-keys.md §Tables): the next or previous cell with its whole content selected,
// as Word does; Tab in the last cell adds a row first. Ahead of Table's own Tab (priority 100) and Lists' (102), which declines in
// a table. Word's other table keys are keymap.mjs rows that run index.js's commands.
import { Extension } from '@tiptap/core';
import { isInTable } from '@tiptap/pm/tables';
import { selectCellContent } from './ops.js';

const select = ({ tr }) => selectCellContent(tr);

export const TableTab = Extension.create({
  name: 'tableToolsTab',
  priority: 105,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (!isInTable(editor.state)) return false;
        if (editor.chain().goToNextCell().command(select).run()) return true;
        return editor.chain().addRowAfter().goToNextCell().command(select).run();
      },
      'Shift-Tab': ({ editor }) => isInTable(editor.state) && editor.chain().goToPreviousCell().command(select).run(),
    };
  },
});

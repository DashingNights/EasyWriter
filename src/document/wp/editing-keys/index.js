// editing-keys: Word's movement, selection and editing keys in Document text (docs/plans/word briefs/editing-keys.md). Forum posts
// never load it: their kit carries no work package extension.
import { Extension } from '@tiptap/core';
import { getState, subscribe } from '../../../app/store.js';
import { COMMANDS } from './commands.js';
import { ekKey, editingKeysPlugin, setWord, word } from './plugin.js';
import { UndoList } from './UndoList.jsx';
import { canvasKey, endMove, hooks } from '../../canvas/rows/home.mjs';
import { keyHooks } from '../../../engine/input/index.js';
import { focusedInput } from '../../../engine/input/viewport.js';

// On a canvas draft: Enter after F2 or Shift+F2 and the letter after an accent prefix (rows/home.mjs canvasKey), and the window
// edge moves through the focused view (src/engine/input/viewport.js).
keyHooks.add(canvasKey);
hooks.windowEdge = (end, extend) => focusedInput.current?.windowEdge(end, extend) ?? false;
// F2 and Shift+F2 on the canvas use the DOM editor's mode, so the status bar shows the same prompt; ending them leaves Extend alone.
hooks.setExtend = (kind) => {
  if (kind || ['move', 'copy'].includes(word().extend)) setWord({ extend: kind });
};
// Another draft ends a canvas F2's wait: its range is in the old draft's positions.
let draftId = getState().draft?.id;
subscribe(() => {
  const id = getState().draft?.id;
  if (id === draftId) return;
  draftId = id;
  endMove();
});

// Above textKeys (1100) and Lists (102), below WordKeys (1200), which runs the bind rows first.
const EditingKeys = Extension.create({
  name: 'wordEditingKeys',
  priority: 1150,
  addProseMirrorPlugins: () => [editingKeysPlugin()],
});

const goBackKey = (id) => `easywriter.goBack.${id}`;

/** Go Back right after a draft opens: the last edit position before it was closed, kept per draft in localStorage. */
function setup(editor) {
  const id = getState().draft?.id;
  if (!id) return undefined;
  try {
    const ring = JSON.parse(localStorage.getItem(goBackKey(id)) ?? '[]').filter((p) => Number.isInteger(p) && p <= editor.state.doc.content.size);
    if (ring.length) editor.view.dispatch(editor.state.tr.setMeta(ekKey, { ring }).setMeta('addToHistory', false));
  } catch { /* no storage: Go Back starts empty */ }
  let saved = null;
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = null;
    const ring = JSON.stringify(ekKey.getState(editor.state)?.ring ?? []);
    if (ring === saved) return;
    saved = ring;
    try {
      localStorage.setItem(goBackKey(id), ring);
    } catch { /* storage full or blocked */ }
  };
  // Typing moves the newest edit position on every keystroke, so the write waits for a pause; closing the draft writes at once.
  // ponytail: a deleted draft's key stays in localStorage (a few bytes each); drop it from the delete path if they pile up.
  const later = ({ transaction }) => {
    if (transaction.docChanged && !timer) timer = setTimeout(save, 1000);
  };
  editor.on('transaction', later);
  return () => {
    editor.off('transaction', later);
    if (timer) save();
  };
}

export default {
  id: 'editing-keys',
  extensions: [EditingKeys],
  commands: COMMANDS,
  panels: { 'frame.qat.undo': UndoList },
  setup,
  // Behaviours delivered without a command of their id: the native keys kept working, the mouse selections, the options and modes.
  implements: [
    'draw.undo.undo', 'draw.undo.redoRepeat', 'editing.repeat', 'editing.insertKey', 'editing.typingReplaces', 'editing.dragDrop',
    'editing.rightDrag', 'editing.clickAndType', 'editing.undoGrouping', 'editing.enterSplits', 'editing.joinRule', 'editing.lineBreak',
    'editing.delete', 'editing.deleteWordKeys', 'editing.deleteWordRight', 'editing.disabledKey', 'chars.altNumpad',
    'selection.autoWordSelect', 'selection.smartParagraph', 'selection.doubleClick', 'selection.tripleClick', 'selection.ctrlClick', 'selection.shiftClick', 'selection.selectionBar',
    'selection.columnDrag', 'selection.multiSelect', 'selection.selectAllKeys', 'selection.charLeftExtend', 'selection.charRightExtend',
    'selection.lineUpExtend', 'selection.lineDownExtend', 'selection.wordLeftExtend', 'selection.wordRightExtend', 'selection.startOfLineExtend',
    'selection.endOfLineExtend', 'selection.pageUpExtend', 'selection.pageDownExtend', 'selection.startOfDocExtend', 'selection.endOfDocExtend',
    'navigation.charLeft', 'navigation.charRight', 'navigation.lineUp', 'navigation.lineDown', 'navigation.wordLeft', 'navigation.wordRight',
    'navigation.startOfLine', 'navigation.endOfLine', 'navigation.startOfDocument', 'navigation.endOfDocument', 'navigation.pageUp',
    'navigation.pageDown', 'navigation.smartCursoring',
  ],
};

import { canvasEditor, openCanvasEditor } from '../../canvas.js';
import { pathOfPos, posOfPath } from '../../doc-path.mjs';
import { withCall } from '../../suggest/extension.js';
import { define, fail, failGates } from './define.mjs';
import { NO_ARGS, ref } from './schema-defs.mjs';
import { scrollToBlock } from './ui.mjs';

// canvas.* (SPEC §8 Catalogue, §6b Canvas Mode): open a canvas in the in-place editor and leave it, through the code the UI
// runs: the canvas bar's Edit (openCanvasEditor), the edit bar's Done and Escape (CanvasSession.close(true)).

const VIEW = ['doc.open', 'view.editor'];
const busy = (ctx) => ctx.lib.anyBoardBusy();

export const defs = [
  define({
    id: 'canvas.edit',
    title: 'Open a canvas in Canvas Mode',
    brief: 'It lets the user draw by hand. {} opens the selected one.',
    notFor: 'changing items. Use board_items_update',
    guide: { playbook: 'canvas-mode' },
    group: 'canvas',
    risk: 'write',
    undo: 'none', // only the view changes
    needs: [...VIEW, { gate: 'node.canvas', if: (a) => !!a.path }],
    args: { type: 'object', additionalProperties: false, properties: { path: ref('PATH', 'Canvas block path') } },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: {} }, { args: { path: [4] } }],
    busy,
    run: (ctx, a) => {
      const ed = ctx.editor;
      const { doc, selection: sel } = ed.state;
      // No path: the node-selected canvas, which lingers after a click in the chat box.
      if (!a.path && sel.node?.type.name !== 'canvas') failGates(['node.canvas'], 'Nothing to open: select a canvas, or pass path');
      const pos = a.path ? posOfPath(doc, a.path) : sel.from; // node.canvas held
      canvasEditor.get()?.close(true); // as a click outside first
      scrollToBlock(ed, pos);
      openCanvasEditor(ed, pos);
      if (!canvasEditor.get()) fail('failed', 'Canvas Mode did not open');
      return { path: pathOfPos(ed.state.doc, pos) };
    },
  }),
  define({
    id: 'canvas.close',
    title: 'Leave Canvas Mode (back to the document)',
    notFor: 'saving',
    group: 'canvas',
    risk: 'write',
    undo: 'none', // Done commits an open text edit (an agent's typing in it waits as a suggestion, docs/plans/suggestions.md)
    needs: ['view.editor', 'board.canvasMode'],
    args: NO_ARGS,
    result: { type: 'object', required: ['closed'] },
    examples: [{ args: {} }],
    busy,
    run: (ctx) => {
      const session = canvasEditor.get() ?? failGates(['board.canvasMode']);
      withCall(ctx.editor, ctx.suggest, 'exact', () => session.close(true)); // an agent's commit of the open text edit suggests
      return { closed: true };
    },
  }),
];

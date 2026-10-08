import { define } from './define.mjs';
import { NO_ARGS } from './schema-defs.mjs';

// history.* (SPEC §8 Catalogue): the open draft's undo stack (TipTap history), without focus and without scrolling.

const STEPS = { type: 'object', additionalProperties: false, properties: { steps: { type: 'integer', minimum: 1, maximum: 50, default: 1 } } };

const depths = (ctx) => ({ undoDepth: ctx.lib.undoDepth(ctx.editor.state), redoDepth: ctx.lib.redoDepth(ctx.editor.state) });

/** Runs `command` (undoNoScroll / redoNoScroll) up to `steps` times; stops when the stack is empty. */
function walk(ctx, command, steps) {
  let n = 0;
  while (n < steps && command(ctx.editor.state, ctx.editor.view.dispatch)) n++;
  return n;
}

export const defs = [
  define({
    id: 'history.undo',
    title: 'Undo the last changes of the open draft',
    group: 'history',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open', 'history.canUndo'],
    args: STEPS,
    result: { type: 'object', required: ['undone'] },
    examples: [{ args: {} }, { args: { steps: 2 } }],
    busy: (ctx) => ctx.lib.anyBoardBusy(),
    run: (ctx, a) => ({ undone: walk(ctx, ctx.lib.undoNoScroll, a.steps), ...depths(ctx) }),
  }),
  define({
    id: 'history.redo',
    title: 'Redo the last undone changes of the open draft',
    group: 'history',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open', 'history.canRedo'],
    args: STEPS,
    result: { type: 'object', required: ['redone'] },
    examples: [{ args: {} }],
    busy: (ctx) => ctx.lib.anyBoardBusy(),
    run: (ctx, a) => ({ redone: walk(ctx, ctx.lib.redoNoScroll, a.steps), ...depths(ctx) }),
  }),
  define({
    id: 'history.state',
    title: 'Read the undo and redo depth of the open draft',
    group: 'history',
    risk: 'read',
    undo: 'none',
    needs: ['doc.open'],
    args: NO_ARGS,
    result: { type: 'object', required: ['undoDepth', 'redoDepth', 'rev'] },
    examples: [{ args: {} }],
    run: (ctx) => ({ ...depths(ctx), rev: ctx.state.rev }),
  }),
];

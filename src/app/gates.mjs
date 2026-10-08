// Preconditions shared by the UI and (roadmap C4) the agent commands: one named gate per requirement, so neither side has
// its own copy of a check (agent-automation plan §3.7, flowchart plan §7.2). Pure and import-free.
//
// A gate reads one subject: `ui` {view, editor} (the store's state fits), `board` (Board.getSnapshot(), null without a
// board), `doc` {inTable}, `history` {canUndo, canRedo} (a board snapshot fits), `draft` {id, threadUrl, pushedAt}, `node`
// (a TipTap JSON block), `flow` (a library record; null when not loaded or missing) or `window` {visible}
// (document.visibilityState is 'visible': shown and not minimized).

const gate = (subject, test, message, fix) => ({ subject, test, message, fix });

export const GATES = {
  'doc.open': gate('ui', (u) => !!u?.editor, 'No document is open', 'Open a draft or start a new one'),
  'view.editor': gate('ui', (u) => u?.view?.type === 'editor', 'The editor is not shown', 'Go back to the editor (Back to editor)'),
  'view.plan': gate('ui', (u) => u?.view?.type === 'plan', 'The plan workspace is not open', 'Open it with the Plans tab'),
  'view.flows': gate('ui', (u) => u?.view?.type === 'flows', 'The flowchart library is not open', 'Open it with the Flowcharts tab'),
  'view.browser': gate('ui', (u) => u?.view?.type === 'browser', 'The browser is not open', 'Open it with the Browser tab'),
  'node.board': gate('node', (n) => n?.type === 'whiteboard' || n?.type === 'canvas', 'The block is not a whiteboard or canvas',
    'Address a whiteboard or canvas block'),
  'node.canvas': gate('node', (n) => n?.type === 'canvas', 'The block is not a canvas', 'Address a canvas block'),
  'node.whiteboard': gate('node', (n) => n?.type === 'whiteboard', 'The block is not a whiteboard', 'Address a whiteboard block'),
  // The node-selected block (no path: the editor's selection). node.none: a caret or text selection; node.is (param: the
  // kinds) reads the `kind` the tool search gives the block (tool-rank.mjs blockKind), so without one it is false.
  'node.none': gate('node', (n) => !n, 'A block is selected, not text', 'Click in the text first'),
  'node.is': gate('node', (n, _args, kinds) => !!n?.kind && kinds.includes(n.kind), 'The selected block is not of the needed kind',
    'Select that block first'),
  'board.active': gate('board', (b) => !!b, 'No board is active', 'Click a whiteboard, or edit a canvas'),
  'board.whiteboard': gate('board', (b) => b?.kind === 'whiteboard', 'Only a whiteboard can do this, not a canvas',
    'Address a whiteboard block'),
  // Canvas Mode (§6b): in the editor view the only board of kind 'canvas' is the one it edits.
  'board.canvasMode': gate('board', (b) => b?.kind === 'canvas', 'No canvas is open in Canvas Mode',
    'Double-click a canvas, or a picture on a whiteboard'),
  'board.selection': gate('board', (b) => b?.count >= 1, 'Nothing is selected on the board', 'Select one or more items first'),
  'board.selectionMany': gate('board', (b) => b?.count >= 2, 'Fewer than two items are selected', 'Select two or more items first'),
  // param: the item types; `item` is set only while exactly one item is selected.
  'board.itemIs': gate('board', (b, _args, types) => !!b?.item && types.includes(b.item.type),
    'The selection is not one item of the needed type', 'Select exactly one item of that type'),
  'doc.inTable': gate('doc', (d) => !!d?.inTable, 'The caret is not in a table', 'Put the caret in a table cell first'),
  'history.canUndo': gate('history', (h) => !!h?.canUndo, 'There is nothing to undo', 'Make a change first'),
  'history.canRedo': gate('history', (h) => !!h?.canRedo, 'There is nothing to redo', 'Undo a change first'),
  'draft.hasThread': gate('draft', (d) => !!d?.threadUrl, 'The draft has no thread', 'Choose its thread in the Post card'),
  'draft.unpushed': gate('draft', (d) => !!d && d.pushedAt == null, 'The draft is already marked as pushed', 'Unpush it first'),
  'draft.pushed': gate('draft', (d) => d?.pushedAt != null, 'The draft is not marked as pushed', 'Nothing to unpush; push it instead'),
  'flow.open': gate('flow', (f) => !!f, 'No library flowchart is open', 'Open one in the flowchart library'),
  'flow.synced': gate('node', (n) => n?.type === 'canvas' && !!n.attrs?.flow, 'The canvas is not linked to the flowchart library',
    'Save it to the library first'),
  'flow.unsynced': gate('node', (n) => n?.type === 'canvas' && !n.attrs?.flow, 'The canvas is already linked to the flowchart library',
    'Unlink it first'),
  'flow.present': gate('flow', (f) => !!f, 'The linked flowchart is missing from the library', 'Unlink the canvas to keep its picture'),
  // Every headless: false command needs it for the in-app assistant (SPEC §8 Policy; other agents are denied those commands).
  'window.visible': gate('window', (w) => !!w?.visible, 'The window is not visible', 'Bring EasyWriter to the front'),
};

/** Whether gate `id` holds for `subject`; `args` are a command's arguments, `param` the gate's parameter (board.itemIs: types,
 * node.is: kinds). */
export const can = (id, subject, args, param) => GATES[id].test(subject, args, param);

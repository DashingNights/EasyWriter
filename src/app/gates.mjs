// Preconditions shared by the UI and (roadmap C4) the agent commands: one named gate per requirement, so neither side has
// its own copy of a check (agent-automation plan §3.7, flowchart plan §7.2). Pure; imports only the pure formats.mjs and
// integrations/index.mjs, whose gates (each manifest's, and integration.<id>) are spread in and tagged with their integration.
//
// A gate reads one subject: `ui` {view, editor} (the store's state fits), `board` (Board.getSnapshot(), null without a
// board), `doc` {inTable}, `history` {canUndo, canRedo} (a board snapshot fits), `draft` {id, threadUrl, pushedAt, format, threads (settings.threads), suggestions}, `node`
// (a TipTap JSON block), `flow` (a library record; null when not loaded or missing), `window` {visible}
// (document.visibilityState is 'visible': shown and not minimized) or `settings` (settings.json as loaded).

import { formatOf } from '../formats.mjs';
import { integrationGates } from '../integrations/index.mjs';

const gate = (subject, test, message, fix) => ({ subject, test, message, fix });

export const GATES = {
  'doc.open': gate('ui', (u) => !!u?.editor, 'No document is open', 'Open a draft or start a new one'),
  'view.editor': gate('ui', (u) => u?.view?.type === 'editor', 'The editor is not shown', 'Go back to the editor (Back to editor)'),
  'view.plan': gate('ui', (u) => u?.view?.type === 'plan', 'The plan workspace is not open', 'Open it with the Plans tab'),
  'view.flows': gate('ui', (u) => u?.view?.type === 'flows', 'The flowchart library is not open', 'Open it with the Flowcharts tab'),
  'view.browser': gate('ui', (u) => u?.view?.type === 'browser', 'The browser is not open', 'Open it with the Browser tab'),
  'node.board': gate('node', (n) => n?.type === 'canvas', 'The block is not a canvas', 'Address a canvas block'),
  'node.canvas': gate('node', (n) => n?.type === 'canvas', 'The block is not a canvas', 'Address a canvas block'),
  // The node-selected block (no path: the editor's selection). node.none: a caret or text selection; node.is (param: the
  // kinds) reads the `kind` the tool search gives the block (tool-rank.mjs blockKind), so without one it is false.
  'node.none': gate('node', (n) => !n, 'A block is selected, not text', 'Click in the text first'),
  'node.is': gate('node', (n, _args, kinds) => !!n?.kind && kinds.includes(n.kind), 'The selected block is not of the needed kind',
    'Select that block first'),
  'board.active': gate('board', (b) => !!b, 'No board is active', 'Edit a canvas'),
  // Canvas Mode (§6b): in the editor view the only board of kind 'canvas' is the one it edits.
  'board.canvasMode': gate('board', (b) => b?.kind === 'canvas', 'No canvas is open in Canvas Mode',
    'Double-click a canvas'),
  'board.selection': gate('board', (b) => b?.count >= 1, 'Nothing is selected on the board', 'Select one or more items first'),
  'board.selectionMany': gate('board', (b) => b?.count >= 2, 'Fewer than two items are selected', 'Select two or more items first'),
  // param: the item types; `item` is set only while exactly one item is selected.
  'board.itemIs': gate('board', (b, _args, types) => !!b?.item && types.includes(b.item.type),
    'The selection is not one item of the needed type', 'Select exactly one item of that type'),
  'doc.inTable': gate('doc', (d) => !!d?.inTable, 'The caret is not in a table', 'Put the caret in a table cell first'),
  'history.canUndo': gate('history', (h) => !!h?.canUndo, 'There is nothing to undo', 'Make a change first'),
  // No agent edit waits as a suggestion in the draft (docs/plans/suggestions.md): `suggestions` is the count, the open draft's or
  // a session's live, else its summary's. A forum push needs it.
  'draft.settled': gate('draft', (d) => !(d?.suggestions > 0), 'Suggestions wait in this draft', 'Accept or reject them in the draft first'),
  'history.canRedo': gate('history', (h) => !!h?.canRedo, 'There is nothing to redo', 'Undo a change first'),
  // The draft's format (formats.mjs formatOf: no draft or no format is the forum post). Forum services, typography and tools
  // need format.post (the forum post or the core page); the Document's own need format.document (docs/plans/document.md).
  'format.post': gate('draft', (d) => ['forum-post', 'page'].includes(formatOf(d)?.id), 'The draft is not a forum post',
    'Use doc_format run and paragraph on a document'),
  'format.document': gate('draft', (d) => formatOf(d)?.id === 'document', 'The draft is not a document',
    'Open a document, or create one with drafts_create format document'),
  // The forum post inserts titled boxes (its ipsRichTextBox); the core page does not. doc.command checks insertBox against the
  // addressed draft in its check.
  'format.box': gate('draft', (d) => !!formatOf(d)?.blocks.includes('box'), 'The page format has no titled box',
    'Use a table or a quote instead'),
  'flow.open': gate('flow', (f) => !!f, 'No library flowchart is open', 'Open one in the flowchart library'),
  'flow.synced': gate('node', (n) => n?.type === 'canvas' && !!n.attrs?.flow, 'The canvas is not linked to the flowchart library',
    'Save it to the library first'),
  'flow.unsynced': gate('node', (n) => n?.type === 'canvas' && !n.attrs?.flow, 'The canvas is already linked to the flowchart library',
    'Unlink it first'),
  'flow.present': gate('flow', (f) => !!f, 'The linked flowchart is missing from the library', 'Unlink the canvas to keep its picture'),
  // Every headless: false command needs it when an agent calls it (SPEC §8 Policy).
  'window.visible': gate('window', (w) => !!w?.visible, 'The window is not visible', 'Bring EasyWriter to the front'),
  ...integrationGates(),
};

/** Whether gate `id` holds for `subject`; `args` are a command's arguments, `param` the gate's parameter (board.itemIs: types,
 * node.is: kinds). */
export const can = (id, subject, args, param) => GATES[id].test(subject, args, param);

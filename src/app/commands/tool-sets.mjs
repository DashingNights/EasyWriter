// Which commands the assistant is offered as tools (SPEC §7i Tool loop, §8 Tool schemas; automation plan §13.2 Tool calls): a
// small core always, the set of the current view, and the tools the model adds with commands.describe, less those its
// permission mode refuses (below). Categories group the
// catalogue for commands.index: a command's category comes from its `group`. Pure and import-free (commands.mjs imports it;
// tools-schema.mjs would make a cycle through the catalogue).

export const toolName = (id) => id.replaceAll('.', '_');

// Groups that share a category; every other group is its own category (plan.* → 'plan', flow.* → 'flow').
export const CATEGORY_OF_GROUP = {
  app: 'app', ui: 'app', audit: 'app', settings: 'app', tool: 'app', batch: 'app', commands: 'app',
  drafts: 'drafts', tags: 'drafts', folders: 'drafts', threads: 'drafts',
  canvas: 'board',
  export: 'export', push: 'export', forum: 'export',
};

// One line per category, shown by commands.index (a new namespace adds its line here; the contract test checks).
export const CATEGORIES = {
  app: 'What is shown and selected, settings, palette tools, tool lists, batch, and the controls on screen',
  drafts: 'Drafts, their tags and folders, and forum threads',
  doc: 'Read and edit the blocks of the open draft',
  board: 'Whiteboards, canvases, their items and Canvas Mode',
  export: 'Forum preview, push and login',
  history: 'Undo and redo in the open draft',
  flow: 'The flowchart library: its flowcharts, their items, layout and insertion into a draft',
};

export const categoryOf = (def) => CATEGORY_OF_GROUP[def.group] ?? def.group;

export const CORE = ['ui.state', 'drafts.list', 'drafts.open', 'batch', 'commands.index', 'commands.describe'];

// Not history.undo / history.redo: the model must not undo the user's own typing (each step line has its own Undo).
// Not board.render: its PNG would reach the model as base64 text. view.render's picture goes as the next user message (loop.js).
export const VIEW_SETS = {
  editor: ['doc.get', 'doc.find', 'doc.selection', 'doc.insert', 'doc.replace', 'doc.delete', 'doc.format', 'board.list', 'canvas.edit', 'view.render'],
  board: ['board.list', 'board.get', 'board.find', 'board.items.add', 'board.items.update', 'board.items.place', 'board.items.straighten', 'board.items.remove', 'ui.select',
    'board.fit', 'canvas.edit', 'canvas.close', 'view.render'],
  none: ['drafts.create', 'drafts.get', 'drafts.setTag', 'drafts.delete', 'threads.list', 'tags.list', 'folders.list'],
  plan: ['drafts.get', 'drafts.setTag', 'tags.list'],
  // The flowchart library (flow.mjs FLOW_VIEW_SET; test/flow-commands.test.mjs checks the two lists agree).
  flows: ['flow.library.list', 'flow.library.get', 'flow.find', 'flow.items.add', 'flow.items.update', 'flow.items.remove', 'flow.items.place', 'flow.items.straighten', 'flow.insert',
    'flow.layout'],
};

/** The VIEW_SETS key: the page when it is not the editor; no open draft → 'none'; the caret in text → 'editor'; a whiteboard
 * active, a canvas being edited (ui.state mode 'board' | 'canvas-edit'), a node-selected canvas, flowchart canvas, image or
 * whiteboard block (`nodeBoard`: ui.state's gate node.board) or a message that attaches board items (`boardItems`, wave 1c:
 * the chat box's focus ends the board's active state, so the mode is text again) → 'board'. */
export function viewOf({ view, mode, hasDoc, nodeBoard = false, boardItems = false }) {
  if (view !== 'editor') return Object.hasOwn(VIEW_SETS, view) ? view : 'none';
  if (!hasDoc) return 'none';
  return mode === 'text' && !nodeBoard && !boardItems ? 'editor' : 'board';
}

// The assistant's permission mode (settings.assistant.permission, SPEC §8 Policy; automation plan §5.2): the rule per risk for
// source agent:assistant (read always runs). standard = the agent:* policy. The executor reads the mode at every call.
export const PERMISSIONS = {
  standard: { write: true, destructive: 'ask', approval: 'ask' },
  ask: { write: 'ask', destructive: 'ask', approval: 'ask' },
  readonly: { write: 'deny', destructive: 'deny', approval: 'deny' },
  // Allow all (2026-10-07, the user: "add an allow all actions mode to assistant"): nothing asks. A push still only prepares
  // the post (push.prepare); the user submits it on the forum.
  all: { write: true, destructive: true, approval: true },
};
// Computer use (§7i): screenshots and mouse and keyboard input, offered to the cloud models only (loop.js toolList), never in a
// view set, so the small models' sets keep their budgets.
export const COMPUTER = ['computer.act', 'background.open', 'background.close'];
export const UI_CONTROL = ['ui.snapshot', 'ui.invoke', ...COMPUTER]; // off with settings.assistant.uiControl false
export const READ_ONLY = 'Read only mode. Change it in Settings.';
export const UI_OFF = 'On-screen controls are off. Change it in Settings.';

/** {permission, uiControl} of settings.assistant `a`: standard and on unless set otherwise. */
export const assistantMode = (a) => ({ permission: Object.hasOwn(PERMISSIONS, a?.permission) ? a.permission : 'standard', uiControl: a?.uiControl !== false });

/** Why the assistant in mode `m` may not call command `def` ({id, risk}), or null: ui.snapshot / ui.invoke while on-screen
 * controls are off, any command that is not a read in Read only. Such commands are not offered or listed either. */
export const refusal = (def, m) => (!m.uiControl && UI_CONTROL.includes(def.id) ? UI_OFF : PERMISSIONS[m.permission][def.risk] === 'deny' ? READ_ONLY : null);

export const MAX_SET = 14000; // characters of core + one view set as model-form tools, either family (test/tools-schema.test.mjs; about 4,000 tokens); 13 700 before the board writes' coords (Qwen Cloud, 2026-10-08), 13 500 before board.fit, 11 500 before draftId (Tier B background drafts), 11 000 before board.items.straighten, 10 000 before wave 2's view.render and board.items.place, 9 000 before wave 1c's tool text
export const MAX_TOOL = 3000; // characters of one model-form tool (2 800 before coords, 2 600 before draftId: board.items.add)
export const DESCRIBE_NAMES = 6; // names per commands.describe
export const DESCRIBED_CHARS = 8000; // characters of described tools a session keeps (oldest dropped first)

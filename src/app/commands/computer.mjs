import { define, fail } from './define.mjs';
import { NO_ARGS, ref } from './schema-defs.mjs';
import { assistantMode, refusal } from './tool-sets.mjs';

// Computer use (SPEC §7i Computer use, Background window; §8 Catalogue): a screenshot of the user's window ('main') or of the
// background window, an offscreen copy of the app on another draft ('background'), and the mouse and keyboard in it. Main does
// the work (src/computer-main.js through window.api.computer); the loop sends each screenshot as the picture after the tool
// message, as view_render's (loop.js, context.mjs takePictures). The cloud models get these tools (loop.js toolList), the small
// local ones do not.

const ACTIONS = ['screenshot', 'click', 'double_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait'];
const NEED = { click: ['x', 'y'], double_click: ['x', 'y'], move: ['x', 'y'], scroll: ['x', 'y'], drag: ['path'], type: ['text'], key: ['keys'], wait: ['ms'] };
// The input actions (the approval card's words in Ask first); screenshot and wait only look.
const DOING = { click: 'click', double_click: 'double-click', move: 'move the pointer', drag: 'drag', type: 'type', key: 'press keys', scroll: 'scroll' };
const WINDOW = { main: 'main window', background: 'background window' };
// Undo and redo in the user's window would undo the user's own typing (as history.undo, never offered; loop.js NEVER).
const UNDO = /^(control|ctrl|meta|cmd)\+(shift\+)?[zy]$/i;
const px = (description) => ({ type: 'number', minimum: 0, description });

/** main's answer {target, url, width, height, title?} or {error, code} → the result: the size line, and the picture that the loop
 * sends as the next message. */
function picture(r) {
  if (r?.error) fail(r.code, r.error);
  const of = r.target === 'background' ? `the background window, draft "${r.title}"` : 'the main window';
  return { width: r.width, height: r.height, size: `${r.width} x ${r.height} screenshot of ${of}`, picture: 'next message', url: r.url };
}

/** The input actions are writes, as ui.invoke: refused in Read only, asked on the card in Ask first. */
async function mayAct(ctx, a) {
  if (ctx.source === 'agent:assistant') {
    const why = refusal({ id: 'ui.invoke', risk: 'write' }, assistantMode(ctx.state.settings?.assistant));
    if (why) fail('denied', why, { reason: 'policy' });
  }
  const rule = ctx.policy.write;
  if (rule === 'deny') fail('denied', `computer.act is not allowed for ${ctx.source}`, { reason: 'policy' });
  if (rule === 'ask' && !(await ctx.ask(`${DOING[a.action]} in the ${WINDOW[a.target]}`, '', { risk: 'write' }))) {
    fail('denied', 'The user denied the request', { reason: 'user' });
  }
}

export const defs = [
  define({
    id: 'computer.act',
    title: 'Look at a window as a screenshot, or click, drag, type or press keys in it',
    brief: 'Use it for visual work such as drawing by hand. x and y are pixels of the last screenshot of that window. Each action answers with a new screenshot.',
    notFor: 'changes a draft or board tool can make. Use that tool',
    group: 'ui',
    risk: 'read', // the screenshot; the input actions are writes (mayAct)
    undo: 'none',
    args: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: {
        action: { enum: ACTIONS, description: 'screenshot only looks. The others act, then answer with a new screenshot' },
        target: { enum: ['main', 'background'], default: 'main', description: "main is the user's window, background the one from background_open" },
        x: px('Pixels from the left of the last screenshot'),
        y: px('Pixels from the top of the last screenshot'),
        button: { enum: ['left', 'right', 'middle'], description: 'click: the mouse button. Left when left out' },
        path: {
          type: 'array', minItems: 2, maxItems: 50, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
          description: 'drag: the points [x, y] from the press to the release',
        },
        text: { type: 'string', minLength: 1, maxLength: 2000, description: 'type: the text, typed where the keyboard focus is. Click there first' },
        keys: { type: 'string', minLength: 1, maxLength: 40, description: 'key: one key or a combination, such as Enter, Delete, Escape or Shift+Tab' },
        dx: { type: 'number', description: 'scroll: pixels to the right' },
        dy: { type: 'number', description: 'scroll: pixels down. Negative scrolls up' },
        ms: { type: 'integer', minimum: 1, maximum: 3000, description: 'wait: milliseconds, at most 3000' },
      },
    },
    result: { type: 'object', required: ['width', 'height', 'size', 'picture'] },
    examples: [
      { args: { action: 'screenshot' } }, { args: { action: 'click', x: 640, y: 360 } },
      { args: { action: 'drag', target: 'background', path: [[400, 300], [560, 420]] } }, { args: { action: 'type', text: 'Hello' } },
      { args: { action: 'key', keys: 'Enter' } }, { args: { action: 'scroll', x: 640, y: 400, dy: 300 } }, { args: { action: 'wait', ms: 500 } },
    ],
    run: async (ctx, a) => {
      const miss = (NEED[a.action] ?? []).find((k) => a[k] === undefined);
      if (miss) fail('invalid_args', `args.${miss} is needed for ${a.action}`, { path: `/${miss}`, message: `is needed for ${a.action}`, expected: {} });
      if (a.target === 'main' && a.action === 'key' && UNDO.test(a.keys)) {
        fail('refused', "Undo and redo in the main window are the user's. Each step line has its own Undo.", { code: 'undo' });
      }
      if (DOING[a.action]) await mayAct(ctx, a);
      return picture(await ctx.api.computer.act(a));
    },
  }),
  define({
    id: 'background.open',
    title: 'Open another draft in the background window and look at it',
    brief: 'Use it to work on a draft by hand while the user keeps working in theirs, then use computer_act with target background.',
    notFor: 'the draft open in the main window',
    group: 'ui',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', required: ['draftId'], additionalProperties: false,
      properties: { draftId: ref('ID', 'The draft id from drafts_list or the situation note') },
    },
    result: { type: 'object', required: ['width', 'height', 'size', 'picture', 'draftId'] },
    examples: [{ args: { draftId: '0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55' } }],
    run: async (ctx, a) => {
      if (ctx.state.draft?.id === a.draftId) {
        fail('refused', 'That draft is open in the main window. Work on it there with computer_act and target main.', { code: 'open_in_main' });
      }
      const title = ctx.state.drafts.find((d) => d.id === a.draftId)?.title || 'Untitled draft';
      return { ...picture(await ctx.actions.openInBackground(a.draftId, title)), draftId: a.draftId };
    },
  }),
  define({
    id: 'background.close',
    title: 'Save and close the background window',
    brief: 'Use it when the work there is done. It also closes by itself 5 minutes after its last action.',
    group: 'ui',
    risk: 'write',
    undo: 'none',
    args: NO_ARGS,
    result: { type: 'object', required: ['closed'] },
    examples: [{ args: {} }],
    run: async (ctx) => {
      const r = await ctx.api.computer.close();
      if (r?.error) fail(r.code, r.error);
      return r;
    },
  }),
];

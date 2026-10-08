import { BOARD_TYPES } from '../../doc-path.mjs';
import { buildPayload } from '../../export.js';
import { GATES } from '../gates.mjs';
import { define, fail } from './define.mjs';
import { ref } from './schema-defs.mjs';

// export.preview, push.prepare, forum.* (SPEC §8 Catalogue; agent-automation plan §6.4). Push stays the existing flow
// (actions.js push): its human confirm, then the forum window's reply box is filled; Submit is always the human's click.

/** The number of pictures a push attaches: one per whiteboard, canvas and plan chart of the open draft. */
function pictures(doc) {
  let n = 0;
  doc.descendants((node) => {
    if (!BOARD_TYPES.includes(node.type.name)) return true;
    n++;
    return false;
  });
  return n;
}

const bytesOf = (base64) => Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

export const defs = [
  define({
    id: 'export.preview',
    title: 'Build the post HTML and pictures that Push would send for the open draft',
    group: 'export',
    risk: 'read',
    undo: 'none',
    slow: true,
    needs: ['doc.open'],
    args: { type: 'object', additionalProperties: false, properties: { images: { type: 'boolean', default: false } } },
    result: { type: 'object', required: ['html', 'images'] },
    examples: [{ args: {} }, { args: { images: true } }],
    run: async (ctx, a) => {
      const { html, images } = await buildPayload(ctx.editor, ctx.state.settings);
      return { html, images: images.map(({ base64, ...m }) => ({ ...m, bytes: bytesOf(base64), ...(a.images && { base64 }) })) };
    },
  }),
  define({
    id: 'push.prepare',
    title: 'Fill the forum reply box with a draft (the user confirms and submits it)',
    group: 'push',
    risk: 'approval',
    undo: 'none',
    slow: true,
    needs: ['draft.hasThread', 'draft.unpushed'], // on the addressed draft (draftId), else the open one
    args: { type: 'object', additionalProperties: false, properties: { draftId: ref('ID') } },
    result: { type: 'object', required: ['ok', 'attachments', 'submitted'] },
    examples: [{ args: {} }, { args: { draftId: '0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55' } }],
    ask: (ctx, a) => {
      const d = a.draftId && a.draftId !== ctx.state.draft?.id ? ctx.state.drafts.find((x) => x.id === a.draftId) : ctx.state.draft;
      const thread = ctx.state.settings.threads.find((t) => t.url === d?.threadUrl);
      return {
        title: `fill the forum reply box with the draft "${d?.title || 'Untitled draft'}"`,
        description: `Thread: ${thread?.title || d?.threadUrl}\nYou confirm the push next, then review the reply and press Submit in the forum window.`,
      };
    },
    run: async (ctx, a) => {
      let switched = false;
      if (a.draftId && a.draftId !== ctx.state.draft?.id) {
        await ctx.actions.openDraft(a.draftId, { remember: false }); // saves the open draft first
        if (ctx.state.draft?.id !== a.draftId) fail('failed', 'The draft could not be opened');
        switched = true;
      }
      const before = ctx.state.draft.pushedAt ?? null;
      const attachments = pictures(ctx.editor.state.doc);
      const r = await ctx.actions.push({ requireThread: true });
      if (r?.code === 'no_thread') {
        const { message, fix } = GATES['draft.hasThread'];
        fail('precondition_failed', message, { failed: [{ gate: 'draft.hasThread', message, fix }] });
      }
      // push() marks the draft pushed once the reply box is filled; a declined confirm or a failed push leaves it (the user
      // saw why).
      const ok = (ctx.state.draft?.pushedAt ?? null) !== before;
      return { ok, attachments: ok ? attachments : 0, submitted: false, ...(switched && { switched }) };
    },
  }),
  define({
    id: 'forum.status',
    title: 'Whether the forum window is logged in',
    group: 'forum',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'object', required: ['loggedIn'] },
    examples: [{ args: {} }],
    run: async (ctx) => ({ loggedIn: !!(await ctx.api.forum.status())?.loggedIn }),
  }),
  define({
    id: 'forum.login',
    title: 'Open the forum login window: the user signs in there (never automatic)',
    group: 'forum',
    risk: 'approval',
    undo: 'none',
    headless: false,
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'object', required: ['loggedIn'] },
    examples: [{ args: {} }],
    run: async (ctx) => {
      await ctx.actions.login();
      return { loggedIn: !!ctx.state.status?.loggedIn };
    },
  }),
];

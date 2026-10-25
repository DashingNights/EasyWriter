import { define, fail } from '../../app/commands/define.mjs';
import { ref } from '../../app/commands/schema-defs.mjs';
import { GATES } from '../../app/gates.mjs';
import { BOARD_TYPES } from '../../doc-path.mjs';

// The forum integration's commands (SPEC §8 Catalogue; agent-automation plan §6.4), spread by app/commands/catalogue.mjs:
// export.preview, push.prepare, forum.*, threads.openInForum and drafts.unpush. Each has integration: 'forum', so agents see
// them only while the forum is on. They reach the forum only through ctx.integrations.forum (forum/actions.js), so this
// file imports no renderer code. Push stays the existing flow (forum/actions.js push): its human confirm, then the forum window's
// reply box is filled; Submit is always the human's click.

// Copies of app/commands/drafts.mjs's, which imports renderer code (whiteboard.js).
const EXAMPLE_ID = '0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55';
const THREAD = 'project:3a7c9e1b-5d2f-4b8a-9c6e-1f0d2b4a6c8e';
const DRAFT = { type: 'object', required: ['draftId'], additionalProperties: false, properties: { draftId: ref('ID', 'The draft id from drafts_list') } };

/** The draft `id` (the open one carries the live fields), or null. */
const draftOf = (ctx, id) => (ctx.state.draft?.id === id ? ctx.state.draft : ctx.state.drafts.find((d) => d.id === id) ?? null);

/** The number of files a push attaches: one per canvas, plan chart and media node of the open draft. */
function pictures(doc) {
  let n = 0;
  doc.descendants((node) => {
    if (!BOARD_TYPES.includes(node.type.name) && node.type.name !== 'media') return true;
    n++;
    return false;
  });
  return n;
}

// Forum services follow the draft's format. The gate's own fix names doc_format, so they carry their own.
export const FORMAT_POST = { gate: 'format.post', fix: 'Use a forum post draft' };
const bytesOf = (base64) => Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);

export const defs = [
  define({
    id: 'export.preview',
    title: 'Build the post HTML and pictures that Push would send for the open draft',
    group: 'export',
    integration: 'forum',
    risk: 'read',
    undo: 'none',
    slow: true,
    needs: ['doc.open', FORMAT_POST],
    args: { type: 'object', additionalProperties: false, properties: { images: { type: 'boolean', default: false } } },
    result: { type: 'object', required: ['html', 'images'] },
    examples: [{ args: {} }, { args: { images: true } }],
    run: async (ctx, a) => {
      const { html, images } = await ctx.integrations.forum.buildPayload(ctx.editor, ctx.state.settings, ctx.state.draft);
      return { html, images: images.map(({ base64, ...m }) => ({ ...m, bytes: bytesOf(base64), ...(a.images && { base64 }) })) };
    },
  }),
  define({
    id: 'push.prepare',
    title: 'Fill the forum reply box with a draft (the user confirms and submits it)',
    group: 'push',
    integration: 'forum',
    risk: 'approval',
    undo: 'none',
    slow: true,
    needs: ['app.forum', FORMAT_POST, 'draft.hasThread', 'draft.unpushed'], // on the addressed draft (draftId), else the open one
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
      const r = await ctx.integrations.forum.push({ requireThread: true });
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
    integration: 'forum',
    needs: ['app.forum'],
    title: 'Whether the forum window is logged in',
    group: 'forum',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'object', required: ['loggedIn'] },
    examples: [{ args: {} }],
    run: async (ctx) => ({ loggedIn: !!(await ctx.integrations.forum.status())?.loggedIn }),
  }),
  define({
    id: 'forum.login',
    integration: 'forum',
    needs: ['app.forum'],
    title: 'Open the forum login window: the user signs in there (never automatic)',
    group: 'forum',
    risk: 'approval',
    undo: 'none',
    headless: false,
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'object', required: ['loggedIn'] },
    examples: [{ args: {} }],
    run: async (ctx) => {
      await ctx.integrations.forum.login();
      return { loggedIn: !!ctx.state.status?.loggedIn };
    },
  }),
  define({
    id: 'threads.openInForum',
    integration: 'forum',
    title: "Open a project's forum thread in the forum window",
    group: 'threads',
    risk: 'approval', // outward-facing: it loads the forum site
    undo: 'none',
    headless: false,
    needs: ['app.forum'],
    args: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: ref('URL') } },
    result: { type: 'object', required: ['url'] },
    examples: [{ args: { url: THREAD } }],
    ask: (ctx, a) => ({ title: 'open a forum thread in the forum window', description: ctx.integrations.forum.projectTopic(a.url) || a.url }),
    run: async (ctx, a) => {
      const url = ctx.integrations.forum.projectTopic(a.url) || fail('precondition_failed', 'That project links no forum thread', { failed: [{ gate: null, message: 'no forum thread', fix: 'Link one to the project first' }] });
      await ctx.integrations.forum.open(url);
      return { url };
    },
  }),
  define({
    id: 'drafts.unpush',
    integration: 'forum',
    title: 'Mark a draft as not pushed',
    group: 'drafts',
    risk: 'destructive',
    undo: 'none',
    needs: ['draft.pushed'],
    args: DRAFT,
    result: { type: 'object', required: ['draftId', 'previous'] },
    examples: [{ args: { draftId: EXAMPLE_ID } }],
    ask: (ctx, a) => `mark the draft "${draftOf(ctx, a.draftId)?.title || 'Untitled draft'}" as not pushed`,
    run: async (ctx, a) => {
      const previous = draftOf(ctx, a.draftId).pushedAt;
      if (!(await ctx.integrations.forum.doUnpushDraft(a.draftId))) fail('failed', 'The draft could not be saved');
      return { draftId: a.draftId, previous };
    },
  }),
];

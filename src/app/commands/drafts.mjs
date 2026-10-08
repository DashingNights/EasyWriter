import { sortDrafts } from '../draft-order.mjs';
import { draftTag, tagList } from '../drafts-meta.js';
import { define, fail } from './define.mjs';
import { CONTENT, ID, ref, TAG_ID } from './schema-defs.mjs';

// drafts.* (SPEC §8 Catalogue): one draft per call, through the actions.js functions the sidebar uses. Settings-only
// changes (tag, folder, order) have no undo: their results carry the previous value, so the inverse call restores it.

const DRAFT = { type: 'object', required: ['draftId'], additionalProperties: false, properties: { draftId: ref('ID', 'The draft id from drafts_list') } };
const EXAMPLE_ID = '0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55';
const THREAD = 'https://daf.staffs.ac.uk/topic/88136-level-design/';

/** The draft `id` (the open one carries the live fields), or null. */
const draftOf = (ctx, id) => (ctx.state.draft?.id === id ? ctx.state.draft : ctx.state.drafts.find((d) => d.id === id) ?? null);
const titleOf = (ctx, id) => draftOf(ctx, id)?.title || 'Untitled draft';
const folders = (ctx) => ctx.state.settings.folders || [];
const folderOf = (ctx, id) => {
  const f = ctx.state.settings.draftFolders?.[id];
  return folders(ctx).some((x) => x.id === f) ? f : null;
};

function needFolder(ctx, folderId) {
  if (folderId != null && !folders(ctx).some((f) => f.id === folderId)) fail('not_found', `No folder has the id ${folderId}`);
}

function needTag(ctx, tagId) {
  if (tagId != null && !tagList(ctx.state.settings).some((t) => t.id === tagId)) fail('not_found', `No tag has the id ${tagId}`);
}

export const defs = [
  define({
    id: 'drafts.list',
    title: 'List the drafts in the sidebar order',
    brief: 'Use it to get the id of a draft by its title.',
    notFor: 'opening',
    guide: { args: 'Usually none' },
    group: 'drafts',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: { threadUrl: ref('URL', 'Full forum thread URL. Omit it for all drafts.') } },
    result: { type: 'array' },
    examples: [{ args: {} }, { args: { threadUrl: THREAD } }],
    run: (ctx, a) => sortDrafts(ctx.state.drafts, ctx.state.settings.draftOrder)
      .filter((d) => !a.threadUrl || d.threadUrl === a.threadUrl)
      .map((d) => ({
        id: d.id, title: d.title, threadUrl: d.threadUrl, updated: d.updated, pushedAt: d.pushedAt,
        tag: draftTag(ctx.state.settings, d.id)?.id ?? null, folder: folderOf(ctx, d.id),
      })),
  }),
  define({
    id: 'drafts.get',
    title: 'Read a draft (pictures as {$img} unless images is true)',
    brief: 'Use it to read a draft that is not open.',
    group: 'drafts',
    risk: 'read',
    undo: 'none',
    args: { ...DRAFT, properties: { ...DRAFT.properties, images: { type: 'boolean', default: false, description: 'Keep picture data' } } },
    result: { type: 'object', required: ['draft'] },
    examples: [{ args: { draftId: EXAMPLE_ID } }],
    run: async (ctx, a) => {
      const open = ctx.state.draft?.id === a.draftId;
      const draft = open ? { ...ctx.state.draft, doc: ctx.editor.getJSON() } : await ctx.api.drafts.load(a.draftId);
      if (!draft) fail('not_found', `The draft ${a.draftId} could not be loaded`);
      const out = a.images ? draft : ctx.lib.stripImages(draft);
      return open ? { draft: out, rev: ctx.state.rev } : { draft: out };
    },
  }),
  define({
    id: 'drafts.create',
    title: 'Create a draft and open it',
    brief: 'Use it when the user asks for a new draft.',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        threadUrl: { anyOf: [ref('URL'), { type: 'null' }], description: 'The forum thread URL, or null for none' },
        folderId: { type: 'string', minLength: 1, description: 'A folder id from folders_list' },
        tagId: { ...TAG_ID, description: 'A tag id from tags_list' },
        content: { ...CONTENT, description: 'The first text, as markdown, html or json' },
      },
    },
    result: { type: 'object', required: ['draftId', 'rev'] },
    examples: [{ args: {} }, { args: { threadUrl: THREAD, tagId: 'todo', content: { markdown: '# Week 3\n\nNotes.' } } }],
    run: async (ctx, a) => {
      needFolder(ctx, a.folderId);
      needTag(ctx, a.tagId);
      const { nodes, dropped } = a.content ? await ctx.lib.toNodes(a.content) : { nodes: null, dropped: [] };
      const doc = nodes && { type: 'doc', content: nodes.map((n) => n.toJSON()) };
      const { draftId } = await ctx.actions.createDraft({ threadUrl: a.threadUrl, folderId: a.folderId, tagId: a.tagId, doc });
      return { draftId, rev: ctx.state.rev, ...(dropped.length && { dropped }) };
    },
  }),
  define({
    id: 'drafts.open',
    title: 'Open a draft in the editor',
    notFor: 'a title. Get the draftId from drafts_list first',
    guide: { errors: 'invalid_args on draftId means you sent a title. Send its id' },
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: DRAFT,
    result: { type: 'object', required: ['rev'] },
    examples: [{ args: { draftId: EXAMPLE_ID } }],
    run: async (ctx, a) => {
      // Agents never change lastDraftId: the draft the app reopens stays the user's choice.
      if (ctx.state.draft?.id !== a.draftId) await ctx.actions.openDraft(a.draftId, { remember: !ctx.source.startsWith('agent:') });
      if (ctx.state.draft?.id !== a.draftId) fail('failed', 'The draft could not be opened');
      return { rev: ctx.state.rev };
    },
  }),
  define({
    id: 'drafts.delete',
    title: 'Delete a draft (moved to the trash)',
    brief: 'Use it when the user asks to delete a draft. The user confirms on a card.',
    group: 'drafts',
    risk: 'destructive',
    undo: 'none',
    args: DRAFT,
    result: { type: 'object', required: ['draftId', 'trashed'] },
    examples: [{ args: { draftId: EXAMPLE_ID } }],
    ask: (ctx, a) => `delete the draft "${titleOf(ctx, a.draftId)}" (moved to the trash)`,
    run: async (ctx, a) => {
      await ctx.actions.doDeleteDraft(a.draftId);
      return { draftId: a.draftId, trashed: true };
    },
  }),
  define({
    id: 'drafts.unpush',
    title: 'Mark a draft as not pushed',
    group: 'drafts',
    risk: 'destructive',
    undo: 'none',
    needs: ['draft.pushed'],
    args: DRAFT,
    result: { type: 'object', required: ['draftId', 'previous'] },
    examples: [{ args: { draftId: EXAMPLE_ID } }],
    ask: (ctx, a) => `mark the draft "${titleOf(ctx, a.draftId)}" as not pushed`,
    run: async (ctx, a) => {
      const previous = draftOf(ctx, a.draftId).pushedAt;
      if (!(await ctx.actions.doUnpushDraft(a.draftId))) fail('failed', 'The draft could not be saved');
      return { draftId: a.draftId, previous };
    },
  }),
  define({
    id: 'drafts.setThread',
    title: 'Set the forum thread of a draft',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: { ...DRAFT, required: ['draftId', 'threadUrl'], properties: { ...DRAFT.properties, threadUrl: { anyOf: [ref('URL'), { type: 'null' }] } } },
    result: { type: 'object', required: ['draftId', 'threadUrl', 'previous'] },
    examples: [{ args: { draftId: EXAMPLE_ID, threadUrl: THREAD } }, { args: { draftId: EXAMPLE_ID, threadUrl: null } }],
    run: async (ctx, a) => {
      const previous = draftOf(ctx, a.draftId).threadUrl ?? null;
      if (!(await ctx.actions.setDraftThreadFor(a.draftId, a.threadUrl))) fail('failed', 'The draft could not be saved');
      return { draftId: a.draftId, threadUrl: draftOf(ctx, a.draftId).threadUrl ?? null, previous };
    },
  }),
  define({
    id: 'drafts.setTag',
    title: 'Set the status tag of a draft',
    brief: 'Use it to mark a draft with a status tag.',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: {
      ...DRAFT, required: ['draftId', 'tagId'],
      properties: { ...DRAFT.properties, tagId: { anyOf: [ref('TAG_ID'), { type: 'null' }], description: 'A tag id from tags_list, or null to clear it' } },
    },
    result: { type: 'object', required: ['draftId', 'tagId', 'previous'] },
    examples: [{ args: { draftId: EXAMPLE_ID, tagId: 'done' } }, { args: { draftId: EXAMPLE_ID, tagId: null } }],
    run: async (ctx, a) => {
      needTag(ctx, a.tagId);
      const previous = draftTag(ctx.state.settings, a.draftId)?.id ?? null;
      await ctx.actions.setDraftTag(a.draftId, a.tagId);
      return { draftId: a.draftId, tagId: a.tagId, previous };
    },
  }),
  define({
    id: 'drafts.move',
    title: 'Move a draft into a folder (null: the top level)',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: { ...DRAFT, required: ['draftId', 'folderId'], properties: { ...DRAFT.properties, folderId: { type: ['string', 'null'], minLength: 1 } } },
    result: { type: 'object', required: ['draftId', 'folderId', 'previous'] },
    examples: [{ args: { draftId: EXAMPLE_ID, folderId: null } }],
    run: async (ctx, a) => {
      needFolder(ctx, a.folderId);
      const previous = folderOf(ctx, a.draftId);
      await ctx.actions.moveDraft(a.draftId, a.folderId);
      return { draftId: a.draftId, folderId: a.folderId, previous };
    },
  }),
  define({
    id: 'drafts.reorder',
    title: 'Place a draft just before or after another draft (it joins that draft\'s folder)',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', required: ['draftId'], additionalProperties: false,
      properties: { draftId: ref('ID'), beforeId: ID, afterId: ID },
      oneOf: [{ required: ['beforeId'] }, { required: ['afterId'] }],
    },
    result: { type: 'object', required: ['draftId', 'folderId'] },
    examples: [{ args: { draftId: EXAMPLE_ID, beforeId: '7d1e5f2a-3b4c-4d5e-8f9a-0b1c2d3e4f5a' } }],
    run: async (ctx, a) => {
      const target = a.beforeId ?? a.afterId;
      if (target === a.draftId || !draftOf(ctx, target)) fail('not_found', `No other draft has the id ${target}`);
      await ctx.actions.placeDraft(a.draftId, target, !!a.afterId);
      return { draftId: a.draftId, folderId: folderOf(ctx, a.draftId) };
    },
  }),
];

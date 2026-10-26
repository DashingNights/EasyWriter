import { defaultFormat, pageOf } from '../../formats.mjs';
import { bare } from '../../integrations/index.mjs';
import { brief, pendingCount } from '../../suggest/core.mjs';
import { migrateBoards } from '../../whiteboard.js';
import { sortDrafts } from '../draft-order.mjs';
import { draftTag, tagList } from '../drafts-meta.js';
import { define, fail } from './define.mjs';
import { CONTENT, ID, ref, TAG_ID } from './schema-defs.mjs';

// drafts.* (SPEC §8 Catalogue): one draft per call, through the actions.js functions the sidebar uses. Settings-only
// changes (tag, folder, order) have no undo: their results carry the previous value, so the inverse call restores it.

const DRAFT = { type: 'object', required: ['draftId'], additionalProperties: false, properties: { draftId: ref('ID', 'The draft id from drafts_list') } };
const EXAMPLE_ID = '0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55';
const THREAD = 'project:3a7c9e1b-5d2f-4b8a-9c6e-1f0d2b4a6c8e'; // a project key (threads.list); a forum thread added before projects is keyed by its topic URL

/** The draft `id` (the open one carries the live fields), or null. */
const draftOf = (ctx, id) => (ctx.state.draft?.id === id ? ctx.state.draft : ctx.state.drafts.find((d) => d.id === id) ?? null);
const titleOf = (ctx, id) => draftOf(ctx, id)?.title || 'Untitled draft';
// The suggestions waiting in draft `d` (docs/plans/suggestions.md): the open draft's live count, else its summary's.
const waiting = (ctx, d) => (ctx.state.draft?.id === d.id && ctx.editor ? pendingCount(ctx.editor.state.doc) : d.suggestions ?? 0);
/** The suggestions waiting in TipTap JSON `doc` (a draft file's): its records' distinct ids. */
const countOf = (doc) => new Set([...(doc?.attrs?.suggest?.attrs ?? []).map((r) => r.id),
  ...(doc?.content ?? []).flatMap((b) => [b?.attrs?.suggest?.ins?.id, ...(b?.attrs?.suggest?.del ?? []).map((x) => x.id)])].filter(Boolean)).size;
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
    args: { type: 'object', additionalProperties: false, properties: { threadUrl: ref('URL', 'Its project or thread URL (threads.list). Omit it for all drafts.') } },
    result: { type: 'array' },
    examples: [{ args: {} }, { args: { threadUrl: THREAD } }],
    run: (ctx, a) => sortDrafts(ctx.state.drafts, ctx.state.settings.draftOrder)
      .filter((d) => !a.threadUrl || d.threadUrl === a.threadUrl)
      .map((d) => bare('draft', {
        id: d.id, title: d.title, threadUrl: d.threadUrl, updated: d.updated, pushedAt: d.pushedAt, format: d.format ?? null,
        tag: draftTag(ctx.state.settings, d.id)?.id ?? null, folder: folderOf(ctx, d.id), suggestions: waiting(ctx, d),
      }, ctx.state.settings)),
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
      const loaded = open ? { ...ctx.state.draft, doc: ctx.editor.getJSON() } : await ctx.api.drafts.load(a.draftId);
      if (!loaded) fail('not_found', `The draft ${a.draftId} could not be loaded`);
      // A draft not opened since the merge still holds whiteboards on disk: shown as the canvases it opens as (§6b Converted whiteboards).
      const doc = open ? loaded.doc : migrateBoards(loaded.doc, pageOf(loaded, ctx.state.settings).width);
      // A suggestion record as {id, kind}, its old blocks left out.
      const draft = { ...loaded, doc: brief(doc), suggestions: open ? pendingCount(ctx.editor.state.doc) : countOf(doc) };
      const out = bare('draft', a.images ? draft : ctx.lib.stripImages(draft), ctx.state.settings);
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
        title: { type: 'string', maxLength: 200, description: 'Omitted: the first line of content, else Untitled' },
        threadUrl: { anyOf: [ref('URL'), { type: 'null' }], description: 'The project or thread URL, or null for none' },
        folderId: { type: 'string', minLength: 1, description: 'A folder id from folders_list' },
        tagId: { ...TAG_ID, description: 'A tag id from tags_list' },
        content: { ...CONTENT, description: 'The first text, as markdown, html or json' },
        format: { enum: ['forum-post', 'document'], description: 'Omitted: a forum post in a forum-thread project while the forum is on, else a document' },
      },
    },
    result: { type: 'object', required: ['draftId', 'rev', 'format'] },
    examples: [{ args: {} }, { args: { threadUrl: THREAD, tagId: 'todo', content: { markdown: '# Week 3\n\nNotes.' } } },
      { args: { format: 'document', content: { markdown: '# Report\n\nText' } } }, { args: { title: 'Week 3 notes', format: 'document' } }],
    run: async (ctx, a) => {
      needFolder(ctx, a.folderId);
      needTag(ctx, a.tagId);
      // docs/plans/document.md New-draft defaults: without the user's last pick, so an agent's result never depends on it. An
      // explicit forum-post is allowed with the forum off: the format opens in either state.
      const format = a.format ?? defaultFormat(ctx.state.settings, a.threadUrl === undefined ? ctx.state.settings.selectedThread : a.threadUrl);
      // Parsed in the new draft's own schema before it exists, so content that does not parse creates nothing.
      const { nodes, dropped } = a.content ? await ctx.lib.toNodes(a.content, null, { format }) : { nodes: null, dropped: [] };
      const doc = nodes && { type: 'doc', content: nodes.map((n) => n.toJSON()) };
      const { draftId } = await ctx.actions.createDraft({ title: a.title, threadUrl: a.threadUrl, folderId: a.folderId, tagId: a.tagId, doc, format });
      return { draftId, rev: ctx.state.rev, format, ...(dropped.length && { dropped }) };
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
    brief: 'Use it when the user asks to delete a draft. Do not ask for confirmation in text.',
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
    id: 'drafts.rename',
    title: 'Rename a draft',
    brief: 'Use it when the user asks to rename a draft.',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: {
      ...DRAFT, required: ['draftId', 'title'],
      properties: { ...DRAFT.properties, title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'The new title' } },
    },
    result: { type: 'object', required: ['draftId', 'title', 'previous'] },
    examples: [{ args: { draftId: EXAMPLE_ID, title: 'Week 3 notes' } }],
    run: async (ctx, a) => {
      const draft = draftOf(ctx, a.draftId);
      if (!draft) fail('not_found', `No draft has the id ${a.draftId}`);
      const previous = draft.title;
      // renameDraft refuses while the background window holds the draft (docs/plans/sidebar-menu.md decision 1).
      if (!(await ctx.actions.renameDraft(a.draftId, a.title))) {
        fail('failed', ctx.state.worker?.draftId === a.draftId ? 'The background window has this draft open' : 'The draft could not be saved');
      }
      return { draftId: a.draftId, title: draftOf(ctx, a.draftId).title, previous };
    },
  }),
  define({
    id: 'drafts.duplicate',
    title: 'Copy a draft (titled "<title> (copy)", not opened)',
    brief: 'Use it when the user asks for a copy of a draft.',
    group: 'drafts',
    risk: 'write',
    undo: 'none',
    args: {
      ...DRAFT,
      properties: { ...DRAFT.properties, folderId: { type: ['string', 'null'], minLength: 1, description: 'A folder id from folders_list, null: the top level. Omitted: after the source' } },
    },
    result: { type: 'object', required: ['draftId', 'title', 'folderId'] },
    examples: [{ args: { draftId: EXAMPLE_ID } }, { args: { draftId: EXAMPLE_ID, folderId: null } }],
    run: async (ctx, a) => {
      if (!draftOf(ctx, a.draftId)) fail('not_found', `No draft has the id ${a.draftId}`);
      needFolder(ctx, a.folderId);
      let draftId;
      try {
        ({ draftId } = await ctx.actions.duplicateDraft(a.draftId, { folderId: a.folderId }));
      } catch (e) {
        fail('failed', e.message);
      }
      return { draftId, title: draftOf(ctx, draftId).title, folderId: folderOf(ctx, draftId) };
    },
  }),
  define({
    id: 'drafts.setThread',
    title: 'Set the project of a draft',
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

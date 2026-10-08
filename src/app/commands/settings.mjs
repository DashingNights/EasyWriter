import { moveBeside } from '../draft-order.mjs';
import { draftsWithTag, pruneMap, tagList } from '../drafts-meta.js';
import { FONT_SIZES, FONTS } from '../../format.mjs';
import { define, fail } from './define.mjs';
import { ref, TAG_ID } from './schema-defs.mjs';

// settings.* / tags.* / folders.* (SPEC §8 Catalogue): one key set, one tag or one folder per call, through actions.js.
// Results carry the previous values, so the inverse call restores them.

const COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const NAME = { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' };
const FOLDER_ID = { type: 'string', minLength: 1, maxLength: 64 };
const EXAMPLE_FOLDER = '3f6c2a1e-8b7d-4e5f-9a0b-1c2d3e4f5a6b';

// The keys settings.patch may change (agent-automation plan §7): the lists have their own commands, `presets` is a whole
// list (Settings only), `agent` / `lastDraftId` / `lastView` stay the user's.
const PATCH = {
  forumWidth: { type: 'integer', minimum: 320, maximum: 4000 },
  theme: { enum: ['dark', 'light'] },
  baseFont: { enum: ['', ...FONTS.map((f) => f.css)] },
  baseSize: { enum: FONT_SIZES },
  historyLimit: { type: 'integer', minimum: 0, maximum: 500 },
  sidebarCollapsed: { type: 'boolean' },
  selectedThread: { anyOf: [ref('URL'), { type: 'null' }] },
};

const tags = (ctx) => tagList(ctx.state.settings);
const folders = (ctx) => ctx.state.settings.folders || [];

function tagOf(ctx, id) {
  return tags(ctx).find((t) => t.id === id) ?? fail('not_found', `No tag has the id ${id}`);
}

function folderOf(ctx, id) {
  return folders(ctx).find((f) => f.id === id) ?? fail('not_found', `No folder has the id ${id}`);
}

/** The ids of the drafts filed in folder `id`. */
const inFolder = (ctx, id) => ctx.state.drafts.filter((d) => ctx.state.settings.draftFolders?.[d.id] === id).map((d) => d.id);

export const defs = [
  define({
    id: 'settings.get',
    title: 'Read the settings (all, or the listed keys)',
    group: 'settings',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: { keys: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 50 } } },
    result: { type: 'object' },
    examples: [{ args: {} }, { args: { keys: ['theme', 'forumWidth'] } }],
    run: (ctx, a) => {
      const { apiKey, googleKey, deepseekKey, qwenKey, ...assistant } = ctx.state.settings.assistant ?? {}; // a provider's key never leaves the app
      const s = { ...ctx.state.settings, ...(ctx.state.settings.assistant && { assistant }) };
      return a.keys ? Object.fromEntries(a.keys.filter((k) => Object.hasOwn(s, k)).map((k) => [k, s[k]])) : s;
    },
  }),
  define({
    id: 'settings.patch',
    title: 'Change display settings such as forum width, theme, base font and undo history',
    group: 'settings',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', required: ['patch'], additionalProperties: false,
      properties: { patch: { type: 'object', additionalProperties: false, minProperties: 1, properties: PATCH } },
    },
    result: { type: 'object', required: ['keys', 'previous'] },
    examples: [{ args: { patch: { forumWidth: 1200 } } }, { args: { patch: { theme: 'light', baseSize: 125 } } }],
    run: async (ctx, a) => {
      const s = ctx.state.settings;
      const url = a.patch.selectedThread;
      if (url && !s.threads.some((t) => t.url === url)) fail('not_found', `The thread ${url} is not in the list (threads.add adds it)`);
      const keys = Object.keys(a.patch);
      const previous = Object.fromEntries(keys.map((k) => [k, s[k] ?? null]));
      await ctx.actions.changeSettings(a.patch); // theme / historyLimit remount the editor, as the Settings dialog does
      return { keys, previous };
    },
  }),

  define({
    id: 'tags.list',
    title: 'List the draft status tags in workflow order',
    brief: 'Use it to get a tag id for drafts_setTag.',
    group: 'tags',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'array' },
    examples: [{ args: {} }],
    run: (ctx) => tags(ctx).map((t) => ({ ...t, drafts: draftsWithTag(ctx.state.settings, ctx.state.drafts, t.id).length })),
  }),
  define({
    id: 'tags.add',
    title: 'Add a status tag at the end of the workflow order',
    group: 'tags',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: NAME, color: COLOR, id: TAG_ID } },
    result: { type: 'object', required: ['tagId'] },
    examples: [{ args: { name: 'Needs review' } }, { args: { name: 'Blocked', color: '#e05252', id: 'blocked' } }],
    run: async (ctx, a) => {
      if (a.id && tags(ctx).some((t) => t.id === a.id)) fail('already_exists', `A tag has the id ${a.id}`);
      const tag = { id: a.id ?? crypto.randomUUID(), name: a.name.trim(), color: a.color ?? '#a3a3a3' }; // as Add tag in Settings
      await ctx.actions.saveSettings({ tags: [...tags(ctx), tag] });
      return { tagId: tag.id };
    },
  }),
  define({
    id: 'tags.update',
    title: 'Rename or recolour a status tag',
    group: 'tags',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', required: ['tagId', 'patch'], additionalProperties: false,
      properties: { tagId: TAG_ID, patch: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: NAME, color: COLOR } } },
    },
    result: { type: 'object', required: ['tagId', 'previous'] },
    examples: [{ args: { tagId: 'progress', patch: { name: 'Doing' } } }],
    run: async (ctx, a) => {
      const tag = tagOf(ctx, a.tagId);
      const patch = { ...a.patch, ...(a.patch.name && { name: a.patch.name.trim() }) };
      await ctx.actions.saveSettings({ tags: tags(ctx).map((t) => (t.id === a.tagId ? { ...t, ...patch } : t)) });
      return { tagId: a.tagId, previous: { name: tag.name, color: tag.color } };
    },
  }),
  define({
    id: 'tags.move',
    title: 'Place a status tag just before or after another tag in the workflow order',
    group: 'tags',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', required: ['tagId'], additionalProperties: false,
      properties: { tagId: TAG_ID, beforeId: TAG_ID, afterId: TAG_ID },
      oneOf: [{ required: ['beforeId'] }, { required: ['afterId'] }],
    },
    result: { type: 'object', required: ['tagId', 'index'] },
    examples: [{ args: { tagId: 'done', beforeId: 'todo' } }],
    run: async (ctx, a) => {
      const target = a.beforeId ?? a.afterId;
      tagOf(ctx, a.tagId);
      if (target === a.tagId) fail('not_found', `No other tag has the id ${target}`);
      tagOf(ctx, target);
      const order = moveBeside(tags(ctx).map((t) => t.id), a.tagId, target, !!a.afterId);
      await ctx.actions.saveSettings({ tags: order.map((id) => tags(ctx).find((t) => t.id === id)) });
      return { tagId: a.tagId, index: order.indexOf(a.tagId) };
    },
  }),
  define({
    id: 'tags.remove',
    title: 'Remove a status tag (the drafts that carry it become untagged)',
    group: 'tags',
    risk: 'destructive',
    undo: 'none',
    args: { type: 'object', required: ['tagId'], additionalProperties: false, properties: { tagId: TAG_ID } },
    result: { type: 'object', required: ['tag', 'draftIds'] },
    examples: [{ args: { tagId: 'progress' } }],
    ask: (ctx, a) => `remove the tag "${tagOf(ctx, a.tagId).name}" (its drafts become untagged)`,
    run: async (ctx, a) => {
      const s = ctx.state.settings;
      const tag = tagOf(ctx, a.tagId);
      const draftIds = draftsWithTag(s, ctx.state.drafts, tag.id).map((d) => d.id);
      const rest = tags(ctx).filter((t) => t.id !== tag.id);
      await ctx.actions.saveSettings({ tags: rest, draftTags: pruneMap(s.draftTags, ctx.state.drafts, rest) }); // as Settings does
      return { tag, draftIds };
    },
  }),

  define({
    id: 'folders.list',
    title: 'List the draft folders',
    brief: 'Use it to get a folder id by its name.',
    group: 'folders',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'array' },
    examples: [{ args: {} }],
    run: (ctx) => folders(ctx).map((f) => ({ ...f, drafts: inFolder(ctx, f.id).length })),
  }),
  define({
    id: 'folders.create',
    title: 'Add a draft folder at the end of the list',
    group: 'folders',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: NAME } },
    result: { type: 'object', required: ['folderId'] },
    examples: [{ args: { name: 'Week 3' } }],
    run: async (ctx, a) => ({ folderId: await ctx.actions.createFolder(a.name) }),
  }),
  define({
    id: 'folders.rename',
    title: 'Rename a draft folder',
    group: 'folders',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', required: ['folderId', 'name'], additionalProperties: false, properties: { folderId: FOLDER_ID, name: NAME } },
    result: { type: 'object', required: ['folderId', 'name', 'previous'] },
    examples: [{ args: { folderId: EXAMPLE_FOLDER, name: 'Week 4' } }],
    run: (ctx, a) => {
      const previous = folderOf(ctx, a.folderId).name;
      ctx.actions.renameFolder(a.folderId, a.name);
      return { folderId: a.folderId, name: a.name.trim(), previous };
    },
  }),
  define({
    id: 'folders.delete',
    title: 'Delete a draft folder (its drafts move to the top level; no draft is deleted)',
    group: 'folders',
    risk: 'destructive',
    undo: 'none',
    args: { type: 'object', required: ['folderId'], additionalProperties: false, properties: { folderId: FOLDER_ID } },
    result: { type: 'object', required: ['folder', 'draftIds'] },
    examples: [{ args: { folderId: EXAMPLE_FOLDER } }],
    ask: (ctx, a) => `delete the folder "${folderOf(ctx, a.folderId).name}" (its drafts move to the top level)`,
    run: async (ctx, a) => {
      const folder = folderOf(ctx, a.folderId);
      const draftIds = inFolder(ctx, folder.id);
      await ctx.actions.doDeleteFolder(folder.id);
      return { folder, draftIds };
    },
  }),
];

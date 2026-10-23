import { define, fail } from './define.mjs';
import { ref } from './schema-defs.mjs';
import { mergeThreads, topicId } from '../../thread-url.mjs';

// threads.* (SPEC §8 Catalogue): the sidebar's list (settings.threads), one entry per call, through actions.js. Projects mode
// lists projects (keyed project:<uuid>), forum mode forum threads (topic URLs).

const THREAD = 'project:3a7c9e1b-5d2f-4b8a-9c6e-1f0d2b4a6c8e';
const TOPIC = 'https://forum.example.com/topic/88136-level-design/';
const URL_ARG = { type: 'object', required: ['url'], additionalProperties: false, properties: { url: ref('URL') } };

const threads = (ctx) => ctx.state.settings.threads;
const threadOf = (ctx, url) => threads(ctx).find((t) => t.url === url) ?? fail('not_found', `${url} is not in the list`);

export const defs = [
  define({
    id: 'threads.list',
    title: 'List the projects (forum mode: the forum threads) of the sidebar',
    brief: 'Use it to get the URL of a project or thread by its title.',
    group: 'threads',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'array' },
    examples: [{ args: {} }],
    run: (ctx) => threads(ctx).map((t) => ({ ...t, selected: t.url === ctx.state.settings.selectedThread })),
  }),
  define({
    id: 'threads.add',
    title: 'Add a project by its title (forum mode: a forum thread by its topic URL)',
    group: 'threads',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: { url: ref('URL'), title: { type: 'string', maxLength: 200 } } },
    result: { type: 'object', required: ['url'] },
    examples: [{ args: { title: 'Level design' } }, { args: { url: TOPIC } }, { args: { url: TOPIC, title: 'Level design' } }],
    run: async (ctx, a) => {
      if (!ctx.actions.isForum(ctx.state.settings)) {
        if (!a.title?.trim()) fail('invalid_args', 'A project needs a title', { path: '/title', message: 'is required for a project', expected: { type: 'string', minLength: 1 } });
        return { url: await ctx.actions.addProject(a.title) };
      }
      if (!a.url) fail('invalid_args', 'A forum thread needs its topic URL', { path: '/url', message: 'is required in forum mode', expected: { $ref: '#/$defs/URL' } });
      const u = ctx.actions.normalizeThread(a.url);
      if (u && threads(ctx).some((t) => topicId(t.url) === topicId(u))) fail('already_exists', `The thread ${u} is already in the list`);
      const url = await ctx.actions.addThread(u, a.title?.trim());
      if (!url) fail('invalid_args', 'Not a forum topic URL', { path: '/url', message: 'is not a forum topic URL', expected: { $ref: '#/$defs/URL' } });
      return { url };
    },
  }),
  define({
    id: 'threads.remove',
    title: 'Remove a project or forum thread from the list (its drafts are kept)',
    group: 'threads',
    risk: 'destructive',
    undo: 'none',
    args: URL_ARG,
    result: { type: 'object', required: ['thread', 'selected'] },
    examples: [{ args: { url: THREAD } }],
    ask: (ctx, a) => `remove "${ctx.actions.threadLabel(threadOf(ctx, a.url))}" from the list (its drafts are kept)`,
    run: async (ctx, a) => {
      const thread = threadOf(ctx, a.url);
      const selected = ctx.state.settings.selectedThread === a.url;
      await ctx.actions.doRemoveThread(a.url);
      return { thread, selected };
    },
  }),
  define({
    id: 'threads.select',
    title: 'Show the drafts of one project or thread in the sidebar (null: all drafts)',
    group: 'threads',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { anyOf: [ref('URL'), { type: 'null' }] } } },
    result: { type: 'object', required: ['url', 'previous'] },
    examples: [{ args: { url: THREAD } }, { args: { url: null } }],
    run: async (ctx, a) => {
      if (a.url) threadOf(ctx, a.url);
      const previous = ctx.state.settings.selectedThread ?? null;
      await ctx.actions.saveSettings({ selectedThread: a.url });
      return { url: a.url, previous };
    },
  }),
  define({
    id: 'threads.discover',
    title: 'Find the forum threads the logged-in user posted in and add them to the list',
    group: 'threads',
    risk: 'write',
    undo: 'none',
    slow: true,
    needs: ['app.forum'],
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'object', required: ['added', 'total'] },
    examples: [{ args: {} }],
    run: async (ctx) => {
      let found;
      try {
        ({ threads: found } = await ctx.api.forum.discover());
      } catch (e) {
        const message = String(e?.message ?? e);
        if (message.includes('not-logged-in')) fail('failed', 'Log in to the forum first (forum.login)', { reason: 'not-logged-in' });
        throw e;
      }
      // As "Find my threads" (actions.js discoverThreads): a known thread keeps its entry, updated by what the forum says.
      const { threads: merged, added } = mergeThreads(threads(ctx), found);
      await ctx.actions.saveSettings({ threads: merged });
      return { added, total: merged.length };
    },
  }),
  define({
    id: 'threads.openInForum',
    title: 'Open a forum thread in the forum window',
    group: 'threads',
    risk: 'approval', // outward-facing: it loads the forum site
    undo: 'none',
    headless: false,
    needs: ['app.forum'],
    args: URL_ARG,
    result: { type: 'object', required: ['url'] },
    examples: [{ args: { url: TOPIC } }],
    ask: (ctx, a) => ({ title: 'open a forum thread in the forum window', description: a.url }),
    run: async (ctx, a) => {
      await ctx.api.forum.open(a.url);
      return { url: a.url };
    },
  }),
];

import { define, fail } from './define.mjs';
import { ref } from './schema-defs.mjs';
import { topicId, topicOf } from '../../thread-url.mjs';

// threads.* (SPEC §8 Catalogue): the sidebar's projects (settings.threads, keyed project:<uuid>, or by the topic URL for a forum
// thread added before projects), one entry per call, through actions.js. A project may link a forum thread (its Push target).

const THREAD = 'project:3a7c9e1b-5d2f-4b8a-9c6e-1f0d2b4a6c8e';
const TOPIC = 'https://forum.example.com/topic/88136-level-design/';
const URL_ARG = { type: 'object', required: ['url'], additionalProperties: false, properties: { url: ref('URL') } };

const threads = (ctx) => ctx.state.settings.threads;
const threadOf = (ctx, url) => threads(ctx).find((t) => t.url === url) ?? fail('not_found', `${url} is not in the list`);

export const defs = [
  define({
    id: 'threads.list',
    title: 'List the projects of the sidebar, with the forum thread each one links (if any)',
    brief: 'Use it to get the URL of a project by its title.',
    group: 'threads',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'array' },
    examples: [{ args: {} }],
    run: (ctx) => threads(ctx).map((t) => ({ ...t, thread: topicOf(threads(ctx), t.url) || null, selected: t.url === ctx.state.settings.selectedThread })),
  }),
  define({
    id: 'threads.add',
    title: 'Add a project by its title, a forum thread, or both',
    brief: "thread: the forum topic URL its drafts push to. Without a title the project takes the thread's title.",
    group: 'threads',
    risk: 'write',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 }, thread: ref('URL', 'A forum topic URL') } },
    result: { type: 'object', required: ['url'] },
    examples: [{ args: { title: 'Level design' } }, { args: { thread: TOPIC } }, { args: { title: 'Level design', thread: TOPIC } }],
    run: async (ctx, a) => {
      if (!a.title?.trim() && !a.thread) fail('invalid_args', 'A project needs a title or a forum thread', { path: '', message: 'needs title or thread', expected: { required: ['title'] } });
      if (a.thread) {
        const u = ctx.actions.normalizeThread(a.thread);
        if (!u) fail('invalid_args', `Not a topic URL of the forum (${ctx.state.settings.forumUrl || 'any forum while none is set'})`, { path: '/thread', message: 'is not a topic URL of the forum', expected: { $ref: '#/$defs/URL' } });
        if (threads(ctx).some((t) => topicId(ctx.actions.projectTopic(t.url)) === topicId(u))) fail('already_exists', `A project already links ${u}`);
      }
      return { url: await ctx.actions.addProject(a.title ?? '', a.thread ?? '') };
    },
  }),
  define({
    id: 'threads.remove',
    title: 'Remove a project from the list (its drafts are kept)',
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
    title: 'Show the drafts of one project in the sidebar (null: all drafts)',
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
    id: 'threads.openInForum',
    title: "Open a project's forum thread in the forum window",
    group: 'threads',
    risk: 'approval', // outward-facing: it loads the forum site
    undo: 'none',
    headless: false,
    needs: ['app.forum'],
    args: URL_ARG,
    result: { type: 'object', required: ['url'] },
    examples: [{ args: { url: THREAD } }],
    ask: (ctx, a) => ({ title: 'open a forum thread in the forum window', description: ctx.actions.projectTopic(a.url) || a.url }),
    run: async (ctx, a) => {
      const url = ctx.actions.projectTopic(a.url) || fail('precondition_failed', 'That project links no forum thread', { failed: [{ gate: null, message: 'no forum thread', fix: 'Link one to the project first' }] });
      await ctx.api.forum.open(url);
      return { url };
    },
  }),
];

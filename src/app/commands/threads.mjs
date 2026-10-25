import { bare, enabled } from '../../integrations/index.mjs';
import { define, fail } from './define.mjs';
import { ref } from './schema-defs.mjs';

// threads.* (SPEC §8 Catalogue): the sidebar's projects (settings.threads, keyed project:<uuid>, or by the topic URL for a forum
// thread added before projects), one entry per call, through actions.js. While the forum integration is on, a project may link a
// forum thread (its Push target); while it is off, results leave out the keys it owns (integrations/index.mjs bare).

const THREAD = 'project:3a7c9e1b-5d2f-4b8a-9c6e-1f0d2b4a6c8e';
const TOPIC = 'https://forum.example.com/topic/88136-level-design/';
const URL_ARG = { type: 'object', required: ['url'], additionalProperties: false, properties: { url: ref('URL') } };

const threads = (ctx) => ctx.state.settings.threads;
const threadOf = (ctx, url) => threads(ctx).find((t) => t.url === url) ?? fail('not_found', `${url} is not in the list`);

export const defs = [
  define({
    id: 'threads.list',
    title: 'List the projects of the sidebar',
    brief: 'Use it to get the URL of a project by its title.',
    group: 'threads',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'array' },
    examples: [{ args: {} }],
    run: (ctx) => threads(ctx).map((t) => ({
      ...bare('project', t, ctx.state.settings),
      ...(enabled(ctx.state.settings, 'forum') && { thread: ctx.integrations.forum.projectTopic(t.url) || null }),
      selected: t.url === ctx.state.settings.selectedThread,
    })),
  }),
  define({
    id: 'threads.add',
    title: 'Add a project',
    brief: 'Use it to start a project for drafts.',
    group: 'threads',
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', maxLength: 200 },
        thread: ref('URL', "A forum topic URL, the thread its drafts push to. Without a title the project takes the thread's title."),
      },
    },
    integrationArgs: { thread: 'forum' },
    result: { type: 'object', required: ['url'] },
    examples: [{ args: { title: 'Level design' } }, { args: { thread: TOPIC } }, { args: { title: 'Level design', thread: TOPIC } }],
    run: async (ctx, a) => {
      if (!a.title?.trim() && !a.thread) {
        const forum = enabled(ctx.state.settings, 'forum');
        fail('invalid_args', forum ? 'A project needs a title or a forum thread' : 'A project needs a title', { path: '', message: forum ? 'needs title or thread' : 'needs title', expected: { required: ['title'] } });
      }
      // `thread` reaches run only while the forum is on (commands.js refuses an off integration's argument).
      if (a.thread) return { url: await ctx.integrations.forum.addLinkedProject(a.title ?? '', a.thread) };
      return { url: await ctx.actions.addProject(a.title) };
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
      return { thread: bare('project', thread, ctx.state.settings), selected };
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
];

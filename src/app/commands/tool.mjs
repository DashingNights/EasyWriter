import { define, fail } from './define.mjs';

// tool.* (SPEC §8 Catalogue): the palette entries (tools.js, §7c) that apply now. tools.js imports JSX, which the
// catalogue may not, so it hands its registry over through bindTools() when it loads (the renderer always loads it).

let registry = null;

/** Called by tools.js: {context(board), all(c), failedNeeds(entry, c), command(id)} (command: the catalogue's byId). */
export const bindTools = (r) => {
  registry = r;
};

const tools = () => registry ?? fail('failed', 'The tool registry is not loaded');

const brief = (t, c) => ({
  id: t.id, label: t.label, group: t.group, shortcut: (registry?.shortcut?.(t) ?? t.shortcut) || null, hasOptions: !!t.options, active: !!t.active?.(c),
  risk: t.risk ?? 'write', headless: t.headless ?? true, ...(t.command && { command: t.command }),
});

export const defs = [
  define({
    id: 'tool.list',
    title: 'List the palette tools that apply now (Ctrl+Space shows the same)',
    group: 'tool',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: {} },
    result: { type: 'array' },
    examples: [{ args: {} }],
    run: (ctx) => {
      const r = tools();
      const c = r.context(ctx.board);
      return r.all(c).filter((t) => t.when(c)).map((t) => brief(t, c));
    },
  }),
  define({
    id: 'tool.run',
    title: 'Run a palette tool for the current context (as Enter in Ctrl+Space)',
    group: 'tool',
    risk: 'write', // the entry's own risk applies: a destructive entry asks an agent (below)
    undo: 'doc',
    args: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } },
    result: { type: 'object' },
    examples: [{ args: { id: 'bold' } }, { args: { id: 'h2' } }],
    run: async (ctx, a) => {
      const r = tools();
      const c = r.context(ctx.board);
      const entry = r.all(c).find((t) => t.id === a.id) ?? fail('not_found', `No tool has the id ${a.id} (tool.list lists the tools that apply now)`);
      if (!entry.when(c)) {
        const failed = r.failedNeeds(entry, c);
        const message = `${entry.label} does not apply now`;
        fail('precondition_failed', failed.map((f) => f.message).join('; ') || message,
          { failed: failed.length ? failed : [{ gate: null, message, fix: 'tool.list lists the tools that apply now' }] });
      }
      if (!entry.run && !entry.command) fail('refused', `${entry.label} only has options: use doc.format or doc.command`, { code: 'options_only' });
      if (ctx.source.startsWith('agent:') && entry.headless === false) fail('denied', `${entry.label} needs the user at the window`, { reason: 'headless' });
      const risk = entry.risk ?? 'write';
      const rule = ctx.policy[risk];
      if (rule === 'deny') fail('denied', `${entry.label} is not allowed for ${ctx.source}`, { reason: 'policy' });
      if (rule === 'ask' && !(await ctx.ask(`run the tool "${entry.label}"`, '', { risk }))) fail('denied', 'The user denied the request', { reason: 'user' });
      // ponytail: a command entry runs its command's `run` here (New draft); a builder command would need the executor's dispatch.
      if (entry.command) return r.command(entry.command).run(ctx, entry.args?.(c) ?? {});
      await entry.run(c);
      return { id: entry.id, ...(entry.toggle && { active: !!entry.active(r.context(ctx.board)) }) };
    },
  }),
];

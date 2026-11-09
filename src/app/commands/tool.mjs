import { define, fail } from './define.mjs';

// tool.* (SPEC §8 Catalogue): the palette entries (tools.js, §7c) that apply now. tools.js imports JSX, which the
// catalogue may not, so it hands its registry over through bindTools() when it loads (the renderer always loads it).

let registry = null;

/** Called by tools.js: {context(board), all(c), failedNeeds(entry, c), command(id), shortcut(entry), aliases} (command: the
 * catalogue's byId; aliases: {old id: pool id}, the hand entries pool commands replaced). */
export const bindTools = (r) => {
  registry = r;
};

const tools = () => registry ?? fail('failed', 'The tool registry is not loaded');

/** Whether the entry `t` is for people only when `ctx` is an agent's call: the Word entries (`agent: false`,
 * docs/plans/word/plan.md §1.14), so an agent's list in a Document stays the size it was; agents edit Documents through doc.*.
 * Pool entries are visible unless their command's meta says `agent: false`. */
const hidden = (t, ctx) => t.agent === false && !!ctx.source?.startsWith('agent:');

/** The entry `id` names for `ctx`: its own, else, where that does not apply, the pool command an old id names (r.aliases), so
 * 'canvas' runs insert.canvas in a forum post and the hand entry in a Document. */
function entryOf(r, c, ctx, id) {
  const all = r.all(c);
  const find = (x) => x && all.find((t) => t.id === x && !hidden(t, ctx));
  const own = find(id);
  const alias = find(r.aliases?.[id]);
  return alias?.when(c) && !own?.when(c) ? alias : own ?? alias;
}

const brief = (t, c) => ({
  id: t.id, label: t.label, group: t.group, shortcut: (registry?.shortcut?.(t) ?? t.shortcut) || null, hasOptions: !!t.options, active: !!t.active?.(c),
  risk: t.risk ?? 'write', headless: t.headless ?? true, ...(t.command && { command: t.command }), ...(t.via && { via: t.via }),
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
      const old = Object.fromEntries(Object.entries(r.aliases ?? {}).map(([a, id]) => [id, a])); // pool id → its old id
      return r.all(c).filter((t) => !hidden(t, ctx) && t.when(c)).map((t) => ({ ...brief(t, c), ...(old[t.id] && { alias: old[t.id] }) }));
    },
  }),
  define({
    id: 'tool.run',
    title: 'Run a palette tool for the current context (as Enter in Ctrl+Space)',
    group: 'tool',
    risk: 'write', // the entry's own risk applies: a destructive entry asks an agent (below)
    undo: 'doc',
    args: {
      type: 'object', required: ['id'], additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 64, description: 'A tool.list id, or its alias (the old id)' },
        arg: { type: ['string', 'number', 'boolean', 'object', 'null'], description: 'The value of a pool tool that takes one (a font name, a colour id, {value})' },
      },
    },
    result: { type: 'object' },
    examples: [{ args: { id: 'bold' } }, { args: { id: 'h2' } }, { args: { id: 'text.color', arg: 'red' } }],
    run: async (ctx, a) => {
      const r = tools();
      const c = r.context(ctx.board);
      const entry = entryOf(r, c, ctx, a.id) ?? fail('not_found', `No tool has the id ${a.id} (tool.list lists the tools that apply now)`);
      if (a.arg !== undefined && !entry.arg) fail('invalid_args', `${entry.label} takes no arg`);
      if (!entry.when(c)) {
        const failed = r.failedNeeds(entry, c);
        const message = `${entry.label} does not apply now`;
        fail('precondition_failed', failed.map((f) => f.message).join('; ') || message,
          { failed: failed.length ? failed : [{ gate: null, message, fix: 'tool.list lists the tools that apply now' }] });
      }
      if (!entry.run && !entry.command) fail('refused', `${entry.label} only has options: use ${entry.via ?? 'doc.format or doc.command'}`, { code: 'options_only' });
      if (ctx.source.startsWith('agent:') && entry.headless === false) fail('denied', `${entry.label} needs the user at the window`, { reason: 'headless' });
      const risk = entry.risk ?? 'write';
      const rule = ctx.policy[risk];
      if (rule === 'deny') fail('denied', `${entry.label} is not allowed for ${ctx.source}`, { reason: 'policy' });
      if (rule === 'ask' && !(await ctx.ask(`run the tool "${entry.label}"`, '', { risk }))) fail('denied', 'The user denied the request', { reason: 'user' });
      // ponytail: a command entry runs its command's `run` here (New document, New forum post); a builder command would need the executor's dispatch.
      if (entry.command) return r.command(entry.command).run(ctx, entry.args?.(c) ?? {});
      // A pool command answers false when it did nothing (disabled, or a value it does not know).
      if (await entry.run(c, a.arg) === false && entry.arg) {
        fail('failed', entry.notice?.() || (entry.optionsFirst ? `${entry.label} needs a value it knows: pass it as arg` : `${entry.label} did not run`));
      }
      return { id: entry.id, ...(entry.toggle && { active: !!entry.active(r.context(ctx.board)) }) };
    },
  }),
];

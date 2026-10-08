import { findPlaybooks } from '../assistant/playbooks.mjs';
import { define, fail } from './define.mjs';
import { assistantMode, CATEGORIES, categoryOf, CORE, DESCRIBE_NAMES, refusal, toolName, VIEW_SETS } from './tool-sets.mjs';

// commands.* (SPEC §8 Catalogue; automation plan §7, §13.2 Tool calls): tool discovery for a model that is offered only a few
// tools. commands.index lists categories or tool summaries (a word search also the assistant's playbooks whose title matches,
// playbooks.mjs), commands.describe returns full tool schemas in the model form
// (the assistant's loop then offers them). Both read the catalogue through ctx.lib (commands.js).

const MAX_ENTRIES = 40;

/** The catalogue as `ctx.source` may call it: the assistant does not see what its permission mode refuses (tool-sets.mjs). */
function capsOf(ctx) {
  const caps = ctx.lib.capabilities(false);
  if (ctx.source !== 'agent:assistant') return caps;
  const mode = assistantMode(ctx.state.settings?.assistant);
  return caps.filter((c) => !refusal(c, mode));
}

export const defs = [
  define({
    id: 'commands.index',
    title: 'List tool categories, or the tools of a category, view or search',
    brief: 'Use it to find a tool you do not have.',
    notFor: 'finding items or blocks',
    group: 'commands',
    risk: 'read',
    undo: 'none',
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        category: { type: 'string', minLength: 1, maxLength: 32, description: 'A category name' },
        view: { enum: Object.keys(VIEW_SETS), description: 'The tools of one view' },
        q: { type: 'string', minLength: 1, maxLength: 60, description: 'Words in a tool name or summary' },
      },
    },
    result: { type: 'object' },
    examples: [{ args: {} }, { args: { category: 'board' } }, { args: { view: 'editor' } }, { args: { q: 'tag' } }],
    run: (ctx, a) => {
      const caps = capsOf(ctx);
      if (!a.category && !a.view && !a.q) {
        const count = new Map();
        for (const c of caps) count.set(categoryOf(c), (count.get(categoryOf(c)) ?? 0) + 1);
        return { categories: [...count].map(([category, n]) => ({ category, about: CATEGORIES[category] ?? '', count: n })) };
      }
      if (a.category && !caps.some((c) => categoryOf(c) === a.category)) {
        fail('not_found', `No category ${a.category}. The categories are ${[...new Set(caps.map(categoryOf))].join(', ')}`);
      }
      const inView = a.view && [...CORE, ...VIEW_SETS[a.view]];
      const words = a.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      const hits = caps.filter((c) => (!a.category || categoryOf(c) === a.category) && (!inView || inView.includes(c.id))
        && words.every((w) => `${toolName(c.id)} ${c.title} ${categoryOf(c)}`.toLowerCase().includes(w)));
      const tools = hits.slice(0, MAX_ENTRIES).map((c) => ({ name: toolName(c.id), about: c.title, risk: c.risk }));
      // The playbooks the situation note did not carry (playbooks.mjs): a word search also finds them by title.
      const playbooks = a.q ? findPlaybooks(a.q, ctx.source === 'agent:assistant' ? assistantMode(ctx.state.settings?.assistant).permission : 'standard') : [];
      return { tools, ...(hits.length > MAX_ENTRIES && { more: hits.length - MAX_ENTRIES }), ...(playbooks.length && { playbooks }) };
    },
  }),
  define({
    id: 'commands.describe',
    title: 'Get the schemas of up to 6 tools by name and add them to your tools',
    brief: 'Use it after commands_index.',
    guide: { before: 'Check your tools first. Never make up a name', errors: 'unknown lists the names that do not exist' },
    group: 'commands',
    risk: 'read',
    undo: 'none',
    args: {
      type: 'object', required: ['names'], additionalProperties: false,
      properties: {
        names: { type: 'array', minItems: 1, maxItems: DESCRIBE_NAMES, items: { type: 'string', minLength: 1, maxLength: 64 }, description: 'Tool names or command ids' },
      },
    },
    result: { type: 'object', required: ['tools', 'risk', 'unknown'] },
    examples: [{ args: { names: ['board_set'] } }, { args: { names: ['doc.command', 'history_state'] } }],
    run: (ctx, a) => {
      const caps = capsOf(ctx);
      const capOf = (n) => caps.find((c) => c.id === n || toolName(c.id) === n);
      const found = [...new Set(a.names.map(capOf).filter(Boolean))];
      return {
        tools: ctx.lib.tools(found.map((c) => c.id)),
        risk: Object.fromEntries(found.map((c) => [toolName(c.id), c.risk])),
        unknown: a.names.filter((n) => !capOf(n)),
      };
    },
  }),
];

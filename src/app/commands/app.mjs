import { define } from './define.mjs';
import { NO_ARGS } from './schema-defs.mjs';

// app.* / ui.* / audit.* (SPEC §8 Catalogue). The live UI is read through ctx.lib (commands.js), which knows the boards,
// the canvas editor and the catalogue.

export const defs = [
  define({
    id: 'app.info',
    title: 'Describe the app and the open draft',
    group: 'app',
    risk: 'read',
    undo: 'none',
    args: NO_ARGS,
    result: { type: 'object', required: ['apiVersion', 'rev'] },
    examples: [{ args: {} }],
    run: (ctx) => ({
      appVersion: ctx.lib.appVersion,
      apiVersion: 1,
      userData: null, // reported once main exposes it (agent transport, automation Phase 3)
      draftId: ctx.state.draft?.id ?? null,
      rev: ctx.state.rev,
      loggedIn: !!ctx.state.status?.loggedIn,
      agent: {
        enabled: !!ctx.state.settings?.agent?.enabled,
        hidden: ctx.state.agent.hidden,
        connections: ctx.state.agent.connections.map(({ name, since }) => ({ name, since })),
      },
    }),
  }),
  define({
    id: 'app.capabilities',
    title: 'List the commands, their schemas and the gates they need',
    group: 'app',
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: { available: { type: 'boolean', default: false } } },
    result: { type: 'array' },
    examples: [{ args: {} }, { args: { available: true } }],
    run: (ctx, a) => ctx.lib.capabilities(a.available),
  }),
  define({
    id: 'ui.state',
    title: 'Describe the view, mode and selection now',
    brief: 'Use it when the situation note is not enough.',
    group: 'ui',
    risk: 'read',
    undo: 'none',
    args: NO_ARGS,
    result: { type: 'object', required: ['view', 'mode', 'selection', 'busy', 'gates'] },
    examples: [{ args: {} }],
    run: (ctx) => ctx.lib.uiState(),
  }),
  define({
    id: 'audit.tail',
    title: 'Read the latest audit lines of this session',
    group: 'audit',
    risk: 'read',
    undo: 'none',
    args: {
      type: 'object', additionalProperties: false,
      properties: {
        n: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
        source: { type: 'string', maxLength: 40 },
        draftId: { type: 'string', maxLength: 36 },
      },
    },
    result: { type: 'array' },
    examples: [{ args: {} }, { args: { n: 10, source: 'agent:assistant' } }],
    run: (ctx, a) => ctx.lib.auditTail(a),
  }),
];

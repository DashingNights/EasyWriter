// The integrations registry (docs/plans/integrations.md Registry). Pure: main.js (getSettings, setSettings), node tests and
// the renderer read it. It imports the manifests only; command defs are spread by catalogue.mjs, because define.mjs imports
// gates.mjs, which imports this file.
import forum from './forum/manifest.mjs';

export const INTEGRATIONS = [forum];

/** Whether integration `id` is turned on (settings.integrations, Settings > Integrations). */
export const enabled = (settings, id) => settings?.integrations?.[id]?.enabled === true;

/** The settings every integration adds to main.js DEFAULT_SETTINGS: all off, plus each manifest's own keys. */
export const DEFAULTS = {
  integrations: Object.fromEntries(INTEGRATIONS.map((i) => [i.id, { enabled: false }])),
  ...Object.assign({}, ...INTEGRATIONS.map((i) => i.defaults)),
};

/** settings.json's `stored` object (a plain object) through each manifest's migrate. */
export const migrateSettings = (stored) => INTEGRATIONS.reduce((s, i) => i.migrate(s), stored);

/** Throws unless `value` (a settings.set partial's `integrations`) is {<known id>: {enabled: boolean}}. */
export function checkIntegrations(value) {
  const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!plain(value)) throw new Error('integrations must be an object');
  for (const [id, v] of Object.entries(value)) {
    if (!INTEGRATIONS.some((i) => i.id === id)) throw new Error(`unknown integration ${id}`);
    if (!plain(v) || typeof v.enabled !== 'boolean') throw new Error(`integrations.${id}.enabled must be true or false`);
  }
}

/** The gates the integrations add to app/gates.mjs, each tagged with its integration: every manifest's own, plus
 * integration.<id>, which a command with `integration: id` needs first (define.mjs). ui.state lists an off integration's
 * gates nowhere (commands.js gatesNow). wake.<id> (manifest wake) is untagged: the palette entry that asks to turn the
 * integration back on needs it while the integration is off. It carries `wake` instead, so ui.state lists it nowhere either:
 * only the user turns an integration on. */
export const integrationGates = () => Object.assign({}, ...INTEGRATIONS.map((i) => ({
  ...Object.fromEntries(Object.entries(i.gates ?? {}).map(([id, g]) => [id, { ...g, integration: i.id }])),
  [`integration.${i.id}`]: {
    subject: 'settings', test: (s) => enabled(s, i.id), message: `The ${i.name} integration is off`,
    fix: i.turnOn ?? 'The user turns it on in Settings > Integrations', integration: i.id,
  },
  ...(i.wake && { [`wake.${i.id}`]: { ...i.wake, wake: i.id } }),
})));

/** Whether slot `name` of integration `id`, which is off, renders with `props` anyway (integrations/ui.js Slot): one of its
 * manifest `wakes` slots, on the row of the open draft ({d}), when its `wake` test holds for that draft. `state` is the
 * store's {settings, draft}. */
export function wakes(id, name, props, { settings, draft }) {
  const i = INTEGRATIONS.find((x) => x.id === id);
  if (!i?.wake || enabled(settings, id) || !i.wakes?.includes(name) || !draft || props.d?.id !== draft.id) return false;
  return !!i.wake.test({ ...draft, threads: settings?.threads });
}

const valueAt = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);

/** The integration owning an argument of `args` that command `def` (its integrationArgs: {'<dotted path under
 * args.properties>': id}) takes only while that integration is on and that is off with `settings`, or null. */
export const offArg = (def, args, settings) => Object.entries(def.integrationArgs ?? {})
  .find(([path, id]) => !enabled(settings, id) && valueAt(args, path) !== undefined)?.[1] ?? null;

/** Command `def` as an agent sees it with `settings`: null while its integration is off; else without the arguments of off
 * integrations. The catalogue itself keeps them, so the executor can name the integration when a cached tool list passes one
 * (commands.js). Examples stay: the model sees only examples[0] (tools-schema.mjs modelDescription, read from the catalogue),
 * which uses no integration argument (commands-contract.test). */
export function listed(def, settings) {
  if (def.integration && !enabled(settings, def.integration)) return null;
  const off = Object.entries(def.integrationArgs ?? {}).filter(([, id]) => !enabled(settings, id)).map(([path]) => path);
  if (!off.length) return def;
  const args = structuredClone(def.args);
  for (const path of off) {
    const keys = path.split('.');
    const last = keys.pop();
    const s = keys.reduce((o, k) => o.properties[k], args);
    delete s.properties[last];
    if (s.required) s.required = s.required.filter((k) => k !== last);
  }
  return { ...def, args };
}

/** `obj` (kind 'settings': settings.json, 'project': a settings.threads entry, 'draft') without the keys off integrations own
 * (manifest owns), for command results only: the stored data keeps them (constraint 3). */
export function bare(kind, obj, settings) {
  const off = INTEGRATIONS.filter((i) => !enabled(settings, i.id));
  if (!obj || !off.length) return obj;
  const out = { ...obj };
  for (const i of off) for (const k of i.owns[kind] ?? []) delete out[k];
  if (kind === 'settings') {
    if (out.integrations) out.integrations = Object.fromEntries(Object.entries(out.integrations).filter(([id]) => enabled(settings, id)));
    if (Array.isArray(out.threads)) out.threads = out.threads.map((t) => bare('project', t, settings));
  }
  return out;
}

/** What the enabled integrations add after the open draft's project in the assistant's situation note (manifest situation),
 * joined. */
export const situationNotes = (draft, settings) => INTEGRATIONS.filter((i) => enabled(settings, i.id)).map((i) => i.situation?.(draft, settings) ?? '').join('');

/** What the enabled integrations add to the MCP instructions (manifest agentNote), joined. */
export const agentNotes = (settings) => INTEGRATIONS.filter((i) => enabled(settings, i.id)).map((i) => i.agentNote ?? '').join('');

import { deref } from '../schema.mjs';
import { CATALOGUE } from './catalogue.mjs';
import { GUIDE } from './define.mjs';
import { toolName } from './tool-sets.mjs';

// Commands as OpenAI function tools (SPEC §8 Tool schemas; agent-automation plan §4.6, §13.1): the in-app assistant's tool loop
// now, the MCP bridge later. Tool name = command id with '.' → '_'; parameters = the args schema rewritten for hosts: `$ref`
// inlined (a description beside it kept), `oneOf` → `anyOf`, a type list → `anyOf` of single types, `default` / `examples`
// dropped. Two forms: 'host' (description = title + the gates it needs) and 'model' (description = title, the command's
// `brief`, Not-for line and first example, then its guide lines; limits, patterns, additionalProperties and titles dropped too:
// the registry still validates the full schema and names it on invalid_args). Pure.

export { toolName };

/** The command id of tool `name`, looked up among `ids` (default: the catalogue), or null. */
export const commandIdOf = (name, ids = CATALOGUE.map((d) => d.id)) => ids.find((id) => toolName(id) === name) ?? null;

// Keys the model form leaves out.
const SLIM = ['additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'pattern', 'title'];

/** `schema` rewritten as above (a copy); `slim`: the model form. */
export function rewrite(schema, $defs, { slim = false } = {}) {
  const s = schema?.$ref && schema.description ? { ...deref(schema, $defs), description: schema.description } : deref(schema, $defs);
  if (!s || typeof s !== 'object') return s;
  const again = (x) => rewrite(x, $defs, { slim });
  const { default: _d, examples: _e, $ref: _r, oneOf, anyOf, type, properties, items, additionalProperties, ...rest } = s;
  if (Array.isArray(type) && type.length > 1) {
    const { title, description, ...base } = s;
    const branch = (t) => (t === 'null' ? { type: 'null' } : again({ ...base, type: t }));
    return { ...(title && !slim && { title }), ...(description && { description }), anyOf: type.map(branch) };
  }
  const out = { ...rest };
  if (slim) for (const k of SLIM) delete out[k];
  if (type !== undefined) out.type = Array.isArray(type) ? type[0] : type;
  const branches = oneOf ?? anyOf;
  if (branches) out.anyOf = branches.map(again);
  if (properties) out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, again(v)]));
  if (items) out.items = again(items);
  if (additionalProperties !== undefined && !slim) out.additionalProperties = typeof additionalProperties === 'object' ? again(additionalProperties) : additionalProperties;
  return out;
}

const DEFS = new Map(CATALOGUE.map((d) => [d.id, d]));

/** The model-form description of command `id` titled `title`: the title, the command's `brief` (when to use it), "Not for: "
 * with its `notFor` (what not to use it for, and what to use instead) and "e.g. " with its first example's arguments (left out
 * when they are {}); then a line per entry of its `guide` (wave 1c): "Before: …", "Args: …", "Errors: …", "Playbook: …" (wave 2b). */
export function modelDescription(id, title) {
  const def = DEFS.get(id);
  const ex = JSON.stringify(def?.examples[0].args ?? {});
  const end = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
  const head = [end(title), def?.brief, def?.notFor && `Not for: ${end(def.notFor)}`, ex !== '{}' && `e.g. ${ex}`].filter(Boolean).join(' ');
  const guide = Object.entries(GUIDE).flatMap(([k, label]) => (def?.guide?.[k] ? [`${label}: ${end(def.guide[k])}`] : []));
  return [head, ...guide].join('\n');
}

/** `capabilities` (app.capabilities answers: [{id, title, args, needs: [{gate, fix}]}]) as OpenAI function tools, only the
 * commands in `ids` when given; `form` 'host' or 'model' (above). */
export function toolsFor(capabilities, { ids, $defs, form = 'host' }) {
  const model = form === 'model';
  return capabilities.filter((c) => !ids || ids.includes(c.id)).map((c) => ({
    type: 'function',
    function: {
      name: toolName(c.id),
      description: model ? modelDescription(c.id, c.title) : c.title + (c.needs?.length ? ` Needs: ${c.needs.map((n) => `${n.gate}: ${n.fix}`).join('; ')}` : ''),
      parameters: rewrite(c.args, $defs, { slim: model }),
    },
  }));
}

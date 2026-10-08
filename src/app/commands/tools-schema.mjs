import { deref } from '../schema.mjs';
import { CATALOGUE } from './catalogue.mjs';
import { GUIDE, unionText } from './define.mjs';
import { toolName } from './tool-sets.mjs';

// Commands as OpenAI function tools (SPEC §8 Tool schemas; agent-automation plan §4.6, §13.1): the in-app assistant's tool loop
// now, the MCP bridge later. Tool name = command id with '.' → '_'; parameters = the args schema rewritten for hosts and
// llama.cpp: `$ref` inlined (a description beside it kept), `oneOf` → `anyOf`, a type list → `anyOf` of single types, `default` /
// `examples` dropped. Two forms: 'host' (description = title + the gates it needs) and 'model' (description = title, the
// command's `brief`, Not-for line and first example, then its guide lines; limits, patterns, additionalProperties and titles
// dropped too: the registry still validates the full schema and names it on invalid_args). The model form of family 'gemma'
// (wave 1c) has no unions: Gemma 4's chat template renders a parameter from type, enum, items, properties, required and nullable
// only, so an anyOf came out as type "" with no alternatives; a union there is one schema of its first branch's type with the
// alternatives in its description, and an enum gets a type: string (the template shows an enum only then; a null in it becomes
// nullable) or number (its values go in the description). Family 'qwen'
// keeps anyOf: llama.cpp builds Qwen3.5's tool-call grammar from the schema, where one type would forbid "at": "end". Pure.

export { toolName };

/** The command id of tool `name`, looked up among `ids` (default: the catalogue), or null. */
export const commandIdOf = (name, ids = CATALOGUE.map((d) => d.id)) => ids.find((id) => toolName(id) === name) ?? null;

// Keys the model form leaves out.
const SLIM = ['additionalProperties', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
  'pattern', 'title'];
// A branch that only adds constraints (doc.format's anyOf of required keys): the flat form drops such a union.
const SHAPED = ['type', 'enum', 'const', 'properties', 'items', '$ref', 'oneOf', 'anyOf'];

/** `schema` rewritten as above (a copy); `slim`: the model form; `flat` (with slim): no unions, the gemma family's. */
export function rewrite(schema, $defs, { slim = false, flat = false } = {}) {
  const s = schema?.$ref && schema.description ? { ...deref(schema, $defs), description: schema.description } : deref(schema, $defs);
  if (!s || typeof s !== 'object') return s;
  const again = (x) => rewrite(x, $defs, { slim, flat });
  const { default: _d, examples: _e, $ref: _r, oneOf, anyOf, type, properties, items, additionalProperties, ...rest } = s;
  if (flat && slim) {
    const { title: _t, description, ...base } = s;
    const list = Array.isArray(type) && type.length > 1 ? type.map((t) => (t === 'null' ? { type: 'null' } : { ...base, type: t })) : null;
    const branches = list ?? oneOf ?? anyOf;
    if (branches && !branches.some((b) => SHAPED.some((k) => k in b))) {
      const { oneOf: _o, anyOf: _a, ...own } = s; // constraints only: the registry checks them
      return again(own);
    }
    if (branches) {
      const kept = branches.filter((b) => deref(b, $defs)?.type !== 'null');
      const { oneOf: _o, anyOf: _a, ...own } = list ? {} : base; // the union's own keys (an object's properties beside it)
      const first = again({ ...own, ...(list ? kept[0] : { ...deref(kept[0], $defs), ...(kept[0].description && { description: kept[0].description }) }) });
      const named = description ?? (branches.length > 1 ? unionText(branches, $defs) : first.description);
      const nullable = kept.length < branches.length && named && !/\bnull\b/i.test(named);
      return { ...first, ...(named && { description: nullable ? `${named}, or null` : named }) };
    }
  }
  if (Array.isArray(type) && type.length > 1) {
    const { title, description, ...base } = s;
    const branch = (t) => (t === 'null' ? { type: 'null' } : again({ ...base, type: t }));
    return { ...(title && !slim && { title }), ...(description && { description }), anyOf: type.map(branch) };
  }
  const out = { ...rest };
  if (slim) for (const k of SLIM) delete out[k];
  if (type !== undefined) out.type = Array.isArray(type) ? type[0] : type;
  else if (flat && Array.isArray(out.enum)) { // Gemma's template shows an enum only on a string: null as nullable, numbers in words
    const vals = out.enum.filter((v) => v !== null);
    if (vals.length < out.enum.length) out.nullable = true;
    if (vals.every((v) => typeof v === 'string')) Object.assign(out, { type: 'string', enum: vals });
    else {
      delete out.enum;
      Object.assign(out, { type: 'number', description: [out.description?.replace(/\.$/, ''), `One of ${vals.join(', ')}`].filter(Boolean).join('. ') });
    }
  }
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
 * commands in `ids` when given; `form` 'host' or 'model' (above); `family` (the model form's): 'qwen' or 'gemma' (prompts.mjs
 * familyOf). */
export function toolsFor(capabilities, { ids, $defs, form = 'host', family = 'qwen' }) {
  const model = form === 'model';
  return capabilities.filter((c) => !ids || ids.includes(c.id)).map((c) => ({
    type: 'function',
    function: {
      name: toolName(c.id),
      description: model ? modelDescription(c.id, c.title) : c.title + (c.needs?.length ? ` Needs: ${c.needs.map((n) => `${n.gate}: ${n.fix}`).join('; ')}` : ''),
      parameters: rewrite(c.args, $defs, { slim: model, flat: model && family === 'gemma' }),
    },
  }));
}

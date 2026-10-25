import { checkSchema, deref } from '../schema.mjs';
import { INTEGRATIONS } from '../../integrations/index.mjs';
import { GATES } from '../gates.mjs';

// define(def) checks a command definition when its module loads (SPEC §8 Command definition) and fills its defaults:
// headless true, slow false, needs []. `hidden` (optional, a headless: false command): the fix an agent gets while the window
// is hidden, in place of the window.visible gate's own. `brief` (optional): one sentence on when to use the command, `notFor` (optional): what
// a model wrongly reaches for it to do and what to use instead, and `guide` (optional, wave 1c, after OpenCode's one text per
// tool): {before?, args?, errors?, playbook?}, short sentences on what to do before calling, the argument rules and what its errors
// mean, and the id of its playbook (wave 2b); all for the model form of the tools (tools-schema.mjs: "Not for: <notFor>", a line
// "Before: …", "Args: …", "Errors: …", "Playbook: …" each). `integration` (optional): the id of the integration the command
// belongs to; its gate integration.<id> goes first in needs, and agents see the command only while it is on (integrations/
// index.mjs listed). `integrationArgs` (optional): {'<dotted path under args.properties>': id}, arguments only that
// integration's command form takes (hidden and refused while it is off). `check` (optional): (args, draft, settings) -> the ids of
// gates that fail for these arguments (the executor reports them with the needs, before any ask); for a rule that depends on an
// argument and that capabilities() must not see.
// Pure: catalogue modules stay importable by node --test.

// ids are `<namespace>.<name>[.<name>…]`; `batch` and `calls` are the top-level ids.
export const ID_RE = /^([a-z]+(\.[a-zA-Z]+)+|batch|calls)$/;
export const RISKS = ['read', 'write', 'destructive', 'approval'];
export const UNDOS = ['doc', 'own', 'none'];
// guide key → its line's label, in this order; `playbook` (wave 2b) names the playbook (playbooks.mjs id) to follow for the tool
export const GUIDE = { before: 'Before', args: 'Args', errors: 'Errors', playbook: 'Playbook' };

// What a union's branch is called in a model-form description or a teaching message (unionText).
const KIND_WORDS = { array: 'a list', object: 'an object', integer: 'a whole number', number: 'a number', string: 'text', boolean: 'true or false', null: 'null' };

/** The alternatives of a union (oneOf / anyOf / a type list, as schemas; `$defs` resolves a `$ref`) in words, for a model:
 * each branch's description, else "one of a, b" (an enum), its type ("a list", "text", "null"); "A list, or one of start, end". */
export function unionText(branches, $defs) {
  const words = branches.map((b) => ({ ...deref(b, $defs), ...(b?.description && { description: b.description }) })).map((b) => b.description
    ?? (b.enum ? `one of ${b.enum.join(', ')}` : b.const !== undefined ? JSON.stringify(b.const) : KIND_WORDS[b.type]
      ?? (b.required ? `with ${b.required.join(' and ')}` : 'a value')));
  const s = words.join(', or ');
  return s[0].toUpperCase() + s.slice(1);
}

export function define(def) {
  const bad = (what) => {
    throw new Error(`command ${def.id}: ${what}`);
  };
  if (typeof def.id !== 'string' || !ID_RE.test(def.id) || def.id.length > 48) bad('id must match ' + ID_RE + ' (48 characters at most)');
  if (typeof def.title !== 'string' || !def.title) bad('title');
  if (def.brief !== undefined && (typeof def.brief !== 'string' || !def.brief)) bad('brief must be a sentence');
  if (def.notFor !== undefined && (typeof def.notFor !== 'string' || !def.notFor)) bad('notFor must be a sentence');
  if (def.hidden !== undefined && (typeof def.hidden !== 'string' || !def.hidden || def.headless !== false)) bad('hidden is a sentence for a headless: false command');
  if (def.guide !== undefined && (!def.guide || typeof def.guide !== 'object' || !Object.keys(def.guide).length
    || Object.entries(def.guide).some(([k, v]) => !Object.hasOwn(GUIDE, k) || typeof v !== 'string' || !v))) bad(`guide takes sentences for ${Object.keys(GUIDE)}`);
  if (typeof def.group !== 'string' || !def.group) bad('group');
  if (!RISKS.includes(def.risk)) bad(`risk must be one of ${RISKS}`);
  if (!UNDOS.includes(def.undo)) bad(`undo must be one of ${UNDOS}`);
  if (def.args?.type !== 'object') bad('args must be an object schema');
  checkSchema(def.args);
  if (def.result) checkSchema(def.result);
  if (!Array.isArray(def.examples) || !def.examples.length) bad('at least one example');
  if (typeof def.plan !== 'function' && typeof def.run !== 'function') bad('plan or run');
  if (def.check !== undefined && typeof def.check !== 'function') bad('check must be a function');
  const known = (id) => INTEGRATIONS.some((i) => i.id === id);
  if (def.integration !== undefined && !known(def.integration)) bad(`integration ${def.integration} is not one of ${INTEGRATIONS.map((i) => i.id)}`);
  for (const [path, id] of Object.entries(def.integrationArgs ?? {})) {
    if (!known(id)) bad(`integrationArgs ${path}: ${id} is not an integration`);
    if (!path.split('.').reduce((s, k) => s?.properties?.[k], def.args)) bad(`integrationArgs ${path} is not an argument`);
  }
  const out = { headless: true, slow: false, needs: [], ...def };
  if (def.integration) out.needs = [`integration.${def.integration}`, ...out.needs];
  for (const n of out.needs) {
    const gate = typeof n === 'string' ? n : n?.gate;
    if (!Object.hasOwn(GATES, gate)) bad(`needs an unknown gate ${gate}`);
  }
  return out;
}

/** The invalid_args message for validation error `e` ({path, message}, schema.mjs validate) of `def`'s args, `at` naming them
 * ('args', or 'steps[2].args' in a batch): the validator's line, the description of the failing argument (the nearest one up
 * its path, `$ref` siblings included; a union without one: its alternatives, unionText) and the command's first example, so a
 * model can correct the call (SPEC §8 Errors). */
export function argsMessage(def, e, $defs, at = 'args') {
  const keys = e.path.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  const look = (x) => (x?.$ref ? { ...deref(x, $defs), ...(x.description && { description: x.description }) } : x);
  let s = def.args;
  let about = '';
  for (let i = 0; ; i++) {
    s = look(s);
    if (typeof s?.description === 'string') about = `${keys.slice(0, i).join('/')}: ${s.description}`.replace(/^: /, '').replace(/([^.!?])$/, '$1.');
    if (i === keys.length && s && typeof s.description !== 'string') { // a union with no words of its own: name its alternatives (wave 1c)
      const alts = s.oneOf ?? s.anyOf ?? (Array.isArray(s.type) && s.type.length > 1 ? s.type.map((type) => ({ type })) : null);
      if (alts) about = `${keys.join('/')}: ${unionText(alts, $defs)}.`.replace(/^: /, '');
    }
    if (i === keys.length || !s || typeof s !== 'object') break;
    const branches = [s, ...(s.oneOf ?? s.anyOf ?? []).map(look)];
    const b = branches.find((x) => x?.properties?.[keys[i]] !== undefined) ?? branches.find((x) => x?.items && /^\d+$/.test(keys[i]));
    if (!b) break;
    s = b.properties?.[keys[i]] ?? b.items;
  }
  return `${at}${e.path} ${e.message}.${about ? ` ${about}` : ''} Example: ${JSON.stringify(def.examples[0].args)}`;
}

/** Throws a command error: the executor answers {ok: false, error: {code, message, data}} (codes: SPEC §8 Errors). */
export function fail(code, message, data) {
  throw Object.assign(new Error(message), { code, data });
}

/** A precondition_failed answer naming the gates `ids` (ones the executor cannot read from the arguments); `message`
 * defaults to theirs. */
export function failGates(ids, message) {
  const failed = ids.map((gate) => ({ gate, message: GATES[gate].message, fix: GATES[gate].fix }));
  fail('precondition_failed', message ?? failed.map((f) => f.message).join('; '), { failed });
}

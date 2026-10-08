// The JSON-Schema subset the command layer uses (SPEC §8; agent-automation plan §8): `type` (a name or a list),
// `properties` / `required` / `additionalProperties` / `minProperties` / `maxProperties`, `enum` / `const`, `items` /
// `minItems` / `maxItems`, `minimum` / `maximum`, `minLength` / `maxLength` / `pattern`, `oneOf` / `anyOf`, `$ref` to
// `#/$defs/<name>`, and `default` (filled by withDefaults). Pure and import-free; schemas stay plain JSON for MCP hosts.

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'enum', 'const',
  'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'oneOf', 'anyOf', '$ref', 'default',
  'title', 'description', 'examples']);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'object': return isObject(v);
    case 'array': return Array.isArray(v);
    case 'null': return v === null;
    default: return false;
  }
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const pointer = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** The schema `$ref` names (`#/$defs/<name>`), else the schema itself. */
export function deref(schema, $defs = {}) {
  let s = schema;
  for (let i = 0; s?.$ref && i < 16; i++) {
    const name = /^#\/\$defs\/(.+)$/.exec(s.$ref)?.[1];
    if (!name || !Object.hasOwn($defs, name)) throw new Error(`unknown $ref ${s.$ref}`);
    s = $defs[name];
  }
  return s;
}

/** The errors of `value` against `schema`: [{path, message, expected}], `path` a JSON pointer ('' = the value itself),
 * `expected` the schema at that pointer with its `$ref` resolved. Empty: valid. */
export function validate(schema, value, $defs = {}, path = '') {
  const s = deref(schema, $defs);
  const err = (message, at = path, expected = s) => [{ path: at, message, expected }];
  if (!s || s === true) return [];
  if (s.type !== undefined) {
    const types = [].concat(s.type);
    if (!types.some((t) => typeOk(t, value))) return err(`must be ${types.join(' or ')}`);
  }
  if (s.const !== undefined && !same(s.const, value)) return err(`must be ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((x) => same(x, value))) return err(`must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  if (s.oneOf || s.anyOf) {
    const branches = s.oneOf ?? s.anyOf;
    const fits = branches.filter((b) => !validate(b, value, $defs, path).length).length;
    if (!fits) {
      // One branch only: its own error is the useful one. Several: name the forms.
      if (branches.length === 1) return validate(branches[0], value, $defs, path);
      return err(`must match ${s.oneOf ? 'exactly one' : 'one'} of ${branches.length} forms`);
    }
    if (s.oneOf && fits > 1) return err(`matches more than one of ${branches.length} forms`);
  }
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) return err(`must be at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && value.length > s.maxLength) return err(`must be at most ${s.maxLength} characters`);
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) return err(`must match ${s.pattern}`);
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) return err(`must be at least ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) return err(`must be at most ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) return err(`must have at least ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) return err(`must have at most ${s.maxItems} items`);
    if (s.items) {
      for (let i = 0; i < value.length; i++) {
        const e = validate(s.items, value[i], $defs, pointer(path, i));
        if (e.length) return e;
      }
    }
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (s.minProperties !== undefined && keys.length < s.minProperties) return err(`must have at least ${s.minProperties} properties`);
    if (s.maxProperties !== undefined && keys.length > s.maxProperties) return err(`must have at most ${s.maxProperties} properties`);
    for (const k of s.required ?? []) if (!Object.hasOwn(value, k)) return err(`is required`, pointer(path, k), s.properties?.[k] ? deref(s.properties[k], $defs) : {});
    for (const k of keys) {
      const sub = s.properties?.[k];
      if (sub !== undefined) {
        const e = validate(sub, value[k], $defs, pointer(path, k));
        if (e.length) return e;
      } else if (s.additionalProperties === false) {
        return err(`is not allowed (allowed: ${Object.keys(s.properties ?? {}).join(', ') || 'none'})`, pointer(path, k), {});
      } else if (isObject(s.additionalProperties)) {
        const e = validate(s.additionalProperties, value[k], $defs, pointer(path, k));
        if (e.length) return e;
      }
    }
  }
  return [];
}

/** `value` with the missing object properties that have a `default` filled in (a copy; the input is never mutated). */
export function withDefaults(schema, value, $defs = {}) {
  const s = deref(schema, $defs);
  if (!isObject(value) || !s?.properties) return value;
  const out = { ...value };
  for (const [k, sub] of Object.entries(s.properties)) {
    const d = deref(sub, $defs);
    if (out[k] === undefined && d?.default !== undefined) out[k] = structuredClone(d.default);
    else if (out[k] !== undefined) out[k] = withDefaults(d, out[k], $defs);
  }
  return out;
}

/** Throws when `schema` uses a keyword or type outside the subset (a typo would otherwise validate everything). */
export function checkSchema(schema, at = '#') {
  if (schema === true || (isObject(schema) && !Object.keys(schema).length)) return;
  if (!isObject(schema)) throw new Error(`${at}: a schema must be an object`);
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`${at}: unknown keyword ${k}`);
  for (const t of [].concat(schema.type ?? [])) if (!TYPES.has(t)) throw new Error(`${at}: unknown type ${t}`);
  if (schema.pattern !== undefined) new RegExp(schema.pattern); // throws on a bad pattern
  for (const [k, sub] of Object.entries(schema.properties ?? {})) checkSchema(sub, `${at}/properties/${k}`);
  if (schema.items) checkSchema(schema.items, `${at}/items`);
  if (isObject(schema.additionalProperties)) checkSchema(schema.additionalProperties, `${at}/additionalProperties`);
  for (const key of ['oneOf', 'anyOf']) (schema[key] ?? []).forEach((sub, i) => checkSchema(sub, `${at}/${key}/${i}`));
}

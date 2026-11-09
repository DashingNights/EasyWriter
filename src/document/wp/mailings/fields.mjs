// The mail merge field types (docs/plans/word/plan.md §1.10, briefs/mailings.md Fields; fields.json MERGEFIELD to GREETINGLINE)
// and the `record` cursor they read through ctx.get('record'). The cursor is per update: NEXT, NEXTIF and SKIPIF move or mark it,
// and MERGEFIELD, MERGEREC and MERGESEQ read it, so one update of a label sheet walks several records. With no cursor (no data
// source, or Preview Results off) each type shows Word's placeholder in chevrons. Pure: node tests load it.
import { fieldType, parseField } from '../../fields/registry.mjs';
import { ADDRESS_FIELDS, columnOf, mapped } from './data.mjs';

/** The field types this package owns, in Word's order. */
export const MERGE_NAMES = ['MERGEFIELD', 'MERGEREC', 'MERGESEQ', 'NEXT', 'NEXTIF', 'SKIPIF', 'ADDRESSBLOCK', 'GREETINGLINE'];
const MERGE_SET = new Set(MERGE_NAMES);
/** Whether field name `name` is one of the merge types (Highlight Merge Fields shades these). */
export const isMergeName = (name) => MERGE_SET.has(String(name).toUpperCase());

/** `name` in Word's merge chevrons: «First Name». */
export const chevron = (name) => `\u00AB${name}\u00BB`;

/** Word's error when a MERGEFIELD names a column the source lacks. */
export const MISSING = 'Error! MergeField was not found in header record of data source.';

/** The text of field result `r`. */
export const resultText = (r) => (r == null ? '' : typeof r === 'string' ? r : r.error ?? r.text ?? '');

/** A record cursor (plan.md §1.10 provider `record`) over `list` ([{n, values}], the merge's active records) of `source`, starting at
 * position `start` (0-based) with `seq` records merged so far; positions from `end` on count as past the last record. */
export function makeCursor(source, merge, list, start = 0, seq = 1, end = list.length) {
  const fields = source?.fields ?? [];
  const c = {
    pos: start,
    seq,
    skipped: false,
    fields,
    /** 1-based position in the active list: MERGEREC. */
    get index() { return c.pos + 1; },
    get done() { return c.pos >= Math.min(end, list.length); },
    get values() { return c.done ? null : list[c.pos]?.values ?? null; },
    /** The value of column `name` → string ('' past the last record), or null when the source has no such column. */
    value(name) {
      const i = columnOf(fields, name);
      if (i < 0) return null;
      return c.values?.[i] ?? '';
    },
    /** The value of address field `key` through Match Fields (merge.map). */
    mapped: (key) => (c.values ? mapped(fields, merge?.map, c.values, key) : ''),
    /** NEXT: the following record, without a new copy. */
    next() {
      c.pos++;
      c.seq++;
    },
    /** SKIPIF: this copy is dropped. */
    skip() {
      c.skipped = true;
    },
  };
  return c;
}

const recordOf = (ctx) => ctx?.get?.('record') ?? null;

// ---------- conditions (NEXTIF, SKIPIF) ----------

const NUM = /^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/;
const wild = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, '.*')}$`, 's');

/** Word's IF and COMPARE rule for `a op b`, used while fields-ref's COMPARE is not registered: numbers compare as numbers; = and <>
 * match ? and * in the second text; text compares case-sensitively. An unknown operator is false (an error counts as false). */
export function compareLocal(a, op, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (NUM.test(x) && NUM.test(y)) {
    const d = Number(x) - Number(y);
    return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op] ?? false;
  }
  if (op === '=' || op === '<>') {
    const eq = /[?*]/.test(y) ? wild(y).test(x) : x === y;
    return op === '=' ? eq : !eq;
  }
  const d = x < y ? -1 : x > y ? 1 : 0;
  return { '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op] ?? false;
}

/** The result text of nested field code `code` in `ctx`, computed through the registered types (its own nested fields first). */
export function nestedText(code, ctx) {
  const f = parseField(code, (inner) => nestedText(inner, ctx));
  const type = fieldType(f.name);
  if (!type) return '';
  try {
    return resultText(type.compute(f, ctx));
  } catch {
    return '';
  }
}

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Whether the condition of NEXTIF or SKIPIF field `f` holds: through COMPARE when registered (fields-ref keeps IF's rules), else
 * compareLocal. Nested fields ({ MERGEFIELD City }) take their values from the same cursor. */
export function conditionOf(f, ctx) {
  const p = parseField(f.code, (inner) => nestedText(inner, ctx));
  const [a = '', op = '', b = ''] = p.args;
  const cmp = fieldType('COMPARE');
  if (!cmp) return compareLocal(a, op, b);
  try {
    const r = cmp.compute(parseField(`COMPARE ${quote(a)} ${op} ${quote(b)}`), ctx);
    return !(r && typeof r === 'object' && r.error) && resultText(r).trim() === '1';
  } catch {
    return false;
  }
}

// ---------- ADDRESSBLOCK and GREETINGLINE ----------

/** Word's default Address Block format (\f), with \n for a line break as Word writes it in the code (unverified). */
export const ADDRESS_FORMAT = '<<_TITLE0_ >><<_FIRST0_>><< _LAST0_>><< _SUFFIX0_>>\\n<<_COMPANY_\\n>><<_STREET1_\\n>><<_STREET2_\\n>><<_CITY_>><<, _STATE_>><< _POSTAL_>><<\\n_COUNTRY_>>';
/** Word's default Greeting Line format (\f) and its text for a recipient without a usable name (\e). */
export const GREETING_FORMAT = '<<_BEFORE_ Dear >><<_TITLE0_>><< _LAST0_>><<_AFTER_ ,>>';
export const GREETING_EMPTY = 'Dear Sir or Madam,';

// The address field each token reads (Match Fields keys).
const TOKENS = {
  TITLE0: 'courtesyTitle', FIRST0: 'first', MIDDLE0: 'middle', LAST0: 'last', SUFFIX0: 'suffix', NICK0: 'nickname', JOBTITLE: 'jobTitle',
  COMPANY: 'company', STREET1: 'address1', STREET2: 'address2', CITY: 'city', STATE: 'state', POSTAL: 'postal', COUNTRY: 'country',
};
const NAME_TOKENS = new Set(['FIRST0', 'MIDDLE0', 'LAST0', 'SUFFIX0', 'NICK0']);
// Tokens that hold no value but print the text in their chevrons whenever the name prints (the greeting's word and punctuation).
const MARKERS = { BEFORE: '', AFTER: '', GREETING: 'Dear', PUNCTUATION: ',' };
const TOKEN = /<<([^<>]*?)_([A-Z0-9]+)_([^<>]*?)>>/g;

/** Format `format` (Word's \f tokens) with `valueOf(token)`: the text inside a token's chevrons prints only when it has a value;
 * \n is a line break; blank lines go. → {text, tokens (the names used)}. */
export function formatTokens(format, valueOf) {
  const tokens = [];
  const text = String(format ?? '').replace(/\\n/g, '\n').replace(TOKEN, (_, pre, name, post) => {
    tokens.push(name);
    // A marker's text follows it after one space, which only separates ("<<_AFTER_ ,>>" prints ",").
    if (name in MARKERS) return `${pre}${MARKERS[name]}${MARKERS[name] ? post : post.replace(/^ /, '')}`;
    const v = valueOf(name) ?? '';
    return v.trim() ? `${pre}${v}${post}` : '';
  });
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  return { text: lines.join('\n'), tokens };
}

/** The address of the cursor's record through `\f` (default Word's), `\c` (0 never, 1 always, 2 only when not `\e`) and `\e`. */
export function addressBlock(f, rec) {
  const c = String(f.sw.c ?? '0');
  const excluded = String(f.sw.e ?? '').trim().toLowerCase();
  return formatTokens(f.sw.f || ADDRESS_FORMAT, (name) => {
    const v = TOKENS[name] ? rec.mapped(TOKENS[name]) : '';
    if (name !== 'COUNTRY') return v;
    if (c === '0') return '';
    return c === '2' && v.trim().toLowerCase() === excluded ? '' : v;
  }).text;
}

/** The greeting of the cursor's record through `\f` and `\e`: the `\e` text when every name token but the title is blank. */
export function greetingLine(f, rec) {
  const { text, tokens } = formatTokens(f.sw.f || GREETING_FORMAT, (name) => (TOKENS[name] ? rec.mapped(TOKENS[name]) : ''));
  const names = tokens.filter((t) => NAME_TOKENS.has(t));
  const blank = names.length ? names.every((t) => !rec.mapped(TOKENS[t]).trim()) : !text.trim();
  return blank ? String(f.sw.e ?? GREETING_EMPTY) : text;
}

// ---------- the types ----------

/** MERGEFIELD's value: `\b` before and `\f` after only when the value is not blank; `\m` reads an address field through Match
 * Fields. A column the source lacks gives Word's error. */
function mergeField(f, ctx) {
  const name = f.args[0] ?? '';
  const rec = recordOf(ctx);
  if (!rec) return chevron(name);
  let v = rec.value(name);
  if (v == null && f.sw.m) {
    const a = ADDRESS_FIELDS.find((x) => x.label.toLowerCase() === name.toLowerCase() || x.key === name);
    if (a) v = rec.mapped(a.key);
  }
  if (v == null) return { error: MISSING };
  if (!v.trim()) return '';
  const pre = typeof f.sw.b === 'string' ? f.sw.b : '';
  const post = typeof f.sw.f === 'string' ? f.sw.f : '';
  return { text: `${pre}${v}${post}` };
}

const type = (compute, extra) => ({ category: 'Mail Merge', updates: 'merge', compute, ...extra });
const step = (label, act) => (f, ctx) => {
  const rec = recordOf(ctx);
  if (!rec) return chevron(label);
  act(f, ctx, rec);
  return '';
};

/** The field types by name (module `fields`). */
export const FIELDS = {
  MERGEFIELD: type(mergeField, { bare: 'mv' }),
  MERGEREC: type((f, ctx) => {
    const rec = recordOf(ctx);
    return rec ? { text: String(rec.index) } : chevron('Merge Record #');
  }),
  MERGESEQ: type((f, ctx) => {
    const rec = recordOf(ctx);
    return rec ? { text: String(rec.seq) } : chevron('Merge Sequence #');
  }),
  NEXT: type(step('Next Record', (f, ctx, rec) => rec.next())),
  NEXTIF: type(step('Next Record If', (f, ctx, rec) => conditionOf(f, ctx) && rec.next())),
  SKIPIF: type(step('Skip Record If', (f, ctx, rec) => conditionOf(f, ctx) && rec.skip())),
  ADDRESSBLOCK: type((f, ctx) => {
    const rec = recordOf(ctx);
    if (!rec) return chevron('AddressBlock');
    return rec.values ? { text: addressBlock(f, rec) } : '';
  }, { bare: 'd' }),
  GREETINGLINE: type((f, ctx) => {
    const rec = recordOf(ctx);
    if (!rec) return chevron('GreetingLine');
    return rec.values ? { text: greetingLine(f, rec) } : '';
  }),
};

// ---------- codes ----------

const word = (s) => (/[\s"\\{}]/.test(s) || !s ? quote(s) : s);

/** The MERGEFIELD code for column `name` (quoted when it holds a space), `mapped` adding \m. */
export const mergeFieldCode = (name, { mapped: m = false } = {}) => `MERGEFIELD ${word(name)}${m ? ' \\m' : ''}`;

/** The ADDRESSBLOCK code for Address Block's choices. */
export const addressCode = ({ format = ADDRESS_FORMAT, lang = 1033, country = 2, exclude = 'United States', destination = true } = {}) =>
  `ADDRESSBLOCK \\f ${quote(format).replace(/\\\\n/g, '\\n')} \\l ${lang} \\c ${country} \\e ${quote(exclude)}${destination ? ' \\d' : ''}`;

/** The GREETINGLINE code for Greeting Line's choices. */
export const greetingCode = ({ format = GREETING_FORMAT, lang = 1033, empty = GREETING_EMPTY } = {}) =>
  `GREETINGLINE \\f ${quote(format)} \\l ${lang} \\e ${quote(empty)}`;

/** The merge field names a field code reads (its own MERGEFIELD and those nested in it). */
export function mergeNamesIn(code) {
  const out = [];
  const visit = (c) => {
    const f = parseField(c, (inner) => {
      visit(inner);
      return '';
    });
    if (f.name === 'MERGEFIELD') out.push({ name: f.args[0] ?? '', mapped: !!f.sw.m });
  };
  visit(code);
  return out;
}

/** The MERGEFIELD names among `codes` that `source` cannot fill (Check for Errors), each once, in order. */
export function missingFields(codes, source, merge) {
  const out = [];
  for (const code of codes) {
    for (const { name, mapped: m } of mergeNamesIn(code)) {
      if (columnOf(source?.fields ?? [], name) >= 0) continue;
      const a = m && ADDRESS_FIELDS.find((x) => x.label.toLowerCase() === name.toLowerCase());
      if (a && merge?.map?.[a.key]) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

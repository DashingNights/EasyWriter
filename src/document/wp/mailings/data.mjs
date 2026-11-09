// Mail merge recipient data (docs/plans/word/plan.md §3 mailings, briefs/mailings.md). A source is {name, fields, records}: the column
// names and one array of strings per record, aligned with fields. It lives in the draft record (draft.mergeSource), never in the doc,
// so history and autosave never copy it. What the user picks from it lives in doc.attrs.merge: filter, sort, exclude (1-based source
// record numbers) and map (Match Fields). Pure: node tests load it.

/** The most records a source may hold; a larger list is refused (its records would inflate the draft record on every save). */
export const MAX_RECORDS = 5000;

/** The columns of Word's Type a New List grid, in its order. */
export const TYPED_FIELDS = ['Title', 'First Name', 'Last Name', 'Company Name', 'Address Line 1', 'Address Line 2', 'City', 'State', 'ZIP Code',
  'Country or Region', 'Home Phone', 'Work Phone', 'E-mail Address'];

/** Word's address fields (Match Fields) by key, with the column names that match each on load besides its own label. */
export const ADDRESS_FIELDS = [
  ['uniqueId', 'Unique Identifier', ['id']],
  ['courtesyTitle', 'Courtesy Title', ['title']],
  ['first', 'First Name', ['given name', 'forename']],
  ['middle', 'Middle Name', []],
  ['last', 'Last Name', ['surname', 'family name']],
  ['suffix', 'Suffix', []],
  ['nickname', 'Nickname', []],
  ['jobTitle', 'Job Title', []],
  ['company', 'Company', ['company name', 'organisation', 'organization']],
  ['address1', 'Address 1', ['address line 1', 'address', 'street', 'street address']],
  ['address2', 'Address 2', ['address line 2']],
  ['city', 'City', ['town']],
  ['state', 'State', ['province', 'county', 'region']],
  ['postal', 'Postal Code', ['zip code', 'zip', 'postcode', 'post code']],
  ['country', 'Country or Region', ['country', 'country/region']],
  ['businessPhone', 'Business Phone', ['work phone', 'phone']],
  ['businessFax', 'Business Fax', ['fax']],
  ['homePhone', 'Home Phone', []],
  ['homeFax', 'Home Fax', []],
  ['email', 'E-mail Address', ['email', 'e-mail', 'email address']],
  ['webPage', 'Web Page', ['website', 'web site']],
].map(([key, label, also]) => ({ key, label, also }));

/** `s` reduced for name matching: lower case, letters and digits only ("First Name" and "FirstName" and "first_name" agree). */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- reading files ----------

/** The delimiter of delimited text `text`: a tab when its first line holds more tabs than commas, else a comma. */
export function delimiterOf(text) {
  const line = String(text).split(/\r?\n/, 1)[0] ?? '';
  const count = (c) => line.split(c).length - 1;
  return count('\t') > count(',') ? '\t' : ',';
}

/** Rows of delimited text (RFC 4180: quoted cells may hold the delimiter, line breaks and "" for a quote), as arrays of strings. */
export function parseRows(text, delimiter = delimiterOf(text)) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Blank lines (a trailing newline, an empty last line) are no records.
  return rows.filter((r) => r.some((v) => v !== ''));
}

/** Column names from header row `head`: blanks get "Field n" and repeats a number, so every column has its own name. */
export function fieldNames(head) {
  const seen = new Set();
  return head.map((raw, i) => {
    let name = String(raw ?? '').trim() || `Field ${i + 1}`;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${String(raw).trim() || `Field ${i + 1}`} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/** A source from rows (the first names the fields) → {name, fields, records} with each record as long as fields. */
export function sourceOfRows(rows, name) {
  const [head = [], ...rest] = rows;
  const fields = fieldNames(head);
  const records = rest.map((r) => fields.map((_, i) => String(r[i] ?? '')));
  return { name, fields, records };
}

/** A source from CSV, TSV or delimited TXT text `text` read from the file `name`. */
export const parseDelimited = (text, name = 'List') => sourceOfRows(parseRows(text), name);

/** The plain text of block JSON `node`: text nodes joined, a hard break as a line break. */
function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'field') return node.attrs?.result ?? '';
  return (node.content ?? []).map(textOf).join(node.type === 'tableCell' || node.type === 'tableHeader' ? '\n' : '');
}

/** A source from the first table of Document JSON `doc` (a recipient list kept as a draft), or null when it has none. */
export function sourceOfDoc(doc, name) {
  let table = null;
  const find = (n) => {
    if (table || !n) return;
    if (n.type === 'table') table = n;
    else for (const c of n.content ?? []) find(c);
  };
  find(doc);
  if (!table) return null;
  const rows = (table.content ?? []).map((row) => (row.content ?? []).map((cell) => textOf(cell).trim()));
  return sourceOfRows(rows, name);
}

/** Why `source` cannot be used, in our words, or null. */
export function refusal(source) {
  if (!source?.fields?.length) return 'That list has no column names in its first row.';
  if (source.records.length > MAX_RECORDS) return `That list has ${source.records.length.toLocaleString('en-GB')} recipients. A mail merge takes up to ${MAX_RECORDS.toLocaleString('en-GB')}.`;
  return null;
}

// ---------- values ----------

/** The column of `fields` that `name` names: exact, else ignoring case, else ignoring spaces, underscores and punctuation; -1 if none. */
export function columnOf(fields, name) {
  const n = String(name ?? '');
  let i = fields.indexOf(n);
  if (i < 0) i = fields.findIndex((f) => f.toLowerCase() === n.toLowerCase());
  if (i < 0) i = fields.findIndex((f) => squash(f) === squash(n));
  return i;
}

/** Match Fields on load: each address field's column by name (its label or a usual alias), keeping `map` entries that still name a
 * column → {key: column name | null}. */
export function autoMap(fields, map = {}) {
  const out = {};
  for (const a of ADDRESS_FIELDS) {
    const kept = map?.[a.key];
    if (kept && fields.includes(kept)) {
      out[a.key] = kept;
      continue;
    }
    const names = [a.label, ...a.also].map(squash);
    out[a.key] = fields.find((f) => names.includes(squash(f))) ?? null;
  }
  return out;
}

/** The value of address field `key` ('first', 'company'...) in `values` through `map` → string, '' when unmatched. */
export function mapped(fields, map, values, key) {
  const col = map?.[key];
  const i = col == null ? -1 : fields.indexOf(col);
  return i < 0 ? '' : values[i] ?? '';
}

// ---------- filter and sort ----------

/** Word's Filter and Sort comparisons. */
export const COMPARISONS = [
  ['eq', 'Equal to'], ['ne', 'Not equal to'], ['lt', 'Less than'], ['gt', 'Greater than'], ['le', 'Less than or equal'],
  ['ge', 'Greater than or equal'], ['blank', 'Is blank'], ['nonblank', 'Is not blank'], ['contains', 'Contains'], ['notContains', 'Does not contain'],
];

const asNumber = (s) => (/^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(s) ? Number(s) : null);

/** -1, 0 or 1 for `a` against `b`: as numbers when both are, else as text ignoring case. */
export function compareValues(a, b) {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x != null && y != null) return Math.sign(x - y);
  return Math.sign(String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true }));
}

/** Whether `value` meets comparison `op` with `to`. */
export function meets(value, op, to) {
  const v = String(value ?? '');
  const t = String(to ?? '');
  switch (op) {
    case 'eq': return compareValues(v, t) === 0;
    case 'ne': return compareValues(v, t) !== 0;
    case 'lt': return compareValues(v, t) < 0;
    case 'gt': return compareValues(v, t) > 0;
    case 'le': return compareValues(v, t) <= 0;
    case 'ge': return compareValues(v, t) >= 0;
    case 'blank': return v.trim() === '';
    case 'nonblank': return v.trim() !== '';
    case 'contains': return v.toLowerCase().includes(t.toLowerCase());
    case 'notContains': return !v.toLowerCase().includes(t.toLowerCase());
    default: return true;
  }
}

/** Whether record `values` passes `filter` ([{join: 'and'|'or', field, op, value}], the first row's join ignored). And binds
 * tighter than Or, as in a query: a Or b And c is a Or (b And c). */
export function passes(fields, values, filter) {
  const rows = (filter ?? []).filter((r) => r?.field && r.op);
  if (!rows.length) return true;
  const groups = [[]];
  rows.forEach((r, i) => {
    if (i && r.join === 'or') groups.push([]);
    groups.at(-1).push(r);
  });
  return groups.some((g) => g.every((r) => meets(values[columnOf(fields, r.field)] ?? '', r.op, r.value)));
}

/** Indexes 0..n-1 of `records` ordered by `sort` ([{field, desc}], up to three keys), stable. */
export function sortOrder(fields, records, sort) {
  const keys = (sort ?? []).filter((k) => k?.field).slice(0, 3).map((k) => ({ i: columnOf(fields, k.field), desc: !!k.desc })).filter((k) => k.i >= 0);
  const order = records.map((_, i) => i);
  if (!keys.length) return order;
  return order.sort((a, b) => {
    for (const k of keys) {
      const c = compareValues(records[a][k.i], records[b][k.i]);
      if (c) return k.desc ? -c : c;
    }
    return a - b;
  });
}

/** The records of `source` as `merge` shows them in Edit Recipient List: filtered, then sorted → [{n (1-based source number),
 * values, included}]. */
export function listed(source, merge) {
  if (!source) return [];
  const { fields, records } = source;
  const exclude = new Set(merge?.exclude ?? []);
  return sortOrder(fields, records, merge?.sort)
    .filter((i) => passes(fields, records[i], merge?.filter))
    .map((i) => ({ n: i + 1, values: records[i], included: !exclude.has(i + 1) }));
}

/** The records a merge goes through, in order: listed and ticked → [{n, values}]. Their positions (1-based) are MERGEREC. */
export const active = (source, merge) => listed(source, merge).filter((r) => r.included);

/** Groups of source record numbers whose records are equal in every column (Find duplicates), each group in source order. */
export function duplicates(source) {
  const seen = new Map();
  (source?.records ?? []).forEach((r, i) => {
    const key = JSON.stringify(r.map((v) => String(v).trim().toLowerCase()));
    seen.set(key, [...(seen.get(key) ?? []), i + 1]);
  });
  return [...seen.values()].filter((g) => g.length > 1);
}

/** The position (0-based) in `list` ([{values}]) of the first record after `from` whose `field` (or any column when null) holds
 * `text`, wrapping round; -1 when none does. */
export function findIn(fields, list, text, field = null, from = -1) {
  const t = String(text ?? '').toLowerCase();
  if (!t || !list.length) return -1;
  const col = field == null ? -1 : columnOf(fields, field);
  for (let k = 1; k <= list.length; k++) {
    const i = (from + k + list.length) % list.length;
    const values = list[i].values;
    if ((col < 0 ? values : [values[col]]).some((v) => String(v ?? '').toLowerCase().includes(t))) return i;
  }
  return -1;
}

/** `filter` and `sort` from the header filter menu of column `field`: value v, '(Blanks)' or '(Nonblanks)' → the filter, replacing
 * any row on that field; null (All) removes it. */
export function columnFilter(filter, field, pick) {
  const rest = (filter ?? []).filter((r) => r.field !== field);
  if (pick == null) return rest;
  const row = pick === '(Blanks)' ? { field, op: 'blank', value: '' } : pick === '(Nonblanks)' ? { field, op: 'nonblank', value: '' } : { field, op: 'eq', value: pick };
  return [...rest, { join: 'and', ...row }];
}

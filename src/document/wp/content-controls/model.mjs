// Content controls and legacy form fields, the pure part (docs/plans/word plan.md §1.8 sdt object and field ff, §3 content-controls):
// the Document Property bindings, placeholders, locks, the form field options and their checks. No DOM and no app import, so the
// node tests load it. ProseMirror nodes come in as arguments.

// ---------- Document Property controls ----------

/** The 15 Document Property items of Insert > Quick Parts and Header & Footer > Document Info: [item id, Word's label, props path]. */
export const DOC_PROPS = [
  ['abstract', 'Abstract', 'cover.abstract'],
  ['author', 'Author', 'core.creator'],
  ['category', 'Category', 'core.category'],
  ['comments', 'Comments', 'core.description'],
  ['company', 'Company', 'app.company'],
  ['companyAddress', 'Company Address', 'cover.address'],
  ['companyEMail', 'Company E-mail', 'cover.email'],
  ['companyFax', 'Company Fax', 'cover.fax'],
  ['companyPhone', 'Company Phone', 'cover.phone'],
  ['keywords', 'Keywords', 'core.keywords'],
  ['manager', 'Manager', 'app.manager'],
  ['publishDate', 'Publish Date', 'cover.publishDate'],
  ['status', 'Status', 'core.contentStatus'],
  ['subject', 'Subject', 'core.subject'],
  ['title', 'Title', 'core.title'],
];

/** The props value at `path` ('core.title') → a string ('' when unset). */
export const propValue = (props, path) => String(path.split('.').reduce((o, k) => o?.[k], props) ?? '');

/** A patch object that sets `path` to `value` ('core.title', 'A' → {core: {title: 'A'}}), for deepPatch. */
export const propPatch = (path, value) => path.split('.').reduceRight((v, k) => ({ [k]: v }), value);

// ---------- placeholders ----------

// Our own words for the default placeholders (Word's say "Click or tap here to enter text.").
const PLACEHOLDERS = { richText: 'Type here.', text: 'Type here.', comboBox: 'Pick an item.', dropDown: 'Pick an item.', date: 'Pick a date.',
  docPart: 'Pick a building block.' };

/** The placeholder text control `sdt` shows while empty: its own, else the type's default; '' for types without text (picture draws
 * an icon, check box, group and repeating sections have none). */
export const placeholderOf = (sdt) => sdt?.placeholder ?? PLACEHOLDERS[sdt?.type] ?? '';

/** Whether a control of `sdt`'s type shows a placeholder when emptied. */
export const hasPlaceholder = (sdt) => sdt?.type === 'picture' || !!placeholderOf(sdt);

/** A new control's sdt: a fresh id and `type`, with the keys that differ from the schema's defaults. */
export function newSdt(type, extra = {}) {
  const sdt = { id: String(Math.floor(Math.random() * 2 ** 31)), type, ...extra };
  if (type === 'date') sdt.date = { format: 'M/d/yyyy', lang: 'en-US', full: null, store: 'dateTime', calendar: 'gregorian', ...extra.date };
  if (type === 'repeating') sdt.repeat = { title: null, allowAddRemove: true, ...extra.repeat };
  if (type === 'text' && extra.multiLine == null) sdt.multiLine = false;
  return sdt;
}

// ---------- dates ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `date` (a Date, read in UTC) in Word's picture `fmt` (M/d/yyyy by default). ponytail: d, M, y and the day and month names only;
 * fields-core's \@ formatter takes over when the date picture needs times or locales. */
export function formatDate(date, fmt = 'M/d/yyyy') {
  const d = date.getUTCDate();
  const m = date.getUTCMonth();
  const y = date.getUTCFullYear();
  const map = { dddd: DAYS[date.getUTCDay()], ddd: DAYS[date.getUTCDay()].slice(0, 3), dd: String(d).padStart(2, '0'), d: String(d),
    MMMM: MONTHS[m], MMM: MONTHS[m].slice(0, 3), MM: String(m + 1).padStart(2, '0'), M: String(m + 1), yyyy: String(y), yy: String(y).slice(-2) };
  return fmt.replace(/dddd|ddd|dd|d|MMMM|MMM|MM|M|yyyy|yy/g, (t) => map[t]);
}

/** A date control bound to a property shows props `value`: an ISO day (yyyy-MM-dd, how Word stores PublishDate) in the control's
 * format, any other text as it is. → {text, full} with full the day for sdt.date.full. */
export function boundDate(date, value) {
  const full = /^\d{4}-\d{2}-\d{2}/.test(value) ? `${value.slice(0, 10)}T00:00:00Z` : null;
  return full ? { text: formatDate(new Date(full), date?.format ?? 'M/d/yyyy'), full } : { text: value, full: date?.full ?? null };
}

/** The value a date control gives its property: the ISO day when the shown text is still the picked day, else the text. */
export function dateValue(date, text) {
  return date?.full && formatDate(new Date(date.full), date.format ?? 'M/d/yyyy') === text ? date.full.slice(0, 10) : text;
}

// ---------- locks ----------

const listCache = new WeakMap(); // doc → its controls, so each doc is walked once however many rules ask (docs never change)
const idCache = new WeakMap();

/** Every control of `doc` → [{pos, node}] in document order. */
export function controlList(doc) {
  if (listCache.has(doc)) return listCache.get(doc);
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'sdtInline' || node.type.name === 'sdtBlock') out.push({ pos, node });
  });
  listCache.set(doc, out);
  return out;
}

/** Every control of `doc` with an id → Map id → {pos, node} (the first one when ids repeat). */
export function controlsById(doc) {
  if (idCache.has(doc)) return idCache.get(doc);
  const out = new Map();
  for (const c of controlList(doc)) if (c.node.attrs.sdt?.id && !out.has(c.node.attrs.sdt.id)) out.set(c.node.attrs.sdt.id, c);
  idCache.set(doc, out);
  return out;
}

/** Every control of `doc` with an id → Map id → node. */
export const controlsOf = (doc) => new Map([...controlsById(doc)].map(([id, c]) => [id, c.node]));

/** Group `node`'s content with the content of every control nested in it left out: what a group lock keeps unchanged. */
function skeleton(node) {
  const strip = (json) => ({ ...json, content: json.content?.map((c) => (/^sdt(Inline|Block)$/.test(c.type) && c.attrs?.sdt?.type !== 'group'
    ? { type: c.type, id: c.attrs?.sdt?.id } : strip(c))) });
  return JSON.stringify(strip(node.toJSON()).content ?? []);
}

/** Why the change from doc `before` to doc `after` breaks a control's lock, or null: an sdtLocked control was deleted, a
 * contentLocked control's content changed, or a group's content outside its nested controls changed. */
export function lockRefusal(before, after) {
  if (!controlList(before).some(({ node: n }) => (n.attrs.sdt?.lock ?? 'none') !== 'none' || n.attrs.sdt?.type === 'group')) return null;
  const old = controlsOf(before);
  const now = controlsOf(after);
  for (const [id, node] of old) {
    const { lock = 'none', type } = node.attrs.sdt;
    const next = now.get(id);
    if (!next) {
      if (lock === 'sdtLocked' || lock === 'sdtContentLocked') return 'This content control cannot be deleted.';
      continue;
    }
    if ((lock === 'contentLocked' || lock === 'sdtContentLocked') && !next.content.eq(node.content)) return 'The contents of this content control cannot be edited.';
    if (type === 'group' && skeleton(next) !== skeleton(node)) return 'Only the content controls inside this group can be edited.';
  }
  return null;
}

// ---------- legacy form fields ----------

export const EN_SPACES = ' '.repeat(5); // what an empty text form field shows (Word's five en spaces)
export const DROP_MAX = 25; // Word's limit of drop-down items
export const FORM_KINDS = { FORMTEXT: 'text', FORMCHECKBOX: 'checkBox', FORMDROPDOWN: 'dropDown' };
export const BOOKMARK_PREFIX = { text: 'Text', checkBox: 'Check', dropDown: 'Dropdown' };

/** Text form field Types: [stored value (w:textInput w:type), Word's label]. */
export const TEXT_TYPES = [['regular', 'Regular text'], ['number', 'Number'], ['date', 'Date'], ['currentDate', 'Current date'],
  ['currentTime', 'Current time'], ['calculated', 'Calculation']];
/** The Text format choices per type: [stored value (w:format), label]. */
export const TEXT_FORMATS = {
  regular: [['', ''], ['UPPERCASE', 'Uppercase'], ['LOWERCASE', 'Lowercase'], ['FIRST CAPITAL', 'First capital'], ['TITLE CASE', 'Title case']],
  number: ['', '0', '0.00', '#,##0', '#,##0.00', '$#,##0.00;($#,##0.00)', '0%', '0.00%'].map((f) => [f, f]),
  date: ['', 'M/d/yyyy', 'dddd, MMMM d, yyyy', 'MMMM d, yyyy', 'M/d/yy', 'yyyy-MM-dd', 'd-MMM-yy', 'M.d.yyyy', 'MMM. d, yy', 'd MMMM yyyy',
    'MMMM yy', 'MMM-yy'].map((f) => [f, f]),
  currentTime: ['', 'h:mm am/pm', 'h:mm:ss am/pm', 'HH:mm', 'HH:mm:ss'].map((f) => [f, f]),
};
TEXT_FORMATS.calculated = TEXT_FORMATS.number;
TEXT_FORMATS.currentDate = TEXT_FORMATS.date;
const CASE_SWITCH = { UPPERCASE: 'Upper', LOWERCASE: 'Lower', 'FIRST CAPITAL': 'FirstCap', 'TITLE CASE': 'Caps' };

/** The options a form field of `kind` starts with (field ff, §1.8). */
export function ffDefaults(kind, name) {
  const common = { name, help: null, status: null, enabled: true, calcOnExit: false };
  if (kind === 'checkBox') return { ...common, default: false, checked: null, size: null };
  if (kind === 'dropDown') return { ...common, items: [], result: 0 };
  return { ...common, type: 'regular', default: '', maxLength: 0, format: '' };
}

/** The result text form field `ff` of `kind` shows; `value` is a text field's current text. */
export function ffResult(kind, ff, value) {
  if (kind === 'checkBox') return (ff.checked ?? ff.default) ? '☒' : '☐';
  if (kind === 'dropDown') return ff.items?.[ff.result ?? 0] ?? EN_SPACES;
  return value || EN_SPACES;
}

/** The field code that computes a text form field of Type Current date, Current time or Calculation, or null for the typed types. */
export function computedCode(ff) {
  const pic = ff?.format ? ` \\@ "${ff.format}"` : '';
  if (ff?.type === 'currentDate') return `DATE${pic}`;
  if (ff?.type === 'currentTime') return `TIME${pic}`;
  const expr = String(ff?.default ?? '').replace(/^=/, '').trim();
  if (ff?.type === 'calculated' && expr) return `= ${expr}${ff.format ? ` \\# "${ff.format}"` : ''}`;
  return null;
}

/** Reset Form Fields for one field: → {ff, result} with the field back at its default. */
export function resetFf(kind, ff) {
  const next = kind === 'checkBox' ? { ...ff, checked: null } : kind === 'dropDown' ? { ...ff, result: 0 } : ff;
  return { ff: next, result: ffResult(kind, next, kind === 'text' ? ff.default : '') };
}

/** The lowest unused bookmark name `prefix` + n (Text1, Check1, Dropdown1 and up) among `names`. */
export function nextBookmarkName(prefix, names) {
  const taken = new Set([...names].map((n) => n.toLowerCase()));
  let n = 1;
  while (taken.has(`${prefix}${n}`.toLowerCase())) n++;
  return `${prefix}${n}`;
}

/** Why `value` cannot go into a text form field of `ff`, or null: Maximum length, a Number that is not one, a Date that is not one. */
export function checkFormText(ff, value) {
  const v = String(value ?? '').trim();
  if (ff.maxLength > 0 && String(value ?? '').length > ff.maxLength) return `Type at most ${ff.maxLength} characters.`;
  if (!v) return null;
  if (ff.type === 'number' && (!/\d/.test(v) || !/^[-+(]?\$?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?%?\)?$/.test(v))) return 'Type a number.';
  if (ff.type === 'date' && !validDate(v)) return 'Type a valid date.';
  return null;
}

/** Whether `v` reads as a date: M/d[/y] with any of / - . between the parts, yyyy-MM-dd, or a month name with a day. */
function validDate(v) {
  const iso = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const md = v.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : md ? [md[3] ? +md[3] : 2000, +md[1], +md[2]] : [];
  if (m != null) return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y < 100 ? 2000 + y : y, m, 0)).getUTCDate();
  return MONTHS.some((name) => v.toLowerCase().includes(name.slice(0, 3).toLowerCase())) && /\d/.test(v) && !Number.isNaN(Date.parse(v));
}

/** The QUOTE field code that applies `ff`'s Text format to `value` (fields-core's formatter does the work), or null when no format. */
export function quoteCode(ff, value) {
  const fmt = ff.format;
  if (!fmt) return null;
  const q = `QUOTE "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (ff.type === 'regular' || !ff.type) return CASE_SWITCH[fmt] ? `${q} \\* ${CASE_SWITCH[fmt]}` : null;
  if (ff.type === 'number' || ff.type === 'calculated') return `${q} \\# "${fmt}"`;
  return `${q} \\@ "${fmt}"`;
}

/** The case formats applied here while no QUOTE type is registered (the number and date pictures wait for fields-core). */
export function caseText(fmt, value) {
  const s = String(value);
  if (fmt === 'UPPERCASE') return s.toUpperCase();
  if (fmt === 'LOWERCASE') return s.toLowerCase();
  if (fmt === 'FIRST CAPITAL') return s.charAt(0).toUpperCase() + s.slice(1);
  if (fmt === 'TITLE CASE') return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return s;
}

/** Adds `text` to drop-down `items` → the new list, or a message when it is empty, already there or would be item 26. */
export function addDropItem(items, text) {
  const t = String(text ?? '').trim();
  if (!t) return 'Type the item first.';
  if (items.length >= DROP_MAX) return `A drop-down holds at most ${DROP_MAX} items.`;
  if (items.includes(t)) return 'That item is already in the list.';
  return [...items, t];
}

// The options dialogs edit a flat value object; ff goes in and comes back through these two, so no key is lost (§1.8 patching).

/** The options dialog value for form field `ff` of `kind`, with every key the dialog shows filled. */
export function ffForm(kind, ff) {
  return { ...ffDefaults(kind, ff?.name ?? ''), ...ff };
}

/** `form` (an options dialog's value) written back over `old` → the new ff, patched, never rebuilt. */
export function formFf(old, form) {
  const out = { ...old };
  for (const [k, v] of Object.entries(form)) out[k] = v;
  return out;
}

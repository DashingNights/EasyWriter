// The document information fields (docs/plans/word/briefs/fields-info.md): the property fields, the statistics fields, INFO,
// DOCPROPERTY, DOCVARIABLE, the user fields and the FILLIN and ASK prompts. Pure: FieldCtx in, text out. The prompts open their
// dialogs through bindPrompt, which index.js points at the app's openDialog, so node tests load this file as it is.
// fields.json is the source for names, errors and switch behaviour.
import { counts } from './count.mjs';

// ---------- what the fields read ----------

let ask = async () => null;
/** Points the FILLIN and ASK prompts at `fn(dialogId, props) → Promise<string|null>` (the app's openDialog). */
export const bindPrompt = (fn) => {
  ask = fn;
};

// The statistics once per doc: an update with many NUMWORDS fields counts once.
const stats = new WeakMap();
export const statsOf = (doc) => {
  let s = stats.get(doc);
  if (!s) stats.set(doc, (s = counts(doc)));
  return s;
};

const props = (ctx) => ctx.doc.attrs.props ?? {};
/** The document language (the run defaults' w:lang), which dates follow when no picture is given. */
const langOf = (ctx) => ctx.doc.attrs.styles?.defaults?.run?.lang?.val ?? 'en-US';
// Intl puts a narrow no-break space before AM and PM; Word writes a plain space.
const plain = (s) => s.replace(/[  ]/g, ' ');

/** `value` (ms or a date) as the language's short date, plus the time (h:mm, or h:mm:ss with `seconds`) unless `time` is false. '' for none. */
export function dateText(value, lang, { time = true, seconds = false } = {}) {
  if (value == null || value === '' || value === 0) return '';
  // A date-only string ('2026-10-27', a custom Date property) is a local calendar day, not UTC midnight.
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const day = d.toLocaleDateString(lang, { year: 'numeric', month: 'numeric', day: 'numeric' });
  if (!time || m) return day;
  return plain(`${day} ${d.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit', ...(seconds && { second: '2-digit' }) })}`);
}

/** A custom property's value as Word shows it: dates in the short date, numbers as written, Yes or no as Y or N. */
export function customText(c, lang) {
  if (c.type === 'date') return dateText(c.value, lang, { time: false });
  if (c.type === 'bool') return c.value ? 'Y' : 'N';
  return String(c.value ?? '');
}

/** A custom value typed in Advanced Properties, checked against its type → { value } or { error }. Yes or no reads true unless the
 * text is 'no': the dialog draws Yes as checked before a radio is clicked (value ''), so that must save as yes. */
export function parseValue(type, text) {
  if (type === 'bool') return { value: text !== 'no' && text !== false };
  const t = String(text ?? '').trim();
  if (type === 'number') return t && Number.isFinite(Number(t)) ? { value: Number(t) } : { error: 'The value entered does not match the specified type.' };
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { value: t } : { error: 'The value entered does not match the specified type.' };
  return { value: t };
}

/** Bytes of the draft's saved JSON: the fileSize provider (index.js) when registered, else the doc's own JSON. */
const bytesOf = (ctx) => ctx.get('fileSize') ?? new TextEncoder().encode(JSON.stringify(ctx.doc.toJSON())).length;
const pagesOf = (ctx) => ctx.geometry?.pages?.length || 1;
const minutes = (ctx) => String(Math.floor(ctx.draft.editMinutes ?? 0));
const author = (ctx) => props(ctx).core?.creator ?? ctx.user.name ?? '';
// Decision (recorded): TITLE and INFO Title show the draft's title while the Title property is empty; DOCPROPERTY Title does not.
const title = (ctx) => props(ctx).core?.title || ctx.draft.title || '';

/** DOCPROPERTY's 26 built-in names (index-fields.md), lower case → (ctx) → text. */
const BUILTIN = {
  author,
  bytes: (c) => String(bytesOf(c)),
  category: (c) => props(c).core?.category ?? '',
  characters: (c) => String(statsOf(c.doc).noSpaces),
  characterswithspaces: (c) => String(statsOf(c.doc).chars),
  comments: (c) => props(c).core?.description ?? '',
  company: (c) => props(c).app?.company ?? '',
  createtime: (c) => dateText(c.draft.created, langOf(c)),
  hyperlinkbase: (c) => props(c).app?.hyperlinkBase ?? '',
  keywords: (c) => props(c).core?.keywords ?? '',
  lastprinted: (c) => dateText(c.draft.printed, langOf(c)),
  lastsavedby: (c) => c.draft.savedBy ?? '',
  lastsavedtime: (c) => dateText(c.draft.saved, langOf(c)),
  lines: (c) => String(c.get('lines') ?? ''), // the main view's line boxes; blank without a connected view
  manager: (c) => props(c).app?.manager ?? '',
  nameofapplication: () => 'EasyWriter',
  odmadocid: () => '',
  pages: (c) => String(pagesOf(c)),
  paragraphs: (c) => String(statsOf(c.doc).paragraphs),
  revisionnumber: (c) => String(c.draft.revision ?? 0),
  security: () => '0',
  subject: (c) => props(c).core?.subject ?? '',
  template: (c) => props(c).app?.template || 'Normal.dotm',
  title: (c) => props(c).core?.title ?? '',
  totaleditingtime: minutes,
  words: (c) => String(statsOf(c.doc).words),
};
export const DOCPROPERTY_NAMES = ['Author', 'Bytes', 'Category', 'Characters', 'CharactersWithSpaces', 'Comments', 'Company', 'CreateTime',
  'HyperlinkBase', 'Keywords', 'LastPrinted', 'LastSavedBy', 'LastSavedTime', 'Lines', 'Manager', 'NameofApplication', 'ODMADocId', 'Pages',
  'Paragraphs', 'RevisionNumber', 'Security', 'Subject', 'Template', 'Title', 'TotalEditingTime', 'Words'];

/** Property `name` (a built-in name or a custom property, any case) as DOCPROPERTY shows it, or null when no such property exists. */
export function docProperty(ctx, name) {
  const key = String(name ?? '').toLowerCase();
  if (BUILTIN[key]) return BUILTIN[key](ctx);
  const c = (props(ctx).custom ?? []).find((x) => String(x.name).toLowerCase() === key);
  return c ? customText(c, langOf(ctx)) : null;
}

/** INFO's 17 keywords, lower case → [read, the property a new value writes or null]. Dates show with seconds, as CREATEDATE does. */
const INFO = {
  author: [author, 'core.creator'],
  comments: [BUILTIN.comments, 'core.description'],
  createdate: [(c) => dateText(c.draft.created, langOf(c), { seconds: true }), null],
  edittime: [minutes, null],
  filename: [(c) => c.draft.title ?? '', null],
  filesize: [BUILTIN.bytes, null],
  keywords: [BUILTIN.keywords, 'core.keywords'],
  lastsavedby: [BUILTIN.lastsavedby, null],
  numchars: [BUILTIN.characters, null],
  numpages: [BUILTIN.pages, null],
  numwords: [BUILTIN.words, null],
  printdate: [(c) => dateText(c.draft.printed, langOf(c), { seconds: true }), null],
  revnum: [BUILTIN.revisionnumber, null],
  savedate: [(c) => dateText(c.draft.saved, langOf(c), { seconds: true }), null],
  subject: [BUILTIN.subject, 'core.subject'],
  template: [BUILTIN.template, null],
  title: [title, 'core.title'],
};

// ---------- the prompts ----------

// FILLIN and ASK with \o ask once per merge: the answer of the merge's first record is reused for the rest.
// Integration note for mailings (it owns the merge record): this assumes a 'record' field provider returning { seq } (1 for the
// first record), and a per-record update that calls prompt. updateFields with reason 'merge' skips updates: 'manual' fields, so
// mailings must run a manual update per record for FILLIN and ASK to prompt at all. Untested until mailings publishes that contract.
// ponytail: keyed by field code, so two identical \o fields share one answer; key by position if that ever matters.
const onceAnswers = new Map();
const oldResult = (ctx) => ctx.doc.nodeAt(ctx.pos)?.attrs?.result ?? null;
const textArg = (v) => (typeof v === 'string' ? v : null);

async function promptOnce(f, ctx, dialog, props) {
  const record = ctx.get('record');
  if (f.sw.o && record && record.seq > 1 && onceAnswers.has(f.code)) return onceAnswers.get(f.code);
  const answer = await ask(dialog, props);
  if (f.sw.o && record && answer != null) onceAnswers.set(f.code, answer);
  return answer;
}

/** Records ASK's answer for bookmark `name`: REF and the bare bookmark field read ctx.assigned later in the same update. Stored under
 * the name as written and in lower case, since Word's bookmark names are case-insensitive. */
function assign(ctx, name, value) {
  ctx.assigned.set(name, value);
  ctx.assigned.set(name.toLowerCase(), value);
}

// ---------- the field types ----------

const DOC_INFO = 'Document Information';
const USER_INFO = 'User Information';

/** A property field: shows `read(ctx)`; with an argument shows it and writes it to `path` (AUTHOR "Ana"). */
const propField = (path, read) => ({
  category: DOC_INFO, updates: 'manual',
  compute(f, ctx) {
    const v = f.args[0];
    if (v == null) return read(ctx);
    ctx.setProp(path, v);
    return v;
  },
});
/** A user field: settings.word.user's `key`; an argument shows its text and leaves the option alone (fields.json, USERADDRESS). */
const userField = (key) => ({ category: USER_INFO, updates: 'manual', compute: (f, ctx) => f.args[0] ?? ctx.user[key] ?? '' });
const statField = (read, category = DOC_INFO) => ({ category, updates: 'manual', compute: (f, ctx) => read(ctx) });

export const FIELDS = {
  AUTHOR: propField('core.creator', author),
  TITLE: propField('core.title', title),
  SUBJECT: propField('core.subject', BUILTIN.subject),
  KEYWORDS: propField('core.keywords', BUILTIN.keywords),
  COMMENTS: propField('core.description', BUILTIN.comments),
  LASTSAVEDBY: statField(BUILTIN.lastsavedby),
  REVNUM: statField(BUILTIN.revisionnumber, 'Numbering'),
  // A draft has no template file or path: \p adds nothing (recorded).
  TEMPLATE: { ...statField(BUILTIN.template), bare: 'p' },
  // A draft has no file path: \p gives "<project name>\<title>" (recorded).
  FILENAME: {
    category: DOC_INFO, updates: 'manual', bare: 'p',
    compute(f, ctx) {
      const name = ctx.draft.title ?? '';
      const project = f.sw.p ? ctx.get('project') : null;
      return project ? `${project}\\${name}` : name;
    },
  },
  FILESIZE: {
    category: DOC_INFO, updates: 'manual', bare: 'km',
    compute(f, ctx) {
      const n = bytesOf(ctx);
      return String(f.sw.m ? Math.round(n / 1048576) : f.sw.k ? Math.round(n / 1024) : n);
    },
  },
  NUMWORDS: statField(BUILTIN.words),
  NUMCHARS: statField(BUILTIN.characters),
  INFO: {
    category: DOC_INFO, updates: 'manual',
    compute(f, ctx) {
      const entry = INFO[String(f.args[0] ?? '').toLowerCase()];
      if (!entry) return { error: 'Error! Unknown info keyword.' };
      const [read, path] = entry;
      const v = f.args[1];
      if (v == null || !path) return read(ctx);
      ctx.setProp(path, v);
      return v;
    },
  },
  DOCPROPERTY: {
    category: DOC_INFO, updates: 'manual',
    compute: (f, ctx) => docProperty(ctx, f.args[0]) ?? { error: 'Error! Unknown document property name.' },
  },
  DOCVARIABLE: {
    category: 'Document Automation', updates: 'manual',
    compute(f, ctx) {
      const v = f.args[0] == null ? null : ctx.get('variable', f.args[0]);
      return v == null ? { error: 'Error! No document variable supplied.' } : String(v);
    },
  },
  USERNAME: userField('name'),
  USERINITIALS: userField('initials'),
  USERADDRESS: userField('address'),
  FILLIN: {
    category: 'Mail Merge', updates: 'manual', bare: 'o',
    prompt: (f, ctx) => promptOnce(f, ctx, 'fillIn', { prompt: f.args[0] ?? '', value: textArg(f.sw.d) ?? oldResult(ctx) ?? '' }),
    // Cancel keeps the old result (the engine skips the field); without a prompt (insertion) it shows the default.
    compute: (f, ctx) => ctx.answer ?? textArg(f.sw.d) ?? oldResult(ctx) ?? '',
  },
  ASK: {
    category: 'Mail Merge', updates: 'manual', bare: 'o',
    prompt: (f, ctx) => promptOnce(f, ctx, 'ask', {
      prompt: f.args[1] ?? '', bookmark: f.args[0] ?? '',
      value: textArg(f.sw.d) ?? ctx.assigned.get(String(f.args[0] ?? '').toLowerCase()) ?? '',
    }),
    // No result of its own: the answer goes to the bookmark.
    compute(f, ctx) {
      const v = ctx.answer ?? textArg(f.sw.d);
      if (f.args[0] && v != null) assign(ctx, String(f.args[0]), v);
      return '';
    },
  },
};

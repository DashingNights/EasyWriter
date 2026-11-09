// The reference fields (docs/plans/word/index-fields.md REF, PAGEREF, NOTEREF, STYLEREF, SEQ, Formula, IF and COMPARE; fields.json):
// how each computes its result from a FieldCtx (plan.md §1.10), and the providers `cells` and `styleText`. Pure: no editor, no
// DOM, so Node tests compute every probe row; index.js adds the click hooks that need an editor.
import { numberText } from '../../fields/numfmt.mjs';
import { parseField } from '../../fields/registry.mjs';
import { styleIdOf } from '../../model/styles.mjs';
import { bookmarkNamed, textOf } from './bookmarks.mjs';
import { cellsAt } from './cells.mjs';
import { evaluate } from './formula.mjs';

const NOT_FOUND = 'Error! Reference source not found.';
const NOT_DEFINED = 'Error! Bookmark not defined.';
const SELF = 'Error! Not a valid bookmark self-reference.';
const NO_STYLE = 'Error! No text of specified style in document.';
const OP_CODE = 'Error! Unknown op code for conditional.';
const err = (error) => ({ error });

// Word's \* names for numbers → numfmt's ST_NumberFormat names.
const FORMATS = { arabic: 'decimal', alphabetic: 'lowerLetter', roman: 'lowerRoman' };
/** `n` in the first \* number format of `f` (ALPHABETIC upper case, alphabetic lower, ROMAN, roman, Arabic). */
function formatted(n, f) {
  for (const name of f.format) {
    const fmt = FORMATS[name.toLowerCase()];
    if (!fmt) continue;
    const upper = name === name.toUpperCase() && fmt !== 'decimal';
    return numberText(n, upper ? fmt.replace('lower', 'upper') : fmt);
  }
  return String(n);
}

/** The fields of `doc` in document order: [{pos, f}] for every field node whose code parses to one of `names`. */
function fieldsOf(doc, names) {
  const out = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== 'field') return true;
    const f = parseField(n.attrs.code);
    if (names.includes(f.name)) out.push({ pos, f, node: n });
    return false;
  });
  return out;
}

// ---------- SET and REF ----------
// The SET fields of a doc, found once per doc (docs never change), so every REF does not rescan the document.
const setFields = new WeakMap();
function setsOf(doc) {
  let list = setFields.get(doc);
  if (!list) setFields.set(doc, (list = fieldsOf(doc, ['SET'])));
  return list;
}

/** The text SET last assigned to bookmark `name` before `pos`: from the update's ctx.assigned, else from the SET fields before it
 * (a REF inserted on its own after a SET still reads it). */
function assignedText(ctx, name) {
  const key = String(name).toLowerCase();
  if (ctx.assigned?.has(key)) return ctx.assigned.get(key);
  let hit = null;
  for (const { pos, f } of setsOf(ctx.doc)) if (pos < ctx.pos && String(f.args[0]).toLowerCase() === key) hit = f.args[1] ?? '';
  return hit;
}

/** Bookmark `name`'s value as a formula reads it: the assigned or bookmarked text as a number, or null when not defined. */
function bookmarkNumber(ctx, name) {
  const set = assignedText(ctx, name);
  const text = set ?? (ctx.bookmark(name) ? textOf(ctx.doc, ctx.bookmark(name).from, ctx.bookmark(name).to) : null);
  if (text == null) return null;
  const n = Number(String(text).replace(/[$€£¥,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const position = (ctx, b) => (b.to <= ctx.pos ? 'above' : 'below');

// The number of the numbered paragraph holding `pos` in the form REF's switches ask for, or null when it is not numbered.
function numberOf(ctx, pos, f) {
  const l = ctx.listLabel(pos);
  if (!l) return null;
  const strip = (s) => (f.sw.t ? s.replace(/\p{L}{2,}\s+/gu, '').replace(/^\s+/, '') : s);
  const levels = l.levels.filter((x) => x != null).map(strip);
  if (f.sw.w) return levels.join(f.sw.d === true || f.sw.d == null ? '' : f.sw.d);
  if (f.sw.r) {
    // Relative context: the levels that differ from the field's own place in the list, at least the last one.
    const here = ctx.listLabel(ctx.pos)?.levels ?? [];
    let i = 0;
    while (i < levels.length - 1 && here[i] != null && strip(here[i]) === levels[i]) i++;
    return levels.slice(here.length ? i : levels.length - 1).join('');
  }
  return levels.at(-1) ?? '';
}

// Note numbers of the noteRef nodes in `from`..`to`: the notes package's noteLabel provider, else a count in document order.
function noteLabels(ctx, from, to) {
  const out = [];
  const counts = { footnote: 0, endnote: 0 };
  ctx.doc.descendants((n, pos) => {
    if (n.type.name !== 'noteRef') return true;
    const kind = n.attrs.kind === 'endnote' ? 'endnote' : 'footnote';
    counts[kind]++;
    if (pos >= from && pos < to) {
      const own = ctx.get('noteLabel', pos);
      out.push(own?.label ?? n.attrs.mark ?? numberText(counts[kind], kind === 'endnote' ? 'lowerRoman' : 'decimal'));
    }
    return false;
  });
  return out;
}

const explicit = (f, name) => new RegExp(`^\\s*${name}\\b`, 'i').test(f.code);

const REF = {
  category: 'Links and References',
  updates: 'manual',
  bare: 'nrwtphf',
  compute(f, ctx) {
    const name = f.args[0];
    if (!name) return err(NOT_FOUND);
    const set = assignedText(ctx, name);
    if (set != null && !f.sw.n && !f.sw.r && !f.sw.w && !f.sw.p) return { text: set };
    const b = ctx.bookmark(name);
    if (!b) return err(explicit(f, 'REF') ? NOT_FOUND : NOT_DEFINED);
    if (ctx.pos >= b.from && ctx.pos < b.to) return err(SELF);
    if (f.sw.f) return { text: noteLabels(ctx, b.from, b.to).join(' ') };
    if (f.sw.n || f.sw.r || f.sw.w) {
      const n = numberOf(ctx, b.from, f) ?? '0';
      return { text: f.sw.p ? `${n} ${position(ctx, b)}` : n };
    }
    if (f.sw.p) return { text: position(ctx, b) };
    return { text: textOf(ctx.doc, b.from, b.to) };
  },
};

const PAGEREF = {
  category: 'Links and References',
  updates: 'manual',
  bare: 'hp',
  compute(f, ctx) {
    const b = ctx.bookmark(f.args[0] ?? '');
    if (!b) return err(NOT_DEFINED);
    const page = ctx.pageAt(b.from);
    const number = page?.number ?? 1;
    if (f.sw.p) {
      const here = ctx.pageAt(ctx.pos);
      if (!page || !here || page.index === here.index) return { text: position(ctx, b) };
      return { text: `on page ${page.label ?? number}` };
    }
    // \* formats the plain number (fields-core's general switch); without it the section's page number format shows.
    return f.format.length ? { text: String(number) } : { text: page?.label ?? String(number) };
  },
};

const NOTEREF = {
  category: 'Links and References',
  updates: 'manual',
  bare: 'fhp',
  compute(f, ctx) {
    const b = ctx.bookmark(f.args[0] ?? '');
    if (!b) return err(NOT_DEFINED);
    const labels = noteLabels(ctx, b.from, b.to);
    if (!labels.length) return err(NOT_FOUND);
    return { text: f.sw.p ? `${labels[0]} ${position(ctx, b)}` : labels[0] };
  },
};

// ---------- STYLEREF ----------
// The paragraphs of `doc` with the style `ident` names: a style id, a style name, or 1 to 9 for Heading 1 to 9.
function styleMatcher(doc, ident) {
  const s = String(ident ?? '').trim();
  if (/^[1-9]$/.test(s)) return (node) => styleIdOf(node) === `Heading${s}`;
  const key = s.toLowerCase().replace(/\s+/g, '');
  const list = doc.attrs.styles?.list ?? {};
  const ids = new Set(Object.entries(list).filter(([id, d]) => id.toLowerCase() === key || String(d.name ?? '').toLowerCase().replace(/\s+/g, '') === key)
    .map(([id]) => id));
  if (/^heading[1-9]$/.test(key)) ids.add(`Heading${key.slice(7)}`);
  return (node) => ids.has(styleIdOf(node));
}

/** The paragraph STYLEREF shows → {pos, node} or null. Body: the nearest before the field, else the first after it. Header and
 * footer (ctx.page given): on the page drawn from its top (`fromBottom`: from its bottom), then earlier pages, then later ones. */
export function styleText(ctx, ident, fromBottom = false) {
  const doc = ctx.mainDoc ?? ctx.doc;
  const match = styleMatcher(doc, ident);
  const paras = [];
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    if (match(n)) paras.push({ pos, node: n });
    return false;
  });
  if (!paras.length) return null;
  const story = ctx.story === 'header' || ctx.story === 'footer';
  if (story && ctx.page) {
    const on = paras.filter((p) => p.pos >= ctx.page.from && p.pos < ctx.page.to);
    if (on.length) return fromBottom ? on.at(-1) : on[0];
    return paras.filter((p) => p.pos < ctx.page.from).at(-1) ?? paras.find((p) => p.pos >= ctx.page.to) ?? null;
  }
  return paras.filter((p) => p.pos < ctx.pos).at(-1) ?? paras.find((p) => p.pos > ctx.pos) ?? null;
}

const STYLEREF = {
  category: 'Links and References',
  updates: 'layout',
  bare: 'lnprtws',
  compute(f, ctx) {
    const hit = ctx.get('styleText', f.args[0] ?? '', !!f.sw.l);
    if (!hit) return err(NO_STYLE);
    const b = { from: hit.pos, to: hit.pos + hit.node.nodeSize };
    if (f.sw.s) return { text: ctx.listLabel(hit.pos + 1)?.levels.filter((x) => x != null).join('') ?? '0' };
    if (f.sw.n || f.sw.r || f.sw.w) {
      const n = numberOf(ctx, hit.pos + 1, f) ?? '0';
      return { text: f.sw.p ? `${n} ${position(ctx, b)}` : n };
    }
    if (f.sw.p) return { text: position(ctx, b) };
    return { text: textOf(ctx.mainDoc ?? ctx.doc, b.from + 1, b.to - 1) };
  },
};

// ---------- SEQ ----------
// Every SEQ of `doc` with its number, in document order (memoised per doc): Word counts from the document's start, so one pass
// serves each field whether it updates alone or with the others.
const seqCache = new WeakMap();
function seqNumbers(doc) {
  let out = seqCache.get(doc);
  if (out) return out;
  out = new Map();
  const counts = new Map(); // identifier → {n, heading}
  const lastHeading = new Map(); // level → pos of the last heading of that level
  doc.descendants((n, pos) => {
    if (n.type.name === 'heading') lastHeading.set(n.attrs.level, pos);
    if (n.type.name !== 'field') return true;
    const f = parseField(n.attrs.code);
    if (f.name !== 'SEQ' || !f.args[0] || f.args[1]) return false;
    const id = f.args[0].toLowerCase();
    const c = counts.get(id) ?? { n: 0, heading: null };
    if (f.sw.s != null && f.sw.s !== true) {
      const h = lastHeading.get(Number(f.sw.s)) ?? null;
      if (h !== c.heading) Object.assign(c, { n: 0, heading: h });
    }
    if (f.sw.r != null && f.sw.r !== true && Number.isFinite(Number(f.sw.r))) c.n = Number(f.sw.r);
    else if (!f.sw.c) c.n++;
    counts.set(id, c);
    out.set(pos, c.n);
    return false;
  });
  seqCache.set(doc, out);
  return out;
}

const SEQ = {
  category: 'Numbering',
  updates: 'manual',
  bare: 'chn',
  compute(f, ctx) {
    const id = f.args[0];
    if (!id) return err('Error! No sequence specified.');
    if (f.args[1]) {
      // The number of the last SEQ id inside the bookmark (a caption's cross-reference).
      const b = ctx.bookmark(f.args[1]);
      if (!b) return err(NOT_DEFINED);
      const nums = seqNumbers(ctx.doc);
      const inside = fieldsOf(ctx.doc, ['SEQ']).filter(({ pos, f: g }) => pos >= b.from && pos < b.to && g.args[0]?.toLowerCase() === id.toLowerCase() && nums.has(pos));
      return inside.length ? { text: formatted(nums.get(inside.at(-1).pos), f), raw: !!f.format.length } : err(NOT_FOUND);
    }
    const n = seqNumbers(ctx.doc).get(ctx.pos) ?? 1;
    // Keep ctx.seq in step for the packages that read it during one update (captions, TOC \c).
    ctx.seq?.set(id.toLowerCase(), n);
    if (f.sw.h) return { text: '', raw: true };
    return f.format.length ? { text: formatted(n, f), raw: true } : { text: String(n) };
  },
};

const SET = {
  category: 'Mail Merge',
  updates: 'manual',
  compute(f, ctx) {
    if (f.args[0]) ctx.assigned?.set(f.args[0].toLowerCase(), f.args[1] ?? '');
    return { text: '', raw: true };
  },
};

// ---------- = ----------
const FORMULA = {
  category: 'Equations and Formulas',
  updates: 'manual',
  compute(f, ctx) {
    const r = evaluate(f.args[0] ?? '', {
      bookmark: (name) => bookmarkNumber(ctx, name),
      cells: (table) => ctx.get('cells', table),
    });
    return r.error ? err(r.error) : { text: r.text };
  },
};

// ---------- IF and COMPARE ----------
const OPS = ['<=', '>=', '<>', '=', '<', '>'];
const numeric = (s) => /^\s*[-+]?[$€£¥]?[0-9,]*\.?[0-9]+\s*%?\s*$/.test(s);
const toNumber = (s) => Number(String(s).replace(/[$€£¥,\s%]/g, ''));
// A glob of Word's: ? one character, * any run.
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, '.*')}$`, 's');

/** Word's test `a op b`: numbers compare as numbers; text compares case-sensitively, and with = and <> a quoted `b` takes ? and *. */
export function compareValues(a, op, b, quoted = false) {
  if (numeric(a) && numeric(b)) {
    const x = toNumber(a);
    const y = toNumber(b);
    return { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op];
  }
  if ((op === '=' || op === '<>') && quoted && /[?*]/.test(b)) return glob(b).test(a) === (op === '=');
  const c = a < b ? -1 : a > b ? 1 : 0;
  return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
}

// Whether `text` was written in quotes in field code `code` (parseField drops quotes; wildcards need them).
const quotedIn = (code, text) => code.includes(`"${text}"`);

// An expression as IF and COMPARE read it: a bare word naming a SET value or a bookmark reads as that text (IF num > 3), anything
// else, quoted text included, stays as written.
function operand(f, ctx, s) {
  if (!ctx?.doc || s == null || quotedIn(f.code, s) || !/^\p{L}[\p{L}\p{N}_]*$/u.test(s)) return s;
  const set = assignedText(ctx, s);
  if (set != null) return set;
  const b = ctx.bookmark?.(s);
  return b ? textOf(ctx.doc, b.from, b.to) : s;
}

const IF = {
  category: 'Document Automation',
  updates: 'manual',
  compute(f, ctx) {
    const [a, op, b, yes, no] = f.args;
    if (!OPS.includes(op)) return err(OP_CODE);
    if (b === undefined) return err(OP_CODE);
    return { text: compareValues(operand(f, ctx, a), op, operand(f, ctx, b), quotedIn(f.code, b)) ? yes ?? '' : no ?? '' };
  },
};

const COMPARE = {
  category: 'Document Automation',
  updates: 'manual',
  compute(f, ctx) {
    let [a, op, b] = f.args;
    if (!OPS.includes(op)) {
      // COMPARE takes the operator without spaces too: COMPARE 5>3.
      const s = f.args.join(' ');
      const m = /^(.*?)(<=|>=|<>|=|<|>)(.*)$/s.exec(s);
      if (!m) return err('Error! Unknown op code for conditional.');
      [a, op, b] = [m[1].trim(), m[2], m[3].trim()];
    }
    return { text: compareValues(operand(f, ctx, a), op, operand(f, ctx, b), quotedIn(f.code, b)) ? '1' : '0' };
  },
};

// ---------- buttons and HYPERLINK ----------
const display = (f) => ({ text: f.args.slice(1).join(' ') });
const GOTOBUTTON = { category: 'Document Automation', updates: 'never', compute: display };
// MACROBUTTON runs VBA macros, which EasyWriter leaves out: it draws its display text, and a click selects it (NoMacro placeholders).
const MACROBUTTON = { category: 'Document Automation', updates: 'never', compute: display };
// HYPERLINK keeps the display text it holds (its result); a manual update leaves it as it is.
const HYPERLINK = { category: 'Links and References', updates: 'never', bare: 'mn', compute: () => null };

/** The field types this package registers, by name. */
export const FIELD_TYPES = { REF, PAGEREF, NOTEREF, FTNREF: NOTEREF, STYLEREF, SEQ, SET, '=': FORMULA, IF, COMPARE, GOTOBUTTON, MACROBUTTON, HYPERLINK };

/** The providers this package registers: `cells` (the = field's table, or another table through a bookmark) and `styleText`. */
export const PROVIDERS = {
  cells: (ctx, table = null) => cellsAt(ctx.doc, ctx.pos, table),
  styleText: (ctx, ident, fromBottom = false) => styleText(ctx, ident, fromBottom),
};

/** `s` with its %XX escapes decoded, or `s` itself when they do not decode (a stray % written by hand or by another app). */
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// An e-mail link's parts: mailto:address?subject=..., each part percent-encoded so a %, & or # typed in it survives the round trip.
// The address keeps its @ readable. `mailParts` decodes leniently: a link written by hand or by another app may hold a stray %.
export const mailHref = (address, subject) => `mailto:${encodeURIComponent(address).replace(/%40/g, '@')}${subject ? `?subject=${encodeURIComponent(subject)}` : ''}`;
export function mailParts(href) {
  const rest = href.replace(/^mailto:/i, '');
  const q = rest.indexOf('?');
  const subject = q < 0 ? null : /(?:^|&)subject=([^&#]*)/i.exec(rest.slice(q + 1))?.[1];
  return { address: safeDecode(q < 0 ? rest : rest.slice(0, q)), subject: subject == null ? '' : safeDecode(subject) };
}

/** The destination of a HYPERLINK field: {href, anchor, tooltip, target}. */
export function hyperlinkOf(f) {
  const anchor = f.sw.l && f.sw.l !== true ? f.sw.l : null;
  return { href: f.args[0] ?? (anchor ? `#${anchor}` : ''), anchor, tooltip: f.sw.o && f.sw.o !== true ? f.sw.o : null,
    target: f.sw.n ? '_blank' : f.sw.t && f.sw.t !== true ? f.sw.t : null };
}

/** Whether `name` names a bookmark of `doc` (GOTOBUTTON's destination is a bookmark or a Go To code). */
export const isBookmark = (doc, name) => !!bookmarkNamed(doc, name);

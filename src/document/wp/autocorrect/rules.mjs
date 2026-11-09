// AutoCorrect and AutoFormat As You Type rules (docs/plans/word plan.md §3 autocorrect; index-editing.md "AutoCorrect dialog" and
// "AutoFormat As You Type tab"). Pure: text before the caret in, edits out, so node tests run them. An edit is
// {kind, from, to, insert?, mark?, label, rule?}: offsets into the text, `insert` replaces the range, `mark` ({type, attrs}) formats
// the range (or the inserted text), `label` is what was typed there. kind is plan.md §1.3's wordAuto kind ('boldItalic' is ours).
import { DEFAULT_ENTRIES, DEFAULT_FIRST_LETTER } from './entries.mjs';

const LETTER = /\p{L}/u;
const WORDCH = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
// Characters that finish a word: Word fires a replacement on a space, Tab, Enter or punctuation. Apostrophes and hyphens continue a
// word ("don't", "vis-a-vis"), so they finish none.
const FINISH = /[\s.,;:!?)\]}"“”…]/;
const OPENERS = '([{“‘"\'';
// A list lead at a paragraph start ("a)", "1.", "i)"): the lists' input rules make a list of it on the space, so no rule touches it.
const LIST_LEAD = /^(\p{L}|\d{1,3})[.)]$/u;
const DAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const FRACTIONS = { '1/2': '½', '1/4': '¼', '3/4': '¾' };
const straight = (s) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** The rule options from Word settings `word` (settings.word with defaults) → {ac, af, entries: Map, firstLetter, initialCaps, other}. */
export function optionsOf(word) {
  const ac = word.autocorrect;
  const ex = ac.exceptions ?? {};
  const entries = new Map();
  for (const e of ac.entries ?? DEFAULT_ENTRIES) entries.set(straight(e.name), e);
  return {
    ac, af: word.autoformat, entries,
    firstLetter: new Set((ex.firstLetter ?? DEFAULT_FIRST_LETTER).map((w) => w.toLowerCase())),
    initialCaps: new Set(ex.initialCaps ?? []),
    other: new Set(ex.other ?? []),
  };
}

/** The entry named by the end of `token` → {entry, at (offset of the name in token), text (case adapted)} or null. A name that
 * starts with a letter must start the token or follow a non-letter; a symbol name ("...") may end any token ("hello..."). */
export function entryAt(token, entries) {
  const plain = straight(token);
  for (let at = 0; at < plain.length; at++) {
    const name = plain.slice(at);
    if (at && WORDCH.test(name[0]) && WORDCH.test(plain[at - 1])) continue;
    let e = entries.get(name);
    let text = e?.text;
    if (!e) {
      // An entry of lower-case letters also fires for its capitalised and upper-case forms ("Teh" → "The", "TEH" → "THE").
      e = entries.get(name.toLowerCase());
      if (!e || e.name !== e.name.toLowerCase() || !LETTER.test(name)) continue;
      if (name === name.toUpperCase() && name.length > 1) text = e.text.toUpperCase();
      else if (name[0] !== name[0].toLowerCase()) text = cap(e.text);
      else continue;
    }
    return { entry: e, at, text };
  }
  return null;
}

/** The ordinal suffix of `n` (1st, 22nd, 103rd, 11th). */
const suffixOf = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');

/** Whether `prefix` (paragraph text before a word, opening marks stripped) ends a sentence → {kind: 'para'} for a paragraph start,
 * {kind: 'sentence', prev} after . ! or ? and a space (prev: the word with its period, which undoing adds to the exceptions), or
 * null, also after an exception ("e.g."). */
function sentenceStart(prefix, firstLetter) {
  const p = prefix.replace(/[([{“‘"']+$/, '');
  if (!p.trim()) return { kind: 'para' };
  const m = /(\S*?)([.!?])[)\]"'”’]*\s+$/.exec(p);
  if (!m) return null;
  const prev = (m[1] + m[2]).replace(/^[([{“‘"']+/, '').toLowerCase();
  if (m[2] === '.' && firstLetter.has(prev)) return null;
  return { kind: 'sentence', prev: m[2] === '.' ? prev : null };
}

/** The capitalisation change for `word` at offset `at` of `text` (text before it is the paragraph's) → {insert, rule} or null. */
function capitalOf(text, at, word, o, ctx) {
  const { ac } = o;
  if (!/^\p{L}+$/u.test(word)) return null;
  if (ac.twoCaps && word.length > 2 && /^\p{Lu}\p{Lu}\p{Ll}+$/u.test(word) && !o.initialCaps.has(word)) {
    return { insert: word[0] + word[1].toLowerCase() + word.slice(2), rule: 'twoCaps' };
  }
  if (ac.capsLock && ctx.capsLock && /^\p{Ll}\p{Lu}+$/u.test(word)) {
    return { insert: word[0].toUpperCase() + word.slice(1).toLowerCase(), rule: 'capsLock' };
  }
  if (!/^\p{Ll}+$/u.test(word)) return null;
  const start = sentenceStart(text.slice(0, at), o.firstLetter);
  const cell = start?.kind === 'para' && ctx.inCell;
  if (start && (cell ? ac.cells : ac.sentences)) return { insert: cap(word), rule: cell ? 'cells' : 'sentences', prev: start.prev };
  if (ac.days && DAYS.has(word)) return { insert: cap(word), rule: 'days' };
  return null;
}

const LINK_RES = [
  [/^(https?|ftp):\/\/\S+$/i, (s) => s],
  [/^mailto:\S+@\S+$/i, (s) => s],
  [/^www\.[\w-]+(\.[\w-]+)+\S*$/i, (s) => `http://${s}`],
  [/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/, (s) => `mailto:${s}`],
  [/^\\\\[^\\\s]+\\[^\s]+$/, (s) => s],
];

/** The hyperlink address for `token` (a URL, www., mailto:, an e-mail address or a \\server\share path) → href or null. */
export function linkOf(token) {
  for (const [re, href] of LINK_RES) if (re.test(token)) return href(token);
  return null;
}

/** The edits for `text`, a paragraph's text up to and including the character just typed (its last; '\n' for Enter), under rule
 * options `o` (optionsOf) and `ctx` {inCell, capsLock, spell: {misspelled(word), suggest(word)} | null, linked(from, to)} → edits,
 * rightmost last. Corrections fire only when a word is finished; quotes and *bold* fire on the typed mark itself. */
export function correct(text, o, ctx = {}) {
  const { ac, af } = o;
  const n = text.length - 1;
  const ch = text[n];
  const edits = [];
  if (FINISH.test(ch) || ch === '\t') {
    const tokenStart = (() => { let i = n; while (i > 0 && !SPACE.test(text[i - 1])) i--; return i; })();
    const token = text.slice(tokenStart, n);
    const listLead = !text.slice(0, tokenStart).trim() && (LIST_LEAD.test(token + ch) || (SPACE.test(ch) && LIST_LEAD.test(token)));
    if (token && !listLead) edits.push(...wordEdits(text, tokenStart, token, o, ctx));
  }
  if (af.quotes && (ch === '"' || ch === "'")) {
    const prev = text[n - 1];
    const open = prev === undefined || SPACE.test(prev) || OPENERS.includes(prev) || prev === '\ufffc' || prev === '—' || prev === '–';
    edits.push({ kind: 'quote', from: n, to: n + 1, insert: ch === '"' ? (open ? '“' : '”') : (open ? '‘' : '’'), label: ch });
  }
  if (af.boldItalic && (ch === '*' || ch === '_')) {
    const m = new RegExp(`(^|[\\s(\\[{"“'‘])[${ch}]([^\\s${ch}](?:[^${ch}]*[^\\s${ch}])?)[${ch}]$`, 'u').exec(text);
    if (m) {
      const from = m.index + m[1].length;
      edits.push({ kind: 'boldItalic', from, to: n + 1, insert: m[2], mark: { type: ch === '*' ? 'bold' : 'italic' }, label: m[0].slice(m[1].length) });
    }
  }
  return edits;
}

/** The edits for `token` (offset `start`), the word the typed character finished. */
function wordEdits(text, start, token, o, ctx) {
  const { ac, af } = o;
  const n = text.length - 1;
  const ch = text[n];
  const edits = [];
  // Opening marks before the word ("(monday", “teh) stay out of it.
  const lead = /^[([{“‘"']*/.exec(token)[0].length;
  const word = token.slice(lead);
  const wordAt = start + lead;
  const finished = (s) => s.replace(/[.,;:!?]+$/, '');

  // Links: on a space or Enter only (Word's trigger), the trailing punctuation left out.
  if (af.links && /\s/.test(ch)) {
    const t = word.replace(/[.,;:!?)\]}"”’]+$/, '');
    const href = t && linkOf(t);
    if (href && !ctx.linked?.(wordAt, wordAt + t.length)) {
      return [{ kind: 'link', from: wordAt, to: wordAt + t.length, mark: { type: 'link', attrs: { href } }, label: t }];
    }
  }
  // Replacements, then capitals on the result, as one change.
  let replaced = null;
  if (ac.replace && !o.other.has(token)) {
    const hit = entryAt(token, o.entries);
    // Undoing a replacement adds its name to the Other Corrections exceptions (plugin.js exceptionOf).
    if (hit && !o.other.has(token.slice(hit.at))) replaced ={ from: start + hit.at, to: start + token.length, text: hit.text, entry: hit.entry, label: token.slice(hit.at) };
  }
  if (!replaced && ac.spelling && ctx.spell && /^\p{Ll}{3,}$/u.test(word) && !o.other.has(word)) {
    try {
      if (ctx.spell.misspelled(word)) {
        const s = ctx.spell.suggest(word);
        if (Array.isArray(s) && s.length === 1 && s[0] && s[0] !== word) replaced = { from: wordAt, to: wordAt + word.length, text: s[0], label: word, spelling: true };
      }
    } catch { /* no spell checker in this window */ }
  }
  // The word the capital rules see: the replacement's text, else the finished word.
  const capFrom = replaced ? replaced.from : wordAt;
  const capWord = replaced ? replaced.text : finished(word);
  const capital = capitalOf(text, capFrom, capWord, o, ctx);
  if (replaced) {
    const insert = capital && !replaced.entry?.marks ? capital.insert : replaced.text;
    edits.push({ kind: replaced.spelling ? 'spelling' : 'replace', from: replaced.from, to: replaced.to, insert, label: replaced.label,
      ...(replaced.entry?.marks ? { marks: replaced.entry.marks } : {}) });
    return edits;
  }
  if (capital) {
    edits.push({ kind: 'capital', rule: capital.rule, prev: capital.prev, from: wordAt, to: wordAt + capWord.length, insert: capital.insert, label: capWord });
    return edits;
  }
  const w = finished(word);
  if (af.ordinals) {
    const m = /^(\d+)(st|nd|rd|th)$/.exec(w);
    if (m && suffixOf(+m[1]) === m[2]) {
      return [{ kind: 'ordinal', from: wordAt + m[1].length, to: wordAt + w.length, mark: { type: 'superscript' }, label: w }];
    }
  }
  if (af.fractions && FRACTIONS[w] && !/[\d/]/.test(ch)) return [{ kind: 'fraction', from: wordAt, to: wordAt + 3, insert: FRACTIONS[w], label: w }];
  if (af.dashes) {
    // word--word: an em dash with no spaces.
    const em = /^(.*[\p{L}\p{N}])--([\p{L}\p{N}]+)$/u.exec(w);
    if (em) return [{ kind: 'dash', from: wordAt + em[1].length, to: wordAt + em[1].length + 2, insert: '—', label: '--' }];
    // word - word and word -- word: an en dash, the spaces kept.
    const en = /[\p{L}\p{N}] (--?) [\p{L}\p{N}]+$/u.exec(text.slice(0, wordAt + w.length));
    if (en && w && wordAt === en.index + en[1].length + 3) {
      const at = en.index + 2;
      return [{ kind: 'dash', from: at, to: at + en[1].length, insert: '–', label: en[1] }];
    }
  }
  return edits;
}

const BORDERS = {
  '-': { style: 'single', width: 0.75 }, _: { style: 'single', width: 1.5 }, '=': { style: 'double', width: 0.75 },
  '*': { style: 'dotted', width: 1.5 }, '~': { style: 'wave', width: 0.75 }, '#': { style: 'thinThickThinSmallGap', width: 2.25 },
};

/** The Enter rule for a paragraph whose whole text is `text` → {kind: 'border', border} | {kind: 'table', widths} | null. Three or
 * more of - _ = * ~ # give a bottom border; +---+--+ gives a one-row table, the hyphens of each segment its width share. */
export function enterRule(text, af) {
  const t = text.trim();
  if (af.borders && /^([-_=*~#])\1{2,}$/.test(t)) return { kind: 'border', border: { ...BORDERS[t[0]], space: 1, color: 'auto' }, label: t };
  if (af.tables && /^\+(-+\+)+$/.test(t)) return { kind: 'table', widths: t.slice(1, -1).split('+').map((s) => s.length), label: t };
  return null;
}

/** Column widths in px for hyphen counts `widths` sharing `total` px. */
export const columnWidths = (widths, total) => {
  const sum = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => Math.max(20, Math.round((total * w) / sum)));
};

/** Whether `text` is a heading line for Built-in Heading styles: short, not empty, without ending punctuation → {level, tabs} or
 * null. Leading tabs give lower levels (one tab Heading 2). */
export function headingOf(text) {
  const tabs = /^\t*/.exec(text)[0].length;
  const t = text.slice(tabs).trim();
  // ponytail: Word's length limit is unknown; 60 characters and 10 words stand in for "a short line".
  if (!t || t.length > 60 || t.split(/\s+/).length > 10 || /[.,;:!?]$/.test(t) || !LETTER.test(t)) return null;
  return { level: Math.min(6, tabs + 1), tabs };
}

const NOW_KINDS = { quote: 'quotes', ordinal: 'ordinals', fraction: 'fractions', dash: 'dashes', boldItalic: 'boldItalic', link: 'links' };

// The characters after which correct() can make an edit: a word finisher, a Tab, a quote or a bold or italic mark.
const TRIGGER = /[\s.,;:!?)\]}"“”…'*_]/;

/** AutoFormat now's plan for paragraphs `paras` [{text, styled, list, inTable, linked(from, to)}] under settings.word.autoformatNow `now` →
 * [{edits, heading}] per paragraph: the Replace edits found as if each paragraph were typed, and a heading level for short lines
 * that end no sentence and stand before another paragraph (Normal paragraphs only while Preserve styles is on). */
export function autoFormatPlan(paras, now) {
  const af = { quotes: now.quotes, ordinals: now.ordinals, fractions: now.fractions, dashes: now.dashes, boldItalic: now.boldItalic, links: now.links };
  const o = { ac: {}, af, entries: new Map(), firstLetter: new Set(), initialCaps: new Set(), other: new Set() };
  return paras.map((p, i) => {
    const edits = [];
    const ctx = { linked: p.linked };
    const take = (t) => { for (const e of correct(t, o, ctx)) if (NOW_KINDS[e.kind] && !edits.some((x) => x.from < e.to && e.from < x.to)) edits.push(e); };
    // ponytail: each call slices the prefix, so a paragraph costs O(length x triggers): fine for prose, slow on a paragraph of
    // tens of thousands of characters. Hand correct() a window of the text before the trigger if that matters.
    for (let k = 0; k < p.text.length; k++) if (TRIGGER.test(p.text[k])) take(p.text.slice(0, k + 1));
    take(`${p.text}\n`);
    const next = paras[i + 1];
    const h = now.headings && !p.list && !p.inTable && !(now.preserveStyles && p.styled) && next?.text.trim() ? headingOf(p.text) : null;
    return { edits: edits.sort((a, b) => a.from - b.from), heading: h?.level ?? 0 };
  });
}

// The assistant's plain output rules (automation plan §13.13 (c), user rules 2026-10-06): keyboard characters, no dashes, no
// contrast frames, no rhythmic triplets, no stacked intensifiers, no filler openers or hedges. Pure: loop.js lints the model's
// chat replies, test/style-lint.test.mjs tests it. Text a write puts into a draft is never fixed or linted (cleanup AS3). The cloud
// APIs take no character grammar (§13.13 (a)), so the mechanical fixes run on every reply and only the rest goes back, once.
// Text the user wrote (`known`: the open draft and their message) is left as it is: a match found in it is not an issue.

const LETTER = '\\p{L}';
// Mechanical fixes, in order: [rule, regex, replacement]. A dash between words reads as a comma.
const FIXES = [
  ['space', /[\u00a0\u2007\u2009\u202f]/gu, ' '],
  ['quotes', /[\u2018\u2019\u201a\u2032]/gu, "'"],
  ['quotes', /[\u201c\u201d\u201e\u2033]/gu, '"'],
  ['ellipsis', /\u2026/gu, '...'],
  ['dash', /(\d)\s*[\u2013\u2014]\s*(?=\d)/gu, '$1-'], // a number range
  ['dash', /^([ \t]*)[\u2013\u2014][ \t]+/gmu, '$1- '], // a dash as a bullet
  ['dash', /[ \t]*[\u2013\u2014\u2015][ \t]*/gu, ', '],
  ['dash', new RegExp(`(?<=${LETTER}) (?:-|--) (?=${LETTER})|(?<=${LETTER})--(?=${LETTER})`, 'gu'), ', '],
];
// Flagged symbols: dashes, curly quotes, arrows and emoji only. CJK and full-width punctuation (U+3000-303F, U+FF00-FFEF) is
// never flagged, nor any letter, currency sign or other symbol.
const SYMBOL = /[\u2010-\u2015\u2018-\u201f\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f\u2b00-\u2bff\p{Extended_Pictographic}]/gu;
const CJK = /[\u3000-\u303f\uff00-\uffef]/u;

const INTENSE = 'really|very|truly|extremely|incredibly|super|so|absolutely|totally|deeply|highly|utterly';
const PATTERNS = [
  ['contrast', /\b(?:it'?s|it is|this is|that'?s|that is|they'?re|is|are|was)\s+not\s+(?:just\s+|only\s+|merely\s+)?[^.;!?\n]{1,40}?[,;]\s*(?:it'?s|it is|they'?re|rather)\b/giu],
  ['contrast', /\b(?:isn'?t|aren'?t|wasn'?t)\s+(?:just\s+|only\s+)?[^.;!?\n]{1,40}?[,;]\s*(?:it'?s|it is|they'?re|they are)\b/giu],
  ['contrast', /\bnot\s+(?:just|only|merely)\s+[^.;!?\n]{1,40}?,?\s+but\s+(?:also\s+)?/giu],
  ['intensifiers', new RegExp(`\\b(?:${INTENSE})\\s+(?:${INTENSE})\\b`, 'giu')],
  ['filler', /(?:^|\n)\s*(?:great question|good question|certainly|of course|sure thing|happy to help|i'?d be happy to|i'?d love to)\b/giu],
  ['hedge', /\b(?:it'?s worth noting|it is worth noting|it should be noted|it'?s important to note|it is important to note|needless to say|arguably)\b/giu],
];
const PHRASE = "[\\p{L}\\d']+(?: [\\p{L}\\d']+){0,3}"; // one to four words
// "clean, simple, but powerful." or "clean, simple, powerful."; a list closed by "and" or "or" ("A, B and C.") is not one.
const TRIPLET = new RegExp(`(?<![\\p{L}\\d'])(${PHRASE}, ${PHRASE}, (?:(?:but|and even|yet) |(?![^.!,\\n]*\\b(?:and|or|nor)\\b))${PHRASE}[.!])`, 'gu');
const LONG = 8; // words: the triplet rules skip shorter texts (a label such as "Spawn, mid, lane." is a list)

/** Code spans and fenced blocks of Markdown as [from, to] ranges: their text is never linted or fixed. */
function codeRanges(text) {
  const out = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

// Chinese punctuation outside the CJK blocks (破折號 ——, ……, “” ‘’): a dash, ellipsis or curly quote whose nearest character past
// its run (spaces and more of these skipped) on either side is Han or CJK / full-width punctuation.
const RUN = /[ \t‐-―‘-‟…]/u;
const HAN = /[\p{Script=Han}　-〿＀-￯]/u;
function chinese(text, from, to) {
  if (![...text.slice(from, to)].every((c) => RUN.test(c))) return false;
  let a = from - 1;
  while (a >= 0 && RUN.test(text[a])) a--;
  let b = to;
  while (b < text.length && RUN.test(text[b])) b++;
  return HAN.test(text[a] ?? '') || HAN.test(text[b] ?? '');
}

/** Whether the match at [from, to] of `text` is kept: inside code, Chinese punctuation, or the user's own (found in `known` with a
 * few characters around it). */
function kept(text, from, to, known, code) {
  if (code.some(([a, b]) => from < b && to > a)) return true;
  if (chinese(text, from, to)) return true;
  if (!known) return false;
  const pad = to - from > 12 ? 0 : 6;
  return known.includes(text.slice(Math.max(0, from - pad), to + pad).trim());
}

/** `text` with the mechanical fixes made outside code and outside what `known` holds. */
export function fix(text, known = '') {
  let s = String(text ?? '');
  for (const [, re, to] of FIXES) {
    const code = codeRanges(s);
    s = s.replace(re, (...m) => { // (match, ...groups, offset, string): no named groups
      const off = m.at(-2);
      return kept(s, off, off + m[0].length, known, code) ? m[0] : to.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '');
    });
  }
  return s;
}

/** The issues of `text` that fix() leaves: [{rule, match}], at most one per rule and match, none the user's own. */
export function lint(text, known = '') {
  const s = String(text ?? '');
  const code = codeRanges(s);
  const out = [];
  const add = (rule, match, from) => {
    if (!kept(s, from, from + match.length, known, code) && !out.some((i) => i.rule === rule && i.match === match)) out.push({ rule, match: match.trim() });
  };
  for (const m of s.matchAll(SYMBOL)) if (!CJK.test(m[0])) add('symbol', m[0], m.index);
  for (const [rule, re] of PATTERNS) for (const m of s.matchAll(re)) add(rule, m[0], m.index);
  if (s.split(/\s+/).filter(Boolean).length >= LONG) {
    for (const m of s.matchAll(TRIPLET)) add('triplet', m[1], m.index);
    // Three sentences in a row of at most six words each.
    const sentences = [...s.matchAll(/[^\n]+?[.!?](?=\s|$)/g)].map((m) => ({ text: m[0].trim(), at: m.index })); // "3.7" ends none
    for (let i = 0; i + 2 < sentences.length; i++) {
      const run = sentences.slice(i, i + 3);
      if (run.every((x) => x.text.split(/\s+/).length <= 6) && /^[^\n]*$/.test(s.slice(run[0].at, run[2].at + run[2].text.length))) {
        add('triplet', run.map((x) => x.text).join(' '), run[0].at);
        i += 2;
      }
    }
  }
  return out;
}

const RULE_TEXT = {
  symbol: 'a character that is not on a keyboard', dash: 'a dash between words', contrast: 'a contrast frame ("not X, it is Y")',
  triplet: 'a group of three for rhythm, or three short sentences in a row', intensifiers: 'stacked intensifiers', filler: 'a filler opener',
  hedge: 'a hedge',
};
/** The message that asks the model to write a text again without `issues`. */
export const styleAsk = (issues, what = 'your last reply') => `Write ${what} again without breaking the writing rules. It has ${issues
  .map((i) => `${RULE_TEXT[i.rule] ?? i.rule}: "${i.match}"`).join('; ')}. Keep the content.`;

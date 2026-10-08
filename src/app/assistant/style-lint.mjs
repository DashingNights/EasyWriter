// The assistant's plain output rules (automation plan §13.13 (c), user rules 2026-10-06): keyboard characters, no dashes, no
// contrast frames, no rhythmic triplets, no stacked intensifiers, no filler openers or hedges. Pure: loop.js lints the model's
// replies and the text arguments of its write commands, test/style-lint.test.mjs tests it. The cloud APIs take no character
// grammar (§13.13 (a)), so the mechanical fixes run on every text and only the rest goes back to the model, once.
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
const ALLOWED = /[\u00a3\u20ac]/u; // symbols kept beyond printable ASCII (letters of any script are kept too: names, other languages)
const SYMBOL = /[\p{P}\p{S}\p{Extended_Pictographic}]/gu; // beyond ASCII: an emoji, an arrow, a bullet

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

/** Whether the match at [from, to] of `text` is the user's own: inside code, or found in `known` with a few characters around it. */
function kept(text, from, to, known, code) {
  if (code.some(([a, b]) => from < b && to > a)) return true;
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
  for (const m of s.matchAll(SYMBOL)) if (m[0].charCodeAt(0) > 127 && !ALLOWED.test(m[0])) add('symbol', m[0], m.index);
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

// Argument keys that hold ids, paths, URLs, colours and other values, not prose: never linted or fixed.
const SKIP = /^(?:id|ids|path|paths|itemPath|itemPaths|draftId|planId|flowchartId|url|src|href|color|colour|fill|stroke|bg|background|font|fontFamily|shape|type|kind|mode|target|action|keys|format|align|valign|query|selector|role|ref|anchor|from|to|side|route|dash|head|startHead|endHead)$/i;

/** Tool call arguments `json` (a string) \u2192 {arguments: the JSON with every prose string fixed, issues: lint's issues of them}. */
export function styleArgs(json, known = '') {
  let args;
  try {
    args = JSON.parse(json || '{}');
  } catch {
    return { arguments: json, issues: [] };
  }
  const issues = [];
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (SKIP.test(key ?? '')) return v;
      const fixed = fix(v, known);
      for (const i of lint(fixed, known)) if (!issues.some((x) => x.rule === i.rule && x.match === i.match)) issues.push(i);
      return fixed;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  const fixed = walk(args);
  return { arguments: JSON.stringify(fixed), issues };
}

const RULE_TEXT = {
  symbol: 'a character that is not on a keyboard', dash: 'a dash between words', contrast: 'a contrast frame ("not X, it is Y")',
  triplet: 'a group of three for rhythm, or three short sentences in a row', intensifiers: 'stacked intensifiers', filler: 'a filler opener',
  hedge: 'a hedge',
};
/** The message that asks the model to write a text again without `issues`. */
export const styleAsk = (issues, what = 'your last reply') => `Write ${what} again without breaking the writing rules. It has ${issues
  .map((i) => `${RULE_TEXT[i.rule] ?? i.rule}: "${i.match}"`).join('; ')}. Keep the content.`;

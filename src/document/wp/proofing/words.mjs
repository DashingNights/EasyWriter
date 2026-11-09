// The words spelling looks at (docs/plans/word briefs/proofing.md): a tokenizer over one paragraph's text, Word's ignore rules
// (UPPERCASE, words with numbers, Internet and file addresses) and repeated words ('the the'). Pure, so node tests load it.

// Internet and file addresses: a scheme, www., an e-mail address, a drive or UNC path, or a bare domain with a common ending.
const URL_LIKE = new RegExp([
  '^[a-z][a-z0-9+.-]*://', '^(mailto|file):', '^www\\.', '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$', '^[a-z]:[\\\\/]', '^\\\\\\\\', '^\\.{0,2}/[^\\s/]+/',
  '^[\\w-]+(\\.[\\w-]+)*\\.(com|org|net|edu|gov|io|co|uk|de|fr|hk|cn|jp|info|dev|app|ai|xyz|moe)(/\\S*)?$',
].join('|'), 'i');
const CHUNK = /[^\s\u00a0\u2000-\u200b\u3000\ufffc]+/g; // \ufffc stands for an inline object or text spelling skips
const SUB = /[\p{L}\p{M}\p{N}]+(?:['\u2019][\p{L}\p{M}\p{N}]+)*/gu;
const TRAIL = /[.,;:!?)\]}"'\u2019\u201d>]+$/;

/** The words of paragraph text `text` → [{start, end, word, kind}] in order, kind 'word', 'upper' (all capitals, two letters or more),
 * 'number' (holds a digit) or 'url' (an Internet or file address, kept whole). Hyphenated and slashed words split into their parts,
 * as Chromium checks them. */
export function tokens(text) {
  const out = [];
  for (const m of text.matchAll(CHUNK)) {
    const chunk = m[0];
    const lead = chunk.match(/^[("'\u2018\u201c[<{]*/)[0].length;
    const core = chunk.slice(lead).replace(TRAIL, '');
    if (core && URL_LIKE.test(core)) {
      out.push({ start: m.index + lead, end: m.index + lead + core.length, word: core, kind: 'url' });
      continue;
    }
    for (const s of chunk.matchAll(SUB)) {
      const word = s[0];
      const kind = /\p{N}/u.test(word) ? 'number' : word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase() ? 'upper' : 'word';
      out.push({ start: m.index + s.index, end: m.index + s.index + word.length, word, kind });
    }
  }
  return out;
}

/** Whether token `tok` is skipped under proofing options `opts` ({ignoreUpper, ignoreNumbers, ignoreUrls}). */
export function ignoredKind(tok, opts = {}) {
  if (tok.kind === 'url') return opts.ignoreUrls !== false;
  if (tok.kind === 'number') return opts.ignoreNumbers !== false;
  if (tok.kind === 'upper') return opts.ignoreUpper !== false;
  return false;
}

/** The tokens of `list` (from tokens(text)) that repeat the word just before them with only spaces between, as Word's Flag repeated
 * words finds them ('the the', case ignored) → the second token of each pair. */
export function repeats(list, text) {
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (a.kind === 'number' || a.kind === 'url' || b.kind === 'number' || b.kind === 'url') continue;
    if (a.word.toLowerCase() !== b.word.toLowerCase()) continue;
    if (/^[ \t\u00a0]+$/.test(text.slice(a.end, b.start))) out.push(b);
  }
  return out;
}

/** Whether `word` is on doc settings' ignored list `ignored` (Ignore All; case ignored). */
export const isIgnored = (word, ignored) => !!ignored?.length && ignored.some((w) => String(w).toLowerCase() === word.toLowerCase());

/** The sentence of paragraph text `text` that holds [start, end) → {text, start, end} with start and end inside the sentence. */
export function sentenceAround(text, start, end) {
  let a = 0;
  for (const m of text.slice(0, start).matchAll(/[.!?]['"\u2019\u201d)\]]*\s+/g)) a = m.index + m[0].length;
  const rest = text.slice(end).search(/[.!?]['"\u2019\u201d)\]]*(\s|$)/);
  const b = rest < 0 ? text.length : end + rest + text.slice(end + rest).match(/^[.!?]['"\u2019\u201d)\]]*/)[0].length;
  return { text: text.slice(a, b).replace(/\ufffc/g, ' '), start: start - a, end: end - a };
}

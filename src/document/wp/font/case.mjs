// Change Case and Shift+F3 (docs/plans/word/briefs/font.md; probe/menus/home.change-case.json; index-editing.md lines 98-99).
// Pure: every mode rewrites one character for one, so marks and positions stay where they are. A character whose case form has
// another length keeps its own (ß stays ß in UPPERCASE, as Word leaves it).

const isUpper = (c) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c) => c !== c.toUpperCase() && c === c.toLowerCase();
const up = (c) => (c.toUpperCase().length === c.length ? c.toUpperCase() : c);
const down = (c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c);
const isWord = (c) => /[\p{L}\p{N}'’]/u.test(c);
const isLetter = (c) => /\p{L}/u.test(c);

/** Full-width form of `c`: U+0021-007E to U+FF01-FF5E and the space to U+3000 (katakana left out, recorded in the report). */
const full = (c) => (c === ' ' ? '　' : c >= '!' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c);
const half = (c) => (c === '　' ? ' ' : c >= '！' && c <= '～' ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c);

/** `text` in Sentence case: the first letter of each sentence up and every other letter down. A sentence starts at the text's
 * start and after . ! or ? followed by white space. */
function sentence(text) {
  let start = true;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (isLetter(c)) {
      out += start ? up(c) : down(c);
      start = false;
    } else {
      out += c;
      if (/[.!?]/.test(c) && (i + 1 >= text.length || /\s/.test(text[i + 1]))) start = true;
    }
  }
  return out;
}

/** `text` with each word's first letter up and the rest down (Capitalize Each Word). */
function eachWord(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const first = i === 0 || !isWord(text[i - 1]);
    out += isLetter(c) ? (first ? up(c) : down(c)) : c;
  }
  return out;
}

const MODES = {
  sentenceCase: sentence,
  lowercase: (t) => [...t].map(down).join(''),
  UPPERCASE: (t) => [...t].map(up).join(''),
  capitalizeEachWord: eachWord,
  tOGGLECASE: (t) => [...t].map((c) => (isUpper(c) ? down(c) : isLower(c) ? up(c) : c)).join(''),
  halfWidth: (t) => [...t].map(half).join(''),
  fullWidth: (t) => [...t].map(full).join(''),
};

/** The Change Case modes by their menu id segment. */
export const CASE_MODES = Object.keys(MODES);

/** `text` changed to `mode` (a CASE_MODES id), the same length as `text`; an unknown mode returns null. */
export const changeCase = (text, mode) => MODES[mode]?.(text) ?? null;

/** The mode Shift+F3 applies to `text` next, decided by the text as Word does: all lowercase becomes Capitalize Each Word (Sentence
 * case when it holds a sentence end, index-editing.md line 98), all capitals become lowercase, anything else (a capital first, mixed
 * case) becomes UPPERCASE. → a mode id, or null when `text` has no cased letter. */
export function nextCase(text) {
  const letters = [...text].filter((c) => isUpper(c) || isLower(c));
  if (!letters.length) return null;
  if (letters.every(isUpper)) return 'lowercase';
  if (letters.every(isLower)) return /[.!?]/.test(text) ? 'sentenceCase' : 'capitalizeEachWord';
  return 'UPPERCASE';
}

/** The word around offset `i` of `text` → [start, end], or null when `i` is not strictly inside a word (at its edge, in white
 * space): Word applies a character command to the whole word only then. With `edge`, a word the offset touches counts too
 * (Shift+F3 changes the word at the insertion point). */
export function wordAround(text, i, edge = false) {
  const before = i > 0 && isWord(text[i - 1]);
  const after = i < text.length && isWord(text[i]);
  if (edge ? !before && !after : !before || !after) return null;
  let a = i;
  let b = i;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  return [a, b];
}

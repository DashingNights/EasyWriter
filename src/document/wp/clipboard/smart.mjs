// Smart cut and paste (docs/plans/word plan.md §3 clipboard, index-editing.md "Typing and editing"): Word's "Adjust sentence and
// word spacing automatically". Deleting or cutting `two` from `one two three` leaves `one three`; a word pasted between words gets
// the missing space; a paste right before punctuation drops the space. Pure: the plugin reads the characters around the edit.

const WORD = /[\p{L}\p{N}]/u;
// Punctuation a space never stands before in English text.
const PUNCT = /^[.,;:!?)\]}%]/;
// A space or a no-break space: white space that is not a tab or a line end.
const SPACE = /^[^\S\t\r\n]$/;
const LEAD = /^[^\S\t\r\n]*/;
const TRAIL = /[^\S\t\r\n]*$/;

/** Whether deleting text[from, to) of a paragraph's `text` removes whole words: something wordlike goes, and neither end cuts a word. */
export function wholeWords(text, from, to) {
  const gone = text.slice(from, to);
  return WORD.test(gone) && !WORD.test(text[from - 1] ?? '') && !WORD.test(text[to] ?? '');
}

/** The space to remove after whole words were deleted, from the characters `before` and `after` the deletion point ('' at a paragraph
 * edge) → 'before' (the space before), 'after' (the space after) or null. */
export function deleteFix(before, after) {
  if (SPACE.test(before) && SPACE.test(after)) return 'after';
  if (SPACE.test(before) && (after === '' || PUNCT.test(after))) return 'before';
  if (before === '' && SPACE.test(after)) return 'after';
  return null;
}

/** The space fixes for pasting `text` between the characters `before` and `after` ('' at a paragraph edge) → {lead: add a space
 * first, trail: add one last, dropLead: leading spaces to remove, dropTrail: trailing spaces to remove}. */
export function pasteSpacing(before, text, after) {
  const fix = { lead: false, trail: false, dropLead: 0, dropTrail: 0 };
  // A paste inside a word (word characters on both sides) gets no spaces: splitting the word is a guess, unverified in Word.
  if (!text || (WORD.test(before) && WORD.test(after))) return fix;
  const leading = LEAD.exec(text)[0].length;
  if (leading === text.length) return fix;
  const trailing = TRAIL.exec(text)[0].length;
  const first = text[leading];
  const last = text[text.length - trailing - 1];
  if (!leading && WORD.test(before) && WORD.test(first)) fix.lead = true;
  if (leading && (before === '' || SPACE.test(before))) fix.dropLead = leading;
  if (!trailing && WORD.test(after) && WORD.test(last)) fix.trail = true;
  if (trailing && (PUNCT.test(after) || SPACE.test(after))) fix.dropTrail = trailing;
  return fix;
}

/** `text` with the fixes of pasteSpacing applied (for tests and plain text). */
export function spaced(before, text, after) {
  const f = pasteSpacing(before, text, after);
  return `${f.lead ? ' ' : ''}${text.slice(f.dropLead, text.length - f.dropTrail)}${f.trail ? ' ' : ''}`;
}

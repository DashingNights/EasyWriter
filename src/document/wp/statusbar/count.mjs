// The status bar's counts in the shape it caches per paragraph ({words, chars, charsSp, paras}). The rule itself is proofing's,
// shared by proofing, statusbar and fields-info (src/document/model/count.mjs, plan.md §1.11). A paragraph's text comes in as a
// string: line breaks as '\n', tabs as '\t', field results as their text.
import { countText as countOne } from '../../model/count.mjs';

/** Words in `text` by Word's rules. */
export const countWords = (text) => countOne(String(text ?? '')).words;

/** One paragraph's counts → {words, chars, charsSp, paras}: paras is 1 unless the paragraph is empty or holds only spaces. */
export function countParagraph(text) {
  const c = countOne(String(text ?? ''));
  return { words: c.words, chars: c.chars, charsSp: c.charsSp, paras: c.blank ? 0 : 1 };
}

export const ZERO = Object.freeze({ words: 0, chars: 0, charsSp: 0, paras: 0 });

/** The sum of paragraph counts `a` and `b`. */
export const addCounts = (a, b) => ({ words: a.words + b.words, chars: a.chars + b.chars, charsSp: a.charsSp + b.charsSp, paras: a.paras + b.paras });

/** The counts of `paragraphs` (strings, one per paragraph). */
export const countText = (paragraphs) => paragraphs.map(countParagraph).reduce(addCounts, ZERO);

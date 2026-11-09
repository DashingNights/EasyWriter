// Word's statistics of a Document for the statistics fields, in the shape fields.mjs reads. The rule itself is proofing's, shared
// by proofing, statusbar and fields-info (src/document/model/count.mjs, plan.md §1.11). Body text only, as Word's document
// properties count it: notes and text boxes are left out.
import { countDoc } from '../../model/count.mjs';

/** Word's statistics of `doc` (a Document's ProseMirror doc): words, characters with and without spaces (paragraph marks not
 * counted), and the paragraphs that hold text. */
export function counts(doc) {
  const c = countDoc(doc, { notes: false });
  return { words: c.words, chars: c.charsSp, noSpaces: c.chars, paragraphs: c.paras };
}

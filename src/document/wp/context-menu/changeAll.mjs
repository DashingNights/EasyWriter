// The spelling card's Change All (docs/plans/word/briefs/context-menu.md): every whole-word, same-case copy of the misspelled word in
// the story becomes the suggestion, in one transaction. Pure: it works on a ProseMirror transaction and node tests load it.

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The start offsets of the whole-word, same-case copies of `word` in `text` (a letter or digit on either side means no match). */
export function wordMatches(text, word) {
  const out = [];
  if (!word) return out;
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + word.length)) {
    const before = text[i - 1];
    const after = text[i + word.length];
    if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) out.push(i);
  }
  return out;
}

/** The [from, to] document ranges of the whole-word copies of `word` in `doc`, textblock by textblock; an inline node that is not
 * text counts as one character that is no letter, so a word never runs across it. */
export function wordRanges(doc, word) {
  const out = [];
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    let text = '';
    const at = []; // document position of each character of text
    block.forEach((child, offset) => {
      const start = pos + 1 + offset;
      const chars = child.isText ? child.text : '￼';
      for (let i = 0; i < chars.length; i++) at.push(start + i);
      text += chars;
    });
    for (const i of wordMatches(text, word)) out.push([at[i], at[i + word.length - 1] + 1]);
    return false;
  });
  return out;
}

/** Replaces every whole-word copy of `word` in `tr`'s doc with `next`, last first so the positions hold → the number replaced. */
export function changeAll(tr, word, next) {
  const ranges = wordRanges(tr.doc, word);
  for (const [from, to] of ranges.reverse()) tr.insertText(next, from, to);
  return ranges.length;
}

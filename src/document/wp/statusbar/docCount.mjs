// A Document's counts for the status bar: count.mjs's rules over each paragraph's visible text (model/review.mjs visibleText, so
// tracked deletions follow the markup display). Paragraph counts are memoised on the paragraph node, which ProseMirror keeps
// while the paragraph is unchanged, so a keystroke recounts one paragraph and adds up the rest.
import { visibleText } from '../../model/review.mjs';
import { addCounts, countParagraph, ZERO } from './count.mjs';

const memo = { final: new WeakMap(), all: new WeakMap(), original: new WeakMap(), simple: new WeakMap() };
const docMemo = new WeakMap(); // doc → {display: counts}

/** settings.word.tracking.display → the visibleText display ('none' shows the final text). */
export const displayOf = (display) => (display in memo ? display : 'final');

const paraCounts = (node, display) => {
  const m = memo[display];
  let c = m.get(node);
  if (!c) m.set(node, (c = countParagraph(visibleText(node, display))));
  return c;
};

/** The whole document's counts → {words, chars, charsSp, paras}. */
export function docCounts(doc, display = 'final') {
  const d = displayOf(display);
  let byDisplay = docMemo.get(doc);
  if (!byDisplay) docMemo.set(doc, (byDisplay = {}));
  if (byDisplay[d]) return byDisplay[d];
  let total = ZERO;
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    total = addCounts(total, paraCounts(node, d));
    return false;
  });
  return (byDisplay[d] = total);
}

/** The counts of the text between `from` and `to`: each paragraph the range touches, cut to the range. */
export function rangeCounts(doc, from, to, display = 'final') {
  const d = displayOf(display);
  let total = ZERO;
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    const a = Math.max(0, from - start);
    const b = Math.min(node.content.size, to - start);
    if (b > a) total = addCounts(total, a === 0 && b === node.content.size ? paraCounts(node, d) : countParagraph(visibleText(node.cut(a, b), d)));
    return false;
  });
  return total;
}

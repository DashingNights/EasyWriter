// Word's text units over a flat copy of the document (docs/plans/word briefs/editing-keys.md): '\r' ends each paragraph and '\f'
// stands for a section break, as Word's own story text does, so the F8 steps and the probe offsets (probe/behaviour-tests.tsv f8
// rows) compare one to one. Pure: node tests load it.

const WORD = /[\p{L}\p{N}_'’]/u;
const END = /[.!?]/;
const CLOSE = /["'’”)\]]/;

/** Doc `doc` as Word's flat text → {text, at(i) → the ProseMirror position before character i (the end of the last textblock
 * for i = text.length), offset(pos) → the flat offset of position `pos`}. */
export function flatOf(doc) {
  let text = '';
  const pos = [];
  let last = 0;
  doc.descendants((node, p) => {
    if (node.type.name === 'sectionBreak') {
      text += '\f';
      pos.push(p);
      return false;
    }
    if (!node.isTextblock) return !node.isAtom;
    node.forEach((child, off) => {
      const piece = child.isText ? child.text : '￼';
      for (let i = 0; i < piece.length; i++) pos.push(p + 1 + off + i);
      text += piece;
    });
    text += '\r';
    pos.push(p + node.nodeSize - 1);
    last = p + node.nodeSize - 1;
    return false;
  });
  const at = (i) => (i < pos.length ? pos[i] : last);
  const offset = (p) => {
    let lo = 0;
    let hi = pos.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pos[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return { text, at, offset };
}

const isWord = (ch) => !!ch && WORD.test(ch);

/** The word at offset `i` of `text` with its trailing spaces → [from, to]; on a punctuation mark only that mark. */
export function wordAt(text, i) {
  // A caret right after a word (at a space or a paragraph's end) takes that word.
  if ((i >= text.length || /\s/.test(text[i])) && isWord(text[i - 1])) i--;
  if (!isWord(text[i])) return text[i] && !/\s/.test(text[i]) ? [i, i + 1] : [i, i];
  let a = i;
  let b = i;
  while (isWord(text[a - 1])) a--;
  while (isWord(text[b])) b++;
  while (text[b] === ' ') b++;
  return [a, b];
}

/** The paragraph holding offset `i` with its mark → [from, to]. */
export function paraAt(text, i) {
  let a = i;
  while (a > 0 && text[a - 1] !== '\r' && text[a - 1] !== '\f') a--;
  let b = i;
  while (b < text.length && text[b] !== '\r' && text[b] !== '\f') b++;
  return [a, text[b] === '\r' ? b + 1 : b];
}

/** The sentence holding offset `i` with its trailing spaces → [from, to]: a sentence ends after . ! or ? (and any closing quotes
 * or brackets) at a space or the paragraph's end. */
export function sentenceAt(text, i) {
  const [pa, pb] = paraAt(text, i);
  const end = text[pb - 1] === '\r' ? pb - 1 : pb;
  let start = pa;
  for (let k = pa; k < end;) {
    let e = k;
    while (e < end) {
      if (END.test(text[e])) {
        let f = e + 1;
        while (END.test(text[f]) || CLOSE.test(text[f] ?? '')) f++;
        if (f >= end || text[f] === ' ') {
          e = f;
          break;
        }
      }
      e++;
    }
    while (text[e] === ' ') e++;
    if (i < e || e >= end) return [start, Math.min(e, end)];
    start = k = e;
  }
  return [start, end];
}

/** The section holding offset `i` with its break → [from, to]. flatOf writes each sectionBreak as '', so these are
 * model/sections.mjs sectionsOf's bounds read on the flat text, which the other F8 steps already work on. */
function sectionSpan(text, i) {
  let a = i;
  while (a > 0 && text[a - 1] !== '\f') a--;
  let b = i;
  while (b < text.length && text[b] !== '\f') b++;
  return [a, b < text.length ? b + 1 : b];
}

/** F8's steps from caret `origin` → [[from, to]...], smallest first and each a new size: the caret, the word, the sentence, the
 * paragraph, the section and the document. */
export function levels(text, origin) {
  const all = [[origin, origin], wordAt(text, origin), sentenceAt(text, origin), paraAt(text, origin), sectionSpan(text, origin), [0, text.length]];
  return all.filter((r, k) => k === 0 || r[0] !== all[k - 1][0] || r[1] !== all[k - 1][1])
    .filter((r, k, list) => k === 0 || r[1] - r[0] > list[k - 1][1] - list[k - 1][0]);
}

const within = (r, cur) => r[0] <= cur[0] && r[1] >= cur[1];

/** F8 from selection `cur` ([from, to]) started at caret `origin` → the next larger step, or null when the document is selected. */
export const grow = (text, origin, cur) => levels(text, origin).find((r) => within(r, cur) && r[1] - r[0] > cur[1] - cur[0]) ?? null;

/** Shift+F8 → the next smaller step, or null at the caret. */
export const shrink = (text, origin, cur) => levels(text, origin).filter((r) => within(cur, r) && r[1] - r[0] < cur[1] - cur[0]).at(-1) ?? null;

/** A character `ch` typed in Extend mode: the selection reaches its next occurrence at or after `head`, inclusive → the new head,
 * or null when it does not occur again. */
export function charExtend(text, head, ch) {
  const i = text.indexOf(ch, head);
  return i < 0 ? null : i + 1;
}

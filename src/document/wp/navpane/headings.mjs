// The Navigation pane's model (docs/plans/word/briefs/navpane.md): which top-level blocks are headings and at what outline level,
// the section a heading owns, moving a section, and the ranges collapsed headings hide. Pure: Node tests load it.
// ponytail: top-level blocks only; a heading inside a table, columns or a content control is not listed. Walk wrappers when
// someone needs them.
import { visibleText } from '../../model/review.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';

/** The outline level (1 to 9) of block `node` in `doc`, or null for body text: a heading node's level, else the paragraph's own
 * outline attribute (0 to 8, 9 is body text), else the outline of its style chain, the most derived style first. */
export function levelOf(doc, node) {
  const name = node.type.name;
  if (name === 'heading') return node.attrs.level;
  if (name !== 'paragraph') return null;
  const own = node.attrs.outline;
  if (own != null) return own >= 0 && own < 9 ? own + 1 : null;
  const styles = doc.attrs?.styles;
  const hit = styleLevels.get(node);
  if (hit && hit.styles === styles) return hit.level;
  let level = null;
  const chain = styleChain(doc, styleIdOf(node));
  for (let i = chain.length - 1; i >= 0; i--) {
    const o = chain[i].para?.outline ?? chain[i].outline;
    if (o != null) {
      level = o >= 0 && o < 9 ? o + 1 : null;
      break;
    }
  }
  styleLevels.set(node, { styles, level });
  return level;
}

// A paragraph's style-chain level, per node: nodes never change but the styles they read can, so each entry keeps the styles
// it was read from. Every keystroke reruns headingsOf for the twisties, and this keeps it to a lookup per unchanged paragraph.
const styleLevels = new WeakMap();

/** Every heading of `doc` in order → [{pos, level, text, index, collapsed}]: text is what `display` shows (§1.11 visibleText). */
export function headingsOf(doc, display = 'final') {
  const out = [];
  doc.forEach((node, pos, index) => {
    const level = levelOf(doc, node);
    if (level) out.push({ pos, level, text: visibleText(node, display), index, collapsed: !!node.attrs.collapsed });
  });
  return out;
}

/** The headings as a tree → [{...heading, children}]: each heading nests under the last one above it with a lower level, so a
 * Heading 3 straight after a Heading 1 is the Heading 1's child. */
export function treeOf(heads) {
  const root = { level: 0, children: [] };
  const stack = [root];
  for (const h of heads) {
    while (stack.at(-1).level >= h.level) stack.pop();
    const n = { ...h, children: [] };
    stack.at(-1).children.push(n);
    stack.push(n);
  }
  return root.children;
}

/** The section of the heading at top-level position `pos` → {from, to, level}: the heading and every block after it up to the next
 * heading of the same or a higher level (or the end); null when the block there is no heading. */
export function sectionRange(doc, pos) {
  const node = doc.nodeAt(pos);
  const level = node && levelOf(doc, node);
  if (!level) return null;
  let to = doc.content.size;
  doc.forEach((n, p) => {
    if (to !== doc.content.size || p <= pos) return;
    const l = levelOf(doc, n);
    if (l && l <= level) to = p;
  });
  return { from: pos, to, level };
}

/** Moves the section of the heading at `pos` to top-level position `target` in transaction `tr` (one step pair, so one undo step).
 * The blocks move as they are, so list numbering attributes and suggestion records stay with them. → the section's new start, or
 * null when `target` lies inside the section or nothing is there. */
export function moveSection(tr, pos, target) {
  const r = sectionRange(tr.doc, pos);
  if (!r || (target >= r.from && target <= r.to)) return null;
  const content = tr.doc.slice(r.from, r.to).content;
  if (target > r.to) {
    tr.insert(target, content);
    tr.delete(r.from, r.to);
    return target - (r.to - r.from);
  }
  tr.delete(r.from, r.to);
  tr.insert(target, content);
  return target;
}

/** The ranges the collapsed headings at positions `collapsed` hide → [{from, to}] sorted and merged: each heading's section minus
 * the heading itself. */
export function collapsedRanges(doc, collapsed) {
  const out = [];
  for (const pos of [...collapsed].sort((a, b) => a - b)) {
    const r = sectionRange(doc, pos);
    if (!r) continue;
    const from = pos + doc.nodeAt(pos).nodeSize;
    if (from >= r.to) continue;
    const last = out.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ from, to: r.to });
  }
  return out;
}

/** Whether `pos` lies inside one of `ranges`. */
export const hiddenAt = (ranges, pos) => ranges.some((r) => pos >= r.from && pos < r.to);

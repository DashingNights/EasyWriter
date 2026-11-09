// Outline levels and the outline tree (docs/plans/word/plan.md §3 outline, §1.8 paragraph.outline). Pure: Node tests load it.
// A level is 0 to 8 for Heading 1 to 9 and 9 (BODY) for body text, as Word's w:outlineLvl. Blocks are the document's
// top-level children; a table, a picture or a board counts as body text, as in Word's Outline view.
import { BUILTIN_STYLES } from '../../defaults.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';

export const BODY = 9;
/** Word's indent step between outline levels in points (half an inch, observed in Word's Outline view). */
export const STEP = 36;

/** The outline level of block `node` in `doc`: its own paragraph.outline when set, else its style chain's, else BODY. */
export function levelOf(doc, node) {
  if (!node.isTextblock) return BODY;
  const own = node.attrs?.outline;
  if (Number.isInteger(own) && own >= 0 && own <= BODY) return own;
  const id = styleIdOf(node);
  const chain = styleChain(doc, id);
  for (let i = chain.length - 1; i >= 0; i--) if (Number.isInteger(chain[i].para?.outline)) return chain[i].para.outline;
  // A document whose styles lack the heading definitions (made before styles landed) still reads its headings by name.
  const builtin = BUILTIN_STYLES[id]?.para?.outline;
  if (Number.isInteger(builtin)) return builtin;
  return node.type?.name === 'heading' ? (node.attrs.level ?? 1) - 1 : BODY;
}

/** The top-level blocks of `doc` → [{pos, end, node, level}] in document order. */
export function blocksOf(doc) {
  const out = [];
  doc.forEach((node, pos) => out.push({ pos, end: pos + node.nodeSize, node, level: levelOf(doc, node) }));
  return out;
}

/** The index after the last block of block `i`'s subtree in `blocks` (levels only: [{level}]); body text has none. */
export function subtreeEnd(blocks, i) {
  const l = blocks[i].level;
  let j = i + 1;
  if (l < BODY) while (j < blocks.length && blocks[j].level > l) j++;
  return j;
}

/** Index of the heading that block `i` sits under, or -1. */
export function parentOf(blocks, i) {
  const l = blocks[i].level;
  for (let j = i - 1; j >= 0; j--) if (blocks[j].level < l) return j;
  return -1;
}

/** Which blocks show for display state `view` = {limit: 0-9 (the deepest level shown), over: Map(index → limit)}: a block shows
 * when every heading above it in the tree shows and its level is within the limit of its nearest heading that has its own
 * limit (Expand and Collapse set those), else the global limit (Show Level) → boolean[]. */
export function shownOf(blocks, { limit = BODY, over = new Map() } = {}) {
  const stack = []; // the open headings: {level, lim, shown}
  return blocks.map((b, i) => {
    while (stack.length && stack.at(-1).level >= b.level) stack.pop();
    let lim = limit;
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].lim != null) { lim = stack[k].lim; break; }
    const shown = stack.every((s) => s.shown) && b.level <= lim;
    if (b.level < BODY) stack.push({ level: b.level, lim: over.has(i) ? over.get(i) : null, shown });
    return shown;
  });
}

/** The limit that applies to the children of heading `i` now (its own, else its nearest ancestor's, else the global one). */
export function limitUnder(blocks, i, { limit = BODY, over = new Map() } = {}) {
  for (let k = i; k >= 0; k = parentOf(blocks, k)) if (over.has(k)) return over.get(k);
  return limit;
}

/** The outline symbol of block `i`: 'plus' for a heading with subordinate blocks, 'minus' for one without, 'body' for body text. */
export const symbolOf = (blocks, i) => (blocks[i].level === BODY ? 'body' : subtreeEnd(blocks, i) > i + 1 ? 'plus' : 'minus');

/** Indent steps of each block: a heading's level, body text one step under the heading above it (0 with none) → number[]. */
export function indentsOf(blocks) {
  let heading = -1;
  return blocks.map((b) => {
    if (b.level < BODY) {
      heading = b.level;
      return b.level;
    }
    return heading + 1;
  });
}

/** Expand on heading `i`: the next level of its subtree that is hidden now becomes shown → the heading's new limit, or null
 * when nothing more can show. */
export function expandStep(blocks, i, view) {
  const lim = limitUnder(blocks, i, view);
  let next = null;
  for (let j = i + 1; j < subtreeEnd(blocks, i); j++) if (blocks[j].level > lim && (next == null || blocks[j].level < next)) next = blocks[j].level;
  return next;
}

/** Collapse on heading `i`: the lowest level shown in its subtree hides → the heading's new limit (its own level when all
 * of the subtree hides), or null when nothing under it shows. */
export function collapseStep(blocks, i, view) {
  const shown = shownOf(blocks, view);
  const end = subtreeEnd(blocks, i);
  let deepest = -1;
  for (let j = i + 1; j < end; j++) if (shown[j]) deepest = Math.max(deepest, blocks[j].level);
  if (deepest < 0) return null;
  let next = blocks[i].level;
  for (let j = i + 1; j < end; j++) if (blocks[j].level < deepest && blocks[j].level > next) next = blocks[j].level;
  return next;
}

/** The blocks that Promote and Demote change for the selected block indices `sel` (a collapsed heading brings its hidden
 * subtree) → Map(index → new level). Promote takes a heading up one level (Heading 1 stays) and body text to the level of
 * the heading above it, when the selection holds no heading; Demote takes a heading down one (Heading 9 stays) and leaves
 * body text. `to` instead sets every selected block to that level (Promote to Heading 1, Outline Level, Demote to Body Text). */
export function levelChanges(blocks, sel, dir, to = null) {
  const out = new Map();
  if (to != null) {
    for (const i of sel) if (blocks[i].level !== to) out.set(i, to);
    return out;
  }
  const heading = sel.some((i) => blocks[i].level < BODY);
  for (const i of sel) {
    const l = blocks[i].level;
    if (l < BODY) {
      const n = l + dir;
      if (n >= 0 && n < BODY) out.set(i, n);
    } else if (dir < 0 && !heading) {
      const p = parentOf(blocks, i);
      out.set(i, p < 0 ? 0 : blocks[p].level);
    }
  }
  return out;
}

/** Selected block indices `[a, b]` with the hidden blocks after `b` (a collapsed heading's subtree) → the last index. */
export function runEnd(shown, b) {
  let e = b;
  while (e + 1 < shown.length && !shown[e + 1]) e++;
  return e;
}

/** Where Move Up or Move Down puts the run of blocks `a` to `b` (hidden blocks after `b` included): the gap index the run
 * goes before, past the previous or next shown block (the next one with its hidden subtree), or null at either end. */
export function moveGap(shown, a, b, dir) {
  const e = runEnd(shown, b);
  if (dir < 0) {
    for (let p = a - 1; p >= 0; p--) if (shown[p]) return p;
    return null;
  }
  for (let n = e + 1; n < shown.length; n++) if (shown[n]) return runEnd(shown, n) + 1;
  return null;
}

/** The new order of indices `lo` to `hi` when the run `a`-`e` moves to gap `gap` → {lo, hi, order} or null when it stays. */
export function moveOrder(a, e, gap) {
  if (gap >= a && gap <= e + 1) return null;
  const run = range(a, e);
  if (gap < a) return { lo: gap, hi: e, order: [...run, ...range(gap, a - 1)] };
  return { lo: a, hi: gap - 1, order: [...range(e + 1, gap - 1), ...run] };
}

const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);

/** The blocks Show First Line Only shortens: body text paragraphs → boolean[]. */
export const firstLineOf = (blocks, on) => blocks.map((b) => !!on && b.level === BODY && b.node.isTextblock);

/** Labels of the Outline Level list (probe menus/outline.outlining.outline-level.json) by level. */
export const levelLabel = (l) => (l >= BODY ? 'Body Text' : `Level ${l + 1}`);

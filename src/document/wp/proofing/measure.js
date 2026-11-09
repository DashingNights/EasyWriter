// Word Count's layout counts (docs/plans/word briefs/proofing.md): Lines from the rendered line boxes of each paragraph and Pages
// from the page geometry. Text box lines count only with Include textboxes, footnotes and endnotes on; note text is drawn by the
// notes package outside the text flow, so its lines are not counted (recorded).
import { geometryOf } from '../../geometry.js';

/** The rendered lines of `rects` (client rects of one paragraph's text): rects that overlap vertically sit on one line. */
function lineCount(rects) {
  const list = [...rects].filter((r) => r.height > 0).sort((a, b) => a.top - b.top);
  let n = 0;
  let bottom = -Infinity;
  for (const r of list) {
    if (r.top >= bottom - 1) {
      n++;
      bottom = r.bottom;
    } else bottom = Math.max(bottom, r.bottom);
  }
  return n;
}

/** The lines between `from` and `to` of editor view `view`; an empty paragraph is one line, as in Word. */
export function linesOf(view, from, to, { notes = true } = {}) {
  let n = 0;
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'textBox' && !notes) return false;
    if (!node.isTextblock) return true;
    const a = Math.max(from, pos + 1);
    const b = Math.min(to, pos + node.nodeSize - 1);
    if (node.content.size === 0 || b <= a) {
      n += 1;
      return false;
    }
    try {
      const start = view.domAtPos(a);
      const end = view.domAtPos(b);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      n += Math.max(1, lineCount(range.getClientRects()));
    } catch {
      n += 1;
    }
    return false;
  });
  return n;
}

/** The pages of `state` between `from` and `to` (the whole document without them). */
export function pagesOf(state, from, to) {
  const geo = geometryOf(state);
  const total = geo?.pages?.length || 1;
  if (from == null || !geo?.pageOf) return total;
  return Math.max(1, geo.pageOf(to) - geo.pageOf(from) + 1);
}

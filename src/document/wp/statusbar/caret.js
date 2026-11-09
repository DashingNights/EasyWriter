// Where the caret is on its page, for the Vertical Page Position, Line Number and Column items. These read Range rects, which are
// not free, so the bar measures only the items it shows, once per frame after a selection or layout change.
import { geometryOf, scaleOf } from '../../geometry.js';
import { indexAt } from '../../geometry.mjs';

/** The page box holding layout y `y`, or null without pages. */
function pageAtY(pages, y) {
  if (!pages?.length) return null;
  return pages[indexAt(pages.map((p) => p.top), y)];
}

/** Rects of the lines between `from` and `to` (client px): each text node's line boxes, and an empty paragraph's own box. */
function lineRects(view, from, to) {
  const out = [];
  const range = view.dom.ownerDocument.createRange();
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const el = view.nodeDOM(pos);
    if (!(el instanceof Element)) return false;
    const before = out.length;
    const walker = view.dom.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.data) continue;
      range.selectNodeContents(t);
      for (const r of range.getClientRects()) if (r.height > 0) out.push(r);
    }
    if (out.length === before) out.push(el.getBoundingClientRect()); // an empty paragraph, or one holding only objects
    return false;
  });
  return out;
}

/** The caret's line on its page (1 for the first body line): one plus the lines that end above the caret's line and start on
 * this page. Line boxes that overlap vertically are one line. */
function lineOf(view, head, caret, pages, page, rootTop, scale) {
  const start = page && page.index > 0 ? pages[page.index - 1].from : 0;
  const pageTop = page ? rootTop + page.top * scale : -Infinity;
  // Boxes that reach down into the caret's line (a taller run beside the caret) belong to that line, not to one above it.
  const rects = lineRects(view, Math.min(start, head), head).filter((r) => r.top >= pageTop - 1 && r.bottom <= caret.top + 2)
    .sort((a, b) => a.top - b.top);
  let lines = 0;
  let bottom = -Infinity;
  for (const r of rects) {
    if (r.top < bottom - 1) {
      bottom = Math.max(bottom, r.bottom);
      continue;
    }
    lines++;
    bottom = r.bottom;
  }
  return lines + 1;
}

/** The caret's column (1 at the line start): the characters from the start of its visual line, found with posAtCoords at the
 * paragraph's left edge on the caret's line. */
function columnOf(view, head, caret) {
  const $h = view.state.doc.resolve(head);
  if (!$h.parent.isTextblock || $h.depth < 1) return 1;
  const el = view.nodeDOM($h.before());
  let start = $h.start();
  if (el instanceof Element) {
    const hit = view.posAtCoords({ left: el.getBoundingClientRect().left + 1, top: (caret.top + caret.bottom) / 2 });
    if (hit) start = Math.max($h.start(), Math.min(hit.pos, head));
  }
  return view.state.doc.textBetween(start, head, '', '\ufffc').length + 1;
}

/** The caret measures `want` asks for ({verticalPosition, lineNumber, column}) → {vertical (layout px from the page's top edge),
 * line, column}, each null when not asked or not measurable (a hidden or detached view). */
export function measureCaret(view, want) {
  const out = { vertical: null, line: null, column: null };
  if (!view?.dom?.isConnected || !(want.verticalPosition || want.lineNumber || want.column)) return out;
  try {
    const head = view.state.selection.head;
    const caret = view.coordsAtPos(head);
    const rootTop = view.dom.getBoundingClientRect().top;
    const scale = scaleOf(view);
    const pages = geometryOf(view.state)?.pages ?? [];
    const y = (caret.top - rootTop) / scale;
    const page = pageAtY(pages, y);
    if (want.verticalPosition) out.vertical = page ? y - page.top : y;
    if (want.lineNumber) out.line = lineOf(view, head, caret, pages, page, rootTop, scale);
    if (want.column) out.column = columnOf(view, head, caret);
  } catch {
    // a position without coordinates (a collapsed or hidden view): leave the values out
  }
  return out;
}

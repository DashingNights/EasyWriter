// The width text lays out at, worked out from the page setup (pure): a section's paper less its margins and a side gutter, or one
// newspaper column of it. One helper for the layout predictor's worker (no ProseMirror there) and wp/columns/model.mjs
// columnWidthAt, which canvases and inserted pictures fit to (src/whiteboard.js columnWidth).
import { paperOf } from '../wp/page-engine/layout.mjs';

/** Word's default spacing between newspaper columns, in points. */
export const SPACE = 36;

const r2 = (v) => Math.round(v * 100) / 100;

/** Column boxes of a columns node with `attrs` across `text` px of text width: [{left, width}] in px from the text's left edge, as
 * drawn: CSS multicol draws equal columns only (unequal widths keep their data and draw equal, recorded). */
export function colBoxes(attrs, text) {
  if (!attrs) return null;
  const n = attrs.count;
  const gap = Math.min((attrs.space ?? SPACE) * (4 / 3), n > 1 ? (text - n) / (n - 1) : 0);
  const w = (text - (n - 1) * gap) / n;
  return Array.from({ length: n }, (_, i) => ({ left: r2(i * (w + gap)), width: r2(w) }));
}

/** The width (px) text takes in section `sect` (defaults filled) under document settings `settings`: the paper less the left and
 * right margins and a gutter at the side (paperOf), or one column's width inside a columns node whose attrs are `cols`. */
export function columnWidthOf(sect, settings, cols = null) {
  const text = paperOf(sect, { gutterAtTop: !!settings?.gutterAtTop }).text;
  return cols ? colBoxes(cols, text)[0].width : text;
}

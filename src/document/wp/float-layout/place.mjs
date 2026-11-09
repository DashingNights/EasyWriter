// Floating object placement (docs/plans/word/plan.md §3 float-layout, §1.8 float layout object): where a picture, text box, canvas,
// plan chart or framed paragraph sits from its layout attribute. Pure, so node tests load it: lengths in the model are pt, every
// result is layout px in .ProseMirror coordinates (the page overlay's space, geometry.js), where x 0 is the text column's left
// edge and the paper's left edge is -box.left.

import { styleIdOf } from '../../model/styles.mjs';
import { styleProps } from '../paragraph/rules.mjs';

/** Layout px per pt (96 dpi). */
export const PT = 96 / 72;

/** Every key of a new float (probe/dialogs/layout.json defaults: Left and Right 0.32 cm = 9 pt, Top and Bottom 0). */
export const FLOAT_DEFAULTS = {
  wrap: 'square', side: 'both', dist: { t: 0, b: 0, l: 9, r: 9 }, h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 }, z: 0,
  moveWithText: true, lockAnchor: false, allowOverlap: true, inCell: true, hidden: false, poly: null, relSize: null,
};

/** Wrap styles in Word's menu order; the first is In Line with Text. */
export const WRAPS = ['inline', 'square', 'tight', 'through', 'topBottom', 'behind', 'front'];

/** The objects that float: ctx.obj kinds (registry §1.3). */
export const FLOATABLE = new Set(['picture', 'graphic', 'textbox', 'canvas', 'planChart', 'chart']);

/** A new float of `wrap` placed `at` {x, y} pt from its column and its anchor paragraph (where it was drawn). */
export function newFloat(wrap, at = {}) {
  return { ...FLOAT_DEFAULTS, dist: { ...FLOAT_DEFAULTS.dist }, wrap, h: { rel: 'column', offset: round(at.x ?? 0) }, v: { rel: 'paragraph', offset: round(at.y ?? 0) } };
}

/** `layout` with every key a float has (a text box's stored default holds only wrap, h and v), or null for In Line. */
export function full(layout) {
  if (!layout || layout.wrap === 'inline') return null;
  return { ...FLOAT_DEFAULTS, ...layout, dist: { ...FLOAT_DEFAULTS.dist, ...layout.dist } };
}

/** The layout after picking wrap `wrap` for an object of `kind` whose layout is `old`, drawn `at` {x, y} pt (newFloat). In Line
 * writes null on a picture (it becomes an inline image again) and wrap 'inline' on a block node, which keeps its place (deviation:
 * Word sets the block in the line). An object already floating keeps its position and options; JSON is patched, never rebuilt. */
export function withWrap(old, wrap, kind, at) {
  const picture = kind === 'picture' || kind === 'graphic';
  if (wrap === 'inline') return picture ? null : { ...(old ?? {}), wrap: 'inline' };
  if (!old || old.wrap === 'inline') return { ...(old ?? {}), ...newFloat(wrap, at) };
  return { ...old, wrap };
}

const ROWS = [['top', 'Top'], ['center', 'Middle'], ['bottom', 'Bottom']];
const COLS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];

/** The Position gallery's nine items (menus/layout.position.json order: Top Left to Bottom Right): Square wrapping aligned in the
 * margins, no longer moving with the text. Each is {id, label, patch}. */
export const POSITIONS = ROWS.flatMap(([v, vw]) => COLS.map(([h, hw]) => ({
  id: `positionIn${vw}${hw}WithSquareTextWrapping`,
  label: `Position in ${vw} ${hw} with Square Text Wrapping`,
  wrap: 'square', h: { rel: 'margin', align: h }, v: { rel: 'margin', align: v }, moveWithText: false,
})));

/** Whether page `number` is even (inside and outside margins mirror there). */
const isEven = (number) => (number ?? 1) % 2 === 0;

/** The relation an inside or outside margin stands for on a page: inside is the left margin on odd pages and the right on even
 * ones (Word's book layout); vertically inside is the top margin on odd pages and the bottom on even ones (G5). */
export function mirror(rel, even) {
  if (rel === 'insideMargin') return even ? 'rightMargin' : 'leftMargin';
  if (rel === 'outsideMargin') return even ? 'leftMargin' : 'rightMargin';
  return rel;
}
const mirrorV = (rel, even) => (rel === 'insideMargin' ? (even ? 'bottomMargin' : 'topMargin') : rel === 'outsideMargin' ? (even ? 'topMargin' : 'bottomMargin') : rel);

/** The horizontal band `rel` names on `frame` → {left, width} px. frame: {page: {box}, colLeft, colWidth, charLeft}. */
export function hBand(rel, frame) {
  const { box } = frame.page;
  const col = { left: frame.colLeft ?? 0, width: frame.colWidth ?? box.text };
  switch (mirror(rel, isEven(frame.page.number))) {
    case 'page': return { left: -box.left, width: box.w };
    case 'margin': return { left: 0, width: box.text };
    case 'character': return { left: frame.charLeft ?? col.left, width: 0 };
    case 'leftMargin': return { left: -box.left, width: box.left };
    case 'rightMargin': return { left: box.text, width: box.right };
    default: return col; // column
  }
}

/** The vertical band `rel` names on `frame` → {top, height} px. frame: {page: {top, bodyTop, bodyHeight, box}, anchorTop, lineTop}. */
export function vBand(rel, frame) {
  const { page } = frame;
  const { box } = page;
  switch (mirrorV(rel, isEven(page.number))) {
    case 'page': return { top: page.top, height: box.h };
    case 'margin': return { top: page.bodyTop, height: page.bodyHeight ?? box.body };
    case 'line': return { top: frame.lineTop ?? frame.anchorTop ?? page.bodyTop, height: 0 };
    case 'topMargin': return { top: page.top, height: box.top };
    case 'bottomMargin': return { top: page.bodyTop + (page.bodyHeight ?? box.body), height: box.bottom };
    default: return { top: frame.anchorTop ?? page.bodyTop, height: 0 }; // paragraph
  }
}

/** Where `size` {w, h} px goes in `band` {start, extent} for one axis of `pos` (h or v of the layout); `even` mirrors inside and
 * outside alignment. → px */
function along(pos, start, extent, size, even) {
  if (pos?.align) {
    const a = pos.align === 'inside' ? (even ? 'end' : 'start') : pos.align === 'outside' ? (even ? 'start' : 'end')
      : pos.align === 'left' || pos.align === 'top' ? 'start' : pos.align === 'center' ? 'center' : 'end';
    return a === 'start' ? start : a === 'center' ? start + (extent - size) / 2 : start + extent - size;
  }
  if (pos?.pct != null) return start + (extent * pos.pct) / 100;
  return start + (pos?.offset ?? 0) * PT;
}

/** The object's top-left {x, y} px for layout `layout`, size `size` {w, h} px and `frame` (hBand and vBand). */
export function placement(layout, size, frame) {
  const l = full(layout) ?? FLOAT_DEFAULTS;
  const even = isEven(frame.page.number);
  const hb = hBand(l.h?.rel ?? 'column', frame);
  const vb = vBand(l.v?.rel ?? 'paragraph', frame);
  return { x: along(l.h, hb.left, hb.width, size.w, even), y: along(l.v, vb.top, vb.height, size.h, even) };
}

/** The side of the column nearer to an object at `x` of width `w` → 'left' | 'right' (a centred float falls to the left). */
export function nearerSide(x, w, colLeft, colWidth) {
  return x + w / 2 <= colLeft + colWidth / 2 ? 'left' : 'right';
}

/** The side a Square or Tight float sits on → 'left' | 'right'. CSS wraps text on one side of a float only, so Both sides falls
 * to the nearer side (deviation); Left only puts the object right of the text; Largest only leaves the wider side to the text. */
export function floatSide(layout, x, w, colLeft, colWidth) {
  const l = full(layout) ?? FLOAT_DEFAULTS;
  if (l.side === 'left') return 'right';
  if (l.side === 'right') return 'left';
  if (l.side === 'largest') return x - colLeft >= colLeft + colWidth - (x + w) ? 'right' : 'left';
  const a = l.h?.align;
  if (a === 'left' || a === 'right') return a;
  return nearerSide(x, w, colLeft, colWidth);
}

/** The frame (w:framePr) paragraph or heading `node` lays out by, or null: its own frame's settings over its style's (`doc` gives the
 * styles; without it, its own only). Word merges them setting by setting: the fixture's Styles Format Frame style sets 144 pt at the
 * column's right, the paragraph only wrap around, and Word draws the 144 pt frame at the right. */
export function frameOf(node, doc = null) {
  const own = node.attrs.frame ?? null;
  const n = node.type.name;
  const styled = doc && (n === 'paragraph' || n === 'heading') ? styleProps(doc, styleIdOf(node)).para.frame : null;
  return styled ? { ...styled, ...Object.fromEntries(Object.entries(own ?? {}).filter(([, v]) => v != null)) } : own;
}

/** The layout a framed paragraph (§1.8 paragraph frame, w:framePr) places by: Around wraps like Square, None like Top and Bottom;
 * a frame relative to the text moves with it. */
export function frameLayout(frame) {
  const f = frame ?? {};
  const hRel = f.hAnchor === 'page' ? 'page' : f.hAnchor === 'margin' ? 'margin' : 'column';
  const vRel = f.vAnchor === 'page' ? 'page' : f.vAnchor === 'margin' ? 'margin' : 'paragraph';
  const yAlign = f.yAlign === 'inline' ? null : f.yAlign;
  return {
    ...FLOAT_DEFAULTS,
    wrap: f.wrap === 'none' || f.wrap === 'notBeside' ? 'topBottom' : 'square',
    dist: { t: f.vSpace ?? 0, b: f.vSpace ?? 0, l: f.hSpace ?? 0, r: f.hSpace ?? 0 },
    h: f.xAlign ? { rel: hRel, align: f.xAlign } : { rel: hRel, offset: f.x ?? 0 },
    v: yAlign ? { rel: vRel, align: yAlign } : { rel: vRel, offset: f.y ?? 0 },
    moveWithText: vRel === 'paragraph',
  };
}

/** The offset in pt that puts an object at `px` along an axis whose band starts at `start` px. */
export const offsetOf = (px, start) => round((px - start) / PT);

/** Geometry page `page` in layout px whose y 0 lies `y` px below the paper's top, x unchanged (0 at the text column): the page a
 * header's or footer's floats are placed on. The page layer places on the paper (y 0), the story editor on its own top, so both put
 * a float at the same place on the paper. */
export const pageFrom = (page, y) => ({ ...page, top: -y, bodyTop: page.bodyTop - page.top - y });

/** `n` rounded to hundredths, as Word shows lengths. */
export function round(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// Wrapping: where text runs beside a Square, Tight or Through object

/** The wraps text runs beside, at one side of the object (CSS floats); Top and Bottom takes the object's lines whole. */
export const WRAPS_BESIDE = new Set(['square', 'tight', 'through']);

const BOX = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** The points a Tight or Through object wraps by: its wrap points (Edit Wrap Points; fractions of its box, Word's 21600 a side,
 * and they may reach past it), else its box. */
export const pointsOf = (layout) => (layout?.poly?.length >= 3 ? layout.poly : BOX);

/** The distances from text of full layout `l` in px. */
const distOf = (l) => ({ t: (l.dist?.t ?? 0) * PT, r: (l.dist?.r ?? 0) * PT, b: (l.dist?.b ?? 0) * PT, l: (l.dist?.l ?? 0) * PT });

/** The outline text keeps clear of, for an object of `layout` whose box is `rect` {x, y, w, h} px, floated to `side` ('left'
 * or 'right'; its text runs on the other side): Square is the box grown by its four distances; Tight and Through follow the wrap
 * points moved by the distance on the text's side, as Word measures it across each line (Word greys the top and bottom
 * distances for them). → [[x, y]] px, or null for a wrap without one (In Line, Top and Bottom, Behind, In Front). */
export function outlineOf(layout, { x, y, w, h }, side) {
  const l = full(layout);
  if (!l || !WRAPS_BESIDE.has(l.wrap)) return null;
  const d = distOf(l);
  if (l.wrap === 'square') return [[x - d.l, y - d.t], [x + w + d.r, y - d.t], [x + w + d.r, y + h + d.b], [x - d.l, y + h + d.b]];
  const dx = side === 'right' ? -d.l : d.r;
  return pointsOf(l).map(([px, py]) => [x + px * w + dx, y + py * h]);
}

/** A CSS polygon() of `pts` px. */
const polygon = (pts) => `polygon(${pts.map(([x, y]) => `${round(x)}px ${round(y)}px`).join(', ')})`;

/** Whether a picture's format can hold alpha (png, gif, webp, svg). */
const alphaFormat = (src) => !!src && /^data:image\/(png|gif|webp|svg)/i.test(src);

/** shape-outside for a Square, Tight or Through float of `layout` whose box is `w` x `h` px with margins `m` {mt, ml} px (marginsOf),
 * floated to `side`: its outline (outlineOf) in px of its margin box, which clips it. A Tight or Through picture without wrap
 * points whose format holds alpha wraps its picture (url(), which CSS fits to the content box whatever the margins). → CSS or null. */
export function shapeOf(layout, src, { w, h, m, side }) {
  const l = full(layout);
  if (!l || !WRAPS_BESIDE.has(l.wrap)) return null;
  // ponytail: alpha read from the format, not the pixels, and without the distance; a decoded bitmap would give Word's outline.
  if (l.wrap !== 'square' && !(l.poly?.length >= 3) && alphaFormat(src)) return `url("${src}")`;
  return polygon(outlineOf(l, { x: m.ml, y: m.mt, w, h }, side));
}

/** The margins that move a float from where the flow puts its box with no margins, `nat` {top, left, right} px, to `p` {x, y},
 * `w` x `h` px, floated to `side` ('left' | 'right'), or a block in the flow (side null). The placing margin on the object's own
 * side goes negative when it crosses that column edge, so it keeps its side and the text beside it. The far side and the bottom
 * hold the distances and wrap points reaching past the box, since the margin box clips the float's outline; a block in the flow
 * keeps its top distance from the text above. Nothing rises above the line it is drawn in (clamped: Word would move the lines
 * above), unless `lift`: a header's or footer's float, placed above its paragraph to reach into the body, goes there with a
 * negative top margin, its outline starting at that line, since CSS lays no earlier line round it. → {mt, mr, mb, ml, clamped}
 * ponytail: wrap points above the box (negative y) count only below the top of the line the float is drawn in, and points past
 * its own side only inside the column, where the placing margins end the margin box: widening them would move the float, and
 * no earlier line wraps round it anyway. Word moves the lines above instead. */
export function marginsOf(layout, side, nat, p, w, h, lift = false) {
  const l = full(layout) ?? FLOAT_DEFAULTS;
  const d = distOf(l);
  const pts = l.wrap === 'tight' || l.wrap === 'through' ? pointsOf(l) : BOX;
  const past = (i, lo) => Math.max(0, ...pts.map((q) => (lo ? -q[i] : q[i] - 1)));
  const m = { mt: side && lift ? p.y - nat.top : Math.max(side ? 0 : d.t, p.y - nat.top), mr: 0, mb: side ? Math.max(d.b, past(1) * h) : d.b, ml: 0, clamped: p.y < nat.top - 0.5 };
  if (side === 'right') {
    m.mr = nat.right - (p.x + w);
    m.ml = Math.max(d.l, past(0, true) * w + d.l);
  } else {
    m.ml = p.x - nat.left;
    if (side === 'left') m.mr = Math.max(d.r, past(0) * w + d.r);
  }
  return m;
}

/** What text keeps clear of round an object drawn at `r` {x, y, w, h, layout} px in a text column `width` px wide → {side (the
 * side it floats to), pts (outline px)}, or null for a wrap text runs over: Top and Bottom takes the column's width, Square,
 * Tight and Through their outline (outlineOf). */
export function textOutline(r, width) {
  const l = full(r.layout);
  if (!l) return null;
  if (l.wrap === 'topBottom') {
    const d = distOf(l);
    return { side: 'left', pts: [[0, r.y - d.t], [width, r.y - d.t], [width, r.y + r.h + d.b], [0, r.y + r.h + d.b]] };
  }
  const side = floatSide(l, r.x, r.w, 0, width);
  const pts = outlineOf(l, r, side);
  return pts && { side, pts };
}

/** The floats a page's text wraps round that lie outside its text: a header's or footer's pictures, text boxes and canvases
 * reaching into the body. `rects` [{x, y, w, h, layout, src}] px from the text column's left and the paper's top; `body` {top,
 * height, width} px of the text on the paper. Outlines that start above the text's top (a header's) go in one CSS float a side
 * at the top of the page's text; those that start lower down (a footer's reaching up) in one float a side of their own, at the
 * top-level block that holds their top line, so blocks that avoid a float's whole box (whole tables, Top and Bottom pictures,
 * Text Wrapping breaks) above it stay where they are. `slotAt(y, side)` → {top, ...} gives where such a float starts (px from
 * the text's top, at or above y) or null at the text's top; a lower float whose box would meet the upper one of its side joins
 * it, as CSS would set it beside the first. Each float's box runs down to the lowest of its outlines. Top and Bottom takes the
 * whole width. → [{side, w, h, shape, slot}] (shape: polygon() in px of that box; slot null for the float at the text's top). */
export function pageWraps(rects, body, slotAt = () => null) {
  const sides = { left: [[], []], right: [[], []] }; // per side: [from the text's top, lower down]
  for (const r of rects ?? []) {
    const { side, pts } = textOutline(r, body.width) ?? {};
    if (!pts) continue;
    const ys = pts.map((q) => q[1]);
    if (Math.max(...ys) <= body.top || Math.min(...ys) >= body.top + body.height) continue;
    sides[side][Math.min(...ys) > body.top ? 1 : 0].push(pts.map(([x, y]) => [Math.min(body.width, Math.max(0, x)), y - body.top]));
  }
  const lowest = (all) => Math.max(...all.flat().map((q) => q[1]));
  const out = [];
  for (const side of ['left', 'right']) {
    const [high, low] = sides[side];
    const slot = low.length ? slotAt(Math.min(...low.flat().map((q) => q[1])), side) : null;
    if (low.length && (!slot || (high.length && slot.top < lowest(high)))) high.push(...low.splice(0));
    for (const [all, at] of [[high, null], [low, slot]]) {
      if (!all.length) continue;
      const top = at?.top ?? 0;
      const xs = all.flat().map((q) => q[0]);
      const left = side === 'left' ? 0 : Math.min(...xs);
      const w = side === 'left' ? Math.max(...xs) : body.width - left;
      const h = Math.min(body.height, lowest(all)) - top;
      if (w <= 0 || h <= 0) continue;
      // One outline: each part from its top point and back, joined along the box's edge away from the text, which no line reads
      // (a left float's lines start at the outline's right-most point within them, a right float's end at its left-most).
      const edge = side === 'left' ? 0 : w;
      const pts = [];
      for (const part of all.map((p) => p.map(([x, y]) => [x - left, y - top])).sort((a, b) => Math.min(...a.map((q) => q[1])) - Math.min(...b.map((q) => q[1])))) {
        const i = part.reduce((k, q, j) => (q[1] < part[k][1] ? j : k), 0);
        const t = part[i];
        pts.push([edge, t[1]], ...part.slice(i), ...part.slice(0, i), t, [edge, t[1]]);
      }
      out.push({ side, w: round(w), h: round(h), shape: polygon(pts), slot: at });
    }
  }
  return out;
}

// float-wrap (docs/plans/word/briefs/float-wrap.md): Tight and Through wrap round Word's wrap points, Square round its box and
// distances, in px of the float's margin box; a header's or footer's floats that reach into the body become one CSS float a side
// at the top of the page's text (src/document/wp/float-layout/place.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { marginsOf, outlineOf, pageWraps, PT, shapeOf } from '../src/document/wp/float-layout/place.mjs';

// The fixture's Edit Wrap Points case: a 48 pt picture, a triangle open to the right, 9 pt from the text left and right.
const triangle = { wrap: 'tight', side: 'both', dist: { t: 0, r: 9, b: 0, l: 9 }, poly: [[0, 0], [1, 0], [0.092593, 0.5], [1, 1], [0, 1]], polyEdited: true };
const W = 64;

/** Where a left float's lines start in the band y0..y1: the right-most point of `pts` (a polygon) within it, as CSS reads a shape. */
function startIn(pts, y0, y1) {
  let x = -Infinity;
  pts.forEach((a, i) => {
    const b = pts[(i + 1) % pts.length];
    const lo = Math.max(y0, Math.min(a[1], b[1]));
    const hi = Math.min(y1, Math.max(a[1], b[1]));
    if (lo > hi) return;
    const at = (y) => (a[1] === b[1] ? Math.max(a[0], b[0]) : a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]));
    x = Math.max(x, at(lo), at(hi));
  });
  return x;
}
const parse = (shape) => [...shape.matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);

test('Tight follows the wrap points, moved by the distance on the text side only', () => {
  const pts = outlineOf(triangle, { x: 200, y: 40, w: W, h: W }, 'left');
  assert.deepEqual(pts.map(([x]) => Math.round(x * 1000) / 1000), [212, 276, 217.926, 276, 212]);
  assert.deepEqual(pts.map(([, y]) => y), [40, 40, 72, 104, 104]);
  // Text left of a right float keeps the left distance.
  assert.equal(outlineOf(triangle, { x: 0, y: 0, w: W, h: W }, 'right')[0][0], -12);
});

test('a line beside the notch starts at the triangle, not at the box', () => {
  const pts = outlineOf(triangle, { x: 0, y: 0, w: W, h: W }, 'left');
  assert.ok(Math.abs(startIn(pts, 28, 36) - (0.092593 * W + 9 * PT + (4 / 32) * (1 - 0.092593) * W)) < 0.01);
  assert.equal(startIn(pts, -20, 0), W + 12);
  // Square keeps its box and four distances.
  assert.equal(startIn(outlineOf({ ...triangle, wrap: 'square' }, { x: 0, y: 0, w: W, h: W }, 'left'), 28, 36), W + 12);
});

test('the shape sits in the margin box, which reaches as far as the points and the distance', () => {
  const nat = { top: 10, left: 0, right: W };
  const m = marginsOf(triangle, 'left', nat, { x: 200, y: 50 }, W, W);
  assert.deepEqual({ mt: m.mt, ml: m.ml, mr: m.mr, mb: m.mb }, { mt: 40, ml: 200, mr: 12, mb: 0 });
  const shape = parse(shapeOf(triangle, null, { w: W, h: W, m, side: 'left' }));
  assert.deepEqual(shape[0], [212, 40]);
  // Points past the box widen the margin on the text side, so the margin box does not clip them.
  const wide = marginsOf({ ...triangle, poly: [[0, 0], [1.25, 0.5], [0, 1]] }, 'left', nat, { x: 0, y: 10 }, W, W);
  assert.equal(wide.mr, 0.25 * W + 12);
  // A right float places with its right margin and holds the distance on its left.
  const r = marginsOf({ ...triangle, wrap: 'square' }, 'right', { top: 0, left: 500, right: 564 }, { x: 400, y: 0 }, W, W);
  assert.deepEqual({ ml: r.ml, mr: r.mr }, { ml: 12, mr: 100 });
  // A Top and Bottom block keeps its top distance from the text above; a float puts it in its outline instead.
  assert.equal(marginsOf({ wrap: 'topBottom', dist: { t: 18 } }, null, { top: 0, left: 0 }, { x: 0, y: 0 }, W, W).mt, 24);
  assert.equal(marginsOf({ wrap: 'square', dist: { t: 18 } }, 'left', { top: 0, left: 0 }, { x: 0, y: 0 }, W, W).mt, 0);
  // Above its line a body float stays at the line (clamped); a header's or footer's lifts there.
  const above = marginsOf({ wrap: 'square' }, 'left', { top: 50, left: 0 }, { x: 0, y: 20 }, W, W);
  assert.deepEqual([above.mt, above.clamped], [0, true]);
  assert.equal(marginsOf({ wrap: 'square' }, 'left', { top: 50, left: 0 }, { x: 0, y: 20 }, W, W, true).mt, -30);
});

test('a header float reaching into the body becomes a float at the top of the page text', () => {
  const body = { top: 96, height: 900, width: 600 };
  const square = { wrap: 'square', dist: { t: 0, r: 9, b: 0, l: 9 }, h: { rel: 'column', offset: 0 } };
  const [w] = pageWraps([{ x: 20, y: 60, w: 100, h: 80, layout: square }], body);
  assert.equal(w.side, 'left');
  assert.equal(w.w, 132);
  assert.equal(w.h, 44);
  const pts = parse(w.shape);
  assert.equal(startIn(pts, 0, 10), 132);
  assert.equal(startIn(pts, 45, 60), -Infinity);
  // Inside the header only: nothing. Behind or In Front: nothing.
  assert.deepEqual(pageWraps([{ x: 20, y: 10, w: 100, h: 80, layout: square }], body), []);
  assert.deepEqual(pageWraps([{ x: 20, y: 60, w: 100, h: 80, layout: { ...square, wrap: 'front' } }], body), []);
  // Top and Bottom takes the whole width.
  const [tb] = pageWraps([{ x: 20, y: 60, w: 100, h: 80, layout: { ...square, wrap: 'topBottom' } }], body);
  assert.equal(startIn(parse(tb.shape), 0, 10), 600);
});

test('a header and a footer float on one side share one float, and each band keeps its own start', () => {
  const body = { top: 96, height: 900, width: 600 };
  const square = { wrap: 'square', dist: { t: 0, r: 0, b: 0, l: 0 }, h: { rel: 'column', align: 'left' } };
  const out = pageWraps([
    { x: 0, y: 950, w: 200, h: 100, layout: square }, // a footer picture reaching up 46 px
    { x: 0, y: 50, w: 80, h: 100, layout: square }, // a header picture reaching down 54 px
    { x: 520, y: 50, w: 80, h: 100, layout: { ...square, h: { rel: 'column', align: 'right' } } },
  ], body);
  assert.deepEqual(out.map((w) => w.side), ['left', 'right']);
  const [left, right] = out;
  assert.equal(left.h, 900);
  const pts = parse(left.shape);
  assert.equal(startIn(pts, 0, 20), 80);
  assert.ok(startIn(pts, 100, 800) <= 0);
  assert.equal(startIn(pts, 860, 880), 200);
  assert.equal(right.w, 80);
  assert.equal(Math.min(...parse(right.shape).filter(([, y]) => y >= 0 && y <= 54).map(([x]) => x)), 0);
});

test('a footer float gets its own float from the block holding its top line, unless it would meet the header\'s', () => {
  const body = { top: 96, height: 900, width: 600 };
  const square = { wrap: 'square', dist: { t: 0, r: 0, b: 0, l: 0 }, h: { rel: 'column', align: 'left' } };
  const rects = [{ x: 0, y: 950, w: 200, h: 100, layout: square }, { x: 0, y: 50, w: 80, h: 100, layout: square }];
  const asked = [];
  const out = pageWraps(rects, body, (y, side) => (asked.push([y, side]), { top: 840, pos: 7, at: 0 }));
  assert.deepEqual(asked, [[854, 'left']]);
  assert.deepEqual(out.map((w) => [w.side, w.h, w.slot?.pos ?? null]), [['left', 54, null], ['left', 60, 7]]);
  // The footer's float starts at the block's top; its lines start at the picture from its top (14 px down).
  const low = parse(out[1].shape);
  assert.equal(startIn(low, 0, 13), -Infinity);
  assert.equal(startIn(low, 20, 40), 200);
  // A block starting inside the header's float: one float, as before.
  assert.equal(pageWraps(rects, body, () => ({ top: 40, pos: 7, at: 0 })).length, 1);
});

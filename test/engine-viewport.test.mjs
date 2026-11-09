// engine-viewport: the canvas page area's slot layout (src/document/canvas/layout.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitZoom, GAP, inView, keepPoint, layoutPages, PAD, paintScale, placeOf, pointAt, PX_PER_PT } from '../src/document/canvas/layout.mjs';

const LETTER = { w: 612, h: 792 }; // 816 x 1056 px at 100 %
const pages = (n, p = LETTER) => Array.from({ length: n }, () => p);

test('pages stack one per row when two do not fit across, centred, with the gap', () => {
  const l = layoutPages(pages(3), 1, 1200);
  assert.equal(l.slots.length, 3);
  assert.deepEqual(l.slots.map((s) => s.x), [192, 192, 192]); // (1200 - 816) / 2
  assert.equal(l.slots[0].y, PAD);
  assert.equal(l.slots[1].y, PAD + 1056 + GAP);
  assert.equal(l.height, PAD + 3 * 1056 + 2 * GAP + PAD);
  assert.equal(l.width, 1200);
});

test('pages go side by side once they fit, and Multiple Pages fixes the count across', () => {
  const wide = layoutPages(pages(5), 0.5, 1400); // 408 px pages: three fit in 1400 - 48
  assert.equal(wide.slots.filter((s) => s.y === wide.slots[0].y).length, 3);
  const two = layoutPages(pages(5), 0.5, 1400, 2);
  assert.equal(two.slots.filter((s) => s.y === two.slots[0].y).length, 2);
  assert.equal(two.slots[1].x - two.slots[0].x, 408 + GAP * 0.5);
});

test('a page wider than the view widens the column instead of shrinking', () => {
  const l = layoutPages(pages(1), 2, 800);
  assert.equal(l.slots[0].x, PAD);
  assert.equal(l.width, 1632 + 2 * PAD);
});

test('only slots in the band are in view', () => {
  const l = layoutPages(pages(100), 1, 1200);
  const step = 1056 + GAP;
  assert.deepEqual(inView(l, PAD + 50 * step, PAD + 50 * step + 900), [50]);
  assert.deepEqual(inView(l, PAD + 50 * step, PAD + 51 * step + 100), [50, 51]);
  assert.deepEqual(inView(l, -5000, 0), []);
});

test('a zoom keeps the page point under the anchor', () => {
  const a = layoutPages(pages(20), 1, 1200);
  const b = layoutPages(pages(20), 1.5, 1200);
  const scroll = { left: 0, top: 5 * (1056 + GAP) + 300 };
  const anchor = { x: 640, y: 200 };
  const before = pointAt(a, scroll.left + anchor.x, scroll.top + anchor.y);
  const s = keepPoint(a, b, scroll, anchor);
  const after = pointAt(b, s.left + anchor.x, s.top + anchor.y);
  assert.equal(after.page, before.page);
  assert.ok(Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6, JSON.stringify({ before, after }));
});

test('a point in a gap or margin goes to the nearest page, clamped to it', () => {
  const l = layoutPages(pages(2), 1, 1200);
  assert.deepEqual(pointAt(l, 0, 0), { page: 0, x: 0, y: 0 });
  const gapY = PAD + 1056 + GAP * 0.75; // nearer page 2
  assert.equal(pointAt(l, 600, gapY).page, 1);
  assert.equal(pointAt({ slots: [], k: 1 }, 0, 0), null);
  assert.deepEqual(placeOf(l, { page: 1, x: 0, y: 0 }), { x: l.slots[1].x, y: l.slots[1].y });
});

test('Multiple Pages fits its grid; the paint scale is device px per pt', () => {
  const z = fitZoom(pages(10), 1200, 900, 2, 1);
  const l = layoutPages(pages(10), z, 1200, 2);
  assert.ok(l.slots[0].h <= 900 - 2 * PAD + 1e-6);
  assert.ok(l.slots[1].x + l.slots[1].w <= 1200 - PAD + 1e-6);
  assert.equal(paintScale(PX_PER_PT * 1.25, 1.5), 2.5);
});

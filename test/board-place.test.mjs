// bd-instance (docs/plans/board/briefs/bd-instance.md): where a draft's pages go on a board, from the user's rules. Pure: the
// import grid, its footprint, the free spot beside what a board holds, and the attention point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attention, freeSpot, footprint, grid, GAP, PAD, ROW } from '../src/board/place.mjs';

const A4 = { w: 595, h: 842 };
const pages = (n) => Array.from({ length: n }, () => ({ ...A4 }));

test('the grid puts 12 pages in a row, 24 pt apart, the next row under the tallest', () => {
  const slots = grid(pages(14), { x: 0, y: 0 });
  assert.equal(ROW, 12);
  assert.equal(GAP, 24);
  assert.deepEqual(slots[11], { x: 11 * (595 + 24), y: 0 });
  assert.equal(slots[11].x, 6809);
  assert.deepEqual(slots[12], { x: 0, y: 842 + 24 });
  assert.equal(slots[12].y, 866);
});

test('the footprint of 14 A4 pages is 12 pages wide and two pages tall, with the gaps between', () => {
  assert.deepEqual(footprint(pages(14)), { w: 12 * 595 + 11 * 24, h: 842 + 24 + 842 });
  assert.deepEqual(footprint(pages(14)), { w: 7404, h: 1708 });
});

test('a free want is kept', () => {
  assert.deepEqual(freeSpot({ w: 100, h: 100 }, [], { x: 0, y: 0 }), { x: 0, y: 0 });
});

test('a covered want moves to the nearest free spot, PAD plus one step of the rect at most', () => {
  const size = { w: 100, h: 100 };
  const taken = [{ x: -50, y: -50, w: 100, h: 100 }]; // covers the want point
  const spot = freeSpot(size, taken, { x: 0, y: 0 });
  const clear = (p) => !taken.some((r) => p.x - PAD < r.x + r.w && r.x < p.x + size.w + PAD
    && p.y - PAD < r.y + r.h && r.y < p.y + size.h + PAD);
  assert.ok(clear(spot), `the spot ${JSON.stringify(spot)} is free`);
  assert.notDeepEqual(spot, { x: 0, y: 0 });
  // The nearest side it cleared, from the rect's edge.
  const gap = Math.max(spot.x - 50, -50 - (spot.x + size.w), spot.y - 50, -50 - (spot.y + size.h));
  assert.ok(gap <= PAD + 48, `the spot ${JSON.stringify(spot)} is ${gap} pt from the rect, within PAD plus one step`);
});

test('attention is the pointer inside the view and the view’s centre outside it', () => {
  const view = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(attention({ x: 200, y: 180 }, view), { x: 200, y: 180 });
  assert.deepEqual(attention({ x: 10, y: 10 }, view), { x: 300, y: 250 });
  assert.deepEqual(attention(null, view), { x: 300, y: 250 });
});

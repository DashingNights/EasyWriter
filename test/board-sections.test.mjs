// bd-section (docs/plans/board/briefs/bd-section.md, design section 6): a document's pages as a section. Pure: the page slots
// its keys name, the box round them and their reading order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grid } from '../src/board/place.mjs';
import { PAD, keyedSlots, readingOrder, sectionRect, slotsOf } from '../src/board/sections.mjs';

const A4 = { w: 595, h: 842 };
const pages = (n) => Array.from({ length: n }, () => ({ ...A4 }));

test('reading order runs each row left to right, from the page highest up', () => {
  const rects = [{ x: 0, y: 0, ...A4 }, { x: -200, y: 0, ...A4 }, { x: 1238, y: 0, ...A4 }];
  assert.deepEqual(readingOrder(rects), [1, 0, 2]);
});

test('a page joins a row only when more than half its height is in the row’s band', () => {
  const base = { x: 0, y: 0, ...A4 };
  // 342 of 842 over the band: a row of its own, after the first.
  assert.deepEqual(readingOrder([base, { x: -300, y: 500, ...A4 }]), [0, 1]);
  // 442 over the band: it joins the row, which runs left to right.
  assert.deepEqual(readingOrder([base, { x: -300, y: 400, ...A4 }]), [1, 0]);
});

test('a section’s box is its pages’ bounds plus PAD each way', () => {
  assert.equal(PAD, 32);
  assert.deepEqual(sectionRect([{ x: 0, y: 0, w: 100, h: 100 }]), { x: -32, y: -32, w: 164, h: 164 });
});

test('with no stored slots the pages take the import grid', () => {
  const item = { x: 0, y: 0, slots: null };
  assert.deepEqual(slotsOf(item, pages(14)), grid(pages(14), item));
});

test('a stored slot keeps its page; a page with no slot lands right of the one before it', () => {
  const item = { x: 0, y: 0, slots: { '7#0': [0, 0], '9#0': [700, 0] } };
  const three = [{ w: 100, h: 100 }, { w: 100, h: 100 }, { w: 100, h: 100 }];
  const slots = slotsOf(item, three, ['7#0', '8#0', '9#0']);
  assert.deepEqual(slots[1], { x: 124, y: 0 });
  assert.deepEqual(slots[2], { x: 700, y: 0 });
});

test('after a hard break adds a page inside a block the page after it keeps its slot', () => {
  const item = { x: 0, y: 0, slots: { '7#0': [0, 0], '9#0': [700, 0] } };
  const three = [{ w: 100, h: 100 }, { w: 100, h: 100 }, { w: 100, h: 100 }];
  const slots = slotsOf(item, three, ['7#0', '7#1', '9#0']);
  assert.deepEqual(slots[2], { x: 700, y: 0 });
});

test('a stored slot is relative to the item, so a move of x or y carries every page', () => {
  const pages = [{ w: 100, h: 100 }, { w: 100, h: 100 }];
  const slots = { '7#0': [0, 0], '9#0': [124, 0] };
  assert.deepEqual(slotsOf({ x: 100, y: 50, slots }, pages, ['7#0', '9#0']), [{ x: 100, y: 50 }, { x: 224, y: 50 }]);
  assert.deepEqual(slotsOf({ x: 130, y: 80, slots }, pages, ['7#0', '9#0']), [{ x: 130, y: 80 }, { x: 254, y: 80 }]);
});

test('a page’s slots are stored relative to the box its move writes', () => {
  const rects = [{ x: 100, y: 50, w: 10, h: 10 }, { x: 200, y: 50, w: 10, h: 10 }];
  assert.deepEqual(keyedSlots(rects, ['7#0', '9#0'], { x: 100, y: 50 }), { '7#0': [0, 0], '9#0': [100, 0] });
});

test('a page with no slot that would land on a stored page takes a free spot, and stored pages stay', () => {
  const three = [{ w: 100, h: 100 }, { w: 100, h: 100 }, { w: 100, h: 100 }];
  const slots = slotsOf({ x: 0, y: 0, slots: { '7#0': [0, 0], '9#0': [100, 0] } }, three, ['7#0', '8#0', '9#0']);
  const rects = three.map((p, k) => ({ ...slots[k], ...p }));
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!overlap(rects[1], rects[0]) && !overlap(rects[1], rects[2]), JSON.stringify(rects));
  assert.equal(slots[1].y, 0, 'the page stays in its row');
  assert.ok(slots[1].x > 100);
  assert.deepEqual(slots[0], { x: 0, y: 0 });
  assert.deepEqual(slots[2], { x: 100, y: 0 });
});

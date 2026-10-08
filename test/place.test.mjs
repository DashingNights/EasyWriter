import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeRibbon } from '../src/app/components/board/place.mjs';

const rect = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });
const view = rect(300, 100, 1000, 800); // visible area: x 300…1300, y 100…900
const size = { w: 400, h: 42 };

// The ribbon box never overlaps the 12 px handle squares at the item's corners and stays inside the view.
function check(item, p) {
  const box = rect(p.x, p.y, size.w, size.h);
  for (const hx of [item.left, item.right]) {
    for (const hy of [item.top, item.bottom]) {
      const overlap = box.left < hx + 6 && box.right > hx - 6 && box.top < hy + 6 && box.bottom > hy - 6;
      assert.ok(!overlap, `covers the handle at ${hx},${hy}`);
    }
  }
  assert.ok(box.left >= view.left && box.right <= view.right && box.top >= view.top && box.bottom <= view.bottom, 'inside the view');
}

test('above the item, left-aligned, when there is room', () => {
  const item = rect(500, 400, 200, 100);
  const p = placeRibbon(item, size, view);
  assert.deepEqual(p, { x: 500, y: 400 - 12 - 42 });
  check(item, p);
});

test('below the item when there is no room above', () => {
  const item = rect(500, 120, 200, 100);
  const p = placeRibbon(item, size, view);
  assert.deepEqual(p, { x: 500, y: 220 + 12 });
  check(item, p);
});

test('kept inside the view horizontally', () => {
  const item = rect(1200, 400, 300, 100); // runs past the right edge
  const p = placeRibbon(item, size, view);
  assert.equal(p.x, 1300 - 8 - 400);
  check(item, p);
  assert.equal(placeRibbon(rect(100, 400, 100, 100), size, view).x, 308);
});

// The corner handles of `item` as rects (what the ribbon gets to avoid).
const handles = (item) => [item.left, item.right].flatMap((hx) => [item.top, item.bottom].map((hy) => rect(hx - 6, hy - 6, 12, 12)));

test('tall item: pinned where it covers no handle', () => {
  // Top handles visible just below the view top, bottom handles just above the view bottom, item wider than the ribbon.
  const item = rect(320, 130, 900, 740);
  const p = placeRibbon(item, size, view, handles(item));
  check(item, p);
  // Narrow tall item: beside it.
  const narrow = rect(600, 110, 100, 780);
  const q = placeRibbon(narrow, size, view, handles(narrow));
  assert.deepEqual(q, { x: 712, y: 110 });
  check(narrow, q);
});

test('after a pointer selection: the left edge at the pointer, above the chrome box, else below it, else beside it', () => {
  const box = rect(500, 400, 200, 100); // the selection's chrome box (handles, rotate handle, dots included)
  const at = { x: 583, y: 450 }; // the ribbon's left edge, the pointer's y
  assert.deepEqual(placeRibbon(box, size, view, handles(box), at), { x: 583, y: 400 - 12 - 42 });
  assert.deepEqual(placeRibbon(box, size, view, handles(box), { x: 520 }), { x: 520, y: 400 - 12 - 42 }); // keyboard: the item's left
  const top = rect(500, 120, 200, 100); // near the top of the view: below
  assert.deepEqual(placeRibbon(top, size, view, handles(top), at), { x: 583, y: 220 + 12 });
  const tall = rect(500, 120, 200, 760); // taller than the view allows: beside, centred on the pointer
  assert.deepEqual(placeRibbon(tall, size, view, handles(tall), at), { x: 712, y: 450 - 21 });
  const huge = rect(0, 0, 2000, 2000); // handles out of view: right above the pointer
  assert.deepEqual(placeRibbon(huge, size, view, handles(huge), at), { x: 583, y: 450 - 12 - 42 });
});

test('never over an avoided bar (the canvas edit bar): below the item instead', () => {
  const item = rect(500, 400, 200, 100);
  const bar = rect(600, 330, 300, 30); // where the ribbon above the item would go
  const p = placeRibbon(item, size, view, [bar]);
  assert.deepEqual(p, { x: 500, y: 500 + 12 });
  check(item, p);
});

test('item larger than the view: top-left of the view', () => {
  const item = rect(0, 0, 2000, 2000);
  assert.deepEqual(placeRibbon(item, size, view), { x: 308, y: 108 });
});

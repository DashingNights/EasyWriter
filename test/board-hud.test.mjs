// bd-hud (docs/plans/board/briefs/bd-hud.md): the board's focus rules. Values are the brief's and the user's rule (a document
// counts at a quarter of the view), never this code's own output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toScreen } from '../src/engine/view/camera.mjs';
import { FORMATS } from '../src/formats.mjs';
import { QUARTER, counts, coverage, homeCamera, homePoint, hudOf } from '../src/board/hud.mjs';

const VIEW = { x: 0, y: 0, w: 1000, h: 1000 };

test('coverage sums the pages inside the view over its area', () => {
  assert.equal(coverage([{ x: -250, y: 0, w: 500, h: 500 }], VIEW), 0.125);
  assert.equal(coverage([{ x: 0, y: 0, w: 500, h: 500 }], VIEW), 0.25);
  assert.equal(coverage([{ x: 0, y: 0, w: 2000, h: 2000 }], VIEW), 1);
  assert.equal(coverage([], VIEW), 0);
});

test('a document counts at a quarter of the view', () => {
  assert.equal(QUARTER, 0.25);
  assert.equal(counts([{ x: 0, y: 0 }], [{ w: 500, h: 500 }], VIEW), true);
  assert.equal(counts([{ x: 0, y: 0 }], [{ w: 499, h: 500 }], VIEW), false);
});

test('homePoint takes the page under the cursor at the cursor', () => {
  const docs = [{ id: 'a', rects: [
    { x: 0, y: 0, w: 400, h: 500, page: 0 },
    { x: 500, y: 0, w: 400, h: 500, page: 1 },
    { x: 1000, y: 0, w: 400, h: 500, page: 2 },
  ] }];
  assert.deepEqual(homePoint({ x: 1100, y: 120 }, docs, VIEW), { doc: 'a', page: 2, x: 1100, y: 120 });
});

test('homePoint off every page takes the page whose centre is nearest the view centre', () => {
  const docs = [{ id: 'a', rects: [
    { x: -2000, y: 0, w: 400, h: 500, page: 0 },
    { x: 100, y: 100, w: 400, h: 500, page: 1 },
    { x: 3000, y: 0, w: 400, h: 500, page: 2 },
  ] }];
  // The view's centre (500, 500) is nearest page 1's centre (300, 350); it lies on that page, so the point is the centre.
  assert.deepEqual(homePoint({ x: 20, y: 20 }, docs, VIEW), { doc: 'a', page: 1, x: 500, y: 500 });
  assert.equal(homePoint({ x: 20, y: 20 }, [], VIEW), null);
  assert.equal(homePoint(null, [{ id: 'a', rects: [{ x: 5000, y: 0, w: 100, h: 100, page: 0 }] }], VIEW), null);
});

test('homeCamera puts the point at the view centre', () => {
  const view = { ...VIEW, pxW: 1000, pxH: 800 };
  const point = { x: 1234, y: -56 };
  const cam = homeCamera(point, 500, view, 1);
  const at = toScreen(cam, point);
  assert.ok(Math.abs(at.x - 500) <= 0.5 && Math.abs(at.y - 400) <= 0.5, JSON.stringify(at));
});

test('homeCamera never drops below the current zoom: the cap of 2 limits only a raise', () => {
  const view = { ...VIEW, pxW: 1000, pxH: 800 };
  assert.equal(homeCamera({ x: 0, y: 0 }, 2000, view, 0.5).zoom, 0.5); // fit is under the current zoom
  assert.equal(homeCamera({ x: 0, y: 0 }, 100, view, 1).zoom, 2); // fit is over the cap
  assert.equal(homeCamera({ x: 0, y: 0 }, 500, view, 3).zoom, 3); // the current zoom wins over the cap
});

test('hudOf takes the most verbose format, a tie going to the focus', () => {
  assert.equal(hudOf('forum-post', ['forum-post', 'document'], FORMATS), 'document');
  assert.equal(hudOf('forum-post', ['forum-post'], FORMATS), 'forum-post');
  assert.equal(hudOf('document', ['document', 'forum-post'], FORMATS), 'document');
  assert.equal(hudOf(null, ['document'], FORMATS), null);
});

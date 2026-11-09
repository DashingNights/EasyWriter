// engine-view: the viewport's pure modules (src/engine/view camera, placements, tiles, focus) and the Documents host's world
// placements (src/document/canvas/layout.mjs placePages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, fitRect, keepPoint, MAX_COLUMN_PX, toScreen, toWorld, zoomAbout } from '../src/engine/view/camera.mjs';
import { bounds, hit, nearest, visible, worldOf } from '../src/engine/view/placements.mjs';
import { BUDGET, damaged, keyOf, plan, rough, scaleOf, standIn, TILE, tileRect, tilesIn, wanted, weight } from '../src/engine/view/tiles.mjs';
import { createFocus, nextSession } from '../src/engine/view/focus.js';
import { GAP, layoutPages, PAD, placePages } from '../src/document/canvas/layout.mjs';

const LETTER = { w: 612, h: 792 };
const pages = (n) => Array.from({ length: n }, () => LETTER);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('screen and world points map both ways, and a zoom about an anchor keeps its world point', () => {
  const cam = { x: 100, y: 2000, zoom: 1.5 };
  const w = toWorld(cam, { x: 300, y: 200 });
  near(w.x, 100 + 300 / 2);
  assert.deepEqual(toScreen(cam, w), { x: 300, y: 200 });
  const z = zoomAbout(cam, 3, { x: 300, y: 200 });
  const after = toWorld(z, { x: 300, y: 200 });
  near(after.x, w.x);
  near(after.y, w.y);
  assert.equal(z.zoom, 3);
});

test('the zoom clamp holds the range and keeps a column under Chromium\'s layout limit', () => {
  assert.equal(clampZoom(7, { min: 0.1, max: 5 }), 5);
  assert.equal(clampZoom(0.01, { min: 0.1, max: 5 }), 0.1);
  // The Word fixture's column (1,099,486 px at 100 %) stays unclamped at 500 %.
  assert.equal(clampZoom(5, { min: 0.1, max: 5 }, { w: 700, h: 1099486 * 0.75 }), 5);
  // A column ten times as tall is held below MAX_COLUMN_PX, and the limit wins over the range's minimum.
  const tall = { w: 700, h: 10 * 1099486 * 0.75 };
  const z = clampZoom(5, { min: 0.1, max: 5 }, tall);
  assert.ok(z < 5 && tall.h * z * 4 / 3 <= MAX_COLUMN_PX + 1e-6);
  assert.ok(clampZoom(1, { min: 4 }, { w: 1, h: 1e8 }) < 1);
});

test('fitRect centres a world rect in the view at the zoom that fits it', () => {
  const cam = fitRect({ x: 0, y: 0, w: 612, h: 792 }, { w: 1000, h: 800 }, 20);
  near(cam.zoom, 760 / (792 * 4 / 3));
  const c = toScreen(cam, { x: 306, y: 396 });
  near(c.x, 500, 1e-6);
  near(c.y, 400, 1e-6);
});

test('placements: bounds, the band in view, the topmost hit and the nearest surface point', () => {
  const list = [
    { key: 'a', session: 's', surface: 0, x: 0, y: 0, w: 100, h: 100 },
    { key: 'b', session: 's', surface: 1, x: 50, y: 50, w: 100, h: 100 },
    { key: 'c', session: 't', surface: 0, x: 0, y: 300, w: 100, h: 100 },
  ];
  assert.deepEqual(bounds(list), { x: 0, y: 0, w: 150, h: 400 });
  assert.deepEqual(visible(list, { x: 0, y: 160, w: 10, h: 10 }), []);
  assert.deepEqual(visible(list, { x: 0, y: 140, w: 10, h: 200 }).map((p) => p.key), ['c']);
  const h = hit(list, { x: 60, y: 60 });
  assert.equal(h.placement.key, 'b'); // later is above
  assert.deepEqual([h.x, h.y], [10, 10]);
  assert.equal(hit(list, { x: 120, y: 250 }), null);
  // The gap lands on the nearest surface, clamped to it.
  assert.deepEqual(nearest(list, { x: 30, y: 200 }), { session: 's', surface: 1, x: 0, y: 100 });
  assert.deepEqual(worldOf(list, { session: 't', page: 0, x: 5, y: 6 }), { x: 5, y: 306 });
  assert.equal(worldOf(list, { session: 'x', surface: 0, x: 0, y: 0 }), null);
});

test('Documents placements are layoutPages in world points: centred in the view, gap fixed in points, pad fixed in px', () => {
  for (const zoom of [0.5, 1, 2]) {
    const l = layoutPages(pages(3), zoom, 800); // one page a row at each zoom
    const { placements, extent } = placePages(pages(3), zoom, 800, 0, 'd1');
    placements.forEach((p, i) => {
      near(p.x * l.k, l.slots[i].x, 1e-9);
      near(p.y * l.k, l.slots[i].y, 1e-9);
      assert.equal(p.w, 612);
      assert.equal(p.session, 'd1');
    });
    near(placements[1].y - placements[0].y - 792, GAP * 0.75, 1e-9);
    near(placements[0].y * l.k, PAD, 1e-9);
    near(extent.h * l.k, l.height, 1e-6);
  }
  // Centred in the view the column is given, never in anything wider.
  const { placements } = placePages(pages(1), 1, 1000);
  near(placements[0].x * 4 / 3 + 816 / 2, 1000 / 2, 1e-9);
});

test('a zoom keeps the page point under the pointer across the relayout it causes', () => {
  const before = placePages(pages(20), 1, 1200).placements;
  const cam = { x: 0, y: 5000, zoom: 1 };
  const anchor = { x: 640, y: 300 };
  const p0 = nearest(before, toWorld(cam, anchor));
  const after = placePages(pages(20), 2, 1200).placements;
  const next = keepPoint(before, cam, after, 2, anchor);
  const p1 = nearest(after, toWorld(next, anchor));
  assert.equal(p1.surface, p0.surface);
  near(p1.x, p0.x, 1e-6);
  near(p1.y, p0.y, 1e-6);
});

test("the tile scale is the zoom's own, and tiles cover a surface edge to edge", () => {
  // 100 % is 4/3 px a point: a scale rounded to 1/64 would stretch every tile and blur its text.
  near(scaleOf(1, 1), 4 / 3, 1e-6);
  assert.equal(scaleOf(1, 1), scaleOf(1, 1));
  assert.equal(scaleOf(1.25, 1.5), 2.5);
  const p = { session: 's', surface: 2, x: 0, y: 0, w: 612, h: 792 };
  const all = tilesIn(p, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }, 2); // 1,224 x 1,584 device px
  assert.equal(all.length, 3 * 4);
  const last = all.at(-1);
  assert.deepEqual(tileRect(last), { x: 512, y: 768, w: 100, h: 24 });
  assert.equal(new Set(all.map(keyOf)).size, all.length);
  assert.notEqual(keyOf({ ...last, opts: 1 }), keyOf(last)); // paint options re-key
});

test('wanted tiles: the visible ones nearest the focus first, then the ring and the next view in the scroll direction', () => {
  const list = placePages(pages(10), 1, 1000).placements;
  const scale = 1; // a 512 pt tile
  const view = { x: 0, y: 1000, w: 750, h: 600 };
  const plain = wanted(list, view, scale);
  const vis = plain.filter((t) => t.visible);
  assert.ok(vis.length > 0 && plain.length > vis.length, 'a ring past the visible tiles');
  assert.ok(plain.findIndex((t) => !t.visible) === vis.length, 'visible first');
  const focus = { x: list[1].x + 600, y: list[1].y + 700 };
  const first = wanted(list, view, scale, { focus })[0];
  assert.equal(first.surface, 1);
  assert.deepEqual([first.col, first.row], [1, 1]);
  const down = wanted(list, view, scale, { dir: { x: 0, y: 1 } });
  const below = (ts) => ts.filter((t) => list[t.surface].y + tileRect(t).y >= view.y + view.h + 512).length;
  assert.ok(below(down) > below(plain), 'the next view down joins the wish list');
});

test('tile plan: fresh tiles show, missing ones are needed and borrow stale tiles, covered stale tiles go, the budget holds', () => {
  const p = { session: 's', surface: 0, x: 0, y: 0, w: 612, h: 792 };
  const view = { x: 0, y: 0, w: 612, h: 792 };
  const at = (scale) => wanted([p], view, scale, { ring: 0 });
  const hold = (tiles, extra = {}) => new Map(tiles.map((t, i) => [t.key, { ...t, used: i, ...extra }]));

  // Zoomed from scale 1 to 2: nothing at 2 yet, so every old tile shows stretched and every new tile is needed.
  const old = hold(at(1));
  const want2 = at(2);
  let r = plan(old, want2);
  assert.equal(r.need.length, want2.length);
  assert.deepEqual(new Set(r.show), new Set(old.keys()));
  assert.deepEqual(r.drop, []);

  // Half the new tiles landed: old tiles they fully cover go, those still borrowed stay.
  const held = new Map([...old, ...hold(want2.slice(0, 6))]);
  r = plan(held, want2);
  assert.equal(r.need.length, want2.length - 6);
  for (const k of r.drop) assert.equal(held.get(k).scale, 1);
  assert.ok(r.drop.length > 0 && r.drop.every((k) => !r.show.includes(k)));

  // A dirty tile shows its old pixels and is needed again.
  const all2 = hold(want2);
  all2.get(want2[0].key).dirty = true;
  r = plan(all2, want2);
  assert.deepEqual(r.need.map((t) => t.key), [want2[0].key]);
  assert.ok(r.show.includes(want2[0].key));

  // Over the budget (counted in full tiles' pixels): unwanted tiles go first, least recently shown first; shown tiles never go.
  const far = { ...p, surface: 1 };
  const spare = tilesIn(far, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }, 2).map((t) => ({ ...t, key: keyOf(t) }));
  const crowd = new Map([...hold(want2, { used: 100 }), ...hold(spare)]);
  const page = want2.reduce((a, t) => a + weight(t), 0);
  r = plan(crowd, want2, page + 2);
  let over = page + spare.reduce((a, t) => a + weight(t), 0) - (page + 2);
  const gone = [];
  for (const t of spare) {
    if (over <= 0) break;
    gone.push(t.key);
    over -= weight(t);
  }
  assert.ok(gone.length > 0 && gone.length < spare.length);
  assert.deepEqual(r.drop, gone);
  assert.equal(BUDGET, 72);
  assert.equal(TILE, 512);
});

test('rough tiles: a quarter-scale tile stands in for the visible tiles with nothing to show, and only for them', () => {
  const p = { session: 's', surface: 0, x: 0, y: 0, w: 612, h: 792 };
  const want = wanted([p], { x: 0, y: 0, w: 400, h: 300 }, 8 / 3, { ring: 0 }); // 200 %: 1,632 x 2,112 px, 4 x 5 tiles
  const vis = want.filter((t) => t.visible);
  const low = rough(new Map(), want);
  assert.ok(low.length >= 1 && low.every((t) => !t.visible && Math.abs(t.scale - 2 / 3) < 1e-6), 'a quarter of the scale');
  const held = new Map(low.map((t) => [t.key, t]));
  assert.ok(vis.every((t) => standIn(held, t)), 'they cover every visible tile');
  assert.deepEqual(rough(held, want), [], 'none once a stand-in shows');
  const own = new Map(vis.map((t) => [t.key, t]));
  assert.deepEqual(rough(own, want), [], 'none once the tiles themselves are held');
  const tenth = wanted([p], { x: 0, y: 0, w: 612, h: 792 }, 0.15, { ring: 0 }); // the page in one tile
  assert.deepEqual(rough(new Map(), tenth), [], 'none for a surface one tile holds');
});

test("a tile counts by its share of a full tile's pixels, so a page at 10 % costs a sliver of the budget", () => {
  const p = { session: 's', surface: 0, x: 0, y: 0, w: 612, h: 792 };
  const at2 = tilesIn(p, { x: 0, y: 0, w: 612, h: 792 }, 2); // 1,224 x 1,584 device px
  assert.equal(weight(at2[0]), 1);
  near(weight(at2.at(-1)), (200 * 48) / (512 * 512), 1e-9);
  near(at2.reduce((a, t) => a + weight(t), 0), (1224 * 1584) / (512 * 512), 1e-9);
  const small = tilesIn(p, { x: 0, y: 0, w: 612, h: 792 }, scaleOf(0.1, 1));
  assert.equal(small.length, 1);
  assert.ok(weight(small[0]) < 0.04);
  // 300 such pages in view all fit the budget, where counting tiles would hold 128.
  const many = placePages(pages(300), 0.1, 2000).placements;
  const view = { x: 0, y: 0, w: 1e6, h: 1e6 };
  const want = wanted(many, view, scaleOf(0.1, 1), { ring: 0 });
  assert.equal(want.length, 300);
  assert.equal(plan(new Map(), want).need.length, 300);
});

test('layout damage marks the tiles it meets', () => {
  const p = { session: 's', surface: 0, x: 0, y: 0, w: 612, h: 792 };
  const held = new Map(tilesIn(p, { x: 0, y: 0, w: 612, h: 792 }, 1).map((t) => [keyOf(t), t]));
  assert.deepEqual(damaged(held, [{ session: 's', page: 0, x: 10, y: 600, w: 5, h: 5 }]), [keyOf({ ...p, scale: 1, col: 0, row: 1 })]);
  assert.deepEqual(damaged(held, [{ session: 'other', surface: 0, x: 10, y: 600, w: 5, h: 5 }]), []);
});

test('focus: a change reaches the mirror once, and Tab cycles the sessions shown', () => {
  const heard = [];
  const f = createFocus((x) => heard.push(x));
  f.set({ session: 'a' });
  f.set({ session: 'a', mode: 'text' });
  f.set(null);
  assert.deepEqual(heard, [{ session: 'a', mode: 'text' }, { session: null, mode: null }]);
  const list = [{ session: 'a' }, { session: 'a' }, { session: 'b' }, { session: 'c' }];
  assert.equal(nextSession(list, 'a'), 'b');
  assert.equal(nextSession(list, 'c'), 'a');
  assert.equal(nextSession(list, 'a', -1), 'c');
  assert.equal(nextSession(list, null), 'a');
  assert.equal(nextSession([], 'a'), null);
});

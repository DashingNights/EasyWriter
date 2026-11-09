// bd-connect (docs/plans/board/briefs/bd-connect.md): a connector's derived geometry, its freeform, its labels, its placement
// and the transforms the generic pointer path may ask it for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import { legacyOf, patchOf, textStory } from '../src/board/look.mjs';
import { placementsOf, registerType } from '../src/board/surfaces.mjs';
import connect, { routeOf, rule } from '../src/board/tools/connect.js';

registerType('connector', rule); // the app registers it on mount; the placement read needs it here

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);
const PT = 4 / 3; // board px per point: the default 14 px label size is 10.5 pt

/** A board with a box at the origin, one 300 pt right, and a straight connector between their sides. */
function board({ from = [1, 0.5], to = [0, 0.5], bx = 300, by = 0, heads = { start: 'none', end: 'none' }, labels = {}, end = null } = {}) {
  const store = new BoardStore(blankBoard(), { client: 'test' });
  const ids = {};
  store.change('Add', (tx) => {
    ids.a = tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'A'], x: 0, y: 0, w: 100, h: 60 });
    ids.b = tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'B'], x: bx, y: by, w: 100, h: 60 });
    ids.c = tx.create({ type: 'connector', at: [null, 'C'], from: { item: ids.a, anchor: from },
      to: end ?? { item: ids.b, anchor: to }, route: 'straight', corner: 8, points: [], heads, color: [0, 0, 0], width: 1.5,
      dash: 'solid', jump: 'none', labels });
  });
  return { store, ids };
}

test('a right port to a left port routes edge to edge, one straight run in a box that starts at its first point', () => {
  const { store, ids } = board();
  const f = routeOf(store.get(ids.c), store);
  const pts = f.freeform.paths[0].pts;
  assert.deepEqual(pts.length, 2);
  assert.equal(pts[0][0], 0, 'the first point is the box\'s left edge');
  near(f.x, 100, 0.1); // the first box's right side
  near(f.x + f.w, 300, 0.1); // the second box's left side
  assert.deepEqual([f.kind, f.fill], ['freeform', null]);
  assert.deepEqual(f.stroke, [0, 0, 0]);
  assert.equal(f.strokeWidth, 1.5);
  assert.equal(f.extra.dash, 'solid');
});

test('moving an end writes nothing on the connector, and the derived box grows by the move', () => {
  const { store, ids } = board();
  const before = routeOf(store.get(ids.c), store);
  const stored = JSON.stringify(store.get(ids.c));
  store.change('Move', (tx) => tx.set(ids.b, 'x', 400));
  const after = routeOf(store.get(ids.c), store);
  assert.equal(JSON.stringify(store.get(ids.c)), stored, 'the connector stores only the route\'s inputs');
  near(after.w - before.w, 100, 0.1); // route.mjs rounds its path to a tenth of a px
});

test('two stores, one moving each end, merge both ways to the same geometry', () => {
  const { store, ids } = board();
  const base = JSON.stringify(store.toJSON());
  const s1 = new BoardStore(JSON.parse(base));
  const s2 = new BoardStore(JSON.parse(base));
  s1.change('Move', (tx) => tx.set(ids.a, 'x', 40));
  s2.change('Move', (tx) => tx.set(ids.b, 'y', 40));
  s1.merge(s2);
  s2.merge(s1);
  assert.deepEqual(routeOf(s1.get(ids.c), s1), routeOf(s2.get(ids.c), s2));
});

test('a connector is placed by its derived box, not by a stored x and y', () => {
  const { store, ids } = board();
  const surfaces = { handleOf: () => 1, stampOf: () => ({ ox: 0, oy: 0, w: 10, h: 10 }) };
  const placed = placementsOf(store, surfaces, 'board:test', {}).find((p) => p.key === ids.c);
  const d = routeOf(store.get(ids.c), store);
  assert.ok(placed, 'the connector has a placement');
  near(placed.x, d.x);
  near(placed.y, d.y);
});

test('a filled head adds one closed path and fills the line with it', () => {
  const { store, ids } = board({ heads: { start: 'none', end: 'triangle' } });
  const f = routeOf(store.get(ids.c), store);
  const paths = f.freeform.paths;
  assert.equal(paths.length, 2, 'the shaft and the head');
  assert.equal(paths[0].closed, false);
  assert.equal(paths[1].closed, true);
  assert.deepEqual(f.fill, [0, 0, 0]);
});

test('a middle label gives one labelAt entry, and its boxes stay in the frame', () => {
  const { store, ids } = board({ labels: { mid: textStory('Yes') } });
  const f = routeOf(store.get(ids.c), store);
  assert.deepEqual(Object.keys(f.labelAt), ['mid']);
  const at = f.labelAt.mid;
  assert.ok(at.w > 0 && at.h > 0);
  assert.ok(at.x - at.w / 2 >= -0.01 && at.x + at.w / 2 <= f.w + 0.01, 'the label lies inside the connector box');
});

test('a label\'s text fits its box with the text box insets, wide characters one em', () => {
  const { store, ids } = board({ labels: { mid: textStory('Yes') } });
  const size = 14 / PT; // the old form's 14 px default, in points
  const latin = routeOf(store.get(ids.c), store).labelAt.mid;
  assert.ok(latin.w - 14.4 >= 3 * 0.6 * size, 'Yes fits on one line');
  assert.ok(latin.h - 7.2 >= size * 1.3 - 0.01);
  store.change('Label', (tx) => tx.set(ids.c, 'labels', { mid: textStory('你好嗎') }));
  const wide = routeOf(store.get(ids.c), store).labelAt.mid;
  assert.ok(wide.w - 14.4 >= 3 * size, 'three wide characters fit on one line');
  assert.ok(wide.w - 14.4 > 3 * 0.6 * size, 'they are wider than three narrow ones');
});

test('a vertical connector keeps a width above zero, its stroke', () => {
  const { store, ids } = board({ from: [0.5, 1], to: [0.5, 0], bx: 0, by: 200 });
  const f = routeOf(store.get(ids.c), store);
  assert.ok(f.w > 0);
  near(f.w, 1.5, 1e-6);
});

test('the panel\'s old-form label maps back to the same story: ticking keeps the text', () => {
  const { store, ids } = board();
  store.change('Label', (tx) => tx.set(ids.c, 'labels', { mid: textStory('Yes') }));
  const item = store.get(ids.c);
  const legacy = legacyOf(item);
  assert.ok(legacy.labels.mid, 'the row reads as ticked');
  assert.match(legacy.labels.mid.html, /Yes/);
  const back = patchOf(item, { labels: { mid: legacy.labels.mid } });
  assert.equal(back.labels.mid.blocks[0].text, 'Yes');
});

test('a drag preview routes on its own, even while line jumps cache the board\'s connectors', () => {
  const { store, ids } = board({ heads: { start: 'none', end: 'arrow' } });
  store.change('Jump', (tx) => tx.set(ids.c, 'jump', 'arc'));
  const stored = routeOf(store.get(ids.c), store); // fills the cache at this clock
  const temp = { ...store.get(ids.c), to: { x: 200, y: 160 } };
  const preview = routeOf(temp, store);
  assert.ok(Math.abs(preview.h - stored.h) > 10, 'the preview follows the dragged end');
});

test('the pointer path cannot resize, turn or flip a connector, and a move carries only free ends and points', () => {
  const { store, ids } = board({ end: { x: 200, y: 100 } });
  store.change('Points', (tx) => tx.set(ids.c, 'points', [{ x: 150, y: 100 }]));
  const ctx = { store };
  const fields = { [ids.c]: { x: 1, y: 2, w: 3, h: 4, rot: 45, flipX: true } };
  assert.deepEqual(connect.transform(ctx, [ids.c], { kind: 'resize', fields }), []);
  assert.deepEqual(connect.transform(ctx, [ids.c], { kind: 'rotate', fields }), []);
  assert.deepEqual(connect.transform(ctx, [ids.c], { kind: 'flip', fields }), []);
  const [pair] = connect.transform(ctx, [ids.c], { kind: 'move', delta: { dx: 10, dy: 20 }, fields });
  const written = pair[1];
  assert.equal(written.to.x, 210);
  assert.equal(written.to.y, 120);
  assert.deepEqual(written.points, [{ x: 160, y: 120 }]);
  assert.equal(written.from, undefined, 'a bound end stays on its shape');
  assert.equal(written.x, undefined);
});

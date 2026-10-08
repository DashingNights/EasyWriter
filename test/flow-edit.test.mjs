import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPoints, dragSegment, labelSlotAt, midHandles, pickInDirection, reverseConnector, sideToward } from '../src/flow/edit.mjs';
import { resolveConnectors } from '../src/flow/route.mjs';
import { portNormal } from '../src/flow/shapes.mjs';

const rect = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 100, h: 60, width: 2, ...extra });
const A = rect('a', 0, 0);
const B = rect('b', 400, 200);
const conn = (extra = {}) => ({ id: 'k', type: 'connector', from: { item: 'a', anchor: [1, 0.5] }, to: { item: 'b', anchor: [0, 0.5] },
  route: 'ortho', heads: { start: 'none', end: 'arrow' }, width: 2, points: [], labels: {}, ...extra });
const route = (c) => {
  const { items, geo } = resolveConnectors([A, B, c]);
  return { c: items.find((i) => i.id === 'k'), g: geo.get('k') };
};
const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6;

test('labelSlotAt: start below 0.25, end above 0.75, mid between', () => {
  assert.deepEqual([0, 0.24, 0.25, 0.5, 0.75, 0.76, 1].map(labelSlotAt), ['start', 'start', 'mid', 'mid', 'mid', 'end', 'end']);
});

test('reverseConnector keeps every label at its board position and swaps ends, heads and waypoints', () => {
  const labels = { start: { html: '1', t: 0.15, dx: 0, dy: -10 }, mid: { html: 'yes', t: 0.4, dx: 5, dy: 0 }, end: { html: 'n', t: 0.9, dx: 0, dy: 0 } };
  const c = conn({ route: 'straight', points: [{ x: 250, y: 30 }], heads: { start: 'circle', end: 'triangle' }, labels });
  const before = route(c).c;
  const r = reverseConnector(c);
  assert.deepEqual([r.from, r.to, r.heads, r.points], [c.to, c.from, { start: 'triangle', end: 'circle' }, c.points]);
  const after = route(r).c;
  assert.deepEqual(Object.keys(after.labels).sort(), ['end', 'mid', 'start']);
  const abs = (k, s) => ({ x: k.x + k.lps[s].x, y: k.y + k.lps[s].y });
  for (const [s, t] of [['start', 'end'], ['mid', 'mid'], ['end', 'start']]) {
    const [p, q] = [abs(before, s), abs(after, t)];
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 0.2, `${s}: ${JSON.stringify([p, q])}`);
    assert.equal(after.labels[t].html, before.labels[s].html);
  }
});

test('dragSegment: the dragged inner segment of a Z route moves, the route passes through the new corners', () => {
  const { g } = route(conn());
  const handles = midHandles('ortho', g.pts, []);
  assert.equal(handles.length, 1, JSON.stringify(g.pts)); // the vertical middle of the Z; the stubs move with the ends
  const { k, dir } = handles[0];
  assert.equal(dir, 'v');
  const points = dragSegment([], g.pts, k, { x: 60, y: 0 });
  assert.equal(points.length, 2);
  assert.ok(near(points[0], { x: g.pts[k].x + 60, y: g.pts[k].y }) && near(points[1], { x: g.pts[k + 1].x + 60, y: g.pts[k + 1].y }));
  const moved = route(conn({ points })).g;
  const xs = moved.pts.slice(1, -1).map((p) => p.x);
  assert.ok(xs.includes(g.pts[k].x + 60) && !xs.includes(g.pts[k].x), JSON.stringify(moved.pts));
  // Dragged again: the existing corner waypoints move, none are added.
  const again = dragSegment(points, moved.pts, moved.pts.findIndex((p) => near(p, points[0])), { x: -20, y: 0 });
  assert.deepEqual(again.map((p) => p.x), [points[0].x - 20, points[1].x - 20]);
});

test('midHandles on straight / curve: one per stretch between control points, on the path', () => {
  const c = conn({ route: 'straight', points: [{ x: 250, y: 30 }] });
  const { g } = route(c);
  const h = midHandles('straight', g.pts, c.points);
  assert.deepEqual(h.map((m) => m.k), [0, 1]);
  assert.ok(near(h[0], { x: (g.pts[0].x + 250) / 2, y: (g.pts[0].y + 30) / 2 }), JSON.stringify(h[0]));
});

test('cleanPoints drops waypoints on the line between their neighbours, keeps corners', () => {
  const ends = [{ x: 0, y: 0 }, { x: 200, y: 100 }];
  assert.deepEqual(cleanPoints([{ x: 100, y: 51 }], ends), []);
  assert.deepEqual(cleanPoints([{ x: 200, y: 0 }], ends), [{ x: 200, y: 0 }]);
  assert.deepEqual(cleanPoints([{ x: 100, y: 0 }, { x: 150, y: 1 }], [{ x: 0, y: 0 }, { x: 200, y: 0 }]), []);
});

test('pickInDirection: the smallest angle off the direction, then the nearest; nothing behind', () => {
  const c = { x: 0, y: 0 };
  const cands = [{ id: 'far', x: 300, y: 0 }, { id: 'near', x: 100, y: 0 }, { id: 'skew', x: 100, y: 60 }, { id: 'up', x: 0, y: -100 }];
  assert.equal(pickInDirection(c, cands, 'e'), 'near');
  assert.equal(pickInDirection(c, cands, 'n'), 'up');
  assert.equal(pickInDirection(c, cands, 'w'), null);
});

test('sideToward: the side facing a board direction, also on a turned shape', () => {
  assert.equal(sideToward((a) => portNormal(A, a), 'e'), 'e');
  assert.equal(sideToward((a) => portNormal({ ...A, rot: 90 }, a), 's'), 'e'); // east turned 90° faces down
});

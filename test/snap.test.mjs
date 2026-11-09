import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_HOLD, EDGE_RAMP, edgeHold, guides, linesOf, snap } from '../src/flow/snap.mjs';

const item = (id, x, y, w, h) => ({ id, x, y, w, h });
const ALL = { x: [0, 1, 2], y: [0, 1, 2] };
const query = (box, targets, extra = {}) => ({ box, lines: ALL, targets, frame: null, tol: 6, sticky: 0, spacing: false, grid: 0, prev: null, ...extra });
const moved = (box, hits) => ({ ...box, x: box.x + (hits.x?.d ?? 0), y: box.y + (hits.y?.d ?? 0) });
const count = (gs, type) => gs.filter((g) => g.type === type).length;

test('linesOf: start, centre and end on each axis', () => {
  assert.deepEqual(linesOf({ x: 10, y: 20, w: 30, h: 40 }, 'x'), [10, 25, 40]);
  assert.deepEqual(linesOf({ x: 10, y: 20, w: 30, h: 40 }, 'y'), [20, 40, 60]);
});

test('edge to edge: the moving edge lands exactly on the target edge', () => {
  const hits = snap(query({ x: 203.25, y: 500, w: 100, h: 60 }, [item('a', 100, 0, 100.5, 60)]));
  assert.deepEqual(hits, { x: { d: -2.75, at: 200.5, cls: 'edge', line: 0, target: 'a', tline: 2 }, y: null });
});

test('centre to centre', () => {
  const hits = snap(query({ x: 34, y: 200, w: 40, h: 40 }, [item('a', 0, 0, 100, 60)]));
  assert.deepEqual(hits.x, { d: -4, at: 50, cls: 'centre', line: 1, target: 'a', tline: 1 });
});

test('cross: an edge catches an item centre only within tol / 2, and loses to an edge pair at a similar distance', () => {
  const a = item('a', 0, 0, 100, 60); // centre x 50
  assert.deepEqual(snap(query({ x: 52.5, y: 200, w: 20, h: 20 }, [a])).x, { d: -2.5, at: 50, cls: 'cross', line: 0, target: 'a', tline: 1 });
  assert.equal(snap(query({ x: 53.5, y: 200, w: 20, h: 20 }, [a])).x, null);
  // Cross d = -2 (x 1.5 = 3) against edge d = 2.5 (x 1): the edge wins.
  const b = item('b', -45.5, 100, 100, 60); // right edge 54.5
  assert.deepEqual(snap(query({ x: 52, y: 200, w: 20, h: 20 }, [a, b])).x, { d: 2.5, at: 54.5, cls: 'edge', line: 0, target: 'b', tline: 2 });
});

test('the frame centre line never catches an item edge (probe: top 220, frame middle 225, tol 10)', () => {
  const box = { x: 300, y: 220, w: 100, h: 100 };
  assert.deepEqual(snap(query(box, [], { frame: { x: 0, y: 0, w: 800, h: 450 }, tol: 10 })), { x: null, y: null });
  // An item's centre line at the same place does catch it (cross, within tol / 2).
  assert.equal(snap(query(box, [item('a', 600, 200, 50, 50)], { tol: 10 })).y.cls, 'cross');
});

test('ties: the frame first, then the item nearest across the axis', () => {
  const frame = { x: 0, y: 0, w: 1000, h: 1000 };
  const a = item('a', -100, 400, 100, 50); // right edge 0, beside the box
  const b = item('b', -100, 0, 100, 50); // right edge 0, far above
  assert.equal(snap(query({ x: 3, y: 400, w: 50, h: 50 }, [a], { frame })).x.target, 'frame');
  assert.equal(snap(query({ x: 3, y: 410, w: 50, h: 50 }, [b, a])).x.target, 'a');
});

test('stickiness: the previous winner stays when a rival is 0.5 px nearer', () => {
  const box = { x: 3, y: 300, w: 50, h: 50 };
  const a = item('a', -100, 0, 100, 50); // right edge 0: d = -3
  const b = item('b', -94.5, 600, 100, 50); // right edge 5.5: d = 2.5
  assert.equal(snap(query(box, [a, b], { sticky: 1 })).x.target, 'b');
  const prev = snap(query(box, [a], { sticky: 1 }));
  assert.equal(snap(query(box, [a, b], { sticky: 1, prev })).x.target, 'a');
  assert.equal(snap(query(box, [a, b], { sticky: 0, prev })).x.target, 'b');
});

test('a point snaps to a corner on both axes', () => {
  const hits = snap(query({ x: 182, y: 97, w: 0, h: 0, point: true }, [item('a', 100, 100, 80, 40)], { lines: { x: [0], y: [0] } }));
  assert.deepEqual(hits, {
    x: { d: -2, at: 180, cls: 'point', line: 0, target: 'a', tline: 2 },
    y: { d: 3, at: 100, cls: 'point', line: 0, target: 'a', tline: 0 },
  });
});

test('q.lines: a resize snaps only the moving edge', () => {
  const targets = [item('a', 103, 0, 50, 50), item('b', -102, 0, 100, 50)]; // b's right edge is nearer the box's fixed left edge
  const hits = snap(query({ x: 0, y: 0, w: 100, h: 100 }, targets, { lines: { x: [2], y: [] } }));
  assert.deepEqual(hits, { x: { d: 3, at: 103, cls: 'edge', line: 2, target: 'a', tline: 0 }, y: null });
});

test('grid: only when no candidate holds, on the first allowed line', () => {
  const box = { x: 23, y: 47, w: 10, h: 10 };
  assert.deepEqual(snap(query(box, [], { grid: 10 })), {
    x: { d: -3, at: 20, cls: 'grid', line: 0, target: null, tline: null },
    y: { d: 3, at: 50, cls: 'grid', line: 0, target: null, tline: null },
  });
  assert.equal(snap(query(box, [item('a', 35, 300, 10, 10)], { grid: 10 })).x.cls, 'edge');
});

test('equal spacing: centred between two items, with both gaps', () => {
  const q = query({ x: 167, y: 10, w: 60, h: 30 }, [item('l', 0, 0, 100, 50), item('r', 300, 0, 100, 50)], { spacing: true });
  const hits = snap(q);
  assert.deepEqual(hits.x, {
    d: 3, at: 200, cls: 'spacing', line: 1, target: null, tline: null,
    gaps: [{ axis: 'x', a: 100, b: 170, at: 25, value: 70 }, { axis: 'x', a: 230, b: 300, at: 25, value: 70 }],
  });
  for (const level of ['simple', 'standard']) { // Simple too: a spacing snap has no line to show
    const gs = guides(moved(q.box, hits), q, hits, { level, kind: 'move' }).filter((g) => g.type === 'gap');
    assert.deepEqual(gs.map((g) => [g.a, g.b, g.value]), [[100, 170, 70], [230, 300, 70]]);
  }
  // A grid snap draws nothing at any level.
  const grid = query({ x: 23, y: 47, w: 10, h: 10 }, [], { grid: 10 });
  assert.deepEqual(guides(moved(grid.box, snap(grid)), grid, snap(grid), { level: 'simple' }), []);
  assert.equal(snap({ ...q, spacing: false }).x, null);
});

test('equal spacing: repeat the gap of a pair, with the pair\'s gap shown too', () => {
  const a = item('a', 0, 0, 100, 50);
  const b = item('b', 140, 20, 100, 50); // gap 40 after a
  const hits = snap(query({ x: 283, y: 30, w: 100, h: 50 }, [a, b], { spacing: true }));
  assert.equal(hits.y, null);
  assert.deepEqual(hits.x, {
    d: -3, at: 280, cls: 'spacing', line: 0, target: null, tline: null,
    gaps: [{ axis: 'x', a: 240, b: 280, at: 50, value: 40 }, { axis: 'x', a: 100, b: 140, at: 35, value: 40 }],
  });
  // A target in the pair's gap: no pair, so no gap to repeat.
  assert.equal(snap(query({ x: 283, y: 30, w: 100, h: 50 }, [a, b, item('c', 110, 30, 20, 10)], { spacing: true })).x, null);
});

test('guides: one line spans three lined-up items; a cross that did not win draws nothing', () => {
  const q = query({ x: 2, y: 300, w: 60, h: 60 }, [item('a', 0, 0, 50, 50), item('b', 0, 100, 80, 40), item('c', 0, 200, 30, 30)]);
  const hits = snap(q);
  assert.equal(hits.x.target, 'c'); // the nearest of three equal edges
  const gs = guides(moved(q.box, hits), q, hits);
  assert.deepEqual(gs.filter((g) => g.type === 'line'), [{ type: 'line', axis: 'x', at: 0, a: 0, b: 360 }]);
  assert.equal(count(gs, 'mark'), 8); // both ends of four left edges
});

test('guides: a frame line spans the frame and the box; marks only on the box', () => {
  const q = query({ x: 377, y: 700, w: 50, h: 50 }, [], { frame: { x: 0, y: 0, w: 800, h: 600 } });
  const hits = snap(q);
  assert.deepEqual(guides(moved(q.box, hits), q, hits), [{ type: 'line', axis: 'x', at: 400, a: 0, b: 750 }, { type: 'mark', x: 400, y: 725 }]);
});

test('guides: a point on a corner marks each spot once', () => {
  const q = query({ x: 182, y: 97, w: 0, h: 0, point: true }, [item('a', 100, 100, 80, 40)], { lines: { x: [0], y: [0] } });
  const hits = snap(q);
  const gs = guides(moved(q.box, hits), q, hits, { level: 'standard', kind: 'point' });
  assert.deepEqual(gs.filter((g) => g.type === 'mark').map((g) => [g.x, g.y]), [[180, 100], [180, 140], [100, 100]]);
});

test('guides: simple, standard and detailed', () => {
  const frame = { x: 0, y: 0, w: 500, h: 500 };
  const targets = [item('a', 0, 0, 100, 50), item('c', 200, 400, 50, 50), item('b', 300, 100, 100, 50)];
  const q = query({ x: 102, y: 101, w: 100, h: 50 }, targets, { frame });
  const hits = snap(q);
  assert.deepEqual([hits.x.target, hits.y.target], ['a', 'b']);
  const box = moved(q.box, hits);
  const simple = guides(box, q, hits, { level: 'simple', kind: 'move' });
  assert.deepEqual(simple, [{ type: 'line', axis: 'x', at: 100, a: 0, b: 150 }, { type: 'line', axis: 'y', at: 100, a: 100, b: 400 }]);
  const standard = guides(box, q, hits, { level: 'standard', kind: 'move' });
  assert.deepEqual([count(standard, 'line'), count(standard, 'distance'), count(standard, 'size')], [5, 0, 0]);
  assert.ok(count(standard, 'mark') > 0);
  const detailed = guides(box, q, hits, { level: 'detailed', kind: 'move' });
  assert.deepEqual(detailed.filter((g) => g.type === 'distance'), [
    { type: 'distance', axis: 'x', a: 0, b: 100, at: 125, value: 100 }, // no item on the left: the frame
    { type: 'distance', axis: 'x', a: 200, b: 300, at: 125, value: 100 }, // b
    { type: 'distance', axis: 'y', a: 0, b: 100, at: 150, value: 100 },
    { type: 'distance', axis: 'y', a: 150, b: 500, at: 150, value: 350 },
  ]);
  const resize = guides(box, q, hits, { level: 'detailed', kind: 'resize' });
  assert.deepEqual([count(resize, 'distance'), resize.filter((g) => g.type === 'size')], [0, [{ type: 'size', ...box }]]);
});

test('edgeHold: held at a side within EDGE_HOLD screen px, then out on the ramp, then 1:1', () => {
  const R = EDGE_RAMP;
  assert.equal(edgeHold(100, 100, 50, 0, 800, 1), 100); // inside
  assert.equal(edgeHold(-20, 100, 50, 0, 800, 1), 0); // within the dead zone
  assert.equal(edgeHold(-EDGE_HOLD, 100, 50, 0, 800, 1), 0);
  assert.equal(edgeHold(-(EDGE_HOLD + 120), 100, 50, 0, 800, 1), -(120 * 120) / (2 * R)); // on the ramp
  assert.equal(edgeHold(-(EDGE_HOLD + R), 100, 50, 0, 800, 1), -R / 2); // the ramp meets the 1:1 line
  assert.equal(edgeHold(-(EDGE_HOLD + 300), 100, 50, 0, 800, 1), -(300 - R / 2)); // past the ramp
  assert.equal(edgeHold(770, 100, 50, 0, 800, 1), 750); // the far side holds too
  assert.equal(edgeHold(750 + EDGE_HOLD + 120, 100, 50, 0, 800, 1), 750 + (120 * 120) / (2 * R));
});

test('edgeHold: screen px through the scale; a box that began outside or is larger than the frame moves freely', () => {
  assert.equal(edgeHold(-40, 100, 50, 0, 800, 0.5), 0); // 20 screen px
  assert.equal(edgeHold(-(64 + 240), 100, 50, 0, 800, 0.5), -60); // 152 screen px: 30 on screen out, 60 board px
  assert.equal(edgeHold(-50, -30, 50, 0, 800, 1), -50); // began past the left side
  assert.equal(edgeHold(-10, -0.3, 50, 0, 800, 1), 0); // less than half a px out counts as inside
  assert.equal(edgeHold(-10, 0, 900, 0, 800, 1), -10); // larger than the frame
});

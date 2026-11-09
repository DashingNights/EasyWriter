// bd-pen (docs/plans/board/briefs/bd-pen.md): the pen's stored fields and the paths' geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closes, inkFields, pathFields, spline, stored, thinned } from '../src/board/tools/pen.js';

test('inkFields grows the points by half the stroke width', () => {
  const f = inkFields([{ x: 10, y: 10 }, { x: 20, y: 10 }], { color: '#000000', width: 4, opacity: 1 });
  assert.equal(f.type, 'ink');
  assert.deepEqual([f.x, f.y, f.w, f.h], [8.5, 8.5, 13, 3]);
  assert.deepEqual(f.freeform.paths[0].pts[0], [1.5, 1.5]);
  assert.deepEqual([f.freeform.w, f.freeform.h], [13, 3]);
  assert.equal(f.freeform.paths[0].closed, false);
  assert.equal(f.freeform.alpha, 1);
  assert.equal(f.freeform.ink, 'pen');
  assert.equal(f.freeform.order, undefined);
  assert.deepEqual(f.stroke, [0, 0, 0]);
  assert.equal(f.strokeWidth, 3);
});

test('inkFields keeps a highlighter at its opacity, still ink pen', () => {
  const f = inkFields([{ x: 0, y: 0 }, { x: 10, y: 0 }], { color: '#e05252', width: 8, opacity: 0.35 });
  assert.equal(f.freeform.alpha, 0.35);
  assert.equal(f.freeform.ink, 'pen');
});

test('inkFields stores its points to 0.01 pt', () => {
  const f = inkFields([{ x: 0.123456, y: 0.987654 }, { x: 10, y: 0 }], { color: '#000000', width: 4, opacity: 1 });
  for (const p of f.freeform.paths[0].pts) for (const v of p) assert.equal(v, Math.round(v * 100) / 100);
});

test('thinned on three collinear points keeps two', () => {
  const out = thinned([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out, [{ x: 0, y: 0 }, { x: 2, y: 0 }]);
});

test('thinned keeps a point that leaves the line by more than the tolerance', () => {
  assert.equal(thinned([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 0 }]).length, 3);
});

test('closes is true at 7 px from the first point and false at 9', () => {
  const ring = (d) => [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: d }];
  assert.equal(closes(ring(7), 1), true);
  assert.equal(closes(ring(9), 1), false);
});

test('spline of three points passes through all three', () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 0 }];
  const out = spline(points);
  assert.equal(out.length, 2 * 8 + 1);
  for (const p of points) assert.ok(out.some((q) => Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9), `missed ${p.x},${p.y}`);
});

test('pathFields makes a freeform shape, its closed path taking the look\'s fill', () => {
  const look = { color: '#000000', width: 3, opacity: 1, fill: 'solid', fillColor: '#ff0000' };
  const closed = pathFields([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }], true, look);
  assert.equal(closed.kind, 'freeform');
  assert.deepEqual(closed.fill, [255, 0, 0]);
  assert.equal(closed.freeform.paths[0].closed, true);
  assert.equal(closed.freeform.paths[0].pts.length, 3);
  assert.equal(closed.freeform.ink, undefined);
  const open = pathFields([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, look);
  assert.equal(open.fill, null);
  assert.equal(open.freeform.paths[0].closed, false);
});

test('the same screen-space scribble stores about as many points at zoom 0.1 as at 1', () => {
  // Three hundred screen px of wavy line, a sample every half screen px: one path in screen space, drawn at two zooms.
  const screen = Array.from({ length: 601 }, (_, i) => ({ x: i * 0.5, y: 100 + Math.sin(i / 4) * 40 }));
  const at = (zoom) => {
    const k = zoom * (4 / 3);
    return stored(screen.map((p) => ({ x: p.x / k, y: p.y / k })), k);
  };
  const near = at(1).length;
  const far = at(0.1).length;
  assert.ok(far < screen.length / 2, `${far} of ${screen.length} points kept at zoom 0.1`);
  assert.ok(Math.abs(far - near) <= Math.max(2, near * 0.1), `${near} points at zoom 1, ${far} at zoom 0.1`);
});

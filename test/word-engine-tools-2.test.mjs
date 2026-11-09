// engine-tools-2: the page tools' pure parts. Edit Points' curves (curves.mjs, flattened as the engine's EditPath::flatten), the crop
// on a turned or flipped picture, and the canvas ruler's section columns and table cell. The tools themselves run in the harness
// case .smoke-data/word/cases/engine-tools-2.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/document/canvas/tools/curves.mjs';
import { flipCrop, turn } from '../src/document/canvas/tools/pictures.js';
import { cellAround, sectionColumns } from '../src/document/wp/ruler/ruler.mjs';

const near = (a, b, d = 1e-6) => Math.abs(a - b) <= d;
const square = () => C.pathOf([[0, 0], [30, 0], [30, 30], [0, 30]], true);

test('a path flattens its curves as the engine does and keeps straight sides as points', () => {
  assert.deepEqual(C.flatten(square()), [[0, 0], [30, 0], [30, 30], [0, 30]]);
  const p = C.setSegment(square(), 0, true);
  assert.ok(C.isCurved(p, 0) && !C.isCurved(p, 1));
  // A curved side: CURVE_STEPS points ending at its end; a curved closing side stops one short of the first point.
  assert.equal(C.flatten(p).length, 1 + C.CURVE_STEPS + 2);
  assert.equal(C.flatten(C.setSegment(square(), 3, true)).length, 3 + C.CURVE_STEPS);
  assert.deepEqual(C.flatten(C.setSegment(p, 0, false)), C.flatten(square()));
});

test('a handle dragged bends its side; a smooth point mirrors the other handle and a straight one keeps its length', () => {
  const bent = C.moveHandle(square(), 1, 'cIn', [20, -10]);
  assert.ok(C.pointOn(bent, 0, 0.5)[1] < -2, 'the top side bows up');
  const smooth = C.setKind(square(), 1, 'smooth');
  const h = C.handlesOf(smooth, 1);
  assert.ok(near(h.cIn[0] + h.cOut[0], 60) && near(h.cIn[1] + h.cOut[1], 0), 'in line through the point, equally long');
  const moved = C.moveHandle(smooth, 1, 'cOut', [40, 20]);
  assert.deepEqual(moved.nodes[1].cIn.map((v) => Math.round(v)), [20, -20]);
  const straight = C.moveHandle(C.setKind(square(), 1, 'straight'), 1, 'cOut', [30, 40]);
  const s = straight.nodes[1];
  assert.ok(near(Math.hypot(s.cIn[0] - 30, s.cIn[1]), Math.hypot(h.cIn[0] - 30, h.cIn[1]), 1e-3), 'the other handle keeps its length');
  assert.ok(near(s.cIn[0], 30, 1e-3) && s.cIn[1] < 0, 'and turns in line with the dragged one');
  assert.equal(C.moveHandle(C.setKind(square(), 1, 'auto'), 1, 'cOut', [35, 5]).nodes[1].kind, 'smooth');
});

test('adding a point on a curve splits it without changing its shape; points and sides delete as Word does', () => {
  const p = C.moveHandle(square(), 0, 'cOut', [10, -20]);
  const mid = C.pointOn(p, 0, 0.5);
  const { path, index } = C.addPoint(p, 0, 0.5);
  assert.equal(index, 1);
  assert.deepEqual(path.nodes[1].at.map((v) => +v.toFixed(6)), mid.map((v) => +v.toFixed(6)));
  for (const t of [0.25, 0.5, 0.75]) {
    const was = C.pointOn(p, 0, t < 0.5 ? t : t);
    const side = t < 0.5 ? 0 : 1;
    const now = C.pointOn(path, side, t < 0.5 ? t * 2 : (t - 0.5) * 2);
    assert.ok(near(was[0], now[0], 1e-6) && near(was[1], now[1], 1e-6), `t ${t}`);
  }
  assert.deepEqual(C.deletePoint(square(), 0)[0].nodes.length, 3);
  const opened = C.deleteSegment(square(), 1);
  assert.equal(opened.length, 1);
  assert.deepEqual([opened[0].closed, opened[0].nodes[0].at, opened[0].nodes.at(-1).at], [false, [30, 30], [30, 0]]);
  const split = C.deleteSegment(C.pathOf([[0, 0], [10, 0], [20, 0], [30, 0]], false), 1);
  assert.deepEqual(split.map((x) => x.nodes.length), [2, 2]);
  const open = C.openAt(square(), 2);
  assert.deepEqual([open.closed, open.nodes.length, open.nodes[0].at, open.nodes.at(-1).at], [false, 5, [30, 30], [30, 30]]);
  assert.deepEqual(C.closePath(open).nodes.length, 4);
});

test('the crop of a flipped picture swaps its sides, and a turn about the centre goes back with its opposite', () => {
  assert.deepEqual(flipCrop([0.1, 0.2, 0.3, 0.4], true, false), [0.3, 0.2, 0.1, 0.4]);
  assert.deepEqual(flipCrop(flipCrop([0.1, 0.2, 0.3, 0.4], true, true), true, true), [0.1, 0.2, 0.3, 0.4]);
  const r = turn([50, 50], 90)([100, 50]);
  assert.ok(near(r[0], 50) && near(r[1], 100));
  const back = turn([50, 50], -90)(r);
  assert.ok(near(back[0], 100) && near(back[1], 50));
});

test('the canvas ruler finds the section columns and the table cell around the caret', () => {
  assert.equal(sectionColumns({ count: 1 }, { x: 72, w: 468 }), null);
  const eq = sectionColumns({ count: 2, space: 36, widths: [] }, { x: 72, w: 468 });
  assert.deepEqual(eq.map((c) => [c.x, c.w]), [[72, 216], [324, 216]]);
  const own = sectionColumns({ count: 2, space: 18, widths: [[150, 18], [300, 0]] }, { x: 72, w: 468 });
  assert.deepEqual(own.map((c) => [c.x, c.w]), [[72, 150], [240, 300]]);
  const cells = [
    { x: 72, y: 100, w: 100, h: 20, row: 0, cell: 0, table: [0] }, { x: 172, y: 100, w: 150, h: 20, row: 0, cell: 1, table: [0] },
    { x: 72, y: 120, w: 100, h: 20, row: 1, cell: 0, table: [0] }, { x: 180, y: 104, w: 50, h: 10, row: 0, cell: 0, table: [0, 0, 1, 0] },
  ];
  const at = cellAround(cells, { x: 200, y: 104, h: 12 });
  assert.deepEqual([at.cell.table, at.row.length], [[0, 0, 1, 0], 1], 'the innermost table wins');
  const outer = cellAround(cells, { x: 100, y: 102, h: 12 });
  assert.deepEqual(outer.row.map((c) => c.x), [72, 172]);
  assert.equal(cellAround(cells, { x: 100, y: 300, h: 12 }), null);
});

// Draw tab pens (docs/plans/word briefs/draw.md Acceptance): sizes, opacities, Add, ruler snapping and replay order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addPen, DEFAULT_PENS, mmToPx, penToBoard, pensOf, replayOrder, snapToRuler, strokePoints, THICKNESS } from '../src/document/wp/draw/pens.mjs';

test('mmToPx and penToBoard', () => {
  assert.ok(Math.abs(mmToPx(0.5) - 1.89) <= 0.01);
  assert.equal(penToBoard({ kind: 'highlighter', color: '#ffff00', width: 6 }).opacity, 0.35);
  assert.equal(penToBoard({ kind: 'pencil', color: '#404040', width: 1 }).opacity, 0.7);
  assert.equal(penToBoard({ kind: 'pen', color: '#e71224', width: 0.5 }).opacity, 1);
});

test('thickness lists', () => {
  assert.deepEqual(THICKNESS.pen, [0.25, 0.35, 0.5, 0.7, 1, 2, 3.5]);
  assert.deepEqual(THICKNESS.highlighter, [2, 4, 6, 8, 10]);
});

test('addPen appends a pen with its kind default', () => {
  const pens = addPen(DEFAULT_PENS, 'pencil');
  assert.equal(pens.length, DEFAULT_PENS.length + 1);
  assert.deepEqual(pens.at(-1), { kind: 'pencil', color: '#404040', width: 1 });
  assert.equal(pensOf(null), DEFAULT_PENS);
  assert.equal(pensOf([{ kind: 'nope' }]), DEFAULT_PENS);
  assert.equal(pensOf(pens), pens);
});

// A stroke from (10, y0) through a wobble to (110, y1), as finishStroke stores it.
const stroke = (y0, y1) => ({ id: 's', type: 'stroke', x: 0, y: 0, w: 200, h: 200, vw: 200, vh: 200, width: 2, d: `M10 ${y0}Q60 ${y0 + 3} 85 ${y1 - 1}L110 ${y1}` });
const edge = [{ a: { x: 0, y: 50 }, b: { x: 300, y: 50 } }];

test('snapToRuler straightens a stroke ending near the edge and leaves a far one', () => {
  const snapped = snapToRuler(stroke(46, 55), edge);
  assert.ok(snapped);
  const pts = strokePoints(snapped);
  assert.equal(pts.length, 2);
  for (const p of pts) assert.ok(Math.abs(p.y - 50) <= 0.5, JSON.stringify(pts));
  assert.equal(snapToRuler(stroke(70, 70), edge), null);
});

test('replayOrder keeps item order and drops other items', () => {
  const items = [{ id: 'a', type: 'stroke' }, { id: 'b', type: 'shape' }, { id: 'c', type: 'stroke' }];
  assert.deepEqual(replayOrder(items).map((i) => i.id), ['a', 'c']);
});

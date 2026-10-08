import { test } from 'node:test';
import assert from 'node:assert/strict';
import { align, distribute, resizeInFrame, sameSize } from '../src/flow/model.mjs';
import { rotatePoint, rotBox } from '../src/flow/shapes.mjs';

// Arrangement (align / distribute / same size) and the rotated resize (flowchart plan §5.6, roadmap B3).

const boxes = () => [{ x: 10, y: 50, w: 100, h: 40 }, { x: 200, y: 0, w: 60, h: 60 }, { x: 90, y: 120, w: 30, h: 20 }];

test('align: every box on the group box\'s edge or centre line; the input is not changed', () => {
  const input = boxes();
  const copy = structuredClone(input);
  assert.deepEqual(align(input, 'left').map((b) => b.x), [10, 10, 10]);
  assert.deepEqual(align(input, 'right').map((b) => b.x + b.w), [260, 260, 260]);
  assert.deepEqual(align(input, 'centre').map((b) => b.x + b.w / 2), [135, 135, 135]);
  assert.deepEqual(align(input, 'top').map((b) => b.y), [0, 0, 0]);
  assert.deepEqual(align(input, 'bottom').map((b) => b.y + b.h), [140, 140, 140]);
  assert.deepEqual(align(input, 'middle').map((b) => b.y + b.h / 2), [70, 70, 70]);
  assert.deepEqual(align(input, 'left').map((b) => b.y), [50, 0, 120]); // the other axis stays
  assert.deepEqual(input, copy);
});

test('align: a turned shape aligns by its turned bounds', () => {
  const turned = rotBox({ x: 100, y: 100, w: 100, h: 40, rot: 90 }); // 40 × 100 about (150, 120)
  const [a, b] = align([{ x: 0, y: 0, w: 50, h: 50 }, turned], 'left');
  assert.equal(a.x, 0);
  assert.equal(b.x, 0); // the Board moves the item by b.x − turned.x = −130
  assert.equal(turned.x, 130);
});

test('distribute: equal gaps in position order, the first and last stay; under three unchanged', () => {
  const out = distribute([{ x: 300, y: 0, w: 50, h: 10 }, { x: 0, y: 0, w: 100, h: 10 }, { x: 120, y: 0, w: 20, h: 10 }], 'h');
  assert.deepEqual(out.map((b) => b.x), [300, 0, 190]); // gaps (350 − 170) / 2 = 90: 0..100, 190..210, 300..350
  const v = distribute([{ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 15, w: 10, h: 10 }, { x: 0, y: 100, w: 10, h: 50 }], 'v');
  assert.deepEqual(v.map((b) => b.y), [0, 50, 100]); // gaps (150 − 70) / 2 = 40
  assert.deepEqual(distribute([{ x: 5, y: 0, w: 1, h: 1 }, { x: 50, y: 0, w: 1, h: 1 }], 'h').map((b) => b.x), [5, 50]);
});

test('sameSize: the largest width / height; a turned box keeps its centre, others their top-left', () => {
  const out = sameSize([{ x: 0, y: 0, w: 50, h: 20 }, { x: 100, y: 10, w: 80, h: 30 }, { x: 300, y: 0, w: 40, h: 40, rot: 30 }], 'w');
  assert.deepEqual(out.map((b) => [b.x, b.w]), [[0, 80], [100, 80], [280, 80]]);
  assert.deepEqual(sameSize(out, 'h').map((b) => b.h), [40, 40, 40]);
});

const HANDLES = ['nw', 'ne', 'sw', 'se', 'e'];
// The board position of a point of `b` given as fractions of its unrotated box.
const at = (b, fx, fy) => rotatePoint({ x: b.x + fx * b.w, y: b.y + fy * b.h }, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, b.rot || 0);
// The fixed point of a handle (the opposite corner; for an edge, the opposite edge's middle).
const fixedOf = (h) => [h.includes('w') ? 1 : h.includes('e') ? 0 : 0.5, h.includes('n') ? 1 : h.includes('s') ? 0 : 0.5];
const movingOf = (h) => fixedOf(h).map((f) => 1 - f);

test('resizeInFrame: at 0° / 30° / 90° / 180° the fixed corner (edge) keeps its board position; the dragged one follows', () => {
  for (const rot of [0, 30, 90, 180]) {
    const start = { x: 100, y: 80, w: 120, h: 60, rot };
    for (const handle of HANDLES) {
      // A pointer move of (+30, +20) in the item frame, given in board px.
      const move = rotatePoint({ x: 30 * (handle.includes('w') ? -1 : 1), y: 20 * (handle.includes('n') ? -1 : 1) }, { x: 0, y: 0 }, rot);
      const r = resizeInFrame(start, handle, move.x, move.y);
      const box = { ...r, rot };
      const [f0, f1] = [at(start, ...fixedOf(handle)), at(box, ...fixedOf(handle))];
      assert.ok(Math.hypot(f0.x - f1.x, f0.y - f1.y) <= 0.5, `${handle} @ ${rot}°: fixed ${JSON.stringify([f0, f1])}`);
      if (handle === 'e') {
        assert.deepEqual([r.w, r.h], [150, 60], `e @ ${rot}°: only the width changes`);
        continue;
      }
      assert.deepEqual([r.w, r.h], [150, 80], `${handle} @ ${rot}°`);
      const [m0, m1] = [at(start, ...movingOf(handle)), at(box, ...movingOf(handle))];
      assert.ok(Math.hypot(m0.x + move.x - m1.x, m0.y + move.y - m1.y) <= 0.5, `${handle} @ ${rot}°: the corner follows the pointer`);
    }
  }
});

test('resizeInFrame: aspect keeps the ratio (corners only), the minimum size holds, an edge ignores the other axis', () => {
  const start = { x: 0, y: 0, w: 100, h: 50, rot: 30 };
  const k = resizeInFrame(start, 'se', ...Object.values(rotatePoint({ x: 100, y: 0 }, { x: 0, y: 0 }, 30)), { aspect: true });
  assert.equal(k.w / k.h, 2);
  const small = resizeInFrame(start, 'se', -500, -500, { min: 20 });
  assert.deepEqual([small.w, small.h], [20, 20]);
  const tiny = resizeInFrame({ x: 0, y: 0, w: 10, h: 50 }, 'nw', 100, 0, { min: 20 });
  assert.equal(tiny.w, 10); // a side already under the minimum keeps its start size as its minimum
  const edge = resizeInFrame({ x: 0, y: 0, w: 100, h: 50 }, 's', 40, 25);
  assert.deepEqual(edge, { x: 0, y: 0, w: 100, h: 75 });
});

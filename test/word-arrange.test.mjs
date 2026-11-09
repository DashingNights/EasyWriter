// Arrange's pure logic (src/document/wp/arrange/order.mjs; docs/plans/word briefs/arrange.md Acceptance).
import assert from 'node:assert/strict';
import test from 'node:test';
import { alignTo, distribute, dropOrder, gridLines, nextObject, objectNames, rotateStep, zOps } from '../src/document/wp/arrange/order.mjs';

const abc = [{ id: 'a', z: 1 }, { id: 'b', z: 2 }, { id: 'c', z: 3 }];

test('order steps and ends', () => {
  assert.deepEqual(zOps(abc, 'a', 'forward'), { a: 2, b: 1 });
  assert.deepEqual(zOps(abc, 'a', 'front'), { a: 4 });
  assert.deepEqual(zOps(abc, 'c', 'back'), { c: 0 });
  assert.deepEqual(zOps(abc, 'c', 'forward'), {}, 'the top object stays');
  assert.deepEqual(zOps([{ id: 'a', z: 0 }, { id: 'b', z: 1 }, { id: 'c', z: 2 }], 'c', 'back'), { c: 1, a: 2, b: 3 }, 'z never drops below 0');
  // Equal layers stack in document order and spread to 1..n before the step.
  assert.deepEqual(zOps([{ id: 'a', z: 0 }, { id: 'b', z: 0 }], 'a', 'forward'), { a: 2, b: 1 });
});

test('distribute gives equal gaps', () => {
  const out = distribute([{ x: 0, y: 0, w: 10, h: 10 }, { x: 15, y: 0, w: 10, h: 10 }, { x: 60, y: 0, w: 10, h: 10 }], 'h');
  assert.deepEqual(out.map((b) => b.x), [0, 30, 60]);
});

test('align one object to the margin', () => {
  assert.deepEqual(alignTo({ wrap: 'front', h: { rel: 'column', offset: 30 } }, 'center', 'margin'), { h: { rel: 'margin', align: 'center' } });
  assert.deepEqual(alignTo(null, 'bottom', 'page'), { v: { rel: 'page', align: 'bottom' } });
});

test('next object wraps at both ends', () => {
  assert.equal(nextObject([5, 9, 20], 20, 1, true), 5);
  assert.equal(nextObject([5, 9, 20], 5, -1, true), 20);
  assert.equal(nextObject([5, 9, 20], 7, 1), 9);
  assert.equal(nextObject([], 7, 1), null);
});

test('default names number objects across the document', () => {
  const nodes = [{ type: 'image', attrs: {} }, { type: 'textBox', attrs: {} },
    { type: 'canvas', attrs: { items: [{ type: 'shape', shape: 'rect' }] } }, { type: 'image', attrs: { name: 'Logo' } }];
  assert.deepEqual(objectNames(nodes), ['Picture 1', 'Text Box 2', 'Rectangle 3', 'Logo']);
});

test('rotation steps', () => {
  assert.equal(rotateStep(300, 90), 30);
  assert.equal(rotateStep(0, -90), 270);
});

test('grid lines on A4 from the margins', () => {
  const box = { w: 595.3, h: 841.9, top: 72, right: 72, bottom: 72, left: 72 };
  const { xs, ys } = gridLines(box, null);
  assert.equal(xs[0], 72);
  assert.equal(xs.length, Math.floor((595.3 - 144) / 9) + 1);
  assert.equal(ys[0], 72);
  assert.equal(gridLines(box, { everyV: 0 }).xs.length, 0);
});

test('Selection pane drop reorders the layers', () => {
  const rows = ['a', 'b', 'c', 'd']; // front-most first
  assert.equal(dropOrder(rows, 'b', 'b'), null, 'a row dropped on itself changes nothing');
  assert.equal(dropOrder(rows, 'b', 'x'), null);
  assert.deepEqual(dropOrder(rows, 'a', 'd'), ['b', 'c', 'd', 'a'], 'down onto the last row reaches the back');
  assert.deepEqual(dropOrder(rows, 'd', 'a'), ['d', 'a', 'b', 'c'], 'up onto the first row reaches the front');
  assert.deepEqual(dropOrder(rows, 'b', 'c'), ['a', 'c', 'b', 'd']);
});

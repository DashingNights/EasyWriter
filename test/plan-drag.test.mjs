import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropTarget } from '../src/app/components/plan/drag.mjs';

const rect = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });
// Two 260 px columns 12 px apart ("No status" and To do), cards 60 px high with 8 px gaps.
const columns = [{ id: null, rect: rect(0, 40, 260, 600) }, { id: 'todo', rect: rect(272, 40, 260, 600) }];
const cards = [
  { id: 'b', column: 'todo', rect: rect(280, 116, 244, 60) },
  { id: 'a', column: 'todo', rect: rect(280, 48, 244, 60) },
  { id: 'n', column: null, rect: rect(8, 48, 244, 60) },
];

test('the card below the pointer\'s half decides the insertion point', () => {
  assert.deepEqual(dropTarget(cards, columns, 400, 60), { column: 'todo', beforeId: 'a' }); // above a's middle
  assert.deepEqual(dropTarget(cards, columns, 400, 90), { column: 'todo', beforeId: 'b' }); // below a's middle
  assert.deepEqual(dropTarget(cards, columns, 400, 170), { column: 'todo', beforeId: null }); // past the last card
  assert.deepEqual(dropTarget(cards, columns, 400, 900), { column: 'todo', beforeId: null }); // below the column: still it
});

test('"No status", empty columns and the gap between columns', () => {
  assert.deepEqual(dropTarget(cards, columns, 100, 50), { column: null, beforeId: 'n' });
  assert.deepEqual(dropTarget([], columns, 300, 50), { column: 'todo', beforeId: null });
  assert.equal(dropTarget(cards, columns, 266, 50), null);
});

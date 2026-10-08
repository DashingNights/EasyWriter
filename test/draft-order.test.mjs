import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropDraft, moveBeside, sortDrafts } from '../src/app/draft-order.mjs';

const drafts = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((d) => d.id);
const inFolder = (list, map, folder) => ids(list).filter((id) => (map[id] ?? null) === folder);

test('drafts not in the order come first, in their given order; no order keeps the given order', () => {
  assert.deepEqual(ids(sortDrafts(drafts('n1', 'n2', 'a', 'b', 'c'), ['c', 'a', 'b'])), ['n1', 'n2', 'c', 'a', 'b']);
  assert.deepEqual(ids(sortDrafts(drafts('c', 'b', 'a'))), ['c', 'b', 'a']);
});

test('a folder and the top level show their drafts in the relative order', () => {
  const map = { a: 'F', b: 'F' };
  const list = sortDrafts(drafts('a', 'b', 'x', 'y'), ['y', 'b', 'x', 'a']);
  assert.deepEqual(inFolder(list, map, 'F'), ['b', 'a']);
  assert.deepEqual(inFolder(list, map, null), ['y', 'x']);
});

test('moves before or after a neighbour', () => {
  assert.deepEqual(moveBeside(['a', 'b', 'c', 'd'], 'c', 'a'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(moveBeside(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveBeside(['a', 'b', 'c', 'd'], 'a', 'd', true), ['b', 'c', 'd', 'a']);
});

test('a dropped draft joins the folder of its neighbour at that position', () => {
  const map = { a: 'F', b: 'F', c: 'G', d: 'G' };
  const r = dropDraft(drafts('a', 'b', 'c', 'd', 'x'), ['a', 'b', 'c', 'd', 'x'], map, 'a', 'd');
  assert.deepEqual(r.order, ['b', 'c', 'a', 'd', 'x']);
  assert.deepEqual(inFolder(drafts(...r.order), r.map, 'G'), ['c', 'a', 'd']);
  assert.deepEqual(inFolder(drafts(...r.order), r.map, 'F'), ['b']);
  const top = dropDraft(drafts('a', 'b', 'c', 'd', 'x'), r.order, r.map, 'c', 'x', true);
  assert.deepEqual(top.order, ['b', 'a', 'd', 'x', 'c']);
  assert.equal(top.map.c, null);
  assert.deepEqual(map, { a: 'F', b: 'F', c: 'G', d: 'G' }, 'input not mutated');
});

test('ids of deleted drafts are dropped; new drafts are kept first', () => {
  const r = dropDraft(drafts('new', 'a', 'b'), ['gone', 'a', 'b'], {}, 'b', 'a');
  assert.deepEqual(r.order, ['new', 'b', 'a']);
});

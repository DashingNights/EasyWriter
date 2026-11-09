// bd-pagemove (docs/plans/board/briefs/bd-pagemove.md): the one move a drop asks of the document, and what a drop does with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import { applyOrder, moveOf, orderAfter } from '../src/board/reorder.js';
import { readingOrder, rectsOf } from '../src/board/sections.mjs';

const BOX = { w: 595, h: 842 };
const row = (...xs) => xs.map((x) => ({ x, y: 0, ...BOX }));

test('the dragged page goes in front of the page that now follows it', () => {
  // Page 3 dropped left of page 1; page 2 dropped to the right of page 3; page 3 dropped between the first two.
  assert.deepEqual(moveOf(row(619, 1238, -619), 2), { from: 2, before: 0 });
  assert.deepEqual(moveOf(row(0, 1857, 1238), 1), { from: 1, before: 3 });
  assert.deepEqual(moveOf(row(0, 1238, 300), 2), { from: 2, before: 1 });
});

test('a page that lands where it already stands is no move', () => {
  assert.equal(moveOf(row(0, 619, 1238), 1), null);
  assert.equal(moveOf(row(0, 619, 1238), 2), null);
  assert.equal(moveOf(row(0, 619, 1238), 0), null);
  // Dropped a row down it reads last, which is where the last page is.
  assert.equal(moveOf([...row(0, 619), { x: 1238, y: 1000, ...BOX }], 2), null);
});

test('a page the user did not touch is never moved: a page without a slot that reads out of order stays put', () => {
  // Pages 0, 2 and 3 have slots; page 1 has none and lands right of them all, so the board reads 0, 2, 3, 1.
  const item = { x: 0, y: 0, slots: { a: [0, 0], c: [619, 0], d: [1238, 0] } };
  const pages = ['a', 'b', 'c', 'd'].map((first) => ({ ...BOX, first }));
  const rects = rectsOf(item, pages);
  assert.deepEqual(readingOrder(rects), [0, 2, 3, 1]);
  // Page 3 is dragged to a row of its own below: the board reads 0, 2, 1, 3. Page 3 is last, as it is in the document.
  const dropped = rects.map((r, i) => (i === 3 ? { ...r, y: 1000 } : r));
  assert.deepEqual(readingOrder(dropped), [0, 2, 1, 3]);
  assert.equal(moveOf(dropped, 3), null);
  // Page 0 dragged to the right of them all: only page 0 moves, to the end.
  assert.deepEqual(moveOf(rects.map((r, i) => (i === 0 ? { ...r, x: 2500 } : r)), 0), { from: 0, before: 4 });
});

test('page numbers after a move: the others close ranks and the page takes its place', () => {
  assert.deepEqual(orderAfter(3, { from: 2, before: 0 }), [2, 0, 1]);
  assert.deepEqual(orderAfter(4, { from: 3, before: 1 }), [0, 3, 1, 2]);
  assert.deepEqual(orderAfter(4, { from: 0, before: 3 }), [1, 2, 0, 3]);
  assert.deepEqual(orderAfter(3, { from: 0, before: 3 }), [1, 2, 0]);
});

/** A board with one document item, a fake session for its draft and a journal that records its groups. */
function fixture(answer) {
  const store = new BoardStore(blankBoard());
  let id;
  store.change('Add', (tx) => { id = tx.create({ type: 'doc', at: [null, 'a'], draft: 'd', x: 0, y: 0, w: 0, h: 0, slots: null }); });
  const calls = [];
  const client = {
    id: 'd',
    async execMany(steps) {
      calls.push(steps);
      return answer;
    },
    // The keys after the move: the long paragraph's second half is a new block, so key 7#1 became 12#0.
    async pages() {
      return { pages: [{ first: '12#0' }, { first: '7#0' }, { first: '9#0' }] };
    },
    async steps() {
      return { undo: 'step-2', redo: null };
    },
  };
  const groups = [];
  const api = { store, instances: { clientOf: (draft) => (draft === 'd' ? client : null) }, journal: { group: (parts) => groups.push(parts) } };
  return { store, id, calls, groups, api };
}

// Page 2 dropped to the left of page 0, a gap of 24 between them.
const DROPPED = [{ x: 619, y: 0, ...BOX }, { x: 1238, y: 0, ...BOX }, { x: 0, y: 0, ...BOX }];
const MOVE = { from: 2, before: 0 };

test('a drop that reorders sends one move to the draft, stores the slots by the keys it has after, and groups the two steps', async () => {
  const f = fixture({ ok: true });
  const r = await applyOrder(f.api, f.store.get(f.id), MOVE, DROPPED);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(f.calls, [[['page.move', MOVE]]]);
  const item = f.store.get(f.id);
  // Each page keeps the box it was dropped at: the dragged page is page 0 now, and the others follow it.
  assert.deepEqual(item.slots, { '12#0': [0, 0], '7#0': [619, 0], '9#0': [1238, 0] });
  assert.deepEqual([item.x, item.y, item.w, item.h], [0, 0, 1238 + 595, 842]);
  const step = f.store.steps.at(-1);
  assert.equal(step.label, 'Move page');
  assert.deepEqual(f.groups, [[{ kind: 'doc', session: 'd', step: 'step-2' }, { kind: 'board', step }]]);
});

test('a move the draft refuses changes nothing on the board and says why', async () => {
  const f = fixture({ ok: false, step: 0, error: 'A table row crosses this page.' });
  const steps = f.store.steps.length;
  const r = await applyOrder(f.api, f.store.get(f.id), MOVE, DROPPED);
  assert.deepEqual(r, { ok: false, error: 'A table row crosses this page.' });
  assert.equal(f.store.steps.length, steps);
  assert.equal(f.store.get(f.id).slots, null);
  assert.deepEqual(f.groups, []);
});

test('a draft that is not open is not moved', async () => {
  const f = fixture({ ok: true });
  const r = await applyOrder({ ...f.api, instances: { clientOf: () => null } }, f.store.get(f.id), MOVE, DROPPED);
  assert.equal(r.ok, false);
  assert.deepEqual(f.calls, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, stateOf, summaryOf, validFlow, writeBackOk } from '../src/flow/library.mjs';

const ID = '3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21';
const shape = (id) => ({ id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#fff', width: 2, opacity: 1, fill: 'none', fillColor: '#000', flipX: false, flipY: false });

test('parseFlow drops bad items and nested canvases, keeps rev, defaults sizes to 1200 × 675', () => {
  const r = parseFlow(JSON.stringify({
    id: ID, title: 'Login', rev: 7, threadUrl: 'https://daf.staffs.ac.uk/topic/88136-level-design/',
    board: { w: -1, h: 'x', frame: { x: 0, y: 0, w: 0, h: 5 }, bg: 'nope', items: [shape('a'), { id: 'b', type: 'shape' }, { id: 'c', type: 'canvas', x: 0, y: 0, w: 1, h: 1, aw: 1, ah: 1 }] },
  }));
  assert.equal(r.rev, 7);
  assert.deepEqual([r.board.w, r.board.h, r.board.frame, r.board.bg], [1200, 675, null, 'post']);
  assert.deepEqual(r.board.items.map((i) => i.id), ['a']);
  assert.equal(r.threadUrl, 'https://daf.staffs.ac.uk/topic/88136-level-design/');
});

test('parseFlow repairs the envelope and never throws', () => {
  const r = parseFlow({ id: ID, title: 5, rev: 0, threadUrl: 'https://example.com/', board: null });
  assert.deepEqual([r.title, r.rev, r.threadUrl, r.version, r.board.items.length], ['Flowchart', 1, null, 1, 0]);
  assert.equal(parseFlow('{bad'), null);
  assert.equal(parseFlow({ id: '../x' }), null);
  assert.equal(parseFlow(null), null);
});

test('summaryOf counts the items', () => {
  const r = parseFlow({ id: ID, title: 'T', rev: 2, board: { items: [shape('a'), shape('b')] }, created: 1, updated: 2 });
  assert.deepEqual(summaryOf(r), { id: ID, threadUrl: null, title: 'T', created: 1, updated: 2, rev: 2, items: 2 });
});

test('validFlow', () => {
  assert.deepEqual(validFlow({ id: ID, rev: 3, x: 1 }), { id: ID, rev: 3 });
  for (const bad of [null, {}, { id: ID, rev: 0 }, { id: ID, rev: 1.5 }, { id: 'x', rev: 1 }, { id: ID }]) assert.equal(validFlow(bad), null);
});

// A chain fixture: writes [rev, pred, origin, as?] on top of rev `base` (a record loaded at that rev).
const chainOf = (...writes) => new Map(writes.map(([rev, pred, origin, as]) => [rev, { pred, origin, ...(as && { as }) }]));
const at = (rev) => ({ rev });

test('writeBackOk: an own single edit undoes, and redoes after the write-back', () => {
  const chain = chainOf([4, 3, 'A']);
  assert.ok(writeBackOk(chain, at(4), 'A', 4, 3)); // undo: library at 4, the write 3→4 is A's
  chain.set(5, { pred: 4, origin: 'A', as: 3 }); // the write-back counts as 3
  assert.equal(stateOf(chain, 5), 3);
  assert.ok(writeBackOk(chain, at(5), 'A', 3, 4)); // redo: the node lags at 3, the library counts as 3
});

test('writeBackOk: two merged own commits undo at once', () => {
  assert.ok(writeBackOk(chainOf([4, 3, 'A'], [5, 4, 'A']), at(5), 'A', 5, 3));
});

test('writeBackOk: a write by another draft, the library editor or an agent in between blocks', () => {
  for (const other of ['B', 'library', 'agent']) {
    assert.equal(writeBackOk(chainOf([4, 3, 'A'], [5, 4, other]), at(5), 'A', 4, 3), false, other); // library not at x
    assert.equal(writeBackOk(chainOf([4, 3, other], [5, 4, 'A']), at(5), 'A', 5, 3), false, other); // other's write on the way
  }
});

test('writeBackOk: a library undo of the edit in between counts as the state it restored', () => {
  assert.ok(writeBackOk(chainOf([4, 3, 'A'], [5, 4, 'library'], [6, 5, 'library', 4]), at(6), 'A', 4, 3));
});

test('writeBackOk: a stale cache never writes', () => {
  // The node cached rev 2; rev 3 came from an earlier session or another writer; its own edit made rev 4.
  assert.equal(writeBackOk(chainOf([4, 3, 'A']), at(4), 'A', 4, 2), false);
  assert.equal(writeBackOk(chainOf([3, 2, 'B'], [4, 3, 'A']), at(4), 'A', 4, 2), false);
  assert.equal(writeBackOk(chainOf([4, 3, 'A']), at(4), 'A', 4, 4), false); // no change
});

test('writeBackOk: undoing a catch-up step keeps the edit another canvas of the draft made and still holds', () => {
  // Canvases P and Q of one draft at rev 2; P's edit made 3; Q's catch-up step (2 → 3) and edit made 4; Q's undo wrote 5 as 3.
  const chain = chainOf([3, 2, 'A'], [4, 3, 'A'], [5, 4, 'A', 3]);
  assert.equal(writeBackOk(chain, at(5), 'A', 3, 2, [3, 2]), false); // Q undoes its catch-up: P still holds 3
  assert.ok(writeBackOk(chain, at(5), 'A', 3, 2, [2, 2])); // then P undoes its own edit (written back as 6)
  chain.set(6, { pred: 5, origin: 'A', as: 2 });
  assert.ok(writeBackOk(chain, at(6), 'A', 2, 3, [3, 2])); // P's redo is not held back by Q holding 2
});

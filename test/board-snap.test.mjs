// bd-snap (docs/plans/board/briefs/bd-snap.md): the board's snap query. The board's world is points and the engine works in
// board px, so every value here is the brief's or board-snapping.md's, converted at look.mjs's one boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import snapTool, { queryOf, snapped, targetsOf } from '../src/board/tools/snap.js';

const RULES = { on: true, items: true, board: true, spacing: false, grid: false, distance: 6, guides: 'standard' };
const VIEW = { x: -10_000, y: -10_000, w: 40_000, h: 40_000 };
const ALL = { x: [0, 1, 2], y: [0, 1, 2] };
const shape = (id, x, y, w = 10, h = 10) => ({ id, type: 'shape', x, y, w, h });

function boardWith(items) {
  const board = blankBoard();
  for (const item of items) board.items[item.id] = { at: [null, item.id], ...item };
  return new BoardStore(board);
}

/** A tool's context with no viewport but what a snap reads. */
const contextFor = (store, zoom = 1) => ({ store, vp: { view: () => VIEW, camera: { x: 0, y: 0, zoom } } });

test('a left edge 4 board px from another snaps onto it: 3 pt at zoom 1, and nothing at zoom 4', () => {
  const store = boardWith([shape('a', 103, 0), shape('b', 100, 0)]);
  const q = (zoom) => queryOf({ box: { x: 100, y: 0, w: 10, h: 10 }, lines: ALL, store, skip: ['b'], view: VIEW,
    rules: RULES, zoom, prev: null });
  // 100 pt to 103 pt is 4 board px, within the 6 px snap distance at zoom 1: the box moves right by 3 pt.
  assert.equal(snapped(q(1)).dx, 3);
  assert.equal(snapped(q(1)).hits.x.cls, 'edge');
  // At zoom 4 the same 4 board px are 16 screen px, over the 6 px distance, and the zoomed snap distance is 1.5 px.
  assert.equal(snapped(q(4)).dx, 0);
});

test('equal spacing: a third box whose gap is 24 px snaps to a neighbour gap of 20 px', () => {
  // In board px: a 0..120, b 140..260 (gap 20), c 284..404 (gap 24).
  const store = boardWith([shape('a', 0, 0, 90, 60), shape('b', 105, 0, 90, 60), shape('c', 213, 0, 90, 60)]);
  const q = queryOf({ box: { x: 213, y: 0, w: 90, h: 60 }, lines: ALL, store, skip: ['c'], view: VIEW,
    rules: { ...RULES, spacing: true }, zoom: 1, prev: null });
  const s = snapped(q);
  assert.equal(s.hits.x.cls, 'spacing');
  assert.equal(s.dx, -3); // 4 board px left, so c's gap from b is the 20 px one
});

test('targetsOf leaves out hidden items, connectors and off-screen items, and keeps locked ones', () => {
  const store = boardWith([
    shape('a', 0, 0),
    { ...shape('h', 200, 0), hidden: true },
    { id: 'c', type: 'connector', x: 0, y: 0, w: 50, h: 50 },
    { ...shape('l', 300, 0), locked: true },
    { id: 'd', type: 'doc', x: 0, y: 900, w: 200, h: 200 },
    shape('far', 200_000, 0),
  ]);
  assert.deepEqual(targetsOf(store, [], VIEW).map((t) => t.id), ['a', 'l']);
  assert.deepEqual(targetsOf(store, ['a'], VIEW).map((t) => t.id), ['l']);
  // px, turned bounds: from look.mjs's toPx.
  assert.deepEqual(targetsOf(store, [], VIEW)[0], { id: 'a', x: 0, y: 0, w: 13.333333, h: 13.333333 });
});

test('a moved group does not snap to its own children, nor a child to its group', () => {
  const store = boardWith([
    { id: 'g', type: 'group', at: [null, 'g'] },
    { ...shape('c1', 0, 0, 50, 50), at: ['g', 'a'] },
    { ...shape('c2', 100, 0, 50, 50), at: ['g', 'b'] },
    shape('far', 800, 800, 10, 10),
  ]);
  const ctx = contextFor(store);
  // The group's union box is 0..150: dragged 3 pt right, its own children's edges are 4 board px from its lines.
  assert.equal(snapTool.moveFrame(ctx, ['g'], 3, 0, {}).dx, 3);
  // And c1 dragged inside the group: its group's union box reads c1's start position.
  assert.equal(snapTool.moveFrame(ctx, ['c1'], 3, 0, {}).dx, 3);
});

test('a snapped delta lands on its target, with no residue from the px round trip', () => {
  // 1 pt is 1.333333 px: the target at 4.000001 pt sits 4.000002 px away, which came back as 3.000002 pt unrounded.
  const store = boardWith([shape('a', 4.000001, 0)]);
  const q = queryOf({ box: { x: 1, y: 0, w: 10, h: 10 }, lines: ALL, store, skip: [], view: VIEW, rules: RULES, zoom: 1,
    prev: null });
  const s = snapped(q);
  assert.equal(s.dx, 3); // on the 1e-4 pt grid
  assert.ok(Math.abs(1 + s.dx - 4.000001) <= 1e-4, String(1 + s.dx)); // on the target to 1e-4 pt
});

test('the target list is built once a drag, not a frame', () => {
  const items = [];
  for (let i = 0; i < 2000; i++) items.push(shape(`i${i}`, (i % 50) * 60, Math.floor(i / 50) * 60, 40, 40));
  const store = boardWith(items);
  const ctx = contextFor(store);
  const live = store.live.bind(store);
  let builds = 0;
  store.live = () => {
    builds++;
    return live();
  };
  const frame = () => {
    const t0 = performance.now();
    snapTool.moveFrame(ctx, ['i7'], 3, 0, {});
    return performance.now() - t0;
  };
  const frames = Array.from({ length: 10 }, frame);
  // npm test runs every file at once, so the time is printed and the count is asserted (word-agent-guards.test.mjs); the
  // drag's frame budget is checked in the bd-snap harness case.
  console.log(`snap frames over 2,000 items: ${frames.map((t) => t.toFixed(2)).join(' ')} ms`);
  assert.equal(builds, 1);
  // A change to the store (a peer's item, an undo) rebuilds it for the next frame.
  store.change('Add', (tx) => tx.create({ type: 'shape', x: 9000, y: 9000, w: 10, h: 10, at: [null, 'z'] }));
  frame();
  assert.equal(builds, 2);
});

test('a rotated item is a target by its turned bounds', () => {
  const store = boardWith([{ ...shape('t', 0, 0, 100, 100), rot: 45 }]);
  const [target] = targetsOf(store, [], VIEW);
  const side = 100 * Math.SQRT2; // the turned square's side: 141.42 pt, 188.56 px
  assert.ok(Math.abs(target.w - side * (4 / 3)) < 0.001, JSON.stringify(target));
  assert.ok(target.x < 0 && target.y < 0, JSON.stringify(target)); // the turned square reaches past its own corners
});

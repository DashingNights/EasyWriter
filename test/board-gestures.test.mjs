// bd-select (docs/plans/board/briefs/bd-select.md): the pure gestures and the tool registry. Expected values are Figma's and the
// brief's, never this code's own output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxOf, dragIds, edgeDepth, moved, resized, rotated, turnedBox, unionBox } from '../src/board/gestures.mjs';
import { registerTool, tools } from '../src/board/tools/registry.js';

test('resized holds the opposite corner, keeps the aspect for shift and the centre for alt', () => {
  const start = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(resized(start, 'se', 10, 10, {}), { x: 0, y: 0, w: 110, h: 60, flipX: false, flipY: false });
  assert.deepEqual(resized(start, 'se', 10, 10, { shift: true }), { x: 0, y: 0, w: 120, h: 60, flipX: false, flipY: false });
  assert.deepEqual(resized(start, 'se', 10, 10, { alt: true }), { x: -10, y: -10, w: 120, h: 70, flipX: false, flipY: false });
});

test('a resize past the opposite edge flips', () => {
  assert.deepEqual(resized({ x: 0, y: 0, w: 100, h: 50 }, 'e', -150, 0, {}), { x: -50, y: 0, w: 50, h: 50, flipX: true, flipY: false });
});

test('a shifted move locks the smaller axis', () => {
  assert.deepEqual(moved({ x: 5, y: 7 }, 10, 3, { shift: true }), { x: 15, y: 7 });
});

test('shift snaps rotation to fifteen degrees', () => {
  const from = { x: 1, y: 0 };
  const at = (deg) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
  assert.equal(rotated(0, { x: 0, y: 0 }, from, at(37), { shift: true }), 30);
  assert.equal(rotated(0, { x: 0, y: 0 }, from, at(38), { shift: true }), 45);
});

test('a turned box is its corners turned about its centre', () => {
  assert.deepEqual(turnedBox({ x: 0, y: 0, w: 100, h: 50 }, 90), { x: 25, y: -25, w: 50, h: 100 });
});

test('tools register in order, the first pick wins, and a module with no hooks breaks nothing', () => {
  registerTool({ pick: () => 'first' });
  registerTool({ pick: () => 'second' });
  assert.equal(tools.first('pick'), 'first');
  registerTool({});
  assert.equal(tools.first('down'), null);
  assert.doesNotThrow(() => tools.all('move'));
});

test('a moveFrame sees the delta the one before it adjusted', () => {
  registerTool({ moveFrame: (ctx, ids, dx, dy) => ({ dx: dx + 5, dy }) });
  registerTool({ moveFrame: (ctx, ids, dx) => ({ dx: dx * 2, dy: 0 }) });
  assert.deepEqual(tools.frame(null, [], 10, 3, null), { dx: 30, dy: 0 });
});

test('a group box is the union of its children', () => {
  const a = { id: 'a', type: 'shape', x: 0, y: 0, w: 100, h: 50 };
  const b = { id: 'b', type: 'shape', x: 200, y: 100, w: 40, h: 40 };
  const store = { children: (id) => (id === 'g' ? [a, b] : []) };
  assert.deepEqual(boxOf({ id: 'g', type: 'group' }, store), { x: 0, y: 0, w: 240, h: 140 });
});

test('a group with no live children has no box, and a union skips it instead of stretching to the origin', () => {
  const empty = { children: () => [] };
  assert.equal(boxOf({ id: 'g', type: 'group' }, empty), null);
  assert.equal(turnedBox(null, 30), null);
  assert.deepEqual(unionBox([null, { x: 10, y: 20, w: 30, h: 40 }]), { x: 10, y: 20, w: 30, h: 40 });
});

test('a drag names its items for the end hook, a turn by its base', () => {
  assert.deepEqual(dragIds({ kind: 'move', ids: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(dragIds({ kind: 'resize', id: 'a' }), ['a']);
  assert.deepEqual(dragIds({ kind: 'rotate', base: { a: {}, b: {} } }), ['a', 'b']);
  assert.deepEqual(dragIds({ kind: 'marquee' }), []);
});

test('the edge pan speed stops at its top however far past the edge the pointer is', () => {
  assert.equal(edgeDepth(0, 8), 0);
  assert.equal(edgeDepth(-4, 8), 0.5);
  assert.equal(edgeDepth(3000, 8), 1);
});

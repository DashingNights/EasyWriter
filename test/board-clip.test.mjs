// bd-clip (docs/plans/board/briefs/bd-clip.md): the copied fields cloneItems makes, where a paste lands, and the board's
// clipboard over a store: a connector end outside the copy, a paste's keys, the text cap and the Alt+drag repeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import clip, { capText, cloneItems, inField, pasteSpot } from '../src/board/tools/clip.js';
import { PlaneBoard } from '../src/board/api.js';
import { after } from '../src/board/order.mjs';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import '../src/board/tools/index.js'; // the tool modules as the app registers them

const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};

const CLIENT = { id: 'test', call: async () => false };
const SURFACES = { sync: async () => [], preview: async () => [], stampOf: () => null };

/** createSelection (Selection.jsx) as api.js reads it: ids, set, clear and subscribe. */
function createSelection() {
  const ids = new Set();
  const subs = new Set();
  const bump = () => { for (const fn of [...subs]) fn(); };
  return {
    get ids() { return [...ids]; },
    has: (id) => ids.has(id),
    set(next) { ids.clear(); for (const id of next ?? []) ids.add(id); bump(); },
    clear() { ids.clear(); bump(); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** A board with `items` created in one step: [{id, at (its order key), ...fields}]. */
function plane(items = []) {
  const store = new BoardStore(blankBoard(), { client: 'test' });
  if (items.length) store.change('Add', (tx) => { for (const { at = 'V', ...fields } of items) tx.create({ ...fields, at: [null, at] }); });
  const selection = createSelection();
  const board = new PlaneBoard({ store, selection, vp: null, surfaces: SURFACES, client: CLIENT, draft: { id: 'd1' } });
  return { board, store, selection };
}

const rect = (id, x, y, w = 20, h = 10) => ({ id, type: 'shape', kind: 'rectangle', x, y, w, h, fill: [255, 0, 0], stroke: null });

test('a group with two children clones to three new ids and the children name the new group', () => {
  const items = [
    { id: 'g', type: 'group', at: [null, 'V'] },
    { id: 'c1', type: 'shape', kind: 'rectangle', at: ['g', 'F'], x: 0, y: 0, w: 10, h: 10, _s: { x: [3, 'peer'] } },
    { id: 'c2', type: 'shape', kind: 'rectangle', at: ['g', 'V'], x: 20, y: 0, w: 10, h: 10 },
  ];
  const out = cloneItems(items, { newId: ids(), keyAfter: after });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((i) => i.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(out[0].at, [null, 'W']); // above the copied group, the topmost selected item
  assert.deepEqual([out[1].at, out[2].at], [['n1', 'F'], ['n1', 'V']]);
  assert.deepEqual(items[1].at, ['g', 'F']); // the selection itself is untouched
  assert.equal(out[1]._s, undefined);
});

test('a connector points at copied items and its free ends move with them', () => {
  const a = { id: 'a', type: 'shape', kind: 'rectangle', at: [null, 'F'], x: 0, y: 0, w: 10, h: 10 };
  const b = { id: 'b', type: 'shape', kind: 'rectangle', at: [null, 'V'], x: 100, y: 0, w: 10, h: 10 };
  const k = { id: 'k', type: 'connector', at: [null, 'W'], from: { item: 'a', anchor: [1, 0.5] }, to: { x: 100, y: 5 } };
  const both = cloneItems([a, b, k], { dx: 16, dy: 16, newId: ids(), keyAfter: after });
  const copy = both.find((i) => i.type === 'connector');
  assert.deepEqual([copy.from.item, copy.from.anchor], ['n1', [1, 0.5]]);
  assert.deepEqual(copy.to, { x: 116, y: 21 }); // a free end goes with the copy
  assert.deepEqual(both.map((i) => i.at[1]), ['X', 'Y', 'Z']); // in order above W, the topmost copied item
});

test('pasteSpot offsets a box in view by 16 pt and centres one outside it', () => {
  assert.deepEqual(pasteSpot({ x: 100, y: 100, w: 10, h: 10 }, { x: 0, y: 0, w: 500, h: 500 }), { dx: 16, dy: 16 });
  const far = pasteSpot({ x: 10000, y: 10000, w: 10, h: 10 }, { x: 0, y: 0, w: 500, h: 500 });
  assert.deepEqual(far, { dx: -9755, dy: -9755 });
  assert.deepEqual([10000 + far.dx + 5, 10000 + far.dy + 5], [250, 250]); // the copy's centre is the view's centre
});

test('a connector end bound outside the copy pastes as a free point on that item', () => {
  const { board, store, selection } = plane([
    rect('a', 0, 0),
    rect('b', 500, 500, 40, 20),
    { id: 'k', type: 'connector', at: 'W', from: { item: 'a', anchor: [1, 0.5] }, to: { item: 'b', anchor: [1, 0.5] } },
  ]);
  selection.set(['a', 'k']);
  board.copyItem();
  board.pasteItem();
  const copy = store.live().filter((i) => i.type === 'connector').at(-1);
  assert.notEqual(copy.from.item, 'a'); // the copied end names the new copy
  assert.deepEqual(copy.to, { x: 540, y: 510 }); // b was not copied: the right middle of its box, not (0, 0)
});

test('two pastes give distinct keys above the original, the later on top', () => {
  const { board, store, selection } = plane([rect('a', 0, 0)]);
  selection.set(['a']);
  board.copyItem();
  board.pasteItem();
  board.pasteItem();
  const keys = store.children(null).map((item) => item.at[1]);
  assert.deepEqual(keys, ['V', 'W', 'X']);
});

test('a pasted text stops at 20,000 characters and says so', () => {
  const long = 'x'.repeat(20005);
  assert.deepEqual(capText(long), { text: long.slice(0, 20000), cut: true });
  assert.deepEqual(capText('short'), { text: 'short', cut: false });
});

test('a paste in a field or while editing is not the board\'s', () => {
  assert.equal(inField({ nodeType: 1, tagName: 'INPUT' }), true);
  assert.equal(inField({ nodeType: 1, tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(inField({ nodeType: 1, tagName: 'DIV', getAttribute: () => 'textbox' }), true);
  assert.equal(inField({ nodeType: 1, tagName: 'DIV', closest: () => ({}) }), true);
  assert.equal(inField({ nodeType: 1, tagName: 'DIV' }), false);
  const data = { getData: (type) => (type === 'text/plain' ? 'hello' : '') };
  assert.equal(clip.paste({ api: { editing: true } }, data), false);
  const { board, store } = plane([]);
  assert.equal(clip.paste({ api: board }, data), true);
  assert.deepEqual(store.live().map((item) => item.type), ['text']);
});

test('Ctrl+D repeats the Alt+drag offset only while that selection is in hand', () => {
  const { board, store, selection } = plane([rect('a', 0, 0), rect('b', 200, 0)]);
  const ctx = { api: board, selection, store };
  selection.set(['a']);
  selection.lastDrop = { altKey: true };
  clip.transform(ctx, ['a'], { kind: 'move', delta: { dx: 30, dy: 30 } });
  const alt = store.live().filter((i) => i.type === 'shape').at(-1);
  assert.deepEqual([alt.x, alt.y], [30, 30]);
  board.duplicate();
  const repeated = store.live().filter((i) => i.type === 'shape').at(-1);
  assert.deepEqual([repeated.x, repeated.y], [60, 60]); // the same offset again
  selection.set(['b']);
  board.duplicate();
  const shapes = store.live().filter((i) => i.type === 'shape' && i.id !== 'a' && i.id !== 'b');
  assert.equal(shapes.length, 3);
  assert.ok(shapes.some((i) => i.x === 200 && i.y === 0), 'a new selection copies in place');
});

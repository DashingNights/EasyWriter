// bd-layers (docs/plans/board/briefs/bd-layers.md): groups as items, the plane board's layer tree, rename, reorder and the
// selection's scope, checked in node against the real store and registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaneBoard } from '../src/board/api.js';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import { ruleOf } from '../src/board/surfaces.mjs';
import { nameOf } from '../src/board/tools/layers.js';
import { tools } from '../src/board/tools/registry.js';
import '../src/board/tools/index.js'; // the tool modules as the app registers them (a mode, a hook, a method from each)

const CLIENT = { id: 'test', call: async () => false };
const SURFACES = { sync: async () => [], preview: async () => [], stampOf: () => null, drop: async () => [] };

/** createSelection (Selection.jsx) as the board reads it: ids, hover, scope, set, clear and subscribe. */
function createSelection() {
  const ids = new Set();
  const subs = new Set();
  const bump = () => { for (const fn of [...subs]) fn(); };
  return {
    scope: null,
    get ids() { return [...ids]; },
    has: (id) => ids.has(id),
    set(next) { ids.clear(); for (const id of next ?? []) ids.add(id); bump(); },
    add(next) { for (const id of next ?? []) ids.add(id); bump(); },
    toggle(id) { if (ids.has(id)) ids.delete(id); else ids.add(id); bump(); },
    clear() { ids.clear(); bump(); },
    hover: null,
    setHover(id) { this.hover = id ?? null; },
    setPreview() {},
    setMarquee() {},
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const rect = (id, at, x = 0, y = 0) => ({ id, type: 'shape', kind: 'rectangle', at: [null, at], x, y, w: 20, h: 10, fill: [255, 0, 0], stroke: null });

/** A board with `items` created in one step, its selection and its board. */
function plane(items = []) {
  const store = new BoardStore(blankBoard(), { client: 'test' });
  if (items.length) store.change('Add', (tx) => { for (const fields of items) tx.create(fields); });
  const selection = createSelection();
  const board = new PlaneBoard({ store, selection, vp: null, surfaces: SURFACES, client: CLIENT, draft: { id: 'd1' } });
  const ctx = { api: board, store, selection, vp: null, client: CLIENT, item: null, surfaces: SURFACES, draft: { id: 'd1' }, journal: null };
  return { board, store, selection, ctx };
}

const order = (store) => store.live().map((item) => item.id);

test('group puts the selection in a group item and keeps their paint order', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  const steps = store.steps.length;
  assert.equal(board.group(), true);
  assert.equal(store.steps.length, steps + 1, 'one undo step');
  const group = store.live().find((item) => item.type === 'group');
  assert.ok(group, 'a group item is on the board');
  assert.deepEqual(store.get('a').at[0], group.id);
  assert.deepEqual(store.get('b').at[0], group.id);
  assert.deepEqual(store.live().filter((item) => item.at[0] === group.id).map((item) => item.id), ['a', 'b'], 'paint order among the members holds');
  assert.deepEqual([...board.sel], [group.id], 'the group is selected');
  assert.equal(board.canUngroup(), true);

  store.undo();
  assert.deepEqual(store.get('a').at, [null, 'A'], 'undo restores the member\'s place');
  assert.deepEqual(store.get('b').at, [null, 'B']);
  assert.equal(store.get(group.id).gone, true);
});

test('ungroup puts the children back between the group\'s neighbours', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  selection.set([group.id]);
  assert.equal(board.group(false), true);
  assert.deepEqual(order(store), ['a', 'b', 'c'], 'the members sit where the group was');
  assert.equal(store.get(group.id).gone, true);
  assert.deepEqual(store.get('a').at[0], null);
  assert.deepEqual([...board.sel].sort(), ['a', 'b']);
});

test('a group\'s resize, turn and flip write nothing; its move still carries the children', () => {
  const { board, store, selection, ctx } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  const ids = [group.id, 'a', 'b'];
  const fields = { [group.id]: { x: 0, y: 0, w: 200, h: 60 }, a: { x: 0, y: 0, w: 200, h: 60 }, b: { x: 0, y: 0, w: 200, h: 60 } };
  assert.equal(tools.first('transform', ctx, ids, { kind: 'resize', fields }), null, 'a resize gets no answer');
  assert.equal(tools.first('transform', ctx, ids, { kind: 'rotate', fields }), null);
  assert.equal(tools.first('transform', ctx, ids, { kind: 'flip', fields }), null);
  assert.deepEqual(tools.first('transform', ctx, ids, { kind: 'move', fields }), [['a', fields.a], ['b', fields.b]], 'a move writes the children, not the group');
});

test('an Alt+drag is left to bd-clip\'s duplicate', () => {
  const { board, store, selection, ctx } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  const ids = [group.id, 'a', 'b'];
  const fields = { [group.id]: { x: 0, y: 0 }, a: { x: 20, y: 0 }, b: { x: 20, y: 0 } };
  tools.frame(ctx, ids, 20, 0, { altKey: true }); // the drag's last frame held Alt: the drop is a duplicate
  assert.equal(tools.first('transform', ctx, ids, { kind: 'move', fields }), null, 'this module stands aside');
  tools.frame(ctx, ids, 20, 0, {}); // Alt released: a plain move is this module's again
  assert.deepEqual(tools.first('transform', ctx, ids, { kind: 'move', fields }), [['a', fields.a], ['b', fields.b]]);
});

test('tree lists rows topmost first and counts depth', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  const rows = board.tree(new Set([group.id]));
  assert.deepEqual(rows.map((row) => row.id), ['c', group.id, 'b', 'a'], 'topmost first, the group\'s members under it');
  assert.deepEqual(rows.map((row) => row.depth), [0, 0, 1, 1]);
  assert.equal(rows[1].type, 'group');
  assert.equal(rows[1].open, true);
  assert.deepEqual(board.tree().map((row) => row.id), ['c', group.id], 'a collapsed group shows one row');

  selection.set(['a']);
  assert.equal(board.tree(new Set([group.id])).find((row) => row.id === 'a').selected, true);
});

test('layer names come from the item\'s type', () => {
  assert.equal(nameOf({ type: 'shape', kind: 'rectangle' }), 'Rectangle');
  assert.equal(nameOf({ type: 'shape', kind: 'ellipse' }), 'Ellipse');
  assert.equal(nameOf({ type: 'shape', kind: 'line', extra: { arrowEnd: true } }), 'Arrow');
  assert.equal(nameOf({ type: 'shape', kind: 'line' }), 'Line');
  assert.equal(nameOf({ type: 'text', story: { blocks: [{ kind: 'para', text: 'Ship it today, then the rest.' }] } }), 'Ship it today, then the');
  assert.equal(nameOf({ type: 'picture' }), 'Picture');
  assert.equal(nameOf({ type: 'group' }), 'Group');
  assert.equal(nameOf({ type: 'shape', kind: 'rectangle', name: 'Card' }), 'Card', 'a stored name wins');
});

test('moveLayer into the item\'s own descendant changes nothing', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  const before = store.toJSON();
  const steps = store.steps.length;
  assert.equal(board.moveLayer(group.id, 'a', null), false);
  assert.equal(store.steps.length, steps, 'no step was written');
  assert.deepEqual(store.toJSON().items, before.items);
});

test('moveLayer reorders a row and reparents it into a group', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  // c before the group: the bottom of the paint order.
  assert.equal(board.moveLayer('c', null, group.id), true);
  assert.deepEqual(order(store), ['c', group.id, 'a', 'b']);
  // c into the group, last inside it.
  assert.equal(board.moveLayer('c', group.id, null), true);
  assert.deepEqual(store.get('c').at[0], group.id);
  assert.deepEqual(order(store).at(-1), 'c');
});

test('renameLayer is one step and undo restores the old name', () => {
  const { board, store, selection } = plane([rect('a', 'A')]);
  selection.set(['a']);
  const steps = store.steps.length;
  assert.equal(board.renameLayer('a', '  Left card '), true);
  assert.equal(store.get('a').name, 'Left card');
  assert.equal(store.steps.length, steps + 1);
  store.undo();
  assert.equal(store.get('a').name, undefined);
  assert.equal(board.renameLayer('a', ''), false, 'an empty name changes nothing');
  assert.equal(board.renameLayer('a', 'x'.repeat(250)), true);
  assert.equal(store.get('a').name.length, 200, 'a name stops at 200 characters');
});

test('moving the last child out takes its group in the same step', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  assert.equal(board.moveLayer('a', null, null), true);
  assert.equal(store.get(group.id).gone ?? false, false, 'one child left: the group stays');
  const steps = store.steps.length;
  assert.equal(board.moveLayer('b', null, null), true);
  assert.equal(store.get(group.id).gone, true, 'the emptied group went in the move\'s own step');
  assert.equal(store.steps.length, steps + 1);
  assert.deepEqual(store.live().filter((item) => item.type === 'group' && !store.children(item.id).length), [], 'no live group is empty');
  store.undo();
  assert.equal(store.get(group.id).gone ?? false, false, 'undo brings the group and its child back where they were');
});

test('grouping members out of their groups takes the emptied ones in the same step', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  board.group();
  const first = store.live().find((item) => item.type === 'group');
  const steps = store.steps.length;
  selection.set(['a', 'b', 'c']);
  assert.equal(board.group(), true);
  assert.equal(store.steps.length, steps + 1, 'one step');
  assert.equal(store.get(first.id).gone, true, 'the group they left had no children left');
  assert.deepEqual(store.live().filter((item) => item.type === 'group' && !store.children(item.id).length), [], 'no live group is empty');
});

test('a group with no live children derives no box (a merge can leave one)', () => {
  const { store } = plane([rect('a', 'A')]);
  let empty = null;
  store.change('Add a merged group', (tx) => { empty = tx.create({ type: 'group', at: [null, 'Z'] }); });
  assert.equal(ruleOf('group').derive(store.get(empty), store), null, 'no box at the origin');
  const { board, selection } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = board.store.live().find((item) => item.type === 'group');
  const box = ruleOf('group').derive(group, board.store);
  assert.deepEqual(box, { x: 0, y: 0, w: 20, h: 10 }, 'a group with children keeps their union');
});

test('a group left with one child stays, and the last child\'s removal takes it in the same step', () => {
  const { board, store, selection } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  selection.set(['a']);
  board.removeItem();
  assert.equal(store.get(group.id).gone ?? false, false, 'a group of one stays a group');
  selection.set(['b']);
  board.removeItem();
  assert.equal(store.get(group.id).gone, true, 'the emptied group went with the last child');
  store.undo();
  assert.equal(store.get('b').gone, false, 'one undo brings the child and its group back');
  assert.equal(store.get(group.id).gone, false);
});

test('a double-click steps into a group and Esc steps back out', () => {
  const { board, store, selection, ctx } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  selection.set([group.id]);

  assert.equal(tools.first('dblclick', ctx, { kind: 'item', id: 'b', item: store.get('b') }, {}), true);
  assert.equal(selection.scope, group.id, 'the group is entered');
  assert.deepEqual([...board.sel], ['b'], 'the child under the pointer is selected');

  // A press on the other child selects it directly.
  assert.equal(tools.first('down', ctx, { kind: 'item', id: 'a', item: store.get('a') }, { button: 0, shiftKey: false }), true);
  assert.deepEqual([...board.sel], ['a']);

  assert.equal(tools.first('keydown', ctx, { code: 'Escape' }), true);
  assert.equal(selection.scope, null, 'Esc steps out');
  assert.deepEqual([...board.sel], [group.id], 'the group is the selection again');

  // A press outside the group steps out too.
  selection.scope = group.id;
  selection.set(['a']);
  assert.equal(tools.first('down', ctx, { kind: 'item', id: 'b', item: store.get('b') }, { button: 0, shiftKey: false }), true);
  assert.deepEqual([...board.sel], ['b'], 'a press on a sibling inside the scope selects it, not the group');
  selection.scope = group.id;
  assert.equal(tools.first('down', ctx, {}, { button: 0 }), null);
  assert.equal(selection.scope, null, 'a press on the empty plane steps out');
});

test('Enter selects a group\'s children and Tab goes to the next sibling', () => {
  const { board, store, selection, ctx } = plane([rect('a', 'A'), rect('b', 'B'), rect('c', 'C')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  selection.set([group.id]);
  assert.equal(tools.first('keydown', ctx, { code: 'Enter' }), true);
  assert.deepEqual([...board.sel].sort(), ['a', 'b']);
  assert.equal(selection.scope, group.id);

  // Inside the group Tab goes to the next sibling; at the top level bd-a11y reads the board in reading order.
  selection.scope = group.id;
  selection.set(['a']);
  assert.equal(tools.first('keydown', ctx, { code: 'Tab' }), true);
  assert.deepEqual([...board.sel], ['b']);
  selection.scope = null;
  selection.set(['a']);
  assert.equal(tools.first('keydown', ctx, { code: 'Tab' }), null);
});

test('can answers for the methods this package fills', () => {
  const { board } = plane();
  assert.equal(board.can('group'), true);
  assert.equal(board.can('canUngroup'), true);
  assert.equal(typeof board.renameItem, 'function');
  assert.equal(board.can('straighten'), false, 'a later package\'s method still shows disabled');
  assert.equal(board.can('align'), true, 'the ones that work are untouched');
});

test('a locked group\'s child is not picked', () => {
  const { board, store, selection, ctx } = plane([rect('a', 'A'), rect('b', 'B')]);
  selection.set(['a', 'b']);
  board.group();
  const group = store.live().find((item) => item.type === 'group');
  store.change('Lock', (tx) => tx.set(group.id, 'locked', true));
  // The vp's placements: the two members' boxes.
  ctx.vp = { camera: { zoom: 1 }, placements: [
    { key: 'a', x: 0, y: 0, w: 20, h: 10 }, { key: 'b', x: 100, y: 0, w: 20, h: 10 },
  ] };
  assert.deepEqual(tools.first('pick', ctx, { x: 5, y: 5 }, {}), { kind: 'locked' }, 'a press on a locked group\'s child is blocked');
  assert.equal(tools.first('pick', ctx, { x: 300, y: 300 }, {}), null, 'a press on the empty plane is not');
});

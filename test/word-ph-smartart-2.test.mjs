// ph-smartart-2 (docs/plans/word/briefs/ph-smartart-2.md): the diagram outline edits, the layout and colour tables and the
// Diagram Design rows on a canvas draft. Pure: no engine build needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_COMMANDS } from '../src/document/canvas/commands.mjs';
import { CATEGORIES, COLORS, LAYOUTS } from '../src/document/canvas/smart-art/layouts.mjs';
import { MAX_ITEMS, addAbove, addAfter, addBefore, addBelow, canDemote, canPromote, commitText, moveAfter, moveBefore, removeItem } from '../src/document/canvas/smart-art/outline.mjs';
import { pickItem } from '../src/document/canvas/smart-art/state.mjs';

const FEATURES = [
  'insert.illustrations.smartArt',
  'smartArtDesign.createGraphic.addShape',
  'smartArtDesign.createGraphic.addShape.addShapeAfter',
  'smartArtDesign.createGraphic.addShape.addShapeBefore',
  'smartArtDesign.createGraphic.addShape.addShapeAbove',
  'smartArtDesign.createGraphic.addShape.addShapeBelow',
  'smartArtDesign.createGraphic.addBullet',
  'smartArtDesign.createGraphic.textPane',
  'smartArtDesign.createGraphic.promote',
  'smartArtDesign.createGraphic.demote',
  'smartArtDesign.createGraphic.moveBefore',
  'smartArtDesign.createGraphic.moveAfter',
  'smartArtDesign.layouts.layouts',
  'smartArtDesign.layouts.layouts.moreLayouts',
  'smartArtDesign.smartArtStyles.changeColors',
];

/** 'A:0 a:1 B:0' → the outline [{text: 'A', level: 0}, {text: 'a', level: 1}, {text: 'B', level: 0}]. */
const items = (s) => s.split(' ').map((t) => {
  const k = t.lastIndexOf(':');
  return { text: t.slice(0, k), level: Number(t.slice(k + 1)) };
});
const text = (list) => list.map((it) => `${it.text}:${it.level}`).join(' ');

test('the fifteen ids have a row in ENGINE_COMMANDS', () => {
  for (const id of FEATURES) assert.ok(ENGINE_COMMANDS[id], `${id} has a row`);
});

test('addAfter puts a new item after the picked item and everything under it', () => {
  const r = addAfter(items('A:0 a:1 B:0'), 0);
  assert.equal(text(r.items), 'A:0 a:1 :0 B:0');
  assert.equal(r.at, 2);
  assert.equal(text(addAfter(items('A:0 a:1 B:0'), null).items), 'A:0 a:1 B:0 :0', 'nothing picked: the end');
});

test('addBefore puts a new item just before the picked one', () => {
  const r = addBefore(items('A:0 a:1 B:0'), 2);
  assert.equal(text(r.items), 'A:0 a:1 :0 B:0');
  assert.equal(r.at, 2);
  assert.equal(text(addBefore(items('A:0'), null).items), ':0 A:0', 'nothing picked: the start');
});

test('addAbove stands a new item where the picked one was and pushes its block down a level', () => {
  const r = addAbove(items('A:0 B:1 C:2 D:1'), 1);
  assert.equal(text(r.items), 'A:0 :1 B:2 C:3 D:1');
  assert.equal(r.at, 1);
  assert.equal(addAbove(items('A:0'), null), null, 'nothing picked');
});

test('addBelow puts a last child under the picked item', () => {
  const r = addBelow(items('A:0 a:1 B:0'), 0);
  assert.equal(text(r.items), 'A:0 a:1 :1 B:0');
  assert.equal(r.at, 2);
});

test('moveBefore swaps the item block with the sibling before it', () => {
  const r = moveBefore(items('A:0 a:1 B:0'), 2);
  assert.equal(text(r.items), 'B:0 A:0 a:1');
  assert.equal(r.at, 0);
  assert.equal(moveBefore(items('A:0 a:1 B:0'), 0), null, 'nothing before it');
  assert.equal(moveBefore(items('A:0'), null), null, 'nothing picked');
});

test('moveAfter swaps the item block with the sibling after it', () => {
  const r = moveAfter(items('A:0 a:1 B:0'), 0);
  assert.equal(text(r.items), 'B:0 A:0 a:1');
  assert.equal(r.at, 1);
  assert.equal(moveAfter(items('A:0 a:1 B:0'), 2), null, 'nothing after it');
});

test('a move keeps the look of the moved items', () => {
  const look = { text: '{"fill":"C00000"}' };
  const list = [{ text: 'A', level: 0, look }, { text: 'B', level: 0 }];
  assert.deepEqual(moveAfter(list, 0).items[1].look, look);
});

test('removeItem keeps the last item and the children of the one it removes', () => {
  assert.equal(removeItem(items('A:0'), 0), null, 'a single item stays');
  const r = removeItem(items('A:0 a:1 B:0'), 0);
  assert.equal(text(r.items), 'a:1 B:0');
  assert.equal(r.at, 0);
});

test('canPromote and canDemote follow the item and the one before it', () => {
  assert.equal(canDemote(items('A:0 B:0'), 0), false, 'the first item has nothing to go under');
  assert.equal(canDemote(items('A:0 B:0'), 1), true);
  assert.equal(canPromote(items('A:0 B:0'), 0), false);
  assert.equal(canPromote(items('A:0 a:1'), 1), true);
  assert.equal(canDemote(items('A:0'), null), false, 'nothing picked');
});

test('the add rows stop at 100 items', () => {
  const full = Array.from({ length: MAX_ITEMS }, (_, i) => ({ text: `i${i}`, level: 0 }));
  assert.equal(addAfter(full, 0), null);
  assert.equal(addBefore(full, 0), null);
  assert.equal(addAbove(full, 0), null);
});

test('a typed text kept in the pane when the engine refuses to write it', async () => {
  const list = items('A:0 B:0');
  const draft = { i: 1, text: 'Hello' };
  assert.deepEqual(await commitText(list, draft, async () => ({ ok: true })), { items: items('A:0 Hello:0'), failed: false });
  assert.deepEqual(await commitText(list, { i: 1, text: 'B' }, async () => ({ ok: true })), { items: null, failed: false },
    'the text is the item\'s already: nothing to write');
  const refused = await commitText(list, draft, async () => ({ ok: false, error: 'a newer version saved it' }));
  assert.deepEqual(refused, { items: null, failed: true }, 'the pane keeps the draft');
  assert.deepEqual(await commitText(list, draft, async () => { throw new Error('the draft closed'); }), { items: null, failed: true },
    'a failed call keeps it too');
});

test('every layout is one the engine knows, and every group is a category', () => {
  const ids = new Set(LAYOUTS.map((l) => l.id));
  assert.deepEqual([...ids].sort(), ['basicList', 'cycle', 'hierarchy', 'matrix', 'process', 'pyramid', 'radial', 'venn']);
  for (const l of LAYOUTS) for (const g of l.groups) assert.ok(CATEGORIES.includes(g), `${g} is a category`);
  assert.equal(new Set(LAYOUTS.map((l) => l.icon)).size, LAYOUTS.length, 'each layout has its own icon');
  assert.deepEqual(COLORS.map((c) => c.id), ['colorful', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']);
});

/** The ctx a row's enabled reads: a selected diagram of `layout` with the outline `list`, and a pick at `pick`. */
const POS = { page: 0, para: 0, off: 0 };
const ctxFor = (layout, list, pick = null) => {
  pickItem(pick == null ? null : POS, pick);
  const spec = { layout, colors: 'colorful', rtl: false, items: list };
  return {
    engine: {},
    obj: { kind: 'smartArt' },
    read: () => ({ pos: POS, w: 400, h: 200, smartArt: { spec, shapes: [] } }),
  };
};

test('Add Shape Above and Below need the hierarchy layout; Add Bullet stays off on it', () => {
  const list = items('A:0 B:0');
  const above = ENGINE_COMMANDS['smartArtDesign.createGraphic.addShape.addShapeAbove'];
  const bullet = ENGINE_COMMANDS['smartArtDesign.createGraphic.addBullet'];
  const after = ENGINE_COMMANDS['smartArtDesign.createGraphic.addShape.addShapeAfter'];
  assert.equal(above.enabled(ctxFor('hierarchy', list, 0)), true);
  assert.equal(above.enabled(ctxFor('basicList', list, 0)), false);
  assert.equal(bullet.enabled(ctxFor('basicList', list, 0)), true);
  assert.equal(bullet.enabled(ctxFor('hierarchy', list, 0)), false);
  assert.equal(after.enabled(ctxFor('basicList', list, 0)), true);
  assert.equal(after.enabled({ ...ctxFor('basicList', list, 0), read: () => ({}) }), false, 'a diagram from another program is off');
});

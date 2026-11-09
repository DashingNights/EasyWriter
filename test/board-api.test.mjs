// bd-api (docs/plans/board/briefs/bd-api.md): PlaneBoard, the Board surface the chrome reads over the engine board's store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlaneBoard, LATER } from '../src/board/api.js';
import { blankModel } from '../src/board/model.mjs';
import { BoardStore, blankBoard } from '../src/board/store.mjs';
import { presetFields } from '../src/board/tools/place.js';
import '../src/board/tools/index.js'; // the tool modules as the app registers them (a mode is armed only by one that draws it)

const CLIENT = { id: 'test', call: async () => false };
const SURFACES = { sync: async () => [], preview: async () => [], stampOf: () => null, drop: async () => [] };

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

/** A board with `items` created in one step: [{id?, type, at (its order key), ...fields}]. */
function plane(items = []) {
  const store = new BoardStore(blankBoard(), { client: 'test' });
  if (items.length) store.change('Add', (tx) => { for (const { at = 'V', ...fields } of items) tx.create({ ...fields, at: [null, at] }); });
  const selection = createSelection();
  const board = new PlaneBoard({ store, selection, vp: null, surfaces: SURFACES, client: CLIENT, draft: { id: 'd1' } });
  return { board, store, selection };
}

const rect = (id, x, y, w = 20, h = 10) => ({ id, type: 'shape', kind: 'rectangle', x, y, w, h, fill: [255, 0, 0], stroke: null });

test('getSnapshot has every key Board.getSnapshot has', () => {
  const source = readFileSync(new URL('../src/whiteboard.js', import.meta.url), 'utf8');
  const start = source.indexOf('  getSnapshot() {');
  assert.ok(start > 0, 'whiteboard.js has Board.getSnapshot');
  const body = source.slice(start, source.indexOf('\n  }', start));
  const keys = [...body.matchAll(/^ {6}(\w+)(?::|,)/gm)].map((m) => m[1]);
  assert.ok(keys.length > 10, `the key list was read (${keys.join(', ')})`);
  const { board } = plane();
  assert.deepEqual(Object.keys(board.getSnapshot()).sort(), keys.sort());
});

test('getSnapshot keeps its object until something in it changes', () => {
  const { board, store } = plane([rect('a', 0, 0)]);
  const first = board.getSnapshot();
  assert.equal(board.getSnapshot(), first, 'the same object is returned each read');
  store.change('Move', (tx) => tx.set('a', 'x', 40));
  assert.equal(board.getSnapshot(), first, 'a change nothing in the snapshot shows keeps it');
  board.setMode('shape');
  const next = board.getSnapshot();
  assert.notEqual(next, first, 'a change the snapshot shows makes a new one');
  assert.equal(next.mode, 'shape');
  assert.equal(next.count, 0);
});

test('setItem on two selected items is one undo step', () => {
  const { board, store, selection } = plane([rect('a', 0, 0), rect('b', 100, 0)]);
  selection.set(['a', 'b']);
  const steps = store.steps.length;
  board.setItem({ color: '#ff0000' });
  assert.equal(store.steps.length, steps + 1);
  assert.deepEqual(store.get('a').stroke, [255, 0, 0]);
  assert.deepEqual(store.get('b').stroke, [255, 0, 0]);
  store.undo();
  assert.equal(store.get('a').stroke, null);
  assert.equal(store.get('b').stroke, null);
});

test('setItem remembers the style for the next item', () => {
  const { board, selection } = plane([rect('a', 0, 0)]);
  selection.set(['a']);
  board.setItem({ fillColor: '#00ff00' });
  assert.deepEqual(board.getSnapshot().shape.fillColor, '#00ff00');
});

test('align left on boxes at x 10 and 30 sets both to 10', () => {
  const { board, store, selection } = plane([rect('a', 10, 0), rect('b', 30, 50)]);
  selection.set(['a', 'b']);
  board.align('left');
  assert.equal(store.get('a').x, 10);
  assert.equal(store.get('b').x, 10);
  assert.equal(store.get('b').y, 50, 'the other axis holds');
});

test('arrange front on the lowest of three makes it last in live()', () => {
  const { board, store, selection } = plane([{ ...rect('a', 0, 0), at: 'A' }, { ...rect('b', 0, 0), at: 'B' }, { ...rect('c', 0, 0), at: 'C' }]);
  assert.deepEqual(store.live().map((i) => i.id), ['a', 'b', 'c']);
  selection.set(['a']);
  board.arrange('front');
  assert.deepEqual(store.live().map((i) => i.id), ['b', 'c', 'a']);
  selection.set(['a']);
  board.arrange('back');
  assert.deepEqual(store.live().map((i) => i.id), ['a', 'b', 'c']);
});

test('removeItem deletes the selection in one step', () => {
  const { board, store, selection } = plane([rect('a', 0, 0), rect('b', 100, 0)]);
  selection.set(['a']);
  const steps = store.steps.length;
  board.removeItem();
  assert.equal(store.steps.length, steps + 1);
  assert.equal(store.live().length, 1);
  assert.deepEqual(selection.ids, []);
});

test('the background is an op: it merges, syncs and undoes', () => {
  const { board, store } = plane();
  const steps = store.steps.length;
  board.setBg('dark');
  assert.equal(store.steps.length, steps + 1, 'one undo step');
  assert.equal(store.board.bg, 'dark');
  assert.ok(store.board._s.bg, 'it carries a stamp');
  assert.ok(store.deltaSince({}).some((o) => o.i === null && o.f === 'bg'), 'a sync carries it');
  const peer = new BoardStore(blankBoard(), { client: 'peer' });
  peer.merge(store);
  assert.equal(peer.board.bg, 'dark', 'a merge carries it');
  const synced = new BoardStore(blankBoard(), { client: 'synced' });
  synced.receive(store.deltaSince({}));
  assert.equal(synced.board.bg, 'dark', 'deltaSince carries it');
  store.undo();
  assert.equal(store.board.bg, 'canvas', 'undo restores it');
});

test('align, distribute and same size keep fractional positions', () => {
  const { board, store, selection } = plane([rect('a', 40, 0, 20, 10), rect('b', 107.5, 0, 21.5, 10), rect('c', 300.25, 5, 30, 10)]);
  selection.set(['a', 'b', 'c']);
  board.align('left');
  assert.deepEqual(['a', 'b', 'c'].map((id) => store.get(id).x), [40, 40, 40], 'align left');

  const even = plane([rect('a', 40, 0, 20, 10), rect('b', 107.5, 0, 21.5, 10), rect('c', 300.25, 5, 30, 10)]);
  even.selection.set(['a', 'b', 'c']);
  even.board.distribute('h');
  assert.deepEqual(['a', 'b', 'c'].map((id) => even.store.get(id).x), [40, 169.375, 300.25], 'equal gaps between the fractional boxes');

  const same = plane([rect('a', 40, 0, 20, 10), { ...rect('b', 107.5, 0, 21.5, 10), rot: 90 }, rect('c', 300.25, 5, 30, 10)]);
  same.selection.set(['a', 'b', 'c']);
  same.board.sameSize('w');
  assert.deepEqual(['a', 'b', 'c'].map((id) => same.store.get(id).w), [30, 30, 30]);
  assert.equal(same.store.get('b').x, 107.5 - (30 - 21.5) / 2, 'a turned item keeps its centre, to the thousandth of a point');
});

test('a later module\'s methods are off until it lands, and a mode no tool draws cannot be armed', () => {
  const { board } = plane();
  const filled = new Set(['group', 'canUngroup', 'editItem']); // bd-layers (and bd-text's editItem) have landed
  for (const name of Object.keys(LATER)) if (!filled.has(name)) assert.equal(board.can(name), false, name);
  assert.equal(board.can('align'), true);
  board.setMode('text'); // bd-text draws with it
  assert.equal(board.mode, 'text');
  board.setMode(null);
  board.setMode('shape');
  assert.equal(board.mode, 'shape');
  board.setMode(null);
  assert.equal(board.mode, null);
});

/** The item session (engine/client.js SessionClient) as presetFields reads it: open, execMany, save, each taking a turn. */
function itemSession() {
  const session = {
    log: [],
    steps: [],
    model: null,
    async open(bytes) {
      session.log.push('open');
      await new Promise((r) => setTimeout(r, 4));
      session.model = JSON.parse(new TextDecoder().decode(bytes));
    },
    async execMany(list) {
      session.log.push('exec');
      await new Promise((r) => setTimeout(r, 4));
      session.steps.push(list);
      session.model.preset = list[1][1];
    },
    async save() {
      session.log.push('save');
      await new Promise((r) => setTimeout(r, 4));
      const [prst, av] = [session.model.preset.preset, session.model.preset.av ?? []];
      return JSON.stringify({ body: [{ objects: [{ kind: 'custom', freeform: { preset: prst }, extra: { preset: [prst, av] } }] }] });
    },
  };
  return session;
}

const BLANK = { body: [], parts: {}, styles: { styles: [] }, numbering: { abstracts: [], nums: [] }, lastSection: { pageW: 612, pageH: 792 } };

test('two presets drawn at once each get their own geometry', async () => {
  blankModel(structuredClone(BLANK));
  const item = itemSession();
  const [pentagon, hexagon] = await Promise.all([
    presetFields({ item }, 'pentagon', [['adj1', 25000]], 100, 80),
    presetFields({ item }, 'hexagon', [], 120, 90),
  ]);
  assert.deepEqual(item.log, ['open', 'exec', 'save', 'open', 'exec', 'save'], 'the shared session takes one preset at a time');
  assert.equal(pentagon.extra.preset[0], 'pentagon');
  assert.deepEqual(pentagon.extra.preset[1], [['adj1', 25000]], 'the adjust values are sent and kept');
  assert.equal(hexagon.extra.preset[0], 'hexagon');
  assert.deepEqual(item.steps[0][1][1], { preset: 'pentagon', av: [['adj1', 25000]] });
});

test('the preset cache keeps the last 64 sizes', async () => {
  blankModel(structuredClone(BLANK));
  const item = itemSession();
  await presetFields({ item }, 'pentagon', [], 10, 10);
  for (let i = 0; i < 64; i++) await presetFields({ item }, 'pentagon', [], 20 + i, 10);
  const cached = item.log.length;
  await presetFields({ item }, 'pentagon', [], 10, 10); // older than the 64 kept: made again
  assert.equal(item.log.length, cached + 3);
  const rebuilt = item.log.length;
  await presetFields({ item }, 'pentagon', [], 10, 10); // kept now
  assert.equal(item.log.length, rebuilt, 'a kept preset is not made again');
});

test('every method pool-board.js calls on the board is on PlaneBoard or in LATER', () => {
  const source = readFileSync(new URL('../src/app/pool-board.js', import.meta.url), 'utf8');
  const calls = new Set([...source.matchAll(/\b(?:b|board|ctx\.board)\.(\w+)\s*\(/g)].map((m) => m[1]));
  assert.ok(calls.size > 15, `the calls were read (${calls.size})`);
  const missing = [...calls].filter((name) => !(name in PlaneBoard.prototype) && !(name in LATER));
  assert.deepEqual(missing, [], `pool-board.js calls ${missing.join(', ')}; PlaneBoard or LATER must have each`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSurfaces, derived, mediaOf, mergeMedia, placementsOf, registerType } from '../src/board/surfaces.mjs';
import { blankModel } from '../src/board/model.mjs';
import { BoardStore, blankBoard } from '../src/board/store.mjs';

/** A red 8 x 8 PNG, base64. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

const BASE = () => blankModel(JSON.parse(readFileSync(new URL('./fixtures/board/shape-model.json', import.meta.url))));

/** A board whose `apply` answers every entry with a stamp: 100 x 50 at the item's corner, unless `stamps` says otherwise. */
function setup(stamps = () => ({})) {
  const calls = [];
  const apply = async (list) => list.map((e) => {
    calls.push(e);
    if (e.gone) return { handle: e.handle, ok: true };
    return { handle: e.handle, ok: true, ox: 0, oy: 0, w: 100, h: 50, textW: 0, textH: 0, ...stamps(e) };
  });
  const store = new BoardStore(blankBoard());
  const surfaces = createSurfaces({ apply, base: BASE(), media: new Map() });
  return { store, surfaces, calls, place: () => placementsOf(store, surfaces, 'board:test', {}) };
}

test('a move sends nothing and moves the placement; a fill sends one model', async () => {
  const { store, surfaces, calls, place } = setup();
  let id;
  store.change('Add', (tx) => {
    id = tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'V'], x: 10, y: 20, w: 100, h: 50, fill: [255, 0, 0] });
  });
  await surfaces.sync(store, new Set([id]));
  assert.equal(calls.length, 1);
  assert.deepEqual([place()[0].x, place()[0].y], [10, 20]);

  store.change('Move', (tx) => tx.set(id, 'x', 60));
  await surfaces.sync(store, new Set([id]));
  assert.equal(calls.length, 1, 'a change of x sends nothing');
  assert.equal(place()[0].x, 60);

  store.change('Fill', (tx) => tx.set(id, 'fill', [0, 0, 255]));
  await surfaces.sync(store, new Set([id]));
  assert.equal(calls.length, 2, 'a change of fill sends one model');
});

test('keys place in order, and an at before the first places that item first', async () => {
  const { store, surfaces, place } = setup();
  const ids = [];
  store.change('Add', (tx) => {
    for (const [key, x] of [['V', 0], ['W', 200], ['X', 400]]) {
      ids.push(tx.create({ type: 'shape', kind: 'rectangle', at: [null, key], x, y: 0, w: 100, h: 50 }));
    }
  });
  await surfaces.sync(store, new Set(ids));
  assert.deepEqual(place().map((p) => p.key), ids);

  store.change('Bring to front', (tx) => tx.set(ids[2], 'at', [null, 'A']));
  await surfaces.sync(store, new Set([ids[2]]));
  assert.deepEqual(place().map((p) => p.key), [ids[2], ids[0], ids[1]]);
});

test('a stamp offset places the item there; a hidden item has none; a gone item sends gone', async () => {
  const { store, surfaces, calls, place } = setup(() => ({ ox: -2, oy: -3 }));
  let id;
  store.change('Add', (tx) => {
    id = tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'V'], x: 10, y: 20, w: 100, h: 50 });
  });
  await surfaces.sync(store, new Set([id]));
  assert.deepEqual([place()[0].x, place()[0].y], [8, 17]);

  const sent = calls.length;
  store.change('Hide', (tx) => tx.set(id, 'hidden', true));
  await surfaces.sync(store, new Set([id]));
  assert.deepEqual(place(), []);
  assert.equal(calls.length, sent, 'hiding sends nothing');

  store.change('Delete', (tx) => tx.remove(id));
  await surfaces.sync(store, new Set([id]));
  assert.deepEqual(calls.at(-1), { handle: calls[0].handle, gone: true });
});

test('a type with derive gets its fields in the model and nothing in the store', async () => {
  registerType('shape', { paints: true, derive: () => ({ w: 42, h: 7 }) });
  const { store, surfaces, calls } = setup();
  let id;
  store.change('Add', (tx) => {
    id = tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'V'], x: 0, y: 0, w: 100, h: 50 });
  });
  await surfaces.sync(store, new Set([id]));
  const model = JSON.parse(new TextDecoder().decode(calls[0].model));
  assert.equal(model.lastSection.pageW, 42);
  assert.equal(model.lastSection.pageH, 7);
  assert.equal(store.get(id).w, 100, 'the derived width is never written back');
  assert.deepEqual(derived(store.get(id), store).w, 42);
});

test('a picture that arrives after the open joins the media and paints', async () => {
  const media = mediaOf({});
  const calls = [];
  const apply = async (list) => list.map((e) => {
    calls.push(e);
    return { handle: e.handle, ok: true, ox: 0, oy: 0, w: 40, h: 40, textW: 0, textH: 0 };
  });
  const store = new BoardStore(blankBoard());
  const surfaces = createSurfaces({ apply, base: BASE(), media });
  let id;
  store.change('Add', (tx) => {
    id = tx.create({ type: 'picture', media: 'p.png', at: [null, 'V'], x: 0, y: 0, w: 40, h: 40 });
  });
  await surfaces.sync(store, new Set([id]));
  assert.equal(JSON.parse(new TextDecoder().decode(calls[0].model)).media?.['p.png'], undefined, 'nothing paints before its bytes');

  assert.deepEqual(mergeMedia(media, { 'p.png': `data:image/png;base64,${PNG}` }), ['p.png']);
  assert.deepEqual(mergeMedia(media, { 'p.png': `data:image/png;base64,${PNG}` }), [], 'each picture is decoded once');
  await surfaces.sync(store, new Set([id]));
  assert.equal(calls.length, 2, 'the picture stamps again once its bytes are in');
  assert.equal(JSON.parse(new TextDecoder().decode(calls[1].model)).media?.['p.png'], PNG);
});

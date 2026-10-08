import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePrefab, parsePrefab, prefabItems, summaryOfPrefab } from '../src/flow/prefab.mjs';
import { resolveConnectors } from '../src/flow/route.mjs';
import { rotBox } from '../src/flow/shapes.mjs';

const ID = '3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21';
const shape = (id, x, y, more = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 100, h: 60, color: '#fff', width: 2, opacity: 1, fill: 'none',
  fillColor: '#000', flipX: false, flipY: false, ...more });
const conn = (id, from, to) => ({ id, type: 'connector', from, to, route: 'straight', heads: { start: 'none', end: 'arrow' }, width: 2, labels: {} });
const routed = (items) => resolveConnectors(items).items; // as a Board holds them

test('makePrefab: the top-left of the bounds (a turned shape by its turned box) at 0,0, ids local', () => {
  const a = shape('a', 200, 100, { rot: 45 });
  const b = shape('b', 400, 300);
  const p = makePrefab([a, b]);
  const ra = rotBox(a);
  const [pa, pb] = p.items;
  assert.equal(pa.id, 'p1');
  assert.equal(pb.id, 'p2');
  assert.equal(pa.x, Math.round(a.x - ra.x)); // the turned box's left edge lands on 0
  assert.equal(pa.y, Math.round(a.y - ra.y));
  assert.equal(pb.x, Math.round(400 - ra.x));
  assert.equal(p.w, Math.round(500 - ra.x));
  assert.equal(p.h, Math.round(360 - ra.y));
  assert.equal(a.x, 200, 'input not mutated');
});

test('makePrefab stores post px (unit 2 and 0.5); prefabItems at another unit keeps the post-px look', () => {
  const items = [shape('a', 40, 40, { w: 200, h: 120, width: 4 }), { id: 't', type: 'text', html: 'Hi', x: 40, y: 200, w: 200, h: 40, size: 40, color: '#fff' }];
  const p2 = makePrefab(items, 2);
  assert.deepEqual([p2.items[0].w, p2.items[0].h, p2.items[0].width, p2.items[1].size, p2.items[1].y], [100, 60, 2, 20, 80]);
  assert.deepEqual([p2.w, p2.h], [100, 100]);
  const p05 = makePrefab(items, 0.5);
  assert.deepEqual([p05.items[0].w, p05.items[0].width, p05.items[1].size], [400, 8, 80]);
  const back = prefabItems(p2, 0.5);
  assert.deepEqual([back[0].w, back[0].h, back[0].width, back[1].size], [50, 30, 1, 10]);
});

test('connectors: bound with remapped ids when both ends were selected, else free at the tip; derived fields dropped', () => {
  const [a, b, c] = [shape('a', 0, 0), shape('b', 300, 0), shape('c', 600, 300)];
  const items = routed([a, b, c, conn('ab', { item: 'a', anchor: [1, 0.5] }, { item: 'b', anchor: [0, 0.5] }), conn('bc', { item: 'b', anchor: null }, { item: 'c', anchor: null })]);
  const tipBC = (() => { const k = items[4]; return { x: k.x + k.tips[1].x, y: k.y + k.tips[1].y }; })();
  const p = makePrefab(items.filter((i) => i.id !== 'c'));
  const byOld = Object.fromEntries(['a', 'b', 'ab', 'bc'].map((id, k) => [id, p.items[k]]));
  assert.deepEqual(byOld.ab.from, { item: byOld.a.id, anchor: [1, 0.5] });
  assert.deepEqual(byOld.ab.to, { item: byOld.b.id, anchor: [0, 0.5] });
  assert.deepEqual(byOld.bc.from, { item: byOld.b.id, anchor: null });
  assert.equal(typeof byOld.bc.to.item, 'undefined');
  assert.deepEqual(byOld.bc.to, { x: tipBC.x, y: tipBC.y }); // the group's top-left was 0,0 already
  for (const k of ['x', 'y', 'w', 'h', 'd', 'tips', 'lps']) assert.ok(!(k in byOld.ab), k);
  // Placed again: routed, still bound to each other.
  const placed = prefabItems(p);
  assert.equal(typeof placed[2].d, 'string');
  assert.equal(placed[2].from.item, placed[0].id);
});

test('parsePrefab repairs and fills defaults; summaryOfPrefab', () => {
  assert.equal(parsePrefab('{'), null);
  assert.equal(parsePrefab({ id: 'nope' }), null);
  const p = parsePrefab(JSON.stringify({
    id: ID, name: 7, keywords: ['ok', 3, 'x'.repeat(41)], thumb: 'data:image/jpeg;base64,AA', w: 'wide',
    items: [shape('a', 0, 0), { id: 'bad', type: 'shape', shape: 'nope' }, conn('k', { item: 'a', anchor: null }, { item: 'gone', anchor: null })],
  }));
  assert.equal(p.name, 'Prefab');
  assert.deepEqual(p.keywords, ['ok']);
  assert.equal(p.thumb, null);
  assert.deepEqual(p.items.map((i) => i.id), ['a', 'k']);
  assert.equal(typeof p.items[1].to.x, 'number'); // a dangling end freed (100 px right of the other end)
  assert.ok(p.w >= 100 && p.h >= 60, JSON.stringify([p.w, p.h])); // recomputed from the items
  assert.deepEqual(summaryOfPrefab(p), { id: ID, name: 'Prefab', keywords: ['ok'], w: p.w, h: p.h, items: 2, thumb: null, created: null, updated: null });
});

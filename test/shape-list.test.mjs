import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRefs, defaultFavourites, liveRefs, moveRef, resetOrder, shapeSections, toggleFavourite } from '../src/app/shape-list.mjs';

const KINDS = [{ kind: 'rect', group: 'basic' }, { kind: 'ellipse', group: 'basic' }, { kind: 'diam', group: 'flow' }, { kind: 'lane', group: 'container' }];
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const PREFABS = [{ id: P1, created: 100 }, { id: P2, created: 200 }];
const refsOf = (sections) => Object.fromEntries(sections.map((s) => [s.id, s.refs]));

test('Favourites first, starred entries only there; new prefabs first in Prefabs; unknown refs skipped', () => {
  const favs = [`prefab:${P1}`, 'kind:diam', 'kind:gone', 'prefab:00000000-0000-4000-8000-000000000000'];
  const order = { prefabs: [`prefab:${P1}`], basic: ['kind:ellipse', 'kind:rect'] };
  const before = JSON.stringify([favs, order]);
  const s = shapeSections(KINDS, PREFABS, favs, order);
  assert.deepEqual(s.map((x) => x.id), ['favourites', 'basic', 'flow', 'container', 'prefabs']);
  assert.deepEqual(refsOf(s), {
    favourites: [`prefab:${P1}`, 'kind:diam'],
    basic: ['kind:ellipse', 'kind:rect'],
    flow: [],
    container: ['kind:lane'],
    prefabs: [`prefab:${P2}`], // P2 is not in the saved order: first; P1 is starred
  });
  assert.deepEqual(s[4].all, [`prefab:${P2}`, `prefab:${P1}`], 'the whole order keeps the starred entry');
  assert.deepEqual(refsOf(shapeSections(KINDS, PREFABS)).prefabs, [`prefab:${P2}`, `prefab:${P1}`], 'default: newest first');
  assert.equal(JSON.stringify([favs, order]), before, 'inputs not mutated');
});

test('toggleFavourite, moveRef before / after, resetOrder, defaultFavourites', () => {
  const favs = ['kind:rect'];
  assert.deepEqual(toggleFavourite(favs, 'kind:diam'), ['kind:rect', 'kind:diam']);
  assert.deepEqual(toggleFavourite(favs, 'kind:rect'), []);
  assert.deepEqual(favs, ['kind:rect']);
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveRef(list, 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveRef(list, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveRef(list, 'x', 'a'), ['x', 'a', 'b', 'c', 'd'], 'a ref from elsewhere is inserted');
  assert.deepEqual(list, ['a', 'b', 'c', 'd']);
  const order = { basic: ['kind:rect'], prefabs: [] };
  assert.deepEqual(resetOrder(order, 'basic'), { prefabs: [] });
  assert.deepEqual(order, { basic: ['kind:rect'], prefabs: [] });
  assert.deepEqual(defaultFavourites([`prefab:${P2}`, 'kind:lane', `prefab:${P1}`, 'kind:rect'], KINDS, PREFABS),
    ['kind:rect', 'kind:lane', `prefab:${P1}`, `prefab:${P2}`]);
});

test('cleanRefs drops deleted prefabs, unknown kinds, repeats and unknown sections', () => {
  const live = liveRefs(KINDS, [PREFABS[0]]);
  const favs = ['kind:rect', `prefab:${P2}`, 'kind:nope', 'kind:rect'];
  const order = { basic: ['kind:ellipse', 'kind:x'], prefabs: [`prefab:${P2}`, `prefab:${P1}`], bogus: ['kind:rect'] };
  assert.deepEqual(cleanRefs(favs, order, live), { favs: ['kind:rect'], order: { basic: ['kind:ellipse'], prefabs: [`prefab:${P1}`] } });
  assert.equal(favs.length, 4);
});

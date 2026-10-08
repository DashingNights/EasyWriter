import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanConnector, cloneItems, containedIn, hitTarget, moveItem, unbindFrom } from '../src/flow/model.mjs';
import { parseBoard } from '../src/whiteboard.js';

const shape = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 100, h: 60, color: '#fff', width: 2, opacity: 1, fill: 'none', fillColor: '#fff', ...extra });
const conn = (id, from, to, extra = {}) => ({ id, type: 'connector', from, to, ...extra });
const parse = (items) => parseBoard(JSON.stringify({ height: 400, items })).items;
const derived = { x: 50, y: 20, w: 300, h: 100, d: 'M0 0L300 100', tips: [{ x: 0, y: 0, a: 180 }, { x: 300, y: 100, a: 0 }], lps: {} };

test('parseBoard keeps valid connectors, drops malformed ones, repairs dangling ends (a: at the tip, b: 100 px right, c: dropped)', () => {
  const items = parse([
    shape('a', 0, 0),
    conn('ok', { item: 'a', anchor: 'e' }, { x: 300, y: 40 }),
    conn('badEnd', { item: 'a', anchor: [2, 0] }, { x: 1, y: 1 }),
    conn('badHead', { x: 0, y: 0 }, { x: 1, y: 1 }, { heads: { end: 'spear' } }),
    conn('tipped', { item: 'gone', anchor: null }, { item: 'a', anchor: null }, derived),
    conn('untipped', { item: 'a', anchor: null }, { item: 'gone', anchor: null }),
    conn('lost', { item: 'gone', anchor: null }, { item: 'gone2', anchor: null }),
  ]);
  assert.deepEqual(items.map((i) => i.id), ['a', 'ok', 'tipped', 'untipped']);
  const ok = items[1];
  assert.deepEqual(ok.from, { item: 'a', anchor: [1, 0.5] }); // anchor name → fraction
  assert.equal(ok.route, 'ortho');
  assert.deepEqual(ok.heads, { start: 'none', end: 'arrow' });
  assert.deepEqual(items[2].from, { x: 50, y: 20 }); // tip 0 + bbox origin
  assert.deepEqual(items[3].to, { x: 150, y: 30 }); // a's centre + 100 px
});

test('cleanConnector: a string label becomes labels.mid; slots without html are dropped; t defaulted and clamped; ≤ 32 points', () => {
  const c = cleanConnector(conn('k', { x: 0, y: 0 }, { x: 9, y: 9 }, {
    label: 'yes', labels: { start: { html: '1', t: 4 }, end: { html: '' }, junk: { html: 'x' } }, points: Array.from({ length: 40 }, (_, k) => ({ x: k, y: 0 })),
  }));
  assert.equal(c.labels.mid.html, 'yes');
  assert.equal(c.labels.mid.t, 0.5);
  assert.equal(c.labels.start.t, 1);
  assert.deepEqual(Object.keys(c.labels).sort(), ['mid', 'start']);
  assert.equal(c.points.length, 32);
  assert.equal('label' in c, false);
  assert.equal('d' in c, false); // no derived fields without all of them
});

test('cloneItems remaps ends inside the copied set and frees ends outside it at their tips; unbindFrom frees ends', () => {
  const k = conn('k', { item: 'a', anchor: null }, { item: 'b', anchor: [0, 0.5] }, derived);
  let n = 0;
  const [a2, k2] = cloneItems([shape('a', 0, 0), k], () => `n${n++}`);
  assert.equal(a2.id, 'n0');
  assert.deepEqual(k2.from, { item: 'n0', anchor: null });
  assert.deepEqual(k2.to, { x: 350, y: 120 });
  const left = unbindFrom([shape('a', 0, 0), shape('b', 300, 0), k], new Set(['b']));
  assert.deepEqual(left.map((i) => i.id), ['a', 'k']);
  assert.deepEqual(left[1].to, { x: 350, y: 120 });
});

test('moveItem: a connector moves its free ends, waypoints and box; bound ends stay', () => {
  const m = moveItem(conn('k', { item: 'a', anchor: null }, { x: 10, y: 10 }, { ...derived, points: [{ x: 5, y: 5 }] }), 3, 4);
  assert.deepEqual([m.from, m.to, m.points, m.x, m.y], [{ item: 'a', anchor: null }, { x: 13, y: 14 }, [{ x: 8, y: 9 }], 53, 24]);
});

test('hitTarget: a port within tol, the inside of an unfilled diamond, a rect at 45° (not its AABB corner), nothing outside', () => {
  const items = [shape('d', 0, 0, { shape: 'diam', w: 100, h: 100 }), shape('r', 300, 0, { rot: 45, h: 100 })];
  assert.deepEqual(hitTarget(items, { x: 101, y: 52 }, { tol: 5 }), { item: 'd', anchor: [1, 0.5] });
  assert.deepEqual(hitTarget(items, { x: 50, y: 60 }), { item: 'd', anchor: null });
  assert.equal(hitTarget(items, { x: 5, y: 5 }), null); // inside the diamond's box, outside the diamond
  assert.deepEqual(hitTarget(items, { x: 350, y: 50 }), { item: 'r', anchor: null });
  assert.equal(hitTarget(items, { x: 350 - 69, y: 50 - 69 }), null); // the turned square's AABB corner
  assert.equal(hitTarget(items, { x: 200, y: 300 }), null);
  assert.equal(hitTarget(items, { x: 50, y: 60 }, { exclude: new Set(['d']) }), null);
});

test('containedIn: the items fully inside a lane', () => {
  const lane = shape('lane', 0, 0, { shape: 'lane', w: 500, h: 200 });
  assert.deepEqual(containedIn(lane, [lane, shape('in', 20, 40), shape('out', 450, 40), conn('k', { x: 1, y: 1 }, { x: 2, y: 2 }, derived)]), ['in']);
});

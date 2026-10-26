import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeItems, cleanConnector, cloneItems, containedIn, flipItem, groupItems, hitTarget, layerRows, moveItem, normalizeGroups, selectable,
  toggleLayer, turnItem, unbindFrom, ungroupItems, unitOf, units,
} from '../src/flow/model.mjs';
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

test('turnItem: a quarter turn about a point takes the centre round it and turns the item; a free connector end and bend go round, a bound end stays', () => {
  const t = turnItem({ id: 'a', type: 'shape', x: 0, y: 0, w: 20, h: 10, rot: 350 }, { x: 50, y: 5 }, 90);
  assert.deepEqual([t.x, t.y, t.rot], [40, -40, 80]); // centre (10, 5) → (50, -35)
  const c = { id: 'c', type: 'connector', from: { item: 'a', anchor: null }, to: { x: 60, y: 5 }, points: [{ x: 50, y: 15 }] };
  const tc = turnItem(c, { x: 50, y: 5 }, 90);
  assert.deepEqual([tc.from, tc.to, tc.points], [c.from, { x: 50, y: 15 }, [{ x: 40, y: 5 }]]);
});

test('flipItem: across x = 50 the centre mirrors, the angle negates and the flag toggles; a free end mirrors, a bound one stays', () => {
  const f = flipItem({ id: 'a', type: 'image', x: 0, y: 0, w: 20, h: 10, rot: 30 }, { x: 50, y: 5 }, 'x', 'mirrorX');
  assert.deepEqual([f.x, f.y, f.rot, f.mirrorX], [80, 0, 330, true]);
  const c = flipItem({ id: 'c', type: 'connector', from: { item: 'a', anchor: null }, to: { x: 60, y: 9 } }, { x: 50, y: 5 }, 'x');
  assert.deepEqual([c.from, c.to], [{ item: 'a', anchor: null }, { x: 40, y: 9 }]);
});

// --- layers (SPEC §6 Layer fields) ---

const it = (id, ...groups) => ({ id, ...(groups.length && { groups }) });
const ids = (items) => items.map((i) => i.id).join(' ');

test('parseBoard keeps hidden and locked only as true and groups only as distinct ids, a canvas item\'s own items too', () => {
  const [a, b, c, k] = parse([
    shape('a', 0, 0, { hidden: true, locked: true, groups: ['g1', 'g2'] }),
    shape('b', 0, 0, { hidden: 1, locked: false, groups: ['bad id'] }),
    { ...shape('c', 0, 0), type: 'canvas', aw: 10, ah: 10, groups: ['g', 'g'], items: [shape('in', 0, 0, { hidden: 'yes', groups: ['g1'] })] },
    conn('k', { x: 0, y: 0 }, { x: 1, y: 1 }, { locked: true, groups: [] }),
  ]);
  assert.deepEqual([a.hidden, a.locked, a.groups], [true, true, ['g1', 'g2']]);
  assert.deepEqual(['hidden', 'locked', 'groups'].filter((f) => f in b), []);
  assert.equal('groups' in c, false); // a repeated id
  assert.deepEqual([c.items[0].hidden, c.items[0].groups], [undefined, ['g1']]);
  assert.deepEqual([k.locked, 'groups' in k], [true, false]);
});

test('normalizeGroups: lone ids go, members gather at the topmost one, an inner group takes its outer groups; unchanged → the same array', () => {
  const plain = [it('a'), it('b')];
  assert.equal(normalizeGroups(plain), plain);
  const whole = [it('a', 'g'), it('b', 'g')];
  assert.equal(normalizeGroups(whole), whole);
  // g gathers at c's place (its topmost member); h has one member and goes.
  const out = normalizeGroups([it('a', 'g'), it('x'), it('c', 'g'), it('y', 'h'), it('z')]);
  assert.equal(ids(out), 'x a c y z');
  assert.equal('groups' in out[3], false);
  // Nested: i inside o, gathered at a; b names i inside p and takes o instead (the topmost chain wins); o's own member d sits
  // below the inner group, as it was.
  const nest = normalizeGroups([it('b', 'i', 'p'), it('d', 'o'), it('x'), it('a', 'i', 'o')]);
  assert.equal(ids(nest), 'x d b a');
  assert.deepEqual(nest.map((i) => i.groups), [undefined, ['o'], ['i', 'o'], ['i', 'o']]);
});

test('units and arrangeItems: a group is one unit and moves whole; front, back, forward, backward, {index}', () => {
  const items = [it('a'), it('b', 'g'), it('c', 'g'), it('d'), it('e')];
  assert.deepEqual(units(items).map((u) => ids(u)), ['a', 'b c', 'd', 'e']);
  assert.equal(ids(arrangeItems(items, ['b'], 'front')), 'a d e b c');
  assert.equal(ids(arrangeItems(items, ['c'], 'back')), 'b c a d e');
  assert.equal(ids(arrangeItems(items, ['b'], 'forward')), 'a d b c e');
  assert.equal(ids(arrangeItems(items, ['d'], 'backward')), 'a d b c e');
  assert.equal(ids(arrangeItems(items, ['a', 'e'], 'forward')), 'b c a d e');
  assert.equal(ids(arrangeItems(items, ['e'], { index: 1 })), 'a e b c d');
});

test('unitOf: the outermost group at the scope; inside its own group an item alone; outside the scope it counts from around it', () => {
  const items = [it('a', 'i', 'o'), it('b', 'i', 'o'), it('c', 'o'), it('d')];
  assert.deepEqual(unitOf(items, 'a'), { group: 'o', scope: null, ids: ['a', 'b', 'c'] });
  assert.deepEqual(unitOf(items, 'a', 'o'), { group: 'i', scope: 'o', ids: ['a', 'b'] });
  assert.deepEqual(unitOf(items, 'a', 'i'), { group: null, scope: 'i', ids: ['a'] });
  assert.deepEqual(unitOf(items, 'c', 'i'), { group: null, scope: 'o', ids: ['c'] });
  assert.deepEqual(unitOf(items, 'd', 'i'), { group: null, scope: null, ids: ['d'] });
});

test('groupItems wraps whole units inside their parent; ungroupItems removes each selected group; arrangeItems at a scope', () => {
  const items = [it('z'), it('a', 'i', 'o'), it('b', 'i', 'o'), it('c', 'o'), it('x', 'o'), it('y')];
  const n = () => 'n';
  const groups = (list) => list.map((i) => i.groups?.join() ?? '');
  assert.deepEqual(groups(groupItems(items, ['z', 'b'], n)), ['n', 'i,o,n', 'i,o,n', 'o,n', 'o,n', '']); // b brings o whole
  assert.deepEqual(groups(groupItems(items, ['a', 'c'], n)), ['', 'i,n,o', 'i,n,o', 'n,o', 'o', '']); // inside o: i and c
  assert.deepEqual(groups(groupItems(items, ['a', 'b', 'c', 'x'], n)), ['', 'i,o,n', 'i,o,n', 'o,n', 'o,n', '']); // o itself
  assert.equal(groupItems(items, ['z'], n), items);
  assert.deepEqual(groups(ungroupItems(items, ['a', 'b', 'c', 'x'])), ['', 'i', 'i', '', '', '']); // o selected
  assert.deepEqual(groups(ungroupItems(items, ['a', 'b'])), ['', 'o', 'o', 'o', 'o', '']); // i selected inside o
  assert.equal(ungroupItems(items, ['a', 'z']), items);
  assert.deepEqual(groups(ungroupItems([it('a', 'g'), it('b', 'g'), it('c', 'h'), it('d', 'h')], ['a', 'b', 'c', 'd'])), ['', '', '', '']);
  assert.equal(ids(arrangeItems(items, ['c'], 'front', 'o')), 'z a b x c y');
  assert.equal(ids(arrangeItems(items, ['a'], 'front', 'o')), 'z c x a b y');
  assert.equal(ids(arrangeItems(items, ['x'], 'back', 'o')), 'z x a b c y');
  assert.equal(ids(arrangeItems(items, ['c'], 'front')), 'z y a b c x'); // the top level: o moves whole
});

test('layerRows: units topmost first, a group one row holding its own rows, nested groups nested', () => {
  const items = [it('z'), it('a', 'i', 'o'), it('b', 'i', 'o'), it('c', 'o'), it('y')];
  const tree = (rows) => rows.map((r) => (r.group ? `${r.group}@${r.scope}(${tree(r.rows)})` : `${ids(r.items)}@${r.scope}`)).join(' ');
  assert.equal(tree(layerRows(items)), 'y@null o@null(c@o i@o(b@i a@i)) z@null');
  assert.deepEqual(layerRows([]), []);
});

test('cloneItems: a group copied whole gets a new id, one copied in part is dropped', () => {
  const board = [it('a', 'i', 'o'), it('b', 'i', 'o'), it('c', 'o')];
  let n = 0;
  const copies = cloneItems(board.slice(0, 2), () => `n${n++}`, board);
  assert.deepEqual(copies.map((i) => i.groups), [['n2'], ['n2']]); // i kept (whole) as n2, o dropped (c not copied)
  const all = cloneItems(board, () => `m${n++}`);
  assert.deepEqual(all.map((i) => i.groups), [['m6', 'm7'], ['m6', 'm7'], ['m7']]);
});

test('a hidden member does not keep its group from counting as selected or copied whole', () => {
  const items = [it('a', 'g'), it('b', 'g'), { ...it('h', 'g'), hidden: true }, it('c')];
  const groups = (list) => list.map((i) => i.groups?.join() ?? '');
  assert.deepEqual(groups(ungroupItems(items, ['a', 'b'])), ['', '', '', '']);
  assert.deepEqual(groups(groupItems(items, ['a', 'b'], () => 'n')), ['g,n', 'g,n', 'g,n', '']);
  assert.deepEqual(cloneItems(items.slice(0, 2), () => 'k', items).map((i) => i.groups), [['k'], ['k']]);
});

test('toggleLayer: sets the flag on the named items unless all have it, then clears it; selectable skips hidden and locked', () => {
  const items = [it('a'), { ...it('b'), locked: true }, it('c')];
  assert.equal(toggleLayer(items, ['x'], 'locked'), items);
  const on = toggleLayer(items, ['a', 'b'], 'locked'); // b has it, a not: both set
  assert.deepEqual(on.map((i) => !!i.locked), [true, true, false]);
  assert.equal(on[2], items[2]);
  const off = toggleLayer(on, new Set(['a', 'b']), 'locked');
  assert.deepEqual(off.map((i) => 'locked' in i), [false, false, false]);
  assert.deepEqual(toggleLayer(items, ['c'], 'hidden').map(selectable), [true, false, false]);
});

test('cleanConnector keeps pin only on a bound end with an anchor', () => {
  const c = cleanConnector({ id: 'c', type: 'connector', from: { item: 'a', anchor: [0.2, 0.7], pin: true }, to: { item: 'b', anchor: null, pin: true } });
  assert.deepEqual([c.from, c.to], [{ item: 'a', anchor: [0.2, 0.7], pin: true }, { item: 'b', anchor: null }]);
});

test('cleanConnector: a label stored as white has no colour (it follows the board); any other colour is kept', () => {
  const c = cleanConnector({ id: 'c', type: 'connector', from: { x: 0, y: 0 }, to: { x: 9, y: 9 }, labels: {
    start: { html: 'a', textColor: '#ffffff' }, mid: { html: 'b', textColor: '#FFFFFF' }, end: { html: 'c', textColor: '#ff0000' } } });
  assert.deepEqual([c.labels.start.textColor, c.labels.mid.textColor, c.labels.end.textColor], [undefined, undefined, '#ff0000']);
  // A board loaded from a draft goes through the same rule.
  const board = parseBoard(JSON.stringify({ items: [{ id: 'k', type: 'connector', from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, labels: { mid: { html: 'keep', textColor: '#ffffff' } } }] }));
  assert.equal(board.items[0].labels.mid.textColor, undefined);
});

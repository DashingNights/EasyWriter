// Two arrow tools, and flat shapes with transparency (docs/plans/word/briefs/board-arrows-flat.md): the Line and Arrow tools draw free
// lines whose ends go where they are put, the Connector's ends still stick; new shapes and flowchart nodes are a flat fill with no
// outline; an item's opacity and #rrggbbaa colours are saved with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanConnector, endAt, hitTarget } from '../src/flow/model.mjs';
import { FLAT_FILL, flowPreset } from '../src/flow/shapes.mjs';
import { fromGraph } from '../src/flow/graph.mjs';
import { Board, parseBoard } from '../src/whiteboard.js';

// A picture, a nested canvas (as a smart canvas holds one: its backing rect and its items, grouped), a shape drawn on the
// picture and a shape with its ports: everything a connector end sticks to.
const shape = (id, x, y, more = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 100, h: 60, color: '#000000', width: 2, opacity: 1, fill: 'solid', fillColor: '#ffffff', ...more });
const items = [
  { id: 'pic', type: 'image', src: 'x', x: 0, y: 0, w: 400, h: 300 },
  shape('cv-bg', 0, 400, { w: 300, h: 200, width: 0, groups: ['cv'] }),
  shape('cv-in', 40, 440, { groups: ['cv'] }),
  shape('on', 100, 100),
  shape('box', 500, 0),
];
const POINTS = [
  ['inside the picture', { x: 300, y: 75 }],
  ['inside the nested canvas', { x: 250, y: 560 }],
  ['inside a shape of the nested canvas', { x: 90, y: 470 }],
  ['inside a shape drawn on the picture', { x: 150, y: 130 }],
  ["on a shape's port", { x: 598, y: 31 }],
];

test("a free line's end is the very point it is dropped on, over a picture, a nested canvas, a shape or a port", () => {
  for (const [where, p] of POINTS) {
    // The control: an item lies under the point (a connector end there sticks only in its ring: board-connector-ring).
    assert.notEqual(hitTarget(items, p, { tol: 12 }), null, `an item lies under ${where}`);
    for (const shift of [false, true]) {
      assert.deepEqual(endAt(items, p, { free: true, tol: 12, shift }), p, `a free line's first end ${where}${shift ? ' with Shift' : ''}`);
    }
    // Dropping the other end there (the release, or an end handle dragged there) never sticks either.
    assert.deepEqual(endAt(items, p, { free: true, from: { x: p.x - 200, y: p.y }, tol: 12 }), p, `a free line's dropped end ${where}`);
  }
});

test('Shift keeps a free end at 15 degree steps from the other end, its length kept', () => {
  const from = { x: 100, y: 100 };
  // (200, 110): 5.7 degrees → 0; length 100.5.
  assert.deepEqual(endAt([], { x: 200, y: 110 }, { free: true, from, shift: true }), { x: 200.5, y: 100 });
  // (200, 130): 16.7 degrees → 15; length 104.4: (100 + 104.4 cos 15, 100 + 104.4 sin 15).
  assert.deepEqual(endAt([], { x: 200, y: 130 }, { free: true, from, shift: true }), { x: 200.85, y: 127.02 });
  // (130, 200): 73.3 degrees → 75; length 104.4.
  assert.deepEqual(endAt([], { x: 130, y: 200 }, { free: true, from, shift: true }), { x: 127.02, y: 200.85 });
  // Up and to the left, (40, 40): -135 degrees, already a step.
  assert.deepEqual(endAt([], { x: 40, y: 40 }, { free: true, from, shift: true }), { x: 40, y: 40 });
  // Without Shift the end is where it was dropped, to 2 decimals.
  assert.deepEqual(endAt([], { x: 200.123, y: 130.456 }, { free: true, from }), { x: 200.12, y: 130.46 });
});

test('a saved free line opens as a free line; a saved connector opens with no flag and keeps sticking', () => {
  const line = { id: 'l', type: 'connector', free: true, from: { x: 10, y: 10 }, to: { x: 90, y: 40 }, route: 'straight', heads: { start: 'none', end: 'arrow' } };
  const conn = { id: 'c', type: 'connector', from: { item: 'box', anchor: [1, 0.5] }, to: { x: 5, y: 5 } };
  const [l, c] = parseBoard(JSON.stringify({ items: [line, conn, { ...conn, id: 'odd', free: 'yes' }] })).items;
  assert.equal(l.free, true);
  assert.deepEqual([l.from, l.to, l.route], [line.from, line.to, 'straight']);
  assert.equal('free' in c, false);
  assert.equal('free' in cleanConnector({ ...conn, free: false }), false);
});

test('a new shape and a flowchart node draw a flat fill with no outline; a pen stroke, line and connector keep their stroke', () => {
  const look = Board.prototype.shapeLook.call({ host: {} });
  assert.deepEqual([look.fill, look.fillColor, look.width], ['solid', FLAT_FILL, 0]);
  for (const theme of ['light', 'dark']) {
    const p = flowPreset(theme);
    assert.deepEqual([p.fill, p.fillColor, p.width], ['solid', FLAT_FILL, 0], theme);
  }
  const { items: drawn } = fromGraph({ dir: 'TD', nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'End' }], edges: [{ from: 'a', to: 'b' }] });
  for (const n of drawn.filter((i) => i.type === 'shape')) assert.deepEqual([n.fill, n.width], ['solid', 0], n.id);
  assert.ok(drawn.find((i) => i.type === 'connector').width > 0);
  const free = Board.prototype.lineLook.call({ host: {} });
  const conn = Board.prototype.connLook.call({ host: {} });
  const { open, closed } = Board.prototype.pathLook.call({ host: {} }); // Curve's open line, Freeform: Shape's closed one
  assert.ok(free.width > 0 && conn.width > 0 && open.width > 0 && open.fill === 'none', JSON.stringify({ free, conn, open }));
  assert.deepEqual([closed.fill, closed.width], ['solid', 0]);
  // A frame or lane holds what is drawn on it: no fill over it, and a line.
  const frame = Board.prototype.shapeLook.call({ host: {} }, 'frame');
  assert.deepEqual([frame.fill, frame.width > 0], ['none', true]);
});

test('a shape tool look saved before the flat defaults gives way to the flat look; one saved after stays', async () => {
  const load = async (saved, tag) => {
    globalThis.localStorage = { getItem: () => JSON.stringify(saved), setItem: () => {} };
    try {
      const { Board: B } = await import(`../src/whiteboard.js?${tag}`); // a fresh module reads its tool settings again
      return B.prototype.shapeLook.call({ host: {} });
    } finally {
      delete globalThis.localStorage;
    }
  };
  const old = await load({ shape: { shape: 'ellipse', color: '#e05252', width: 4, opacity: 1, fill: 'none', fillColor: '#e05252' } }, 'old');
  assert.deepEqual([old.shape, old.fill, old.fillColor, old.width], ['ellipse', 'solid', FLAT_FILL, 0]);
  const mine = await load({ flat: true, shape: { shape: 'ellipse', color: '#e05252', width: 3, fill: 'none', fillColor: '#e05252' } }, 'mine');
  assert.deepEqual([mine.fill, mine.width, mine.color], ['none', 3, '#e05252']);
});

test("an item's opacity and its #rrggbbaa fill and line colours are saved with it", () => {
  const items = [
    shape('s', 0, 0, { opacity: 0.37, fillColor: '#4a7fe080', color: '#e0525240', width: 0 }),
    { id: 'l', type: 'connector', free: true, from: { x: 0, y: 0 }, to: { x: 50, y: 0 }, route: 'straight', opacity: 0.5, color: '#11223380' },
    { id: 'k', type: 'stroke', x: 0, y: 0, w: 10, h: 10, vw: 10, vh: 10, d: 'M0 0L10 10', color: '#00000080', width: 2, opacity: 0.25 },
  ];
  const back = parseBoard(JSON.stringify({ items })).items;
  assert.deepEqual(back.map((i) => [i.id, i.opacity, i.color]), [['s', 0.37, '#e0525240'], ['l', 0.5, '#11223380'], ['k', 0.25, '#00000080']]);
  assert.deepEqual([back[0].fillColor, back[0].width], ['#4a7fe080', 0]);
});

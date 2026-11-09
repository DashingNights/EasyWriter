// A connector sticks only in a ring around an item (docs/plans/word/briefs/board-connector-ring.md): an end sticks in the band from
// 6 screen px inside an item's outline to 16 screen px outside it (fixed to a port within 12 screen px, else floating on the
// outline); deeper inside an item or outside every ring it binds to nothing. Shift pins to the item under the point, Alt never
// sticks. Expected values are worked out from the brief's numbers, not from a run of the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanConnector, endAt, stickTarget } from '../src/flow/model.mjs';

const shape = (id, x, y, more = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 100, h: 60, color: '#000000', width: 2, opacity: 1, fill: 'solid', fillColor: '#ffffff', ...more });
const pic = { id: 'pic', type: 'image', src: 'x', x: 0, y: 0, w: 400, h: 300 };
const items = [
  pic,
  shape('on', 100, 100), // drawn on the picture
  { id: 'cv', type: 'canvas', x: 0, y: 400, w: 300, h: 200, aw: 600, ah: 400, items: [] },
  shape('cv2-bg', 0, 700, { w: 300, h: 200, width: 0, groups: ['cv2'] }), // a flattened nested canvas's backing rect
  shape('frame', 600, 400, { shape: 'frame', w: 300, h: 200, fill: 'none' }),
  shape('n', 650, 450), // a node inside the frame
  shape('s', 500, 0),
  { ...pic, id: 'locked', x: 1000, locked: true },
  { ...pic, id: 'hidden', x: 1500, hidden: true },
];
// The board passes its zoom as `scale` and the port tolerance as 12 screen px.
const at = (x, y, { scale = 1, ...o } = {}) => stickTarget(items, { x, y }, { tol: 12 / scale, scale, ...o });
const float = (item) => ({ item, anchor: null });
const pin = (item, fx, fy) => ({ item, anchor: [fx, fy], pin: true });

test('a connector end sticks only in the ring around an item', () => {
  const rows = [
    // A press or release on top of an item ends free there.
    ['inside a small shape', at(550, 30), null],
    ['inside a large picture', at(300, 75), null],
    ['inside a nested canvas', at(150, 500), null],
    ['inside a flattened nested canvas', at(150, 800), null],
    ['inside a frame', at(750, 550), null],
    ['inside a shape drawn on the picture', at(150, 130), null],
    // The ring: 6 px inside to 16 px outside the outline.
    ['3 px inside the small shape', at(503, 45), float('s')],
    ['8 px inside the small shape', at(508, 45), null],
    ['10 px outside the small shape', at(490, 45), float('s')],
    ['17 px outside the small shape', at(483, 45), null],
    ['3 px inside the picture', at(3, 100), float('pic')],
    ['10 px outside the picture', at(-10, 100), float('pic')],
    ['5 px inside the frame', at(605, 550), float('frame')],
    ['10 px outside the nested canvas', at(100, 610), float('cv')],
    ['in the ring of the shape drawn on the picture', at(97, 145), float('on')],
    // A port within 12 px: fixed.
    ['near the small shape\'s east port', at(598, 31), { item: 's', anchor: [1, 0.5] }],
    ['10 px outside, near the canvas\'s south port', at(150, 610), { item: 'cv', anchor: [0.5, 1] }],
    // The topmost ring wins: a node's ring inside the frame.
    ['5 px outside a node inside the frame', at(645, 465), float('n')],
    ['inside the node inside the frame', at(700, 480), null],
    // Locked and hidden items take nothing.
    ['in a locked picture\'s ring', at(1003, 150), null],
    ['in a hidden picture\'s ring', at(1503, 150), null],
    // Shift pins to the item under the point; Alt never sticks; the skipped item never.
    ['with Shift inside the small shape', at(525, 15, { shift: true }), pin('s', 0.25, 0.25)],
    ['with Shift inside the picture', at(300, 75, { shift: true }), pin('pic', 0.75, 0.25)],
    ['with Shift on empty board', at(450, 350, { shift: true }), null],
    ['with Alt in the picture\'s ring', at(3, 150, { alt: true }), null],
    ['in the skipped item\'s ring', at(503, 45, { skip: 's' }), null],
  ];
  for (const [what, got, want] of rows) assert.deepEqual(got, want, what);
});

test('the ring is the same in screen px at 25 %, 100 % and 400 % zoom', () => {
  const rows = [
    // 40 board px outside the picture: 10 screen px at 25 %, 40 at 100 %.
    ['40 px outside at 25 %', at(-40, 100, { scale: 0.25 }), float('pic')],
    ['40 px outside at 100 %', at(-40, 100), null],
    // 20 board px inside: 5 screen px at 25 %, 20 at 100 %.
    ['20 px inside at 25 %', at(20, 100, { scale: 0.25 }), float('pic')],
    ['20 px inside at 100 %', at(20, 100), null],
    // 3 board px outside: 12 screen px at 400 %; 5 board px: 20 screen px.
    ['3 px outside at 400 %', at(-3, 100, { scale: 4 }), float('pic')],
    ['5 px outside at 400 %', at(-5, 100, { scale: 4 }), null],
    // 1 board px inside: 4 screen px at 400 %; 2 board px: 8 screen px.
    ['1 px inside at 400 %', at(1, 100, { scale: 4 }), float('pic')],
    ['2 px inside at 400 %', at(2, 100, { scale: 4 }), null],
  ];
  for (const [what, got, want] of rows) assert.deepEqual(got, want, what);
});

test('endAt: the Connector tool\'s ends follow the ring; a pinned end already saved stays as stored', () => {
  assert.equal(endAt(items, { x: 300, y: 75 }, { tol: 12, scale: 1 }), null, 'a press inside the picture starts free');
  assert.deepEqual(endAt(items, { x: 3, y: 100 }, { tol: 12, scale: 1 }), float('pic'), 'a press in its ring sticks');
  const saved = { id: 'c', type: 'connector', from: pin('pic', 0.75, 0.25), to: { x: 600, y: 75 } };
  assert.deepEqual(cleanConnector(saved).from, pin('pic', 0.75, 0.25));
});

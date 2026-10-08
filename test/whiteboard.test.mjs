import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxBetween, clampMove, groupBox, marqueeHits, parseBoard, smartArtboard } from '../src/whiteboard.js';

const canvas = (extra = {}) => ({ id: 'c', type: 'canvas', x: 10, y: 20, w: 400, h: 225, aw: 800, ah: 450, bg: 'post', items: [], ...extra });
const parse = (items) => parseBoard(JSON.stringify({ height: 400, items })).items;

test('canvas items: invalid numbers and artboards dropped, inner items filtered, no nesting', () => {
  const stroke = { id: 's', type: 'stroke', x: 0, y: 0, w: 10, h: 10, vw: 10, vh: 10, d: 'M0 0', color: '#fff', width: 2, opacity: 1 };
  const items = parse([
    canvas({ id: 'ok', bg: 'nope', items: [stroke, { ...stroke, d: 7 }, canvas({ id: 'nested' }), { id: 'i', type: 'image', src: 'x', crop: { x: 2 } }] }),
    canvas({ id: 'nan', x: 'a' }),
    canvas({ id: 'flat', ah: 0 }),
    canvas({ id: 'noitems', items: null }),
  ]);
  assert.deepEqual(items.map((i) => i.id), ['ok', 'noitems']);
  assert.equal(items[0].bg, 'post');
  assert.deepEqual(items[0].items.map((i) => i.id), ['s', 'i']);
  assert.equal(items[0].items[1].crop, undefined);
  assert.deepEqual(items[1].items, []);
});

test('flowchart items (§6d): a connector with three labels, a labelled shape, rot −90 → 270, text h; a canvas item loses flow', () => {
  const sh = { id: 'sh', type: 'shape', shape: 'diam', x: 0, y: 0, w: 160, h: 90, color: '#fff', width: 2, opacity: 1, fill: 'solid', fillColor: '#333', flipX: false, flipY: false };
  const labels = { start: { html: '1' }, mid: { html: 'yes', t: 0.4, dy: -10 }, end: { html: 'n', bold: true } };
  const items = parse([
    { ...sh, html: 'Valid?', size: 16, textColor: '#fff', align: 'center', valign: 'middle', rot: -90 },
    { ...sh, id: 'sh2', rot: 'x', align: 'sideways', size: -3 },
    { id: 'k', type: 'connector', from: { item: 'sh', anchor: null }, to: { item: 'sh2', anchor: 's' }, labels },
    { id: 't', type: 'text', html: 'A', x: 0, y: 0, w: 100, size: 20, color: '#fff', bold: false, align: 'left', bg: null, h: 38 },
    { id: 't2', type: 'text', html: 'B', x: 0, y: 0, w: 100, size: 20, color: '#fff', bold: false, align: 'left', bg: null, h: null },
    canvas({ id: 'cv', flow: { id: '00000000-0000-4000-8000-000000000001', rev: 3 } }),
  ]);
  assert.deepEqual(items.map((i) => i.id), ['sh', 'sh2', 'k', 't', 't2', 'cv']);
  assert.equal(items[0].rot, 270);
  assert.equal(items[0].html, 'Valid?');
  assert.deepEqual([items[1].rot, items[1].align, items[1].size], [undefined, undefined, undefined]); // bad values dropped
  assert.deepEqual(Object.keys(items[2].labels), ['start', 'mid', 'end']);
  assert.deepEqual(items[2].labels.mid, { html: 'yes', t: 0.4, dx: 0, dy: -10, size: 14, textColor: '#ffffff', bold: false });
  assert.deepEqual([items[2].labels.start.t, items[2].labels.end.t, items[2].labels.end.bold], [0.15, 0.85, true]);
  assert.deepEqual(items[2].to, { item: 'sh2', anchor: [0.5, 1] });
  assert.deepEqual([items[3].h, 'h' in items[4]], [38, false]);
  assert.equal('flow' in items[5], false);
});

test('canvas items: a valid frame is kept, an invalid or missing one becomes null', () => {
  const frames = parse([canvas({ frame: { x: 32, y: 0, w: 800, h: 450 } }), canvas({ frame: { x: 0, y: 0, w: 0, h: 450 } }), canvas()]).map((i) => i.frame);
  assert.deepEqual(frames, [{ x: 32, y: 0, w: 800, h: 450 }, null, null]);
});

const FRAME = { x: 0, y: 0, w: 2500, h: 1250 };

test('smart artboard: content inside the frame adds nothing', () => {
  const same = { w: 2500, h: 1250, dx: 0, dy: 0, frame: FRAME };
  assert.deepEqual(smartArtboard(FRAME, null, { x: 0, y: 0, w: 2500, h: 1250 }), same);
  assert.deepEqual(smartArtboard(FRAME, null, { x: 100, y: 100, w: 10, h: 10 }), same);
  assert.deepEqual(smartArtboard(FRAME, null, null), same);
});

test('smart artboard: grows right / bottom to the content plus 32 px, no shift', () => {
  assert.deepEqual(smartArtboard(FRAME, null, { x: 0, y: 0, w: 2600, h: 1550 }), { w: 2632, h: 1582, dx: 0, dy: 0, frame: FRAME });
});

test('smart artboard: grows left / top, items and frame shift to start at 0,0', () => {
  assert.deepEqual(smartArtboard(FRAME, null, { x: -300, y: -50, w: 2800, h: 1300 }), { w: 2832, h: 1332, dx: 332, dy: 82, frame: { x: 332, y: 82, w: 2500, h: 1250 } });
});

test('smart artboard: shrinks back to the frame (and shifts back) when the content is inside again', () => {
  const grown = { x: 332, y: 82, w: 2500, h: 1250 };
  assert.deepEqual(smartArtboard(grown, null, { x: 332, y: 82, w: 2500, h: 1250 }), { w: 2500, h: 1250, dx: -332, dy: -82, frame: FRAME });
});

test('smart artboard: frame null (old drafts) = the whole current artboard', () => {
  const whole = { x: 0, y: 0, w: 800, h: 450 };
  assert.deepEqual(smartArtboard(null, { w: 800, h: 450 }, null), { w: 800, h: 450, dx: 0, dy: 0, frame: whole });
  assert.deepEqual(smartArtboard(null, { w: 800, h: 450 }, { x: 0, y: 0, w: 900, h: 100 }), { w: 932, h: 450, dx: 0, dy: 0, frame: whole });
});

const BOXES = [{ id: 'a', x: 0, y: 0, w: 100, h: 50 }, { id: 'b', x: 200, y: 0, w: 100, h: 50 }, { id: 'c', x: 0, y: 200, w: 50, h: 50 }];

test('marquee: selects every box it touches, edges included, dragged in any direction', () => {
  assert.deepEqual(marqueeHits(boxBetween({ x: 50, y: 25 }, { x: 250, y: 30 }), BOXES), ['a', 'b']);
  assert.deepEqual(marqueeHits(boxBetween({ x: 250, y: 30 }, { x: 50, y: 25 }), BOXES), ['a', 'b']);
  assert.deepEqual(marqueeHits(boxBetween({ x: 50, y: 100 }, { x: 150, y: 200 }), BOXES), ['c']); // touches c's top-right corner
  assert.deepEqual(marqueeHits(boxBetween({ x: 110, y: 60 }, { x: 190, y: 190 }), BOXES), []);
});

test('group box: union of the boxes, null for none', () => {
  assert.deepEqual(groupBox(BOXES), { x: 0, y: 0, w: 300, h: 250 });
  assert.equal(groupBox([]), null);
});

test('group move: cut at the left, top and right bounds, open at the bottom; a too wide group is pinned left', () => {
  const box = { x: 100, y: 40, w: 300, h: 100 };
  const wb = { l: 0, t: 0, r: 1000, b: Infinity };
  assert.deepEqual(clampMove(box, 50, 500, wb), { dx: 50, dy: 500 });
  assert.deepEqual(clampMove(box, -150, -70, wb), { dx: -100, dy: -40 });
  assert.deepEqual(clampMove(box, 800, 0, wb), { dx: 600, dy: 0 });
  assert.deepEqual(clampMove({ ...box, w: 1200 }, 30, 0, wb), { dx: -100, dy: 0 });
  assert.deepEqual(clampMove(box, -500, -500, { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity }), { dx: -500, dy: -500 }); // a canvas
});

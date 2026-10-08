import assert from 'node:assert/strict';
import test from 'node:test';
import { BADGE, markCentres, markSpots, sizeText } from '../src/app/assistant/marks.mjs';

test('sizeText: the picture size and the size of what it shows (wave 2b), so the model knows the scale', () => {
  assert.equal(sizeText(1280, 720, 1920, 1080), '1280 x 720 of a 1920 x 1080 board');
  assert.equal(sizeText(1280, 512, 1000.4, 399.6), '1280 x 512 of a 1000 x 400 board');
  assert.equal(sizeText(1280, 800, 1600, 1000, 'view'), '1280 x 800 of a 1600 x 1000 view');
});

// The numbered marks on the assistant's pictures (SPEC §7i Vision; plan assistant-reliability.md wave 2): where each badge goes.

const shape = (id, x, y, w, h, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w, h, ...extra });
const conn = (id, from, to, points = []) => ({ id, type: 'connector', from: { item: from, anchor: null }, to: { item: to, anchor: null }, route: 'straight', points });

test('markSpots: a box at its top-left corner, a turned shape at its bounding box, a connector at the middle of its routed path', () => {
  // The fixture's flowchart: the yes connector runs down from Decision, along y 340 and up into End; its middle is on the bottom run.
  const items = [shape('d', 360, 170, 180, 80), shape('e', 660, 170, 180, 80), conn('yes', 'd', 'e', [{ x: 450, y: 340 }, { x: 750, y: 340 }]), conn('c', 'd', 'e')];
  const spots = markSpots(items);
  assert.deepEqual(spots.map((s) => s.id), ['d', 'e', 'yes', 'c']); // the legend's order
  assert.deepEqual(spots[0], { id: 'd', x: 360, y: 170, mid: false });
  assert.equal(spots[2].mid, true);
  assert.equal(Math.round(spots[2].y), 340);
  assert.ok(spots[2].x > 450 && spots[2].x < 750, JSON.stringify(spots[2]));
  assert.ok(spots[3].x > 540 && spots[3].x < 660 && Math.round(spots[3].y) === 210, JSON.stringify(spots[3])); // between the boxes
  // A middle label covers the midpoint: the badge goes just past it along the path ("yes" at 0.6 x 14 px a character, 4 px padding).
  const labelled = markSpots([items[0], items[1], { ...items[2], labels: { mid: { html: 'yes' } } }])[2];
  assert.equal(Math.round(labelled.y), 340);
  assert.ok(labelled.x - spots[2].x > 3 * 14 * 0.3 + 4 + 7, JSON.stringify([labelled, spots[2]])); // past the label's half width and a badge radius
  const turned = markSpots([shape('r', 0, 0, 100, 50, { rot: 90 })])[0];
  assert.deepEqual([Math.round(turned.x), Math.round(turned.y)], [25, -25]);
  // Selected first: the order given, the board's items for the ends.
  assert.deepEqual(markSpots([items[2], items[0]], items).map((s) => s.id), ['yes', 'd']);
});

test('markCentres: numbered from 1 in order; a corner badge inside its box, a midpoint badge on its point; scaled to the picture', () => {
  const spots = [{ id: 'a', x: 40, y: 40, mid: false }, { id: 'b', x: 300, y: 210, mid: true }];
  const m = markCentres(spots, (p) => ({ x: p.x * 2, y: p.y * 2 }));
  assert.equal(BADGE, 22);
  assert.deepEqual(m, [{ n: 1, id: 'a', x: 80 + 13, y: 80 + 13 }, { n: 2, id: 'b', x: 600, y: 420 }]);
});

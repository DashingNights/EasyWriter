// float-layout's pure placement (docs/plans/word/plan.md §3 float-layout, src/document/wp/float-layout/place.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { floatSide, frameLayout, nearerSide, newFloat, placement, POSITIONS, PT, shapeOf, withWrap } from '../src/document/wp/float-layout/place.mjs';

// A4 portrait with 2.54 cm margins, in px: 794 x 1123, margins 96.
const box = { w: 794, h: 1123, top: 96, right: 96, bottom: 96, left: 96, text: 602, body: 931 };
const page = (number = 1, top = 0) => ({ number, top, bodyTop: top + box.top, bodyHeight: box.body, box });
const frame = (p = page()) => ({ page: p, anchorTop: 300, colLeft: 0, colWidth: box.text });
const size = { w: 200, h: 150 };

test('POSITIONS[4] is Middle Center: square, centred in the margins both ways, fixed on the page', () => {
  const p = POSITIONS[4];
  assert.equal(p.id, 'positionInMiddleCenterWithSquareTextWrapping');
  assert.equal(p.wrap, 'square');
  assert.deepEqual(p.h, { rel: 'margin', align: 'center' });
  assert.deepEqual(p.v, { rel: 'margin', align: 'center' });
  assert.equal(p.moveWithText, false);
  assert.equal(POSITIONS.length, 9);
});

test('an offset from the page is measured from the paper edge', () => {
  const { x } = placement({ ...newFloat('front'), h: { rel: 'page', offset: 72 } }, size, frame());
  assert.equal(x, -box.left + 96);
});

test('centred in the margin sits in the middle of the text column', () => {
  const { x } = placement({ ...newFloat('front'), h: { rel: 'margin', align: 'center' } }, size, frame());
  assert.equal(x + size.w / 2, box.text / 2);
});

test('an offset below the paragraph is measured from the anchor top', () => {
  const { y } = placement({ ...newFloat('front'), v: { rel: 'paragraph', offset: 36 } }, size, frame());
  assert.equal(y, 300 + 48);
});

test('the inside margin is the left one on odd pages and the right one on even pages', () => {
  const l = { ...newFloat('front'), h: { rel: 'insideMargin', offset: 0 } };
  assert.equal(placement(l, size, frame(page(1))).x, -box.left);
  assert.equal(placement(l, size, frame(page(2))).x, box.text);
  const outside = { ...newFloat('front'), h: { rel: 'margin', align: 'outside' } };
  assert.equal(placement(outside, size, frame(page(1))).x, box.text - size.w);
  assert.equal(placement(outside, size, frame(page(2))).x, 0);
});

test('a percentage of the page is that share of the paper', () => {
  const { x, y } = placement({ ...newFloat('front'), h: { rel: 'page', pct: 50 }, v: { rel: 'page', pct: 50 } }, size, frame(page(1, 2000)));
  assert.equal(x, -box.left + box.w / 2);
  assert.equal(y, 2000 + box.h / 2);
});

test('a centred square float falls to the nearer side, and Largest only leaves the wider side to the text', () => {
  const centred = { ...newFloat('square'), h: { rel: 'margin', align: 'center' } };
  assert.equal(floatSide(centred, 201, 200, 0, 602), 'left');
  assert.equal(nearerSide(300, 200, 0, 602), 'right');
  const largest = { ...newFloat('square'), side: 'largest' };
  assert.equal(floatSide(largest, 50, 200, 0, 602), 'left'); // 352 px of text on the right
  assert.equal(floatSide(largest, 380, 200, 0, 602), 'right');
  assert.equal(floatSide({ ...newFloat('square'), side: 'left' }, 0, 200, 0, 602), 'right');
});

test('a new float keeps 9 pt left and right of the text and starts where it was drawn', () => {
  const l = newFloat('square', { x: 12, y: 30 });
  assert.equal(l.dist.l, 9);
  assert.equal(l.dist.r, 9);
  assert.deepEqual([l.dist.t, l.dist.b], [0, 0]);
  assert.deepEqual(l.h, { rel: 'column', offset: 12 });
  assert.deepEqual(l.v, { rel: 'paragraph', offset: 30 });
  assert.equal(l.allowOverlap && l.inCell && l.moveWithText && !l.lockAnchor, true);
});

test('In Line with Text writes null on a picture and inline on a block; a float keeps its options when the wrap changes', () => {
  assert.equal(withWrap(newFloat('square'), 'inline', 'picture'), null);
  assert.equal(withWrap({ wrap: 'front', h: { rel: 'column', offset: 5 } }, 'inline', 'textbox').wrap, 'inline');
  const moved = { ...newFloat('square'), h: { rel: 'page', offset: 40 }, lockAnchor: true };
  assert.deepEqual(withWrap(moved, 'behind', 'picture'), { ...moved, wrap: 'behind' });
  assert.equal(withWrap(null, 'tight', 'picture', { x: 3, y: 4 }).h.offset, 3);
});

test('a frame around the text places like a square float and keeps its page position', () => {
  const l = frameLayout({ w: 100, h: 50, hRule: 'exact', x: 72, y: 144, hAnchor: 'page', vAnchor: 'page', wrap: 'around' });
  assert.equal(l.wrap, 'square');
  const p = placement(l, { w: 133, h: 67 }, frame(page(1, 0)));
  assert.deepEqual(p, { x: -box.left + 96, y: 192 });
  assert.equal(frameLayout({ wrap: 'none' }).wrap, 'topBottom');
});

test('Tight wraps the picture alpha, or the wrap points when set', () => {
  // A 100 x 50 box with no margins and no distances, floated left (float-wrap moved the outline into the margin box, in px).
  const fit = { w: 100, h: 50, m: { mt: 0, ml: 0 }, side: 'left' };
  const tight = { wrap: 'tight', dist: { t: 0, r: 0, b: 0, l: 0 } };
  assert.match(shapeOf(tight, 'data:image/png;base64,AAA', fit), /^url\(/);
  assert.equal(shapeOf(tight, 'data:image/jpeg;base64,AAA', fit), 'polygon(0px 0px, 100px 0px, 100px 50px, 0px 50px)');
  assert.equal(shapeOf({ ...tight, poly: [[0, 0], [1, 0], [0.5, 1]] }, null, fit), 'polygon(0px 0px, 100px 0px, 50px 50px)');
  assert.equal(PT, 4 / 3);
});

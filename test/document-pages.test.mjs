import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSect } from '../src/document/defaults.mjs';
import { marginPreset, pageAt, pageGuard, pagesFor, paperSize, printCss, sectFor, showIn, tooSmall, unitOf } from '../src/document/pages.mjs';

const A4 = defaultSect('a4');

test('margin presets: Moderate gives 54 pt left and right, Wide 144; header, footer and gutter stay', () => {
  const m = sectFor(A4, { margins: 'moderate' }).margin;
  assert.deepEqual([m.top, m.right, m.bottom, m.left], [72, 54, 72, 54]);
  assert.deepEqual([sectFor(A4, { margins: 'wide' }).margin.left, sectFor(A4, { margins: 'wide' }).margin.right], [144, 144]);
  assert.equal(m.header, 35.4);
  assert.equal(marginPreset(sectFor(A4, { margins: 'narrow' })), 'narrow');
  assert.equal(marginPreset(sectFor(A4, { margins: { topPt: 10, rightPt: 72, bottomPt: 72, leftPt: 72 } })), null);
});

test('landscape swaps w and h and keeps the margins; a size keeps the orientation', () => {
  const land = sectFor(sectFor(A4, { margins: 'moderate' }), { orientation: 'landscape' });
  assert.deepEqual([land.w, land.h, land.orient], [841.9, 595.3, 'landscape']);
  assert.equal(land.margin.left, 54);
  const letter = sectFor(land, { size: 'letter' });
  assert.deepEqual([letter.w, letter.h, letter.orient], [792, 612, 'landscape']);
  assert.equal(paperSize(letter), 'letter');
  assert.deepEqual([sectFor(letter, { orientation: 'portrait' }).w, sectFor(letter, { orientation: 'portrait' }).h], [612, 792]);
});

test('Letter is 612 x 792; a custom size wider than tall is landscape', () => {
  const s = sectFor(A4, { size: 'letter' });
  assert.deepEqual([s.w, s.h, s.orient], [612, 792, 'portrait']);
  const c = sectFor(A4, { size: { widthPt: 700, heightPt: 500 } });
  assert.deepEqual([c.w, c.h, c.orient, paperSize(c)], [700, 500, 'landscape', null]);
});

test('margins that leave no text column are refused; lengths show in cm or inches', () => {
  assert.equal(tooSmall(A4), null);
  assert.match(tooSmall(sectFor(A4, { margins: { topPt: 72, rightPt: 300, bottomPt: 72, leftPt: 280 } })), /left and right/);
  assert.equal(showIn(72, unitOf('letter')), '1');
  assert.equal(showIn(72, unitOf('a4')), '2.54');
});

test('page counts at content heights on and around page boundaries', () => {
  const body = 600;
  const breaker = 200; // bottom margin, gap, top margin
  assert.equal(pagesFor(0, body, breaker), 1);
  assert.equal(pagesFor(600, body, breaker), 1);
  assert.equal(pagesFor(600.4, body, breaker), 1); // rounding
  assert.equal(pagesFor(601, body, breaker), 2); // a line pushed below the breaker is on page 2...
  assert.equal(pagesFor(700, body, breaker), 2); // ...and so is an end inside the breaker (floats not drawn yet)
  assert.equal(pagesFor(1400, body, breaker), 2);
  assert.equal(pagesFor(1401, body, breaker), 3);
  // pageAt over two runs: the second starts after a manual page break at y 2000.
  const segs = [{ top: 0, pages: 2 }, { top: 2000, pages: 3 }];
  assert.deepEqual([0, 599, 800, 1500, 2000, 2800, 9000].map((y) => pageAt(y, segs, body + breaker)), [0, 0, 1, 1, 2, 3, 4]);
});

test('the page count guard stops an A-B-A flip and runaway growth at the largest count', () => {
  const settle = pageGuard(5);
  assert.deepEqual(settle(1, [3]), [3]);
  assert.deepEqual(settle(1, [4]), [4]);
  assert.deepEqual(settle(1, [3]), [4]); // back to 3 for the same doc: keep 4
  assert.deepEqual(settle(2, [3]), [3]); // a new doc version starts over
  const grow = pageGuard(3);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => grow(7, [n])), [[1], [2], [3], [4], [4], [4]]);
  const still = pageGuard(3);
  for (let i = 0; i < 20; i++) still(9, [2]); // caret moves in one doc version measure the same count
  assert.deepEqual(still(9, [3]), [3]);
});

test('a page number is set and removed through sectFor; other fields stay', () => {
  const s = sectFor(A4, { pageNumber: { at: 'bottom', align: 'center' } });
  assert.deepEqual(s.pageNumber, { at: 'bottom', align: 'center', start: null });
  assert.equal(s.w, A4.w);
  assert.equal(sectFor(s, { margins: 'narrow' }).pageNumber.align, 'center');
  assert.equal(sectFor(s, { pageNumber: null }).pageNumber, null);
});

test('printCss gives the @page size, margins and the page number box', () => {
  const css = printCss(sectFor(A4, { pageNumber: { at: 'bottom', align: 'center' } }));
  assert.match(css, /size: 595\.3pt 841\.9pt; margin: 72pt 72pt 72pt 72pt;/);
  assert.match(css, /@bottom-center \{ content: counter\(page\);/);
  assert.doesNotMatch(printCss(A4), /counter/);
});

// eq-barcode (docs/plans/word/briefs/eq-barcode.md): the boxes Word gives EQ fields and barcodes, and the line room they take,
// against Word's PDF of the fixture (all-features.pdf pages 80 to 84, Aptos 12 pt: ascent 11.27 pt, descent 3.38 pt).
import test from 'node:test';
import assert from 'node:assert/strict';
import { barcodeOf, barcodeSvg } from '../src/document/wp/fields-draw/barcode.mjs';
import { parseEq } from '../src/document/wp/fields-draw/eq.mjs';
import { eqLayout, eqSvg } from '../src/document/wp/fields-draw/eqbox.mjs';
import { overflowRoom, pictureRoom } from '../src/document/wp/fields-draw/room.mjs';

// Aptos at 12 pt (OS/2 typographic ascender and descender), with a stand-in advance of half an em a character.
const APTOS = { a: 0.93896484375, d: 0.28173828125, s: 12, width: (t, k = 1) => [...t].length * 0.5 * k };
const A = APTOS.a * 12;
const D = APTOS.d * 12;
/** How far (pt) the EQ code's box reaches past the text's ascent and descent: the room Word adds to its line. */
const over = (code) => {
  const b = eqLayout(parseEq(code), APTOS);
  return [(b.asc - APTOS.a) * 12, (b.desc - APTOS.d) * 12];
};
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got.toFixed(2)} against Word's ${want}`);

test('EQ boxes reach as far past the text as Word drew them', () => {
  // [code, above, below, tolerance]: each from the label baselines either side of the line (pitch less 24.96).
  const cases = [
    ['EQ \\f(1,2)', 9.0, 5.76, 0.1],
    ['EQ \\a(1,2,3)', 16.35, 12.96, 0.15],
    ['EQ \\a \\ac \\co3(1,2,3,4,5,6)', 9.0, 5.64, 0.1],
    ['EQ \\a \\al \\co2 \\vs3 \\hs3(1,2,3,4)', 10.44, 7.2, 0.15],
    ['EQ x\\s\\up8(2)', 8.04, 0, 0.1],
    ['EQ x\\s\\do4(2)', 0, 3.96, 0.1],
    ['EQ \\s\\ai4(x)', 7.08, 0, 0.15],
    ['EQ \\s\\di4(x)', 3.0, 1.0, 0.1],
    ['EQ \\s(a,b)', 9.0, 5.64, 0.1],
    ['EQ \\x(boxed)', 4.08, 3.84, 0.1],
    ['EQ \\x \\to(x)', 4.08, 3.84, 0.1],
    ['EQ \\b(x)', 0, 3.0, 0.15],
    ['EQ \\i(a,b,x)', 14.91, 17.04, 0.15],
    ['EQ \\i \\su(1,5,3)', 15.12, 15.72, 0.15],
    ['EQ \\i \\pr(a,b,c)', 15.12, 15.72, 0.15],
    ['EQ \\o(=,/)', 0, 0, 0.01],
    ['EQ \\d \\fo10()x', 0, 0, 0.01],
  ];
  for (const [code, up, down, tol] of cases) {
    const [oa, ob] = over(code);
    near(oa, up, tol, `${code} above`);
    near(ob, down, tol, `${code} below`);
  }
  // Radicals: \r(,x) 2.4 above (2.76 read beside a fraction), with an index 12.84 over its two lines.
  near(over('EQ \\r(,x)')[0], 2.4, 0.01, '\\r(,x) above');
  near(over('EQ \\r(3,x)')[0], 12.84, 0.05, '\\r(3,x) above');
  // Nested: a radical as the numerator sits on the bar like any other (Word: x at -9.00 pt, 11.04 pt above for 13.79 under it).
  near(over('EQ \\f(\\r(,x),2)')[0], 11.04, 0.8, '\\f(\\r(,x),2) above');
});

test('EQ draws an SVG on the baseline, sized in em', () => {
  const svg = eqSvg(eqLayout(parseEq('EQ \\f(1,2)'), APTOS));
  assert.match(svg, /^<svg class="fd-eq"/);
  assert.match(svg, />1<\/text>.*>2<\/text>/);
  assert.match(svg, /vertical-align:-\d+\.\d+em/);
  assert.match(svg, /<polyline/); // the bar
});

test('room: glyph overflow is added unscaled, a picture scales with the line spacing', () => {
  assert.equal(overflowRoom(0, 0), null);
  assert.equal(overflowRoom(8, 0), 'line-height:calc(1lh + 8pt);vertical-align:4pt');
  assert.equal(overflowRoom(9, 5.76), 'line-height:calc(1lh + 14.76pt);vertical-align:1.62pt');
  assert.equal(pictureRoom(9.4, A, D), null, 'a picture no taller than the text leaves the line alone');
  // An 84 pt barcode in Aptos 12 pt: the room inline is 84 / 14.65 lines plus the descent tall; at Word's 1.1583 multiple the
  // line is 1.1583 x 84 + 3.38 = 100.68 pt (Word: 108.60 - 8 = 100.60 between two CODE128 and CODE39 labels).
  const css = pictureRoom(84, A, D);
  const m = /calc\(1lh \* ([\d.]+) \+ ([\d.]+)pt\)/.exec(css);
  near(16.97 * Number(m[1]) + Number(m[2]), 100.6, 0.15, 'the 84 pt barcode line');
});

test('barcodes are as tall as Word drew them', () => {
  const h = (data, type, sw = {}) => barcodeSvg(barcodeOf(data, type, sw), sw).height;
  near(h('1234567890123', 'ITF14'), 72.0, 0.1, 'ITF-14 with its bearers');
  near(h('1234567890123', 'CASE'), 72.0, 0.1, 'CASE');
  near(h('1234567', 'EAN8'), 85.5, 0.1, 'EAN-8 with its guard bars');
  near(h('123456789012', 'EAN13'), 85.6, 0.1, 'EAN-13');
  near(h('123456789012', 'EAN13', { p: 'CASE' }), 104.6, 0.1, 'EAN-13 in its case frame');
  near(h('ABC-123', 'CODE128'), 84, 0.01, 'CODE128');
  near(h('https://example.com', 'QR', { q: '3' }), 94.1, 0.05, 'QR \\q 3 (Word draws level Q)');
});

// Tab rules from the page walk against Word (docs/plans/word/briefs/tabs-pages.md): stops past the right indent or margin, alignment
// tabs behind the pen and the decimal tab's alignment point, each from Word's PDF of .smoke-data/word/fixture/walk/tabs_docx.py
// (A4, 72 pt margins: column 451.3 pt) or the fixture's tab pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decimalAt, layoutLine, placePtab, placeTab } from '../src/document/wp/tabs/layout.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) <= 0.5, `${a} vs ${b}`);
const L = (pos, align = 'left', leader = 'none') => ({ pos, align, leader });
const C = (o = {}) => ({ stops: [], def: 36, left: 0, firstLine: 0, right: 451.3, width: 451.3, ...o });
const at = (pen, c) => ({ ...c, lineStart: c.left, first: false });

test('centre and decimal stops past the right margin right-align on the margin (probe C, D)', () => {
  for (const align of ['center', 'decimal']) {
    const r = placeTab(100, at(100, C({ stops: [L(475, align)] })), { w: 30, dec: 10 });
    near(100 + r.w + 30, 451.3);
    assert.equal(r.wrap, false);
  }
});

test('a right stop past the right indent right-aligns on the indent', () => {
  const r = placeTab(50, at(50, C({ stops: [L(400, 'right')], right: 307.3 })), { w: 20 });
  near(50 + r.w + 20, 307.3);
});

test('a left stop past the margin wraps the tab, which fills the next line: the text starts on the third (probe E, fixture 1584 pt)', () => {
  const p = layoutLine([{ text: 80 }, { tab: true }, { text: 23 }], C({ stops: [L(1584)] }));
  assert.equal(p[1].line, 1);
  assert.equal(p[2].line, 2);
  near(p[2].x, 0);
});

test('a left stop between the right indent and the margin is honoured on its line (fixture next stop past the right indent)', () => {
  const p = layoutLine([{ text: 235 }, { tab: true }, { text: 23 }], C({ stops: [L(360)], right: 307.3 }));
  assert.equal(p[2].line, 0);
  near(p[2].x, 360);
});

test('a centre alignment tab behind the pen moves the text after it to the next line, centred there (probe J)', () => {
  const r = placePtab(284.3, { align: 'center' }, at(284.3, C()), { w: 20.5 });
  assert.equal(r.wrap, true);
  near(r.w + 20.5 / 2, 451.3 / 2);
  const p = layoutLine([{ text: 284.3 }, { ptab: { align: 'center' } }, { text: 20.5 }], C());
  assert.equal(p[2].line, 1);
  near(p[2].x, 451.3 / 2 - 10.25);
});

test('a left alignment tab behind the pen puts the text after it at the next line start (fixture, probe L)', () => {
  const p = layoutLine([{ text: 200 }, { ptab: { align: 'left' } }, { text: 23 }], C());
  assert.equal(p[2].line, 1);
  near(p[2].x, 0);
  const q = layoutLine([{ text: 150 }, { ptab: { align: 'left', relativeTo: 'indent' } }, { text: 23 }], C({ left: 36 }));
  assert.equal(q[2].line, 1);
  near(q[2].x, 36);
});

test('a right alignment tab with room before it stays on its line (probe K)', () => {
  const r = placePtab(370, { align: 'right' }, at(370, C()), { w: 20.5 });
  assert.equal(r.wrap, false);
  near(370 + r.w + 20.5, 451.3);
});

test('the decimal point: the first decimal symbol, else the first non-digit after digits, else none', () => {
  assert.equal(decimalAt('123.45', '.'), 3);
  assert.equal(decimalAt('0.125 and 7.5', '.'), 1);
  assert.equal(decimalAt('12345 (no decimal point: acts as right)', '.'), 5);
  assert.equal(decimalAt('12345', '.'), null);
  assert.equal(decimalAt('text only', '.'), null);
  assert.equal(decimalAt('1,234.5', '.'), 5);
  assert.equal(decimalAt('1,5', '.'), null);
  // The digit run carries across text nodes.
  const st = { num: false };
  assert.equal(decimalAt('12', '.', st), null);
  assert.equal(decimalAt('34 x', '.', st), 2);
});

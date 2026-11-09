import assert from 'node:assert/strict';
import test from 'node:test';
import { accessOf } from '../src/tooling/kit/access.mjs';
import { hexOf, rgbOf } from '../src/tooling/kit/color.mjs';
import { formatLength, LIMITS, parseLength, unitOf, UNITS } from '../src/tooling/kit/units.mjs';

// The dialog kit's pure parts (plan.md §1.6): lengths, units, access keys and colour models.

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('parseLength reads every unit, a bare number in the shown unit, and lines only where asked', () => {
  near(parseLength('2.54 cm', 'in'), 72);
  near(parseLength('1"', 'cm'), 72);
  near(parseLength('1 in', 'cm'), 72);
  near(parseLength('25.4mm', 'pt'), 72);
  near(parseLength('12 pt', 'cm'), 12);
  near(parseLength('3 pi', 'cm'), 36);
  near(parseLength('2', 'cm'), 2 * UNITS.cm);
  near(parseLength('-.5 in', 'cm'), -36);
  assert.deepEqual(parseLength('1.5 li', 'pt', { lines: true }), { lines: 1.5 });
  assert.equal(parseLength('1 li', 'pt'), null);
  for (const bad of ['', 'abc', '2 km', '1..2 cm', null]) assert.equal(parseLength(bad, 'cm'), null, String(bad));
});

test('formatLength shows points in each unit as Word does', () => {
  assert.equal(formatLength(72, 'cm'), '2.54 cm');
  assert.equal(formatLength(72, 'in'), '1"');
  assert.equal(formatLength(72, 'mm'), '25.4 mm');
  assert.equal(formatLength(12, 'pt'), '12 pt');
  assert.equal(formatLength(36, 'pi'), '3 pi');
  assert.equal(formatLength(36.85, 'cm', 1), '1.3 cm');
  for (const u of Object.keys(UNITS)) near(parseLength(formatLength(90, u, 6), u), 90);
});

test('LIMITS: Word\'s ranges in points, low before high', () => {
  assert.deepEqual(LIMITS.indent, [-1584, 1584]);
  assert.deepEqual(LIMITS.page, [7.2, 1584]);
  for (const [lo, hi] of Object.values(LIMITS)) assert.ok(lo < hi);
});

test('unitOf: the setting, else the profile default, else the region (inches in the US, Liberia and Myanmar)', () => {
  assert.equal(unitOf({ word: { units: 'mm' } }, { defaults: { units: 'in' } }, 'cm'), 'mm');
  assert.equal(unitOf({ word: { units: null } }, { defaults: { units: 'pt' } }, 'cm'), 'pt');
  assert.equal(unitOf({}, null, 'in'), 'in');
  assert.equal(unitOf({}, null, 'cm'), 'cm');
  assert.equal(unitOf(null, null, 'en-US'), 'in');
  assert.equal(unitOf(null, null, 'my-MM'), 'in');
  assert.equal(unitOf(null, null, 'en-GB'), 'cm');
  assert.equal(unitOf(null, null, undefined), 'cm');
});

test('accessOf: the "&" marker, "&&" as a literal ampersand, and labels without a key', () => {
  assert.deepEqual(accessOf('Stri&kethrough'), { text: 'Strikethrough', key: 'k', at: 4 });
  assert.deepEqual(accessOf('&Font:'), { text: 'Font:', key: 'f', at: 0 });
  assert.deepEqual(accessOf('Emphasis mark&:'), { text: 'Emphasis mark:', key: ':', at: 13 });
  assert.deepEqual(accessOf('Find && &Replace'), { text: 'Find & Replace', key: 'r', at: 7 });
  assert.deepEqual(accessOf('OK'), { text: 'OK', key: null, at: -1 });
});

test('colour models: hex and RGB (the picker formats are in word-color-picker.test.mjs)', () => {
  assert.deepEqual(rgbOf('#808080'), [128, 128, 128]);
  assert.equal(rgbOf('#80808'), null);
  assert.equal(hexOf([255, 0, 128.4]), '#FF0080');
});

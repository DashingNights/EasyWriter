// The paragraph work package's pure rules (docs/plans/word/briefs/paragraph.md Acceptance): line heights, the gap between
// paragraphs, contextual spacing, Special and By, the indent steps and typed lengths.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  firstLineOf, gap, gapBetween, hang, lineCss, lineOf, linePitch, lineRuleOf, nextStop, prevStop, rangeMessage, readLength, specialOf, styleProps,
} from '../src/document/wp/paragraph/rules.mjs';
import { LIMITS } from '../src/tooling/kit/units.mjs';

const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) <= d, `${a} is not ${b}`);
const TNR = 1.15; // Times New Roman's single line over its size: 13.80 pt at 12 pt in Word

test('line pitch for every rule', () => {
  const single = TNR * 12;
  near(linePitch(null, single), 13.8);
  near(linePitch({ rule: 'auto', value: 1.5 }, single), 20.7);
  near(linePitch({ rule: 'auto', value: 2 }, single), 27.6);
  near(linePitch({ rule: 'auto', value: 1.15 }, single), 15.87);
  near(linePitch({ rule: 'auto', value: 0.01 }, single), 0.06 * single); // Multiple clamps at 0.06
  near(linePitch({ rule: 'auto', value: 500 }, single), 132 * single); // and at 132
  near(linePitch({ rule: 'atLeast', value: 6 }, single), 13.8); // below Single: Single
  near(linePitch({ rule: 'atLeast', value: 20 }, single), 20); // above: the value
  near(linePitch({ rule: 'exact', value: 0.1 }, single), 0.7); // Exactly's floor
  near(linePitch({ rule: 'exact', value: 20 }, single), 20);
});

test('line height as CSS', () => {
  assert.equal(lineCss({ rule: 'exact', value: 20 }, TNR, 12), '20pt');
  assert.equal(lineCss({ rule: 'atLeast', value: 6 }, TNR, 12), '1.15');
  assert.equal(lineCss({ rule: 'atLeast', value: 30 }, TNR, 12), '30pt');
  assert.equal(lineCss({ rule: 'auto', value: 1.15 }, TNR, 12), '1.3225');
  assert.equal(lineCss(null, TNR, 12), '1.15');
});

test('the gap is the larger of after and before, or the sum in compatibility mode', () => {
  assert.equal(gap(18, 6), 18);
  assert.equal(gap(10, 10), 10);
  assert.equal(gap(30, 1), 30);
  assert.equal(gap(18, 6, { sum: true }), 24);
  assert.equal(gap(10, 10, { sum: true }), 20);
});

test('contextual spacing', () => {
  const normal = { style: 'Normal', contextual: true, before: 6, after: 8 };
  assert.equal(gapBetween(normal, { ...normal }), 0);
  assert.equal(gapBetween(normal, { style: 'Heading1', contextual: false, before: 12 }), 12);
  assert.equal(gapBetween({ ...normal, contextual: false, after: 8 }, { style: 'Normal', contextual: false, before: 0 }), 8);
});

test('Special and By to the indent and back', () => {
  assert.equal(firstLineOf('hanging', 18), -18);
  assert.equal(firstLineOf('firstLine', 36), 36);
  assert.equal(firstLineOf('none', 36), null);
  assert.deepEqual(specialOf(-18), { special: 'hanging', by: 18 });
  assert.deepEqual(specialOf(36), { special: 'firstLine', by: 36 });
  assert.deepEqual(specialOf(null), { special: 'none', by: null });
});

test('indent steps', () => {
  assert.equal(nextStop(10), 36);
  assert.equal(nextStop(36), 72);
  assert.equal(prevStop(40), 36);
  assert.equal(prevStop(0), 0);
  assert.equal(prevStop(36), 0);
  assert.equal(prevStop(-20), -20);
  assert.equal(nextStop(0, 50), 50);
  assert.deepEqual(hang({ left: 0, firstLine: 0 }), { left: 36, firstLine: -36 });
  assert.deepEqual(hang({ left: 36, firstLine: -36 }), { left: 72, firstLine: -72 });
  assert.deepEqual(hang({ left: 72, firstLine: -72 }, 36, false), { left: 36, firstLine: -36 });
  assert.deepEqual(hang({ left: 36, firstLine: -36 }, 36, false), { left: 0, firstLine: null });
});

test('typed lengths', () => {
  near(readLength('2.54 cm', 'cm'), 72);
  near(readLength('1"', 'cm'), 72);
  assert.equal(readLength('1 li', 'pt', { lines: true }), 12);
  assert.equal(readLength('1 li', 'pt'), null);
  near(readLength('2', 'cm'), 56.69);
  assert.equal(readLength('abc', 'cm'), null);
  assert.equal(rangeMessage(2000, LIMITS.indent, 'pt'), 'The value must be between -1584 pt and 1584 pt.');
  assert.equal(rangeMessage(-10, LIMITS.spacing, 'pt'), 'The value must be between 0 pt and 1584 pt.');
  assert.equal(rangeMessage(12, LIMITS.spacing, 'pt'), null);
});

test('line rules in the dialog', () => {
  assert.deepEqual(lineRuleOf(null), { rule: 'single', at: null });
  assert.deepEqual(lineRuleOf({ rule: 'auto', value: 1.1583 }), { rule: 'multiple', at: 1.16 });
  assert.deepEqual(lineRuleOf({ rule: 'auto', value: 2 }), { rule: 'double', at: null });
  assert.deepEqual(lineRuleOf({ rule: 'exact', value: 20 }), { rule: 'exact', at: 20 });
  assert.deepEqual(lineOf('onePt5'), { rule: 'auto', value: 1.5 });
  assert.deepEqual(lineOf('exact', 20), { rule: 'exact', value: 20 });
});

test('a table style lies over docDefaults and Normal, under other paragraph styles', () => {
  const doc = { attrs: { styles: {
    defaults: { run: { font: '+minor', size: 11 }, para: { spacing: { after: 8, line: { rule: 'auto', value: 1.08 } } } },
    list: {
      Normal: { type: 'paragraph', para: { spacing: { after: 10 } } },
      Quote: { type: 'paragraph', basedOn: 'Normal', para: { spacing: { after: 4 } } },
      TableNormal: { type: 'table' },
      TableGrid: { type: 'table', basedOn: 'TableNormal', para: { spacing: { after: 0, line: { rule: 'auto', value: 1 } } } },
    },
  } } };
  assert.deepEqual(styleProps(doc, 'Normal').para.spacing, { after: 10, line: { rule: 'auto', value: 1.08 } });
  assert.deepEqual(styleProps(doc, 'Normal', 'TableGrid').para.spacing, { after: 0, line: { rule: 'auto', value: 1 } });
  assert.deepEqual(styleProps(doc, 'Quote', 'TableGrid').para.spacing, { after: 4, line: { rule: 'auto', value: 1 } });
});

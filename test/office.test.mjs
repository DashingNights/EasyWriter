import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FONT_SIZES, fontStack, growSize, numberLabel, ptToEighths, ptToEmu, ptToHalfPoints, ptToPx, ptToTwips, pxToPt, resolveColor,
  shrinkSize, size1, THEME_GRID, toDrawingColor, toExcelTint, toWordColor,
} from '../src/office.mjs';
import { THEME } from '../src/document/defaults.mjs';
import { validate } from '../src/app/schema.mjs';
import { PARA_ARGS, RUN_ARGS } from '../src/office.mjs';

test('points convert to twips, half-points, eighths and EMU and back', () => {
  for (const pt of [0.5, 1, 8, 10.5, 12, 72]) { // sizes and border widths
    assert.equal(ptToHalfPoints(pt) / 2, pt);
    assert.equal(ptToEighths(pt) / 8, pt);
  }
  for (const pt of [0.5, 12, 35.4, 72, 595.3, 841.9]) { // lengths
    assert.equal(ptToTwips(pt) / 20, pt);
    assert.equal(ptToEmu(pt) / 12700, pt);
    assert.equal(pxToPt(ptToPx(pt)), pt);
  }
  assert.equal(ptToTwips(595.3), 11906); // A4 width
});

test("theme lum maps to Word's themeTint and themeShade bytes", () => {
  const byte = (lum) => { const w = toWordColor('#000000', { slot: 'accent1', lum }); return w.themeTint ?? w.themeShade; };
  const accent = THEME_GRID.find((c) => c.slot === 'accent1').lums;
  assert.deepEqual(accent.map(byte), ['33', '66', '99', 'BF', '80']);
  assert.deepEqual(THEME_GRID.find((c) => c.slot === 'dk1').lums.map(byte), ['80', 'A6', 'BF', 'D9', 'F2']);
  assert.ok('themeShade' in toWordColor('#0F4761', { slot: 'accent1', lum: -0.25 }));
  assert.deepEqual(toWordColor('#0F4761', { slot: 'dk1', lum: 0 }), { val: '0F4761', themeColor: 'text1' });
  assert.deepEqual(toWordColor(null), { val: 'auto' });
});

test('accent1 darkened 25% resolves within 1 per channel of the probe colour', () => {
  const got = resolveColor(THEME, { slot: 'accent1', lum: -0.25 });
  const ch = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  ch(got).forEach((v, i) => assert.ok(Math.abs(v - ch('#0F4761')[i]) <= 1, got));
  assert.equal(resolveColor(THEME, { slot: 'dk1', lum: 0.35 }), '#595959');
  assert.equal(resolveColor(THEME, { slot: 'accent2', lum: 0 }), '#E97132');
});

test('DrawingML lumMod / lumOff and the Excel tint', () => {
  assert.deepEqual(toDrawingColor({ slot: 'accent1', lum: -0.25 }), { scheme: 'accent1', lumMod: 75000 });
  assert.deepEqual(toDrawingColor({ slot: 'accent1', lum: 0.4 }), { scheme: 'accent1', lumMod: 60000, lumOff: 40000 });
  assert.deepEqual(toDrawingColor({ slot: 'dk2' }), { scheme: 'dk2' });
  assert.deepEqual(toExcelTint({ slot: 'dk1', lum: 0.5 }), { theme: 1, tint: 0.5 });
  assert.deepEqual(toExcelTint({ slot: 'accent1', lum: -0.25 }), { theme: 4, tint: -0.25 });
});

test('grow and shrink walk the size list', () => {
  assert.equal(growSize(11), 12);
  assert.equal(growSize(10.5), 11);
  assert.equal(growSize(13), 14);
  assert.equal(growSize(72), 80);
  assert.equal(shrinkSize(12), 11);
  assert.equal(shrinkSize(8), 7);
  assert.equal(shrinkSize(80), 72);
  assert.equal(shrinkSize(1), 1);
  assert.equal(growSize(1638), 1638);
  for (let i = 1; i < FONT_SIZES.length; i++) assert.equal(growSize(FONT_SIZES[i - 1]), FONT_SIZES[i]);
  assert.equal(size1(12, 1), 13);
  assert.equal(size1(1, -1), 1);
});

test('number labels: decimal, letters and roman', () => {
  assert.equal(numberLabel(3, 'decimal'), '3');
  assert.equal(numberLabel(1, 'lowerLetter'), 'a');
  assert.equal(numberLabel(27, 'lowerLetter'), 'aa');
  assert.equal(numberLabel(26, 'upperLetter'), 'Z');
  assert.equal(numberLabel(4, 'lowerRoman'), 'iv');
  assert.equal(numberLabel(1994, 'upperRoman'), 'MCMXCIV');
});

test('font stacks resolve theme fonts and fall back to metric clones', () => {
  assert.equal(fontStack('+minor', THEME), '"Aptos", "Calibri", "Carlito", sans-serif');
  assert.equal(fontStack('+major', THEME), '"Aptos Display", "Calibri Light", "Calibri", "Carlito", sans-serif');
  assert.equal(fontStack('Cambria'), '"Cambria", "Caladea", serif');
});

test('the run and paragraph arguments take points, hex and theme colours, and refuse the forum values', () => {
  const ok = (schema, v) => assert.deepEqual(validate(schema, v), [], JSON.stringify(v));
  const bad = (schema, v) => assert.notDeepEqual(validate(schema, v), [], JSON.stringify(v));
  ok(RUN_ARGS, { sizePt: 10.5, color: '#C00000', highlight: 'yellow', underline: 'double', font: '+minor' });
  ok(RUN_ARGS, { color: { theme: 'accent1', lum: -0.25 } });
  ok(RUN_ARGS, { color: null, highlight: null });
  bad(RUN_ARGS, { sizePt: 0 });
  bad(RUN_ARGS, { sizePt: 1639 });
  bad(RUN_ARGS, { color: 'red' }); // the forum's colour names
  bad(RUN_ARGS, { highlight: 'orange' });
  bad(RUN_ARGS, { fontSize: 150 }); // the forum's percent sizes
  bad(RUN_ARGS, {});
  bad(RUN_ARGS, { underline: 'squiggle' });
  bad(RUN_ARGS, { color: { theme: 'accent9' } });
  ok(PARA_ARGS, { style: 'Title', spaceBeforePt: 12, lineSpacing: { multiple: 1.5 }, indent: { leftPt: 36, firstLinePt: -18 }, list: { kind: 'bullet', level: 2 } });
  ok(PARA_ARGS, { lineSpacing: { exactPt: 14 } });
  ok(PARA_ARGS, { indent: { leftPt: 0 }, list: { kind: null } });
  bad(PARA_ARGS, { lineSpacing: { multiple: 1.5, exactPt: 14 } });
  bad(PARA_ARGS, { lineSpacing: 1.5 });
  bad(PARA_ARGS, { list: { kind: 'number', level: 9 } });
  bad(PARA_ARGS, { spaceAfterPt: -1 });
});

// Phonetic guide layout rules (src/document/wp/font/ruby.mjs; docs/plans/word/briefs/font-pages.md). The figures are Word's, from
// its PDF of .smoke-data/word/fixture/walk/ruby_docx.py's document (fixture Normal: Aptos 12 pt, line 278/240, a 6 pt MS Mincho
// reading at offset 11 pt).
import assert from 'node:assert/strict';
import test from 'node:test';
import { isEastAsian, piecesOf, readingAscent, rubyRoom } from '../src/document/wp/font/ruby.mjs';

const MINCHO = { asc: 220 / 256, desc: 36 / 256 };
const APTOS = { asc: 1923 / 2048, desc: 577 / 2048 };
const MULT = { rule: 'auto', value: 278 / 240 };
// The fixture's Normal line: Aptos 12 pt, Word's ascent and descent, CSS line height and how far CSS draws it under the baseline.
const line = (rule, box = MINCHO) => {
  const css = (rule?.value ?? 1) * 14.65;
  return { A: 11.27, D: 3.38, rule, css, below: css / 2 - 3.94, base: 12, box };
};

test('an East Asian reading reaches its font height and 15% above its baseline, a Latin one its ascent', () => {
  assert.ok(isEastAsian('かんじ') && isEastAsian('漢字') && !isEastAsian('ruby'));
  assert.ok(Math.abs(readingAscent('かんじ', 72, MINCHO) - 72.6) < 0.1, 'MS Mincho 72 pt: Word 72.6');
  assert.ok(Math.abs(readingAscent('ab', 6, APTOS) - 5.65) < 0.1, 'Aptos 6 pt: Word 5.65');
});

test('the line grows to the reading top and keeps the spacing rule', () => {
  // Word: 56.64 pt from the paragraph before to the one after against 49.94 without a guide, so the line is 6.70 pt taller.
  const r = rubyRoom({ text: 'かんじ', size: 6, offset: 11 }, line(MULT));
  assert.ok(Math.abs(r.up + r.down - MULT.value * (11.27 + 3.38) - 6.70) < 0.1, JSON.stringify(r));
  // Single spacing: 35.16 against 29.28 (5.88 taller); the box reaches as far down as CSS's own line does.
  const s = rubyRoom({ text: 'かんじ', size: 6, offset: 11 }, line({ rule: 'auto', value: 1 }));
  assert.ok(Math.abs(s.up + s.down - 14.65 - 5.88) < 0.15, JSON.stringify(s));
  assert.ok(s.down >= line({ rule: 'auto', value: 1 }).below + 0.75);
  // At least 20 pt with a 50 pt offset: 79.47 against 40 for two 20 pt lines, so the line is 59.47.
  const a = rubyRoom({ text: 'かんじ', size: 6, offset: 50 }, line({ rule: 'atLeast', value: 20 }));
  assert.ok(Math.abs(a.up + a.down - 59.47) < 0.15, JSON.stringify(a));
});

test('a reading inside the line, or Exactly spacing, leaves the line alone', () => {
  assert.equal(rubyRoom({ text: 'かんじ', size: 6, offset: 5 }, line(MULT)), null, '5 pt offset: Word keeps the line');
  assert.equal(rubyRoom({ text: 'かんじ', size: 6, offset: 11 }, line({ rule: 'exact', value: 20 })), null);
  // No size: half the base.
  assert.ok(rubyRoom({ text: 'かんじ', offset: 11 }, line(MULT)).up > 11.27);
});

test('a distributed text spreads by character, the others stay whole', () => {
  assert.deepEqual(piecesOf('漢字', 'distributeSpace'), ['漢', '字']);
  assert.deepEqual(piecesOf('漢字', 'distributeLetter'), ['漢', '字']);
  assert.deepEqual(piecesOf('漢字', 'center'), ['漢字']);
  assert.deepEqual(piecesOf('漢', 'distributeSpace'), ['漢']);
});

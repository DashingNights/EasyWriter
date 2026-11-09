// lists-pages (docs/plans/word/briefs/lists-pages.md): the list labels and number runs the Word fixture's lists pages draw.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ascentOf, singleLine } from '../src/document/fonts/metrics.mjs';
import { labelRun } from '../src/document/lists.js';
import { formatNumber } from '../src/document/numbering.mjs';

// Word's labels for items 1 to 3 of each Define New Number Format case (all-features.pdf pages 146 to 152).
const WORD = {
  chicago: '* † ‡', ideographDigital: '一 二 三', japaneseCounting: '一 二 三', aiueo: 'ｱ ｲ ｳ', iroha: 'ｲ ﾛ ﾊ', decimalFullWidth: '１ ２ ３',
  decimalHalfWidth: '1 2 3', japaneseLegal: '壱 弐 参', japaneseDigitalTenThousand: '一 二 三', decimalEnclosedCircle: '① ② ③',
  decimalFullWidth2: '１ ２ ３', aiueoFullWidth: 'ア イ ウ', irohaFullWidth: 'イ ロ ハ', decimalZero: '01 02 03', ganada: '가 나 다', chosung: 'ㄱ ㄴ ㄷ',
  decimalEnclosedFullstop: '⒈ ⒉ ⒊', decimalEnclosedParen: '⑴ ⑵ ⑶', decimalEnclosedCircleChinese: '① ② ③', ideographEnclosedCircle: '㈠ ㈡ ㈢',
  ideographTraditional: '甲 乙 丙', ideographZodiac: '子 丑 寅', ideographZodiacTraditional: '甲子 乙丑 丙寅', taiwaneseCounting: '一 二 三',
  ideographLegalTraditional: '壹 貳 參', taiwaneseCountingThousand: '一 二 三', taiwaneseDigital: '一 二 三', chineseCounting: '一 二 三',
  chineseLegalSimplified: '壹 贰 叁', chineseCountingThousand: '一 二 三', koreanDigital: '일 이 삼', koreanCounting: '일 이 삼', koreanLegal: '하나 둘 셋',
  koreanDigital2: '一 二 三', hebrew1: 'א ב ג', arabicAlpha: 'أ ب ت', hebrew2: 'א ב ג', arabicAbjad: 'أ ب ج', hindiVowels: 'क ख ग',
  hindiConsonants: 'अ आ इ', hindiNumbers: '१ २ ३', hindiCounting: 'एक दो तीन', thaiLetters: 'ก ข ค', thaiNumbers: '๑ ๒ ๓',
  thaiCounting: 'หนึ่ง สอง สาม', vietnameseCounting: 'một hai ba', numberInDash: '- 1 -|- 2 -|- 3 -', russianLower: 'а б в', russianUpper: 'А Б В',
  hex: '1 2 3', ordinal: '1st 2nd 3rd', cardinalText: 'One Two Three', ordinalText: 'First Second Third',
};

test('every number format draws Word\'s labels for 1, 2 and 3', () => {
  for (const [fmt, want] of Object.entries(WORD)) {
    const got = [1, 2, 3].map((n) => formatNumber(n, fmt)).join(want.includes('|') ? '|' : ' ');
    assert.equal(got, want, fmt);
  }
});

test('letter lists double past their last letter, counting lists carry on in their own script', () => {
  assert.equal(formatNumber(5, 'chicago'), '**');
  assert.equal(formatNumber(29, 'russianLower'), 'аа');
  assert.equal(formatNumber(11, 'koreanLegal'), '열하나');
  assert.equal(formatNumber(10, 'japaneseLegal'), '壱拾');
  assert.equal(formatNumber(12, 'koreanCounting'), '십이');
  assert.equal(formatNumber(10, 'ideographDigital'), '一〇');
  assert.equal(formatNumber(0, 'decimal'), '0');
});

test('the number takes the paragraph mark\'s run, the level\'s own on top', () => {
  const node = (markRun) => ({ attrs: { markRun } });
  assert.equal(labelRun(node(null), { fmt: 'decimal' }), null);
  assert.deepEqual(labelRun(node({ font: 'Courier New', size: 20 }), { fmt: 'decimal' }), { font: 'Courier New', size: 20 });
  assert.deepEqual(labelRun(node({ font: 'Courier New', size: 20 }), { run: { font: 'Symbol' } }), { font: 'Symbol', size: 20 });
});

test('Word\'s ascent is the single line less the descent singleLine takes', () => {
  // Aptos (USE_TYPO_METRICS): 0.939; Calibri: its Windows ascent 0.9521; Symbol: 1.0054 (fonts/metrics.mjs).
  const aptos = { upm: 2048, useTypo: true, typoAscender: 1923, typoDescender: -577, typoLineGap: 0, winAscent: 2068, winDescent: 563, ascender: 1923, descender: -577, lineGap: 0 };
  const calibri = { upm: 2048, useTypo: false, typoAscender: 1536, typoDescender: -512, typoLineGap: 452, winAscent: 1950, winDescent: 550, ascender: 1536, descender: -512, lineGap: 452 };
  assert.ok(Math.abs(ascentOf(aptos) - 1923 / 2048) < 1e-9);
  assert.ok(Math.abs(ascentOf(calibri) - 1950 / 2048) < 1e-9);
  assert.ok(Math.abs(singleLine(calibri) - ascentOf(calibri) - 550 / 2048) < 1e-9);
});

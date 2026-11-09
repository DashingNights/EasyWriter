// The Word status bar's pure parts (docs/plans/word/briefs/statusbar.md): the count rule against every count row of
// probe/behaviour-tests.tsv, the zoom slider's scale, the position text and the item list.
import assert from 'node:assert/strict';
import test from 'node:test';
import { countParagraph, countText, countWords } from '../src/document/wp/statusbar/count.mjs';
import { ITEMS, positionText, wordsText, charsText, languageName } from '../src/document/wp/statusbar/items.mjs';
import { pctToPos, posToPct, stepZoom } from '../src/document/wp/statusbar/zoomScale.mjs';
import { WORD_DEFAULTS } from '../src/document/word/settings.mjs';

// [text with \r between paragraphs, words, chars (no spaces), chars with spaces, paragraphs] from probe/behaviour-tests.tsv.
const ROWS = [
  ['one two', 2, 6, 7, 1],
  ['one-two', 1, 7, 7, 1],
  ['one - two', 3, 7, 9, 1],
  ['one \u2014 two', 2, 7, 9, 1],
  ['one\u2014two', 2, 7, 7, 1],
  ['one \u2013 two', 2, 7, 9, 1],
  ["don't", 1, 5, 5, 1],
  ['3.14', 1, 4, 4, 1],
  ['a/b', 1, 3, 3, 1],
  ['hello,world', 1, 11, 11, 1],
  ['hello, world', 2, 11, 12, 1],
  ['e.g. this', 2, 8, 9, 1],
  ['...', 1, 3, 3, 1],
  ['- - -', 3, 3, 5, 1],
  ['#1 @2', 2, 4, 5, 1],
  ['one\ttwo', 2, 6, 7, 1],
  ['one\u00a0two', 2, 6, 7, 1],
  ['line\r\rpara', 2, 8, 8, 2],
  ['x\r \r\ty', 2, 2, 4, 2],
  ['www.example.com/a b', 2, 18, 19, 1],
  ['caf\u00e9 na\u00efve', 2, 9, 10, 1],
  ['\u4f60\u597d\u4e16\u754c test', 5, 8, 9, 1],
];

for (const [text, words, chars, charsSp, paras] of ROWS) {
  test(`count ${JSON.stringify(text)}`, () => {
    const c = countText(text.split('\r'));
    assert.deepEqual(c, { words, chars, charsSp, paras });
  });
}

test('a line break splits words and counts as no character', () => {
  assert.equal(countWords('one\ntwo'), 2);
  assert.deepEqual(countParagraph('one\ntwo'), { words: 2, chars: 6, charsSp: 6, paras: 1 });
});

test('the zoom slider maps 0, 0.25, 0.5, 0.75 and 1 to 10, 55, 100, 300 and 500 and back', () => {
  const marks = [[0, 10], [0.25, 55], [0.5, 100], [0.75, 300], [1, 500]];
  for (const [pos, pct] of marks) {
    assert.equal(posToPct(pos), pct);
    assert.ok(Math.abs(pctToPos(pct) - pos) < 1e-9, `${pct} → ${pctToPos(pct)}`);
  }
  assert.equal(posToPct(-1), 10);
  assert.equal(posToPct(2), 500);
});

test('minus and plus step 10 percent and stay within 10 to 500', () => {
  assert.equal(stepZoom(100, 1), 110);
  assert.equal(stepZoom(104, -1), 90);
  assert.equal(stepZoom(300, 1), 310);
  assert.equal(stepZoom(10, -1), 10);
  assert.equal(stepZoom(500, 1), 500);
  assert.equal(stepZoom(495, 1), 500);
});

test('vertical page position reads in cm, in and mm with one decimal', () => {
  const px = 96; // one inch of layout px
  assert.equal(positionText(px, 'cm'), 'At 2.5 cm');
  assert.equal(positionText(px, 'in'), 'At 1"');
  assert.equal(positionText(px, 'mm'), 'At 25.4 mm');
  assert.equal(positionText(-5, 'cm'), 'At 0 cm');
});

test('word and character texts', () => {
  assert.equal(wordsText(1234), '1,234 words');
  assert.equal(wordsText(1234, 56), '56 of 1,234 words');
  assert.equal(wordsText(1), '1 word');
  assert.equal(charsText(6789, 12), '12 of 6,789 characters');
  assert.equal(languageName('en-US'), 'English (United States)');
});

test("the item list holds settings.word.statusBar's 19 keys in Word's order", () => {
  const order = ['formattedPageNumber', 'section', 'pageNumber', 'verticalPosition', 'lineNumber', 'column', 'wordCount', 'characterCount', 'proofing',
    'language', 'trackChanges', 'capsLock', 'overtype', 'selectionMode', 'accessibility', 'focus', 'viewShortcuts', 'zoomSlider', 'zoom'];
  assert.deepEqual(ITEMS.map((i) => i.key), order);
  assert.deepEqual(Object.keys(WORD_DEFAULTS.statusBar).sort(), [...order].sort());
  const on = ITEMS.filter((i) => WORD_DEFAULTS.statusBar[i.key]).map((i) => i.key);
  assert.deepEqual(on, ['pageNumber', 'wordCount', 'proofing', 'accessibility', 'focus', 'viewShortcuts', 'zoomSlider', 'zoom']);
});

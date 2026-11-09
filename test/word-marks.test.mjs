// Formatting marks' pure parts (src/document/wp/marks/kinds.mjs): kinds and data-marks, glyphs and labels, the visible-range
// filter, and crop mark and text boundary geometry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WORD_DEFAULTS, wordSettings } from '../src/document/word/settings.mjs';
import { GLYPH, KINDS, SECTION_LABEL, boundaryRect, breakLabel, charsIn, cropLines, kindsOf, marksAttr, paraGlyph, tabGlyph } from '../src/document/wp/marks/kinds.mjs';

test('kinds: the defaults show only anchors; Show All shows every kind plus all', () => {
  assert.deepEqual(kindsOf(WORD_DEFAULTS), ['anchors']);
  assert.equal(marksAttr(WORD_DEFAULTS), 'anchors');
  const all = wordSettings({ word: { marks: { all: true } } });
  assert.deepEqual(kindsOf(all), [...KINDS, 'all']);
  assert.equal(marksAttr(all), 'tabs spaces paragraphs hidden optionalHyphens anchors all');
  assert.equal(marksAttr(wordSettings({ word: { marks: { anchors: false } } })), null);
  assert.equal(marksAttr(wordSettings({ word: { marks: { spaces: true, anchors: false } } })), 'spaces');
});

test('glyphs and labels: every section break kind, the RTL ¶ and tab arrow', () => {
  assert.equal(paraGlyph(), '¶');
  assert.equal(paraGlyph({ rtl: true }), '⁋');
  assert.equal(paraGlyph({ cellEnd: true, rtl: true }), '¤');
  assert.equal(tabGlyph(), '→');
  assert.equal(tabGlyph(true), '←');
  assert.deepEqual([GLYPH.space, GLYPH.nbsp, GLYPH.lineBreak, GLYPH.optionalHyphen], ['·', '°', '↵', '¬']);
  assert.equal(breakLabel('pageBreak'), 'Page Break');
  assert.equal(breakLabel('columnBreak'), 'Column Break');
  for (const [kind, label] of Object.entries({ nextPage: 'Next Page', continuous: 'Continuous', evenPage: 'Even Page', oddPage: 'Odd Page', nextColumn: 'New Column' })) {
    assert.equal(breakLabel('sectionBreak', { kind }), `Section Break (${label})`);
  }
  assert.equal(breakLabel('sectionBreak', {}), SECTION_LABEL.nextPage);
  assert.equal(breakLabel('paragraph'), null);
});

test('visible range: only the marked characters inside the range, for the kinds shown', () => {
  const text = 'one two three four­five six';
  const spaces = new Set(['spaces']);
  // The text starts at position 10: spaces at 13, 23 and 33, the nbsp at 17, the soft hyphen at 28.
  assert.deepEqual(charsIn(text, 10, 0, 100, spaces).map((c) => [c.pos, c.glyph]), [[13, 'space'], [17, 'nbsp'], [23, 'space'], [33, 'space']]);
  assert.deepEqual(charsIn(text, 10, 14, 24, spaces).map((c) => c.pos), [17, 23]);
  assert.deepEqual(charsIn(text, 10, 0, 100, new Set(['optionalHyphens'])).map((c) => [c.pos, c.glyph]), [[28, 'optionalHyphen']]);
  assert.deepEqual(charsIn(text, 10, 0, 100, new Set(['paragraphs'])), []);
  const long = 'word '.repeat(10000);
  const got = charsIn(long, 0, 25000, 25050, spaces);
  assert.equal(got.length, 10);
  assert.ok(got.every((c) => c.pos >= 25000 && c.pos < 25050 && long[c.pos] === ' '));
});

test('page geometry: four crop corners reaching into the margins, the boundary on the text area', () => {
  const box = { w: 800, h: 1100, top: 96, right: 72, bottom: 96, left: 72 };
  const lines = cropLines(box, 24);
  assert.equal(lines.length, 8);
  const corners = new Set(lines.map((l) => `${l.x1},${l.y1}`));
  assert.deepEqual([...corners].sort(), ['72,1004', '72,96', '728,1004', '728,96'].sort());
  for (const l of lines) {
    assert.equal(Math.hypot(l.x2 - l.x1, l.y2 - l.y1), 24);
    // Every line leaves the text area: its far end lies outside it.
    assert.ok(l.x2 < 72 || l.x2 > 728 || l.y2 < 96 || l.y2 > 1004);
  }
  assert.deepEqual(boundaryRect(box), { left: 72, top: 96, width: 656, height: 908 });
});

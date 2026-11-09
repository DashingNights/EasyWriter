// Indents beyond the text width (docs/plans/word/briefs/para-indents.md): Word's lines reach at most LINE_REACH (22 in.) from the
// column's left edge, and indents that leave no width set one character per line. The predictor with a fake measurer: every
// character 10 px (7.5 pt) wide, on 300 pt paper with 20 pt margins (260 pt of text width).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayout } from '../src/document/layout/engine.mjs';
import { LINE_REACH, reachRight } from '../src/document/wp/paragraph/rules.mjs';

const fake = () => ({
  stats: { calls: 0, hits: 0, ms: 0, fonts: 0 },
  width: (_f, t) => [...t].length * 10,
  metrics: (font) => {
    const px = Number(/([\d.]+)px/.exec(font)[1]);
    return { asc: px * 0.8, desc: px * 0.2, ascU: px * 0.8, descU: px * 0.2 };
  },
});
const sect = { w: 300, h: 200, orient: 'portrait', margin: { top: 20, right: 20, bottom: 20, left: 20, header: 0, footer: 0, gutter: 0 } };
const attrs = { styles: { defaults: { run: { size: 12 }, para: {} }, list: {} }, settings: { defaultTabStop: 36 }, sect, numbering: null, theme: null };
const lines = (text, indent) => {
  const L = createLayout(fake());
  L.open({ type: 'doc', attrs, content: [{ type: 'paragraph', attrs: { styleId: null, indent }, content: [{ type: 'text', text }] }] });
  return L.lines([0])[0][0].map((l) => l.text);
};
const words = (n) => Array.from({ length: n }, () => 'abcd').join(' ');

test('reachRight: a negative right indent stops at 1584 pt from the column\'s left edge', () => {
  assert.equal(LINE_REACH, 1584);
  assert.equal(reachRight(-100, 451.3), -100);
  assert.ok(Math.abs(reachRight(-1584, 451.3) - (451.3 - 1584)) < 1e-9);
  assert.equal(reachRight(36, 451.3), 36);
  assert.equal(reachRight(undefined, 451.3), 0);
});

test('the predictor wraps a negative right indent at the reach', () => {
  // 1584 pt is 2112 px: 42 words of five characters (with the space) fit, not the 60 that 260 + 2000 pt would hold.
  assert.equal(lines(words(100), { right: -2000 })[0].trim().split(' ').length, 42);
  // Within the reach the indent counts in full: 260 + 400 pt is 880 px, 17 words.
  assert.equal(lines(words(100), { right: -400 })[0].trim().split(' ').length, 17);
  // A negative left indent still moves the start out: -1584 to +1584 pt is 4224 px, 84 words.
  assert.equal(lines(words(200), { left: -1584, right: -1584 })[0].trim().split(' ').length, 84);
});

test('indents that leave no width set one character per line', () => {
  assert.equal(lines('abcd efgh', { left: 1584 }).length, 8);
  assert.equal(lines('abcd efgh', { right: 300 }).length, 8);
  // Left 1584 with right -1584: the line would start at the reach, so it has no width either.
  assert.equal(lines('abcd efgh', { left: 1584, right: -1584 }).length, 8);
  // The first line alone: one character past the edge, then the full width.
  assert.deepEqual(lines(`x${words(3)}`, { firstLine: 1584 }), ['x', 'abcd abcd abcd']);
});

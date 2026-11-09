// AutoCorrect and AutoFormat As You Type rules (docs/plans/word plan.md §3 autocorrect; src/document/wp/autocorrect/rules.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoFormatPlan, columnWidths, correct, enterRule, headingOf, linkOf, optionsOf } from '../src/document/wp/autocorrect/rules.mjs';
import { WORD_DEFAULTS } from '../src/document/word/settings.mjs';

const opts = (patch = {}) => optionsOf({
  ...WORD_DEFAULTS,
  autocorrect: { ...WORD_DEFAULTS.autocorrect, ...patch.autocorrect },
  autoformat: { ...WORD_DEFAULTS.autoformat, ...patch.autoformat },
});
const O = opts();
/** `text` after the edits (applied right to left) → the corrected text. */
const apply = (text, edits) => [...edits].sort((a, b) => b.from - a.from)
  .reduce((s, e) => (e.insert != null ? s.slice(0, e.from) + e.insert + s.slice(e.to) : s), text);
const fix = (text, o = O, ctx) => apply(text, correct(text, o, ctx));

test('replacement entries fire on a finished word only', () => {
  assert.equal(fix('teh '), 'The '); // the paragraph's first word is capitalised as well
  assert.equal(fix('so teh '), 'so the ');
  assert.equal(fix('so teh,'), 'so the,');
  assert.equal(fix('so tehran '), 'so tehran ');
  assert.equal(fix('so teh'), 'so teh');
  assert.equal(fix('a (c) '), 'a © ');
  assert.equal(fix('wait... '), 'wait… ');
  assert.equal(fix('a --> '), 'a → ');
  assert.equal(fix('so can;t '), 'so can’t ');
  assert.equal(fix('so Teh '), 'so The ');
  assert.equal(fix('so teh ', opts({ autocorrect: { replace: false } })), 'so teh ');
  assert.equal(correct('so teh ', O)[0].kind, 'replace');
});

test('two initial capitals, with IDs and all capitals kept', () => {
  assert.equal(fix('so THe '), 'so The ');
  assert.equal(fix('so IDs '), 'so IDs ');
  assert.equal(fix('so THE '), 'so THE ');
  assert.equal(correct('so THe ', O)[0].rule, 'twoCaps');
});

test('sentence capitals after . ! ? and at a paragraph start, none after e.g.', () => {
  assert.equal(fix('hello '), 'Hello ');
  assert.equal(fix('Hi. world '), 'Hi. World ');
  assert.equal(fix('Hi! world '), 'Hi! World ');
  assert.equal(fix('Hi? world '), 'Hi? World ');
  assert.equal(fix('See e.g. world '), 'See e.g. world ');
  assert.equal(fix('hello ', opts({ autocorrect: { sentences: false } })), 'hello ');
  assert.equal(fix('hello ', O, { inCell: true }), 'Hello ');
  assert.equal(fix('hello ', opts({ autocorrect: { cells: false } }), { inCell: true }), 'hello ');
  assert.equal(correct('Hi approx. world ', opts({ autocorrect: { exceptions: { firstLetter: [] } } }))[0].prev, 'approx.');
});

test('day names and caps lock', () => {
  assert.equal(fix('on monday '), 'on Monday ');
  assert.equal(fix('so hELLO ', O, { capsLock: true }), 'so Hello ');
  assert.equal(fix('so hELLO '), 'so hELLO ');
});

test('quote direction', () => {
  const q = (t) => correct(t, O).find((e) => e.kind === 'quote')?.insert;
  assert.equal(q('"'), '“');
  assert.equal(q('say "'), '“');
  assert.equal(q('("'), '“');
  assert.equal(q('Say "hi"'), '”');
  assert.equal(q("don'"), '’');
  assert.equal(q("a '"), '‘');
  assert.equal(correct('"', opts({ autoformat: { quotes: false } })).length, 0);
});

test('ordinals, fractions and dashes', () => {
  for (const w of ['1st', '22nd', '103rd', '11th']) {
    const e = correct(`the ${w} `, O)[0];
    assert.equal(e.kind, 'ordinal', w);
    assert.equal(`the ${w} `.slice(e.from, e.to), w.slice(-2));
  }
  assert.equal(correct('the 1th ', O).length, 0);
  assert.equal(fix('a 1/2 '), 'a ½ ');
  assert.equal(fix('a 3/4,'), 'a ¾,');
  assert.equal(fix('a 2/3 '), 'a 2/3 ');
  assert.equal(fix('so a--b '), 'so a—b ');
  assert.equal(fix('so word - word '), 'so word – word ');
  assert.equal(fix('so word -- word '), 'so word – word ');
  assert.equal(fix('- '), '- ');
});

test('*bold* and _italic_ with the option on', () => {
  const on = opts({ autoformat: { boldItalic: true } });
  const b = correct('so *bold*', on)[0];
  assert.deepEqual([b.insert, b.mark.type, b.from, b.to], ['bold', 'bold', 3, 9]);
  assert.equal(correct('so _it_', on)[0].mark.type, 'italic');
  assert.equal(correct('so *bold*', O).length, 0);
});

test('link detection', () => {
  assert.equal(linkOf('www.x.org'), 'http://www.x.org');
  assert.equal(linkOf('https://x.org/a?b'), 'https://x.org/a?b');
  assert.equal(linkOf('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(linkOf('a@b.co'), 'mailto:a@b.co');
  assert.equal(linkOf('\\\\srv\\share'), '\\\\srv\\share');
  assert.equal(linkOf('hello'), null);
  const e = correct('see www.x.org. ', O)[0];
  assert.deepEqual([e.kind, e.from, e.to, e.mark.attrs.href], ['link', 4, 13, 'http://www.x.org']);
  assert.equal(correct('see www.x.org ', opts({ autoformat: { links: false } })).length, 0);
});

test('border lines and +---+ tables on Enter', () => {
  const style = (t) => enterRule(t, WORD_DEFAULTS.autoformat)?.border?.style;
  assert.deepEqual(['---', '___', '===', '***', '~~~', '###'].map(style), ['single', 'single', 'double', 'dotted', 'wave', 'thinThickThinSmallGap']);
  assert.equal(enterRule('___', WORD_DEFAULTS.autoformat).border.width, 1.5);
  assert.equal(enterRule('--', WORD_DEFAULTS.autoformat), null);
  const t = enterRule('+---+--+', WORD_DEFAULTS.autoformat);
  assert.deepEqual(t.widths, [3, 2]);
  assert.deepEqual(columnWidths(t.widths, 500), [300, 200]);
  assert.equal(enterRule('---', { ...WORD_DEFAULTS.autoformat, borders: false }), null);
});

test('the heading rule', () => {
  assert.deepEqual(headingOf('Introduction'), { level: 1, tabs: 0 });
  assert.deepEqual(headingOf('\tDetails'), { level: 2, tabs: 1 });
  assert.equal(headingOf('A sentence.'), null);
  assert.equal(headingOf(''), null);
});

test('AutoFormat now plan', () => {
  const plan = autoFormatPlan([
    { text: 'Short line', styled: false, list: false, inTable: false },
    { text: 'She said "hi" and it\'s fine.', styled: false, list: false, inTable: false },
  ], WORD_DEFAULTS.autoformatNow);
  assert.equal(plan[0].heading, 1);
  assert.equal(plan[1].heading, 0);
  assert.equal(apply('She said "hi" and it\'s fine.', plan[1].edits), 'She said “hi” and it’s fine.');
});

test('a list lead at a paragraph start is left for the list rules', () => {
  for (const t of ['a)', '1.', 'i)', 'a) ', '1. ', '  b)']) assert.deepEqual(correct(t, O), [], t);
  assert.equal(fix('so a) '), 'so a) ');
  assert.equal(fix('a) teh '), 'a) the ');
});

test('an Other Corrections exception stops its replacement', () => {
  assert.equal(fix('so teh ', opts({ autocorrect: { exceptions: { other: ['teh'] } } })), 'so teh ');
  assert.equal(fix('so "teh ', opts({ autocorrect: { exceptions: { other: ['teh'] } } })), 'so "teh ');
});

test('AutoFormat now leaves text that already has a link', () => {
  const p = (linked) => autoFormatPlan([{ text: 'See www.x.org now', styled: true, list: false, inTable: false, linked }], WORD_DEFAULTS.autoformatNow)[0].edits;
  assert.equal(p(() => false).filter((e) => e.kind === 'link').length, 1);
  assert.equal(p(() => true).filter((e) => e.kind === 'link').length, 0);
});

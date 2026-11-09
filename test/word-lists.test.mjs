import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NUMBERING } from '../src/document/defaults.mjs';
import {
  ABSTRACTS, adjustIndents, autoFormatList, backspaceStep, continueAt, enterEmpty, formatNumber, listLabels, listNumText, MULTILEVEL,
  NUMBER_STYLES, numOf, restartAt, setNumsAbstract, tabIndentStep, valueAt,
} from '../src/document/numbering.mjs';

// Word's list behaviour on the flat-list model (docs/plans/word briefs/lists.md Acceptance).
const N = (numId, ilvl = 0) => ({ numId, ilvl });
const cmOf = (pt) => Math.round((pt * 20) / 567 * 100) / 100; // Word shows centimetres as 567 twips each

test('every number style labels 1, 4, 12 and 27 as Word does', () => {
  const want = {
    none: ['', '', '', ''], decimal: ['1', '4', '12', '27'], decimalFullWidth: ['１', '４', '１２', '２７'], upperRoman: ['I', 'IV', 'XII', 'XXVII'],
    lowerRoman: ['i', 'iv', 'xii', 'xxvii'], upperLetter: ['A', 'D', 'L', 'AA'], lowerLetter: ['a', 'd', 'l', 'aa'],
    taiwaneseCountingThousand: ['一', '四', '十二', '二十七'], ideographLegalTraditional: ['壹', '肆', '壹拾貳', '貳拾柒'],
    chineseCountingThousand: ['一', '四', '十二', '二十七'], chineseLegalSimplified: ['壹', '肆', '壹拾贰', '贰拾柒'], ideographTraditional: ['甲', '丁', '乙', '庚'],
    ideographZodiac: ['子', '卯', '亥', '寅'], ordinal: ['1st', '4th', '12th', '27th'], cardinalText: ['One', 'Four', 'Twelve', 'Twenty-seven'],
    ordinalText: ['First', 'Fourth', 'Twelfth', 'Twenty-seventh'], decimalZero: ['01', '04', '12', '27'], '001': ['001', '004', '012', '027'],
    '0001': ['0001', '0004', '0012', '0027'], '00001': ['00001', '00004', '00012', '00027'],
  };
  assert.equal(NUMBER_STYLES.length, 20);
  for (const [id, , fmt, format] of NUMBER_STYLES) assert.deepEqual([1, 4, 12, 27].map((n) => formatNumber(n, fmt, format)), want[id], id);
  assert.equal(formatNumber(21, 'ordinal'), '21st');
  assert.equal(formatNumber(13, 'ordinal'), '13th');
  assert.equal(formatNumber(22, 'ordinalText'), 'Twenty-second');
});

test('legal style numbering draws every level as decimal, also under a roman level', () => {
  const levels = ABSTRACTS.decimal.levels.map((l, i) => ({ ...l, fmt: ['upperRoman', 'lowerRoman', 'lowerLetter'][i % 3], text: ['%1.', '%1.%2.', '%1.%2.%3.'][i % 3] }));
  const legal = levels.map((l, i) => (i === 2 ? { ...l, isLgl: true } : l));
  const numbering = { abstract: { a: { levels }, b: { levels: legal } }, nums: { 1: { abstract: 'a' }, 2: { abstract: 'b' } } };
  assert.deepEqual(listLabels([N(1), N(1, 1), N(1, 2)], numbering), ['I.', 'I.i.', 'I.i.a.']);
  assert.deepEqual(listLabels([N(2), N(2, 1), N(2, 2), N(2, 2)], numbering), ['I.', 'I.i.', '1.1.1.', '1.1.2.']);
  // Legal style keeps a zero-padded level: the Article list's second level reads Section 1.01, as the probe's '01' format.
  const article = { abstract: { a: { levels: MULTILEVEL.find((m) => m.id === 'article').levels } }, nums: { 1: { abstract: 'a' } } };
  assert.deepEqual(listLabels([N(1), N(1, 1)], article), ['Article I.', 'Section 1.01']);
});

test('the multilevel List Library matches the probe: formats and positions of the first three levels', () => {
  // probe/menus/home.multilevel-list.json: "L1: ..., Number Format: X, Aligned at: a cm, Indent at: b cm" per level.
  const probe = {
    paren: [['decimal', '%1)', 0, 0.63], ['lowerLetter', '%2)', 0.63, 1.27], ['lowerRoman', '%3)']],
    outline: [['decimal', '%1.', 0, 0.63], ['decimal', '%1.%2.', 0.63, 1.4], ['decimal', '%1.%2.%3.']],
    bullets: [['bullet', '❖', 0, 0.63], ['bullet', '➢', 0.63, 1.27], ['bullet', '▪', 1.27, 1.9]],
    article: [['upperRoman', 'Article %1.', 0, 0], ['decimalZero', 'Section %1.%2', 0, 0], ['lowerLetter']],
    headings: [['decimal', '%1', 0, 0.76], ['decimal', '%1.%2', 0, 1.02], ['decimal', '%1.%2.%3']],
    roman: [['upperRoman', '%1.', 0, 0], ['upperLetter', '%2.', 1.27, 1.27], ['decimal']],
    chapter: [['decimal', 'Chapter %1', 0, 0], ['bullet', '', 0, 0], ['bullet', '', 0, 0]],
  };
  assert.deepEqual(MULTILEVEL.map((m) => m.id), Object.keys(probe));
  for (const m of MULTILEVEL) {
    probe[m.id].forEach(([fmt, text, at, indent], i) => {
      const l = m.levels[i];
      assert.equal(l.fmt, fmt, `${m.id} L${i + 1} format`);
      if (text !== undefined) assert.equal(l.text, text, `${m.id} L${i + 1} text`);
      if (at !== undefined) assert.deepEqual([cmOf(l.left - l.hanging), cmOf(l.left)], [at, indent], `${m.id} L${i + 1} positions`);
    });
    // The last four are linked to Heading 1 to 9.
    assert.equal(m.levels.every((l, i) => l.pStyle === `Heading${i + 1}`), ['article', 'headings', 'roman', 'chapter'].includes(m.id), m.id);
  }
  const outline = { abstract: { o: { levels: MULTILEVEL[1].levels } }, nums: { 1: { abstract: 'o' } } };
  assert.deepEqual(listLabels([N(1), N(1, 1), N(1, 1), N(1, 2), N(1)], outline), ['1.', '1.1.', '1.2.', '1.2.1.', '2.']);
});

// A document's numbered paragraphs: num 3 and 4 on 'decimal', num 5 on 'bullet'.
const numbering = { ...DEFAULT_NUMBERING, nums: { ...DEFAULT_NUMBERING.nums, 3: { abstract: 'decimal' }, 4: { abstract: 'decimal' }, 5: { abstract: 'bullet' } } };
const applied = (r, all) => all.map((n, i) => r.set.get(i) ?? n);

test('Restart at 1 and Set Numbering Value start a new list from the item to the end of its list', () => {
  const all = [N(3), N(3), N(3), N(3)];
  const r = restartAt(numbering, all, 2, 1);
  assert.deepEqual(listLabels(applied(r, all), r.numbering), ['1.', '2.', '1.', '2.']);
  const v = restartAt(numbering, all, 1, 5);
  assert.deepEqual(listLabels(applied(v, all), v.numbering), ['1.', '5.', '6.', '7.']);
  assert.deepEqual(v.numbering.nums[Object.keys(v.numbering.nums).at(-1)].overrides, { 0: { start: 5 } });
  // Below the first level the parents keep their numbers: 2.2. restarted reads 2.1., and the next first-level item stays 3.
  const outline = setNumsAbstract(numbering, [6], 'ml.outline');
  const deep = [N(6), N(6), N(6, 1), N(6, 1), N(6, 2), N(6)];
  const d = restartAt(outline, deep, 3, 1);
  assert.deepEqual(listLabels(applied(d, deep), d.numbering), ['1.', '2.', '2.1.', '2.1.', '2.1.1.', '3.']);
});

test('Continue Numbering and Continue from previous list join the list above, Advance value skips numbers', () => {
  const all = [N(3), N(3), N(5), N(4), N(4)];
  assert.equal(valueAt(numbering, all, 4), 2);
  const r = continueAt(numbering, all, 3);
  assert.deepEqual(listLabels(applied(r, all), r.numbering), ['1.', '2.', '•', '3.', '4.']);
  const skip = continueAt(numbering, all, 3, 7);
  assert.deepEqual(listLabels(applied(skip, all), skip.numbering), ['1.', '2.', '•', '7.', '8.']);
  const low = continueAt(numbering, all, 3, 2); // no higher than it would be: it simply continues
  assert.deepEqual(listLabels(applied(low, all), low.numbering), ['1.', '2.', '•', '3.', '4.']);
  assert.equal(continueAt(numbering, [N(3), N(4)].slice(0, 1), 0), null); // nothing above
});

test('Adjust List Indents: 0.63 and 1.27 cm give left 36 and hanging 18, and Space follows the number', () => {
  const out = adjustIndents(numbering, 3, 0, { pos: 0.63 * 72 / 2.54, text: 1.27 * 72 / 2.54, suff: 'space', tab: null });
  const lvl = out.abstract[out.nums[3].abstract].levels[0];
  assert.deepEqual([Math.round(lvl.left), Math.round(lvl.hanging), lvl.suff], [36, 18, 'space']);
  assert.notEqual(out.nums[3].abstract, 'decimal'); // the shared definition stays as it was
  assert.equal(out.abstract.decimal.levels[0].suff, undefined);
  assert.equal(out.nums[4].abstract, 'decimal');
});

test('Enter on an empty item promotes, then ends the list; Backspace removes the number, then the indent, then joins', () => {
  let n = N(3, 2);
  const seen = [];
  while (n) seen.push((n = enterEmpty(n))?.ilvl ?? null);
  assert.deepEqual(seen, [1, 0, null]);
  const level = { left: 36, hanging: 18 };
  const one = backspaceStep({ numbered: true, indent: null, level });
  assert.deepEqual(one, { numbering: null, indent: { left: 36 } });
  const two = backspaceStep({ numbered: false, indent: one.indent, level: null });
  assert.deepEqual(two, { indent: null });
  assert.equal(backspaceStep({ numbered: false, indent: two.indent }), null); // joins
  // Tab at the start of a plain paragraph: a first-line indent, then the left indent; Backspace takes the first-line indent first.
  const tab = tabIndentStep(null);
  assert.deepEqual(tab, { firstLine: 36 });
  assert.deepEqual(tabIndentStep(tab), { firstLine: 36, left: 36 });
  assert.deepEqual(backspaceStep({ numbered: false, indent: tab }), { indent: null });
  assert.equal(backspaceStep({ numbered: false, indent: tab }, false), null); // option off: Backspace joins
});

test('AutoFormat list triggers start their list, and 5. stays text', () => {
  const want = { '*': ['bullet', '•'], '-': ['bullet', '–'], '>': ['bullet', '➢'], '->': ['bullet', '→'], '=>': ['bullet', '⇨'],
    '1.': ['decimal', '%1.'], '1)': ['decimal', '%1)'], '(1)': ['decimal', '(%1)'], 'A.': ['upperLetter', '%1.'], 'a)': ['lowerLetter', '%1)'],
    'I.': ['upperRoman', '%1.'], 'i.': ['lowerRoman', '%1.'] };
  for (const [typed, [fmt, text]] of Object.entries(want)) {
    const r = autoFormatList(typed);
    assert.deepEqual([r?.fmt, r?.text], [fmt, text], typed);
  }
  for (const typed of ['5.', 'b)', 'x', '1', 'II.', '--']) assert.equal(autoFormatList(typed), null, typed);
});

test('LISTNUM gives the probe results', () => {
  const nb = setNumsAbstract(numbering, [6], 'ml.paren');
  const after = [{ para: N(6) }, { para: N(6, 1) }, { para: null }];
  const f = (name, level = null, start = null) => ({ field: { name, level, start } });
  assert.equal(listNumText([...after, f(null)], nb), 'b)');
  assert.equal(listNumText([...after, f('NumberDefault', 2)], nb), 'a)');
  assert.equal(listNumText([...after, f('LegalDefault', 3)], nb), '1.1.1.');
  assert.equal(listNumText([...after, f('OutlineDefault', null, 5)], nb), '5.');
  // Inside a numbered paragraph a bare LISTNUM counts one level below it, and fields count on.
  assert.equal(listNumText([{ para: N(6) }, f(null), f(null)], nb), 'b)');
});

test('a paragraph style can number its paragraphs, and numId 0 stops it', () => {
  const doc = { attrs: { styles: { list: { Heading1: { para: { numbering: { numId: 7, ilvl: 0 } } }, Heading2: { basedOn: 'Heading1', para: { numbering: { numId: 7, ilvl: 1 } } } } } } };
  assert.deepEqual(numOf(doc, { type: 'heading', attrs: { level: 2, numbering: null } }), N(7, 1));
  assert.deepEqual(numOf(doc, { type: 'paragraph', attrs: { styleId: 'Heading1', numbering: null } }), N(7, 0));
  assert.equal(numOf(doc, { type: 'heading', attrs: { level: 1, numbering: { numId: 0, ilvl: 0 } } }), null);
  assert.equal(numOf(doc, { type: 'paragraph', attrs: { numbering: null } }), null);
});

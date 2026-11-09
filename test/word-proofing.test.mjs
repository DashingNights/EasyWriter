// proofing's pure modules (docs/plans/word briefs/proofing.md Acceptance): Word Count's rules against Word's own counts
// (probe/behaviour-tests.tsv), readability, the spelling tokenizer and ignore rules, repeated words and the accessibility rules.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrast, issuesOf, tally } from '../src/document/wp/proofing/a11y.mjs';
import { countDoc, countParas, parasOf } from '../src/document/model/count.mjs';
import { languageList, langName, served } from '../src/document/wp/proofing/languages.mjs';
import { readability, sentencesOf, syllables } from '../src/document/wp/proofing/readability.mjs';
import { ignoredKind, isIgnored, repeats, sentenceAround, tokens } from '../src/document/wp/proofing/words.mjs';

const TSV = 'A:/Programming Dumpster/DAF Writer/docs/plans/word/probe/behaviour-tests.tsv';
// The rows as captured on 2026-10-27, used when the planning folder is not on this machine.
const ROWS = [
  ['one two', 2, 6, 7, 1, 0], ['one-two', 1, 7, 7, 1, 0], ['one - two', 3, 7, 9, 1, 0], ['one — two', 2, 7, 9, 1, 0], ['one—two', 2, 7, 7, 1, 0],
  ['one – two', 2, 7, 9, 1, 0], ["don't", 1, 5, 5, 1, 0], ['3.14', 1, 4, 4, 1, 0], ['a/b', 1, 3, 3, 1, 0], ['hello,world', 1, 11, 11, 1, 0],
  ['hello, world', 2, 11, 12, 1, 0], ['e.g. this', 2, 8, 9, 1, 0], ['...', 1, 3, 3, 1, 0], ['- - -', 3, 3, 5, 1, 0], ['#1 @2', 2, 4, 5, 1, 0],
  ['one\\ttwo', 2, 6, 7, 1, 0], ['one\u00a0two', 2, 6, 7, 1, 0], ['line\\r\\rpara', 2, 8, 8, 2, 0], ['x\\r \\r\\ty', 2, 2, 4, 2, 0],
  ['www.example.com/a b', 2, 18, 19, 1, 0], ['café naïve', 2, 9, 10, 1, 0], ['你好世界 test', 5, 8, 9, 1, 4],
];

function rows() {
  if (!existsSync(TSV)) return ROWS;
  const out = [];
  for (const line of readFileSync(TSV, 'utf8').split(/\r?\n/)) {
    const m = /^count\t\[(.*)\]\t(.*)$/.exec(line);
    if (!m) continue;
    const v = Object.fromEntries(m[2].split('\t').map((kv) => kv.split('=')).map(([k, n]) => [k, Number(n)]));
    out.push([m[1], v.words, v.chars, v.charsSp, v.paras, v.farEast]);
  }
  return out;
}

test('count.mjs matches every count row Word gave', () => {
  const list = rows();
  assert.ok(list.length >= 22, `rows read: ${list.length}`);
  for (const [raw, words, chars, charsSp, paras, farEast] of list) {
    const text = raw.replace(/\\t/g, '\t');
    const c = countParas(text.split('\\r'));
    assert.deepEqual({ words: c.words, chars: c.chars, charsSp: c.charsSp, paras: c.paras, farEast: c.farEast }, { words, chars, charsSp, paras, farEast }, raw);
  }
});

const p = (...content) => ({ type: 'paragraph', content });
const tx = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });

test('note and text box text count only with the box on (3 words without, 6 with)', () => {
  const note = { type: 'noteRef', attrs: { kind: 'footnote', id: 'n1', content: [p(tx('four five six'))] } };
  const doc = { type: 'doc', content: [p(tx('one two three'), note)] };
  assert.equal(countDoc(doc, { notes: false }).words, 3);
  assert.equal(countDoc(doc, { notes: true }).words, 6);
  const box = { type: 'doc', content: [p(tx('one two')), { type: 'textBox', content: [p(tx('in a box'))] }] };
  assert.equal(countDoc(box, { notes: false }).words, 2);
  assert.equal(countDoc(box, { notes: true }).words, 5);
});

test('deletion-marked text never counts; a field counts as its result; empty paragraphs are no paragraphs', () => {
  const doc = { type: 'doc', content: [
    p(tx('kept '), tx('gone words', [{ type: 'deletion', attrs: { id: 1 } }]), tx(' here')),
    p(),
    p({ type: 'field', attrs: { code: 'DATE', result: '28 October 2026' } }),
  ] };
  assert.deepEqual(parasOf(doc), ['kept  here', '28 October 2026']);
  const c = countDoc(doc);
  assert.equal(c.words, 5);
  assert.equal(c.paras, 2);
});

test('syllables and sentences by our English rule', () => {
  assert.deepEqual(['the', 'cat', 'table', 'jumped', 'reading', 'beautiful', 'make', 'easy'].map(syllables), [1, 1, 2, 1, 2, 3, 1, 2]);
  assert.deepEqual(sentencesOf('One two. Three four! Five? Use e.g. six'), ['One two.', 'Three four!', 'Five?', 'Use e.g. six']);
});

test('readability of a fixed paragraph equals the hand-computed Flesch values', () => {
  // 2 sentences, 13 words, 17 syllables (reading 2, beautiful 3, table 2, the other ten 1).
  const r = readability(['Reading is beautiful at the table. The cat sat on the old mat.']);
  assert.equal(r.words, 13);
  assert.equal(r.sentences, 2);
  assert.equal(r.syllables, 17);
  const wps = 13 / 2;
  const spw = 17 / 13;
  assert.equal(r.raw.ease, 206.835 - 1.015 * wps - 84.6 * spw);
  assert.equal(r.raw.grade, 0.39 * wps + 11.8 * spw - 15.59);
  assert.equal(r.ease, 89.6); // 206.835 - 6.5975 - 110.6308 = 89.607
  assert.equal(r.grade, 2.4); // 2.535 + 15.4308 - 15.59 = 2.3758
  assert.equal(r.wordsPerSentence, 6.5);
  assert.equal(r.sentencesPerPara, 2);
});

test('the tokenizer and the ignore rules', () => {
  const t = tokens('Teh NASA plan2 see https://example.com/a, C:\\temp\\x and www.site.org. Well-known (wrod)');
  assert.deepEqual(t.map((x) => [x.word, x.kind]), [
    ['Teh', 'word'], ['NASA', 'upper'], ['plan2', 'number'], ['see', 'word'], ['https://example.com/a', 'url'], ['C:\\temp\\x', 'url'],
    ['and', 'word'], ['www.site.org', 'url'], ['Well', 'word'], ['known', 'word'], ['wrod', 'word'],
  ]);
  const opts = { ignoreUpper: true, ignoreNumbers: true, ignoreUrls: true };
  assert.deepEqual(t.filter((x) => !ignoredKind(x, opts)).map((x) => x.word), ['Teh', 'see', 'and', 'Well', 'known', 'wrod']);
  assert.equal(t.filter((x) => !ignoredKind(x, { ignoreUpper: false, ignoreNumbers: false, ignoreUrls: false })).length, t.length);
  assert.ok(isIgnored('WROD', ['wrod']));
  assert.ok(!isIgnored('word', ['wrod']));
  const s = 'One sentence here. The teh cat sat. Last one';
  const at = s.indexOf('teh');
  assert.deepEqual(sentenceAround(s, at, at + 3), { text: 'The teh cat sat.', start: 4, end: 7 });
});

test('noProof runs and deletion marks are no words to check', async () => {
  // spell.js reads paragraphs through blockText, which puts \ufffc where spelling skips; tokens never cross it.
  assert.deepEqual(tokens('good \ufffc\ufffc\ufffc bad').map((x) => x.word), ['good', 'bad']);
});

test('repeated words', () => {
  const text = 'Then the the end. It is is, and the-the and the  The.';
  const r = repeats(tokens(text), text);
  assert.deepEqual(r.map((x) => [x.word, text.slice(0, x.start).length]), [['the', 9], ['is', 24], ['The', text.lastIndexOf('The')]]);
});

const img = (attrs) => ({ type: 'image', attrs: { src: 'data:image/png;base64,AA', ...attrs } });

test('each accessibility rule fires on a minimal doc and not on its fixed form', () => {
  const cases = {
    altText: [{ content: [p(img({}))] }, { content: [p(img({ alt: 'A dog' }))] }, { content: [p(img({ decorative: true }))] }],
    tableHeader: [
      { content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(tx('a'))] }] }] }] },
      { content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(tx('a'))] }] }] }] },
    ],
    contrast: [
      { content: [p(tx('pale', [{ type: 'textStyle', attrs: { color: '#AAAAAA' } }]))] },
      { content: [p(tx('dark', [{ type: 'textStyle', attrs: { color: '#767676' } }]))] },
    ],
    linkText: [
      { content: [p(tx('click here', [{ type: 'link', attrs: { href: 'https://a.example' } }]))] },
      { content: [p(tx('the price list', [{ type: 'link', attrs: { href: 'https://a.example' } }]))] },
    ],
    headingLevel: [
      { content: [{ type: 'heading', attrs: { level: 1 }, content: [tx('A')] }, { type: 'heading', attrs: { level: 3 }, content: [tx('B')] }] },
      { content: [{ type: 'heading', attrs: { level: 1 }, content: [tx('A')] }, { type: 'heading', attrs: { level: 2 }, content: [tx('B')] }] },
    ],
    blanks: [{ content: [p(tx('a    b'))] }, { content: [p(tx('a b'))] }],
    notInline: [{ content: [p(img({ alt: 'x', layout: { wrap: 'square' } }))] }, { content: [p(img({ alt: 'x' }))] }],
  };
  for (const [rule, [bad, ...good]] of Object.entries(cases)) {
    const hit = issuesOf({ type: 'doc', ...bad });
    assert.deepEqual(hit.map((i) => i.rule), [rule], `${rule} fires`);
    for (const g of good) assert.deepEqual(issuesOf({ type: 'doc', ...g }), [], `${rule} quiet when fixed`);
  }
  const empties = issuesOf({ type: 'doc', content: [p(tx('a')), p(), p(), p(), p(tx('b'))] });
  assert.deepEqual(empties.map((i) => i.rule), ['blanks']);
  // Contrast against a highlight: white on yellow is hard to read; large bold text needs only 3:1.
  const onYellow = issuesOf({ type: 'doc', content: [p(tx('x', [{ type: 'textStyle', attrs: { color: '#FFFFFF', highlight: 'yellow' } }]))] });
  assert.deepEqual(onYellow.map((i) => i.rule), ['contrast']);
  const big = issuesOf({ type: 'doc', content: [p(tx('x', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#949494', size: 14 } }]))] });
  assert.deepEqual(big, []);
  assert.deepEqual(tally(hitAll()), { error: 2, warning: 0, tip: 0 });
  function hitAll() {
    return issuesOf({ type: 'doc', content: [p(img({})), p(img({}))] });
  }
});

test('issue positions point at the object', () => {
  const doc = { type: 'doc', content: [p(tx('ab')), p(img({}))] };
  const [i] = issuesOf(doc);
  // p(ab) is 4, the next paragraph opens at 4 and the image sits at 5.
  assert.equal(i.from, 5);
  assert.equal(i.to, 6);
});

test('the contrast ratio of #767676 on #FFFFFF is 4.54', () => {
  assert.equal(contrast('#767676', '#FFFFFF'), 4.54);
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
});

test('language names and the dictionary-first list', () => {
  assert.equal(langName('en-US'), 'English (United States)');
  assert.ok(served('en-GB', ['en-US']));
  assert.ok(!served('fr-FR', ['en-US']));
  const list = languageList(['en-US', 'en-GB']);
  assert.deepEqual(list.slice(0, 2).map((r) => r[0]), ['en-GB', 'en-US']);
  assert.ok(list.slice(2).every((r) => !r[2]));
});

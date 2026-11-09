import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { findMatches } from '../src/find.js';
import { inflect, soundex, stem } from '../src/document/wp/find/forms.mjs';
import { itemsOf, parseGoTo, pick } from '../src/document/wp/find/goto.mjs';
import { queryError } from '../src/document/wp/find/query.mjs';
import { replaceAll, replaceInStories } from '../src/document/wp/find/replace.mjs';

// Find and Replace (docs/plans/word/plan.md §3 find, §1.18): Word's ^ codes and wildcards, the search options, Replace All and
// Go To parsing, on schema v2 docs.
const schema = getSchema(documentExtensions(50));
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...content) => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? t(c) : c)) });
const doc = (...content) => schema.nodeFromJSON({ type: 'doc', content });
const lines = (...texts) => doc(...texts.map((x) => (x ? p(x) : { type: 'paragraph' })));
const texts = (d, q, opts = { codes: true }) => findMatches(d, q, opts).map((m) => d.textBetween(m.from, m.to, '\r', '\u0001'));
const W = { codes: true, wildcards: true };
const replaced = (d, q, r, opts = { codes: true }) => {
  const tr = EditorState.create({ doc: d }).tr;
  replaceAll(tr, q, r, opts);
  return tr.doc.textBetween(0, tr.doc.content.size, '\n', '\u0001');
};

// ---------- wildcards: the wild rows of behaviour-tests.tsv ----------
test('wildcards: the wild rows of behaviour-tests.tsv', () => {
  const rows = [
    ['abcabc', 'a*c', ['abc', 'abc']],
    ['Apple apple', 'apple', ['apple']],
    ['cat category concat', '<cat>', ['cat']],
    ['cat category concat', '<cat', ['cat', 'cat']],
    ['cat category concat', 'cat>', ['cat', 'cat']],
    ['aa ab abbb b', 'ab@', ['ab', 'ab']],
    ['tel 12 123 1234', '[0-9]{3}', ['123', '123']],
    ['tel 12 123 1234', '[0-9]{2,3}', ['12', '123', '123']],
    ['tel 12 123 1234', '[0-9]{3,}', ['123', '1234']],
    ['bat bet bit', 'b?t', ['bat', 'bet', 'bit']],
    ['bat bet bit', 'b[!e]t', ['bat', 'bit']],
    ['a(b)c', '\\(*\\)', ['(b)']],
    ['zoo', 'o{1,}', ['oo']],
    ['big bag bug', 'b[a-i]g', ['big', 'bag']],
    ['ab12', '[a-z0-9]@', ['a', 'b', '1', '2']],
    ['a*b', 'a\\*b', ['a*b']],
    ['aXb', 'a[A-Z]b', ['aXb']],
    ['axb', 'a[A-Z]b', []],
  ];
  for (const [text, q, want] of rows) assert.deepEqual(texts(lines(text), q, W), want, `${q} in ${text}`);
  assert.equal(findMatches(lines('x', 'y'), '^13', W).length, 2, '^13 finds each paragraph mark');
  assert.match(queryError('o{,2}', W), /not valid/, '{,m} is refused');
  assert.ok(queryError('b[z-a]g', W), 'a descending range is refused');
});

test('wildcards: replacements with groups and ^&', () => {
  assert.equal(replaced(lines('Smith, John'), '(<*>), (<*>)', '\\2 \\1', W), 'John Smith');
  assert.equal(replaced(lines('2026-10-27'), '([0-9]{4})-([0-9]{2})-([0-9]{2})', '\\3/\\2/\\1', W), '27/10/2026');
  assert.equal(replaced(lines('word word twice twice'), '(<[a-z]@>) \\1', '\\1', W), 'word twice');
  assert.equal(replaced(lines('x1 y22'), '[a-z][0-9]@', '<^&>', W), '<x1> <y2>2');
  assert.equal(replaced(lines('a1'), 'a', '\\1'), '\\11', 'without wildcards \\1 is literal text');
});

// ---------- ^ codes ----------
test('^ codes: each character and node of the table', () => {
  const nodes = (type, attrs) => ({ type, ...(attrs && { attrs }) });
  const d = doc(
    p('Abc 123 def\ttab', nodes('hardBreak'), 'line nbsp‑nbh­opt—em–en§sect¶pil… x q ^caret', nodes('image', { src: 'data:,' })),
    p('fn ', nodes('noteRef', { kind: 'footnote', id: 'f1' }), ' en ', nodes('noteRef', { kind: 'endnote', id: 'e1' }), ' fld ', nodes('field', { code: 'PAGE', result: '1' })),
    nodes('pageBreak'),
    p('after'),
  );
  const count = (q, opts) => findMatches(d, q, { codes: true, ...opts }).length;
  assert.equal(count('^t'), 1);
  assert.equal(count('^l'), 1);
  assert.equal(count('^s'), 1);
  assert.equal(count('^~'), 1);
  assert.equal(count('^-'), 1);
  assert.equal(count('^+'), 1);
  assert.equal(count('^='), 1);
  assert.equal(count('^%'), 1);
  assert.equal(count('^v'), 1);
  assert.equal(count('^i'), 1);
  assert.equal(count('^j'), 1);
  assert.equal(count('^q'), 1);
  assert.equal(count('^^'), 1);
  assert.equal(count('^#'), 4, 'three digits and the field result 1');
  assert.equal(count('^g'), 1);
  assert.equal(count('^f'), 1);
  assert.equal(count('^e'), 1);
  assert.equal(count('^2'), 2);
  assert.equal(count('^m'), 1);
  assert.equal(count('^b'), 0);
  assert.equal(count('^a'), 0);
  assert.equal(count('^d'), 0, 'fields read as their result while codes are hidden');
  assert.equal(count('^d', { fieldCodes: true }), 1);
  assert.equal(count('^u8212'), 1, '^unnnn is a Unicode code');
  assert.equal(count('^0167'), 1, '^0nnn is a Windows-1252 code');
  assert.equal(count('^9'), 1);
  assert.equal(count('^?'), count('^?'));
  assert.ok(queryError('^c', { codes: true }), '^c belongs to Replace with');
  assert.ok(queryError('^&', { codes: true }));
  assert.ok(queryError('^Q', { codes: true }), 'other codes are refused');
  assert.equal(queryError('^p', W) != null, true, '^p is refused with wildcards');
});

test('^p spans paragraphs; ^w takes runs of white space', () => {
  const d = lines('one', '', '', 'two');
  assert.equal(findMatches(d, 'one^ptwo', { codes: true }).length, 0);
  assert.equal(findMatches(d, '^p^p', { codes: true }).length, 1, 'the two empty paragraphs after one');
  assert.equal(replaced(d, '^p^p', '^p'), 'one\n\ntwo');
  assert.equal(replaced(lines('one', 'two'), '^p', ' '), 'one two ', 'replacing ^p joins the paragraphs; the last mark stays');
  assert.equal(replaced(lines('a-b'), '-', '^p'), 'a\nb', 'replacing by ^p splits');
  assert.deepEqual(texts(lines('a \t  b  c'), 'a^wb'), ['a \t  b']);
  assert.equal(findMatches(lines('a 　 b'), '^w', { codes: true }).length, 1, 'one run');
});

test('^p stops at a table: the end-of-cell mark and the mark before a table never join across it', () => {
  const cell = (x) => ({ type: 'tableCell', content: [p(x)] });
  const table = { type: 'table', content: [{ type: 'tableRow', content: [cell('c1'), cell('c2')] }] };
  const d = doc(p('before'), table, p('after'));
  assert.equal(replaced(d, '^p', ' '), 'before\nc1\nc2\nafter ', 'only the last mark, outside the table, is replaced');
  const e = doc(p('one'), { type: 'paragraph' }, table, p('after'));
  assert.equal(replaced(e, '^p^p', '^p'), 'one\n\nc1\nc2\nafter', 'the empty paragraph before the table stays');
});

// ---------- options ----------
test('findMatches with no opts behaves as before', () => {
  const d = lines('An apple, an Apple', 'APPLE pie');
  assert.deepEqual(findMatches(d, 'apple').map((m) => d.textBetween(m.from, m.to)), ['apple', 'Apple', 'APPLE']);
  assert.deepEqual(findMatches(d, 'apple'), findMatches(d, 'apple', { codes: false, display: 'all' }).map(({ from, to }) => ({ from, to })));
});

test('match case, whole words, prefix, suffix, punctuation and white space', () => {
  assert.deepEqual(texts(lines('Apple apple'), 'Apple', { matchCase: true }), ['Apple']);
  assert.deepEqual(texts(lines('cat category'), 'cat', { wholeWord: true }), ['cat']);
  assert.deepEqual(texts(lines('preview review'), 'view', { suffix: true }), ['view', 'view']);
  assert.deepEqual(texts(lines('preview viewer'), 'view', { prefix: true }), ['view']);
  assert.deepEqual(texts(lines("don't dont"), 'dont', { ignorePunct: true }), ["don't", 'dont']);
  assert.deepEqual(texts(lines('ice cream icecream'), 'icecream', { ignoreSpace: true }), ['ice cream', 'icecream']);
  assert.deepEqual(texts(lines('ＡＢＣ abc'), 'abc', { display: 'all' }), ['ＡＢＣ', 'abc'], 'half and full width forms match while the option is off');
  assert.deepEqual(texts(lines('ＡＢＣ abc'), 'abc', { widthForms: true }), ['abc']);
});

test('sounds like and all word forms', () => {
  assert.equal(soundex('Smith'), soundex('Smyth'));
  assert.deepEqual(texts(lines('Smith met Smyth and Jones'), 'Smith', { soundsLike: true }), ['Smith', 'Smyth']);
  assert.deepEqual(texts(lines('walk walked walking talk'), 'walk', { allForms: true }), ['walk', 'walked', 'walking']);
  assert.deepEqual(texts(lines('go went gone goat'), 'go', { allForms: true }), ['go', 'went', 'gone']);
  assert.equal(stem('stopped'), stem('stop'));
  assert.equal(inflect('stroll', 'walked', 'walk'), 'strolled');
  assert.equal(replaced(lines('Walked walking'), 'walk', 'stroll', { allForms: true }), 'Strolled strolling', 'keeps case and suffix');
});

test('display: deletion-marked text is skipped under simple', () => {
  const del = { type: 'deletion', attrs: { id: 'd1', author: 'Ben', date: '2026-10-27T11:00:00Z' } };
  const d = doc(p('keep ', t('gone', [del]), ' keep'));
  assert.equal(findMatches(d, 'gone', { display: 'simple' }).length, 0);
  assert.equal(findMatches(d, 'gone', { display: 'all' }).length, 1);
  assert.equal(findMatches(d, 'keep keep', { display: 'simple' }).length, 0, 'the gap is there: "keep " then " keep"');
  assert.equal(findMatches(d, 'keep  keep', { display: 'simple' }).length, 1);
});

test('format: bold runs, and Replace with Format keeps the text', () => {
  const d = doc(p('plain ', t('bold', [{ type: 'bold' }]), ' plain'));
  assert.deepEqual(texts(d, '', { format: { run: { bold: true } } }), ['bold']);
  assert.deepEqual(texts(d, 'plain', { format: { run: { bold: false } } }), ['plain', 'plain']);
  const tr = EditorState.create({ doc: d }).tr;
  replaceAll(tr, 'plain', '', { replaceFormat: { run: { italic: true } } });
  assert.equal(tr.doc.textContent, 'plain bold plain');
  assert.equal(findMatches(tr.doc, '', { format: { run: { italic: true } } }).length, 2);
});

test('Replace All of three matches is one transaction and one step list', () => {
  const state = EditorState.create({ doc: lines('colour colour', 'colour') });
  const tr = state.tr;
  assert.equal(replaceAll(tr, 'colour', 'color', { codes: true }), 3);
  assert.equal(tr.doc.textBetween(0, tr.doc.content.size, '\n'), 'color color\ncolor');
  assert.equal(state.apply(tr).doc.textContent, 'color colorcolor', 'one transaction carries every replacement');
});

test('Replace All rewrites note text in its noteRef', () => {
  const d = doc(p('a', { type: 'noteRef', attrs: { kind: 'footnote', id: 'n1', content: [{ type: 'paragraph', content: [t('old note')] }] } }));
  const tr = EditorState.create({ doc: d }).tr;
  assert.equal(replaceInStories(tr, 'old', 'new', {}, new Set(['footnotes'])), 1);
  let note;
  tr.doc.descendants((n) => { if (n.type.name === 'noteRef') note = n; });
  assert.equal(note.attrs.content[0].content[0].text, 'new note');
});

// ---------- Go To ----------
test('Go To: the box', () => {
  assert.deepEqual(parseGoTo('3'), { kind: 'abs', n: 3 });
  assert.deepEqual(parseGoTo('+2'), { kind: 'rel', n: 2 });
  assert.deepEqual(parseGoTo('-1'), { kind: 'rel', n: -1 });
  assert.deepEqual(parseGoTo('p3s2'), { kind: 'page', page: 3, section: 2 });
  assert.deepEqual(parseGoTo('s2'), { kind: 'page', page: 1, section: 2 });
  assert.deepEqual(parseGoTo(''), { kind: 'step' });
  assert.equal(parseGoTo('abc', 'page'), null);
  assert.deepEqual(parseGoTo('Intro', 'bookmark'), { kind: 'name', name: 'Intro' });
  const items = [{ from: 10 }, { from: 20 }, { from: 30 }];
  assert.equal(pick(items, parseGoTo('2'), 0), 1);
  assert.equal(pick(items, parseGoTo('+1'), 20), 2);
  assert.equal(pick(items, parseGoTo('-1'), 25), 0);
  assert.equal(pick(items, parseGoTo(''), 20, 1), 2);
  assert.equal(pick(items, parseGoTo(''), 20, -1), 0);
  const d = doc({ type: 'heading', attrs: { level: 1 }, content: [t('One')] }, p('x'), { type: 'heading', attrs: { level: 2 }, content: [t('Two')] });
  assert.equal(itemsOf(d, 'heading').length, 2);
});

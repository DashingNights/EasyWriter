// index-toa builders (docs/plans/word/briefs/index-toa.md Acceptance): Word's drawn INDEX and TOA results from probe/fields/out3.tsv.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseField } from '../src/document/fields/registry.mjs';
import { buildIndex, buildToa, LANGUAGES, levelsOf, markAllHits, taCode, xeCode } from '../src/document/wp/index-toa/index.mjs';

const pg = (n) => ({ n, label: String(n) });
// The probe's entries with the pages given: apple 5, Apple 4, Cherry 4 bold italic, Date See Fruit, Elder 1 (a \r range), Fruit:Banana 4.
const XE = [
  ['XE "Apple"', 4], ['XE "Fruit:Banana"', 4], ['XE "Cherry" \\b \\i', 4], ['XE "Date" \\t "See Fruit"', 4], ['XE "Elder" \\r num', 1],
  ['XE "Fig" \\f "a"', 5], ['XE "apple"', 5],
];
const sw = (code) => parseField(code).sw;
const entries = XE.map(([code, n]) => {
  const f = parseField(code);
  return { levels: levelsOf(f.args[0]), page: pg(n), to: f.sw.r ? pg(n) : null, bold: !!f.sw.b, italic: !!f.sw.i, cross: f.sw.t ?? null, type: f.sw.f };
});
// A paragraph's text with its style: '\t' and run marks spelt out.
const lines = (blocks) => blocks.flatMap((b) => (b.type === 'columns' ? b.content : [b]))
  .map((p) => `${p.attrs.styleId}|${(p.content ?? []).map((r) => (r.marks ? `<${r.marks.map((m) => m.type).join('+')}>${r.text}` : r.text)).join('')}`);

test('INDEX draws the probe index', () => {
  assert.deepEqual(lines(buildIndex(entries, {})), [
    'Index1|apple, 5', 'Index1|Apple, 4', 'Index1|Cherry, <bold+italic>4', 'Index1|Date. <italic>See Fruit', 'Index1|Elder, 1',
    'Index1|Fruit', 'Index2|Banana, 4',
  ]);
});

test('INDEX switches', () => {
  assert.deepEqual(lines(buildIndex(entries, sw('INDEX \\r'))).at(-1), 'Index1|Fruit: Banana, 4');
  const heads = lines(buildIndex(entries, sw('INDEX \\h "A"'))).filter((l) => l.startsWith('IndexHeading'));
  assert.deepEqual(heads, ['IndexHeading|A', 'IndexHeading|C', 'IndexHeading|D', 'IndexHeading|E', 'IndexHeading|F']);
  assert.deepEqual(lines(buildIndex(entries, sw('INDEX \\p a-d'))).map((l) => l.split(/[|,.]/)[1]), ['apple', 'Apple', 'Cherry', 'Date']);
  assert.deepEqual(lines(buildIndex(entries, sw('INDEX \\f "a"'))), ['Index1|Fig, 5']);
  assert.deepEqual(lines(buildIndex([{ levels: ['Range'], page: pg(5), to: pg(7) }], {})), ['Index1|Range, 5–7']);
  const cols = buildIndex(entries, sw('INDEX \\c "2"'));
  assert.equal(cols.length, 1);
  assert.deepEqual([cols[0].type, cols[0].attrs.count], ['columns', 2]);
  const tabbed = buildIndex(entries, sw('INDEX \\e "\t"'), { tabPos: 450 });
  assert.equal(lines(tabbed)[0], 'Index1|apple\t5');
  assert.deepEqual(tabbed[0].attrs.tabs, [{ pos: 450, align: 'right', leader: 'dot' }]);
  assert.equal(lines(tabbed)[3], 'Index1|Date\t<italic>See Fruit');
  assert.deepEqual(lines(buildIndex([], {})), ['Normal|No index entries found.']);
});

test('XE and TA codes', () => {
  assert.equal(xeCode({ main: 'a:b' }), 'XE "a\\:b"');
  assert.equal(xeCode({ main: 'Fruit', sub: 'Say "hi"', cross: 'See Food', bold: true }), 'XE "Fruit:Say \\"hi\\"" \\t "See Food" \\b');
  assert.equal(xeCode({ main: 'Fruit', sub: 'Pear', yomi: 'f', subYomi: 'p' }), 'XE "Fruit:Pear" \\y "f:p"');
  // The subentry's reading sorts its level: Pear (read "a") before Apple (read "b").
  const subs = buildIndex([{ levels: ['Fruit', 'Apple'], yomi: ':b', page: pg(1) }, { levels: ['Fruit', 'Pear'], yomi: parseField('XE "x" \\y "f:a"').sw.y, page: pg(2) }], {});
  assert.deepEqual(lines(subs).slice(1), ['Index2|Pear, 2', 'Index2|Apple, 1']);
  assert.deepEqual(levelsOf(parseField('XE "a\\:b"').args[0]), ['a:b']);
  assert.deepEqual(levelsOf(parseField('XE "Fruit:Banana"').args[0]), ['Fruit', 'Banana']);
  assert.equal(taCode({ long: 'Smith v. Jones', short: 'Smith', category: 1 }), 'TA \\l "Smith v. Jones" \\s "Smith" \\c 1');
  assert.equal(taCode({ short: 'Smith' }), 'TA \\s "Smith"');
});

test('TOA: passim, short citations and headings', () => {
  const long = { long: 'Smith v. Jones, 1 U.S. 1 (1900)', short: 'Smith', category: 1, page: pg(1) };
  const five = [long, ...[2, 3, 4, 5].map((n) => ({ short: 'Smith', page: pg(n) })), { long: 'Clean Air Act', short: 'Clean Air', category: 2, page: pg(4) }];
  assert.deepEqual(lines(buildToa(five, sw('TOA \\h \\c "1" \\p'))), ['TOAHeading|Cases', 'TableofAuthorities|Smith v. Jones, 1 U.S. 1 (1900)\tpassim']);
  assert.deepEqual(lines(buildToa(five, sw('TOA \\c "1"'))), ['TableofAuthorities|Smith v. Jones, 1 U.S. 1 (1900)\t1, 2, 3, 4, 5']);
  assert.deepEqual(lines(buildToa(five, sw('TOA \\c "2" \\e "\t"'))), ['TableofAuthorities|Clean Air Act\t4']);
  assert.deepEqual(lines(buildToa(five, sw('TOA \\c "3"'))), ['Normal|No table of authorities entries found.']);
});

test('Mark All matches the same case, the whole text, once per paragraph', () => {
  const hits = markAllHits([{ pos: 0, text: 'apple and apple' }, { pos: 20, text: 'Apple pie' }, { pos: 40, text: 'pineapple, apple' }], 'apple');
  assert.deepEqual(hits, [{ from: 0, to: 5 }, { from: 51, to: 56 }]);
});

test('an AutoMark entry "Main:Sub" splits into a subentry; the Language list keeps the probe order', () => {
  const [main, sub = ''] = levelsOf('Fruit:Apple');
  assert.equal(xeCode({ main, sub }), 'XE "Fruit:Apple"');
  assert.equal(xeCode({ main: 'Fruit:Apple' }), 'XE "Fruit\\:Apple"');
  assert.deepEqual(LANGUAGES.map(([id]) => id), [2052, 3076, 1028, 15369, 2057, 1033]);
});

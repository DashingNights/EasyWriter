// Citations & Bibliography in a Document (docs/plans/word/briefs/citations.md): tags, Word's source types, the style table and the
// CITATION and BIBLIOGRAPHY results.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseField, registerField } from '../src/document/fields/registry.mjs';
import { bibliographyBlocks, citationCode, citationText, citedTags, EMPTY_TEXT, FIELDS, parseCitation } from '../src/document/wp/citations/fields.mjs';
import { cleanSource, ensureTags, fieldOf, formatReference, SOURCE_TYPES, tagOf, wordBibliography, WORD_STYLES, wordTypeOf } from '../src/references.mjs';

for (const [name, type] of Object.entries(FIELDS)) registerField(name, type); // so \n \t \y parse as bare switches

const book = (o) => cleanSource({ wtype: 'Book', type: 'book', ...o });
const smith = { ...book({ id: 's', authors: ['Smith, John'], title: 'A title', year: '2026', publisher: 'Pub', place: 'London' }), tag: 'Smi26' };
// A doc stand-in: the fields in document order, as citedTags walks them.
const docOf = (...codes) => ({ descendants: (fn) => codes.forEach((code) => fn({ type: { name: 'field' }, attrs: { code } })) });
const cite = (code, style, sources = [smith], doc = docOf(code)) => citationText(parseCitation(parseField(code)), doc, { sources, style });

test('tags: three letters of the family name and two of the year, a digit on a clash', () => {
  assert.equal(tagOf({ authors: ['Smith, John'], year: '2026' }), 'Smi26');
  assert.equal(tagOf({ authors: ['Smith, John'], year: '2026' }, new Set(['Smi26'])), 'Smi261');
  assert.equal(tagOf({ authors: ['Smith, Ann'], year: '2026' }, new Set(['Smi26', 'Smi261'])), 'Smi262');
  assert.deepEqual(ensureTags([{ authors: ['Lee, A'], year: '2020' }, { authors: ['Lee, B'], year: '2020' }]).map((s) => s.tag), ['Lee20', 'Lee201']);
});

test("the five builder types map to Word's, and Word has its 17 types in the probe's order", () => {
  assert.deepEqual(['web', 'article', 'preprint', 'chapter', 'book'].map((type) => wordTypeOf({ type })),
    ['InternetSite', 'JournalArticle', 'Report', 'BookSection', 'Book']);
  assert.equal(SOURCE_TYPES.length, 17);
  assert.deepEqual(SOURCE_TYPES.find((t) => t.id === 'Book').short.map(([, l]) => l), ['Title', 'Year', 'City', 'Publisher']); // probed
  assert.equal(cleanSource({ type: 'book' }).wtype, undefined); // a forum post's source gains no Word keys
});

test('a Book cites as (Smith, 2026) in APA, (Smith) in MLA and [1] in IEEE', () => {
  const code = 'CITATION Smi26 \\l 1033';
  assert.equal(cite(code, 'apa'), '(Smith, 2026)');
  assert.equal(cite(code, 'mla'), '(Smith)');
  assert.equal(cite(code, 'ieee'), '[1]');
  assert.equal(cite(code, 'harvard'), '(Smith, 2026)');
  assert.equal(citationCode({ tags: ['Smi26'] }), code);
});

test('switches: \\p adds the pages, \\n \\y \\t suppress their parts, \\m adds a source', () => {
  assert.equal(cite('CITATION Smi26 \\l 1033 \\p 12', 'apa'), '(Smith, 2026, p. 12)');
  assert.equal(cite('CITATION Smi26 \\l 1033 \\n', 'apa'), '(2026)');
  assert.equal(cite('CITATION Smi26 \\l 1033 \\y', 'apa'), '(Smith)');
  assert.equal(cite('CITATION Smi26 \\l 1033 \\n \\y \\t', 'apa'), '()');
  const untitled = { ...book({ id: 'u', title: 'Only a title', year: '2020' }), tag: 'Onl20' };
  assert.equal(cite('CITATION Onl20 \\l 1033 \\t', 'apa', [untitled]), '(2020)'); // no author: the title stands in, \t drops it
  const lee = { ...book({ id: 'l', authors: ['Lee, Ann'], title: 'B', year: '2025' }), tag: 'Lee25' };
  assert.equal(cite('CITATION Smi26 \\l 1033 \\m Lee25', 'apa', [smith, lee]), '(Smith, 2026; Lee, 2025)');
  const c = parseCitation(parseField('CITATION Smi26 \\l 1033 \\p 12 \\n'));
  assert.deepEqual([c.pages, c.noAuthor, c.noYear], ['12', true, false]);
  assert.equal(citationCode(c), 'CITATION Smi26 \\l 1033 \\p 12 \\n');
});

test('an unknown tag gives Word\'s error; a placeholder cites as its name', () => {
  assert.equal(cite('CITATION Nope99 \\l 1033', 'apa'), 'Invalid source specified.');
  const ph = { ...cleanSource({ id: 'p', placeholder: true }), tag: 'Placeholder1' };
  assert.equal(cite('CITATION Placeholder1 \\l 1033', 'apa', [ph]), '(Placeholder1)');
  assert.equal(cite('CITATION Placeholder1 \\l 1033', 'ieee', [ph]), '(Placeholder1)');
});

test('numbered styles number by first citation in the document', () => {
  const lee = { ...book({ id: 'l', authors: ['Lee, Ann'], title: 'B', year: '2025' }), tag: 'Lee25' };
  const doc = docOf('CITATION Lee25 \\l 1033', 'CITATION Smi26 \\l 1033');
  assert.deepEqual(citedTags(doc), ['Lee25', 'Smi26']);
  assert.equal(cite('CITATION Smi26 \\l 1033', 'ieee', [smith, lee], doc), '[2]');
  assert.equal(cite('CITATION Lee25 \\l 1033', 'ieee', [smith, lee], doc), '[1]');
});

test('bibliography order per style on three sources', () => {
  const zed = { ...book({ id: 'z', authors: ['Zed, Amy'], title: 'Apples', year: '2020' }), tag: 'Zed20' };
  const abel = { ...book({ id: 'a', authors: ['Abel, Bo'], title: 'Zebras', year: '2021' }), tag: 'Abe21' };
  const mid = { ...book({ id: 'm', authors: ['Mid, Cy'], title: 'Mangoes', year: '2022' }), tag: 'Mid22' };
  const three = [zed, abel, mid];
  const first = (style, cited) => wordBibliography(three, style, cited).map((rs) => rs.map((r) => r.text).join('').slice(0, 12));
  assert.deepEqual(first('apa').map((t) => t.slice(0, 4)), ['Abel', 'Mid,', 'Zed,']); // by author
  assert.deepEqual(first('gostTitle').map((t) => t.slice(3, 8)), ['Apple', 'Mango', 'Zebra']); // by title
  assert.deepEqual(first('ieee', ['Mid22', 'Zed20']).map((t) => t.slice(0, 3)), ['[1]', '[2]', '[3]']); // by first citation
  assert.match(first('ieee', ['Mid22', 'Zed20'])[0], /C\. Mid/);
  const blocks = bibliographyBlocks(docOf(), { sources: three, style: 'mla' });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].attrs.styleId, 'Bibliography');
  assert.equal(bibliographyBlocks(docOf(), { sources: [], style: 'apa' })[0].content[0].text, EMPTY_TEXT);
});

test("Word's 12 styles in the probe's order, then Harvard; every rule says whether it is verified", () => {
  assert.deepEqual(WORD_STYLES.map((r) => r.label), ['APA', 'Chicago', 'GB7714', 'GOST - Name Sort', 'GOST - Title Sort', 'Harvard - Anglia', 'IEEE',
    'ISO 690 - First Element and Date', 'ISO 690 - Numerical Reference', 'MLA', 'SIST02', 'Turabian', 'Harvard']);
  for (const r of WORD_STYLES) {
    assert.deepEqual(Object.keys(r.status).sort(), ['cite', 'entry', 'sort'], r.id);
    for (const v of Object.values(r.status)) assert.ok(v === 'verified' || v === 'unverified', `${r.id}: ${v}`);
    assert.ok(r.builder || typeof r.entry === 'function', r.id);
  }
});

test("cleanSource keeps Create Source's Corporate Author choice, false included, and adds none to other sources", () => {
  assert.equal(cleanSource({ authors: ['Plato'], corporate: false }).corporate, false);
  assert.equal(cleanSource({ authors: ['Anthropic'], corporate: true }).corporate, true);
  assert.equal('corporate' in cleanSource({ authors: ['Anthropic'] }), false);
});

test('a retagged citation keeps its other parts (Edit Source after a tag change)', () => {
  const c = parseCitation(parseField(String.raw`CITATION Placeholder1 \l 1033 \m Lee25 \p 12`));
  assert.equal(citationCode({ ...c, tags: c.tags.map((t) => (t === 'Placeholder1' ? 'Smi26' : t)) }), String.raw`CITATION Smi26 \l 1033 \m Lee25 \p 12`);
});

test("Create Source's Accessed boxes are the access date the styles print, and show it again", () => {
  const web = cleanSource({ type: 'web', title: 'Page', url: 'https://example.com', extra: { yearAccessed: '2026', monthAccessed: 'October', dayAccessed: '28' } });
  assert.equal(web.accessed, '2026-10-28');
  assert.equal(web.extra, undefined);
  assert.match(formatReference(web), /\(Accessed: 28 October 2026\)/);
  assert.deepEqual(['yearAccessed', 'monthAccessed', 'dayAccessed'].map((k) => fieldOf(web, k)), ['2026', 'October', '28']);
  assert.equal(cleanSource({ accessed: '2026-01-02', extra: { yearAccessed: '2026' } }).accessed, '2026-01-02'); // no whole date: left as it was
});

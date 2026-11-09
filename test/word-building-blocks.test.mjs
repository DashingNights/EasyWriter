// building-blocks pure logic (docs/plans/word briefs/building-blocks.md Acceptance): the F3 matcher, AutoComplete, the Options
// rules, the entry check, the built-in designs against the Document schema and the AUTOTEXT error text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { autoCompleteOf, autoTextResult, cleanEntries, firstWords, insertionOf, matchAutoText, MISSING, validEntry } from '../src/document/wp/building-blocks/blocks.mjs';
import { COVER_PROPS, COVERS, monthWeeks, QUICK_TABLES } from '../src/document/wp/building-blocks/designs.mjs';

const schema = getSchema(documentExtensions(50));
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const entry = (name, extra = {}) => ({ id: `id-${name}`, name, gallery: 'AutoText', category: 'General', description: '', insert: 'content',
  content: [p(name)], created: '2026-10-28T00:00:00Z', ...extra });

test('F3: an exact name beats a prefix, a unique prefix works, an ambiguous one is refused, case is ignored', () => {
  const list = [entry('addr'), entry('address'), entry('Kind regards,'), entry('signoff')];
  assert.equal(matchAutoText(list, 'my addr').entry.name, 'addr');
  assert.deepEqual(matchAutoText(list, 'see addre'), { entry: list[1], start: 4 });
  assert.equal(matchAutoText(list, 'x ADDRESS').entry.name, 'address');
  assert.equal(matchAutoText(list, 'Yours, kind regards,').entry.name, 'Kind regards,');
  assert.equal(matchAutoText(list, 'x SIG').entry.name, 'signoff');
  assert.deepEqual(matchAutoText([entry('alpha'), entry('alps')], 'al'), { error: 'ambiguous' });
  assert.deepEqual(matchAutoText(list, 'nothing'), { error: 'none' });
  assert.deepEqual(matchAutoText(list, 'xaddr'), { error: 'none' }); // not at a word start
});

test('AutoComplete starts at four letters and only for names of at least four', () => {
  const list = [entry('Kind regards,'), entry('abc'), entry('Spike', { gallery: 'Quick Parts' })];
  assert.equal(autoCompleteOf(list, 'Kin'), null);
  assert.equal(autoCompleteOf(list, 'Thanks. Kind').entry.name, 'Kind regards,');
  assert.equal(autoCompleteOf(list, 'Kind regards,'), null); // typed in full
  assert.equal(autoCompleteOf(list, 'abc'), null);
  assert.equal(autoCompleteOf(list, 'Spik'), null); // AutoText only
});

test('the three Options rules', () => {
  const sel = [p('Kind regards, Ana')];
  assert.deepEqual(insertionOf(sel, 'content'), { inline: sel[0].content });
  assert.deepEqual(insertionOf(sel, 'paragraph'), { blocks: sel });
  const page = insertionOf(sel, 'page').blocks;
  assert.equal(page.at(-1).type, 'pageBreak');
  assert.equal(page[0].type, 'pageBreak');
  assert.equal(insertionOf(sel, 'page', { atStart: true }).blocks[0].type, 'paragraph');
  assert.deepEqual(insertionOf([p('a'), p('b')], 'content'), { blocks: [p('a'), p('b')] });
});

test('the entry shape is checked and a corrupt entry is skipped', () => {
  const good = entry('ok');
  assert.ok(validEntry(good, schema));
  const bad = [{ ...good, gallery: 'Nope' }, { ...good, content: [] }, { ...good, name: ' ' }, { ...good, content: [{ type: 'unknownNode' }] }, null, 'x'];
  for (const b of bad) assert.equal(validEntry(b, schema), false);
  assert.deepEqual(cleanEntries([good, ...bad], schema), [good]);
  assert.deepEqual(cleanEntries({ not: 'a list' }, schema), []);
  assert.equal(firstWords('  Kind regards, Ana'), 'Kind regards,');
});

test('every built-in cover is valid Document JSON with the six bound controls', () => {
  for (const [id, c] of Object.entries(COVERS)) {
    const blocks = c.blocks();
    const node = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'sdtBlock', attrs: { sdt: { type: 'docPart', docPart: { gallery: 'Cover Pages' } } }, content: [...blocks, { type: 'pageBreak' }] }] });
    node.check();
    const props = [];
    node.descendants((n) => { if (n.type.name === 'sdtInline') props.push(n.attrs.sdt.binding.prop); });
    assert.deepEqual(props.sort(), COVER_PROPS.map(([k]) => k).sort(), id);
  }
});

test('every Quick Table is valid Document JSON holding a table', () => {
  const now = new Date(2026, 9, 28);
  for (const [id, q] of Object.entries(QUICK_TABLES)) {
    const doc = schema.nodeFromJSON({ type: 'doc', content: q.blocks(now) });
    doc.check();
    let tables = 0;
    doc.descendants((n) => { if (n.type.name === 'table') tables++; });
    assert.equal(tables, 1, id);
  }
  // October 2026 starts on a Thursday: Monday-first weeks lead with three blanks; 31 days fill five rows.
  const weeks = monthWeeks(2026, 9);
  assert.deepEqual(weeks[0], ['', '', '', 1, 2, 3, 4]);
  assert.equal(weeks.length, 5);
});

test('AUTOTEXT shows the entry text, a missing name gives Word\'s error', () => {
  const list = [entry('sig', { content: [p('Ana Silva'), p('Editor')] })];
  assert.equal(autoTextResult(list, 'SIG'), 'Ana Silva Editor');
  assert.deepEqual(autoTextResult(list, 'none'), { error: MISSING });
});

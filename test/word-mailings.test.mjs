// Mail merge's pure logic (docs/plans/word/briefs/mailings.md Acceptance): reading CSV and TSV, filter and sort, duplicates, the
// merge field types over a record cursor, Match Fields, a merge of copies and the label sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldCtx, parseField, registerField, registerFieldProvider, updateState } from '../src/document/fields/registry.mjs';
import { active, autoMap, duplicates, findIn, listed, parseDelimited, passes, refusal, sortOrder, MAX_RECORDS } from '../src/document/wp/mailings/data.mjs';
import { addressCode, FIELDS, greetingCode, makeCursor, missingFields, resultText } from '../src/document/wp/mailings/fields.mjs';
import { LABELS, mergeDocument, mergeLabelTable, updateLabels } from '../src/document/wp/mailings/merge.mjs';

for (const [name, type] of Object.entries(FIELDS)) registerField(name, type);
// The app registers the record provider (index.js); a merge seeds its cursor into the update's cache, which wins over it.
registerFieldProvider('record', () => null);

const CSV = 'First Name,Last Name,Address Line 1,Address Line 2,City,Country\r\n'
  + '"Ana","Lopez, Jr","1 ""Main"" St",,Springfield,United States\r\n'
  + 'Ben,Ng,"2 High St\nFlat 3",Rear,Leeds,United Kingdom\r\n'
  + 'Cy,,3 Low Rd,,Paris,France\r\n';

const src = () => parseDelimited(CSV, 'people.csv');

test('CSV with quotes, commas and newlines parses to fields and records', () => {
  const s = src();
  assert.deepEqual(s.fields, ['First Name', 'Last Name', 'Address Line 1', 'Address Line 2', 'City', 'Country']);
  assert.equal(s.records.length, 3);
  assert.equal(s.records[0][1], 'Lopez, Jr');
  assert.equal(s.records[0][2], '1 "Main" St');
  assert.equal(s.records[1][2], '2 High St\nFlat 3');
  assert.equal(s.records[2][1], '');
});

test('TSV is detected and parsed', () => {
  const s = parseDelimited('﻿Name\tCity\nAna\tRome\n\nBen\t"Oslo"\n', 'list.tsv');
  assert.deepEqual(s.fields, ['Name', 'City']);
  assert.deepEqual(s.records, [['Ana', 'Rome'], ['Ben', 'Oslo']]);
});

test('a list over the limit is refused', () => {
  const big = { fields: ['A'], records: Array.from({ length: MAX_RECORDS + 1 }, () => ['x']) };
  assert.match(refusal(big), /5,000/);
  assert.equal(refusal(src()), null);
});

test('filter rows: Contains, Is blank, And and Or', () => {
  const s = src();
  const keep = (filter) => s.records.filter((r) => passes(s.fields, r, filter)).map((r) => r[0]);
  assert.deepEqual(keep([{ field: 'City', op: 'contains', value: 'ee' }]), ['Ben']);
  assert.deepEqual(keep([{ field: 'Last Name', op: 'blank' }]), ['Cy']);
  assert.deepEqual(keep([{ field: 'City', op: 'contains', value: 's' }, { join: 'and', field: 'Address Line 2', op: 'blank' }]), ['Ana', 'Cy']);
  assert.deepEqual(keep([{ field: 'First Name', op: 'eq', value: 'ben' }, { join: 'or', field: 'Country', op: 'eq', value: 'France' }]), ['Ben', 'Cy']);
});

test('a three-key sort', () => {
  const s = { fields: ['A', 'B', 'C'], records: [['1', 'x', '3'], ['1', 'y', '1'], ['2', 'x', '1'], ['1', 'x', '2']] };
  const order = sortOrder(s.fields, s.records, [{ field: 'A' }, { field: 'B', desc: true }, { field: 'C' }]);
  assert.deepEqual(order, [1, 3, 0, 2]);
});

test('duplicates are rows equal in every column', () => {
  const s = { fields: ['A', 'B'], records: [['a', 'b'], ['c', 'd'], ['A ', 'b'], ['a', 'x']] };
  assert.deepEqual(duplicates(s), [[1, 3]]);
});

test('exclusions, the active list and Find recipient', () => {
  const s = src();
  const merge = { exclude: [2] };
  assert.deepEqual(listed(s, merge).map((r) => r.included), [true, false, true]);
  assert.deepEqual(active(s, merge).map((r) => r.n), [1, 3]);
  assert.equal(findIn(s.fields, active(s, merge), 'paris'), 1);
  assert.equal(findIn(s.fields, active(s, merge), 'paris', 'First Name'), -1);
});

test('Match Fields pairs "First Name" with "FirstName"', () => {
  const map = autoMap(['FirstName', 'Surname', 'ZIP', 'Email', 'Street']);
  assert.equal(map.first, 'FirstName');
  assert.equal(map.last, 'Surname');
  assert.equal(map.postal, 'ZIP');
  assert.equal(map.email, 'Email');
  assert.equal(map.address1, 'Street');
  assert.equal(map.middle, null);
});

// A FieldCtx whose record provider is `cursor`.
const ctxWith = (cursor) => {
  const shared = updateState();
  shared.cache.set('record', cursor);
  return fieldCtx({ doc: null, shared });
};
const compute = (code, ctx) => resultText(FIELDS[parseField(code).name].compute(parseField(code), ctx));

test('ADDRESSBLOCK: no empty line without Address Line 2, and \\c 2 drops only the excluded country', () => {
  const s = src();
  const merge = { map: autoMap(s.fields) };
  const list = active(s, merge);
  const code = addressCode();
  assert.equal(compute(code, ctxWith(makeCursor(s, merge, list, 0))), 'Ana Lopez, Jr\n1 "Main" St\nSpringfield');
  assert.equal(compute(code, ctxWith(makeCursor(s, merge, list, 1))), 'Ben Ng\n2 High St\nFlat 3\nRear\nLeeds\nUnited Kingdom');
  assert.equal(compute(code, ctxWith(null)), '«AddressBlock»');
});

test('GREETINGLINE with an empty last name prints the \\e text', () => {
  const s = src();
  const merge = { map: autoMap(s.fields) };
  const list = active(s, merge);
  const code = greetingCode({ empty: 'Dear Friend,' });
  assert.equal(compute(code, ctxWith(makeCursor(s, merge, list, 0))), 'Dear Lopez, Jr,');
  assert.equal(compute(code, ctxWith(makeCursor(s, merge, list, 2))), 'Dear Friend,');
});

test('MERGEFIELD \\b and \\f print only around a value', () => {
  const s = src();
  const list = active(s, {});
  const code = 'MERGEFIELD "Last Name" \\b "Dear " \\f ","';
  assert.equal(compute(code, ctxWith(makeCursor(s, {}, list, 0))), 'Dear Lopez, Jr,');
  assert.equal(compute(code, ctxWith(makeCursor(s, {}, list, 2))), '');
  assert.equal(compute(code, ctxWith(null)), '«Last Name»');
  assert.match(compute('MERGEFIELD Missing', ctxWith(makeCursor(s, {}, list, 0))), /not found/);
  assert.deepEqual(missingFields(['MERGEFIELD Missing', 'MERGEFIELD City', 'IF { MERGEFIELD Nope } = "x" "a" "b"'], s, {}), ['Missing', 'Nope']);
});

const field = (code) => ({ type: 'field', attrs: { code, result: null } });
const para = (...content) => ({ type: 'paragraph', content });
const text = (t) => ({ type: 'text', text: t });

test('NEXT advances the cursor and SKIPIF drops a record, so MERGESEQ and MERGEREC differ', async () => {
  const s = parseDelimited('Name,City\nAna,Rome\nBen,Paris\nCy,Oslo\nDee,Rome\n');
  const list = active(s, {});
  const doc = { type: 'doc', attrs: { sect: { w: 595 } }, content: [para(field('SKIPIF { MERGEFIELD City } = "Paris"'), text('#'), field('MERGEREC'),
    text('/'), field('MERGESEQ'), text(' '), field('MERGEFIELD Name'))] };
  const out = await mergeDocument(doc, list, s, { type: 'letters' });
  assert.equal(out.copies, 3);
  const texts = out.doc.content.filter((b) => b.type === 'paragraph').map((b) => b.content.map((n) => n.text ?? '').join(''));
  assert.deepEqual(texts, ['#1/1 Ana', '#3/2 Cy', '#4/3 Dee']);
  assert.equal(out.doc.content.filter((b) => b.type === 'sectionBreak').length, 2);
  assert.equal(out.doc.attrs.merge, null);

  const two = { type: 'doc', content: [para(field('MERGEFIELD Name'), text('+'), field('NEXT'), field('MERGEFIELD Name'), text(' '), field('MERGEREC'))] };
  const pairs = await mergeDocument(two, list, s, { type: 'directory' });
  assert.deepEqual(pairs.doc.content.map((b) => b.content.map((n) => n.text ?? '').join('')), ['Ana+Ben 2', 'Cy+Dee 4']);
});

test('a merge from and to, with an IF keeping its nested merge field filled in', async () => {
  const s = parseDelimited('Name\nAna\nBen\nCy\n');
  const doc = { type: 'doc', content: [para(field('IF { MERGEFIELD Name } = "Ben" "yes" "no"'))] };
  const out = await mergeDocument(doc, active(s, {}), s, { type: 'directory' }, { from: 2, to: 2 });
  assert.equal(out.copies, 1);
  assert.equal(out.doc.content[0].content[0].attrs.code, 'IF "Ben" = "Ben" "yes" "no"');
});

test('a 3 by 10 label sheet: Update Labels fills 30 cells, each after the first starting with NEXT', async () => {
  const label = LABELS.find((l) => l.name === '30 Per Page');
  const table = mergeLabelTable(label);
  table.content[0].content[0].content = [para(field('MERGEFIELD Name'))];
  const done = updateLabels(table);
  const cells = done.content.flatMap((r) => r.content);
  assert.equal(cells.length, 30);
  assert.ok(cells.slice(1).every((c) => c.content[0].content[0].attrs.code === 'NEXT' && c.content[0].content[1].attrs.code === 'MERGEFIELD Name'));
  const s = parseDelimited(`Name\n${Array.from({ length: 31 }, (_, i) => `P${i + 1}`).join('\n')}\n`);
  const out = await mergeDocument({ type: 'doc', content: [done, para()] }, active(s, {}), s, { type: 'labels' });
  const merged = out.doc.content[0].content.flatMap((r) => r.content);
  assert.equal(out.copies, 2);
  assert.equal(merged.length, 60);
  assert.equal(merged[29].content[0].content.map((n) => n.text ?? '').join(''), 'P30');
  assert.equal(merged[30].content[0].content.map((n) => n.text ?? '').join(''), 'P31');
  assert.equal(merged[31].content[0].content?.length ?? 0, 0);
});

// fields-core (docs/plans/word/briefs/fields-core.md Acceptance): the general switches against Word's probe values
// (index-fields.md), the field types, nesting, updates that keep locked and unregistered fields, and the Field dialog catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { star, numeric, datePicture } from '../src/document/wp/fields-core/format.mjs';
import { fieldTypes } from '../src/document/wp/fields-core/types.mjs';
import { CATEGORIES, FIELDS } from '../src/document/wp/fields-core/catalogue.mjs';
import { fieldCtx, parseField, registerField } from '../src/document/fields/registry.mjs';
import { numberText } from '../src/document/fields/numfmt.mjs';

const { computeField, updateFields } = await import('../src/document/fields/engine.js');
const { documentExtensions } = await import('../src/document/schema.js');

const NOW = new Date(2026, 9, 27, 16, 6, 44); // the probe's clock: Tuesday 27 October 2026, 16:06:44
const ctx = (extra = {}) => fieldCtx({ doc: null, now: NOW, ...extra });
const types = fieldTypes(parseField);
for (const [name, type] of Object.entries(types)) registerField(name, type);
const code = (c, extra) => {
  const r = computeField(c, ctx(extra));
  return typeof r === 'string' ? r : r?.error ?? r?.text ?? r;
};

test('\\* case and number formats', () => {
  assert.equal(code('QUOTE 28 \\* roman \\* Upper'), 'XXVIII');
  assert.equal(star("o'neil mcdonald-smith", 'Caps'), "O'neil Mcdonald-Smith");
  assert.equal(star('hello wORLD', 'FirstCap'), 'Hello wORLD');
  assert.deepEqual(['27', '52', '53'].map((n) => star(n, 'alphabetic')), ['aa', 'zz', 'aaa']);
  assert.equal(star('781', 'alphabetic').error, 'Error! Number cannot be represented in specified format.');
  assert.equal(star('4000', 'roman'), 'mmmm');
  assert.deepEqual(['11', '21', '112'].map((n) => star(n, 'Ordinal')), ['11th', '21st', '112th']);
  assert.equal(star('999999', 'CardText'), 'nine hundred ninety-nine thousand nine hundred ninety-nine');
  assert.equal(star('1234.56', 'DollarText'), 'one thousand two hundred thirty-four and 56/100');
  assert.equal(star('28.999', 'DollarText'), 'twenty-eight and 00/100');
  assert.equal(star('255', 'Hex'), 'FF');
  assert.equal(star('1.7', 'Arabic'), '2');
  assert.equal(code('QUOTE 28 \\* Bogus'), 'Error! Unknown switch argument.');
  assert.deepEqual(['GB4', 'DBNum2', 'Zodiac3', 'Hebrew1', 'ThaiCardText'].map((s) => star(s === 'GB4' || s === 'Zodiac3' ? '3' : '28', s)),
    ['㈢', '贰拾捌', '丙寅', 'כח', 'ยี่สิบแปด']);
  assert.equal(numberText(5, 'cardinalText'), 'five');
  assert.equal(numberText(3, 'upperRoman'), 'III');
  // List labels keep numberLabel's text where the \* switch has none: '' for 0, letters past 780.
  assert.deepEqual([numberText(0, 'lowerRoman'), numberText(0, 'upperLetter'), numberText(781, 'lowerLetter').length], ['', '', 31]);
});

test('\\# numeric pictures', () => {
  assert.equal(numeric(5, '000'), '005');
  assert.equal(numeric(5, '###'), '  5');
  assert.equal(numeric(111053, 'x##'), '053');
  assert.equal(numeric(-1234.5, '$#,##0.00;($#,##0.00)'), '($1,234.50)');
  assert.equal(numeric(0, "0.00;-0.00;'zero'"), 'zero');
  assert.equal(numeric(0.5, '##%'), ' 1%');
  assert.equal(numeric(1234.5, '0.00 `Figure`'), '1234.50 0');
  assert.equal(code('QUOTE "12 apples" \\# "0.0"'), '12.0');
});

test('\\@ date-time pictures at the probe time', () => {
  assert.equal(datePicture(NOW, 'dddd, MMMM d, yyyy'), 'Tuesday, October 27, 2026');
  assert.equal(datePicture(NOW, 'MMMMM'), 'October10');
  assert.equal(datePicture(NOW, 'yyy').error, 'Error! Unknown character in picture string.');
  assert.equal(datePicture(NOW, '`x`').error, 'Error! No bookmark name given.');
  assert.equal(code('DATE \\@ "d" \\* OrdText'), 'twenty-seventh');
  assert.equal(code('DATE'), '10/27/2026');
  assert.equal(code('TIME'), '4:06 PM');
  assert.equal(code('DATE \\h'), '5/16/1448');
  assert.equal(code('DATE \\s'), '8/5/1948');
  assert.equal(code('QUOTE "2026-01-05" \\@ "d MMMM yyyy"'), '5 January 2026');
  assert.equal(code('PRINTDATE'), '0/0/0000 0:00:00 AM');
  assert.equal(code('PRINTDATE \\@ "d MMM yyyy"'), '0 XXX 0000');
  assert.equal(code('SAVEDATE \\@ "HH:mm:ss"'), '00:00:00');
});

test('QUOTE joins words and keeps nested results whole', () => {
  assert.equal(code('QUOTE noquotes here'), 'noquoteshere');
  assert.equal(code('QUOTE { QUOTE "a b" }'), 'a b');
  assert.equal(code("QUOTE 'single'"), "'single'");
});

test('page fields read the geometry; AUTONUM paragraphs share one counter', async () => {
  const geometry = { pages: [{ index: 0, number: 1, label: '1', section: 0 }, { index: 1, number: 2, label: 'ii', section: 0 }],
    sections: [{ pages: 2 }], pageOf: () => 1, sectionOf: () => null };
  const page = geometry.pages[1];
  assert.equal(code('PAGE', { geometry, page }), 'ii');
  assert.equal(code('PAGE \\* Arabic', { geometry, page }), '2');
  assert.equal(code('NUMPAGES', { geometry }), '2');
  assert.equal(code('SECTIONPAGES', { geometry, page }), '2');

  const { Editor } = await import('@tiptap/core');
  const para = (c) => ({ type: 'paragraph', content: [{ type: 'field', attrs: { code: c } }, { type: 'text', text: ' item' }] });
  const ed = new Editor({ element: null, extensions: documentExtensions(50), content: { type: 'doc', content: [
    para('AUTONUM'), para('AUTONUM \\* alphabetic'), para('AUTONUM \\s ,'), para('AUTONUMLGL'), para('AUTONUMLGL \\e'), para('AUTONUMOUT')] } });
  try {
    const out = [];
    ed.state.doc.descendants((n, pos) => {
      if (n.type.name === 'field') out.push(code(n.attrs.code, { doc: ed.state.doc, pos }));
    });
    assert.equal(out.join(' '), '1. b. 3, 4. 5 6.');
  } finally {
    ed.destroy();
  }
});

test('a manual update keeps locked fields and names without a registered type', async () => {
  const { Editor } = await import('@tiptap/core');
  const { undoDepth } = await import('@tiptap/pm/history');
  const f = (c, extra) => ({ type: 'field', attrs: { code: c, ...extra } });
  const ed = new Editor({ element: null, extensions: documentExtensions(50), content: { type: 'doc', content: [{ type: 'paragraph', content: [
    f('QUOTE "new"', { result: 'old' }), f('QUOTE "new"', { result: 'kept', locked: true }), f('MERGEFIELD Name', { result: 'stored' })] }] } });
  ed.view.updateState(ed.state.reconfigure({ plugins: ed.extensionManager.plugins }));
  try {
    assert.equal(await updateFields(ed, 'all', 'manual'), 1);
    const results = [];
    ed.state.doc.descendants((n) => void (n.type.name === 'field' && results.push(n.attrs.result)));
    assert.deepEqual(results, ['new', 'kept', 'stored']);
    assert.equal(undoDepth(ed.state), 1, 'one undo step');
  } finally {
    ed.destroy();
  }
});

test('the Field dialog catalogue: 77 names and the nine category lists', () => {
  assert.equal(FIELDS.length, 77);
  assert.deepEqual(FIELDS.slice(0, 30).map((r) => r[0]), ['= (Formula)', 'AddressBlock', 'Advance', 'Ask', 'Author', 'AutoNum', 'AutoNumLgl',
    'AutoNumOut', 'AutoText', 'AutoTextList', 'BarCode', 'Bibliography', 'BidiOutline', 'Citation', 'Comments', 'Compare', 'CreateDate', 'Database',
    'Date', 'DocProperty', 'DocVariable', 'EditTime', 'Eq', 'FileName', 'FileSize', 'Fill-in', 'GoToButton', 'GreetingLine', 'Hyperlink', 'If']);
  const lists = {
    'Date and Time': 'CreateDate, Date, EditTime, PrintDate, SaveDate, Time',
    'Document Automation': 'Compare, DocVariable, GoToButton, If, MacroButton, Print',
    'Document Information': 'Author, Comments, DocProperty, FileName, FileSize, Info, Keywords, LastSavedBy, NumChars, NumPages, NumWords, Subject, Template, Title',
    'Equations and Formulas': '= (Formula), Advance, Eq, Symbol',
    'Index and Tables': 'Index, RD, TA, TC, TOA, TOC, XE',
    'Links and References': 'AutoText, AutoTextList, Hyperlink, IncludePicture, IncludeText, Link, NoteRef, PageRef, Quote, Ref, StyleRef',
    'Mail Merge': 'AddressBlock, Ask, Compare, Database, Fill-in, GreetingLine, If, MergeField, MergeRec, MergeSeq, Next, NextIf, Set, SkipIf',
    Numbering: 'AutoNum, AutoNumLgl, AutoNumOut, BarCode, ListNum, Page, RevNum, Section, SectionPages, Seq',
    'User Information': 'UserAddress, UserInitials, UserName',
  };
  assert.deepEqual(CATEGORIES, Object.keys(lists));
  CATEGORIES.forEach((c, i) => assert.equal(FIELDS.filter((r) => r[2].includes(i)).map((r) => r[0]).join(', '), lists[c], c));
});

// Footnotes and endnotes, the pure part (src/document/wp/notes/model.mjs; docs/plans/word/briefs/notes.md Acceptance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import {
  convertContent, convertKind, convertPlan, effectivePr, endnoteGroups, freshId, labelsOf, noteNumber, numberNotes, repeatedIds, splitAreas,
} from '../src/document/wp/notes/model.mjs';

const schema = getSchema(documentExtensions(50));
const note = (kind, id, mark = null) => ({ type: 'noteRef', attrs: { kind, id, mark } });
const para = (...inline) => ({ type: 'paragraph', content: inline.map((x) => (typeof x === 'string' ? { type: 'text', text: x } : x)) });
const docOf = (content, attrs = {}) => schema.nodeFromJSON({ type: 'doc', attrs, content });

test('labels per number format', () => {
  assert.deepEqual([1, 2, 3].map((n) => noteNumber(n, 'decimal')), ['1', '2', '3']);
  assert.deepEqual([1, 26, 27, 28].map((n) => noteNumber(n, 'lowerLetter')), ['a', 'z', 'aa', 'bb']);
  assert.equal(noteNumber(27, 'upperLetter'), 'AA');
  assert.deepEqual([1, 4, 9].map((n) => noteNumber(n, 'lowerRoman')), ['i', 'iv', 'ix']);
  assert.equal(noteNumber(14, 'upperRoman'), 'XIV');
  assert.deepEqual([1, 2, 3, 4, 5, 8, 9].map((n) => noteNumber(n, 'chicago')), ['*', '†', '‡', '§', '**', '§§', '***']);
});

test('the effective note properties: section over document over defaults', () => {
  assert.deepEqual(effectivePr('footnote', null, null), { pos: 'pageBottom', numFmt: 'decimal', numStart: 1, numRestart: 'continuous', columns: 0, sep: null });
  assert.equal(effectivePr('endnote', {}, {}).numFmt, 'lowerRoman');
  assert.equal(effectivePr('endnote', {}, {}).pos, 'docEnd');
  const settings = { footnotePr: { numFmt: 'lowerLetter', numStart: 3 } };
  assert.equal(effectivePr('footnote', settings, null).numFmt, 'lowerLetter');
  const pr = effectivePr('footnote', settings, { footnotePr: { numFmt: 'upperRoman', numStart: null } });
  assert.equal(pr.numFmt, 'upperRoman');
  assert.equal(pr.numStart, 3, 'a null key in the section leaves the document value');
  assert.equal(effectivePr('endnote', { endnotePr: { numRestart: 'eachPage' } }).numRestart, 'continuous', 'endnotes never restart per page');
});

test('restart logic from a page per note and section starts', () => {
  const pr = (numRestart, extra = {}) => () => ({ ...effectivePr('footnote', null, null), numRestart, ...extra });
  const list = [{ page: 0, section: 0 }, { page: 0, section: 0 }, { page: 1, section: 0 }, { page: 2, section: 1 }, { page: 2, section: 1 }]
    .map((n) => ({ kind: 'footnote', mark: null, ...n }));
  assert.deepEqual(numberNotes(list, pr('continuous')), ['1', '2', '3', '4', '5']);
  assert.deepEqual(numberNotes(list, pr('eachPage', { numFmt: 'lowerLetter' })), ['a', 'b', 'a', 'a', 'b']);
  assert.deepEqual(numberNotes(list, pr('eachSect', { numStart: 5 })), ['5', '6', '7', '5', '6']);
  // Footnotes and endnotes count on their own.
  const mixed = [{ kind: 'footnote' }, { kind: 'endnote' }, { kind: 'footnote' }].map((n) => ({ mark: null, page: 0, section: 0, ...n }));
  assert.deepEqual(numberNotes(mixed, (kind) => effectivePr(kind)), ['1', 'i', '2']);
});

test('custom marks take no number from the sequence', () => {
  const list = [null, '¤', null].map((mark) => ({ kind: 'footnote', mark, page: 0, section: 0 }));
  assert.deepEqual(numberNotes(list, () => effectivePr('footnote')), ['1', '¤', '2']);
});

test('labels of a document follow its settings and sections', () => {
  const doc = docOf([para('A', note('footnote', 'a'), ' B', note('endnote', 'b'), note('footnote', 'c'))],
    { settings: { footnotePr: { numFmt: 'upperLetter' } } });
  const labels = [...labelsOf(doc).values()].map((l) => `${l.kind}:${l.label}`);
  assert.deepEqual(labels, ['footnote:A', 'endnote:i', 'footnote:B']);
  // Restart each page asks pageOf for each footnote.
  const paged = docOf(doc.toJSON().content, { settings: { footnotePr: { numRestart: 'eachPage' } } });
  const pages = { 2: 0, 6: 1 };
  const byPage = [...labelsOf(paged, (pos) => pages[pos] ?? 9).values()].filter((l) => l.kind === 'footnote').map((l) => l.label);
  assert.deepEqual(byPage, ['1', '1']);
});

test('endnotes collect at the end of the document, or of each section that does not pass them on', () => {
  const sect = (extra) => ({ w: 595, h: 842, margin: { top: 72, right: 72, bottom: 72, left: 72 }, ...extra });
  const content = [para('one', note('endnote', 'e1')), { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: sect({ noEndnote: true }) } },
    para('two', note('endnote', 'e2')), { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: sect() } }, para('three', note('endnote', 'e3'))];
  const atEnd = endnoteGroups(docOf(content, { sect: sect() }));
  assert.equal(atEnd.length, 1);
  assert.deepEqual(atEnd[0].notes.map((n) => n.node.attrs.id), ['e1', 'e2', 'e3']);
  const doc = docOf(content, { sect: sect(), settings: { endnotePr: { pos: 'sectEnd' } } });
  const groups = endnoteGroups(doc);
  assert.deepEqual(groups.map((g) => g.notes.map((n) => n.node.attrs.id)), [['e1', 'e2'], ['e3']]);
  assert.equal(doc.nodeAt(groups[0].pos).type.name, 'sectionBreak', 'the first group sits before the second break');
  assert.equal(groups[1].pos, doc.content.size);
});

test('a note area splits between two pages by height and room', () => {
  const lines = (h, step = 10) => Array.from({ length: h / step }, (_, i) => (i + 1) * step);
  // Page 0: a 30 px note and a 100 px note with 80 px room; page 1: its own 20 px note.
  const out = splitAreas([
    { room: 80, notes: [{ id: 'a', h: 30, lines: lines(30) }, { id: 'b', h: 100, lines: () => lines(100) }] },
    { room: 200, notes: [{ id: 'c', h: 20, lines: lines(20) }] },
  ]);
  assert.deepEqual(out[0].parts, [{ id: 'a', from: 0, to: 30 }, { id: 'b', from: 0, to: 50 }]);
  assert.equal(out[0].notice, true);
  assert.equal(out[0].height, 80);
  assert.equal(out[1].cont, true, 'page 2 starts with the continued note');
  assert.deepEqual(out[1].parts, [{ id: 'b', from: 50, to: 100 }, { id: 'c', from: 0, to: 20 }]);
  assert.equal(out[1].height, 70);
  // A page's own note keeps its first line even without room; the last page takes the rest.
  const tight = splitAreas([{ room: 0, notes: [{ id: 'x', h: 40, lines: lines(40) }] }, { room: 10, notes: [] }]);
  assert.deepEqual(tight[0].parts, [{ id: 'x', from: 0, to: 10 }]);
  assert.deepEqual(tight[1].parts, [{ id: 'x', from: 10, to: 40 }]);
  // A note's own room (below its reference) holds the notes above it on the page; a low reference cuts its note early.
  const low = splitAreas([
    { room: 200, notes: [{ id: 'a', h: 10, room: 190 }, { id: 'b', h: 10, room: 180 }, { id: 'c', h: 40, room: 5, lines: lines(40) }] },
    { room: 200, notes: [] },
  ]);
  assert.deepEqual(low[0].parts, [{ id: 'a', from: 0, to: 10 }, { id: 'b', from: 0, to: 10 }, { id: 'c', from: 0, to: 10 }]);
  assert.deepEqual(low[1].parts, [{ id: 'c', from: 10, to: 40 }]);
  // Everything fits: no cut, no continuation.
  const easy = splitAreas([{ room: 500, notes: [{ id: 'a', h: 30 }] }]);
  assert.deepEqual(easy[0], { parts: [{ id: 'a', from: 0, to: 30 }], cont: false, notice: false, height: 30 });
});

test('convert and swap', () => {
  assert.equal(convertKind('footnote', 'toEndnotes'), 'endnote');
  assert.equal(convertKind('endnote', 'toEndnotes'), 'endnote');
  assert.equal(convertKind('endnote', 'toFootnotes'), 'footnote');
  assert.equal(convertKind('footnote', 'swap'), 'endnote');
  assert.equal(convertKind('endnote', 'swap'), 'footnote');
  const content = [{ type: 'paragraph', attrs: { styleId: 'FootnoteText' }, content: [{ type: 'text', text: 'x' }] }, { type: 'paragraph' }];
  const moved = convertContent(content, 'endnote');
  assert.equal(moved[0].attrs.styleId, 'EndnoteText');
  assert.equal(moved[1], content[1]);
  assert.equal(convertContent(content, 'footnote'), content, 'unchanged content is the same array');
  const doc = docOf([para('a', note('footnote', '1'), note('endnote', '2'), note('footnote', '3'))]);
  assert.deepEqual(convertPlan(doc, 'toEndnotes').map((c) => c.node.attrs.id), ['1', '3']);
  assert.deepEqual(convertPlan(doc, 'swap').map((c) => `${c.node.attrs.id}:${c.kind}`), ['1:endnote', '2:footnote', '3:endnote']);
});

test('a pasted copy of a reference gets a fresh id; the note that was there keeps its own', () => {
  assert.equal(freshId(new Set(['1', '3'])), '4');
  assert.equal(freshId(new Set(['2', '3'])), '4');
  assert.deepEqual(repeatedIds(docOf([para('a', note('footnote', '1'), note('footnote', '2'))])), []);
  // The copy pasted before the original: keep(id) names where the original now is.
  const doc = docOf([para('a', note('footnote', '1'), 'b', note('footnote', '2'), note('footnote', '1'))]);
  const fix = repeatedIds(doc, (id) => (id === '1' ? 5 : null));
  assert.equal(fix.length, 1);
  assert.equal(fix[0].pos, 2);
  assert.equal(fix[0].id, '3');
  // Without a known original (a copy pasted after a cut), the first keeps the id.
  assert.deepEqual(repeatedIds(doc).map((f) => f.pos), [5]);
});

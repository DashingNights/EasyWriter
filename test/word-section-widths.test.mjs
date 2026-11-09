// Section text widths (docs/plans/word/briefs/section-widths.md): each section's text width against the editor's one column (the
// last section's), and the decorations that carry the difference onto every top-level block of a section of another width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { defaultSect } from '../src/document/defaults.mjs';
import { blockDecorations } from '../src/document/pagination.js';
import { documentExtensions } from '../src/document/schema.js';
import { withDefaults } from '../src/document/model/sections.mjs';
import { sectionShifts } from '../src/document/wp/page-engine/layout.mjs';

const A4 = withDefaults(defaultSect('a4'));
const A4L = { ...A4, w: A4.h, h: A4.w, orient: 'landscape' };
const LETTER_WIDE = { ...withDefaults(defaultSect('letter')), margin: { ...A4.margin, left: 108, right: 108 } };
const GUTTER = { ...A4, margin: { ...A4.margin, gutter: 72 } };
const r2 = (v) => Math.round(v * 100) / 100;

test('each section against the last section\'s column: narrower is positive, wider negative, the same 0', () => {
  const { column, shifts } = sectionShifts([A4L, LETTER_WIDE, GUTTER, A4], {});
  assert.equal(column, 601.73); // A4 less 1 inch margins: 451.3 pt
  assert.deepEqual(shifts, [r2(601.73 - 930.53), r2(601.73 - 528), r2(601.73 - 505.73), 0]);
});

test('a gutter at the top takes nothing from the width; mirror margins never change it', () => {
  assert.deepEqual(sectionShifts([GUTTER, A4], { gutterAtTop: true }).shifts, [0, 0]);
  assert.deepEqual(sectionShifts([GUTTER, A4], { mirrorMargins: true }).shifts, [96, 0]);
});

const schema = getSchema(documentExtensions(50));
const p = (s) => schema.node('paragraph', null, [schema.text(s)]);
const ends = (sect) => schema.node('sectionBreak', { kind: 'nextPage', sect });

/** The decorations of `doc` as [text of the block (or its type), its attrs]. */
const decos = (doc, widths) => blockDecorations(doc, widths).find().map((d) => [doc.nodeAt(d.from).textContent || doc.nodeAt(d.from).type.name, d.type.attrs]);

test('while pages are drawn, the blocks of a section of another width carry its difference; the column\'s carry nothing', () => {
  const doc = schema.node('doc', { sect: A4 }, [p('wide'), schema.node('pageBreak'), p('wide 2'), ends(A4L), p('same'), ends(A4), p('narrow'), ends(LETTER_WIDE), p('last')]);
  const wide = { 'data-pg-dr': '', style: '--pg-dr:-328.8px' };
  assert.deepEqual(decos(doc, true), [
    ['wide', wide], ['pageBreak', wide], ['wide 2', { 'data-after-break': '', ...wide }], ['sectionBreak', wide],
    ['narrow', { 'data-pg-dr': '', style: '--pg-dr:73.73px' }], ['sectionBreak', { 'data-pg-dr': '', style: '--pg-dr:73.73px' }],
  ]);
  // Outside paged views only the page break's mark stays.
  assert.deepEqual(decos(doc, false), [['wide 2', { 'data-after-break': '' }]]);
});

test('a document of one width takes the same decorations with pages drawn or not', () => {
  const doc = schema.node('doc', { sect: A4 }, [p('a'), ends(A4), p('b')]);
  assert.equal(blockDecorations(doc, true), blockDecorations(doc, false));
  assert.equal(blockDecorations(doc, true).find().length, 0);
});

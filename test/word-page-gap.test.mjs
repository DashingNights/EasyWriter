// page-gap (docs/plans/word/briefs/page-gap.md): an object fits the text height of its own section, not the least of the whole
// document. The Word fixture has a section with a 1 pt text area, and every picture, canvas and row in it was shrunk to 1 px.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { defaultSect } from '../src/document/defaults.mjs';
import { blockDecorations } from '../src/document/pagination.js';
import { documentExtensions } from '../src/document/schema.js';
import { withDefaults } from '../src/document/model/sections.mjs';
import { sectionBodies } from '../src/document/wp/page-engine/layout.mjs';

test('each section takes the least body of its pages; one begun mid-page takes the section before it', () => {
  const pages = [
    { section: 0, bodyH: 931 }, { section: 0, bodyH: 900 }, // a taller header on the second page
    { section: 1, bodyH: 50, blank: true }, // a blank page counts for nothing
    { section: 1, bodyH: 1.333 },
    { section: 3, bodyH: 931 }, // section 2 starts mid-page on section 1's page
  ];
  assert.deepEqual(sectionBodies(pages, 4), [900, 1.33, 1.33, 931]);
  assert.deepEqual(sectionBodies([], 2), [null, null]);
});

const A4 = withDefaults(defaultSect('a4'));
const A4L = { ...A4, w: A4.h, h: A4.w, orient: 'landscape' };
const schema = getSchema(documentExtensions(50));
const p = (s) => schema.node('paragraph', null, [schema.text(s)]);
const ends = (sect) => schema.node('sectionBreak', { kind: 'nextPage', sect });
const decos = (doc, widths, bodies) => blockDecorations(doc, widths, bodies).find()
  .map((d) => [doc.nodeAt(d.from).textContent || doc.nodeAt(d.from).type.name, d.type.attrs]);

test('while pages are drawn, the blocks of a section of another text height carry it; the last section\'s carry nothing', () => {
  const doc = schema.node('doc', { sect: A4 }, [p('tiny'), ends(A4), p('same'), ends(A4), p('last')]);
  const tiny = { style: '--pg-body:1.33px;--fit-h:1.33px' };
  assert.deepEqual(decos(doc, true, [1.33, 931, 931]), [['tiny', tiny], ['sectionBreak', tiny]]);
  // One height throughout, no pages drawn or no plan yet: nothing.
  assert.deepEqual(decos(doc, true, [931, 931, 931]), []);
  assert.deepEqual(decos(doc, false, [1.33, 931, 931]), []);
  assert.deepEqual(decos(doc, true, null), []);
  // The same bodies give the same set (one walk per doc and plan).
  assert.equal(blockDecorations(doc, true, [1.33, 931, 931]), blockDecorations(doc, true, [1.33, 931, 931]));
});

test('a block of a section of another width and height carries both in one style', () => {
  const doc = schema.node('doc', { sect: A4 }, [p('wide'), ends(A4L), p('last')]);
  assert.deepEqual(decos(doc, true, [451.33, 931]), [
    ['wide', { 'data-pg-dr': '', style: '--pg-dr:-328.8px;--pg-body:451.33px;--fit-h:451.33px' }],
    ['sectionBreak', { 'data-pg-dr': '', style: '--pg-dr:-328.8px;--pg-body:451.33px;--fit-h:451.33px' }],
  ]);
});

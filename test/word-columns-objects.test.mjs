// Objects in newspaper columns (docs/plans/word/briefs/columns-objects.md): the Document kit's columns node holds canvases, plan
// charts, text boxes and pictures; an object inserted at the caret goes into the caret's column (flowPos); applying columns takes
// the objects in; float layout's column box (columnBoxAt); .docx keeps an object in its column; drafts stored before still load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { defaultSect } from '../src/document/defaults.mjs';
import { withDefaults } from '../src/document/model/sections.mjs';
import { documentExtensions } from '../src/document/schema.js';
import { applyColumns, colBoxes, columnBoxAt, columnWidthAt, flowDepth, flowPos, unitsOf } from '../src/document/wp/columns/model.mjs';
import { paperOf } from '../src/document/wp/page-engine/layout.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';

const { kitOf, loadable } = await import('../src/editors.js');
const schema = kitOf('document').schema;
const LETTER = withDefaults(defaultSect('letter'));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const P = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const CANVAS = { type: 'canvas', attrs: { w: 288, h: 160, dw: 288, items: [{ id: 'a', type: 'rect' }] } };
const CHART = { type: 'planChart', attrs: { id: 'abc1234', planId: 'p1', view: 'gantt' } };
const BOX = { type: 'textBox', content: [P('In the box')] };
const PIC = { type: 'paragraph', content: [{ type: 'image', attrs: { src: PNG, width: 40, height: 30 } }] };
const COLS = (content, count = 2) => ({ type: 'columns', attrs: { count, space: 36, sep: false, equal: true, widths: null }, content });
const doc = (content) => schema.nodeFromJSON({ type: 'doc', attrs: { sect: LETTER }, content });
const posOf = (d, text) => {
  let at = null;
  d.descendants((n, pos) => void (at == null && n.isText && n.text.includes(text) && (at = pos + n.text.indexOf(text))));
  return at;
};

test('the Document kit\'s columns hold every block object; section breaks and nested columns stay out', () => {
  doc([COLS([P('a'), CANVAS, CHART, BOX, PIC, P('b')])]).check();
  assert.throws(() => doc([COLS([{ type: 'sectionBreak', attrs: { kind: 'continuous', sect: LETTER } }])]).check());
  assert.throws(() => doc([COLS([COLS([P('a')])])]).check());
  // The schema without the kit's objects (Node tests, the docx worker) still builds and names only its own blocks.
  assert.doesNotMatch(getSchema(documentExtensions(50)).nodes.columns.spec.content, /canvas/);
  assert.match(schema.nodes.columns.spec.content, /\| canvas \| planChart\)\+$/);
});

test('drafts stored before load, and a draft with an object in its columns loads', () => {
  const before = { format: 'document', formatVersion: 2, doc: { type: 'doc', content: [COLS([P('a'), { type: 'columnBreak' }, BOX, P('b')]), CANVAS, P('c')] } };
  assert.ok(loadable(before, {}));
  assert.ok(loadable({ ...before, doc: { type: 'doc', content: [COLS([P('a'), CANVAS, CHART, P('b')]), P('c')] } }, {}));
});

test('an object goes after (or before) the caret\'s block in the text flow: in columns, the column\'s block', () => {
  const d = doc([P('top'), COLS([P('left'), P('right')]), P('after')]);
  const $top = d.resolve(posOf(d, 'top') + 1);
  assert.equal(flowDepth($top), 1);
  assert.equal(flowPos($top), d.child(0).nodeSize);
  assert.equal(flowPos($top, true), 0);
  const $right = d.resolve(posOf(d, 'right') + 2);
  assert.equal(flowDepth($right), 2);
  const colsAt = d.child(0).nodeSize;
  const rightAt = colsAt + 1 + d.child(1).child(0).nodeSize;
  assert.equal(flowPos($right), rightAt + d.child(1).child(1).nodeSize, 'after the right paragraph, still in the columns');
  assert.equal(flowPos($right, true), rightAt);
  const $between = d.resolve(rightAt); // between the columns' blocks (a node selection's end there)
  assert.equal(flowPos($between), rightAt);
  // Inserting there keeps the canvas in the columns node, at one column's width.
  const tr = EditorState.create({ doc: d }).tr.insert(flowPos($right), schema.nodeFromJSON(CANVAS));
  tr.doc.check();
  assert.deepEqual(tr.doc.child(1).content.content.map((n) => n.type.name), ['paragraph', 'paragraph', 'canvas']);
  const text = paperOf(LETTER).text;
  assert.equal(columnWidthAt(tr.doc, flowPos($right)), colBoxes({ count: 2, space: 36 }, text)[0].width);
});

test('applying columns takes the section\'s objects in', () => {
  const d = doc([P('one'), CANVAS, CHART, P('two')]);
  const tr = EditorState.create({ doc: d }).tr;
  const units = unitsOf(d);
  assert.ok(applyColumns(tr, 0, units.length - 1, { count: 2, space: 36, sep: false, equal: true, widths: null }));
  tr.doc.check();
  assert.equal(tr.doc.childCount, 1);
  assert.deepEqual(tr.doc.child(0).content.content.map((n) => n.type.name), ['paragraph', 'canvas', 'planChart', 'paragraph']);
  // One column again: the objects come back out in order.
  const back = EditorState.create({ doc: tr.doc }).tr;
  assert.ok(applyColumns(back, 0, unitsOf(tr.doc).length - 1, null));
  assert.deepEqual(back.doc.content.content.map((n) => n.type.name), ['paragraph', 'canvas', 'planChart', 'paragraph']);
});

test('float layout\'s column: the newspaper column the anchor was drawn in, its box from the page setup', () => {
  const d = doc([P('top'), COLS([P('left'), P('mid'), P('right')], 3)]);
  const boxes = colBoxes({ count: 3, space: 36 }, paperOf(LETTER).text);
  const at = posOf(d, 'right') - 1;
  assert.equal(columnBoxAt(d, posOf(d, 'top') - 1, 0), null, 'outside columns: the page frame');
  assert.deepEqual(columnBoxAt(d, at, 0), boxes[0]);
  assert.deepEqual(columnBoxAt(d, at, boxes[1].left), boxes[1]);
  assert.deepEqual(columnBoxAt(d, at, boxes[2].left + 18), boxes[2], 'an indented paragraph in column 3');
  // The caller passes the block's midpoint: a paragraph in column 2 outdented 18 px into the gap still measures from column 2.
  assert.deepEqual(columnBoxAt(d, at, boxes[1].left - 18 + (boxes[1].width + 18) / 2), boxes[1], 'an outdented paragraph in column 2');
});

test('.docx keeps each object in its column: a section with columns holding it', async () => {
  const content = [P('Before'), COLS([P('Left'), CANVAS, PIC, BOX, { type: 'columnBreak' }, P('Right'), CHART, P('End')]), P('After')];
  const json = { type: 'doc', attrs: { sect: LETTER }, content };
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  const { bytes } = await exportDocx(json, { media: async () => ({ bytes: png, ext: 'png', w: 1, h: 1 }), picture: async () => ({ bytes: png, ext: 'png', w: 10, h: 10 }) });
  const back = (await importDocx(bytes)).doc;
  schema.nodeFromJSON(back).check();
  const cols = back.content.find((n) => n.type === 'columns');
  assert.ok(cols, 'a columns node');
  assert.equal(cols.attrs.count, 2);
  const kinds = cols.content.map((n) => n.type);
  assert.ok(kinds.includes('canvas') && kinds.includes('planChart') && kinds.includes('columnBreak'), kinds.join(' '));
  assert.ok(kinds.indexOf('canvas') < kinds.indexOf('columnBreak') && kinds.indexOf('planChart') > kinds.indexOf('columnBreak'), 'each in its column');
  const flat = JSON.stringify(cols);
  assert.match(flat, /"type":"image"/, 'the picture');
  assert.match(flat, /"type":"textBox"/, 'the text box');
  assert.deepEqual(back.content.filter((n) => n.type !== 'columns').map((n) => n.content?.[0]?.text), ['Before', 'After']);
});

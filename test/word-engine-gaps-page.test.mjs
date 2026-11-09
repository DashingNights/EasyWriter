// engine-gaps-page (docs/plans/engine/stage2b.md, Gap packages): the rows it builds are working rows on a canvas draft, they pass
// the engine its params, and the Table Properties and table style helpers translate between the dialogs and the engine.
//   node --test test/word-engine-gaps-page.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { PAGE } from '../src/document/canvas/rows/page.mjs';
import { REFERENCES } from '../src/document/canvas/rows/references.mjs';
import { defineOf } from '../src/document/wp/table-design/canvas.mjs';
import { tablePropsSteps, tablePropsValue } from '../src/document/wp/table-layout/canvas.mjs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { Engine, initSync } from '../src/engine/wasm/ew.js';

const WASM = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);

const BUILT = {
  page: ['design.pageBackground.watermark.customWatermark', 'draw.edit.formatBackground.none', 'draw.edit.formatBackground.collegeRuled',
    'draw.edit.formatBackground.veryLargeGrid', 'draw.edit.formatBackground.applyToFullPage', 'insert.headerFooter.pageNumber.pageMargins',
    'headerFooter.options.showDocumentText', 'tableLayout.table.properties'],
  references: ['editing.autoTextF3', 'insert.pages.coverPage.removeCurrentCoverPage', 'design.pageBackground.watermark.saveSelectionToWatermarkGallery',
    'references.tableOfContents.tableOfContents.saveSelectionToTableOfContentsGallery',
    'references.citationsBibliography.bibliography.saveSelectionToBibliographyGallery', 'references.tableOfContents.tableOfContents.manualTable',
    'references.citationsBibliography.manageSources'],
};
const ctx = (state = {}) => ({ engineState: state, settings: {}, profile: null });
const params = (id, arg, c = ctx()) => (typeof PAGE[id].args === 'function' ? PAGE[id].args(arg, c) : PAGE[id].args);

test('the built rows are working rows, none off', () => {
  for (const id of BUILT.page) assert.ok(['exec', 'spec', 'engine'].includes(formOf(PAGE[id])), id);
  for (const id of BUILT.references) assert.ok(['exec', 'spec', 'engine'].includes(formOf(REFERENCES[id])), id);
});

test('the rows pass the engine its params and read its state', () => {
  assert.deepEqual(params('draw.edit.formatBackground.wideRuled'), { kind: 'wideRuled' });
  assert.equal(PAGE['draw.edit.formatBackground.none'].active({ value: { kind: 'none', full: true } }), true);
  assert.deepEqual(params('insert.headerFooter.pageNumber.pageMargins', 'left'), { position: 'margin', align: 'left' });
  assert.equal(params('insert.headerFooter.pageNumber.pageMargins', undefined), null, 'no pick, nothing runs');
  assert.deepEqual(params('insert.headerFooter.header', 'titleRule'), { preset: 'titleRule' });
  assert.deepEqual(params('insert.headerFooter.footer', 'titleNumber'), { preset: 'titleNumber' });
  assert.equal(PAGE['headerFooter.navigation.linkToPrevious'].active({ checked: true }), true, 'pressed from the engine state');
  assert.equal(PAGE['insert.pages.pageBreak'].hide, undefined, 'a page break in a table splits it');
});

test('Table Properties: the dialog value from table.get, and only the changes back', () => {
  const t = {
    props: { align: 'left', indent: 0, cellMargins: [0, 5.4, 0, 5.4] }, grid: [100, 100, 100], row: 1, cell: 1, selection: null,
    rows: [0, 1, 2].map((r) => ({ props: { header: r === 0 }, cells: [0, 1, 2].map((c) => ({ props: c === 1 && r === 1 ? { valign: 'center' } : {}, text: '', col: c })) })),
  };
  const was = tablePropsValue(t, { pageW: 612, marginLeft: 72, marginRight: 72 });
  assert.equal(was.headerRun, 1);
  assert.deepEqual([was.rowsAt, was.colsAt, was.cell.vAlign, was.textWidth, was.tableWidth], [[1, 1], [1, 1], 'center', 468, 300]);
  assert.deepEqual(tablePropsSteps(structuredClone(was), was), [], 'nothing changed, nothing runs');
  const out = structuredClone(was);
  out.table.align = 'center';
  out.rows[2] = { ...out.rows[2], height: { value: 30, rule: 'exact' }, cantSplit: true };
  out.cols[0] = 80;
  out.cell.vAlign = 'bottom';
  out.table.caption = 'Prices';
  assert.deepEqual(tablePropsSteps(out, was), [
    ['table.properties', { align: 'center', rows: [{ index: 2, height: 30, heightRule: 'exact', allowBreak: false, headerRow: false }],
      columns: [{ index: 0, width: 80 }], valign: 'bottom' }],
    ['table.altText', { title: 'Prices', text: '' }],
  ]);
});

test('a gallery table style comes with its definition for the engine', () => {
  const d = defineOf('GridTable4-Accent1');
  assert.equal(d.name, 'Grid Table 4 - Accent 1');
  assert.ok(d.parts.some((p) => p.part === 'wholeTable' && p.borders?.length));
  assert.ok(d.parts.some((p) => p.part === 'firstRow'), 'the header row part');
  assert.equal(defineOf('NoSuchStyle'), null);
});

// gaps.md: the note and table of contents states scanned the whole document on each state call (about 10 ms on the Word fixture);
// now they read the blocks changed since the last call only (rule 6: no state may slow a keystroke).
test('the note and table of contents states stay quick on the Word fixture after a keystroke',
  { skip: (!fs.existsSync(WASM) || !fs.existsSync(FIXTURE)) && 'no built engine or no fixture' }, async () => {
    initSync({ module: fs.readFileSync(WASM) });
    await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
    const e = new Engine();
    e.open(new Uint8Array(fs.readFileSync(FIXTURE)), 'docx');
    const ids = JSON.stringify(['references.nextFootnote', 'references.nextEndnote', 'references.showNote', 'references.updateToc', 'references.removeToc']);
    const first = JSON.parse(e.state(ids));
    const times = [];
    for (let i = 0; i < 15; i++) {
      e.exec('text.insert', JSON.stringify({ text: 'x' }));
      // Laid out first, as the worker does before the page's state call follows the layout event.
      e.surfaces();
      const t0 = performance.now();
      e.state(ids);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    // Printed, not asserted: npm test runs every file at once, so its 3 ms gate is the harness case agent-guards's now.
    console.log(`note [engine-gaps-page] the five states after a keystroke on the fixture: ${median.toFixed(2)} ms at the median`);
    assert.equal(typeof first['references.nextFootnote']?.enabled, 'boolean');
    e.free();
  });

test("the DOM editor's page break in a cell splits the table above the caret's row, as the canvas engine's does", async () => {
  const { getSchema } = await import('@tiptap/core');
  const { EditorState, TextSelection } = await import('@tiptap/pm/state');
  const { documentExtensions } = await import('../src/document/schema.js');
  const { splitTable } = await import('../src/document/wp/table-tools/ops.js');
  const schema = getSchema(documentExtensions(50));
  const cell = (text) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'table', content: ['ab', 'cd', 'ef'].map((r) => ({ type: 'tableRow', content: [cell(r[0]), cell(r[1])] })) }] });
  const at = (text) => {
    let pos = null;
    doc.descendants((n, p) => { if (pos == null && n.isText && n.text === text) pos = p; });
    return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  };
  const shape = (d) => { const out = []; d.forEach((n) => out.push(n.type.name === 'table' ? `table:${n.childCount}` : n.type.name)); return out.join(' '); };
  const tr = splitTable(at('d'), schema.nodes.pageBreak.create());
  assert.equal(shape(tr.doc), 'table:1 pageBreak table:2');
  assert.equal(tr.selection.$from.parent.textContent, 'd', 'the caret stays in its cell');
  assert.equal(shape(splitTable(at('a'), schema.nodes.pageBreak.create()).doc), 'pageBreak table:3', 'in the first row the break goes before the table');
});

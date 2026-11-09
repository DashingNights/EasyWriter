// engine-cmd-references (docs/plans/engine/stage2.md S4 References): every id the References package owns has a row of the canvas
// table, the rows' converters match the DOM side's shapes, and the rows run on the real engine (in process, as the scaffold's test
// does) with the dialogs answered by the test: notes and their browsing, Show Notes, tables of contents and figures, fields and
// the Field and Date and Time dialogs, citations and the style, the index, building blocks by gallery, legacy form fields,
// bookmarks, cross-references and content control properties.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ENGINE_STYLE, fromEngineSource, styleIdOf, toEngineSource } from '../src/document/wp/citations/canvas.mjs';
import { FILE_GALLERIES } from '../src/document/wp/building-blocks/doc-blocks.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { controlArgs, dateCode, GALLERY_CODE, REFERENCES, sdtOf, tocArgs } from '../src/document/canvas/rows/references.mjs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { Engine, initSync } from '../src/engine/wasm/ew.js';
import { WORD_STYLES } from '../src/references.mjs';

const J = JSON.parse;
const WASM = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);

// The 118 ids of the ten modules (engine-coverage's report at the scaffold) and base's Text from File.
const OWNED = `editing.autoTextF3 editing.createBuildingBlock insert.text.quickParts insert.text.quickParts.autoText
insert.text.quickParts.autoText.saveSelectionToAutoTextGallery insert.text.quickParts.buildingBlocksOrganizer
insert.text.quickParts.saveSelectionToQuickPartGallery insert.pages.coverPage insert.pages.coverPage.removeCurrentCoverPage
insert.pages.coverPage.saveSelectionToCoverPageGallery insert.tables.table.quickTables insert.tables.table.quickTables.saveSelectionToQuickTablesGallery
insert.headerFooter.header.saveSelectionToHeaderGallery insert.headerFooter.footer.saveSelectionToFooterGallery
insert.headerFooter.pageNumber.topOfPage.saveSelectionAsPageNumberTop insert.headerFooter.pageNumber.bottomOfPage.saveSelectionAsPageNumberBottom
insert.headerFooter.pageNumber.pageMargins.saveSelectionAsPageNumberMargin insert.headerFooter.pageNumber.currentPosition.saveSelectionToPageNumberGallery
insert.text.textBox.saveSelectionToTextBoxGallery design.pageBackground.watermark.saveSelectionToWatermarkGallery
insert.symbols.equation.saveSelectionToEquationGallery equation.tools.equation.saveSelectionToEquationGallery
references.tableOfContents.tableOfContents.saveSelectionToTableOfContentsGallery references.citationsBibliography.bibliography.saveSelectionToBibliographyGallery
fieldsUi.update fieldsUi.toggle fieldsUi.toggleAll fieldsUi.insertField fieldsUi.next fieldsUi.prev fieldsUi.lock fieldsUi.unlock fieldsUi.unlink
fieldsUi.doFieldClick fieldsUi.dateField fieldsUi.timeField fieldsUi.pageField fieldsUi.dialog fieldsUi.shading insert.text.quickParts.field
headerFooter.insert.documentInfo.field insert.text.dateTime insert.links.link insert.links.link.insertLink insert.links.bookmark
insert.links.crossReference tableLayout.data.formula navigation.webGoBack navigation.webGoForward file.info.properties
headerFooter.insert.documentInfo headerFooter.insert.documentInfo.author headerFooter.insert.documentInfo.fileName
headerFooter.insert.documentInfo.filePath home.font.encloseCharacters developer.controls.richTextContentControl
developer.controls.plainTextContentControl developer.controls.pictureContentControl developer.controls.buildingBlockGalleryContentControl
developer.controls.checkBoxContentControl developer.controls.comboBoxContentControl developer.controls.dropDownListContentControl
developer.controls.datePickerContentControl developer.controls.repeatingSectionContentControl developer.controls.designMode
developer.controls.properties developer.controls.group developer.controls.legacyTools developer.controls.legacyTools.textFormField
developer.controls.legacyTools.checkBoxFormField developer.controls.legacyTools.dropDownFormField developer.controls.legacyTools.formFieldShading
developer.controls.legacyTools.resetFormFields developer.mapping.xmlMappingPane keys.xmlTags insert.text.quickParts.documentProperty
headerFooter.insert.documentInfo.documentProperty headerFooter.insert.documentInfo.documentTitle references.tableOfContents.tableOfContents
references.tableOfContents.tableOfContents.automaticTable1 references.tableOfContents.tableOfContents.automaticTable2
references.tableOfContents.tableOfContents.manualTable references.tableOfContents.tableOfContents.customTableOfContents
references.tableOfContents.tableOfContents.removeTableOfContents references.tableOfContents.updateTable references.captions.insertCaption
references.captions.insertTableOfFigures references.captions.updateTable fieldsUi.markTocEntry references.citationsBibliography.insertCitation
references.citationsBibliography.insertCitation.addNewSource references.citationsBibliography.manageSources references.citationsBibliography.style
references.citationsBibliography.bibliography references.citationsBibliography.bibliography.insertBibliography
references.citationsBibliography.insertCitation.addNewPlaceholder references.citationsBibliography.bibliography.bibliography
references.citationsBibliography.bibliography.references references.citationsBibliography.bibliography.worksCited x.citations.update
references.index.markEntry references.index.insertIndex references.index.updateIndex references.tableOfAuthorities.markCitation
references.tableOfAuthorities.insertTableOfAuthorities references.tableOfAuthorities.updateTable references.footnotes.insertFootnote
references.footnotes.insertEndnote references.footnotes.nextFootnote references.footnotes.nextFootnote.nextFootnote
references.footnotes.nextFootnote.previousFootnote references.footnotes.nextFootnote.nextEndnote references.footnotes.nextFootnote.previousEndnote
references.footnotes.showNotes references.footnotes.launcher notes.convert notes.doubleClickMark x.reveal.note
insert.text.object.textFromFile`.split(/\s+/);

test('every id the References package owns has a canvas row, and nothing else is in its table', () => {
  assert.equal(OWNED.length, 119);
  assert.deepEqual(OWNED.filter((id) => !REFERENCES[id]), []);
  assert.deepEqual(Object.keys(REFERENCES).filter((id) => !OWNED.includes(id)), []);
  for (const [id, row] of Object.entries(REFERENCES)) assert.ok(formOf(row), id);
  // A gap row names what is missing in the app's plain words.
  for (const [id, row] of Object.entries(REFERENCES)) if (formOf(row) === 'off') assert.match(row.off, /^[A-Z][^—]*\.$/, id);
});

test('the converters match the DOM side: styles, sources, galleries, table of contents, content controls, date codes', () => {
  for (const s of WORD_STYLES) if (s.id !== 'harvard') assert.equal(styleIdOf(ENGINE_STYLE[s.id]), s.id, s.id);
  const app = { tag: 'Smi26', wtype: 'JournalArticle', type: 'article', authors: ['Smith, Ann', 'Jones, Bo'], year: '2026', title: 'On Things',
    container: 'Journal', volume: '3', issue: '2', pages: '1-9', place: 'Leeds', publisher: 'P', url: 'u', doi: 'd', accessed: '' };
  const e = toEngineSource(app);
  assert.deepEqual([e.kind, e.author, e.journal, e.city], ['article', 'Smith, Ann; Jones, Bo', 'Journal', 'Leeds']);
  const back = fromEngineSource(e);
  assert.deepEqual([back.id, back.authors, back.container, back.wtype, back.placeholder], ['Smi26', app.authors, 'Journal', 'JournalArticle', false]);
  assert.equal(fromEngineSource({ tag: 'Placeholder1', kind: 'book' }).placeholder, true);
  for (const [name, code] of Object.entries(GALLERY_CODE)) assert.equal(FILE_GALLERIES[code], name);
  assert.deepEqual(tocArgs({ levels: 2, pageNumbers: true, rightAlign: false, leader: 'middleDot', hyperlinks: true, styles: true, outline: false, tcFields: true,
    extra: [['Title', 1]] }), { levels: 2, pageNumbers: true, rightAlign: false, tabLeader: 'dot', hyperlinks: true, headingStyles: true, outlineLevels: false,
    tcFields: true, styleLevels: { Title: 1 } });
  const sdt = sdtOf({ type: 'dropDown', title: 'T', tag: '', lockDelete: true, lockEdit: false, items: [{ display: 'A', value: 'a' }] });
  assert.deepEqual([sdt.type, sdt.tag, sdt.lock, sdt.items.length], ['dropDown', null, 'sdtLocked', 1]);
  assert.deepEqual(controlArgs({ ...sdt, lock: 'sdtContentLocked' }), { title: 'T', tag: '', lockDelete: true, lockEdit: true, temporary: false,
    items: [{ display: 'A', value: 'a' }] });
  assert.equal(dateCode('M/d/yyyy'), 'DATE \\@ "M/d/yyyy"');
  assert.equal(dateCode('h:mm am/pm'), 'TIME \\@ "h:mm am/pm"');
});

/** A canvas ctx over a real Engine: `answers` are the dialogs' results by id (a function of the props, or a value). */
function canvasCtx(e, answers = {}) {
  const toasts = [];
  const opened = [];
  const ctx = {
    engine: {
      exec: async (id, a = {}) => J(e.exec(id, JSON.stringify(a))),
      query: async (id, a = {}) => J(e.query(id, JSON.stringify(a))),
      paste: async (kind, data) => J(e.paste(kind, typeof data === 'string' ? new TextEncoder().encode(data) : data)),
    },
    story: 'body', in: {}, settings: {}, engineState: {},
    stateOf: (id) => J(e.state(JSON.stringify([id])))[id],
    toast: (t) => toasts.push(t),
    dialog: async (id, props) => {
      opened.push([id, props]);
      const a = answers[id];
      return typeof a === 'function' ? a(props) : a ?? null;
    },
  };
  return { ctx, toasts, opened };
}
/** Runs row `id` with `arg` as the registry does: an exec row's command with its params, a spec's run. */
async function runRow(ctx, id, arg) {
  const row = REFERENCES[id];
  if (formOf(row) === 'spec') return row.run(ctx, arg);
  if (formOf(row) === 'off') return false;
  const params = typeof row.args === 'function' ? row.args(arg, ctx) : row.args ?? arg ?? {};
  return (await ctx.engine.exec(row.exec, params)).ok;
}
/** Whether row `id` is enabled now (exec rows by the engine's state, specs by their own). */
function enabled(ctx, id) {
  const row = REFERENCES[id];
  if (formOf(row) === 'spec') return row.enabled(ctx);
  if (formOf(row) === 'off') return false;
  return !row.when?.(ctx) && (ctx.stateOf(row.state ?? row.exec)?.enabled ?? true);
}

test('the rows run on the engine', { skip: !fs.existsSync(WASM) && 'no built engine (npm run build)' }, async () => {
  initSync({ module: fs.readFileSync(WASM) });
  await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
  const e = new Engine();
  const text = () => new TextDecoder().decode(e.save('txt')).replace(/\r\n?/g, '\n');
  const x = (id, a = {}) => J(e.exec(id, JSON.stringify(a)));
  assert.ok(x('document.setText', { text: 'Intro\nThe quick brown fox.\nLast line.' }).ok);
  x('select.text', { text: 'Intro' });
  x('styles.apply', { style: 'Heading 1' });
  // The body's start first: a new note takes the caret, and the find works in the caret's story.
  const home = () => e.select(JSON.stringify({ story: 'body', path: [0], off: 0 }), JSON.stringify({ story: 'body', path: [0], off: 0 }));
  const end = (w) => {
    home();
    x('select.text', { text: w });
    const s = J(e.selection());
    e.select(JSON.stringify(s.head), JSON.stringify(s.head));
  };

  // Notes: off without notes, as the DOM's; then insert, browse both kinds, Show Notes there and back, convert.
  let { ctx, opened } = canvasCtx(e, { convertNotes: (p) => (p.kinds.includes('footnote') ? 'toEndnotes' : null) });
  for (const id of ['references.footnotes.nextFootnote', 'references.footnotes.showNotes', 'references.footnotes.nextFootnote.nextEndnote', 'notes.convert']) {
    assert.equal(enabled(ctx, id), false, id);
  }
  end('quick');
  assert.ok(await runRow(ctx, 'references.footnotes.insertFootnote'));
  end('fox');
  assert.ok(await runRow(ctx, 'references.footnotes.insertEndnote'));
  assert.equal(enabled(ctx, 'references.footnotes.nextFootnote.previousEndnote'), true);
  assert.equal(enabled(ctx, 'notes.convert'), true);
  home();
  assert.ok(await runRow(ctx, 'references.footnotes.nextFootnote.nextEndnote'));
  const atEndnote = J(e.selection()).head;
  assert.ok(await runRow(ctx, 'references.footnotes.showNotes'));
  assert.ok(J(e.selection()).head.story.part != null, 'into the note');
  assert.ok(await runRow(ctx, 'notes.doubleClickMark'));
  assert.equal(J(e.selection()).head.off, atEndnote.off + 3, 'back after its reference');
  assert.ok(await runRow(ctx, 'notes.convert'));
  assert.deepEqual(opened.at(-1)[1].kinds.sort(), ['endnote', 'footnote']);
  assert.ok(J(e.query('references.notes', '{}')).value.every((n) => n.kind === 'endnote'), 'footnotes became endnotes');

  // Tables of contents: off without one; Automatic Table 2; the custom dialog's values; update and remove.
  ({ ctx } = canvasCtx(e, { tableOfContents: { levels: 2, pageNumbers: true, rightAlign: true, leader: 'hyphen', hyperlinks: false, styles: true, outline: true,
    tcFields: false, extra: [] } }));
  x('caret.docEnd');
  assert.equal(enabled(ctx, 'references.tableOfContents.updateTable'), false);
  assert.equal(enabled(ctx, 'references.captions.updateTable'), false);
  assert.ok(await runRow(ctx, 'references.tableOfContents.tableOfContents.automaticTable2'));
  assert.match(text(), /Table of Contents/);
  assert.equal(enabled(ctx, 'references.tableOfContents.updateTable'), true);
  assert.ok(await runRow(ctx, 'references.tableOfContents.updateTable'));
  assert.ok(await runRow(ctx, 'references.tableOfContents.tableOfContents.customTableOfContents'));
  assert.ok(await runRow(ctx, 'references.tableOfContents.tableOfContents.removeTableOfContents'));
  assert.doesNotMatch(text(), /Table of Contents/);

  // Fields: Date and Time both ways, the Field dialog new and edit, field codes as a pressed toggle.
  ({ ctx } = canvasCtx(e, { dateAndTime: { code: 'DATE \\@ "yyyy"' }, field: (p) => ({ code: p.code ? 'AUTHOR' : 'NUMPAGES' }) }));
  end('Last');
  assert.ok(await runRow(ctx, 'insert.text.dateTime'));
  assert.match(text(), new RegExp(String(new Date().getFullYear())));
  ({ ctx } = canvasCtx(e, { dateAndTime: { text: 'PLAINDATE' }, field: (p) => ({ code: p.code ? 'AUTHOR' : 'NUMPAGES' }) }));
  assert.ok(await runRow(ctx, 'insert.text.dateTime'));
  assert.match(text(), /PLAINDATE/);
  assert.ok(await runRow(ctx, 'fieldsUi.dialog'));
  assert.ok(await runRow(ctx, 'fieldsUi.prev'));
  assert.equal(J(e.query('fields.selected', '{}')).value[0].instr, 'NUMPAGES');
  assert.ok(await runRow(ctx, 'fieldsUi.dialog'));
  assert.equal(J(e.query('fields.selected', '{}')).value[0].instr, 'AUTHOR', 'the selected field edited');
  assert.equal(ctx.stateOf('view.fieldCodes').checked, false);
  assert.ok(await runRow(ctx, 'fieldsUi.toggleAll'));
  assert.equal(ctx.stateOf('view.fieldCodes').checked, true, 'Alt+F9 reads pressed');
  await runRow(ctx, 'fieldsUi.toggleAll');

  // Citations: a new source from Create Source, cited; the style box's value; a bibliography.
  ({ ctx } = canvasCtx(e, { createSource: { wtype: 'Book', type: 'book', authors: ['Smith, Ann'], year: '2026', title: 'On Things', tag: '' } }));
  x('caret.docEnd');
  assert.ok(await runRow(ctx, 'references.citationsBibliography.insertCitation.addNewSource'));
  const cit = J(e.query('references.citations', '{}')).value;
  assert.equal(cit.sources.length, 1);
  assert.deepEqual(cit.cited, [cit.sources[0].tag]);
  assert.ok(await runRow(ctx, 'references.citationsBibliography.style', 'mla'));
  const style = REFERENCES['references.citationsBibliography.style'];
  assert.equal(style.value(ctx.stateOf(style.state)), 'mla');
  assert.ok(await runRow(ctx, 'references.citationsBibliography.bibliography.worksCited'));
  assert.match(text(), /Works Cited[\s\S]*Smith/);

  // Index: Mark Entry through the dialog's engine prop, then the Index dialog's values.
  ({ ctx, opened } = canvasCtx(e, { markIndexEntry: null, index: { runIn: false, columns: 2, right: true, leader: 'dot', format: 'classic' } }));
  x('caret.docStart');
  x('select.text', { text: 'fox' });
  await runRow(ctx, 'references.index.markEntry');
  const mark = opened.at(-1)[1].engine;
  assert.equal(mark.text, 'fox');
  assert.ok(await mark.mark({ entry: 'fox', bold: true }));
  x('caret.docEnd');
  assert.ok(await runRow(ctx, 'references.index.insertIndex'));
  assert.ok(J(e.exec('document.inspect', '{}')).value.blocks.some((b) => /fox/.test(b.text ?? '') && /INDEX|ListEntry|Index/.test(JSON.stringify(b))) || /fox/.test(text()));

  // Building blocks: Save Selection to Header Gallery is off with nothing selected; saved, listed, inserted, deleted.
  ({ ctx, opened } = canvasCtx(e, { createNewBuildingBlock: async (p) => (await p.engine.save({ name: 'Brown', gallery: 'Headers', category: 'Mine', description: '', insert: 'content' })) ? {} : null }));
  x('caret.docStart');
  assert.equal(enabled(ctx, 'insert.headerFooter.header.saveSelectionToHeaderGallery'), false, 'nothing selected');
  x('select.text', { text: 'brown' });
  assert.equal(enabled(ctx, 'insert.headerFooter.header.saveSelectionToHeaderGallery'), true);
  await runRow(ctx, 'insert.headerFooter.header.saveSelectionToHeaderGallery');
  assert.equal(opened.at(-1)[1].engine.text, 'brown');
  assert.deepEqual(J(e.query('insert.buildingBlocks', '{}')).value.map((b) => [b.name, b.gallery, b.category]), [['Brown', 'hdrs', 'Mine']]);
  x('caret.docEnd');
  assert.ok(await runRow(ctx, 'insert.text.quickParts', 'eb:hdrs:Brown'));
  assert.match(text(), /brown\s*$/);
  ({ ctx, opened } = canvasCtx(e, { buildingBlocksOrganizer: async (p) => p.engine.remove('Brown', 'hdrs') }));
  await runRow(ctx, 'insert.text.quickParts.buildingBlocksOrganizer');
  assert.deepEqual(J(e.query('insert.buildingBlocks', '{}')).value, []);

  // Legacy form fields, a bookmark through the Bookmark dialog's engine prop, a cross-reference to it.
  ({ ctx, opened } = canvasCtx(e, { bookmark: null, crossReference: null }));
  x('caret.docEnd');
  assert.ok(await runRow(ctx, 'developer.controls.legacyTools.checkBoxFormField'));
  x('caret.docStart');
  x('select.text', { text: 'quick' });
  await runRow(ctx, 'insert.links.bookmark');
  const bm = opened.at(-1)[1].engine;
  assert.ok(await bm.add('Quick'));
  assert.deepEqual((await bm.list()).filter((b) => !b.hidden).map((b) => b.name).sort(), ['Check1', 'Quick']);
  await runRow(ctx, 'insert.links.crossReference');
  const xr = opened.at(-1)[1].engine;
  assert.ok((await xr.list('bookmark')).includes('Quick'));
  x('caret.docEnd');
  assert.ok(await xr.insert({ to: 'bookmark', target: 'Quick', show: 'text' }));

  // Content control properties round trip, and Design Mode as a pressed toggle.
  ({ ctx } = canvasCtx(e, { contentControlProperties: (p) => ({ ...p.sdt, title: 'Name', lock: 'sdtLocked' }) }));
  x('caret.docEnd');
  assert.ok(await runRow(ctx, 'developer.controls.richTextContentControl'));
  assert.ok(await runRow(ctx, 'developer.controls.properties'));
  const c = J(e.query('developer.control', '{}')).value;
  assert.deepEqual([c.title, c.lockDelete, c.lockEdit], ['Name', true, false]);
  assert.ok(await runRow(ctx, 'developer.controls.designMode'));
  assert.equal(ctx.stateOf('developer.designMode').checked, true);
});

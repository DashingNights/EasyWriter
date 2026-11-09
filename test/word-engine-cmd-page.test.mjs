// engine-cmd-page (docs/plans/engine/stage2.md S3 Page and Tables): every tooling id of the package's modules has a row on a canvas
// draft, and the rows translate the controls' arguments into the engine's params. The ids are the ones engine-coverage listed on
// the generic reason before the package (sections, columns, page-background, layout-misc, headers-footers, design, ruler, the
// three table modules and base's page break, table and Layout > Paragraph rows).
//   node --test test/word-engine-cmd-page.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { PAGE } from '../src/document/canvas/rows/page.mjs';

const IDS = {
  'sections': [
    'layout.pageSetup.margins', 'layout.pageSetup.margins.normalMargins', 'layout.pageSetup.margins.narrowMargins',
    'layout.pageSetup.margins.moderateMargins', 'layout.pageSetup.margins.wideMargins', 'layout.pageSetup.margins.customMargins',
    'layout.pageSetup.orientation', 'layout.pageSetup.orientation.portrait', 'layout.pageSetup.orientation.landscape',
    'layout.pageSetup.size', 'layout.pageSetup.size.morePaperSizes', 'layout.pageSetup.breaks', 'layout.pageSetup.launcher',
    'layout.pageSetup.margins.mirroredMargins', 'layout.pageSetup.breaks.nextPage', 'layout.pageSetup.breaks.continuous',
    'layout.pageSetup.breaks.evenPage', 'layout.pageSetup.breaks.oddPage', 'insert.pages.blankPage',
    'layout.pageSetup.textDirection', 'layout.pageSetup.textDirection.horizontal',
    'layout.pageSetup.textDirection.textDirectionOptions',
  ],
  'columns': [
    'layout.pageSetup.columns', 'layout.pageSetup.columns.one', 'layout.pageSetup.columns.two', 'layout.pageSetup.columns.three',
    'layout.pageSetup.columns.left', 'layout.pageSetup.columns.right', 'layout.pageSetup.columns.moreColumns',
    'layout.pageSetup.breaks.column',
  ],
  'page-background': [
    'design.pageBackground.watermark', 'design.pageBackground.watermark.customWatermark',
    'design.pageBackground.watermark.removeWatermark', 'design.pageBackground.pageColor',
    'design.pageBackground.pageColor.moreColors', 'design.pageBackground.pageColor.fillEffects',
    'design.pageBackground.pageBorders', 'draw.edit.formatBackground.none', 'draw.edit.formatBackground.narrowRuled',
    'draw.edit.formatBackground.collegeRuled', 'draw.edit.formatBackground.standardRuled', 'draw.edit.formatBackground.wideRuled',
    'draw.edit.formatBackground.smallGrid', 'draw.edit.formatBackground.mediumGrid', 'draw.edit.formatBackground.largeGrid',
    'draw.edit.formatBackground.veryLargeGrid', 'draw.edit.formatBackground.applyToFullPage',
    'draw.edit.formatBackground.pageColor', 'draw.edit.formatBackground.pageColor.moreColors',
    'draw.edit.formatBackground.pageColor.fillEffects',
  ],
  'layout-misc': [
    'layout.pageSetup.lineNumbers', 'layout.pageSetup.lineNumbers.none', 'layout.pageSetup.lineNumbers.continuous',
    'layout.pageSetup.lineNumbers.restartEachPage', 'layout.pageSetup.lineNumbers.restartEachSection',
    'layout.pageSetup.lineNumbers.suppressForCurrentParagraph', 'layout.pageSetup.lineNumbers.lineNumberingOptions',
    'paragraph.suppressLineNumbers', 'layout.pageSetup.hyphenation', 'layout.pageSetup.hyphenation.none',
    'layout.pageSetup.hyphenation.automatic', 'layout.pageSetup.hyphenation.manual',
    'layout.pageSetup.hyphenation.hyphenationOptions', 'paragraph.dontHyphenate', 'chars.optionalHyphen', 'insert.text.dropCap',
    'insert.text.dropCap.none', 'insert.text.dropCap.dropped', 'insert.text.dropCap.inMargin',
    'insert.text.dropCap.dropCapOptions',
  ],
  'headers-footers': [
    'insert.headerFooter.pageNumber', 'insert.headerFooter.pageNumber.topOfPage', 'insert.headerFooter.pageNumber.bottomOfPage',
    'insert.headerFooter.pageNumber.removePageNumbers', 'insert.headerFooter.header', 'insert.headerFooter.footer',
    'insert.headerFooter.header.editHeader', 'insert.headerFooter.footer.editFooter', 'insert.headerFooter.header.removeHeader',
    'insert.headerFooter.footer.removeFooter', 'insert.headerFooter.pageNumber.pageMargins',
    'insert.headerFooter.pageNumber.currentPosition', 'insert.headerFooter.pageNumber.formatPageNumbers',
    'headerFooter.navigation.goToHeader', 'headerFooter.navigation.goToFooter', 'headerFooter.navigation.previous',
    'headerFooter.navigation.next', 'headerFooter.navigation.linkToPrevious', 'headerFooter.options.differentFirstPage',
    'headerFooter.options.differentOddEvenPages', 'headerFooter.options.showDocumentText',
    'headerFooter.position.headerPositionFromTop', 'headerFooter.position.headerPositionFromTop.more',
    'headerFooter.position.headerPositionFromTop.less', 'headerFooter.position.footerPositionFromBottom',
    'headerFooter.position.footerPositionFromBottom.more', 'headerFooter.position.footerPositionFromBottom.less',
    'headerFooter.close.closeHeaderAndFooter', 'headersFooters.copyPrevious', 'x.headersFooters.pageNumber', 'x.reveal.header',
    'x.reveal.footer',
  ],
  'design': [
    'design.documentFormatting.themes', 'design.documentFormatting.themes.resetToThemeFromTemplate',
    'design.documentFormatting.themes.browseForThemes', 'design.documentFormatting.themes.saveCurrentTheme',
    'design.documentFormatting.colors', 'design.documentFormatting.colors.customizeColors', 'design.documentFormatting.fonts',
    'design.documentFormatting.fonts.customizeFonts', 'design.documentFormatting.effects',
    'design.documentFormatting.documentFormatting', 'design.documentFormatting.documentFormatting.resetToTheDefaultStyleSet',
    'design.documentFormatting.documentFormatting.saveAsANewStyleSet', 'design.documentFormatting.paragraphSpacing.default',
    'design.documentFormatting.paragraphSpacing.noParagraphSpace', 'design.documentFormatting.paragraphSpacing.compact',
    'design.documentFormatting.paragraphSpacing.tight', 'design.documentFormatting.paragraphSpacing.open',
    'design.documentFormatting.paragraphSpacing.relaxed', 'design.documentFormatting.paragraphSpacing.double',
    'design.documentFormatting.paragraphSpacing.customParagraphSpacing', 'design.documentFormatting.setAsDefault',
    'developer.templates.documentTemplate',
  ],
  'ruler': [
    'view.show.ruler', 'ruler.keyboardRuler',
  ],
  'table-tools': [
    'insert.tables.table.insertTable', 'insert.tables.table.convertTextToTable', 'insert.tables.table.drawTable',
    'tableLayout.draw.drawTable', 'tableLayout.draw.eraser', 'tableDesign.borders.borderPainter', 'tables.cellNavigation',
    'tables.endOfRow', 'tables.startOfColumn', 'tables.endOfColumn', 'tables.moveRow', 'tables.splitTableKey',
    'tables.updateAutoFormat', 'tables.selectTable',
  ],
  'table-design': [
    'tableDesign.tableStyleOptions.headerRow', 'tableDesign.tableStyleOptions.totalRow',
    'tableDesign.tableStyleOptions.bandedRows', 'tableDesign.tableStyleOptions.firstColumn',
    'tableDesign.tableStyleOptions.lastColumn', 'tableDesign.tableStyleOptions.bandedColumns',
    'tableDesign.tableStyles.tableStyles', 'tableDesign.tableStyles.tableStyles.clear',
    'tableDesign.tableStyles.tableStyles.modifyTableStyle', 'tableDesign.tableStyles.tableStyles.newTableStyle',
    'tableDesign.tableStyles.shading.moreColors', 'tableDesign.borders.borderStyles',
    'tableDesign.borders.borderStyles.borderSampler', 'tableDesign.borders.penStyle', 'tableDesign.borders.penWeight',
    'tableDesign.borders.penColor', 'tableDesign.borders.penColor.moreColors',
  ],
  'table-layout': [
    'tableLayout.merge.splitCells', 'tableLayout.table.select.selectCell', 'tableLayout.table.select.selectRow',
    'tableLayout.table.select.selectColumn', 'tableLayout.table.select.selectTable', 'tableLayout.table.viewGridlines',
    'tableLayout.table.properties', 'tableLayout.rowsColumns.delete.deleteCells', 'tableLayout.rowsColumns.launcher',
    'tableLayout.merge.splitTable', 'tableLayout.cellSize.autoFit.autoFitContents', 'tableLayout.cellSize.autoFit.autoFitWindow',
    'tableLayout.cellSize.autoFit.fixedColumnWidth', 'tableLayout.cellSize.tableRowHeight',
    'tableLayout.cellSize.tableRowHeight.more', 'tableLayout.cellSize.tableRowHeight.less',
    'tableLayout.cellSize.tableColumnWidth', 'tableLayout.cellSize.tableColumnWidth.more',
    'tableLayout.cellSize.tableColumnWidth.less', 'tableLayout.cellSize.distributeRows', 'tableLayout.cellSize.distributeColumns',
    'tableLayout.alignment.textDirection', 'tableLayout.alignment.cellMargins', 'home.paragraph.sort',
    'tableLayout.data.repeatHeaderRows', 'tableLayout.data.convertToText',
  ],
  'base': [
    'insert.pages.pageBreak', 'layout.pageSetup.breaks.page', 'tableLayout.rowsColumns.insertRowAbove',
    'tableLayout.rowsColumns.insertRowBelow', 'tableLayout.rowsColumns.insertColumnLeft',
    'tableLayout.rowsColumns.insertColumnRight', 'tableLayout.rowsColumns.delete.deleteRows',
    'tableLayout.rowsColumns.delete.deleteColumns', 'tableLayout.rowsColumns.delete.deleteTable', 'tableLayout.merge.mergeCells',
    'insert.tables.table', 'layout.paragraph.indentLeft', 'layout.paragraph.indentLeft.more', 'layout.paragraph.indentLeft.less',
    'layout.paragraph.indentRight', 'layout.paragraph.indentRight.more', 'layout.paragraph.indentRight.less',
    'layout.paragraph.spacingBefore', 'layout.paragraph.spacingBefore.more', 'layout.paragraph.spacingBefore.less',
    'layout.paragraph.spacingAfter', 'layout.paragraph.spacingAfter.more', 'layout.paragraph.spacingAfter.less',
    'tableLayout.alignment.alignTopLeft', 'tableLayout.alignment.alignTopCenter', 'tableLayout.alignment.alignTopRight',
    'tableLayout.alignment.alignCenterLeft', 'tableLayout.alignment.alignCenter', 'tableLayout.alignment.alignCenterRight',
    'tableLayout.alignment.alignBottomLeft', 'tableLayout.alignment.alignBottomCenter', 'tableLayout.alignment.alignBottomRight',
    'tableDesign.tableStyles.shading',
  ],
};

const ctx = (state = {}, more = {}) => ({ engineState: state, settings: {}, profile: null, ...more });
const params = (id, arg, c = ctx()) => {
  const row = PAGE[id];
  return typeof row.args === 'function' ? row.args(arg, c) : row.args;
};

test('every id of the package has a row in one of the forms', () => {
  const missing = Object.values(IDS).flat().filter((id) => !(id in PAGE));
  assert.deepEqual(missing, []);
  for (const [id, row] of Object.entries(PAGE)) assert.ok(formOf(row), `${id} has a row form`);
  assert.equal(Object.values(IDS).flat().length, 216);
});

test('menus and galleries translate their picks', () => {
  assert.deepEqual(params('layout.pageSetup.margins', 'narrowMargins'), { top: 36, bottom: 36, left: 36, right: 36, mirror: false });
  assert.equal(params('layout.pageSetup.margins.mirroredMargins').mirror, true);
  assert.equal(PAGE['layout.pageSetup.margins'].value({ value: { top: 36, bottom: 36, left: 36, right: 36, mirror: false } }, ctx()), 'narrowMargins');
  assert.deepEqual(params('layout.pageSetup.size', 'a4'), { width: 595.3, height: 841.9 });
  assert.equal(PAGE['layout.pageSetup.size'].value({ value: { width: 841.9, height: 595.3 } }), 'a4', 'either way round');
  assert.deepEqual(params('layout.pageSetup.columns', 'left'), { count: 2, preset: 'left' });
  assert.deepEqual(params('design.pageBackground.watermark', 'draft2'), { text: 'DRAFT', diagonal: false, color: 'C0C0C0', semitransparent: true });
  assert.equal(PAGE['design.pageBackground.watermark'].value({ value: { text: 'DRAFT', diagonal: true } }), 'draft1');
  assert.deepEqual(params('design.pageBackground.pageColor', { color: '#ff8800', themeColor: null }), { color: 'FF8800' });
  assert.deepEqual(params('design.pageBackground.pageColor', { color: null }), { color: null }, 'No Color');
  assert.deepEqual(params('layout.pageSetup.lineNumbers', 'restartEachPage'), { value: 'restartPage' });
  assert.deepEqual(params('insert.headerFooter.header', 'blankThreeColumns'), { preset: 'blankThree' });
  assert.deepEqual(params('insert.headerFooter.pageNumber.bottomOfPage', 'pageXofY'), { position: 'bottom', align: 'center', format: 'x of y' });
  assert.deepEqual(params('insert.headerFooter.pageNumber.topOfPage', 'right'), { position: 'top', align: 'right' });
  assert.deepEqual(params('tableLayout.alignment.alignBottomRight'), { value: 'bottomRight' });
  assert.deepEqual(params('tableLayout.alignment.alignCenter'), { value: 'center' });
  assert.deepEqual(params('tables.endOfColumn', 'extend'), { to: 'columnBottom', extend: true });
  assert.deepEqual(params('design.documentFormatting.paragraphSpacing.noParagraphSpace'), { value: 'none' });
  const harbour = params('design.documentFormatting.themes', 'harbour');
  assert.equal(harbour.colors.length, 12);
  assert.equal(harbour.colors[4], '1F4E79', 'accent1 in the engine order');
  assert.equal(PAGE['design.documentFormatting.themes'].value({ value: 'Harbour (Soft Shadow)' }), 'harbour', 'an effect name after it');
});

test('toggles pass the value they want, read from the engine when they run (an empty snapshot too), never a bare toggle', async () => {
  const now = { 'table.repeatHeader': { checked: true }, 'layout.differentFirstPage': { checked: false },
    'table.look': { value: { bandedRows: true } }, 'layout.paragraph': { value: { suppressLineNumbers: true } } };
  const on = ctx({}, { engine: { state: async (ids) => Object.fromEntries(ids.map((id) => [id, now[id]])) } });
  assert.deepEqual(await params('tableLayout.data.repeatHeaderRows', undefined, on), { value: false });
  assert.deepEqual(await params('headerFooter.options.differentFirstPage', undefined, on), { value: true });
  assert.deepEqual(await params('tableDesign.tableStyleOptions.bandedRows', undefined, on), { bandedRows: false });
  assert.deepEqual(await params('paragraph.suppressLineNumbers', undefined, on), { props: { suppressLineNumbers: false } });
  assert.equal(await params('paragraph.dontHyphenate', undefined, ctx({}, { engine: { state: async () => ({}) } })), null, 'no state, no change');
  // A boolean argument (an agent or tool search setting it) is the value, whatever the state: true on an option already on stays on.
  assert.deepEqual(await params('tableLayout.data.repeatHeaderRows', true, on), { value: true });
  assert.deepEqual(await params('headerFooter.options.differentFirstPage', false, on), { value: false });
  assert.deepEqual(await params('tableDesign.tableStyleOptions.bandedRows', true, on), { bandedRows: true });
  assert.deepEqual(await params('paragraph.suppressLineNumbers', true, on), { props: { suppressLineNumbers: true } });
  assert.deepEqual(params('layout.pageSetup.hyphenation.automatic'), { value: true });
  assert.deepEqual(params('layout.pageSetup.hyphenation', 'none'), { value: false });
});

test('a gallery parent given no valid pick runs nothing, as the DOM rows do', () => {
  for (const id of ['layout.pageSetup.orientation', 'layout.pageSetup.columns', 'layout.pageSetup.textDirection', 'layout.pageSetup.lineNumbers',
    'layout.pageSetup.hyphenation', 'insert.text.dropCap', 'design.pageBackground.watermark', 'design.pageBackground.pageColor',
    'draw.edit.formatBackground.pageColor']) {
    assert.equal(params(id, undefined), null, id);
  }
  assert.deepEqual(params('layout.pageSetup.orientation', 'landscape'), { value: 'landscape' });
  assert.deepEqual(params('insert.text.dropCap', 'inMargin'), { position: 'margin' });
});

test('spinners step from the current value within their limits', () => {
  const c = ctx({ 'layout.paragraph': { value: { spaceBefore: 3, indentLeft: 10 } }, 'hf.position': { value: { header: 299 } } });
  assert.deepEqual(params('layout.paragraph.spacingBefore.less', undefined, c), { before: 0 }, 'never below 0');
  assert.deepEqual(params('layout.paragraph.spacingBefore.more', undefined, c), { before: 9 });
  assert.deepEqual(params('layout.paragraph.indentLeft', '72', c), { left: 72 });
  assert.deepEqual(params('headerFooter.position.headerPositionFromTop.more', undefined, c), { header: 300 }, "the engine's 300 pt clamp");
  assert.equal(PAGE['layout.paragraph.indentLeft'].value({ value: { indentLeft: 10 } }), 10);
});

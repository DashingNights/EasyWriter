// What Word writes for tables, sections, settings, document properties and comments comes back from import and export (the
// fixture's round trip, .smoke-data/word/fixture/roundtrip-check.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** A .docx of `body` (with `sect` as its final w:sectPr and `before` ahead of w:body) and the parts `parts` [[name, xml]]. */
const docx = (body, { sect = '<w:sectPr/>', parts = [], before = '' } = {}) => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${W}>${before}<w:body>${body}${sect}</w:body></w:document>`],
  ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
  ...parts,
]);
/** Imports `bytes`, exports the result → {doc, files (the exported parts as text)}. */
async function roundTrip(bytes) {
  const { doc } = await importDocx(bytes);
  const files = await readZip((await exportDocx(doc)).bytes);
  return { doc, files: Object.fromEntries([...files].map(([k, b]) => [k, text(b)])) };
}
const cell = (s, w) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${s}</w:t></w:r></w:p></w:tc>`;

test('a table keeps its floating position, Word\'s tblLook mask, exact column twips, none borders and an inserted row', async () => {
  const body = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:tblpX="2881" w:tblpY="1"/>'
    + '<w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideV w:val="nil"/></w:tblBorders>'
    + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
    + '<w:tblGrid><w:gridCol w:w="1803"/><w:gridCol w:w="1804"/></w:tblGrid>'
    + `<w:tr>${cell('a', 1803)}${cell('b', 1804)}</w:tr>`
    + `<w:tr><w:trPr><w:ins w:id="5" w:author="Kim" w:date="2026-10-29T10:00:00Z"/></w:trPr>${cell('c', 1803)}${cell('d', 1804)}</w:tr></w:tbl><w:p/>`;
  const { doc, files } = await roundTrip(await docx(body));
  const t = doc.content[0];
  assert.deepEqual(t.attrs.float, { vAnchor: 'text', x: 144.05, y: 0.05, dist: { r: 9, l: 9 } });
  assert.deepEqual(t.attrs.borders, { top: { style: 'none' }, insideV: { style: 'nil' } }, 'none and nil take the style\'s edges away');
  assert.deepEqual(t.content[0].content.map((c) => c.attrs.colwidth), [[120.2], [120.27]]);
  assert.deepEqual(t.content[1].attrs.rev, { ins: { id: '5', author: 'Kim', date: '2026-10-29T10:00:00Z' } });
  const d = files['word/document.xml'];
  assert.match(d, /<w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:tblpX="2881" w:tblpY="1"\/>/);
  assert.match(d, /<w:tblLook w:val="04A0" w:firstRow="1"/);
  assert.match(d, /<w:gridCol w:w="1803"\/><w:gridCol w:w="1804"\/>/);
  assert.match(d, /<w:tcW w:w="1804" w:type="dxa"\/>/);
  assert.match(d, /<w:tblBorders><w:top w:val="none" w:space="0" w:color="auto"\/><w:insideV w:val="nil"/);
  assert.match(d, /<w:trPr><w:ins w:id="\d+" w:author="Kim" w:date="2026-10-29T10:00:00Z"\/><\/w:trPr>/);
});

test('a section keeps its line between columns (w:cols w:sep), art page border widths in points, a grid pitch without a type and its note properties', async () => {
  const notes = '<w:footnotePr><w:pos w:val="beneathText"/><w:numFmt w:val="lowerLetter"/><w:numStart w:val="5"/><w:numRestart w:val="eachSect"/></w:footnotePr>'
    + '<w:endnotePr><w:numFmt w:val="upperRoman"/></w:endnotePr>';
  const body = '<w:p><w:r><w:t>Two columns</w:t></w:r></w:p><w:p><w:pPr><w:sectPr><w:type w:val="continuous"/><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:cols w:num="2" w:sep="1" w:space="720"/></w:sectPr></w:pPr></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p>';
  const sect = `<w:sectPr>${notes}<w:type w:val="continuous"/><w:pgSz w:w="11906" w:h="16838"/><w:pgBorders w:offsetFrom="page"><w:top w:val="apples" w:sz="20" w:space="24" w:color="auto"/>`
    + '<w:bottom w:val="single" w:sz="12" w:space="24" w:color="auto"/></w:pgBorders><w:cols w:space="708"/><w:docGrid w:linePitch="360"/><w15:footnoteColumns w:val="2"/></w:sectPr>';
  const { doc, files } = await roundTrip(await docx(body, { sect }));
  assert.equal(doc.content.find((n) => n.type === 'columns').attrs.sep, true);
  const s = doc.attrs.sect;
  assert.equal(s.pgBorders.top.width, 20, 'an art border\'s w:sz is points');
  assert.equal(s.pgBorders.bottom.width, 1.5, 'a line border\'s is eighths');
  assert.deepEqual(s.docGrid, { linePitch: 18 });
  assert.deepEqual(s.footnotePr, { pos: 'beneathText', numFmt: 'lowerLetter', numStart: 5, numRestart: 'eachSect', columns: 2 });
  assert.deepEqual(s.endnotePr, { numFmt: 'upperRoman' });
  const d = files['word/document.xml'];
  assert.match(d, /<w:cols w:num="2" w:space="720" w:sep="1"/);
  assert.match(d, /<w:top w:val="apples" w:sz="20" w:space="24" w:color="auto"\/>/);
  assert.match(d, /<w:bottom w:val="single" w:sz="12"/);
  const last = d.slice(d.lastIndexOf('<w:sectPr'));
  assert.match(last, /^<w:sectPr xmlns:w15="[^"]+" mc:Ignorable="w15"><w:footnotePr><w:pos w:val="beneathText"\/><w:numFmt w:val="lowerLetter"\/><w:numStart w:val="5"\/><w:numRestart w:val="eachSect"\/><\/w:footnotePr><w:endnotePr><w:numFmt w:val="upperRoman"\/><\/w:endnotePr><w:type/);
  assert.match(last, /<w:docGrid w:linePitch="360"\/><w15:footnoteColumns w:val="2"\/><\/w:sectPr>/);
  assert.doesNotMatch(d, /<w:pgNumType\/>/, 'a decimal page number from 1 writes no w:pgNumType');
});

test('the document settings the app holds read from settings.xml and go back in CT_Settings order', async () => {
  const settings = `<w:settings ${W} xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:writeProtection w:recommended="1"/><w:mirrorMargins/>`
    + '<w:bordersDoNotSurroundHeader/><w:alignBordersAndEdges/><w:linkStyles/><w:mailMerge><w:mainDocumentType w:val="mailingLabels"/><w:dataType w:val="textFile"/></w:mailMerge>'
    + '<w:documentProtection w:edit="forms" w:enforcement="1"/><w:styleLockTheme/><w:defaultTabStop w:val="720"/><w:autoHyphenation/><w:consecutiveHyphenLimit w:val="2"/>'
    + '<w:hyphenationZone w:val="357"/><w:doNotHyphenateCaps/><w:bookFoldPrinting/><w:bookFoldPrintingSheets w:val="12"/><w:drawingGridHorizontalSpacing w:val="120"/>'
    + '<w:displayVerticalDrawingGridEvery w:val="2"/><w:doNotUseMarginsForDrawingGridOrigin/><w:drawingGridHorizontalOrigin w:val="0"/><w:doNotShadeFormData/><w:printTwoOnOne/>'
    + '<w:endnotePr><w:pos w:val="sectEnd"/><w:endnote w:id="-1"/></w:endnotePr><w:compat><w:doNotUseHTMLParagraphAutoSpacing/></w:compat>'
    + '<w:docVars><w:docVar w:name="Client" w:val="Kim &amp; Co"/></w:docVars><m:mathPr><m:mathFont m:val="Cambria Math"/><m:smallFrac m:val="0"/><m:dispDef/>'
    + '<m:lMargin m:val="720"/><m:defJc m:val="left"/><m:wrapIndent m:val="1440"/></m:mathPr></w:settings>';
  const { doc, files } = await roundTrip(await docx('<w:p/>', { parts: [['word/settings.xml', settings]] }));
  const s = doc.attrs.settings;
  assert.deepEqual([s.writeProtection, s.mirrorMargins, s.bordersDoNotSurroundHeader, s.alignBordersAndEdges, s.linkStyles], [{ recommended: true }, true, true, true, true]);
  assert.deepEqual(s.protection, { edit: 'forms', formatting: false, enforcement: true, autoFormatOverride: false, lockTheme: true, lockQFSet: false });
  assert.deepEqual([s.defaultTabStop, s.autoHyphenation, s.consecutiveHyphenLimit, s.hyphenationZone, s.doNotHyphenateCaps], [36, true, 2, 17.85, true]);
  assert.deepEqual(s.bookFold, { sheets: 4, reverse: false }, 'Word writes 4 sheets per booklet as 12');
  assert.deepEqual(s.grid, { h: 6, useMargins: false, x: 0, everyV: 2 });
  assert.deepEqual([s.formShading, s.printTwoOnOne, s.compat.htmlAutoSpacing], [false, true, false]);
  assert.deepEqual(s.endnotePr, { pos: 'sectEnd' });
  assert.deepEqual(s.mathPr, { font: 'Cambria Math', smallFrac: false, dispDef: true, lMargin: 36, defJc: 'left', wrapIndent: 72 });
  assert.deepEqual(doc.attrs.vars, { Client: 'Kim & Co' });
  assert.deepEqual(doc.attrs.merge, { type: 'labels' });
  const x = files['word/settings.xml'];
  const order = ['writeProtection', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader', 'linkStyles', 'mailMerge', 'documentProtection', 'styleLockTheme',
    'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit', 'hyphenationZone', 'doNotHyphenateCaps', 'bookFoldPrinting', 'bookFoldPrintingSheets',
    'drawingGridHorizontalSpacing', 'displayVerticalDrawingGridEvery', 'doNotUseMarginsForDrawingGridOrigin', 'drawingGridHorizontalOrigin', 'doNotShadeFormData',
    'printTwoOnOne', 'endnotePr', 'compat', 'docVars'];
  assert.deepEqual([...x.matchAll(/<w:(\w+)/g)].map((mm) => mm[1]).filter((n) => order.includes(n)), order);
  assert.match(x, /<w:mainDocumentType w:val="mailingLabels"\/><w:dataType w:val="textFile"\/>/);
  assert.match(x, /<w:documentProtection w:edit="forms" w:enforcement="1"\/>/);
  assert.match(x, /<w:bookFoldPrintingSheets w:val="12"\/>/);
  assert.match(x, /<w:hyphenationZone w:val="357"\/>/);
  assert.match(x, /<w:docVar w:name="Client" w:val="Kim &amp; Co"\/>/);
  assert.match(x, /<m:mathPr><m:mathFont m:val="Cambria Math"\/><m:smallFrac m:val="0"\/><m:dispDef m:val="1"\/><m:lMargin m:val="720"\/><m:defJc m:val="left"\/><m:wrapIndent m:val="1440"\/><\/m:mathPr>/);
});

test('document properties: core category and status, the app properties and typed custom ones read in and write back', async () => {
  const core = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + '<dc:title>Report</dc:title><cp:category>Test document</cp:category><cp:contentStatus>Draft</cp:contentStatus></cp:coreProperties>';
  const app = '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Template>Normal.dotm</Template><Pages>3</Pages>'
    + '<Manager>Morgan</Manager><Company>Fixture &amp; Co</Company><HyperlinkBase>https://example.com/</HyperlinkBase></Properties>';
  const prop = (pid, name, v) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${pid}" name="${name}">${v}</property>`;
  const custom = '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + prop(2, 'Text', '<vt:lpwstr>Custom text</vt:lpwstr>') + prop(3, 'Number', '<vt:i4>42</vt:i4>') + prop(4, 'Float', '<vt:r8>3.25</vt:r8>')
    + prop(5, 'Date', '<vt:filetime>2026-10-29T00:00:00Z</vt:filetime>') + prop(6, 'No', '<vt:bool>false</vt:bool>') + '</Properties>';
  const { doc, files } = await roundTrip(await docx('<w:p/>', { parts: [['docProps/core.xml', core], ['docProps/app.xml', app], ['docProps/custom.xml', custom]] }));
  const p = doc.attrs.props;
  assert.deepEqual(p.core, { title: 'Report', category: 'Test document', contentStatus: 'Draft' });
  assert.deepEqual(p.app, { company: 'Fixture & Co', manager: 'Morgan', hyperlinkBase: 'https://example.com/', template: 'Normal.dotm' });
  assert.deepEqual(p.custom, [{ name: 'Text', type: 'text', value: 'Custom text' }, { name: 'Number', type: 'number', value: 42 }, { name: 'Float', type: 'number', value: 3.25 },
    { name: 'Date', type: 'date', value: '2026-10-29' }, { name: 'No', type: 'bool', value: false }]);
  assert.match(files['docProps/core.xml'], /<cp:category>Test document<\/cp:category><cp:contentStatus>Draft<\/cp:contentStatus>/);
  assert.match(files['docProps/app.xml'], /<Template>Normal.dotm<\/Template><Manager>Morgan<\/Manager><Company>Fixture &amp; Co<\/Company><HyperlinkBase>https:\/\/example.com\/<\/HyperlinkBase>/);
  const c = files['docProps/custom.xml'];
  for (const v of ['<vt:lpwstr>Custom text</vt:lpwstr>', '<vt:i4>42</vt:i4>', '<vt:r8>3.25</vt:r8>', '<vt:filetime>2026-10-29T00:00:00Z</vt:filetime>', '<vt:bool>false</vt:bool>']) assert.ok(c.includes(v), v);
  assert.match(files['_rels/.rels'], /relationships\/extended-properties" Target="docProps\/app.xml".*relationships\/custom-properties" Target="docProps\/custom.xml"/);
  assert.match(files['[Content_Types].xml'], /PartName="\/docProps\/custom.xml" ContentType="application\/vnd.openxmlformats-officedocument.custom-properties\+xml"/);
});

test('comments: commentsExtended\'s resolved state and reply threads read in; a reply has no mark of its own and goes back over its thread\'s range', async () => {
  const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
  const comment = (id, para, text) => `<w:comment w:id="${id}" w:author="Ana" w:initials="A"><w:p w14:paraId="${para}"><w:r><w:annotationRef/></w:r><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`;
  const comments = `<w:comments ${W} ${W14}>${comment(1, '762B9195', 'Should this go?')}${comment(2, '279F5266', 'Removed it.')}</w:comments>`;
  const ex = '<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:commentEx w15:paraId="762B9195" w15:done="1"/>'
    + '<w15:commentEx w15:paraId="279F5266" w15:paraIdParent="762B9195" w15:done="0"/></w15:commentsEx>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Target="commentsExtended.xml"'
    + ' Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended"/></Relationships>';
  const ref = (id) => `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
  const body = `<w:p><w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:r><w:t>thread</w:t></w:r>${ref(1)}${ref(2)}</w:p>`;
  const bytes = await writeZip([...(await readZip(await docx(body)))].filter(([n]) => n !== 'word/_rels/document.xml.rels')
    .concat([['word/_rels/document.xml.rels', rels], ['word/comments.xml', comments], ['word/commentsExtended.xml', ex]]));
  const { doc, files } = await roundTrip(bytes);
  assert.deepEqual(doc.content[0].content[0].marks, [{ type: 'comment', attrs: { id: 'c1' } }], 'only the thread marks the text');
  assert.deepEqual([doc.attrs.comments.c1.done, doc.attrs.comments.c1.parent, doc.attrs.comments.c2.done, doc.attrs.comments.c2.parent], [true, null, false, 'c1']);
  assert.match(files['word/document.xml'], /<w:commentRangeStart w:id="0"\/><w:commentRangeStart w:id="1"\/>.*thread.*<w:commentReference w:id="0"\/>.*<w:commentReference w:id="1"\/>/);
  assert.match(files['word/comments.xml'], /<w:comment w:id="1" w:author="Ana"[^>]*><w:p w14:paraId="00000002">.*Removed it/);
  assert.match(files['word/commentsExtended.xml'], /<w15:commentEx w15:paraId="00000001" w15:done="1"\/><w15:commentEx w15:paraId="00000002" w15:paraIdParent="00000001" w15:done="0"\/>/);
  assert.match(files['word/_rels/document.xml.rels'], /relationships\/commentsExtended" Target="commentsExtended.xml"/);
});

test('the page colour (w:background) reads in with its theme colour and writes back', async () => {
  const settings = `<w:settings ${W}><w:displayBackgroundShape/></w:settings>`;
  const { doc, files } = await roundTrip(await docx('<w:p/>', { before: '<w:background w:color="2F5496" w:themeColor="accent1" w:themeShade="BF"/>', parts: [['word/settings.xml', settings]] }));
  assert.deepEqual(doc.attrs.background, { color: '#2F5496', themeColor: { slot: 'accent1', lum: -0.25 }, fill: null });
  assert.equal(doc.attrs.settings.displayBackground, true);
  assert.match(files['word/document.xml'], /<w:background w:color="2F5496" w:themeColor="accent1" w:themeShade="BF"\/><w:body>/);
  assert.match(files['word/settings.xml'], /<w:displayBackgroundShape\/>/);
});

// docx-roundtrip-runs (docs/plans/word/briefs/docx-roundtrip-runs.md): what Word writes for a drawing's run, a field's result runs,
// a row's table property exceptions, a content control's end mark, a one-column section's spacing and a drawing's wrap polygon
// comes back from import and export, and a field's runs follow Word's update rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { drawnRuns, resultRuns, validRuns } from '../src/document/wp/fields-core/runs.mjs';

const { documentExtensions } = await import('../src/document/schema.js');
const { updateFields } = await import('../src/document/fields/engine.js');
const { registerField, parseField } = await import('../src/document/fields/registry.mjs');
const { fieldTypes } = await import('../src/document/wp/fields-core/types.mjs');
for (const [name, type] of Object.entries(fieldTypes(parseField))) registerField(name, type);

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const docx = (body, sect = '<w:sectPr/>') => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`],
  ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
]);
/** Imports `body`, checks the result against the Document schema, exports it → {doc, xml (document.xml)}. */
async function roundTrip(body, sect) {
  const { doc } = await importDocx(await docx(body, sect));
  schema.nodeFromJSON(doc).check();
  const files = await readZip((await exportDocx(doc, { picture: async () => null })).bytes);
  return { doc, xml: text(files.get('word/document.xml')) };
}
// The kit's schema: canvases (Word shapes) exist only there (src/editors.js).
const schema = (await import('../src/editors.js')).kitOf('document').schema;
const r = (t, rpr = '') => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const fc = (type) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
const field = (code, result) => `${fc('begin')}<w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r>${fc('separate')}${result}${fc('end')}`;

test('a text box\'s and a shape\'s drawing run keep their run properties (noProof)', async () => {
  const shape = (txbx) => '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="S"/>'
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp>'
    + `${txbx ? '<wps:cNvSpPr txBox="1"/>' : '<wps:cNvSpPr/>'}<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr>`
    + `${txbx ? '<wps:txbx><w:txbxContent><w:p><w:r><w:t>In the box</w:t></w:r></w:p></w:txbxContent></wps:txbx>' : ''}<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const { doc, xml } = await roundTrip(`<w:p>${shape(true)}</w:p><w:p>${shape(false)}</w:p>`);
  const box = doc.content.find((n) => n.type === 'textBox');
  const canvas = doc.content.find((n) => n.type === 'canvas');
  assert.deepEqual(box.attrs.run, { noProof: true });
  assert.deepEqual(canvas.attrs.run, { noProof: true });
  assert.equal(xml.match(/<w:r><w:rPr><w:noProof\/><\/w:rPr><w:drawing>/g)?.length, 2);
});

test('a field result keeps its runs\' formatting through import and export, and the node holds what they share', async () => {
  const body = `<w:p>${field('QUOTE "plain italic plain" \\* MERGEFORMAT', r('plain ', '<w:b/>') + r('italic', '<w:b/><w:i/>') + r(' plain', '<w:b/>'))}</w:p>`
    + '<w:p><w:fldSimple w:instr=" QUOTE &quot;Year 2026&quot; ">' + r('Year ') + r('2026', '<w:noProof/>') + '</w:fldSimple></w:p>';
  const { doc, xml } = await roundTrip(body);
  const [f1, f2] = doc.content.map((p) => p.content.find((n) => n.type === 'field'));
  assert.deepEqual(f1.attrs.runs, [{ text: 'plain ', marks: [{ type: 'bold' }] }, { text: 'italic', marks: [{ type: 'bold' }, { type: 'italic' }] },
    { text: ' plain', marks: [{ type: 'bold' }] }]);
  assert.deepEqual(f1.marks, [{ type: 'bold' }], 'bold is shared by every run');
  assert.deepEqual(f2.attrs.runs, [{ text: 'Year ' }, { text: '2026', marks: [{ type: 'textStyle', attrs: { noProof: true } }] }]);
  assert.equal(f2.marks, undefined);
  assert.match(xml, /<w:rPr><w:b\/><w:bCs\/><w:i\/><w:iCs\/><\/w:rPr><w:t xml:space="preserve">italic<\/w:t>/);
  assert.match(xml, /<w:rPr><w:noProof\/><\/w:rPr><w:t xml:space="preserve">2026<\/w:t>/);
  // One formatting for the whole result keeps the old shape: no runs, the first result run's marks on the node.
  const plain = await roundTrip(`<w:p>${field('QUOTE "one"', r('one', '<w:i/>'))}</w:p>`);
  const f3 = plain.doc.content[0].content.find((n) => n.type === 'field');
  assert.equal(f3.attrs.runs, undefined);
  assert.deepEqual(f3.marks, [{ type: 'italic' }]);
});

test('runs count only while they make up the result, and a refreshed value follows MERGEFORMAT word by word', () => {
  const runs = [{ text: 'plain ' }, { text: 'italic', marks: [{ type: 'italic' }] }, { text: ' plain' }];
  const merge = { code: 'QUOTE "x" \\* MERGEFORMAT', result: 'plain italic plain', runs };
  assert.deepEqual(validRuns({ ...merge, result: 'changed by a TOC update' }), [{ text: 'changed by a TOC update' }], "stale runs: one run in the first run's formatting");
  assert.equal(validRuns({ ...merge, result: '' }), null);
  // A result another writer changed keeps the first run's own formatting, which the node's marks do not hold.
  const title = resultRuns([{ text: 'My ', marks: [{ type: 'bold' }] }, { text: 'Title' }]);
  assert.deepEqual(title.marks, []);
  const stale = { code: 'TITLE', result: 'New Title', runs: title.runs };
  assert.deepEqual(validRuns(stale), [{ text: 'New Title', marks: [{ type: 'bold' }] }]);
  assert.deepEqual(drawnRuns(stale, 'New Title'), [{ text: 'New Title', marks: [{ type: 'bold' }] }]);
  assert.deepEqual(drawnRuns({ ...stale, code: 'TITLE \\* MERGEFORMAT' }, 'Other Title'), [{ text: 'Other Title', marks: [{ type: 'bold' }] }]);
  assert.equal(validRuns({ ...merge, runs: 'bad' }), null);
  assert.deepEqual(drawnRuns(merge, 'one two three four'), [{ text: 'one ' }, { text: 'two', marks: [{ type: 'italic' }] }, { text: ' three four' }]);
  assert.deepEqual(drawnRuns({ ...merge, code: 'QUOTE "x"' }, 'other'), [{ text: 'other' }], 'without the switch: the first run\'s formatting');
});

test('a manual update: MERGEFORMAT keeps the italic word, no switch gives the whole result the first run\'s formatting, a field\'s own bold stays', async () => {
  const { Editor } = await import('@tiptap/core');
  const runs = [{ text: 'plain ' }, { text: 'italic', marks: [{ type: 'italic' }] }, { text: ' plain' }];
  const f = (code, marks) => ({ type: 'field', attrs: { code, result: 'plain italic plain', runs }, ...(marks && { marks }) });
  const ed = new Editor({ element: null, extensions: documentExtensions(50), content: { type: 'doc', content: [
    { type: 'paragraph', content: [f('QUOTE "plain italic plain" \\* MERGEFORMAT')] },
    { type: 'paragraph', content: [f('QUOTE "plain italic plain"')] },
    { type: 'paragraph', content: [f('QUOTE "new words here now" \\* MERGEFORMAT', [{ type: 'bold' }])] }] } });
  ed.view.updateState(ed.state.reconfigure({ plugins: ed.extensionManager.plugins }));
  try {
    assert.equal(await updateFields(ed, 'all', 'manual'), 3);
    const out = [];
    ed.state.doc.descendants((n) => void (n.type.name === 'field' && out.push({ result: n.attrs.result, runs: n.attrs.runs, marks: n.marks.map((m) => m.type.name) })));
    assert.deepEqual(out[0], { result: 'plain italic plain', runs, marks: [] }, 'unchanged under MERGEFORMAT');
    assert.deepEqual(out[1], { result: 'plain italic plain', runs: null, marks: [] }, 'the italic word is lost without it, as in Word');
    assert.deepEqual(out[2].runs, [{ text: 'new ', marks: [{ type: 'bold' }] }, { text: 'words', marks: [{ type: 'bold' }, { type: 'italic' }] }, { text: ' here now', marks: [{ type: 'bold' }] }]);
    assert.deepEqual(out[2].marks, ['bold'], 'the bold given to the whole field stays');
    // A second update changes nothing more, so it adds no undo step of its own.
    const before = ed.state.doc;
    await updateFields(ed, 'all', 'manual');
    assert.ok(ed.state.doc.eq(before));
  } finally {
    ed.destroy();
  }
});

test('unlink leaves each result run with its own formatting', async () => {
  const { unlinkNodes } = await import('../src/document/wp/fields-core/commands.js');
  const node = schema.nodeFromJSON({ type: 'field', attrs: { code: 'QUOTE "a b"', result: 'a b', runs: [{ text: 'a ' }, { text: 'b', marks: [{ type: 'italic' }] }] },
    marks: [{ type: 'textStyle', attrs: { size: 14 } }] });
  const out = unlinkNodes(node, 0, new Map(), schema).map((n) => ({ text: n.text, marks: n.marks.map((m) => m.type.name).sort(), size: n.marks.find((m) => m.type.name === 'textStyle')?.attrs.size }));
  assert.deepEqual(out, [{ text: 'a ', marks: ['textStyle'], size: 14 }, { text: 'b', marks: ['italic', 'textStyle'], size: 14 }]);
});

test('a row\'s w:tblPrEx, a control\'s w:sdtEndPr and a one-column section\'s w:cols spacing come back', async () => {
  const tc = '<w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>';
  const body = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>`
    + `<w:tr><w:tblPrEx><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPrEx>${tc}</w:tr></w:tbl>`
    + '<w:sdt><w:sdtPr><w:id w:val="5"/></w:sdtPr><w:sdtEndPr><w:rPr><w:b w:val="0"/><w:sz w:val="22"/></w:rPr></w:sdtEndPr><w:sdtContent><w:p><w:r><w:t>In it</w:t></w:r></w:p></w:sdtContent></w:sdt>';
  const { doc, xml } = await roundTrip(body, '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:cols w:space="708"/></w:sectPr>');
  assert.deepEqual(doc.content[0].content[0].attrs.tblPrEx, { borders: { top: { style: 'single', width: 0.5, space: 0 } }, cellMargin: { top: 0, bottom: 0 } });
  assert.match(xml, /<w:tr><w:tblPrEx><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"\/><\/w:tblBorders><w:tblCellMar><w:top w:w="0" w:type="dxa"\/><w:bottom w:w="0" w:type="dxa"\/><\/w:tblCellMar><\/w:tblPrEx>/);
  assert.deepEqual(doc.content[1].attrs.sdt.endRun, { b: false, size: 11 });
  assert.match(xml, /<\/w:sdtPr><w:sdtEndPr><w:rPr><w:b w:val="0"\/><w:bCs w:val="0"\/><w:sz w:val="22"\/><w:szCs w:val="22"\/><\/w:rPr><\/w:sdtEndPr><w:sdtContent>/);
  assert.equal(doc.attrs.sect.colSpace, 35.4);
  assert.match(xml, /<w:cols w:space="708"\/>/);
});

test('Word\'s wrap polygon, its edited flag and behindDoc beside a tight wrap come back as layout attributes', async () => {
  const pic = '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">'
    + '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
    + '<wp:extent cx="914400" cy="914400"/><wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="1"><wp:start x="2000" y="0"/><wp:lineTo x="21600" y="10800"/>'
    + '<wp:lineTo x="2000" y="21600"/><wp:lineTo x="2000" y="0"/></wp:wrapPolygon></wp:wrapTight><wp:docPr id="2" name="T"/>'
    + '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/>'
    + '<a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="triangle"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
  const { doc, xml } = await roundTrip(`<w:p>${pic}<w:r><w:t>Text</w:t></w:r></w:p>`);
  const { layout } = doc.content.find((n) => n.type === 'canvas').attrs;
  assert.equal(layout.wrap, 'tight');
  assert.deepEqual(layout.poly, [[0.092593, 0], [1, 0.5], [0.092593, 1]], 'fractions of the box, without the closing point');
  assert.equal(layout.polyEdited, true);
  assert.equal(layout.behindDoc, true);
  assert.match(xml, /behindDoc="1"/);
  assert.match(xml, /<wp:wrapPolygon edited="1"><wp:start x="2000" y="0"\/><wp:lineTo x="21600" y="10800"\/><wp:lineTo x="2000" y="21600"\/><wp:lineTo x="2000" y="0"\/><\/wp:wrapPolygon>/);
  // In Front of Text chosen later clears the kept flag, as Word's does.
  const front = { ...doc, content: doc.content.map((n) => (n.type === 'canvas' ? { ...n, attrs: { ...n.attrs, layout: { ...layout, wrap: 'front' } } } : n)) };
  const out = text((await readZip((await exportDocx(front)).bytes)).get('word/document.xml'));
  assert.match(out, /behindDoc="0"/);
});

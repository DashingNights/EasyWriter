// shape-text-roundtrip (docs/plans/word/briefs/shape-text-roundtrip.md): the text in a Word shape (wps:txbx / w:txbxContent) survives
// the round trip with its paragraph properties: Word's empty, centred text body in a callout, text typed into it, and text in a
// group, a drawing canvas or a floating shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, importDocx } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { PLAIN_FMT } from '../src/document/docx/dml.mjs';
import { canvasOf } from '../src/document/docx/shapes-in.mjs';
import { shapeDrawing } from '../src/document/docx/shapes-out.mjs';
import { THEME } from '../src/document/defaults.mjs';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
  + 'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const URI = { wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape', wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas' };
// Word's default shape style (the minor font in Light 1) and the empty, centred text body it writes into every callout (the fixture's
// insert.illustrations.shapes Speech Bubble cases).
const STYLE = '<wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="15000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>'
  + '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></wps:style>';
const EMPTY = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p>';
const BODY = '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="ctr"><a:noAutofit/></wps:bodyPr>';
const wsp = (prst, paras, x = 0, y = 0) => `<wps:wsp><wps:cNvPr id="${x + 2}" name="Shape ${x + 2}"/><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="685800" cy="457200"/></a:xfrm>`
  + `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom></wps:spPr>${STYLE}<wps:txbx><w:txbxContent>${paras}</w:txbxContent></wps:txbx>${BODY}</wps:wsp>`;
const gd = (uri, inner) => parseXml(`<a:graphicData ${NS} uri="${uri}">${inner}</a:graphicData>`);
const ctx = { dml: { colors: THEME.colors, fonts: THEME.fonts, fmt: PLAIN_FMT }, fonts: THEME.fonts, text: { size: 11, color: '#000000', font: null },
  picture: () => null, partXml: () => null, drop: () => {} };
const out = (attrs) => { let n = 0; return shapeDrawing(attrs, { id: () => ++n, placed: (cx, cy, pr, graphic) => `<wp:inline><wp:extent cx="${cx}" cy="${cy}"/>${pr}${graphic}</wp:inline>` }).xml; };
const content = (xml) => [...xml.matchAll(/<w:txbxContent>(.*?)<\/w:txbxContent>/g)].map((m) => m[1]);
const back = (xml, uri) => canvasOf(gd(uri, /<a:graphicData uri="[^"]*">(.*)<\/a:graphicData>/.exec(xml)[1]), 685800, 457200, ctx).attrs.items;

test('a callout\'s empty, centred text body stays: drawn as no text, ready to type in Word\'s style, and written back as Word wrote it', () => {
  const [it] = canvasOf(gd(URI.wps, wsp('wedgeRectCallout', EMPTY)), 685800, 457200, ctx).attrs.items;
  assert.deepEqual([it.html, it.align, it.valign, it.bold, it.inset], ['', 'center', 'middle', false, { t: 4.8, r: 9.6, b: 4.8, l: 9.6 }]);
  assert.equal(it.textColor, THEME.colors.lt1.toUpperCase(), 'text typed later takes the font reference\'s Light 1');
  assert.deepEqual(it.themeColors.textColor.attrs, { val: 'lt1' });
  assert.deepEqual(it.pPr, { align: 'center', xml: ['<w:jc w:val="center"/>'] });
  assert.deepEqual(content(out({ w: 72, h: 48, dw: 72, items: [it] })), [EMPTY]);

  // Typed in the app: the text goes into Word's paragraph, with its properties and in the font reference's colour.
  const typed = out({ w: 72, h: 48, dw: 72, items: [{ ...it, html: 'Hello &amp; bye' }] });
  assert.match(content(typed)[0], /^<w:p><w:pPr><w:jc w:val="center"\/><\/w:pPr><w:r><w:rPr>(?!.*<w:color)[^]*<w:t xml:space="preserve">Hello &amp; bye<\/w:t><\/w:r><\/w:p>$/);
  const [re] = back(typed, URI.wps);
  assert.deepEqual([re.html, re.align, re.textColor], ['Hello &amp; bye', 'center', it.textColor], 'reopened, it shows the text again');
  // A second paragraph typed takes Word's properties too, as Enter carries them in Word.
  assert.deepEqual(content(out({ w: 72, h: 48, dw: 72, items: [{ ...it, html: 'One<div>Two</div>' }] }))[0].match(/<w:pPr>.*?<\/w:pPr>/g),
    ['<w:pPr><w:jc w:val="center"/></w:pPr>', '<w:pPr><w:jc w:val="center"/></w:pPr>']);
});

test('text keeps each paragraph\'s own properties in a group and a drawing canvas; a new alignment goes where Word puts w:jc', () => {
  // Spacing, a style, a justified paragraph (the board shows it left) and a paragraph mark's run properties, with no jc in the third.
  const paras = '<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:after="0"/><w:jc w:val="right"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>Head</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:ind w:left="144"/><w:jc w:val="both"/></w:pPr><w:r><w:t>Body text</w:t></w:r></w:p><w:p><w:r><w:t>Plain</w:t></w:r></w:p>';
  const grp = `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="685800" cy="457200"/><a:chOff x="0" y="0"/><a:chExt cx="685800" cy="457200"/></a:xfrm></wpg:grpSpPr>`
    + `${wsp('cloudCallout', paras)}${wsp('ellipse', '<w:p><w:r><w:t>Other</w:t></w:r></w:p>', 342900)}</wpg:wgp>`;
  const can = `<wpc:wpc><wpc:bg/><wpc:whole/>${wsp('cloudCallout', paras)}${wsp('ellipse', '<w:p><w:r><w:t>Other</w:t></w:r></w:p>', 342900)}</wpc:wpc>`;
  for (const [uri, xml] of [[URI.wpg, grp], [URI.wpc, can]]) {
    const { attrs } = canvasOf(gd(uri, xml), 685800, 457200, ctx);
    const it = attrs.items[0];
    assert.deepEqual([it.html, it.align], ['Head<br>Body text<br>Plain', 'right']);
    assert.equal(content(out(attrs))[0].replace(/<w:r>.*?<\/w:r>/g, ''), paras.replace(/<w:r>.*?<\/w:r>/g, ''), `${uri}: every paragraph's properties as Word wrote them`);
    // Aligned left in the app: each paragraph takes it in Word's place for w:jc (before the mark's w:rPr).
    const left = content(out({ ...attrs, items: [{ ...it, align: 'left' }, attrs.items[1]] }))[0].match(/<w:pPr>.*?<\/w:pPr>/g);
    assert.deepEqual(left, ['<w:pPr><w:pStyle w:val="Title"/><w:spacing w:after="0"/><w:jc w:val="left"/><w:rPr><w:b/></w:rPr></w:pPr>',
      '<w:pPr><w:ind w:left="144"/><w:jc w:val="left"/></w:pPr>', '<w:pPr><w:jc w:val="left"/></w:pPr>']);
  }
});

test('kept paragraph XML uses only prefixes every exported part declares: a tracked paragraph mark keeps its w:ins without Word\'s w16du copy', () => {
  const mark = '<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:ins w:id="5" w:author="A" w:date="2026-01-01T00:00:00Z" w16du:dateUtc="2026-01-01T00:00:00Z"/><w16x:odd/></w:rPr></w:pPr><w:r><w:t>T</w:t></w:r></w:p>';
  const { attrs } = canvasOf(gd(URI.wps, wsp('ellipse', mark)), 685800, 457200, ctx);
  assert.deepEqual(attrs.items[0].pPr.xml, ['<w:jc w:val="center"/><w:rPr><w:ins w:id="5" w:author="A" w:date="2026-01-01T00:00:00Z"/></w:rPr>']);
});

test('a label made in the app, with no Word paragraphs, writes the board\'s spacing as before', () => {
  const xml = out({ w: 72, h: 48, dw: 72, items: [{ id: 'a', type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 72, h: 48, fill: 'solid', fillColor: '#FFFFFF', color: '#000000', width: 1, html: 'Mine', align: 'left' }] });
  assert.match(content(xml)[0], /^<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"\/><w:jc w:val="left"\/><\/w:pPr>/);
  assert.deepEqual([back(xml, URI.wps)[0].html, back(xml, URI.wps)[0].pPr], ['Mine', undefined], 'it reads back as the app\'s text');
  assert.doesNotMatch(out({ w: 72, h: 48, dw: 72, items: [{ id: 'a', type: 'shape', shape: 'ellipse', x: 0, y: 0, w: 72, h: 48, fill: 'none', color: '#000000', width: 1 }] }), /wps:txbx/,
    'a shape never given text has no text body');
});

test('a floating speech bubble round trips through import and export: its empty text body, then text typed in it', async () => {
  const anchor = (inner) => `<w:p><w:r><w:drawing><wp:anchor behindDoc="0" relativeHeight="251658240" allowOverlap="1" simplePos="0" locked="0" layoutInCell="1" distT="0" distB="0" distL="114300" distR="114300">`
    + '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>12700</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>25400</wp:posOffset></wp:positionV>'
    + `<wp:extent cx="685800" cy="457200"/><wp:wrapNone/><wp:docPr id="7" name="Speech Bubble: Oval 7"/><a:graphic><a:graphicData uri="${URI.wps}">${inner}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r><w:r><w:t>Anchor</w:t></w:r></w:p>`;
  const docx = (body) => writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`],
    ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'],
  ]);
  const { doc } = await importDocx(await docx(anchor(wsp('wedgeEllipseCallout', EMPTY))));
  const canvas = doc.content.find((n) => n.type === 'canvas');
  assert.equal(canvas.attrs.items[0].html, '');
  const xml = async (d) => text((await readZip((await exportDocx(d, { picture: async () => null })).bytes)).get('word/document.xml'));
  assert.deepEqual(content(await xml(doc)), [EMPTY]);
  canvas.attrs.items[0] = { ...canvas.attrs.items[0], html: 'Typed' };
  const typed = await xml(doc);
  assert.match(content(typed)[0], /^<w:p><w:pPr><w:jc w:val="center"\/><\/w:pPr><w:r>.*<w:t xml:space="preserve">Typed<\/w:t><\/w:r><\/w:p>$/);
  const again = (await importDocx(await docx(/<w:body>(.*)<w:sectPr/.exec(typed)[1]))).doc.content.find((n) => n.type === 'canvas');
  assert.deepEqual([again.attrs.items[0].html, again.attrs.items[0].align], ['Typed', 'center'], 'reopened, the text shows again');
});

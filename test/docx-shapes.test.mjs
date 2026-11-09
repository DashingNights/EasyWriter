import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';
import { fitItems, shapeItem } from '../src/document/wp/shapes/map.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';
import { presetPath } from '../src/flow/presets.mjs';
import { kindOf, presetKind } from '../src/flow/shapes.mjs';

// Synthetic Word files: one paragraph holding one drawing, plus any parts and relationships a case needs.
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
  + 'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"';
const URI = { wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape', wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas', dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram' };
const PX = 9525;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** A w:drawing of `inner` (graphicData's content, of `uri`) at w × h px: anchored at column + 1 pt, paragraph + 2 pt, or inline. */
export const drawingXml = (inner, uri, w, h, inline = false) => {
  const head = `<wp:extent cx="${w * PX}" cy="${h * PX}"/>`;
  const tail = `<wp:docPr id="7" name="Shape 7" descr="alt text"/><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic>`;
  return inline ? `<w:drawing><wp:inline>${head}${tail}</wp:inline></w:drawing>`
    : `<w:drawing><wp:anchor behindDoc="0" relativeHeight="251658240" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>12700</wp:posOffset></wp:positionH>`
      + `<wp:positionV relativeFrom="paragraph"><wp:posOffset>25400</wp:posOffset></wp:positionV>${head}<wp:wrapNone/>${tail}</wp:anchor></w:drawing>`;
};
const docx = (body, parts = [], rels = '') => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`],
  ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`],
  ...parts,
]);
const spPr = (x, y, w, h, more = '', xf = '') => `<wps:spPr><a:xfrm${xf}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>${more}</wps:spPr>`;
const wsp = (sp, extra = '') => `<wps:wsp><wps:cNvSpPr/>${sp}${extra}<wps:bodyPr/></wps:wsp>`;
const canvases = (doc) => doc.content.filter((n) => n.type === 'canvas');

test('a preset shape imports as a canvas with one item of the matching board kind: fill, line, dash, rotation and flip, the canvas grown to the turned box', async () => {
  const sp = spPr(0, 0, 100 * PX, 50 * PX, '<a:prstGeom prst="flowChartDecision"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'
    + '<a:ln w="19050"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:prstDash val="lgDash"/></a:ln>', ' rot="5400000" flipH="1"');
  const { doc, dropped } = await importDocx(await docx(`<w:p>${`<w:r>${drawingXml(wsp(sp), URI.wps, 100, 50)}</w:r>`}<w:r><w:t>Anchor</w:t></w:r></w:p>`));
  assert.deepEqual(dropped, []);
  assert.deepEqual(doc.content.map((n) => n.type), ['canvas', 'paragraph'], 'a floating shape sits before the paragraph it anchors to');
  const c = doc.content[0].attrs;
  const it = c.items[0];
  assert.deepEqual([it.type, it.shape, kindOf(it.shape).prst, it.w, it.h, it.rot, it.mirrorX], ['shape', 'diam', 'flowChartDecision', 100, 50, 90, true]);
  assert.deepEqual([it.fill, it.fillColor, it.color, it.width, it.dash, it.prstDash], ['solid', '#FF0000', '#0000FF', 2, 'dashed', 'lgDash']);
  assert.equal(c.items.length, 1);
  // 100 x 50 turned 90 degrees reaches 25 px above the drawing's box: the canvas grows and its offset follows.
  assert.deepEqual([c.w, c.h, it.x, it.y, c.dw, c.bg, c.frame.item], [100, 100, 0, 25, 100, 'transparent', it.id]);
  assert.deepEqual([c.layout.wrap, c.layout.h, c.layout.v], ['front', { rel: 'column', offset: 1 }, { rel: 'paragraph', offset: 2 - 18.75 }]);
  assert.deepEqual(c.docPr, { name: 'Shape 7', alt: 'alt text' });
});

test('every preset is a kind drawn from its guide maths, with the adjust values of the file; an unknown name is a rectangle that keeps it', async () => {
  assert.equal(presetPath('rightArrow', {}, 100, 50)[0].d, 'M0 12.5L75 12.5L75 0L100 25L75 50L75 37.5L0 37.5Z');
  assert.match(presetPath('roundRect', { adj: 50000 }, 100, 50)[0].d, /^M0 25C/, 'arcs become Béziers, radius from the adjust value');
  const one = async (prst, av = '') => (await importDocx(await docx(`<w:p><w:r>${drawingXml(wsp(spPr(0, 0, 100 * PX, 50 * PX, `<a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom>`)), URI.wps, 100, 50, true)}</w:r></w:p>`))).doc;
  const arrow = await one('rightArrow');
  assert.deepEqual(arrow.content.map((n) => n.type), ['canvas'], 'an inline shape alone in its paragraph replaces it');
  const a = arrow.content[0].attrs.items[0];
  assert.deepEqual([a.shape, a.fill, a.color], ['rightArrow', 'none', 'transparent'], 'no fill or line of its own and no style: none');
  assert.equal(kindOf(a.shape).path(100, 50, 0, a).parts[0].d, presetPath('rightArrow', {}, 100, 50)[0].d, 'the board draws the kind from it');
  const round = (await one('roundRect', '<a:gd name="adj" fmla="val 50000"/>')).content[0].attrs.items[0];
  assert.deepEqual([round.shape, round.av], ['round', { adj: 50000 }], 'the board kind that draws the preset, with its adjust values');
  assert.equal((await one('roundRect', '<a:gd name="adj" fmla="val 16667"/>')).content[0].attrs.items[0].shape, 'round');
  const sun = (await one('sun')).content[0].attrs.items[0];
  assert.deepEqual([sun.shape, sun.prst], [presetKind('sun'), undefined]);
  const odd = (await one('notAPreset')).content[0].attrs.items[0];
  assert.deepEqual([odd.shape, odd.prst], ['rect', 'notAPreset']);
});

test('custom geometry: each a:path its own part in the unit square, arcs as Béziers, fill and stroke kept', async () => {
  const cg = '<a:custGeom><a:avLst/><a:gdLst><a:gd name="half" fmla="*/ h 1 2"/></a:gdLst><a:pathLst><a:path w="200" h="100"><a:moveTo><a:pt x="0" y="50"/></a:moveTo>'
    + '<a:arcTo wR="100" hR="50" stAng="10800000" swAng="10800000"/><a:close/></a:path><a:path w="200" h="100" fill="none" stroke="1"><a:moveTo><a:pt x="0" y="100"/></a:moveTo>'
    + '<a:lnTo><a:pt x="200" y="100"/></a:lnTo><a:cubicBezTo><a:pt x="150" y="0"/><a:pt x="50" y="0"/><a:pt x="0" y="100"/></a:cubicBezTo></a:path><a:path stroke="0"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="10" y="half"/></a:lnTo></a:path></a:pathLst></a:custGeom>';
  const { doc } = await importDocx(await docx(`<w:p><w:r>${drawingXml(wsp(spPr(0, 0, 200 * PX, 100 * PX, `${cg}<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>`)), URI.wps, 200, 100)}</w:r></w:p>`));
  const it = canvases(doc)[0].attrs.items[0];
  assert.equal(it.shape, 'path');
  assert.equal(it.path.length, 3);
  assert.match(it.path[0].d, /^M0 0\.5C.*,0\.5 0C.*,1 0\.5Z$/, 'a half ellipse over the top: through its top middle to its right end');
  assert.deepEqual([it.path[1].fill, it.path[1].stroke, it.path[2].stroke], ['none', undefined, false]);
  assert.match(it.path[2].d, /^M0 0L0 0\.5$/, 'a point may name a guide (h / 2 in the shape\'s EMU, as a path without a size of its own is)');
  const parts = kindOf('path').path(200, 100, 0, it).parts;
  assert.match(parts[0].d, /^M0 50C/, 'scaled to the item');
});

test('a group imports into one canvas: children placed through chOff, chExt, off and ext, nested groups, a text box as a labelled shape, a picture; flips mirror the children', async () => {
  const child = (x, y, w, h, fill) => wsp(spPr(x, y, w, h, `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`));
  const box = `<wps:wsp><wps:cNvSpPr txBox="1"/>${spPr(300, 200, 100, 100, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>')}<wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
    + '<w:r><w:rPr><w:sz w:val="24"/><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Hi </w:t></w:r><w:r><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="FF0000"/></w:rPr><w:t>&lt;there&gt;</w:t></w:r></w:p></w:txbxContent></wps:txbx>'
    + '<wps:bodyPr lIns="0" tIns="9525" rIns="0" bIns="0" anchor="ctr"/></wps:wsp>';
  const nested = '<wpg:grpSp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="300" y="100"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="10" cy="10"/></a:xfrm></wpg:grpSpPr>'
    + `${child(5, 0, 5, 5, '0000FF')}${child(0, 5, 5, 5, '00FF00')}</wpg:grpSp>`;
  const pic = `<pic:pic><pic:nvPicPr><pic:cNvPr id="9" name="P"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000" r="10000"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic>`;
  // 200 x 100 px whose children use 0.5 px units from (100, 100).
  const grp = (flip = '') => `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm${flip}><a:off x="0" y="0"/><a:ext cx="${200 * PX}" cy="${100 * PX}"/><a:chOff x="100" y="100"/><a:chExt cx="400" cy="200"/></a:xfrm></wpg:grpSpPr>`
    + `${child(100, 100, 200, 200, 'FF0000')}${box}${nested}${pic}</wpg:wgp>`;
  const files = [['word/media/image1.png', Buffer.from(PNG, 'base64')]];
  const rels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>';
  const { doc, dropped } = await importDocx(await docx(`<w:p><w:r>${drawingXml(grp(), URI.wpg, 200, 100)}</w:r></w:p>`, files, rels));
  assert.deepEqual(dropped, []);
  const c = canvases(doc)[0].attrs;
  assert.deepEqual([c.w, c.h], [200, 100]);
  const [a, t, n1, n2, p] = c.items;
  const box4 = (i) => [i.x, i.y, i.w, i.h];
  assert.deepEqual(box4(a), [0, 0, 100, 100]);
  assert.deepEqual(box4(t), [100, 50, 50, 50]);
  assert.deepEqual(box4(n1), [125, 0, 25, 25], 'a nested group scales again');
  assert.deepEqual(box4(n2), [100, 25, 25, 25]);
  assert.deepEqual([p.type, box4(p), p.crop], ['image', [0, 50, 50, 50], { x: 0.1, y: 0, w: 0.8, h: 1 }]);
  assert.match(p.src, /^data:image\/png;base64,/);
  assert.deepEqual([a.groups, n1.groups, n2.groups], [['g1'], ['g2', 'g1'], ['g2', 'g1']], 'the canvas is one group, the nested group another inside it');
  assert.deepEqual([t.shape, t.html, t.size, t.textColor, t.bold, t.align, t.valign, t.inset], ['rect', 'Hi <b>&lt;there&gt;</b>', 16, '#FF0000', false, 'center', 'middle', { t: 1, r: 0, b: 0, l: 0 }]);
  // Flipped: the children mirror about the group's middle and their content mirrors.
  const flipped = canvases((await importDocx(await docx(`<w:p><w:r>${drawingXml(grp(' flipH="1"'), URI.wpg, 200, 100)}</w:r></w:p>`, files, rels))).doc)[0].attrs.items;
  assert.deepEqual([box4(flipped[0]), flipped[0].mirrorX, box4(flipped[1])], [[100, 0, 100, 100], true, [50, 50, 50, 50]]);
});

test('lines are free connectors with their ends, heads, route and dash; a Word drawing canvas keeps its shapes ungrouped', async () => {
  const line = `<wps:wsp><wps:cNvCnPr/>${spPr(0, 0, 100 * PX, 50 * PX, '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="sysDot"/><a:headEnd type="oval"/><a:tailEnd type="triangle"/></a:ln>', ' flipH="1"')}<wps:bodyPr/></wps:wsp>`;
  const { doc } = await importDocx(await docx(`<w:p><w:r>${drawingXml(line, URI.wps, 100, 50)}</w:r></w:p>`));
  const c = canvases(doc)[0].attrs;
  const it = c.items[0];
  // Heads need room: the canvas grows 6 px each way and the offsets follow.
  assert.deepEqual([it.type, it.route, it.from, it.to, it.heads, it.dash, it.width, it.prst], ['connector', 'straight', { x: 106, y: 6 }, { x: 6, y: 56 }, { start: 'circle', end: 'triangle' }, 'dotted', 1, undefined],
    'a straight line with heads is what export writes back without naming it');
  assert.deepEqual([c.w, c.h, c.layout.h.offset, c.layout.v.offset], [112, 62, 1 - 4.5, 2 - 4.5]);
  const bent = await importDocx(await docx(`<w:p><w:r>${drawingXml(line.replace('straightConnector1', 'bentConnector3'), URI.wps, 100, 50)}</w:r></w:p>`));
  assert.equal(canvases(bent.doc)[0].attrs.items[0].route, 'ortho');

  const shape = (x, prst) => wsp(spPr(x * PX, 0, 50 * PX, 50 * PX, `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`));
  const wpc = `<wpc:wpc><wpc:bg/><wpc:whole/>${shape(0, 'ellipse')}${shape(100, 'rect')}</wpc:wpc>`;
  const items = canvases((await importDocx(await docx(`<w:p><w:r>${drawingXml(wpc, URI.wpc, 200, 50)}</w:r></w:p>`))).doc)[0].attrs.items;
  assert.deepEqual(items.map((i) => [i.shape, i.x, i.groups]), [['ellipse', 0, undefined], ['rect', 100, undefined]]);
});

test('SmartArt imports from its pre-drawn dsp:drawing part, found through the data part\'s dataModelExt, with theme style references and DrawingML text', async () => {
  const sp = (x, text) => `<dsp:sp><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr><a:xfrm><a:off x="${x * PX}" y="0"/><a:ext cx="${80 * PX}" cy="${40 * PX}"/></a:xfrm>`
    + '<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom></dsp:spPr><dsp:style><a:lnRef idx="2"><a:schemeClr val="lt1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>'
    + '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>'
    + `<dsp:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-GB" sz="1800"/><a:t>${text}</a:t></a:r></a:p></dsp:txBody></dsp:sp>`;
  const drawing = `<dsp:drawing ${NS}><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>${sp(0, 'Plan')}${sp(100, 'Build')}</dsp:spTree></dsp:drawing>`;
  const data = `<dgm:dataModel ${NS}><dgm:ptLst/><dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt relId="rId9" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst></dgm:dataModel>`;
  const theme = '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="T"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>'
    + '<a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="T"><a:majorFont><a:latin typeface="Major"/></a:majorFont><a:minorFont><a:latin typeface="Minor"/></a:minorFont></a:fontScheme>'
    + '<a:fmtScheme name="T"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
    + '<a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>';
  const rels = '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData" Target="diagrams/data1.xml"/>'
    + '<Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="diagrams/drawing1.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>';
  const dg = '<dgm:relIds r:dm="rId5" r:lo="rId6" r:qs="rId7" r:cs="rId8"/>';
  const { doc, dropped } = await importDocx(await docx(`<w:p><w:r>${drawingXml(dg, URI.dgm, 180, 40, true)}</w:r></w:p>`,
    [['word/diagrams/data1.xml', data], ['word/diagrams/drawing1.xml', drawing], ['word/theme/theme1.xml', theme]], rels));
  assert.deepEqual(dropped, []);
  const items = canvases(doc)[0].attrs.items;
  assert.deepEqual(items.map((i) => [i.shape, i.x, i.w, i.fillColor, i.color, i.width, i.html, i.textColor, i.size, i.font, i.align, i.valign, i.groups]), [
    ['round', 0, 80, '#4472C4', '#FFFFFF', 1.3333, 'Plan', '#FFFFFF', 24, 'Minor', 'center', 'middle', ['g0']],
    ['round', 100, 80, '#4472C4', '#FFFFFF', 1.3333, 'Build', '#FFFFFF', 24, 'Minor', 'center', 'middle', ['g0']]]);
});

test('a text box in a rectangle stays a text box; Word text in another shape becomes the shape\'s label', async () => {
  const txbx = (prst) => `<wps:wsp><wps:cNvSpPr txBox="1"/>${spPr(0, 0, 100 * PX, 50 * PX, `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`)}<wps:txbx><w:txbxContent><w:p><w:r><w:t>Words</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>`;
  const rect = (await importDocx(await docx(`<w:p><w:r>${drawingXml(txbx('rect'), URI.wps, 100, 50)}</w:r></w:p>`))).doc;
  assert.deepEqual(rect.content.map((n) => n.type), ['textBox', 'paragraph']);
  const oval = (await importDocx(await docx(`<w:p><w:r>${drawingXml(txbx('ellipse'), URI.wps, 100, 50)}</w:r></w:p>`))).doc;
  const it = canvases(oval)[0].attrs.items[0];
  assert.deepEqual([it.shape, it.html, it.size, it.textColor], ['ellipse', 'Words', 16, '#000000'], "the document's Normal size (12 pt without a styles part) and colour where the run sets none");
});

// ---------- export ----------
const P = (t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
const roundTrip = async (content, opts = {}) => {
  const { bytes, dropped } = await exportDocx({ type: 'doc', attrs: {}, content }, opts);
  const files = await readZip(bytes);
  return { xml: text(files.get('word/document.xml')), dropped, files, back: (await importDocx(bytes, { fresh: true })).doc, kept: (await importDocx(bytes)).doc };
};
/** Items as compared across a round trip: ids and group ids renamed in order of appearance, numbers to 0.1. */
const same = (items) => {
  const ids = new Map();
  const name = (x) => (ids.has(x) ? ids.get(x) : (ids.set(x, `#${ids.size}`), ids.get(x)));
  const out = items.map(({ id, ...it }) => ({ ...it, id: name(id), ...(it.groups && { groups: it.groups.map(name) }) }));
  return JSON.parse(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
};

test('an Insert > Shapes canvas exports as a Word shape, not a picture, and reads back as the same shape at the same place', async () => {
  const item = { ...shapeItem('Oval', { x: 20, y: 10, w: 120, h: 60 }), html: 'Hello <b>you</b>', rot: 30 };
  const fit = fitItems([item]);
  const canvas = { type: 'canvas', attrs: { ...fit, dw: fit.w, bg: 'transparent', layout: { wrap: 'front', h: { rel: 'column', offset: 50 }, v: { rel: 'paragraph', offset: 10 } } } };
  const { xml, dropped, back, kept } = await roundTrip([canvas, P('Anchor')]);
  assert.deepEqual(dropped, []);
  assert.doesNotMatch(xml, /a:blip/);
  assert.match(xml, /<w:p><w:r><w:drawing><wp:anchor [^>]*>.*<a:graphicData uri="[^"]*wordprocessingShape"><wps:wsp><wps:cNvSpPr\/><wps:spPr><a:xfrm rot="1800000"><a:off x="0" y="0"\/><a:ext cx="1143000" cy="571500"\/><\/a:xfrm><a:prstGeom prst="ellipse">.*<\/w:drawing><\/w:r><w:r><w:t[^>]*>Anchor/s,
    'a floating shape rides in the paragraph after it, as a text box does');
  assert.deepEqual(back.content.map((n) => n.type), ['canvas', 'paragraph']);
  const b = back.content[0].attrs;
  const it = b.items[0];
  assert.deepEqual([it.shape, it.fill, it.fillColor, it.color, it.width, it.rot, it.html, it.textColor, it.size], ['ellipse', 'solid', item.fillColor, item.color, Math.round(item.width * 10000) / 10000, 30, 'Hello <b>you</b>', '#FFFFFF', 16]);
  // Where it is drawn: the canvas's offset plus the item's place in it, in pt.
  const at = (c) => [c.layout.h.offset + (c.items[0].x * 72) / 96, c.layout.v.offset + (c.items[0].y * 72) / 96].map((v) => Math.round(v * 100) / 100);
  assert.deepEqual(at(b), at(canvas.attrs));
  assert.deepEqual(kept.content[0], canvas, 'unchanged, the file reopens the canvas itself (STASH)');
});

test('a line width goes back out at Word\'s EMU: 2 pt is 2.6667 board px, not 2.67', async () => {
  const sp = wsp(spPr(0, 0, 100 * PX, 50 * PX, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'));
  const c = canvases((await importDocx(await docx(`<w:p><w:r>${drawingXml(sp, URI.wps, 100, 50)}</w:r></w:p>`))).doc)[0];
  assert.equal(c.attrs.items[0].width, 2.6667);
  assert.match((await roundTrip([c, P('Anchor')])).xml, /<a:ln w="25400">/);
});

test('a group of shapes exports as wpg:wgp with nested groups, line ends and a custom path, and re-imports to the same items; ungrouped shapes go out as a drawing canvas', async () => {
  const shape = (o) => ({ type: 'shape', fill: 'solid', fillColor: '#FF0000', color: '#000000', width: 2, opacity: 1, ...o });
  const items = [
    shape({ id: 'a', shape: 'rect', x: 0, y: 0, w: 100, h: 50, groups: ['G'], dash: 'dashed', prstDash: 'lgDashDot', shadow: { color: '#000000', alpha: 0.4, blur: 4, dist: 3, angle: 45 } }),
    shape({ id: 'b', shape: 'rightArrow', av: { adj1: 40000 }, x: 110, y: 10, w: 80, h: 40, groups: ['N', 'G'], mirrorY: true, rot: 15, fillColor: '#8080FF',
      gradient: { kind: 'linear', angle: 90, stops: [{ pos: 0, color: '#FFFFFF' }, { pos: 1, color: '#0000FF' }] } }),
    shape({ id: 'c', shape: 'path', path: [{ d: 'M0 0L1 0L0.5 1Z' }, { d: 'M0 1L1 1', fill: 'none' }], x: 110, y: 50, w: 40, h: 40, groups: ['N', 'G'], fill: 'none', fillColor: '#FFFFFF' }),
    { id: 'd', type: 'connector', from: { x: 10, y: 90 }, to: { x: 90, y: 60 }, points: [], labels: {}, route: 'straight', corner: 8, heads: { start: 'circle', end: 'arrow' },
      dash: 'dotted', jump: 'none', color: '#00AA00', width: 3, opacity: 1, groups: ['G'] },
    shape({ id: 'e', shape: 'rightBrace', x: 160, y: 50, w: 20, h: 40, groups: ['G'], fill: 'none', fillColor: '#FFFFFF', html: 'Note', size: 12, textColor: '#333333', bold: false, font: 'Arial',
      align: 'left', valign: 'top', inset: { t: 0, r: 1, b: 0, l: 1 } }),
  ];
  const canvas = { type: 'canvas', attrs: { w: 200, h: 100, dw: 200, frame: { x: 0, y: 0, w: 200, h: 100 }, bg: 'transparent', items } };
  const { xml, back } = await roundTrip([P('Before'), canvas, P('After')]);
  assert.match(xml, /<wpg:wgp>.*<wpg:grpSp>.*<\/wpg:grpSp>.*<\/wpg:wgp>/s);
  assert.match(xml, /<a:ln w="19050"><a:solidFill><a:srgbClr val="000000"\/><\/a:solidFill><a:prstDash val="lgDashDot"\/><\/a:ln>/, "the file's own dash");
  assert.match(xml, /<a:headEnd type="oval"\/><a:tailEnd type="arrow"\/>/);
  assert.match(xml, /<a:prstGeom prst="rightBrace">/);
  assert.match(xml, /<a:custGeom>.*<a:path w="\d+" h="\d+" fill="none">/s);
  assert.deepEqual(back.content.map((n) => n.type), ['paragraph', 'canvas', 'paragraph'], 'inline: its own paragraph, which goes again on the way back');
  const b = back.content[1].attrs;
  assert.deepEqual([b.w, b.h], [200, 100]);
  // A shape with no autoFit is a Document's (Do not Autofit, shapes-out.mjs fitOf) and comes back saying so.
  const fixed = (list) => list.map((it) => (it.type === 'shape' ? { ...it, autoFit: false } : it));
  assert.deepEqual(same(b.items), same(fixed(items)));
  // Drawn at 1.5 times its size: the group scales positions; widths and label sizes are written at the size drawn.
  const big = await roundTrip([{ ...canvas, attrs: { ...canvas.attrs, dw: 300 } }]);
  assert.match(big.xml, /<a:ext cx="2857500" cy="1428750"\/><a:chOff x="0" y="0"\/><a:chExt cx="1905000" cy="952500"\/>/);
  assert.match(big.xml, /<a:ln w="28575">/);
  const bb = big.back.content[0].attrs;
  assert.deepEqual([bb.w, bb.h, bb.items[0].w, bb.items[0].width], [300, 150, 150, 3]);

  const loose = { ...canvas, attrs: { ...canvas.attrs, dw: 200, items: items.slice(0, 2).map(({ groups, ...it }) => it) } };
  const l = await roundTrip([loose]);
  assert.match(l.xml, /<wpc:wpc><wpc:bg\/><wpc:whole\/><wps:wsp><wps:cNvPr [^>]*\/><wps:cNvSpPr\/>/);
  assert.deepEqual(same(l.back.content[0].attrs.items), same(fixed(loose.attrs.items)));
});

test('a canvas holding a picture Word does not show keeps the picture and STASH; a lone line exports as a connector shape at its place', async () => {
  const webp = { id: 's', type: 'image', src: 'data:image/webp;base64,AAAA', x: 0, y: 0, w: 10, h: 10 }; // pen strokes go out as ink (canvas-native-export)
  const png = Buffer.from(PNG, 'base64');
  const pen = await roundTrip([{ type: 'canvas', attrs: { w: 50, h: 50, dw: 50, items: [webp, { ...shapeItem('Oval'), x: 0, y: 0 }] } }], { picture: async () => ({ bytes: png, ext: 'png', w: 50, h: 50 }) });
  assert.match(pen.xml, /<a:blip r:embed=/);
  assert.equal(pen.kept.content[0].type, 'canvas');
  const line = shapeItem('Line Arrow', { x: 0, y: 0, w: 90, h: 30 });
  const fit = fitItems([line]);
  const c = { type: 'canvas', attrs: { ...fit, dw: fit.w, bg: 'transparent', layout: { wrap: 'front', h: { rel: 'column', offset: 0 }, v: { rel: 'paragraph', offset: 0 } } } };
  const { xml, back } = await roundTrip([c, P('x')]);
  assert.match(xml, /<wps:cNvCnPr\/><wps:spPr><a:xfrm><a:off x="0" y="0"\/><a:ext cx="857250" cy="285750"\/><\/a:xfrm><a:prstGeom prst="straightConnector1">/);
  const it = back.content[0].attrs.items[0];
  const abs = (cv, p) => [cv.layout.h.offset * (96 / 72) + p.x, cv.layout.v.offset * (96 / 72) + p.y].map((v) => Math.round(v * 10) / 10);
  assert.deepEqual([abs(back.content[0].attrs, it.from), abs(back.content[0].attrs, it.to), it.heads], [abs(c.attrs, fit.items[0].from), abs(c.attrs, fit.items[0].to), line.heads]);
});

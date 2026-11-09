// drawing-import (docs/plans/word/briefs/drawing-import.md): Word shapes keep their theme colours and style references beside the
// resolved colours, Design > Colors re-resolves them, export writes them back, an empty drawing canvas stays one, and group members
// the board cannot draw become framed boxes instead of dropping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, importDocx } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { PLAIN_FMT, rethemeItems } from '../src/document/docx/dml.mjs';
import { canvasOf } from '../src/document/docx/shapes-in.mjs';
import { shapeDrawing } from '../src/document/docx/shapes-out.mjs';
import { setTheme } from '../src/document/wp/design/model.mjs';
import { THEME } from '../src/document/defaults.mjs';
import { kitOf } from '../src/editors.js';
import { EditorState } from '@tiptap/pm/state';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
  + 'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"';
const URI = { wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape', wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas', dgm: 'http://schemas.openxmlformats.org/drawingml/2006/diagram' };
// Word's own default shape style: an Accent 1 fill, its 15 % shade as the line, the minor font in Light 1.
const STYLE = '<wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="15000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>'
  + '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></wps:style>';
// (Text in a plain rectangle is a text box, so a shape with text here is an ellipse.)
const wsp = (x, y, extra = '', text = '') => `<wps:wsp><wps:cNvPr id="${x + 1}" name="Shape ${x + 1}"/><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="914400" cy="457200"/></a:xfrm>`
  + `<a:prstGeom prst="${text ? 'ellipse' : 'rect'}"><a:avLst/></a:prstGeom>${extra}</wps:spPr>${STYLE}${text && `<wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx>`}<wps:bodyPr anchor="ctr"/></wps:wsp>`;
const gd = (uri, inner) => parseXml(`<a:graphicData ${NS} uri="${uri}">${inner}</a:graphicData>`);
const dropped = [];
const ctx = (parts = {}) => ({ dml: { colors: THEME.colors, fonts: THEME.fonts, fmt: PLAIN_FMT }, fonts: THEME.fonts, text: { size: 11, color: '#000000', font: null },
  picture: () => null, partXml: (rid) => (parts[rid] ? parseXml(parts[rid]) : null), drop: (w) => dropped.push(w) });
// export.mjs's wp:inline, as shapeDrawing's caller makes it.
const out = (attrs) => { let n = 0; return shapeDrawing(attrs, { id: () => ++n, placed: (cx, cy, pr, graphic) => `<wp:inline><wp:extent cx="${cx}" cy="${cy}"/>${pr}${graphic}</wp:inline>` }).xml; };
const OTHER = { ...THEME.colors, accent1: '#C00000', lt1: '#FFFF00' };

test('a shape keeps its theme colours, transforms and style references beside the colours they resolve to', () => {
  const { attrs } = canvasOf(gd(URI.wps, wsp(0, 0, '', 'Hello')), 914400, 457200, ctx());
  const [it] = attrs.items;
  assert.equal(it.fillColor, THEME.colors.accent1.toUpperCase(), 'the fill reference names Accent 1');
  assert.deepEqual(it.themeColors.fillColor, { el: 'schemeClr', attrs: { val: 'accent1' }, mods: [], color: it.fillColor });
  assert.deepEqual(it.themeColors.color.mods, [['shade', '15000']], 'the line keeps the reference\'s shade');
  assert.equal(it.themeColors.color.color, it.color);
  assert.deepEqual(it.themeColors.textColor.attrs, { val: 'lt1' }, 'the text takes the font reference\'s Light 1');
  assert.equal(it.styleRefs.lnRef.idx, '2');
  assert.deepEqual(it.styleRefs.fontRef, { idx: 'minor', clr: { el: 'schemeClr', attrs: { val: 'lt1' }, mods: [] } });

  // Design > Colors: the linked colours move with the theme; a colour the user changed keeps its own.
  const [re] = rethemeItems(attrs.items, OTHER);
  assert.equal(re.fillColor, '#C00000');
  assert.equal(re.textColor, '#FFFF00');
  assert.notEqual(re.color, it.color, 'the shaded line follows Accent 1 too');
  assert.equal(re.themeColors.fillColor.color, '#C00000', 'the link moves with its colour');
  const mine = { ...it, fillColor: '#00FF00' };
  assert.equal(rethemeItems([mine], OTHER)[0].fillColor, '#00FF00');
  assert.equal(rethemeItems(attrs.items, THEME.colors), attrs.items, 'nothing to change: the same array');

  // Export writes the scheme colours and the style back, and text in the font reference's colour names none.
  const xml = out(attrs);
  assert.match(xml, /<a:solidFill><a:schemeClr val="accent1"\/><\/a:solidFill>/);
  assert.match(xml, /<a:ln w="\d+"><a:solidFill><a:schemeClr val="accent1"><a:shade val="15000"\/><\/a:schemeClr><\/a:solidFill>/);
  assert.match(xml, /<\/wps:spPr><wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="15000"\/><\/a:schemeClr><\/a:lnRef><a:fillRef idx="1">.*<a:fontRef idx="minor"><a:schemeClr val="lt1"\/><\/a:fontRef><\/wps:style><wps:txbx>/);
  assert.doesNotMatch(xml, /<w:color /);
  const changed = out({ ...attrs, items: [mine] });
  assert.match(changed, /<a:solidFill><a:srgbClr val="00FF00"\/><\/a:solidFill>/, 'a changed colour goes out as itself');
  assert.doesNotMatch(xml, /<a:effectLst/, 'effect style 0: no effects to turn off');
  assert.match(out({ ...attrs, items: [{ ...it, styleRefs: { ...it.styleRefs, effectRef: { idx: '3' } } }] }), /<a:effectLst\/><\/wps:spPr>/,
    'without a shadow, a style\'s theme effects are turned off, as the board draws none');
  // The round trip reads the same links back.
  const back = canvasOf(gd(URI.wps, /<wps:wsp>.*<\/wps:wsp>/.exec(xml)[0]), 914400, 457200, ctx()).attrs.items[0];
  assert.deepEqual([back.themeColors.fillColor.attrs, back.themeColors.color.mods, back.styleRefs], [{ val: 'accent1' }, [['shade', '15000']], it.styleRefs]);
});

test('gradient stops and an outer shadow keep their links; a preset colour goes out as it came', () => {
  const fill = '<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="accent2"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>'
    + '<a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln><a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:schemeClr val="tx1"><a:alpha val="40000"/></a:schemeClr></a:outerShdw></a:effectLst>';
  const { attrs } = canvasOf(gd(URI.wps, wsp(0, 0, fill)), 914400, 457200, ctx());
  const [it] = attrs.items;
  assert.deepEqual(Object.keys(it.themeColors).sort(), ['color', 'gradient.stops.0.color', 'shadow.color']);
  assert.deepEqual(it.gradient.stops[0], { pos: 0, color: it.themeColors['gradient.stops.0.color'].color }, 'the stop itself stays {pos, color}');
  assert.equal(it.themeColors['shadow.color'].color, it.shadow.color, 'an opaque shadow colour, its alpha in the link');
  const xml = out(attrs);
  assert.match(xml, /<a:gs pos="0"><a:schemeClr val="accent2"><a:lumMod val="60000"\/><a:lumOff val="40000"\/><\/a:schemeClr><\/a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"\/>/);
  assert.match(xml, /<a:prstClr val="black"\/>/);
  assert.match(xml, /<a:outerShdw [^>]*><a:schemeClr val="tx1"><a:alpha val="40000"\/><\/a:schemeClr><\/a:outerShdw>/);
  const [re] = rethemeItems(attrs.items, { ...THEME.colors, dk1: '#123456' });
  assert.equal(re.shadow.color, '#123456', 'the shadow follows Text 1 and stays opaque');
});

test('an empty drawing canvas imports as one and exports as one, with its background', () => {
  const g = gd(URI.wpc, '<wpc:wpc><wpc:bg><a:solidFill><a:prstClr val="white"/></a:solidFill></wpc:bg><wpc:whole/></wpc:wpc>');
  const r = canvasOf(g, 2743200, 1371600, ctx());
  assert.ok(r, 'not dropped');
  assert.deepEqual([r.attrs.items, r.attrs.w, r.attrs.h], [[], 288, 144]);
  assert.deepEqual(r.attrs.docPr.canvas.bg, { el: 'prstClr', attrs: { val: 'white' }, mods: [], color: '#FFFFFF' });
  const xml = out(r.attrs);
  assert.match(xml, /<wp:extent cx="2743200" cy="1371600"\/>/);
  assert.match(xml, /<wpc:wpc><wpc:bg><a:solidFill><a:prstClr val="white"\/><\/a:solidFill><\/wpc:bg><wpc:whole\/><\/wpc:wpc>/);
  // An empty canvas made in the app still goes out as its picture (export.mjs).
  assert.equal(shapeDrawing({ w: 400, h: 200, dw: 400, items: [] }, { id: () => 1, placed: () => '' }), null);
});

test('a group inside a drawing canvas imports whole and goes back as a wpg:wgp in the canvas', () => {
  const grp = (inner) => `<wpg:wgp><wpg:cNvPr id="9" name="Group 9"/><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="152400" y="152400"/><a:ext cx="1828800" cy="457200"/>`
    + `<a:chOff x="152400" y="152400"/><a:chExt cx="1828800" cy="457200"/></a:xfrm></wpg:grpSpPr>${inner}</wpg:wgp>`;
  const g = gd(URI.wpc, `<wpc:wpc><wpc:bg/><wpc:whole/>${grp(wsp(152400, 152400) + wsp(1066800, 152400))}</wpc:wpc>`);
  const { attrs } = canvasOf(g, 3200400, 1600200, ctx());
  assert.equal(attrs.items.length, 2);
  assert.ok(attrs.items.every((i) => i.groups?.length === 1) && attrs.items[0].groups[0] === attrs.items[1].groups[0], 'one group');
  const xml = out(attrs);
  assert.match(xml, /<wpc:wpc><wpc:bg\/><wpc:whole\/><wpg:wgp><wpg:cNvPr [^>]*\/><wpg:cNvGrpSpPr\/>.*<\/wpg:wgp><\/wpc:wpc>/, 'still a canvas, the group a wpg:wgp');
  assert.doesNotMatch(xml, /<wpg:grpSp>/);
});

test('group members the board cannot draw become framed boxes with their names; SmartArt draws its drawing', () => {
  dropped.length = 0;
  const frame = (name, inner) => `<wpg:graphicFrame><wpg:cNvPr id="5" name="${name}"/><wpg:cNvFrPr/><wpg:xfrm><a:off x="914400" y="0"/><a:ext cx="914400" cy="457200"/></wpg:xfrm><a:graphic>${inner}</a:graphic></wpg:graphicFrame>`;
  const chart = frame('Chart 5', '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId7"/></a:graphicData>');
  const ink = '<w14:contentPart xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" r:id="rId8"><w14:nvContentPartPr><w14:cNvPr id="6" name="Ink 6"/></w14:nvContentPartPr><w14:xfrm><a:off x="0" y="457200"/><a:ext cx="457200" cy="457200"/></w14:xfrm></w14:contentPart>';
  const dsp = '<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:nvGrpSpPr/><dsp:grpSpPr/>'
    + '<dsp:sp><dsp:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="228600"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent3"/></a:solidFill></dsp:spPr></dsp:sp>'
    + '<dsp:sp><dsp:spPr><a:xfrm><a:off x="457200" y="0"/><a:ext cx="457200" cy="228600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></dsp:spPr></dsp:sp></dsp:spTree></dsp:drawing>';
  const data = '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"><dgm:extLst><a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:dataModelExt relId="rId20"/></a:ext></dgm:extLst></dgm:dataModel>';
  const smart = frame('Diagram 7', `<a:graphicData uri="${URI.dgm}"><dgm:relIds r:dm="rId10" r:lo="rId11" r:qs="rId12" r:cs="rId13"/></a:graphicData>`);
  const g = gd(URI.wpg, `<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="2743200" cy="914400"/></a:xfrm></wpg:grpSpPr>`
    + `${wsp(0, 0)}${chart}${ink}${smart.replace('x="914400" y="0"', 'x="1828800" y="0"')}</wpg:wgp>`);
  const { attrs } = canvasOf(g, 2743200, 914400, ctx({ rId10: data, rId20: dsp }));
  const boxes = attrs.items.filter((i) => i.placeholder);
  assert.deepEqual(boxes.map((b) => [b.html, b.placeholder]), [['Chart 5', 'charts in groups'], ['Ink 6', 'ink in groups']]);
  assert.deepEqual([boxes[0].x, boxes[0].y, boxes[0].w, boxes[0].h], [96, 0, 96, 48], 'the frame\'s box');
  const art = attrs.items.filter((i) => !i.placeholder).slice(1);
  assert.deepEqual(art.map((i) => [i.shape, i.x, i.y]), [['ellipse', 192, 0], ['rect', 240, 0]], 'the SmartArt drawing\'s shapes inside its frame');
  assert.equal(art[0].themeColors.fillColor.attrs.val, 'accent3');
  assert.ok(art[0].groups.length === 2 && art[0].groups[0] === art[1].groups[0], 'the SmartArt shapes are a group inside the group');
  assert.deepEqual(dropped, ['drawings of charts in groups', 'drawings of ink in groups'], 'the notice says what shows as a box');
  // SmartArt with no drawing at all: one framed box at the drawing's extent.
  const lone = canvasOf(gd(URI.dgm, '<dgm:relIds r:dm="rId10"/>'), 914400, 457200, ctx());
  assert.deepEqual(lone.attrs.items.map((i) => [i.html, i.w, i.h]), [['SmartArt', 96, 48]]);
});

test('a .docx round trip keeps the references, and Design > Colors recolours an imported shape in one transaction', async () => {
  const W = `<w:document ${NS} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Rectangle 1"/>`
    + `<a:graphic><a:graphicData uri="${URI.wps}">${wsp(0, 0)}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    + `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2743200" cy="1371600"/><wp:docPr id="2" name="Canvas 2"/><a:graphic><a:graphicData uri="${URI.wpc}"><wpc:wpc><wpc:bg/><wpc:whole/></wpc:wpc></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`;
  const bytes = await writeZip([['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'], ['word/document.xml', W]]);
  const r = await importDocx(bytes, { metafiles: null });
  assert.deepEqual(r.dropped, []);
  const canvases = r.doc.content.filter((n) => n.type === 'canvas');
  assert.equal(canvases.length, 2);
  assert.deepEqual(canvases[1].attrs.items, [], 'the empty canvas');
  assert.deepEqual(canvases[1].attrs.docPr, { canvas: { bg: null }, name: 'Canvas 2' });

  const doc = kitOf('document').schema.nodeFromJSON(r.doc);
  doc.check();
  assert.ok(doc.content.content.find((n) => n.type.name === 'canvas').attrs.items[0].themeColors, 'the links survive the editor\'s schema');
  const state = EditorState.create({ doc });
  const tr = setTheme(state.tr, { ...state.doc.attrs.theme, colors: OTHER });
  const after = tr.doc.content.content.filter((n) => n.type.name === 'canvas');
  assert.equal(after[0].attrs.items[0].fillColor, '#C00000');
  assert.equal(after[1].attrs.docPr.canvas.bg, null);

  const { bytes: back } = await exportDocx(tr.doc.toJSON(), { picture: async () => null });
  const xml = text((await readZip(back)).get('word/document.xml'));
  assert.match(xml, /<a:schemeClr val="accent1"\/>/);
  assert.match(xml, /<wps:style><a:lnRef idx="2">/);
  assert.match(xml, /<wpc:wpc><wpc:bg\/><wpc:whole\/><\/wpc:wpc>/, 'the empty canvas goes back as one');
});

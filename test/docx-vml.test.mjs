import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/document/docx/import.mjs';
import { vmlDrawings, emu, color, vmlPath } from '../src/document/docx/vml.mjs';

const NS = 'xmlns:w="w" xmlns:v="v" xmlns:o="o" xmlns:w10="w10" xmlns:r="r"';
const one = (xml, types) => vmlDrawings(parseXml(`<w:pict ${NS}>${xml}</w:pict>`), types);
const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const deep = (n, name, out = []) => { for (const k of kids(n)) (k.name === name ? out.push(k) : deep(k, name, out)); return out; };
const find = (n, name) => deep({ kids: [n] }, name)[0] ?? null;
const at = (n, a) => n?.attrs?.[a];
const txt = (n) => (n?.kids ?? []).join('');

test('VML lengths, colours and paths', () => {
  assert.deepEqual(['1pt', '2px', '1in', '1cm', '1mm', '1pc', '12700emu', '.5pt', '3'].map((s) => emu(s)), [12700, 19050, 914400, 360000, 36000, 152400, 12700, 6350, 28575]);
  assert.equal(emu('10', 100), 1000, 'a bare number counts the given unit (a group coordinate)');
  assert.deepEqual(['#ff0000', '#0f0', 'navy', '#4f81bd [3204]', 'fill darken(118)'].map(color), ['FF0000', '00FF00', '000080', '4F81BD', null]);
  const [p] = vmlPath('m,l,21600r21600,l21600,xe', [21600, 21600]);
  assert.deepEqual(kids(p).map((k) => k.name), ['a:moveTo', 'a:lnTo', 'a:lnTo', 'a:lnTo', 'a:close']);
  assert.deepEqual(kids(p).slice(0, 4).map((k) => [+at(kids(k)[0], 'x'), +at(kids(k)[0], 'y')]), [[0, 0], [0, 21600], [21600, 21600], [21600, 0]]);
  assert.equal(vmlPath('m@0,0l@1,21600e'), null, 'formulas need the shapetype: no path');
  const two = vmlPath('m0,0l10,10enfm0,10c5,5,5,5,10,0e', [10, 10]);
  assert.deepEqual(two.map((x) => [x.attrs.fill, kids(x).map((k) => k.name).join()]), [[undefined, 'a:moveTo,a:lnTo'], ['none', 'a:moveTo,a:cubicBezTo']]);
});

test('a VML picture becomes pic:pic, inline or anchored with its size, position, wrap, crop and alt text', () => {
  const [inline] = one('<v:shape id="Picture 1" style="width:144pt;height:72pt" type="#_x0000_t75" alt="A cat"><v:imagedata r:id="rId5" o:title="cat" cropleft="0.1" cropbottom="6554f"/></v:shape>');
  const box = kids(inline)[0];
  assert.equal(box.name, 'wp:inline');
  assert.deepEqual([at(find(box, 'wp:extent'), 'cx'), at(find(box, 'wp:extent'), 'cy')], ['1828800', '914400']);
  assert.equal(at(find(box, 'a:blip'), 'r:embed'), 'rId5');
  assert.deepEqual([at(find(box, 'a:srcRect'), 'l'), at(find(box, 'a:srcRect'), 'b')], ['10000', '10001']);
  assert.deepEqual([at(find(box, 'wp:docPr'), 'descr'), at(find(box, 'wp:docPr'), 'title'), at(find(box, 'wp:docPr'), 'name')], ['A cat', 'cat', 'Picture 1']);
  assert.equal(find(box, 'a:ln'), null, 'the picture shapetype (75) draws no line even when not defined in the part');

  const [anchored] = one('<v:shape style="position:absolute;margin-left:36pt;margin-top:1in;width:100px;height:50px;z-index:-251655168;rotation:90;flip:x;'
    + 'mso-position-horizontal-relative:page;mso-position-vertical:center;mso-position-vertical-relative:margin;mso-wrap-distance-left:9pt" o:spid="_x0000_s1030">'
    + '<v:imagedata r:id="rId6"/><w10:wrap type="square" side="left"/><w10:anchorlock/></v:shape>');
  const a = kids(anchored)[0];
  assert.equal(a.name, 'wp:anchor');
  assert.deepEqual([at(a, 'behindDoc'), at(a, 'relativeHeight'), at(a, 'locked'), at(a, 'distL')], ['1', '251655168', '1', '114300']);
  assert.deepEqual([at(find(a, 'wp:positionH'), 'relativeFrom'), txt(find(a, 'wp:posOffset'))], ['page', '457200']);
  assert.deepEqual([at(find(a, 'wp:positionV'), 'relativeFrom'), txt(find(a, 'wp:align'))], ['margin', 'center']);
  assert.equal(at(find(a, 'wp:wrapSquare'), 'wrapText'), 'left');
  assert.deepEqual([at(find(a, 'a:xfrm'), 'rot'), at(find(a, 'a:xfrm'), 'flipH')], ['5400000', '1']);
  assert.equal(at(find(a, 'wp:docPr'), 'id'), '1030');
});

test('position defaults: text means column and paragraph; no w10:wrap is in front of text, a negative z-index behind it', () => {
  const [d] = one('<v:rect style="position:absolute;margin-left:10pt;margin-top:20pt;width:30pt;height:40pt;z-index:3"/>');
  const a = kids(d)[0];
  assert.deepEqual([at(find(a, 'wp:positionH'), 'relativeFrom'), at(find(a, 'wp:positionV'), 'relativeFrom')], ['column', 'paragraph']);
  assert.ok(find(a, 'wp:wrapNone'));
  assert.deepEqual([at(a, 'behindDoc'), at(a, 'relativeHeight')], ['0', '251658243']);
  for (const [type, el] of [['tight', 'wp:wrapTight'], ['through', 'wp:wrapThrough'], ['topAndBottom', 'wp:wrapTopAndBottom'], ['none', 'wp:wrapNone']]) {
    assert.ok(find(one(`<v:rect style="position:absolute;width:1pt;height:1pt"><w10:wrap type="${type}"/></v:rect>`)[0], el), type);
  }
  const [rel] = one('<v:rect style="position:absolute;width:1pt;height:1pt;mso-position-horizontal:right;mso-position-horizontal-relative:right-margin-area;mso-position-vertical-relative:line;'
    + 'mso-width-percent:500;mso-width-relative:page"/>');
  assert.deepEqual([at(find(rel, 'wp:positionH'), 'relativeFrom'), txt(find(rel, 'wp:align')), at(find(rel, 'wp:positionV'), 'relativeFrom')], ['rightMargin', 'right', 'line']);
  assert.deepEqual([at(find(rel, 'wp14:sizeRelH'), 'relativeFrom'), txt(find(rel, 'wp14:pctWidth'))], ['page', '50000']);
  assert.deepEqual(one('<v:rect style="position:absolute;width:1pt;height:1pt;visibility:hidden"/>'), [], 'Word does not draw a hidden shape');
});

test('a VML text box becomes wps:wsp with wps:txbx, its inset, fill, line, anchor and fit; shapetypes carry over within a part', () => {
  const types = new Map();
  one('<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"/>', types);
  const [d] = one('<v:shape id="Text Box 2" type="#_x0000_t202" fillcolor="#ffc" strokecolor="red" strokeweight="2pt" style="position:absolute;width:100pt;height:50pt;v-text-anchor:middle;mso-wrap-style:none">'
    + '<v:fill opacity="0.5"/><v:stroke dashstyle="dash"/><v:textbox inset="1pt,2pt,,0" style="mso-fit-shape-to-text:t;layout-flow:vertical"><w:txbxContent><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape>', types);
  const wsp = find(d, 'wps:wsp');
  assert.equal(at(find(wsp, 'a:prstGeom'), 'prst'), 'rect');
  assert.equal(txt(find(find(wsp, 'wps:txbx'), 'w:t')), 'Hello');
  assert.equal(at(find(wsp, 'wps:cNvSpPr'), 'txBox'), '1');
  const sp = find(wsp, 'wps:spPr');
  assert.deepEqual([at(find(kids(sp, 'a:solidFill')[0], 'a:srgbClr'), 'val'), at(find(sp, 'a:alpha'), 'val')], ['FFFFCC', '50000']);
  const ln = find(sp, 'a:ln');
  assert.deepEqual([at(ln, 'w'), at(find(ln, 'a:srgbClr'), 'val'), at(find(ln, 'a:prstDash'), 'val')], ['25400', 'FF0000', 'dash']);
  const body = find(wsp, 'wps:bodyPr');
  assert.deepEqual(['lIns', 'tIns', 'rIns', 'bIns', 'anchor', 'wrap', 'vert'].map((k) => at(body, k)), ['12700', '25400', '91440', '0', 'ctr', 'none', 'vert']);
  assert.ok(find(body, 'a:spAutoFit'));
  const [bare] = one('<v:shape type="#_x0000_t202" filled="f" stroked="f" style="width:1pt;height:1pt"><v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox></v:shape>');
  assert.ok(find(find(bare, 'wps:spPr'), 'a:noFill'));
  assert.ok(find(find(bare, 'a:ln'), 'a:noFill'));
  assert.equal(at(find(bare, 'wps:bodyPr'), 'lIns'), '91440', 'the default inset is 0.1in, 0.05in');
});

test('VML shapes: rect, roundrect, oval, line, polyline, curve, a shapetype preset and a path', () => {
  const geom = (xml, types) => { const d = one(xml, types)[0]; return at(find(d, 'a:prstGeom'), 'prst') ?? (find(d, 'a:custGeom') && 'cust'); };
  assert.equal(geom('<v:rect style="width:1pt;height:1pt"/>'), 'rect');
  assert.equal(geom('<v:oval style="width:1pt;height:1pt"/>'), 'ellipse');
  const [rr] = one('<v:roundrect arcsize="10923f" style="width:1pt;height:1pt"/>');
  assert.deepEqual([at(find(rr, 'a:prstGeom'), 'prst'), at(find(rr, 'a:gd'), 'fmla')], ['roundRect', 'val 16667']);
  assert.equal(geom('<v:shape type="#_x0000_t5" style="width:1pt;height:1pt"/>'), 'triangle', 'the spt in a shapetype id names its preset');
  assert.equal(geom('<v:shape o:spt="110" style="width:1pt;height:1pt"/>'), 'flowChartDecision');
  assert.equal(geom('<v:shape coordsize="100,100" path="m0,0l100,0,50,100xe" style="width:1pt;height:1pt"/>'), 'cust');

  const [line] = one('<v:line from="100pt,50pt" to="10pt,80pt" strokeweight="1.5pt" style="position:absolute;z-index:1"><v:stroke endarrow="block" endarrowwidth="wide" startarrow="oval"/></v:line>');
  const a = kids(line)[0];
  assert.equal(at(find(a, 'a:prstGeom'), 'prst'), 'line');
  assert.deepEqual([txt(find(find(a, 'wp:positionH'), 'wp:posOffset')), txt(find(find(a, 'wp:positionV'), 'wp:posOffset'))], [String(10 * 12700), String(50 * 12700)]);
  assert.deepEqual([at(find(a, 'wp:extent'), 'cx'), at(find(a, 'wp:extent'), 'cy')], [String(90 * 12700), String(30 * 12700)]);
  assert.deepEqual([at(find(a, 'a:xfrm'), 'flipH'), at(find(a, 'a:xfrm'), 'flipV')], ['1', undefined], 'right to left and downward');
  assert.deepEqual([at(find(a, 'a:tailEnd'), 'type'), at(find(a, 'a:tailEnd'), 'w'), at(find(a, 'a:headEnd'), 'type')], ['triangle', 'lg', 'oval']);
  assert.ok(find(find(a, 'wps:spPr'), 'a:noFill'), 'a line has no fill');

  const [poly] = one('<v:polyline points="10pt,10pt,40pt,10pt,40pt,30pt" filled="f" style="position:absolute"/>');
  const path = find(poly, 'a:path');
  assert.deepEqual([at(path, 'w'), at(path, 'h')], [String(30 * 12700), String(20 * 12700)]);
  assert.deepEqual(deep(path, 'a:pt').map((p) => [+at(p, 'x') / 12700, +at(p, 'y') / 12700]), [[0, 0], [30, 0], [30, 20]]);
  const [curve] = one('<v:curve from="0,0" control1="10pt,0" control2="10pt,10pt" to="0,10pt"/>');
  assert.equal(deep(find(curve, 'a:cubicBezTo'), 'a:pt').length, 3);
});

test('a VML group becomes wpg:wgp with its coordinate space; children keep their kinds', () => {
  const [d] = one('<v:group coordorigin="100,100" coordsize="200,100" style="position:absolute;width:200pt;height:100pt">'
    + '<v:rect style="position:absolute;left:100;top:100;width:100;height:50"/><v:oval style="position:absolute;left:200;top:150;width:100;height:50"/>'
    + '<v:group coordsize="10,10" style="position:absolute;left:100;top:150;width:50;height:50"><v:line from="0,0" to="10,10"/></v:group>'
    + '<v:shape style="position:absolute;left:250;top:100;width:50;height:50" type="#_x0000_t202"><v:textbox><w:txbxContent><w:p><w:r><w:t>In group</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></v:group>');
  const g = find(d, 'wpg:wgp');
  const x = find(kids(g, 'wpg:grpSpPr')[0], 'a:xfrm');
  assert.deepEqual(['a:off', 'a:ext', 'a:chOff', 'a:chExt'].map((n) => Object.values(find(x, n).attrs).map(Number)), [[0, 0], [2540000, 1270000], [1270000, 1270000], [2540000, 1270000]]);
  assert.deepEqual(kids(g).map((k) => k.name), ['wpg:cNvGrpSpPr', 'wpg:grpSpPr', 'wps:wsp', 'wps:wsp', 'wpg:grpSp', 'wps:wsp']);
  const off = (n) => Object.values(find(find(n, 'a:xfrm'), 'a:off').attrs).map(Number);
  assert.deepEqual(off(kids(g, 'wps:wsp')[1]), [200 * 12700, 150 * 12700], 'child offsets in the group\'s child space');
  assert.equal(at(find(kids(g, 'wpg:grpSp')[0], 'a:prstGeom'), 'prst'), 'line');
  assert.equal(at(find(kids(g, 'wpg:grpSp')[0], 'a:ext'), 'cx'), String(50 * 12700));
  assert.equal(txt(find(g, 'w:t')), 'In group');
});

test('Word\'s horizontal line (o:hr) is an inline grey bar the width of the column; an OLE object shows its preview', () => {
  const [hr] = one('<v:rect style="width:0;height:1.5pt" o:hralign="center" o:hrstd="t" o:hr="t"/>');
  const i = kids(hr)[0];
  assert.equal(i.name, 'wp:inline');
  assert.deepEqual([at(find(i, 'wp:extent'), 'cy'), txt(find(i, 'wp14:pctWidth')), at(find(i, 'wp14:sizeRelH'), 'relativeFrom')], ['19050', '100000', 'margin']);
  assert.equal(at(find(find(i, 'a:solidFill'), 'a:srgbClr'), 'val'), 'A0A0A0');
  assert.ok(find(find(i, 'a:ln'), 'a:noFill'));
  assert.equal(txt(find(one('<v:rect style="width:0;height:1pt" o:hr="t" o:hrpct="500"/>')[0], 'wp14:pctWidth')), '50000');

  const obj = vmlDrawings(parseXml(`<w:object ${NS} w:dxaOrig="1440" w:dyaOrig="720"><v:shapetype id="_x0000_t75" o:spt="75" filled="f" stroked="f"/>`
    + '<v:shape type="#_x0000_t75" style="width:72pt;height:36pt"><v:imagedata r:id="rId9"/></v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" r:id="rId10"/></w:object>'));
  assert.equal(obj.length, 1);
  assert.equal(at(find(obj[0], 'a:blip'), 'r:embed'), 'rId9');
});

test('v:arc becomes the DrawingML arc preset: VML angles run clockwise from 12 o\'clock, DrawingML\'s from 3 o\'clock', () => {
  const adj = (xml) => { const d = one(xml)[0]; return [at(find(d, 'a:prstGeom'), 'prst'), ...deep(d, 'a:gd').map((g) => `${at(g, 'name')} ${at(g, 'fmla')}`)]; };
  assert.deepEqual(adj('<v:arc style="width:100pt;height:100pt"/>'), ['arc', 'adj1 val 16200000', 'adj2 val 0'], 'the defaults, 0 to 90: top to right');
  assert.deepEqual(adj('<v:arc style="width:100pt;height:60pt" startangle="-90" endangle="180"/>'), ['arc', 'adj1 val 10800000', 'adj2 val 5400000'], 'left, clockwise to the bottom');
  assert.deepEqual(adj('<v:arc style="width:1pt;height:1pt" startangle="5898240fd" endangle="450"/>'), ['arc', 'adj1 val 0', 'adj2 val 0'], '90 degrees in 65536ths; past 360');
  const [d] = one('<v:arc style="position:absolute;margin-left:10pt;margin-top:0;width:100pt;height:100pt;z-index:1" strokecolor="red" strokeweight="2pt" filled="f"/>');
  assert.equal(kids(d)[0].name, 'wp:anchor');
  assert.ok(find(find(d, 'wps:spPr'), 'a:noFill'));
  assert.deepEqual([at(find(find(d, 'a:ln'), 'a:srgbClr'), 'val'), at(find(d, 'a:ln'), 'w')], ['FF0000', '25400']);
});

test('VML WordArt (v:textpath) keeps its words: the string as the shape\'s text in its font, size, bold and italic, the fill as its colour', async () => {
  const T136 = '<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" path="m@7,l@8,m@5,21600l@6,21600e"><v:path textpathok="t"/><v:textpath on="t" fitshape="t"/></v:shapetype>';
  const [d] = one(`${T136}<v:shape type="#_x0000_t136" style="position:absolute;width:200pt;height:50pt;z-index:1" fillcolor="#0070c0" stroked="f">`
    + '<v:textpath style="font-family:&quot;Arial Black&quot;;font-size:28pt;font-weight:bold;font-style:italic" string="Hello WordArt"/></v:shape>');
  const sp = find(d, 'wps:spPr');
  assert.ok(find(sp, 'a:noFill') && find(find(sp, 'a:ln'), 'a:noFill'), 'the shape itself draws nothing');
  const rPr = find(d, 'a:rPr');
  assert.deepEqual([txt(find(d, 'a:t')), at(rPr, 'b'), at(rPr, 'i'), at(find(rPr, 'a:srgbClr'), 'val'), at(find(rPr, 'a:latin'), 'typeface'), at(find(d, 'a:pPr'), 'algn')],
    ['Hello WordArt', '1', '1', '0070C0', 'Arial Black', 'ctr']);
  // Fitted to its shape (the shapetype's fitshape): the size whose 13 characters fit 200 pt (0.6 em each), not the style's 28 pt.
  assert.equal(at(rPr, 'sz'), String(Math.round((200 / (13 * 0.6)) * 100)));
  const [own] = one('<v:shape style="width:100pt;height:20pt" fillcolor="red" filled="f" strokecolor="blue"><v:textpath on="t" style="font-family:Calibri;font-size:12pt" string="One&#xA;Two"/></v:shape>');
  assert.deepEqual(deep(own, 'a:t').map(txt), ['One', 'Two'], 'a line each');
  assert.deepEqual([at(find(own, 'a:rPr'), 'sz'), at(find(find(own, 'a:rPr'), 'a:srgbClr'), 'val')], ['1200', '0000FF'], 'its own size without fitshape; no fill: the line colour');
  assert.equal(find(one('<v:shape style="width:1pt;height:1pt"><v:textpath on="f" string="hidden"/></v:shape>')[0], 'a:t'), null, 'textpath off: no text');

  // In the app: a canvas whose shape's label shows the words (shapes-in.mjs reads the DrawingML text).
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ${NS.replace(/xmlns:(w|r)="\w+" /g, '')}`;
  const bytes = await writeZip([['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<w:document ${W}><w:body><w:p><w:r><w:pict>${T136}<v:shape type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:300pt;height:100pt;rotation:315;z-index:-1"`
      + ' fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="DRAFT"/></v:shape></w:pict></w:r></w:p></w:body></w:document>']]);
  const { doc, dropped } = await importDocx(bytes, { fresh: true });
  assert.deepEqual(dropped, []);
  const item = doc.content.find((n) => n.type === 'canvas').attrs.items[0];
  assert.deepEqual([item.html, item.textColor, item.font, item.align, item.valign, item.rot, item.fill, item.width], ['DRAFT', '#C0C0C080', 'Calibri', 'center', 'middle', 315, 'none', 0]);
  assert.equal(Math.round(item.size * 0.75), Math.round(100 / 1.2), 'the watermark\'s 1 pt text fills its 100 pt height');
});

test('docx import: a positioned VML picture keeps its size and place, a VML text box its text, and nothing is reported as left out', async () => {
  const { writeZip } = await import('../src/document/docx/zip.mjs');
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ${NS.replace(/xmlns:(w|r)="\w+" /g, '')}`;
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'],
    ['word/media/image1.png', PNG],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>`
      + '<w:p><w:r><w:pict><v:shape id="Logo" style="position:absolute;margin-left:72pt;margin-top:36pt;width:150pt;height:75pt;z-index:251660288;mso-position-horizontal-relative:page;mso-position-vertical-relative:page">'
      + '<v:imagedata r:id="rId7" o:title="logo"/><w10:wrap type="square"/></v:shape></w:pict></w:r><w:r><w:t>Body</w:t></w:r></w:p>'
      + '<w:p><w:r><w:pict><v:shape type="#_x0000_t202" filled="f" style="position:absolute;margin-left:0;margin-top:0;width:200pt;height:40pt;z-index:251661312">'
      + '<v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:r><w:t>Boxed</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r><w:r><w:t>Anchor</w:t></w:r></w:p>'
      + '</w:body></w:document>'],
  ]);
  const { doc, dropped } = await importDocx(bytes, { fresh: true });
  assert.deepEqual(dropped, []);
  const img = doc.content[0].content[0];
  assert.equal(img.type, 'image');
  assert.deepEqual([img.attrs.width, img.attrs.height, img.attrs.name], [200, 100, 'Logo']);
  assert.deepEqual([img.attrs.layout.wrap, img.attrs.layout.h, img.attrs.layout.v], ['square', { rel: 'page', offset: 72 }, { rel: 'page', offset: 36 }]);
  const box = doc.content[1];
  assert.equal(box.type, 'textBox');
  assert.deepEqual([box.attrs.w, box.attrs.h, box.attrs.fill, box.attrs.line?.color, box.attrs.inset], [200, 40, null, '#000000', { t: 0, r: 0, b: 0, l: 0 }]);
  assert.equal(box.content[0].content[0].text, 'Boxed');
  assert.equal(doc.content[2].content[0].text, 'Anchor');
});

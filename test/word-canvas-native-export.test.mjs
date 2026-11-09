// canvas-native-export (docs/plans/word/briefs/canvas-native-export.md): a Document's canvas exports as a Word drawing canvas
// whatever it holds. Pen strokes go out as Word ink (InkML parts), text items as text boxes with no line, SVG pictures as pic:pic
// with their SVG and a PNG; import reads each back as the item it came from, and Word's own ink as a pen stroke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx, parseXml } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { PLAIN_FMT, svgKey } from '../src/document/docx/dml.mjs';
import { canvasOf } from '../src/document/docx/shapes-in.mjs';
import { shapeCanvas, strokeLines } from '../src/document/docx/shapes-out.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { smoothPath as smooth } from '../src/flow/model.mjs';
import { THEME } from '../src/document/defaults.mjs';

// A stroke item through points, as Board.finishStroke makes one with the pen's path (smoothPath).
function stroke(id, pts, ink) {
  const pad = ink.width / 2 + 1;
  const x = Math.floor(Math.min(...pts.map((q) => q.x)) - pad);
  const y = Math.floor(Math.min(...pts.map((q) => q.y)) - pad);
  const w = Math.ceil(Math.max(...pts.map((q) => q.x)) + pad) - x;
  const h = Math.ceil(Math.max(...pts.map((q) => q.y)) + pad) - y;
  return { id, type: 'stroke', x, y, w, h, vw: w, vh: h, d: smooth(pts.map((q) => ({ x: q.x - x, y: q.y - y }))), ...ink };
}
// A wavy pen line sampled as a pointer gives it (uneven steps, fractions of a px).
const wave = Array.from({ length: 23 }, (_, i) => ({ x: 214.37 + i * 6.13 + (i % 3) * 0.41, y: 96.2 + Math.sin(i / 2.5) * 22.7 }));
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#c00"/></svg>').toString('base64')}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ITEMS = [
  { id: 's1', type: 'shape', shape: 'ellipse', x: 20, y: 20, w: 120, h: 80, color: '#1F3864', width: 2, opacity: 1, fill: 'solid', fillColor: '#4472C4' },
  stroke('k1', wave, { color: '#e71224', width: 1.89, opacity: 1 }),
  { id: 't1', type: 'text', html: 'A label <b>with</b> words<br>on two lines', x: 40, y: 140, w: 180, h: 64, size: 20, color: '#1F2328', bold: false, align: 'left', bg: null },
  { id: 'p1', type: 'image', src: SVG, fallback: { src: PNG, of: svgKey(SVG) }, x: 300, y: 150, w: 60, h: 60 },
];
const canvas = (items, more = {}) => ({ type: 'canvas', attrs: { w: 420, h: 240, dw: 420, frame: { x: 0, y: 0, w: 420, h: 240 }, bg: 'transparent', items, ...more } });
const docOf = (...nodes) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before' }] }, ...nodes, { type: 'paragraph' }] });
const canvasesOf = (doc) => doc.content.filter((n) => n.type === 'canvas');
const noId = ({ id, ...it }) => it;
// The points a stroke's pen path is drawn through (its M point, Q control points and L end), in canvas px.
const samples = (it) => strokeLines(it)[0].filter((_, i, a) => i % 2 || !i || i === a.length - 1);

async function roundTrip(doc, fresh = true) {
  const out = await exportDocx(doc);
  const zip = await readZip(out.bytes);
  return { out, zip, xml: text(zip.get('word/document.xml')), back: await importDocx(out.bytes, { fresh }) };
}

test('a canvas of a shape, a pen stroke, a text item and an SVG picture goes out as one Word drawing canvas', async () => {
  assert.ok(shapeCanvas(canvas(ITEMS).attrs), 'every item has a Word form');
  const { out, zip, xml } = await roundTrip(docOf(canvas(ITEMS)));
  assert.deepEqual(out.dropped ?? [], []);
  assert.equal((xml.match(/<wpc:wpc>/g) ?? []).length, 1, 'one drawing canvas');
  assert.doesNotMatch(xml, /<a:graphicData uri="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/picture">/, 'no picture of the canvas');
  const wpc = /<wpc:wpc>([^]*)<\/wpc:wpc>/.exec(xml)[1];
  assert.match(wpc, /<wps:wsp><wps:cNvPr [^>]*\/><wps:cNvSpPr\/><wps:spPr>[^]*prst="ellipse"/, 'the shape');
  assert.match(wpc, /<w14:contentPart bwMode="auto" r:id="(rId\d+)"><w14:nvContentPartPr><w14:cNvPr id="\d+" name="Ink \d+"\/><w14:cNvContentPartPr\/><\/w14:nvContentPartPr><w14:xfrm><a:off [^>]*\/><a:ext [^>]*\/><\/w14:xfrm><\/w14:contentPart>/, 'the stroke as ink');
  assert.match(wpc, /<wps:cNvSpPr txBox="1"\/><wps:spPr>[^]*<a:noFill\/><a:ln><a:noFill\/><\/a:ln><\/wps:spPr><wps:txbx><w:txbxContent>[^]*A label [^]*<\/w:txbxContent><\/wps:txbx><wps:bodyPr [^>]*><a:prstTxWarp [^>]*><a:avLst\/><\/a:prstTxWarp><a:spAutoFit\/><\/wps:bodyPr>/, 'the text item as a text box with no line');
  assert.match(wpc, /<w:pPr><w:spacing w:after="0" w:line="390" w:lineRule="atLeast"\/><w:jc w:val="left"\/><\/w:pPr><w:r>[^]*A label /, 'the board\'s 1.3 line height: 20 px is 15 pt, lines at least 19.5 pt');
  assert.match(wpc, /<pic:pic>[^]*<a:blip r:embed="rId\d+"><a:extLst><a:ext uri="\{96DAC541-7B7A-43D3-8B79-37D633B846F1\}"><asvg:svgBlip [^>]*r:embed="rId\d+"\/>/, 'the SVG beside its PNG');
  // The ink part: InkML Word reads, typed and related as Word's Draw tab writes it.
  const rid = /<w14:contentPart [^>]*r:id="(rId\d+)"/.exec(wpc)[1];
  const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(text(zip.get('word/_rels/document.xml.rels')))[1];
  assert.equal(target, 'ink/ink1.xml');
  assert.match(text(zip.get('[Content_Types].xml')), /PartName="\/word\/ink\/ink1\.xml" ContentType="application\/inkml\+xml"/);
  const ink = text(zip.get('word/ink/ink1.xml'));
  assert.match(ink, /<inkml:brushProperty name="width" value="0\.050006" units="cm"\/>.*name="color" value="#e71224"\/>.*name="fitToCurve" value="1"\/>/);
  assert.equal((ink.match(/<inkml:trace /g) ?? []).length, 1);
  assert.match(text(zip.get('word/_rels/document.xml.rels')), /media\/image\d+\.svg/);
});

test('import reads the drawing canvas back as the same items, and a second round trip keeps them', async () => {
  const first = await roundTrip(docOf(canvas(ITEMS)));
  assert.deepEqual(first.back.dropped, []);
  const [cv] = canvasesOf(first.back.doc);
  const [shape, ink, label, pic] = cv.attrs.items;
  assert.deepEqual([shape.type, shape.shape, shape.x, shape.y, shape.w, shape.h, shape.fillColor], ['shape', 'ellipse', 20, 20, 120, 80, '#4472C4']);
  assert.deepEqual(noId(ink), noId(ITEMS[1]), 'the pen stroke, its path to the tenth of a px');
  assert.deepEqual(noId(label), noId(ITEMS[2]), 'the text item');
  assert.deepEqual(noId(pic), noId(ITEMS[3]), 'the SVG with its PNG');
  const second = await roundTrip(first.back.doc);
  assert.deepEqual(canvasesOf(second.back.doc)[0].attrs.items, cv.attrs.items, 'the same items again');
  // Through the stash, as this app reopens its own file, the canvas comes back whole.
  const own = await importDocx(first.out.bytes);
  assert.deepEqual(canvasesOf(own.doc)[0].attrs.items, ITEMS);
});

test('pen kinds, turns and stretches: the highlighter and pencil as Word\'s brushes, a turned stroke drawn where it was', async () => {
  const pen = (id, opacity, more = {}) => ({ ...stroke(id, wave.slice(0, 9), { color: '#FFFF00', width: 22.68, opacity }), ...more });
  const items = [pen('h', 0.35), pen('c', 0.7), pen('o', 0.5), { ...pen('r', 1), rot: 30, mirrorX: true }, { ...pen('z', 1), w: 140, y: 150 }];
  const { zip, back } = await roundTrip(docOf(canvas(items)));
  const inks = [1, 2, 3].map((n) => text(zip.get(`word/ink/ink${n}.xml`)));
  assert.match(inks[0], /name="tip" value="rectangle"\/><inkml:brushProperty name="rasterOp" value="maskPen"\/>/, 'the highlighter');
  assert.match(inks[1], /name="inkEffects" value="pencil"\/>/, 'the pencil');
  assert.match(inks[2], /name="transparency" value="128"\/>/, 'half opaque');
  const got = canvasesOf(back.doc)[0].attrs.items;
  assert.deepEqual(got.slice(0, 3).map((i) => [i.opacity, i.color, i.width]), [[0.35, '#FFFF00', 22.68], [0.7, '#FFFF00', 22.68], [0.5, '#FFFF00', 22.68]]);
  assert.deepEqual(noId(got[0]), noId(items[0]));
  // A turned and mirrored stroke, and a stretched one, come back drawn through the same points, their turn and stretch in the path.
  for (const i of [3, 4]) {
    const [a, b] = [strokeLines(items[i])[0], strokeLines(got[i])[0]];
    assert.ok(!got[i].rot && !got[i].mirrorX && got[i].w === got[i].vw, 'no turn or stretch of its own');
    assert.ok(a.length && a.every((p, j) => Math.hypot(p.x - b[j].x, p.y - b[j].y) < 0.15), `stroke ${i} drawn through the same points`);
  }
});

test('an agent\'s stroke with curves of its own, a sticky note and a fitted text go out natively too', async () => {
  const items = [
    { id: 'a', type: 'stroke', x: 10, y: 50, w: 100, h: 60, vw: 50, vh: 30, d: 'M0 0C10 30 40 30 50 0s20-20 30 0', color: '#0078d4', width: 3, opacity: 1 },
    { id: 'n', type: 'text', html: 'Note', x: 150, y: 20, w: 120, h: 40, size: 16, color: '#000000', bold: true, align: 'center', bg: '#FFF59D', fit: true },
  ];
  const { xml, back } = await roundTrip(docOf(canvas(items)));
  assert.match(xml, /<wpc:wpc>[^]*<w14:contentPart [^]*<wps:cNvSpPr txBox="1"\/>[^]*<a:solidFill><a:srgbClr val="FFF59D"\/><\/a:solidFill><a:ln><a:noFill\/><\/a:ln>[^]*wrap="none"/);
  const [a, n] = canvasesOf(back.doc)[0].attrs.items;
  assert.equal(a.type, 'stroke');
  const [before, after] = [strokeLines(items[0])[0], samples(a)];
  assert.equal(after.length, before.length, 'sampled along both curves');
  assert.ok(before.every((p, j) => Math.hypot(p.x - after[j].x, p.y - after[j].y) < 0.15));
  assert.deepEqual(noId(n), noId(items[1]), 'the note keeps its colour, bold, centring and fitted width');
});

test('a text background with transparency goes out as Word\'s fill transparency and comes back', async () => {
  const items = [{ id: 'h', type: 'text', html: 'Half', x: 20, y: 20, w: 120, h: 40, size: 16, color: '#000000', bold: false, align: 'left', bg: '#4A7FE080', fit: true }];
  const { xml, back } = await roundTrip(docOf(canvas(items)));
  // 0x80 is Word's 50 % transparency (whole percents, as the other fills: dml.mjs alphaVal)
  assert.match(xml, /<wps:cNvSpPr txBox="1"\/>[^]*<a:solidFill><a:srgbClr val="4A7FE0"><a:alpha val="50000"\/><\/a:srgbClr><\/a:solidFill>/);
  assert.equal(canvasesOf(back.doc)[0].attrs.items[0].bg.toUpperCase(), '#4A7FE080');
});

test('a canvas still goes out as a picture only for items Word has no form for', () => {
  const bound = { id: 'c', type: 'connector', from: { item: 's1' }, to: { x: 300, y: 40 }, route: 'straight', points: [], labels: {}, heads: { start: 'none', end: 'arrow' }, color: '#000', width: 2 };
  assert.equal(shapeCanvas(canvas([ITEMS[0], bound]).attrs), false, 'a connector bound to an item');
  assert.equal(shapeCanvas(canvas([ITEMS[1], { ...ITEMS[3], src: 'data:image/webp;base64,AAAA', fallback: undefined }]).attrs), false, 'a WebP picture');
  assert.equal(shapeCanvas(canvas([ITEMS[3]]).attrs), false, 'one picture alone stays that picture');
  assert.equal(shapeCanvas(canvas([ITEMS[1]]).attrs), true, 'one pen stroke alone is a drawing canvas');
});

test('an SVG with no PNG to go beside it keeps its canvas a picture outside a browser', async () => {
  const { xml } = await roundTrip(docOf(canvas([ITEMS[0], { ...ITEMS[3], fallback: undefined }])));
  assert.doesNotMatch(xml, /<wpc:wpc>/);
});

// Word's own ink in a drawing canvas: the fixture's Draw part wave (first and second differences, a force channel) in a pencil.
const WAVE = '<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:definitions><inkml:context xml:id="ctx0"><inkml:inkSource xml:id="inkSrc0"><inkml:traceFormat>'
  + '<inkml:channel name="X" type="integer" max="32767" units="cm"/><inkml:channel name="Y" type="integer" max="32767" units="cm"/><inkml:channel name="F" type="integer" max="32767" units="dev"/></inkml:traceFormat>'
  + '<inkml:channelProperties><inkml:channelProperty channel="X" name="resolution" value="1000" units="1/cm"/><inkml:channelProperty channel="Y" name="resolution" value="1000" units="1/cm"/></inkml:channelProperties></inkml:inkSource></inkml:context>'
  + '<inkml:brush xml:id="br0"><inkml:brushProperty name="width" value="0.1" units="cm"/><inkml:brushProperty name="height" value="0.1" units="cm"/><inkml:brushProperty name="color" value="#404040"/>'
  + '<inkml:brushProperty name="inkEffects" value="pencil"/></inkml:brush></inkml:definitions>'
  + '<inkml:trace contextRef="#ctx0" brushRef="#br0">200 400 4000,\'300\'-250\'8000,"0"500"2000,0 0 0,0-500-20000,0 0 0,0 500 4000,-100-100 2000</inkml:trace></inkml:ink>';
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const ctx = (parts = {}) => ({ dml: { colors: THEME.colors, fonts: THEME.fonts, fmt: PLAIN_FMT }, fonts: THEME.fonts, text: { size: 11, color: '#000000', font: null },
  picture: () => null, partXml: (rid) => (parts[rid] ? parseXml(parts[rid]) : null), drop: () => {} });

test('Word\'s ink in a drawing canvas reads as a pen stroke stretched to its drawing\'s box', () => {
  // The wave's points span 2000 x 500 units; Word draws them across the contentPart's 2.4 x 0.8 cm box (Word's fallback picture
  // of the fixture's ink fills its frame), here at 96 px from the canvas's left.
  const part = '<w14:contentPart bwMode="auto" r:id="rIdK"><w14:nvContentPartPr><w14:cNvPr id="2" name="Ink 2"/><w14:cNvContentPartPr/></w14:nvContentPartPr>'
    + '<w14:xfrm><a:off x="914400" y="0"/><a:ext cx="864000" cy="288000"/></w14:xfrm></w14:contentPart>';
  const gd = parseXml(`<a:graphicData ${NS} uri="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"><wpc:wpc><wpc:bg/><wpc:whole/>${part}</wpc:wpc></a:graphicData>`);
  const [it] = canvasOf(gd, 2743200, 914400, ctx({ rIdK: WAVE })).attrs.items;
  assert.equal(it.type, 'stroke');
  assert.deepEqual([it.color, it.width, it.opacity], ['#404040', 3.7795, 0.7], 'the pencil\'s colour, 1 mm, the board\'s pencil');
  const pts = samples(it);
  const [w, h] = [864000 / 9525, 288000 / 9525];
  const want = [[200, 400], [500, 150], [800, 400], [1100, 650], [1400, 400], [1700, 150], [2000, 400], [2200, 550]]
    .map(([x, y]) => ({ x: 96 + ((x - 200) * w) / 2000, y: 3 + ((y - 150) * h) / 500 })); // 3: the canvas grew up to the pencil's padded box
  assert.equal(pts.length, 8);
  assert.ok(pts.every((p, i) => Math.hypot(p.x - want[i].x, p.y - want[i].y) < 0.1), JSON.stringify(pts));
  // Without its part the ink stays a framed box, as before.
  assert.equal(canvasOf(gd, 2743200, 914400, ctx()).attrs.items[0].placeholder, 'ink in groups');
});

test('a text box in a drawing canvas reads as a text item only while it is the app\'s plain label', () => {
  const APP = '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>';
  const box = (spPr, pPr = APP) => `<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><wps:cNvPr id="3" name="Text Box 3"/><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="457200"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPr}</wps:spPr><wps:txbx><w:txbxContent><w:p>${pPr}<w:r><w:t>Hello</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp>`;
  const read = (xml) => canvasOf(parseXml(`<a:graphicData ${NS} uri="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"><wpc:wpc>${xml}</wpc:wpc></a:graphicData>`), 1371600, 457200, ctx()).attrs.items[0];
  const plain = read(box('<a:noFill/><a:ln><a:noFill/></a:ln>'));
  assert.deepEqual([plain.type, plain.html, plain.w, plain.h, plain.size, plain.color, plain.bg], ['text', 'Hello', 144, 48, 14.67, '#000000', null]);
  const lined = read(box('<a:noFill/><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'));
  assert.deepEqual([lined.type, lined.shape, lined.html], ['shape', 'rect', 'Hello'], 'a text box with a line stays a shape');
  const word = read(box('<a:noFill/><a:ln><a:noFill/></a:ln>', ''));
  assert.deepEqual([word.type, word.shape, word.html], ['shape', 'rect', 'Hello'], 'one Word made, with Word\'s paragraph spacing, stays a shape');
  // Word rewrites the paragraph as the label is edited in Word: a paragraph mark's run properties, attributes in its own order.
  const edited = '<w:pPr><w:spacing w:lineRule="atLeast" w:line="390" w:after="0"/><w:jc w:val="center"/><w:rPr><w:sz w:val="30"/></w:rPr></w:pPr>';
  const kept = read(box('<a:noFill/><a:ln><a:noFill/></a:ln>', edited));
  assert.deepEqual([kept.type, kept.align, kept.pPr], ['text', 'center', undefined], 'still the app\'s label');
  const justified = read(box('<a:noFill/><a:ln><a:noFill/></a:ln>', APP.replace('left', 'both')));
  assert.equal(justified.type, 'shape', 'justified text the board cannot draw stays a shape');
});

test('a group of items with ink goes out as a wpg:wgp and reads back with its group', async () => {
  const items = [{ ...ITEMS[0], groups: ['g'] }, { ...ITEMS[1], groups: ['g'] }];
  const { xml, back } = await roundTrip(docOf(canvas(items)));
  assert.match(xml, /uri="http:\/\/schemas\.microsoft\.com\/office\/word\/2010\/wordprocessingGroup"><wpg:wgp>[^]*<w14:contentPart /);
  const got = canvasesOf(back.doc)[0].attrs.items;
  assert.deepEqual(got.map((i) => i.type), ['shape', 'stroke']);
  assert.ok(got.every((i) => i.groups?.length === 1) && got[0].groups[0] === got[1].groups[0], 'one group');
  assert.deepEqual(noId({ ...got[1], groups: undefined }), noId({ ...ITEMS[1], groups: undefined }));
});

// A whole .docx Word could have written: the ink's part through the document's relationships.
test('a .docx with a drawing canvas holding ink imports the ink as a stroke, and the stroke exports as ink again', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
  const body = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2743200" cy="914400"/><wp:docPr id="1" name="Canvas 1"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas">'
    + '<wpc:wpc><wpc:bg/><wpc:whole/><w14:contentPart bwMode="auto" r:id="rId5"><w14:nvContentPartPr><w14:cNvContentPartPr/></w14:nvContentPartPr><w14:xfrm><a:off x="95250" y="95250"/><a:ext cx="864000" cy="288000"/></w14:xfrm></w14:contentPart>'
    + '</wpc:wpc></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`],
    ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="ink/ink1.xml"/></Relationships>'],
    ['word/ink/ink1.xml', WAVE],
  ]);
  const read = await importDocx(bytes, { fresh: true });
  assert.deepEqual(read.dropped, []);
  const [cv] = canvasesOf(read.doc);
  assert.deepEqual(cv.attrs.items.map((i) => i.type), ['stroke']);
  const again = await roundTrip(read.doc);
  assert.match(again.xml, /<wpc:wpc>[^]*<w14:contentPart [^]*<\/wpc:wpc>/);
  const [it] = canvasesOf(again.back.doc)[0].attrs.items;
  assert.deepEqual(noId(it), noId(cv.attrs.items[0]), 'the same stroke after a round trip of the app\'s own');
});

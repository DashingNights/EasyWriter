// metafile-everywhere (docs/plans/word/briefs/metafile-everywhere.md): every way a picture comes in draws EMF and WMF through the
// one reader (src/tooling/metafile.mjs): picture bullets and pictures in drawing canvases from a .docx, which export as they came,
// and picture files of any editor (whiteboard.js readImage and picture-format's replacePicture, both on tooling/picture.mjs pictureOfUrl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocx } from '../src/document/docx/import.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { shapeCanvas } from '../src/document/docx/shapes-out.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { drawMetafiles, metafileKind, metafilePicture, metafileOfUrl, metafileSize } from '../src/tooling/metafile.mjs';
import { patched } from '../src/app/commands/board.mjs';

/** An EMF of 72 x 48 pt (a 1 x 2/3 inch frame) holding one rectangle. */
function emf() {
  const b = new Uint8Array(88 + 24 + 20);
  const v = new DataView(b.buffer);
  const put = (list) => list.forEach(([at, n]) => v.setInt32(at, n, true));
  // EMR_HEADER: bounds, frame (0.01 mm), " EMF", version, size, 3 records, a 1920 x 1080 px device of 508 x 286 mm.
  put([[0, 1], [4, 88], [16, 95], [20, 63], [32, 2540], [36, 1693], [40, 0x464d4520], [44, 0x10000], [48, b.length], [52, 3], [72, 1920], [76, 1080], [80, 508], [84, 286]]);
  put([[88, 43], [92, 24], [96, 10], [100, 10], [104, 80], [108, 50]]); // EMR_RECTANGLE
  put([[112, 14], [116, 20], [124, 16], [128, 20]]); // EMR_EOF
  return b;
}
/** A placeable WMF one inch square (1440 units) holding one rectangle. */
function wmf() {
  const recs = [[0x041b, [100, 1300, 1300, 100]], [0, []]].map(([fn, p]) => {
    const r = new Uint8Array(6 + p.length * 2);
    const v = new DataView(r.buffer);
    v.setUint32(0, r.length / 2, true);
    v.setUint16(4, fn, true);
    p.forEach((n, i) => v.setInt16(6 + i * 2, n, true));
    return r;
  });
  const size = 40 + recs.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x9ac6cdd7, true);
  [0, 0, 1440, 1440, 1440].forEach((n, i) => v.setInt16(6 + i * 2, n, true));
  [1, 9, 0x300].forEach((n, i) => v.setUint16(22 + i * 2, n, true));
  v.setUint32(28, (size - 22) / 2, true);
  v.setUint16(32, 1, true);
  let at = 40;
  for (const r of recs) out.set(r, at), at += r.length;
  return out;
}
/** An EMF whose drawing is in EMF+ records only (the reader leaves it to the fallback). */
function emfPlusOnly() {
  const b = new Uint8Array(88 + 44 + 20);
  const v = new DataView(b.buffer);
  const put = (list) => list.forEach(([at, n]) => v.setUint32(at, n, true));
  put([[0, 1], [4, 88], [32, 2540], [36, 2540], [40, 0x464d4520], [44, 0x10000], [48, b.length], [52, 3], [72, 1920], [76, 1080], [80, 508], [84, 286]]);
  put([[88, 70], [92, 44], [96, 32], [100, 0x2b464d45]]);
  v.setUint16(104, 0x4001, true);
  put([[108, 28], [112, 16], [116, 0xdbc01002], [120, 1], [124, 96], [128, 96], [132, 14], [136, 20], [144, 16], [148, 20]]);
  return b;
}
const EMF = emf();
const WMF = wmf();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('a metafile is told from its header, and draws at its own size with its original kept', async () => {
  assert.equal(metafileKind(EMF), 'emf');
  assert.equal(metafileKind(WMF), 'wmf');
  assert.equal(metafileKind(WMF.subarray(22)), 'wmf', 'a WMF without its placeable header');
  assert.equal(metafileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...new Array(40).fill(0)])), null, 'a PNG');
  const e = await metafilePicture(EMF, { name: 'box.emf' });
  assert.match(e.src, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual([e.w, Math.round(e.h)], [96, 64], '72 x 48 pt as CSS px');
  assert.equal(e.metafile, `data:image/x-emf;base64,${b64(EMF)}`);
  const w = await metafilePicture(WMF);
  assert.deepEqual([w.w, w.h, w.metafile.slice(0, 20)], [96, 96, 'data:image/x-wmf;bas']);
  assert.equal(await metafilePicture(new Uint8Array(64)), null, 'not a metafile');
  assert.deepEqual(await metafileOfUrl(w.metafile), w, 'a data URL reads the same as its bytes');
  assert.equal(await metafileOfUrl(PNG), null);
});

test('a metafile\'s own size comes from the model: points for an EMF or placeable WMF, logical units as px for a plain WMF', async () => {
  assert.deepEqual(await metafileSize(`data:image/x-emf;base64,${b64(EMF)}`), await metafileSize(EMF), 'a data URL reads as its bytes');
  assert.deepEqual(await metafileSize(WMF), { w: 96, h: 96 }, 'one inch square');
  // Without the placeable header the WMF names no unit: its 1200 x 1200 logical units (the rectangle's bounds) count as px.
  const plain = WMF.subarray(22);
  assert.deepEqual(await metafileSize(plain), { w: 1200, h: 1200 });
  const p = await metafilePicture(plain);
  assert.deepEqual([p.w, p.h, p.metafile.slice(0, 20)], [1200, 1200, 'data:image/x-wmf;bas']);
  assert.equal(await metafileSize(PNG), null, 'not a metafile');
});

test('a board picture given a new src through the command API leaves its metafile behind', () => {
  const it = { id: 'p', type: 'image', src: 'data:image/svg+xml;base64,PHN2Zy8+', metafile: 'data:image/x-emf;base64,AQ==', x: 0, y: 0, w: 10, h: 10 };
  assert.equal(patched(it, { x: 5 }).metafile, it.metafile, 'a move keeps it');
  assert.equal(patched(it, { src: it.src }).metafile, it.metafile, 'the same src keeps it');
  assert.ok(!('metafile' in patched(it, { src: PNG })), 'a new picture drops it, so export writes the new one');
});

test('what the reader cannot draw goes to the system\'s renderer, else shows a box of its size naming it', async () => {
  const plus = emfPlusOnly();
  let asked = null;
  const viaSystem = await metafilePicture(plus, { name: 'plus.emf', convert: async (list) => { asked = list; return list.map(() => PNG); } });
  assert.equal(viaSystem.src, PNG);
  assert.deepEqual([asked.length, asked[0].w, asked[0].h, asked[0].data], [1, 96, 96, b64(plus)], 'the picture and its own size');
  const web = await metafilePicture(plus, { name: 'plus.emf', convert: undefined });
  assert.match(decodeURIComponent(web.src), /^data:image\/svg\+xml,<svg [^>]*width="96" height="96".*plus\.emf/s);
  // A list mixes both, in order; a failing renderer falls back to the boxes.
  const [a, b] = await drawMetafiles([{ data: b64(EMF), w: 50, h: 40, label: 'A' }, { data: b64(plus), w: 30, h: 20, label: 'B' }], async () => { throw new Error('no'); });
  assert.match(a, /^data:image\/svg\+xml;base64,/);
  assert.match(decodeURIComponent(b), /width="30" height="20".*>B</s);
});

// A .docx holding a picture bullet (an EMF, VML through numbering.xml's relationships, as Word writes it) on a list paragraph, and
// a drawing canvas holding a WMF picture and a rectangle.
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
  + 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"';
const IMG = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const rels = (list) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, t, target]) => `<Relationship Id="${id}" Type="${t}" Target="${target}"/>`).join('')}</Relationships>`;
const CANVAS = '<w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="1143000"/><wp:docPr id="1" name="Canvas 1"/><a:graphic>'
  + '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"><wpc:wpc><wpc:bg/><wpc:whole/>'
  + '<pic:pic><pic:nvPicPr><pic:cNvPr id="2" name="Picture 2"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
  + '<pic:spPr><a:xfrm><a:off x="95250" y="95250"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'
  + '<wps:wsp><wps:cNvPr id="3" name="Shape 3"/><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="1143000" y="95250"/><a:ext cx="609600" cy="609600"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
  + '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></wps:spPr><wps:bodyPr/></wps:wsp></wpc:wpc></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
const NUMBERING = `<w:numbering ${NS}><w:numPicBullet w:numPicBulletId="0"><w:pict><v:shape style="width:9pt;height:9pt" o:bullet="t"><v:imagedata r:id="rId1" o:title=""/></v:shape></w:pict></w:numPicBullet>`
  + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:lvlPicBulletId w:val="0"/><w:lvlJc w:val="left"/>'
  + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
const docx = () => writeZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['word/document.xml', `<w:document ${NS}><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Bullet</w:t></w:r></w:p>`
    + `<w:p>${CANVAS}</w:p><w:sectPr/></w:body></w:document>`],
  ['word/_rels/document.xml.rels', rels([['rId2', IMG, 'media/canvas.wmf']])],
  ['word/numbering.xml', NUMBERING],
  ['word/_rels/numbering.xml.rels', rels([['rId1', IMG, 'media/bullet.emf']])],
  ['word/media/bullet.emf', EMF], ['word/media/canvas.wmf', WMF],
]);
const levelOf = (doc) => doc.attrs.numbering.abstract[Object.keys(doc.attrs.numbering.abstract).find((k) => doc.attrs.numbering.abstract[k].levels[0]?.pic)].levels[0];
const canvasIn = (doc) => doc.content.find((n) => n.type === 'canvas');
/** The parts of an exported .docx, and the bytes of the picture `rid` of `part`. */
async function partsOf(bytes) {
  const zip = await readZip(bytes);
  const media = (part, rid) => {
    const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(text(zip.get(part.replace(/([^/]+)$/, '_rels/$1.rels'))))?.[1];
    return target && zip.get(`word/${target}`);
  };
  return { zip, media };
}

test('a picture bullet and a picture in a drawing canvas from a .docx draw after import and export back unchanged', async () => {
  const read = await importDocx(await docx(), { fresh: true, metafiles: undefined });
  assert.deepEqual(read.dropped, []);
  const lvl = levelOf(read.doc);
  assert.match(lvl.pic, /^data:image\/svg\+xml;base64,/, 'the bullet shows the reader\'s drawing');
  assert.deepEqual(lvl.metafile, { src: `data:image/x-emf;base64,${b64(EMF)}`, pic: lvl.pic }, 'and keeps its original with the drawing it goes with');
  const c = canvasIn(read.doc);
  const pic = c.attrs.items.find((i) => i.type === 'image');
  assert.match(pic.src, /^data:image\/svg\+xml;base64,/, 'the canvas picture shows the reader\'s drawing');
  assert.equal(pic.metafile, `data:image/x-wmf;base64,${b64(WMF)}`);
  assert.ok(shapeCanvas(c.attrs), 'a canvas of Word shapes and pictures writes as Word shapes');

  const { bytes } = await exportDocx(read.doc, { picture: async () => null });
  const { zip, media } = await partsOf(bytes);
  const numbering = text(zip.get('word/numbering.xml'));
  const bulletRid = /<v:imagedata r:id="([^"]+)"/.exec(numbering)?.[1];
  assert.deepEqual(media('word/numbering.xml', bulletRid), EMF, 'the bullet writes its EMF back');
  const body = text(zip.get('word/document.xml'));
  assert.match(body, /<wpc:wpc>.*<pic:pic>.*<\/pic:pic>.*<wps:wsp>.*<\/wpc:wpc>/s, 'the canvas goes out as a drawing canvas with its picture and shape');
  assert.match(body, /<a:srcRect l="10000"\/>/, 'with its crop');
  assert.deepEqual(media('word/document.xml', /<a:blip r:embed="([^"]+)"/.exec(body)[1]), WMF, 'the canvas picture writes its WMF back');
  assert.ok(![...zip.keys()].some((k) => /\.(png|svg)$/.test(k)), 'no drawing or picture of the canvas goes in their place');

  // Read back fresh (not from the app's own stash), both come back the same.
  const again = await importDocx(bytes, { fresh: true, metafiles: undefined });
  assert.equal(levelOf(again.doc).metafile.src, lvl.metafile.src);
  const back = canvasIn(again.doc).attrs.items;
  assert.equal(back.find((i) => i.type === 'image').metafile, pic.metafile);
  assert.deepEqual(back.map((i) => [i.type, Math.round(i.x), Math.round(i.y), Math.round(i.w), Math.round(i.h)]),
    c.attrs.items.map((i) => [i.type, Math.round(i.x), Math.round(i.y), Math.round(i.w), Math.round(i.h)]));
  assert.deepEqual(back.find((i) => i.type === 'image').crop, pic.crop);

  // A level given another picture since writes that picture, not the original it no longer shows.
  levelOf(read.doc).pic = PNG;
  const changed = await partsOf((await exportDocx(read.doc, { picture: async () => null })).bytes);
  const rid = /<v:imagedata r:id="([^"]+)"/.exec(text(changed.zip.get('word/numbering.xml')))[1];
  assert.deepEqual(changed.media('word/numbering.xml', rid), new Uint8Array(Buffer.from(PNG.split(',')[1], 'base64')));
});

test('a canvas stays a picture where Word could not show its picture, or where it holds one picture alone', () => {
  const shape = { id: 's', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, fill: 'solid', fillColor: '#FFFFFF', color: '#000000', width: 1, opacity: 1 };
  const image = (src, more = {}) => ({ id: 'p', type: 'image', src, x: 0, y: 0, w: 10, h: 10, ...more });
  assert.ok(shapeCanvas({ items: [shape, image(PNG)] }));
  assert.ok(shapeCanvas({ items: [shape, image('data:image/svg+xml;base64,PHN2Zy8+', { metafile: 'data:image/x-emf;base64,AQ==' })] }), 'a metafile writes its original');
  assert.ok(shapeCanvas({ items: [shape, image('data:image/svg+xml;base64,PHN2Zy8+')] }), 'an SVG goes out beside a PNG of it (canvas-native-export)');
  assert.ok(!shapeCanvas({ items: [shape, image('data:image/webp;base64,AAAA')] }), 'a picture Word does not show');
  assert.ok(!shapeCanvas({ items: [image(PNG)] }), 'one picture alone stays the picture of its canvas');
  assert.ok(shapeCanvas({ items: [image(PNG)], docPr: { canvas: { bg: null } } }), 'unless it came in a Word drawing canvas');
});

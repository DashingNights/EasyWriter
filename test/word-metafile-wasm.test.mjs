// metafile-wasm (docs/plans/word/briefs/metafile-wasm.md): EMF and WMF pictures draw through WordCraft's metafile reader as
// WebAssembly (src/vendor/wordcraft-metafile), and only the ones it cannot draw go to the system's renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawMetafile, emfPlusOnly, summary } from '../src/vendor/wordcraft-metafile/index.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { writeZip } from '../src/document/docx/zip.mjs';

// The docx-metafile case's samples, drawn by GDI+: an EMF+ dual EMF of 240 x 160 px and a placeable WMF of 200 x 120 px, each
// with a caption ("EMF sample", "WMF sample").
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const EMF = b64('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');
const WMF = b64('183GmgAAAAAAAHAAQwA2AAAAAAAUVwEACQAAA8UBAAAHAIYAAAAAAAQAAAADAQgABQAAAAsCAAAAAAUAAAAMAogA4wADAAAAHgAHAAAA/AIAAP//4AAAAAQA'
  + 'AAAtAQAACAAAAPoCBQAAAAAA////AAQAAAAtAQEADgAAACQDBQAAAAAAAACIAOMAiADjAAAAAAAAAAgAAAD6AgAAAAAAAAAAAAAEAAAALQECAAcAAAD8AgAA'
  + '////AAAABAAAAC0BAwAIAAAA+gIAAAMAAAAAAIAABAAAAC0BBAAHAAAA/AIBAAAAAAAAAAQAAAAtAQUADAAAACQDBAACAAIA4AACAOAAhQACAIUABAAAAC0B'
  + 'AgAEAAAALQEDAAQAAADwAQQABAAAAPABAAAHAAAA/AIAAEaCtAAAAAQAAAAtAQAABAAAAAYBAQAEAAAALQEBAIYAAAAkA0EAZAA7AGQAPwBjAEMAYgBHAGEA'
  + 'SwBfAE8AXQBSAFsAVQBYAFgAVQBbAFIAXQBPAF8ASwBhAEcAYgBDAGMAPwBkADsAZAA3AGQAMwBjAC8AYgArAGEAKABfACQAXQAhAFsAHgBYABwAVQAZAFIA'
  + 'FwBPABUASwAUAEcAEwBDABIAPwASADsAEgA3ABMAMwAUAC8AFQArABcAKAAZACQAHAAhAB4AHgAhABwAJAAZACgAFwArABUALwAUADMAEwA3ABIAOwASAD8A'
  + 'EgBDABMARwAUAEsAFQBPABcAUgAZAFUAHABYAB4AWwAhAF0AJABfACgAYQArAGIALwBjADMAZAA3AGQAOwAEAAAALQECAAQAAAAGAQEABAAAAC0BAwAEAAAA'
  + '8AEAAAcAAAD8AgAAzVxcAAAABAAAAC0BAAAEAAAABgEBAAQAAAAtAQEACgAAACQDAwB9AGYAqgASANEAZgAEAAAALQECAAQAAAAGAQEABAAAAC0BAwAEAAAA'
  + 'AgEBAAUAAAAJAgAAAAAEAAAALgEYABwAAAD7AuX/AAAAAAAAvAIAAAAABwAAAEFyaWFsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAC0BBAAWAAAA'
  + 'Mgp6ABcACgAAAFdNRiBzYW1wbGUaABcAEQAIAA8ADwAYABEACAAPABwAAAD7AhQACQAAAAAAvAIAAAAAAQICIlN5c3RlbQAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAABAAAAC0BBgAEAAAAJwH//wMAAAAAAA==');

/** An EMF whose only record after its header is the EMF+ header, with `flags` (bit 0: dual). */
function emfPlus(flags) {
  const b = new Uint8Array(88 + 44 + 20);
  const v = new DataView(b.buffer);
  const put = (list) => list.forEach(([at, n]) => v.setUint32(at, n, true));
  // EMR_HEADER: bounds, a 1 inch frame, the signature, version, size, 3 records, a 1920 x 1080 px device of 508 x 286 mm.
  put([[0, 1], [4, 88], [32, 2540], [36, 2540], [40, 0x464d4520], [44, 0x10000], [48, b.length], [52, 3], [72, 1920], [76, 1080], [80, 508], [84, 286]]);
  // EMR_COMMENT "EMF+" holding EmfPlusHeader (type 0x4001, flags, size 28, data 16, version, display, 96 dpi), then EMR_EOF.
  put([[88, 70], [92, 44], [96, 32], [100, 0x2b464d45]]);
  v.setUint16(104, 0x4001, true);
  v.setUint16(106, flags, true);
  put([[108, 28], [112, 16], [116, 0xdbc01002], [120, 1], [124, 96], [128, 96], [132, 14], [136, 20], [144, 16], [148, 20]]);
  return b;
}
const svgOf = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString();

test('the two samples parse at their stated size and draw as SVG over the asked size, natural size twice that, captions included', async () => {
  for (const [bytes, w, h, caption] of [[EMF, 240, 160, 'EMF sample'], [WMF, 200, 120, 'WMF sample']]) {
    const [ok, size] = (await summary(bytes)).split(' ');
    const [pw, ph] = size.split('x').map(Number);
    assert.equal(ok, 'ok');
    // Points: 3/4 of the pixels the case drew at, within the screen DPI's rounding.
    assert.ok(Math.abs(pw - w * 0.75) < 2 && Math.abs(ph - h * 0.75) < 2, `${caption}: ${size}`);
    const url = await drawMetafile(bytes, w, h);
    assert.match(url, /^data:image\/svg\+xml;base64,/);
    const svg = svgOf(url);
    assert.match(svg, new RegExp(`^<svg [^>]*width="${w * 2}\\.00" height="${h * 2}\\.00" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`));
    assert.ok((svg.match(/<path /g) ?? []).length >= 3, `${caption}: the box, the circle and the triangle`);
    // WMF text draws too (TEXTOUT and EXTTEXTOUT in the vendored reader): one run per caption.
    assert.deepEqual([...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]), [caption]);
  }
});

test('an EMF+ only file is told from its records, and the reader leaves it to the fallback', async () => {
  assert.equal(emfPlusOnly(emfPlus(0)), true);
  assert.equal(emfPlusOnly(emfPlus(1)), false, 'EMF+ dual: its GDI records hold the picture');
  assert.equal(emfPlusOnly(EMF), false, 'the EMF sample is EMF+ dual');
  assert.equal(emfPlusOnly(WMF), false);
  assert.equal(await drawMetafile(emfPlus(0), 100, 100), null);
  assert.equal(await drawMetafile(new Uint8Array([1, 2, 3]), 100, 100), null, 'not a metafile');
});

test('the import shows the reader\'s drawing and sends only what it cannot draw to the system, else a placeholder', async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const pic = (id, w, h) => `<w:r><w:drawing><wp:inline><wp:extent cx="${w * 9525}" cy="${h * 9525}"/><wp:docPr id="${id}" name="p${id}"/><a:graphic>`
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>'
    + `<pic:blipFill><a:blip r:embed="rId${id}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const rel = (id, target) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
  const bytes = await writeZip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<w:document ${W}><w:body><w:p>${pic(1, 240, 160)}${pic(2, 200, 120)}${pic(3, 100, 80)}</w:p><w:sectPr/></w:body></w:document>`],
    ['word/_rels/document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1, 'media/a.emf')}${rel(2, 'media/b.wmf')}${rel(3, 'media/c.emf')}</Relationships>`],
    ['word/media/a.emf', EMF], ['word/media/b.wmf', WMF], ['word/media/c.emf', emfPlus(0)],
  ]);
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const pics = (read) => read.doc.content[0].content.filter((n) => n.type === 'image').map((n) => n.attrs);
  let asked = null;
  const shown = pics(await importDocx(bytes, { fresh: true, metafiles: async (list) => { asked = list; return list.map(() => PNG); } }));
  assert.equal(asked.length, 1, 'only the EMF+ only picture goes to the system');
  assert.deepEqual([asked[0].w, asked[0].h, b64(asked[0].data).length], [100, 80, emfPlus(0).length]);
  assert.deepEqual(shown.map((a) => a.src.slice(0, 26)), ['data:image/svg+xml;base64,', 'data:image/svg+xml;base64,', PNG.slice(0, 26)]);
  assert.equal(shown[2].src, PNG);
  assert.deepEqual(shown.map((a) => a.metafile.slice(0, 20)), ['data:image/x-emf;bas', 'data:image/x-wmf;bas', 'data:image/x-emf;bas'], 'the originals stay for export');
  assert.deepEqual(shown.map((a) => a.orig), [{ w: 240, h: 160 }, { w: 200, h: 120 }, { w: 100, h: 80 }]);
  // The web app has no system renderer: a placeholder of the picture's size.
  const web = pics(await importDocx(bytes, { fresh: true, metafiles: undefined }));
  assert.match(decodeURIComponent(web[2].src), /^data:image\/svg\+xml,<svg [^>]*width="100" height="80".*Picture \(EMF\)/s);
  assert.match(web[0].src, /^data:image\/svg\+xml;base64,/);
});

/** A placeable WMF of one inch square (1440 units) holding `records` ([function, parameter bytes]). */
function wmf(records) {
  const recs = [...records, [0, []]].map(([fn, p]) => {
    const b = new Uint8Array(6 + p.length + (p.length & 1));
    new DataView(b.buffer).setUint32(0, b.length / 2, true);
    new DataView(b.buffer).setUint16(4, fn, true);
    b.set(p, 6);
    return b;
  });
  const size = 40 + recs.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x9ac6cdd7, true);
  [0, 0, 1440, 1440, 1440].forEach((n, i) => v.setInt16(6 + i * 2, n, true));
  [1, 9, 0x300].forEach((n, i) => v.setUint16(22 + i * 2, n, true));
  v.setUint32(28, (size - 22) / 2, true);
  v.setUint16(32, 4, true);
  let at = 40;
  for (const r of recs) out.set(r, at), at += r.length;
  return out;
}
const i16 = (...n) => [...new Uint8Array(new Int16Array(n).buffer)];
const pad = (b) => (b.length & 1 ? [...b, 0] : b);
// CREATEFONTINDIRECT (10 pt Arial in `charset`) and SELECTOBJECT of its handle.
const font = (charset, handle) => [[0x02fb, [...i16(-200, 0, 0, 0, 400), 0, 0, 0, charset, 0, 0, 0, 0, ...new TextEncoder().encode('Arial\0')]], [0x012d, i16(handle)]];
const textOut = (b) => [0x0521, [...i16(b.length), ...pad(b), ...i16(400, 100)]];
const extTextOut = (b, dx) => [0x0a32, [...i16(800, 100, b.length, 0), ...pad(b), ...i16(...dx)]];
const runs = (svg) => [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ x: /\bx="([^"]*)"/.exec(m[1])?.[1].split(' ').map(Number), text: m[2] }));

test('WMF text in a code page other than Windows-1252 decodes by its font\'s character set, advances lined up by character', async () => {
  const svg = svgOf(await drawMetafile(wmf([
    ...font(136, 0), textOut([0xa4, 0xa4, 0xa4, 0xe5]), // Big5 "中文"
    ...font(204, 1), extTextOut([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], [10, 10, 10, 10, 10, 10]), // Windows-1251 "Привет"
    ...font(0, 2), extTextOut([0x61, 0x01, 0x62, 0x20], [10, 10, 10, 10]), // "a", a control character, "b" and a space
    ...font(134, 3), extTextOut([0xd6, 0xd0, 0x41], [10, 0, 5]), // GB2312 "中A": a double-byte character takes both bytes' advances
  ]), 96, 96));
  const [big5, cyr, ctrl, gbk] = runs(svg);
  assert.equal(big5.text, '中文');
  assert.equal(cyr.text, 'Привет');
  assert.equal(cyr.x.length, 6);
  const gap = cyr.x[1] - cyr.x[0];
  assert.ok(gap > 0);
  // The control character is left out of the text and keeps its advance; the trailing space stays.
  assert.equal(ctrl.text, 'ab ');
  assert.equal(ctrl.x.length, 3);
  assert.ok(Math.abs(ctrl.x[1] - ctrl.x[0] - 2 * gap) < 0.02, `${ctrl.x}`);
  assert.equal(gbk.text, '中A');
  assert.equal(gbk.x.length, 2);
  assert.ok(Math.abs(gbk.x[1] - gbk.x[0] - gap) < 0.02, `${gbk.x}`);
});

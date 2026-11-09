// engine-box (docs/plans/engine/viewport-design.md sections 5.3 and 10, P14): schema version 2 gives every block and drawing a
// stable id and adds boxes, EasyWriter's own objects (smart canvases, plan charts) inside engine Documents. A box rides through
// .docx in the STASH part (docProps/easywriter.json) with import.mjs's hash rule, changes only through `box.set`, and prints as
// its fallback picture.
// test/fixtures/engine-boxes.docx is a Document draft of the DOM editor saved through export.mjs with its STASH part: three smart
// canvases (one shape, several items, one picture) and a plan chart. This writes it again from DRAFT below:
//   EW_BOX_WRITE=1 node --test test/engine-box.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { exportDocx, packageHash, STASH } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { readZip, text, writeZip } from '../src/document/docx/zip.mjs';
import { toCanvas, VERSION } from '../src/engine/model/form.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

const FIXTURE = new URL('./fixtures/engine-boxes.docx', import.meta.url);
const P = (s) => ({ type: 'paragraph', content: s ? [{ type: 'text', text: s }] : [] });
/** A `w` x `h` PNG of one colour → its bytes. */
function png(w, h, rgb = [200, 40, 40]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bits a channel, RGB
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(4, 4).toString('base64');
const shape = (id, x, fill) => ({ id, type: 'shape', shape: 'rect', x, y: 20, w: 120, h: 80, color: '#1F3864', width: 2, fill: 'solid', fillColor: fill });
const DRAFT = {
  type: 'doc',
  content: [
    P('A draft with three smart canvases and a plan chart.'),
    { type: 'canvas', attrs: { w: 400, h: 140, dw: 400, bg: 'post', items: [shape('a', 20, '#4472C4')] } },
    P('Between the first and the second canvas.'),
    { type: 'canvas', attrs: { w: 420, h: 160, dw: 420, bg: 'post', items: [shape('b', 20, '#ED7D31'), shape('c', 220, '#70AD47'),
      { id: 't', type: 'text', html: 'A label', x: 40, y: 110, w: 200, size: 18, color: '#1F2328', bold: false, align: 'left', bg: null }] } },
    P('A canvas holding one picture.'),
    { type: 'canvas', attrs: { w: 200, h: 120, dw: 200, bg: 'post', items: [{ id: 'p', type: 'image', src: `data:image/png;base64,${PNG}`, x: 0, y: 0, w: 200, h: 120 }] } },
    P('A plan chart.'),
    { type: 'planChart', attrs: { id: 'abc1234', planId: null, view: 'kanban', options: {}, frozen: null, dw: null } },
    P('After the objects.'),
  ],
};
const N = 4;

if (process.env.EW_BOX_WRITE) {
  // The pictures a page draws (the picture canvas, the plan chart): a small PNG stands in for the rendered one.
  const pic = png(8, 4, [90, 120, 200]);
  const { bytes } = await exportDocx(DRAFT, { picture: async (n) => ({ bytes: pic, ext: 'png', w: n.attrs.dw ?? 300, h: n.attrs.dw ? (n.attrs.dw * n.attrs.h) / n.attrs.w : 150 }) });
  fs.writeFileSync(FIXTURE, bytes);
}
const fixture = fs.readFileSync(FIXTURE);

/** A session on `bytes` of `kind` → {e, frames(), boxes()}. */
function open(bytes, kind = 'docx') {
  const e = new Engine();
  e.open(bytes, kind);
  const pages = JSON.parse(e.pages()).pages.length;
  const frames = () => Array.from({ length: pages }, (_, i) => JSON.parse(e.frames(i))).flat();
  return { e, frames, boxes: () => frames().filter((f) => f.kind === 'box') };
}
const exec = (e, id, args) => JSON.parse(e.exec(id, JSON.stringify(args)));

test('the fixture is a DOM draft with its STASH part, and opens in the engine with a live box for each object', async () => {
  const stash = JSON.parse(text((await readZip(fixture)).get(STASH)));
  assert.equal(Object.keys(stash.nodes).length, N);
  const { e, boxes } = open(fixture);
  const got = boxes();
  assert.deepEqual(got.map((b) => b.box), ['canvas', 'canvas', 'canvas', 'planChart']);
  assert.equal(new Set(got.map((b) => b.id)).size, N, 'each box has its own id');
  // Each box holds its node's attrs as data, as the stash had them.
  const kept = Object.values(stash.nodes);
  for (const [i, b] of got.entries()) {
    const v = exec(e, 'box.get', { id: Number(b.id) }).value;
    assert.deepEqual([v.kind, JSON.parse(v.data)], [kept[i].type, kept[i].attrs]);
  }
  e.free();
});

test('toCanvas of the draft gives the same boxes, kept in the version 2 model', async () => {
  const e = new Engine();
  const client = { open: async (b, k) => JSON.parse(e.open(b, k)), save: async (k) => e.save(k) };
  const draft = { id: 'd', title: 'Boxes', format: 'document', formatVersion: 2, doc: DRAFT };
  const { record } = await toCanvas(client, draft, { docx: async () => ({ bytes: fixture }) });
  const model = JSON.parse(record).engine.model;
  assert.equal(model.version, VERSION);
  const boxes = JSON.stringify(model).match(/"box":\{"kind":"(canvas|planChart)"/g) ?? [];
  assert.equal(boxes.length, N);
  // The model opens again with the same boxes.
  assert.equal(open(new TextEncoder().encode(JSON.stringify(model)), 'engine').boxes().length, N);
  e.free();
});

test('a file with another part changed (the hash differs) opens with Word\'s drawings instead', async () => {
  const files = await readZip(fixture);
  const core = text(files.get('docProps/core.xml')).replace('</cp:coreProperties>', '<dc:subject>Edited in Word</dc:subject></cp:coreProperties>');
  const changed = await writeZip([...files].map(([n, b]) => [n, n === 'docProps/core.xml' ? core : b]));
  const { e, frames, boxes } = open(changed);
  assert.equal(boxes().length, 0);
  assert.ok(frames().length >= N, `the drawings stay drawings: ${frames().map((f) => f.kind)}`);
  e.free();
});

test('box.set commits new data and a new fallback that one undo takes back, and the PDF shows the fallback', () => {
  const { e, boxes } = open(fixture);
  const b = boxes()[0];
  const before = JSON.parse(exec(e, 'box.get', { id: Number(b.id) }).value.data);
  // A 3 x 2 PNG, which the PDF holds as a picture 3 wide and 2 high.
  const fallback = png(3, 2, [10, 160, 60]).toString('base64');
  const data = { ...before, items: [...before.items, { id: 'z', type: 'shape', shape: 'ellipse', x: 200, y: 10, w: 40, h: 40, color: '#000000', width: 1 }] };
  const has = (pdf) => /\/Width 3\s*\/Height 2|\/Height 2\s*\/Width 3/.test(Buffer.from(pdf).toString('latin1'));
  assert.ok(!has(e.pdf('{}')), 'no such picture before');
  const r = exec(e, 'box.set', { id: Number(b.id), data: JSON.stringify(data), fallback: `data:image/png;base64,${fallback}` });
  assert.ok(r.ok && r.changed, JSON.stringify(r));
  assert.equal(JSON.parse(exec(e, 'box.get', { id: Number(b.id) }).value.data).items.length, before.items.length + 1);
  assert.equal(boxes()[0].id, b.id, 'the box keeps its id');
  assert.ok(has(e.pdf('{}')), 'the PDF shows the new fallback');
  JSON.parse(e.undo());
  assert.deepEqual(JSON.parse(exec(e, 'box.get', { id: Number(b.id) }).value.data), before, 'one undo');
  e.free();
});

test('saved as .docx, the boxes go back to the DOM editor as canvases and a plan chart', async () => {
  const { e } = open(fixture);
  const bytes = e.save('docx');
  const files = await readZip(bytes);
  const stash = JSON.parse(text(files.get(STASH)));
  assert.equal(stash.hash, await packageHash(files), 'the engine writes export.mjs\'s hash');
  const { doc } = await importDocx(bytes);
  const types = doc.content.map((n) => n.type).filter((t) => t === 'canvas' || t === 'planChart');
  assert.deepEqual(types, ['canvas', 'canvas', 'canvas', 'planChart']);
  assert.deepEqual(doc.content.find((n) => n.type === 'planChart').attrs.id, 'abc1234');
  e.free();
});

test('version 1 models open; block and frame ids survive typing before them, and the layout event names the edited block', () => {
  const v1 = fs.readFileSync(new URL('./fixtures/engine-models/1.json', import.meta.url));
  const old = open(v1, 'engine');
  const saved = JSON.parse(new TextDecoder().decode(old.e.save('engine')));
  assert.equal(saved.version, VERSION);
  assert.ok(saved.body.every((b) => Number.isInteger(b.id) && b.id > 0), 'every block has an id');
  old.e.free();

  const { e, frames } = open(fixture);
  e.takeLayout();
  const ids = frames().map((f) => f.id);
  const blocks = JSON.parse(e.blocks(0)).map((b) => b.id);
  const first = blocks[0];
  const start = JSON.parse(e.locate(JSON.stringify(JSON.parse(e.selection()).head)));
  assert.equal(start.id, first, 'locate names the block by its id');
  e.insertText('Typed first. ');
  assert.deepEqual(frames().map((f) => f.id), ids, 'frame ids');
  assert.deepEqual(JSON.parse(e.blocks(0)).map((b) => b.id), blocks, 'block ids');
  const event = JSON.parse(e.takeLayout());
  assert.deepEqual(event.changes, { inserted: [], removed: [], replaced: [first] });
  // A new paragraph (Enter) is a new block with its own id; posAt finds a block by its id.
  e.exec('text.newParagraph', '{}');
  const after = JSON.parse(e.takeLayout()).changes;
  assert.equal(after.inserted.length, 1);
  assert.ok(!blocks.includes(after.inserted[0]));
  assert.deepEqual(JSON.parse(e.posAt(first, 0)).path, [0]);
  e.free();
});

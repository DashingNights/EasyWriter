// engine-print (docs/plans/engine/viewport-design.md P14b): print and PDF from the engine. The harness stubs word.printPdf, the
// engine's print job, as it stubs word.print, so no run reaches the user's printer; a print job's PDF embeds preview-and-print
// fonts (OS/2 fsType 4) and a saved one draws them as outlines, naming them (the pdf crate's licence rule, whose own unit test is
// `fonts_embed_only_as_their_licence_allows`); and a box edited after a print shows its new picture in the next print job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { initSync, Engine, addFont } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

const require = createRequire(import.meta.url);
initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

test('the Word harness stubs word.printPdf and leaves printToPDF real', () => {
  const { stubOf } = require('../.smoke-data/word/lib.js');
  assert.equal(stubOf('word.printPdf'), 'printPdf');
  assert.equal(stubOf('word.print'), 'print');
  assert.equal(stubOf('word.printToPDF'), null);
  assert.equal(stubOf('word.printers'), null);
});

/** Source Sans 3 renamed to `family` (13 letters) with OS/2 fsType `fsType`. */
function licensed(family, fsType) {
  const f = Buffer.from(fs.readFileSync(new URL('../engine/assets/fonts/SourceSans3-Regular.ttf', import.meta.url)));
  for (const [from, to] of [['Source Sans 3', family].map((s) => Buffer.from(s, 'latin1')), ['Source Sans 3', family].map((s) => Buffer.from(s, 'utf16le').swap16())]) {
    for (let i = f.indexOf(from); i >= 0; i = f.indexOf(from, i + 1)) to.copy(f, i);
  }
  const tables = f.readUInt16BE(4);
  for (let t = 0; t < tables; t++) {
    const r = 12 + t * 16;
    if (f.toString('latin1', r, r + 4) === 'OS/2') f.writeUInt16BE(fsType, f.readUInt32BE(r + 8) + 8);
  }
  return f;
}

const exec = (e, id, args = {}) => JSON.parse(e.exec(id, JSON.stringify(args)));
const pdf = (e, options) => {
  const r = e.pdfNamed(JSON.stringify(options));
  try {
    return { bytes: r.bytes, outlined: JSON.parse(r.outlined), why: JSON.parse(r.why) };
  } finally {
    r.free();
  }
};

test('a print job embeds a preview-and-print font that a saved PDF draws as outlines, and names it', () => {
  const family = 'PreviewPrint4';
  assert.ok(addFont(licensed(family, 4)) > 0);
  const e = new Engine();
  e.insertText('Licensed text');
  assert.ok(exec(e, 'select.all').ok);
  assert.ok(exec(e, 'format.font', { name: family }).ok);
  const saved = pdf(e, {});
  const printed = pdf(e, { print: true });
  assert.equal(Buffer.from(saved.bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.deepEqual(saved.outlined, [family]);
  assert.deepEqual(printed.outlined, []);
  // `why` names the face and the rule that drew it as outlines.
  assert.ok(saved.why.length === 1 && saved.why[0].startsWith(family) && saved.why[0].includes('its licence'), saved.why.join('; '));
  assert.deepEqual(printed.why, []);
  // `pdf` keeps answering bytes, the saved PDF's.
  assert.equal(Buffer.from(e.pdf('{}').subarray(0, 5)).toString(), '%PDF-');
  e.free();
});

test('a box edited after a print job shows its new picture in the next one', () => {
  const e = new Engine();
  e.open(fs.readFileSync(new URL('./fixtures/engine-boxes.docx', import.meta.url)), 'docx');
  const frames = Array.from({ length: JSON.parse(e.pages()).pages.length }, (_, i) => JSON.parse(e.frames(i))).flat();
  const id = Number(frames.find((f) => f.kind === 'box').id);
  // A 3 x 2 PNG, which the PDF holds as a picture 3 wide and 2 high.
  const fallback = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGPgWmADQQxwFgA00AVlzxACOwAAAABJRU5ErkJggg==';
  const has = (bytes) => /\/Width 3\s*\/Height 2|\/Height 2\s*\/Width 3/.test(Buffer.from(bytes).toString('latin1'));
  assert.ok(!has(pdf(e, { print: true }).bytes), 'no such picture before');
  const data = JSON.parse(exec(e, 'box.get', { id }).value.data);
  data.items.push({ id: 'z', type: 'shape', shape: 'ellipse', x: 200, y: 10, w: 40, h: 40, color: '#000000', width: 1 });
  const r = exec(e, 'box.set', { id, data: JSON.stringify(data), fallback: `data:image/png;base64,${fallback}` });
  assert.ok(r.ok && r.changed, JSON.stringify(r));
  assert.ok(has(pdf(e, { print: true }).bytes), 'the next print job shows the new fallback');
  e.free();
});

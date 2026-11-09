// engine-fidelity (docs/plans/word/briefs/engine-fidelity.md, docs/plans/engine/fidelity.md): what the document engine's
// WebAssembly keeps of the Word fixture when it saves it. WordCraft wrote every page border as measured from the text and
// dropped the text-box attributes Word writes out (wordcraft-eval.md section 2); the layout rules have their unit tests in the
// crates (engine/crates/doc-layout/src/tests/fidelity.rs and the docx crate's easywriter_fidelity tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);

/** One part of a .docx (a zip), found through the central directory. */
function part(zip, name) {
  const buf = Buffer.from(zip);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const [method, size, nameLen, extraLen, commentLen, local] = [10, 20, 28, 30, 32, 42].map((o) => (o === 20 || o === 42 ? buf.readUInt32LE(at + o) : buf.readUInt16LE(at + o)));
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const count = (s, needle) => s.split(needle).length - 1;

test('the Word fixture saved by the engine keeps page border placement and text-box attributes', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const bytes = fs.readFileSync(FIXTURE);
  const before = part(bytes, 'word/document.xml');
  const e = new Engine();
  e.open(bytes, 'docx');
  const after = part(e.save('docx'), 'word/document.xml');
  e.free();
  assert.ok(after, 'the saved package has its document part');
  // Of the fixture's 700 text bodies 675 are written back as Word shapes and the rest are kept as other drawings, so the
  // text-body attributes need 95 % of theirs (WordCraft kept none of the defaults Word writes out); the rest every one.
  const kept = { 'w:offsetFrom="page"': 1, 'w:display="firstPage"': 1, 'w:zOrder="back"': 1, 'prst="can"': 1, 'anchor="ctr"': 0.95, 'wrap="square"': 0.95, 'lIns="91440"': 0.95 };
  for (const [attr, share] of Object.entries(kept)) {
    const [was, is] = [count(before, attr), count(after, attr)];
    assert.ok(was > 0 && is >= Math.ceil(was * share), `${attr}: ${was} in the fixture, ${is} after saving`);
  }
});

test('the Word fixture saved by the engine keeps its pictures cropped to shapes', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const bytes = fs.readFileSync(FIXTURE);
  const before = part(bytes, 'word/document.xml');
  const e = new Engine();
  e.open(bytes, 'docx');
  const after = part(e.save('docx'), 'word/document.xml');
  e.free();
  // Each picture's own preset other than a rectangle (Crop to Shape: the fixture has 55, from roundRect to star32).
  const shapes = (xml) => (xml.match(/<pic:spPr\b[^]*?<\/pic:spPr>/g) ?? []).map((s) => s.match(/prst="([^"]+)"/)?.[1]).filter((p) => p && p !== 'rect');
  assert.ok(shapes(before).length > 50);
  assert.deepEqual(shapes(after), shapes(before));
});

// engine-fidelity-2: every border style the fixture uses (the paragraph, table, cell and page borders' w:val), page art
// included, is written back under its own name, and an art border keeps its width in points (WordCraft saved art as single
// lines of the eighth-point width).
const borderStyles = (xml) => {
  const seen = new Map();
  for (const m of xml.matchAll(/<w:(?:top|left|bottom|right|start|end|between|insideH|insideV|bar|tl2br|tr2bl) w:val="(\w+)"(?: w:sz="(\d+)")?/g)) {
    const key = `${m[1]} ${m[2] ?? ''}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return seen;
};

test('the Word fixture saved by the engine keeps every border style under its own name', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const bytes = fs.readFileSync(FIXTURE);
  const before = borderStyles(part(bytes, 'word/document.xml'));
  const e = new Engine();
  e.open(bytes, 'docx');
  const after = borderStyles(part(e.save('docx'), 'word/document.xml'));
  e.free();
  const names = (m) => new Set([...m.keys()].map((k) => k.split(' ')[0]).filter((n) => n !== 'nil' && n !== 'none'));
  const lost = [...names(before)].filter((n) => !names(after).has(n));
  assert.deepEqual(lost, [], 'every style name is saved');
  assert.ok(names(before).size >= 188, `${names(before).size} styles in the fixture`);
  // The art borders' widths: 1, 16 and 31 pt apples, the rest 16 pt.
  for (const key of ['apples 1', 'apples 16', 'apples 31', 'balloons3Colors 16', 'zigZagStitch 16']) {
    assert.ok(after.get(key) >= before.get(key), `${key}: ${before.get(key)} in the fixture, ${after.get(key)} after saving`);
  }
});

// engine-fidelity-3: headings collapsed by default and the table style parts' cell margins (Word's Calendar 4) were lost on
// save; a paragraph's own frame now keeps its style's settings, so saving writes the merged frame.
test('the Word fixture saved by the engine keeps collapsed headings and table style cell margins', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const bytes = fs.readFileSync(FIXTURE);
  const e = new Engine();
  e.open(bytes, 'docx');
  const saved = e.save('docx');
  e.free();
  assert.equal(count(part(saved, 'word/document.xml'), '<w15:collapsed/>'), count(part(bytes, 'word/document.xml'), '<w15:collapsed/>'));
  const calendar = (xml) => xml.split('w:styleId="Calendar4"')[1]?.split('</w:style>')[0] ?? '';
  assert.match(calendar(part(saved, 'word/styles.xml')), /<w:tblStylePr w:type="band2Horz">.*<w:tcMar>.*<w:bottom w:w="86"/);
});

// engine-fidelity-3 review fixes: pictures sized relative to a page area (Word pages 398 to 402) kept their sizes on save.
test('the Word fixture saved by the engine keeps its relative picture sizes', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const bytes = fs.readFileSync(FIXTURE);
  const e = new Engine();
  e.open(bytes, 'docx');
  const saved = e.save('docx');
  e.free();
  // A share of 0 is no relative size: Word writes it and the engine leaves it out.
  const relative = (xml) => (xml.match(/<wp14:pct(?:Width|Height)>[1-9]/g) ?? []).length;
  const before = relative(part(bytes, 'word/document.xml'));
  assert.ok(before > 0, 'the fixture has relative sizes');
  assert.equal(relative(part(saved, 'word/document.xml')), before);
});

// engine-fidelity-4: a picture linked to a file was dropped when it had no stored data (Word 188, INCLUDEPICTURE \d) and lost its
// link when it had; framed paragraphs and content controls shown as start/end tags are kept as well.
test('the Word fixture saved by the engine keeps linked pictures, framed paragraphs and start/end tags', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const bytes = fs.readFileSync(FIXTURE);
  const e = new Engine();
  e.open(bytes, 'docx');
  const saved = e.save('docx');
  e.free();
  const [before, after] = [part(bytes, 'word/document.xml'), part(saved, 'word/document.xml')];
  // Six VML pictures stored and linked (r:href) and one linked only (an external r:id): seven DrawingML links once saved.
  assert.equal(count(before, 'r:href='), 6);
  assert.equal(count(after, 'r:link='), 7);
  assert.equal((after.match(/<a:blip r:link="[^"]+"\/>/g) ?? []).length, 1, 'the picture linked only has no stored data');
  const rels = part(saved, 'word/_rels/document.xml.rels');
  assert.ok((rels.match(/<Relationship [^>]*TargetMode="External"[^>]*>/g) ?? []).some((r) => r.includes('icon.png')), 'the link keeps its file');
  assert.ok(count(after, '<w:framePr') >= count(before, '<w:framePr'), 'framed paragraphs');
  assert.equal(count(after, 'w15:appearance w15:val="tags"'), count(before, 'w15:appearance w15:val="tags"'));
  // Opened again, the picture linked only is still there at its size.
  const again = new Engine();
  again.open(saved, 'docx');
  const resaved = part(again.save('docx'), 'word/document.xml');
  again.free();
  assert.equal(count(resaved, 'r:link='), 7);
});

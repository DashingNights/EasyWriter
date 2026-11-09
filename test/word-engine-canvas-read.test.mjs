// engine-canvas-read (docs/plans/word/briefs/engine-canvas-read.md, docs/plans/engine/stage2b.md decision 8 and R8 to R16): one
// reader of canvas records, boxes listed and inserted by the engine, Compare from another draft's bytes, a version restored from
// bytes, and Save As's kinds from the engine. The real engine runs here (src/engine/wasm, npm run build first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine, convert as ewConvert } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { adopt, modelBytes } from '../src/engine/model/form.mjs';
import { convert, domDocOf } from '../src/engine/model/read.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { DEFAULTS, engineArgs, refusal } from '../src/document/wp/compare/compare.mjs';
import { OBJECTS } from '../src/document/canvas/rows/objects.mjs';
import { REVIEW } from '../src/document/canvas/rows/review.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const dec = (b) => new TextDecoder().decode(b);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const exec = (e, id, args = {}) => JSON.parse(e.exec(id, JSON.stringify(args)));
/** An engine holding `html`, as a session would. */
function engineOf(html) {
  const e = new Engine();
  e.paste('html', new TextEncoder().encode(html));
  return e;
}
/** A canvas record holding the engine `e`'s document. */
const recordOf = (e, title = 'Canvas draft') => {
  const d = { id: 'c1', title, format: 'document' };
  adopt(d, e.save('engine'));
  return d;
};
/** The window's engine host as read.mjs needs it: the helper's convert, here in this thread. */
const host = { convert: async (model, kind) => ewConvert(model, kind) };
const textOf = (doc) => JSON.stringify(doc).match(/"text":"[^"]*"/g)?.map((t) => t.slice(8, -1)).join(' ') ?? '';

test('a canvas record reads as a DOM doc through the engine .docx, and as text; a record with a missing picture refuses', async () => {
  const d = recordOf(engineOf('<p>Alpha paragraph</p><p>Beta paragraph</p>'));
  assert.match(dec(await convert(host, d, 'txt')), /^Alpha paragraph\r?\nBeta paragraph/);
  const doc = await domDocOf(d, { host, read: async (bytes) => ({ doc: (await importDocx(bytes)).doc }) });
  assert.equal(doc.type, 'doc');
  assert.match(textOf(doc), /Alpha paragraph Beta paragraph/);
  // A DOM record is its own doc, with no engine call.
  const dom = { format: 'document', doc: { type: 'doc', content: [] } };
  assert.equal(await domDocOf(dom, { host: null, read: null }), dom.doc);
  // A picture whose file was missing from images/ keeps its reference: unreadable, as the canvas editor refuses it.
  const missing = { ...d, engine: { ...d.engine, model: d.engine.model.replace('"body"', `"x":"data:image/png;sha256,ab","body"`) } };
  await assert.rejects(convert(host, missing, 'docx'), /pictures is missing/);
  assert.match(refusal(missing, 3), /cannot be compared: one of its pictures is missing/);
  assert.equal(refusal(d, 3), null, 'a canvas record with no doc can be compared');
  assert.match(refusal({ format: 'document' }, 3), /could not be loaded/);
});

test("Save As's kinds come from the engine: docx, html, txt, md, rtf and odt", () => {
  const e = engineOf('<h1>Report</h1><p>Plain <b>bold</b> words.</p>');
  const out = Object.fromEntries(['docx', 'html', 'txt', 'md', 'rtf', 'odt'].map((k) => [k, e.save(k)]));
  assert.equal(String.fromCharCode(...out.docx.slice(0, 2)), 'PK');
  assert.equal(String.fromCharCode(...out.odt.slice(0, 2)), 'PK');
  assert.match(dec(out.html), /Report[\s\S]*<b>bold<\/b>|Report[\s\S]*<strong>bold<\/strong>/);
  assert.match(dec(out.txt), /Report\r?\nPlain bold words\./);
  assert.match(dec(out.md), /# Report[\s\S]*\*\*bold\*\*/);
  assert.match(dec(out.rtf), /^\{\\rtf1[\s\S]*Plain [\s\S]*bold/);
  // The helper's convert writes the same from a model, with no layout.
  assert.equal(dec(ewConvert(e.save('engine'), 'md')), dec(out.md));
});

test('box.insert puts a box at the caret, box.list reports it with the column, and a flowchart link drops through box.set', () => {
  const e = engineOf('<p>Before the boxes.</p>');
  exec(e, 'caret.docEnd');
  const { column } = exec(e, 'box.list').value;
  assert.ok(column > 300, `the text column in points: ${column}`);
  const flow = { id: 'f-1', rev: 2 };
  assert.ok(exec(e, 'box.insert', { kind: 'canvas', data: JSON.stringify({ w: 600, h: 450, items: [], flow }), fallback: `data:image/png;base64,${PNG}` }).ok);
  assert.ok(exec(e, 'box.insert', { kind: 'planChart', data: JSON.stringify({ planId: 'p' }), fallback: PNG }).ok);
  e.pages(); // the frames get their stable ids from the session
  const [canvas, chart] = exec(e, 'box.list').value.boxes;
  assert.equal(canvas.kind, 'canvas');
  assert.equal(chart.kind, 'planChart');
  assert.ok(canvas.id > 0 && chart.id > 0 && canvas.id !== chart.id, 'stable ids');
  assert.equal(Math.round(canvas.w), Math.round(column));
  const r = JSON.parse(e.execMany(JSON.stringify([['box.set', { id: canvas.id, data: JSON.stringify({ ...JSON.parse(canvas.data), flow: null }) }]])));
  assert.ok(r.ok);
  assert.equal(JSON.parse(exec(e, 'box.list').value.boxes[0].data).flow, null);
  // The boxes survive the engine form, as a reload reads it.
  const again = new Engine();
  again.open(e.save('engine'), 'engine');
  assert.deepEqual(exec(again, 'box.list').value.boxes.map((b) => b.kind), ['canvas', 'planChart']);
});

test('Compare and Combine take the other draft as bytes, either form; Restore Version puts a version back in one undo step', () => {
  const original = engineOf('<p>Keep one.</p><p>The quick fox.</p>');
  const revised = engineOf('<p>Keep one.</p><p>The quick cat.</p><p>A new line.</p>');
  const e = new Engine();
  e.open(original.save('engine'), 'engine');
  const r = exec(e, 'review.compare', { ...engineArgs('Rev A', DEFAULTS), revisedData: b64(revised.save('docx')), revisedKind: 'docx' });
  assert.ok(r.ok && r.value.changes >= 2, JSON.stringify(r));
  const changes = exec(e, 'review.changes').value;
  assert.ok(JSON.stringify(changes).includes('Rev A'), 'the changes carry the label');
  exec(e, 'review.acceptAll');
  assert.match(dec(e.save('txt')), /The quick cat\.\r?\nA new line\./);
  // Both sides from bytes, into a session holding something else (Show changes in the revised draft).
  const c = engineOf('<p>Unrelated.</p>');
  assert.ok(exec(c, 'review.combine', { ...engineArgs('Rev B'), originalData: b64(original.save('engine')), originalKind: 'engine',
    revisedData: b64(revised.save('engine')), revisedKind: 'engine' }).ok);
  exec(c, 'review.rejectAll');
  assert.match(dec(c.save('txt')), /^Keep one\.\r?\nThe quick fox\./);
  // Restore: a backup version's engine form, then undo.
  const now = engineOf('<p>Now.</p>');
  assert.ok(exec(now, 'file.restoreVersion', { data: b64(original.save('engine')) }).ok);
  assert.match(dec(now.save('txt')), /The quick fox/);
  exec(now, 'edit.undo');
  assert.match(dec(now.save('txt')), /^Now\./);
});

test('engineArgs maps the dialog settings to review.compare', () => {
  assert.deepEqual(engineArgs('Me', { ...DEFAULTS, caseChanges: false, level: 'char' }),
    { author: 'Me', caseChanges: false, whiteSpace: true, formatting: true, level: 'character',
      moves: true, comments: true, headersFooters: true, footnotes: true, textBoxes: true, fields: true });
});

test('on a canvas draft the box inserts and Compare rows run, none is off', () => {
  for (const id of ['insert.illustrations.shapes.newDrawingCanvas', 'x.insert.boards.canvas', 'x.insert.boards.flowchart', 'x.insert.boards.planChart']) {
    assert.equal(formOf(OBJECTS[id]), 'spec', id);
  }
  for (const id of ['review.compare.compare.compare', 'review.compare.compare.combine', 'review.compare.compare.showSourceDocuments', 'file.info.versionHistory']) {
    assert.equal(formOf(REVIEW[id]), 'app', id);
  }
});

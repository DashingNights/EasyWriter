// engine-helper (docs/plans/engine/viewport-design.md section 8, the first of section 16's conditional packages): opens and PDF
// export in a helper worker, and Print and Create PDF on canvas drafts. The helper's script (src/engine/helper.js) runs here as a
// worker runs it (self.onmessage in, postMessage out, fetch reading the files beside it) on the engine's WebAssembly, beside
// instances of its own that stand in for the engine worker: a .docx read into the engine form in the helper opens as the same
// document as the .docx itself, a PDF there asks for the fonts its layout lacks and waits for them, the engine worker names
// the fonts a draft used, and the registry runs the canvas table's Print and Create PDF rows on the session. The harness case
// (.smoke-data/word/cases/engine-helper.js) measures the stall in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setState } from '../src/app/store.js';
import { sessionRows } from '../src/document/canvas/commands.mjs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { commandOf, registerModule } from '../src/tooling/registry.js';

const MODULE = new WebAssembly.Module(fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)));
const LIBERATION = fs.readFileSync(new URL('../src/vendor/fonts/liberation/LiberationSans-Regular.ttf', import.meta.url));
const DOCS = [new URL('./fixtures/engine-boxes.docx', import.meta.url), new URL('../.smoke-data/word/fixtures/ethics-form.docx', import.meta.url)]
  .filter((u) => fs.existsSync(u));
const J = JSON.parse;
const exec = (e, id, args = {}) => J(e.exec(id, JSON.stringify(args)));

/** An instance of its own (one worker's font database and caches), from the same module. */
async function instance(name) {
  const ew = await import(new URL(`../src/engine/wasm/ew.js?${name}`, import.meta.url).href);
  ew.initSync({ module: MODULE });
  await addBundledFonts(ew, (url) => fs.readFileSync(url));
  return ew;
}

// The helper worker's script in this thread.
const replies = new Map();
const events = [];
globalThis.self = globalThis;
globalThis.postMessage = (m) => (m.event ? events.push(m) : replies.get(m.id)?.(m));
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const u = new URL(url);
  if (u.protocol !== 'file:') return realFetch(url, ...rest);
  return fs.existsSync(u) ? new Response(fs.readFileSync(u)) : new Response(null, { status: 404 });
};
await import('../src/engine/helper.js');
self.onmessage({ data: { module: MODULE } });
let next = 1;
const helper = (method, ...args) => new Promise((resolve, reject) => {
  const id = next++;
  replies.set(id, (m) => ('error' in m ? reject(new Error(m.error)) : resolve(m.result)));
  self.onmessage({ data: { id, method, args } });
});
const until = async (fn, ms = 20000) => {
  for (const end = Date.now() + ms; !fn() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5));
  return fn();
};

test('a .docx read into the engine form in the helper opens as the same document as the .docx itself', async () => {
  assert.ok(DOCS.length, 'a fixture to open');
  const [a, b] = [await instance('direct'), await instance('main')];
  for (const url of DOCS) {
    const bytes = fs.readFileSync(url);
    const direct = new a.Engine();
    const opened = J(direct.open(bytes, 'docx'));
    const model = await helper('engineForm', bytes, 'docx');
    const loaded = new b.Engine();
    assert.equal(J(loaded.open(model, 'engine')).pages, opened.pages, url.pathname);
    assert.equal(loaded.layoutDigest(), direct.layoutDigest(), `${url.pathname}: the same pages`);
    assert.ok(Buffer.from(loaded.save('engine')).equals(Buffer.from(direct.save('engine'))), `${url.pathname}: the same engine form`);
    direct.free();
    loaded.free();
  }
  await assert.rejects(helper('engineForm', new Uint8Array([1, 2, 3]), 'docx'), 'a file that is no .docx fails with its reason');
});

test('the engine worker names the fonts a draft used, a missing family with its stand-ins', async () => {
  const ew = await instance('fonts');
  assert.ok(ew.addFont(LIBERATION) > 0);
  const e = new ew.Engine();
  e.insertText('Latin text');
  exec(e, 'select.all');
  exec(e, 'format.font', { name: 'Liberation Sans' });
  exec(e, 'select.all');
  e.insertText('Latin text \u4E2D\u6587');
  exec(e, 'text.newParagraph');
  exec(e, 'format.font', { name: 'Calibri' });
  e.insertText('More');
  e.pages();
  const used = J(e.fontsUsed());
  assert.ok(used.families.includes('Liberation Sans'), JSON.stringify(used));
  const calibri = used.families.find((f) => f.family === 'Calibri');
  assert.ok(calibri && calibri.standIns.length > 0, `Calibri is missing here, with its stand-ins: ${JSON.stringify(used)}`);
  assert.ok(used.scripts.length > 0, `the Chinese text asked for a script's font: ${JSON.stringify(used)}`);
  e.free();
});

test('a PDF in the helper asks for the fonts its layout lacks and waits for them', async () => {
  const ew = await instance('pdf');
  ew.addFont(LIBERATION);
  const e = new ew.Engine();
  e.insertText('Set in Liberation Sans');
  exec(e, 'select.all');
  exec(e, 'format.font', { name: 'Liberation Sans' });
  const model = e.save('engine');
  e.free();
  events.length = 0;
  const job = helper('pdf', model, {}, true);
  assert.ok(await until(() => events.length), 'fonts.missing went out');
  assert.equal(events[0].event, 'fonts.missing');
  assert.deepEqual(events[0].data.families.map((f) => f.family), ['Liberation Sans']);
  assert.ok((await helper('addFont', LIBERATION)) > 0);
  await helper('fontsDone');
  const r = await job;
  assert.equal(Buffer.from(r.bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.ok(Buffer.from(r.bytes).toString('latin1').includes('LiberationSans'), 'the font that arrived is embedded');
  assert.deepEqual(r.outlined, []);
  assert.ok(Number.isFinite(r.ms));
  const stats = await helper('stats');
  assert.ok(stats.fonts >= LIBERATION.length && stats.wasm > stats.fonts, JSON.stringify(stats));
  // Without a provider (fonts false) nothing is asked and the PDF draws in what the helper has.
  events.length = 0;
  const plain = await helper('pdf', model, {}, false);
  assert.equal(events.length, 0);
  assert.equal(Buffer.from(plain.bytes.subarray(0, 5)).toString(), '%PDF-');
});

test('Print and Create PDF on a canvas draft run on its session through the table, and an outlined font is noticed', async () => {
  const saved = [];
  const notices = [];
  const errors = [];
  const printed = [];
  const rows = sessionRows({
    title: () => 'Notes: week 1',
    saveFile: async (f) => (saved.push(f), 'C:/out/notes.pdf'),
    notice: (families) => notices.push(families),
    error: (text) => errors.push(text),
  });
  let answer = { ok: true, error: null, outlined: [] };
  const session = {
    pdf: async () => ({ bytes: new TextEncoder().encode('%PDF-1.7'), outlined: ['Aptos'], why: ['Aptos Regular: its licence'], ms: 1 }),
    print: async (job, printer) => (printed.push([job, printer]), answer),
    exec: async () => ({ ok: true }),
    state: async () => ({}),
    on: () => () => {},
  };
  // The registry hands a canvas draft the row itself.
  registerModule({ id: 'canvas-engine', engine: rows }, ['document']);
  registerModule({ id: 'print', commands: { 'file.export.pdf': { run: () => 'dom' } } }, ['document']);
  setState({ editor: null, draft: { format: 'document' }, view: { type: 'editor' }, settings: {}, focusedSession: session });
  assert.equal(commandOf('file.export.pdf'), rows['file.export.pdf']);
  assert.equal(rows['file.export.pdf'].enabled({ engine: null }), false);
  assert.equal(await rows['file.export.pdf'].run({ engine: session }), 'C:/out/notes.pdf');
  assert.equal(saved[0].name, 'Notes  week 1.pdf');
  assert.equal(saved[0].data, Buffer.from('%PDF-1.7').toString('base64'));
  assert.deepEqual(notices, [['Aptos']]);
  assert.equal(await rows['print.quickPrint'].run({ engine: session }), true);
  assert.equal(await rows['file.print'].run({ engine: session }), true);
  assert.deepEqual(printed, [[{}, { silent: true }], [{}, {}]]);
  // A failed job says why; a cancelled one says nothing.
  answer = { ok: false, error: 'Print job canceled', outlined: [] };
  await rows['file.print'].run({ engine: session });
  answer = { ok: false, error: 'No printer', outlined: [] };
  await rows['file.print'].run({ engine: session });
  assert.deepEqual(errors, ['Could not print: No printer']);
  setState({ focusedSession: null });
});

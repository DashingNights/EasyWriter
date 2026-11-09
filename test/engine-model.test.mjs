import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileFamily } from '../src/file-family.js';
import { DOM_VERSION, FORM, FORMAT_VERSION, VERSION, adopt, isCanvas, kindOf, modelBytes, openDraft, recordText, toCanvas, toDom, unreadable } from '../src/engine/model/form.mjs';
import marks from '../src/draft-marks.js';
import { autosave } from '../src/engine/model/autosave.mjs';
import { DOCUMENT } from '../src/formats.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx } from '../src/document/docx/import.mjs';
import { newDocumentJson } from '../src/document/defaults.mjs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const START = JSON.stringify({ story: 'body', path: [0], off: 0 });

/** The engine in this thread with the client's promise API (engine plan §3), for open and save. */
function realClient() {
  const e = new Engine();
  return { e, open: async (b, k) => JSON.parse(e.open(b, k)), save: async (k) => e.save(k), pages: () => JSON.parse(e.pages()).pages };
}
const dec = (b) => new TextDecoder().decode(b);
// DATE and TIME fields refresh their result on every open.
const timeless = (s) => s.replace(/("instr":"\s*(?:DATE|TIME)\b(?:[^"\\]|\\.)*","result":)"(?:[^"\\]|\\.)*"/g, '$1""');

// The engine's save('engine') writes its pictures as data URLs (model.md, The 'engine' bytes), so main.js moves them to images/.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const model = (text) => ({ body: [{ kind: 'para', text, runs: [{ len: text.length, props: { size: 11.5 } }] }], styles: { x: 0.89992124 },
  media: { 'image1.png': `data:image/png;base64,${PNG}` }, passthrough: { 'customXml/item1.xml': 'PHg+PC94Pg==' } });
const enc = (v) => new TextEncoder().encode(JSON.stringify(v));

/** A stand-in for the engine client (engine plan §3): open and save only. 'docx' bytes pass through unchanged. */
function stubClient(m = null) {
  const c = {
    model: m, docx: null, opened: [], saves: 0, delay: 0,
    async open(bytes, kind) {
      c.opened.push(kind);
      if (kind === 'engine') c.model = JSON.parse(new TextDecoder().decode(bytes));
      else [c.docx, c.model] = [bytes, model('from a Word file')];
      return { pages: 1 };
    },
    async save(kind) {
      c.saves++;
      if (c.delay) await new Promise((r) => setTimeout(r, c.delay));
      return kind === 'docx' ? c.docx : enc(c.model);
    },
  };
  return c;
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ew-engine-model-'));

test('recordText splices the model text in unparsed and keeps the rest of the record, without a DOM doc', () => {
  const draft = { id: 'x', title: 'T', format: 'document', doc: { type: 'doc' } };
  const text = adopt(draft, enc(model('Hello')));
  const back = JSON.parse(text);
  // engine-undo-file: each engine save stamps the envelope, which the undo history saved beside it names.
  assert.deepEqual(back.engine, { form: FORM, version: VERSION, stamp: back.engine.stamp, model: model('Hello') });
  assert.ok(back.engine.stamp && JSON.parse(adopt({ ...draft }, enc(model('Hello')))).engine.stamp !== back.engine.stamp);
  assert.equal(back.formatVersion, FORMAT_VERSION);
  assert.ok(!('doc' in back) && !('doc' in draft), 'stage2b.md decision 1: the engine holds the document');
  // A record saved before keeps its stale doc until its next save, which leaves it out.
  assert.ok(!('doc' in JSON.parse(recordText({ ...back, doc: { type: 'doc' } }))));
  assert.equal(back.title, 'T');
  assert.equal(typeof draft.engine.model, 'string', 'kept as text in memory: a generic save writes it as a string');
  // A record loaded from disk holds the model as an object; both forms give the same bytes to open.
  assert.deepEqual(JSON.parse(new TextDecoder().decode(modelBytes(back.engine))), model('Hello'));
  assert.equal(recordText(back), text);
  assert.ok(isCanvas(back) && !isCanvas({ doc: {} }));
});

test('a record saved and loaded through the drafts file family comes back the same, its picture in images/', async () => {
  const dir = tempDir();
  const images = path.join(dir, 'images');
  const drafts = fileFamily(() => path.join(dir, 'drafts'), { images: () => images });
  const draft = { title: 'T', format: 'document', doc: { type: 'doc' } };
  const text = adopt(draft, enc(model('Saved')));
  const { id } = await drafts.save(JSON.parse(text)); // main.js saveDraft parses the text the page sends
  const onDisk = fs.readFileSync(path.join(dir, 'drafts', `${id}.json`), 'utf8');
  assert.ok(!onDisk.includes(PNG) && fs.readdirSync(images).length === 1, 'the picture moved to images/');
  assert.ok(onDisk.includes('PHg+PC94Pg=='), 'other parts stay inline');
  const loaded = await drafts.load(id);
  assert.equal(unreadable(loaded.engine), null);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(modelBytes(loaded.engine))), model('Saved'));
  // A generic save (actions.js draftMeta) of the in-memory draft writes the model as a string; it still loads the same.
  const meta = await drafts.save({ ...draft, id });
  assert.equal(meta.id, id);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(modelBytes((await drafts.load(id)).engine))), model('Saved'));
});

test('a record whose picture file is missing from images/ is refused, never opened, and loads once the file is back', async () => {
  const dir = tempDir();
  const images = path.join(dir, 'images');
  const drafts = fileFamily(() => path.join(dir, 'drafts'), { images: () => images });
  const { id } = await drafts.save(JSON.parse(adopt({ title: 'T', format: 'document' }, enc(model('Synced')))));
  const [pic] = fs.readdirSync(images);
  fs.renameSync(path.join(images, pic), path.join(dir, pic)); // a backup that copied the record but not yet its picture
  const loaded = await drafts.load(id);
  assert.match(unreadable(loaded.engine), /pictures is missing/);
  const c = stubClient();
  await assert.rejects(openDraft(c, loaded, {}), /pictures is missing/);
  assert.deepEqual(c.opened, [], 'the engine never saw it, so nothing saves over the record');
  // The model as text (a save in this session) is checked too.
  assert.match(unreadable({ ...loaded.engine, model: JSON.stringify(loaded.engine.model) }), /pictures is missing/);
  fs.renameSync(path.join(dir, pic), path.join(images, pic));
  assert.equal(unreadable((await drafts.load(id)).engine), null);
});

test('kindOf: .doc and .dot open as the binary kind, every other Word file as docx', () => {
  assert.deepEqual(['a.doc', 'b.DOT', 'c.docx', 'd.dotx', 'e.docm'].map(kindOf), ['doc', 'doc', 'docx', 'docx', 'docx']);
});

test("the drafts list's marks of a canvas record come from its model's boxes, never from a stale doc", () => {
  const box = (kind, data) => ({ kind: 'para', text: '\ufffc', objects: [{ type: 'shape', float: { id: 3, box: { kind, data: JSON.stringify(data) } } }] });
  const m = { body: [box('canvas', { w: 400, flow: { id: 'flow-1' } }), { kind: 'table', rows: [{ cells: [{ blocks: [box('planChart', { planId: 'plan-1' })] }] }] },
    box('canvas', { w: 10 }), { kind: 'para', text: 'x', runs: [{ len: 1, props: { box: 'not a box' } }] }],
  parts: { header1: { blocks: [box('canvas', { flow: { id: 'flow-2' } })] } } };
  const stale = { type: 'doc', attrs: { suggest: { attrs: [{ id: 's1' }] } }, content: [{ type: 'canvas', attrs: { flow: { id: 'old' } } }] };
  const record = JSON.parse(adopt({ title: 'T', format: 'document' }, enc(m)));
  const want = { suggestions: 0, flows: ['flow-1', 'flow-2'], plans: ['plan-1'] };
  assert.deepEqual(marks.recordMarks({ ...record, doc: stale }), want);
  assert.deepEqual(marks.engineMarks(JSON.stringify(m)), want, 'the model as text, as a save in this session leaves it');
  assert.deepEqual(marks.engineMarks(JSON.stringify(model('No boxes'))), { suggestions: 0, flows: [], plans: [] });
  assert.deepEqual(marks.recordMarks({ doc: stale }), { suggestions: 1, flows: ['old'], plans: [] }, 'a DOM draft reads its doc');
});

test("the drafts list counts a canvas record's waiting suggestions as cardsOf's cards", () => {
  const rev = (kind, tag) => ({ kind, author: 'Assistant', date: '2026-11-01T00:00:00Z', ...(tag ? { tag } : {}) });
  const m = {
    // A replace (0 and 1), an insertion over two paragraphs and its mark (2), an untagged change (3) and an accepted one (4).
    revisions: [rev('delete', 'g1'), rev('insert', 'g1'), rev('insert', 'g2'), rev('insert'), rev('insert', 'g3')],
    body: [{ kind: 'para', text: 'abcdefgh', runs: [{ len: 3 }, { len: 2, props: { del: 0 } }, { len: 2, props: { ins: 1 } }, { len: 1, props: { ins: 3 } }] },
      { kind: 'para', text: 'xy', runs: [{ len: 2, props: { ins: 2 } }], mark: { ins: 2 } },
      { kind: 'para', text: 'z', runs: [{ len: 1, props: { fmtChange: { rev: 4, old: {} } } }] }],
  };
  assert.equal(marks.engineMarks(JSON.stringify(m)).suggestions, 3, 'the replace, the insertion and the format change');
  m.body[2].runs[0].props = {};
  assert.equal(marks.engineMarks(m).suggestions, 2, 'a revision no run points at is resolved');
});

test('unreadable names a newer pin, an unknown form and a missing model', () => {
  assert.match(unreadable({ form: 'wordcraft-json', pin: 'ffffffff', model: {} }), /newer/);
  assert.match(unreadable({ form: 'other', version: VERSION, model: {} }), /does not know/);
  assert.match(unreadable({ form: FORM, version: VERSION }), /missing/);
});

test('open: a Word file by its extension, an engine record as engine bytes; an unreadable one throws', async () => {
  const c = stubClient();
  await openDraft(c, {}, { file: { name: 'a.DOC', bytes: new Uint8Array([1]) } });
  await openDraft(c, {}, { file: { name: 'a.dot', bytes: new Uint8Array([1]) } });
  await openDraft(c, {}, { file: { name: 'a.docx', bytes: new Uint8Array([1]) } });
  const draft = { format: 'document' }; // what the draft's format opens as, since sourceOf takes the kind from it (post-host C1)
  adopt(draft, enc(model('Engine')));
  await openDraft(c, draft, {});
  assert.deepEqual(c.opened, ['doc', 'doc', 'docx', 'engine']);
  assert.deepEqual(c.model, model('Engine'));
  await assert.rejects(openDraft(c, { engine: { form: 'wordcraft-json', pin: 'ffffffff', model: {} } }, {}), /newer version/);
});

test('switching: a DOM draft goes to the canvas through export.mjs and back through import.mjs with its text', async () => {
  const doc = newDocumentJson();
  doc.content = [{ type: 'paragraph', content: [{ type: 'text', text: 'Switch me', marks: [{ type: 'bold' }] }] }];
  const draft = { id: 'd', title: 'T', format: 'document', formatVersion: DOCUMENT.version, doc };
  const c = stubClient();
  const { record } = await toCanvas(c, draft, { docx: (d) => exportDocx(d.doc, { title: d.title }) });
  assert.deepEqual(c.opened, ['docx']);
  assert.ok(isCanvas(draft) && JSON.parse(record).engine.model.body);
  const { draft: back } = await toDom(c, draft, { read: (bytes) => importDocx(bytes) });
  assert.equal(back.engine, undefined);
  assert.equal(back.formatVersion, DOM_VERSION);
  const para = back.doc.content.find((n) => n.type === 'paragraph' && n.content?.[0]?.text === 'Switch me');
  assert.ok(para?.content[0].marks.some((m) => m.type === 'bold'), JSON.stringify(back.doc.content.slice(0, 2)));
});

test('autosave: one save after a burst of edits, edits during a save get the next, a failed store stays unsaved', async () => {
  const c = stubClient(model('a'));
  const draft = { title: 'T', format: 'document' };
  const stored = [];
  let fail = false;
  let pieces = [];
  const store = async (part, i, n) => {
    if (fail) throw new Error('disk full');
    pieces[i] = part;
    if (i < n - 1) return null;
    stored.push(JSON.parse(pieces.join('')));
    pieces = [];
    return { id: 'id1', updated: stored.length };
  };
  const errors = [];
  let firstSave;
  const saved = new Promise((r) => { firstSave = r; });
  const a = autosave(c, draft, store, { idle: 30, onSaved: () => firstSave(), onError: (e) => errors.push(e.message) });
  for (const t of ['ab', 'abc', 'abcd']) { c.model = model(t); a.changed(); }
  // The save itself, not a fixed wait: its page share runs in idle tasks, timers in node, which a loaded machine delays.
  await saved;
  await new Promise((r) => setTimeout(r, 50)); // past the idle time again: the burst made no second save
  assert.equal(c.saves, 1);
  assert.equal(stored.at(-1).engine.model.body[0].text, 'abcd');
  assert.equal(draft.id, 'id1');
  // An edit while the worker serialises is saved by a second save.
  c.delay = 40;
  a.changed();
  const first = a.flush();
  await new Promise((r) => setTimeout(r, 10));
  c.model = model('later');
  a.changed();
  await first;
  await a.flush();
  assert.equal(stored.at(-1).engine.model.body[0].text, 'later');
  fail = true;
  a.changed();
  assert.equal(await a.flush(), false);
  assert.ok(a.dirty && errors.includes('disk full'));
  fail = false;
  assert.equal(await a.flush(), true);
  assert.ok(!a.dirty && a.last.chars > 0);
  a.stop();
});

test('the engine form round trips the Word fixture: the same model and the same pages', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, async () => {
  const c = realClient();
  const draft = { title: 'Fixture', format: 'document' };
  const { record, pages } = await toCanvas(c, draft, { file: { name: 'all-features.docx', bytes: fs.readFileSync(FIXTURE) } });
  const first = c.pages();
  const t0 = performance.now();
  const bytes = await c.save('engine');
  const saveMs = performance.now() - t0;
  const model = dec(bytes);
  assert.ok(model.length < 8e6 && !model.includes('\n  '), `compact: ${model.length} chars`);
  const parsed = JSON.parse(record).engine.model;
  const media = Object.entries(parsed.media);
  assert.ok(media.length > 50 && media.every(([n, v]) => !/\.(png|jpe?g|emf|wmf|gif)$/i.test(n) || /^data:image\/[a-z]+;base64,/.test(v)), 'pictures are data URLs');

  const t1 = performance.now();
  const again = (await openDraft(c, draft, {})).pages;
  const openMs = performance.now() - t1;
  assert.equal(again, pages);
  assert.deepEqual(c.pages(), first, 'the same pages: sizes and sections');
  assert.equal(timeless(dec(await c.save('engine'))), timeless(model), 'the same model, DATE and TIME results aside');
  console.log(`fixture: ${pages} pages, engine form ${(model.length / 1e6).toFixed(2)} MB, save ${Math.round(saveMs)} ms, open again ${Math.round(openMs)} ms`);
  c.e.free();
});

test('switching with the engine: a DOM draft goes to the canvas, is edited and comes back with the edit', async () => {
  const doc = newDocumentJson();
  doc.content = [{ type: 'paragraph', content: [{ type: 'text', text: 'Switch me', marks: [{ type: 'bold' }] }] }];
  const draft = { id: 'd', title: 'T', format: 'document', formatVersion: DOCUMENT.version, doc };
  const c = realClient();
  await toCanvas(c, draft, { docx: (d) => exportDocx(d.doc, { title: d.title }) });
  c.e.select(START, START);
  c.e.insertText('Edited ');
  const { draft: back } = await toDom(c, draft, { read: (bytes) => importDocx(bytes) });
  const text = JSON.stringify(back.doc.content);
  assert.ok(text.includes('Edited ') && text.includes('Switch me'), text.slice(0, 400));
  c.e.free();
});

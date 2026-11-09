// stage3-documents (docs/plans/word/briefs/stage3-documents.md): one constant holds the Documents default, a DOM draft converts as it
// opens with its DOM form kept until the first save, and a draft the engine cannot take stays on the DOM editor and says why. The
// harness case .smoke-data/word/cases/stage3-documents.js runs the app; this file runs the real engine and exporter in this thread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOCUMENTS_ON_ENGINE } from '../src/formats.mjs';
import { WORD_DEFAULTS, wordSettings } from '../src/document/word/settings.mjs';
import { keepDom, list, openChecked, refused, restoreDom, stayLine } from '../src/document/canvas/convert.mjs';
import { adopt, DOM_VERSION, FORMAT_VERSION, isCanvas, modelBytes } from '../src/engine/model/form.mjs';
import { saveOnce } from '../src/engine/model/autosave.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { areaOpens } from '../src/tooling/surface.js';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

function realClient() {
  const e = new Engine();
  return { open: async (b, k) => JSON.parse(e.open(b, k)), save: async (k) => e.save(k) };
}
const domDraft = (text = 'Written on the DOM editor') => ({ id: 'd', title: 'Notes', format: 'document', formatVersion: DOM_VERSION,
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
const docx = (d) => exportDocx(d.doc, { title: d.title });
const text = (bytes) => new TextDecoder().decode(bytes);

test('the constant is the one source of the default, and a stored value is one user\'s choice over it', () => {
  assert.equal(WORD_DEFAULTS.canvasEngine, DOCUMENTS_ON_ENGINE);
  assert.equal(wordSettings({}).canvasEngine, DOCUMENTS_ON_ENGINE);
  assert.equal(wordSettings({ word: { zoomSlider: true } }).canvasEngine, DOCUMENTS_ON_ENGINE, 'another stored Word setting leaves the default');
  assert.equal(wordSettings({ word: { canvasEngine: false } }).canvasEngine, false);
  assert.equal(wordSettings({ word: { canvasEngine: true } }).canvasEngine, true);
});

test('with the switch on a Document shows in the page area, a forum post and a refused draft do not', () => {
  const on = { word: { canvasEngine: true } };
  const view = { type: 'editor' };
  const draft = domDraft();
  assert.ok(areaOpens({ view, draft, settings: on }));
  assert.ok(!areaOpens({ view, draft: { ...draft, format: 'forum-post' }, settings: on }));
  assert.ok(!areaOpens({ view, draft, settings: on, engineRefused: draft }));
  assert.ok(areaOpens({ view, draft: domDraft(), settings: on, engineRefused: draft }), 'the same draft opened again is another object: the engine tries it again');
  assert.ok(!areaOpens({ view, draft, settings: { word: { canvasEngine: false } } }), 'View > Canvas engine turns it off for one user');
});

test('a DOM draft converts: the first save stores the canvas form, which the engine reopens', async () => {
  const c = realClient();
  const draft = domDraft();
  const before = JSON.stringify(draft);
  const kept = keepDom(draft);
  await openChecked(c, draft, { docx });
  assert.equal(JSON.stringify(draft), before, 'opening changes nothing: the first save does');
  const parts = [];
  await saveOnce(c, draft, (part) => (parts.push(part), { id: 'd', updated: 2 }));
  const stored = JSON.parse(parts.join(''));
  assert.ok(isCanvas(draft) && kept.doc);
  assert.equal(stored.formatVersion, FORMAT_VERSION);
  assert.ok(!('doc' in stored), 'the canvas record keeps no DOM doc');
  const again = realClient();
  await again.open(modelBytes(stored.engine), 'engine');
  assert.match(text(await again.save('engine')), /Written on the DOM editor/);
});

test('the DOM form stays until a first save has stored: a store that fails leaves it, whole', async () => {
  const c = realClient();
  const draft = domDraft();
  const disk = JSON.stringify(draft);
  const kept = keepDom(draft);
  await openChecked(c, draft, { docx });
  await assert.rejects(saveOnce(c, draft, () => { throw new Error('disk full'); }), /disk full/);
  assert.ok(isCanvas(draft) && !draft.doc, 'adopt has taken the draft before the store answers, which is why the form is kept');
  restoreDom(draft, kept);
  assert.equal(JSON.stringify(draft), disk);
  assert.ok(!isCanvas(draft));
});

test('a conversion that cannot finish changes nothing and the line says why', async () => {
  const draft = domDraft();
  const before = JSON.stringify(draft);
  const broken = { open: async () => { throw new Error('reader panicked at crates/docx'); } };
  const failure = await openChecked(broken, draft, { docx }).catch((e) => e);
  assert.equal(JSON.stringify(draft), before);
  assert.equal(stayLine(draft.title, failure), 'Notes stays in the DOM editor because the canvas engine could not read it.');

  // An export that left something out would lose it at the first save.
  const lost = await openChecked(realClient(), draft, { docx: async (d) => ({ ...(await docx(d)), dropped: ['charts', 'page fill effects'] }) }).catch((e) => e);
  assert.equal(stayLine('', lost), 'This draft stays in the DOM editor because the canvas engine cannot take its charts and page fill effects.');
  assert.equal(stayLine('Notes', refused('its canvas form could not be saved')), 'Notes stays in the DOM editor because its canvas form could not be saved.');
  assert.equal(list(['a', 'b', 'c']), 'a, b and c');
});

test('a draft the engine cannot read is refused before the engine sees it, or by the engine, and nothing is overwritten', async () => {
  // A canvas record of a newer build: no DOM form to go back to, so the page area says why and saves nothing over it.
  const newer = domDraft();
  adopt(newer, '{"body":[]}');
  newer.engine.version = 999;
  const record = JSON.stringify(newer);
  assert.equal(keepDom(newer), null);
  let opened = 0;
  await assert.rejects(openChecked({ open: async () => { opened++; } }, newer, {}), /newer version of EasyWriter saved it/);
  assert.equal(opened, 0);
  assert.equal(JSON.stringify(newer), record);

  // A DOM draft whose .docx the real engine will not read.
  const draft = domDraft();
  const before = JSON.stringify(draft);
  await assert.rejects(openChecked(realClient(), draft, { docx: async () => ({ bytes: new Uint8Array([1, 2, 3]), dropped: [] }) }));
  assert.equal(JSON.stringify(draft), before);
});

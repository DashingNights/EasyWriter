// engine-editable (docs/plans/word/briefs/engine-editable.md): canvas drafts are edited and saved through the engine. The harness
// case .smoke-data/word/cases/engine-editable.js runs the app; this file checks the pure parts: the version a canvas draft carries
// against the build that reads it, which layout events need a save, and one save's pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DOCUMENT, formatOf } from '../src/formats.mjs';
import { loadable } from '../src/editors.js';
import { adopt, DOM_VERSION, FORMAT_VERSION, recordText } from '../src/engine/model/form.mjs';
import { editWatch, saveOnce } from '../src/engine/model/autosave.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { newDocumentJson } from '../src/document/defaults.mjs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

const enc = (v) => new TextEncoder().encode(JSON.stringify(v));
const DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stale DOM form' }] }] };

test('a canvas draft opens in this build and is refused by a build whose Document version is 2, which still opens DOM drafts', () => {
  assert.equal(DOCUMENT.version, FORMAT_VERSION);
  const canvas = { format: 'document', doc: DOC };
  adopt(canvas, enc({ body: [] }));
  const dom = { format: 'document', formatVersion: DOM_VERSION, doc: DOC };
  assert.equal(canvas.formatVersion, 3);
  assert.ok(formatOf(canvas) && loadable(canvas) && loadable(dom));
  const v = DOCUMENT.version;
  DOCUMENT.version = 2; // a 1.x build: actions.js openDraft says NEWER_FORMAT for what loadable refuses
  try {
    assert.equal(formatOf(canvas), null);
    assert.equal(loadable(canvas), false, 'it would open without the engine and its save would leave the engine form behind');
    assert.ok(loadable(dom));
  } finally {
    DOCUMENT.version = v;
  }
});

test('editWatch: an edit, an undo and a redo need a save; an open and a layout after fonts or data arrive do not', async () => {
  const doc = { ...newDocumentJson({}), content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }] };
  const e = new Engine();
  e.open((await exportDocx(doc, { title: 'x' })).bytes, 'docx');
  const edited = editWatch();
  const next = () => {
    const s = e.takeLayout();
    return s ? edited(JSON.parse(s)) : null;
  };
  assert.equal(next(), false, 'the open');
  const at = JSON.stringify({ story: 'body', path: [0], off: 5 });
  e.select(at, at);
  assert.equal(next(), null, 'a selection lays nothing out');
  e.insertText('X');
  assert.equal(next(), true);
  e.insertText('Y'); // joins the open step: the same step id, a changed block
  assert.equal(next(), true);
  e.fontsChanged();
  assert.equal(next(), false);
  e.undo();
  assert.equal(next(), true);
  e.redo();
  assert.equal(next(), true);
  e.dataChanged();
  assert.equal(next(), false);
  assert.equal(edited({ steps: { undo: 1, redo: null }, changes: null }), false, 'the same steps again');
  assert.equal(edited({ steps: { undo: 2, redo: null }, changes: null }), true, 'a change outside blocks still moves the step');
});

/** A stand-in engine client: save('engine') gives `model`'s bytes; `saved` records what a crash would reopen from. */
const stub = (model) => ({ last: null, save: async () => enc(model), saved(bytes, kind) { this.last = { bytes, kind }; } });

test('saveOnce: the record goes to store in order, joins to recordText and stamps the canvas form; the reply joins the draft', async () => {
  const model = { body: [{ kind: 'para', text: 'x'.repeat(3 << 20) }] }; // over three pieces' worth of model
  const c = stub(model);
  const draft = { id: 'd', title: 'T', format: 'document', formatVersion: DOM_VERSION, doc: DOC };
  const got = [];
  const marks = { suggestions: 0, flows: ['f'], plans: [] };
  const reply = await saveOnce(c, draft, (part, i, n) => {
    got.push({ part, i, n });
    return i === n - 1 ? { id: 'd', updated: 42, marks } : null;
  });
  assert.deepEqual(reply, { id: 'd', updated: 42, marks }, "main.js saveDraft's list marks go back to the caller");
  assert.ok(!('marks' in draft), 'and never into the record');
  assert.ok(got.length > 3 && got.every((p, i) => p.i === i && p.n === got.length));
  const { updated, ...sent } = draft; // the reply's `updated` joins after the record went
  assert.equal(got.map((p) => p.part).join(''), recordText(sent));
  assert.ok(!('doc' in draft) && !('doc' in JSON.parse(got.map((p) => p.part).join(''))), 'the DOM form from the switch is not kept');
  assert.deepEqual(JSON.parse(recordText(draft)).engine.model, model);
  assert.equal(draft.formatVersion, FORMAT_VERSION);
  assert.equal(draft.updated, 42);
  assert.equal(c.last.kind, 'engine', 'a crash reopens from the form just stored');
});

test('saveOnce: a store call that fails part way rejects, so the app keeps the draft unsaved, and a crash reopens from the last save', async () => {
  const c = stub({ body: [] });
  const draft = { id: 'd', title: 'T', format: 'document', doc: DOC, updated: 1 };
  await assert.rejects(saveOnce(c, draft, (part, i) => {
    if (i === 1) throw new Error('draft pieces out of order');
    return null;
  }), /out of order/);
  assert.equal(draft.updated, 1);
  assert.equal(c.last, null);
});

// stale-doc.md R18: while the page area opens a canvas draft, or after it could not, the surface has neither the hidden DOM editor
// nor a session, so the draft's commands show disabled instead of acting on the hidden editor; the app's own rows still run.
test('while the page area opens a draft, the Document surface has no editor and no session, and only the app rows run', async () => {
  const { setState } = await import('../src/app/store.js');
  const { ENGINE_COMMANDS } = await import('../src/document/canvas/commands.mjs');
  const { commandOf, registerModule, run } = await import('../src/tooling/registry.js');
  const { activeSurface, areaOpens } = await import('../src/tooling/surface.js');
  const DOM = { state: null }; // the hidden editor under the page area
  registerModule({ id: 'base', commands: { 'home.font.bold': { run: () => 'dom bold' } } }, ['document']);
  registerModule({ id: 'canvas-engine', engine: ENGINE_COMMANDS, commands: { 'view.canvasEngine': { run: () => 'switch' } } }, ['document']);
  const show = (draft, settings = {}, focusedSession = null) => setState({ editor: DOM, draft, view: { type: 'editor' }, settings, focusedSession });
  const canvas = { id: 'c', format: 'document' };
  adopt(canvas, enc({ body: [] }));
  for (const [draft, settings] of [[canvas, {}], [{ id: 'd', format: 'document' }, { word: { canvasEngine: true } }]]) {
    show(draft, settings);
    assert.ok(areaOpens({ draft, settings, view: { type: 'editor' } }));
    assert.deepEqual({ ...activeSurface(), profile: null }, { kind: 'document', editor: null, format: 'document', profile: null, session: null, story: null });
    const bold = commandOf('home.font.bold');
    assert.equal(bold.enabled(), false);
    assert.match(bold.reason(), /has not opened this draft/);
    assert.equal(await run('home.font.bold'), false);
    assert.equal(await run('view.canvasEngine'), 'switch', 'the switch works while the area opens, and after it failed');
  }
  show({ id: 'd', format: 'document' }); // the switch off: the DOM editor as before
  assert.equal(activeSurface().editor, DOM);
  assert.equal(await run('home.font.bold'), 'dom bold');
});

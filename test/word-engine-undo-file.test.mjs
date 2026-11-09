// engine-undo-file (docs/plans/word/briefs/engine-undo-file.md, stage2b.md decision 3): a canvas draft's undo history is saved
// beside its record and taken back when the draft opens again, and its engine session closes when it should. The engine's own
// round trip runs its WebAssembly in Node; the save chain (autosave.mjs) and the host's session count (client.js) run over
// stand-ins. The app's side is the harness case (.smoke-data/word/cases/engine-undo-file.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { saveOnce } from '../src/engine/model/autosave.mjs';

class FakeWorker {
  static all = [];
  sent = [];
  constructor(url) {
    this.url = String(url);
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    this.sent.push(m);
  }
  terminate() {}
  /** Answers message `m` with `result`. */
  reply(m, result) {
    this.onmessage({ data: { id: m.id, result } });
  }
}
globalThis.Worker = FakeWorker;
globalThis.document ??= { baseURI: 'file:///app/' };
const { EngineHost } = await import('../src/engine/client.js?undo-file');

const WASM = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);
let ew = null;
async function engine() {
  if (ew) return ew;
  ew = await import(new URL('../src/engine/wasm/ew.js?undo-file', import.meta.url).href);
  ew.initSync({ module: fs.readFileSync(WASM) });
  await addBundledFonts(ew, (url) => fs.readFileSync(url));
  return ew;
}
const text = (e) => new TextDecoder().decode(e.save('txt'));

test('the engine writes its undo history for a record and takes it back after the record opens again', { skip: !fs.existsSync(WASM) && 'no engine build' }, async () => {
  const { Engine } = await engine();
  const e = new Engine();
  e.insertText('One.');
  e.exec('text.newParagraph', '{}');
  e.insertText('Two.');
  e.exec('select.all', '{}');
  e.exec('format.bold', '{}');
  e.exec('caret.docEnd', '{}');
  e.insertText(' Three.');
  e.undo();
  e.pages();
  e.saveBegin(true); // the record's save: the history is noted as it finds the document
  e.insertText(' After the save.'); // goes to the next save, and so not into this history either
  const model = e.saveEnd();
  const history = e.saveHistory('stamp-1', 50);
  assert.ok(history?.length > 0);
  const file = JSON.parse(new TextDecoder().decode(history));
  assert.deepEqual([file.form, file.formVersion, file.stamp, file.undo.length, file.redo.length], ['easywriter.history', 1, 'stamp-1', 4, 1]);
  assert.throws(() => e.saveHistory('stamp-1', 50), /no save/, 'one history a record save');

  const t = new Engine();
  t.open(model, 'engine');
  assert.deepEqual(JSON.parse(t.openHistory(new TextEncoder().encode('{"version":1}'), 'stamp-1')).kept, false, 'the DOM editor\'s history');
  assert.equal(JSON.parse(t.openHistory(history, 'another')).kept, false, 'another record\'s');
  const r = JSON.parse(t.openHistory(history, 'stamp-1'));
  assert.ok(r.kept && r.steps.undo != null && r.steps.redo != null, JSON.stringify(r));
  // The same texts as the session that wrote it, back to the empty document and forward again.
  e.undo(); // ' After the save.'
  const texts = (x) => {
    const out = [text(x)];
    while (JSON.parse(x.steps()).undo != null && out.length < 10) {
      x.undo();
      out.push(text(x));
    }
    return out;
  };
  assert.deepEqual(texts(t), texts(e));
  e.free();
  t.free();
});

test('a save writes the record, then the history with the record\'s stamp; no step writes null; a failed history save is no failed save', async () => {
  const calls = [];
  const fake = (history) => ({
    async save(kind, h) {
      calls.push(['save', kind, h]);
      return new TextEncoder().encode('{"body":[]}');
    },
    async call(method, args) {
      calls.push([method, ...args]);
      if (history instanceof Error) throw history;
      return history;
    },
    saved: (bytes, kind, stamp) => calls.push(['saved', kind, stamp]),
    savedHistory: (stamp, h) => calls.push(['savedHistory', stamp, h?.length ?? null]),
  });
  const draft = { id: 'd1', title: 'Draft', format: 'document' };
  const stores = [];
  const store = (part, i, n) => (stores.push(['record', i, n]), { id: 'd1', updated: 5 });
  const history = { store: (part, i, n) => (stores.push(['history', part]), true), limit: 7 };
  await saveOnce(fake(new TextEncoder().encode('{"form":"easywriter.history"}')), draft, store, {}, history);
  const stamp = draft.engine.stamp;
  assert.ok(stamp);
  assert.deepEqual(calls, [['save', 'engine', true], ['saved', 'engine', stamp], ['saveHistory', stamp, 7], ['savedHistory', stamp, 29]]);
  assert.deepEqual(stores.map((s) => s[0]), ['record', 'record', 'record', 'history'], 'the history after the record');
  assert.equal(stores.at(-1)[1], '{"form":"easywriter.history"}');

  calls.length = stores.length = 0;
  await saveOnce(fake(null), draft, store, {}, history);
  assert.notEqual(draft.engine.stamp, stamp, 'each save has its own stamp');
  assert.deepEqual(stores.at(-1), ['history', 'null'], 'no step to keep: the file says null');

  calls.length = stores.length = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await saveOnce(fake(new Error('engine gone')), draft, store, {}, history)).updated, 5);
  } finally {
    console.warn = warn;
  }
  assert.ok(!stores.some((s) => s[0] === 'history'));

  calls.length = 0;
  await saveOnce(fake(null), draft, store);
  assert.deepEqual(calls.map((c) => c[0]), ['save', 'saved'], 'no history asked: none noted or written');
  assert.equal(calls[0][2], false);
});

test('a watcher hears its session while a view holds it and never keeps it open; a released view opens no blank session', async () => {
  FakeWorker.all = [];
  const host = new EngineHost(new URL('file:///app/src/engine/worker.js'), { fonts: false });
  const w = FakeWorker.all[0];
  const event = (data) => w.onmessage({ data: { event: 'layout', data, session: 'd1' } });
  const watcher = host.watch('d1');
  const heard = [];
  watcher.on('layout', (d) => heard.push(d.n));
  await assert.rejects(watcher.call('steps'), /not open/);
  assert.deepEqual(host.ids(), []);
  const view = host.session('d1');
  assert.deepEqual(host.ids(), ['d1']);
  event({ n: 1 });
  view.release();
  assert.deepEqual(host.ids(), [], 'the watcher does not keep it open');
  assert.equal(w.sent.at(-1).method, 'close');
  await assert.rejects(view.call('steps'), /not open/, 'a released view');
  await assert.rejects(watcher.call('steps'), /not open/);
  const again = host.session('d1');
  event({ n: 2 });
  assert.deepEqual(heard, [1, 2]);
  const p = watcher.call('steps');
  w.reply(w.sent.at(-1), { undo: 3 });
  assert.deepEqual(await p, { undo: 3 });
  again.release();
  watcher.release();
});

test('a crash reopens a draft with the history saved for its record, and says whether it came back', async () => {
  FakeWorker.all = [];
  const host = new EngineHost(new URL('file:///app/src/engine/worker.js'), { fonts: false });
  const a = host.session('a');
  const b = host.session('b');
  a.saved(new Uint8Array([1]), 'engine', 'st-a');
  a.savedHistory('st-a', new Uint8Array([2]));
  b.saved(new Uint8Array([3]), 'engine', 'st-b');
  b.savedHistory('st-old', new Uint8Array([4])); // saved with an earlier record
  const reopened = {};
  host.on('reopened', (d, s) => (reopened[s] = d));
  FakeWorker.all[0].onmessage({ data: { event: 'crash', data: { message: 'stopped' } } });
  const w = FakeWorker.all[1];
  for (const m of w.sent.filter((m) => m.method === 'open')) w.reply(m, { pages: 1 });
  await new Promise((r) => setTimeout(r, 0));
  const imports = w.sent.filter((m) => m.method === 'openHistory');
  assert.deepEqual(imports.map((m) => [m.session, m.args[1]]), [['a', 'st-a']], 'only the history saved for the reopened record');
  w.reply(imports[0], { kept: true, steps: { undo: 9, redo: null } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(reopened.a, { session: 'a', history: true, steps: { undo: 9, redo: null } });
  assert.deepEqual(reopened.b, { session: 'b', history: false, steps: null });
});

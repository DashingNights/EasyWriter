// engine-fixes-4 (docs/plans/word/briefs/engine-fixes-4.md): wave H's loose ends. whenSettled waits for the data files layout
// asked for (hyphenation patterns, the word list), as it waits for fonts, and for a font the layout after fontsDone asks for.
// The first two run client.js over a stand-in Worker the test drives; the third runs the real worker.js and client.js over a
// Node worker thread with the engine's .wasm, and a data fetch that takes its time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';

const WORKER = new URL('../src/engine/worker.js', import.meta.url);

/** A Worker that answers every call at once (`answers[method]`, else true); the test sends its events. */
class FakeWorker {
  static all = [];
  answers = {};
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    if (m.id) queueMicrotask(() => this.onmessage({ data: { id: m.id, result: this.answers[m.method] ?? true } }));
  }
  terminate() {}
}

// The page's Worker over a Node worker thread: `self`, postMessage and fetch of file: URLs (the .wasm, STAMP and bundled fonts)
// as a browser worker has them, with the data files beside the .wasm coming DATA_MS later, as a slow disk or network sends them.
// Messages that come before worker.js has set self.onmessage wait.
const DATA_MS = 400;
const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
globalThis.self = globalThis;
globalThis.fetch = async (url) => {
  const data = String(url).includes('/wasm/data/');
  if (data) await new Promise((r) => setTimeout(r, ${DATA_MS}));
  try {
    return new Response(await fs.promises.readFile(new URL(url)), { headers: { 'content-type': String(url).endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
  } catch {
    return new Response(null, { status: 404 });
  } finally {
    // The test hears that a data file went to the worker, apart from anything the worker says.
    if (data) parentPort.postMessage({ fetched: String(url) });
  }
};
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
const early = [];
parentPort.on('message', (data) => (globalThis.onmessage ? globalThis.onmessage({ data }) : early.push(data)));
import(workerData).then(() => { for (const data of early.splice(0)) globalThis.onmessage({ data }); });
`;
class ThreadWorker {
  constructor(url) {
    this.w = new NodeWorker(BOOT, { eval: true, workerData: String(url) });
    this.fetched = [];
    this.w.on('message', (data) => (data.fetched ? this.fetched.push(data.fetched) : this.onmessage?.({ data })));
    this.w.on('error', (e) => this.onerror?.({ message: e.message, preventDefault() {} }));
    ThreadWorker.last = this;
  }
  postMessage(m, transfer) {
    this.w.postMessage(m, transfer);
  }
  terminate() {
    this.w.terminate();
  }
}

const { EngineHost } = await import('../src/engine/client.js');
const tick = () => new Promise((r) => setTimeout(r, 10));

/** A host on the stand-in Worker, with fonts whose ready() is `fonts.pending`. */
function fakeHost() {
  globalThis.Worker = FakeWorker;
  FakeWorker.all.length = 0;
  const host = new EngineHost(new URL('file:///worker.js'), { fonts: false });
  const fonts = { pending: Promise.resolve(), ready: () => fonts.pending, stop() {} };
  host.fonts = fonts;
  return { host, w: FakeWorker.all[0], fonts };
}

test('whenSettled waits for the data files the layout asked for, then for the layout they make', async () => {
  const { host, w } = fakeHost();
  const s = host.session('s');
  await s.call('selection');
  // The open's layout settles in the message that says its hyphenation data is on its way (worker.js report).
  w.onmessage({ data: { batch: [{ event: 'layout', data: { settled: true }, session: 's' }, { event: 'data', data: { pending: 1 } }] } });
  let done = false;
  const p = s.whenSettled().then(() => (done = true));
  await tick();
  assert.equal(done, false, 'not while the data is on its way');
  // The data's layout is in slices: settled again only at its layout event.
  w.answers.settled = false;
  w.onmessage({ data: { batch: [{ event: 'layout', data: { settled: false }, session: 's' }, { event: 'data', data: { pending: 0 } }] } });
  await tick();
  assert.equal(done, false, 'not while the data\'s layout is in slices');
  w.answers.settled = true;
  w.onmessage({ data: { event: 'layout', data: { settled: true }, session: 's' } });
  await p;
  host.terminate();
});

test('whenSettled waits for a font that the layout after fontsDone asks for', async () => {
  const { host, w, fonts } = fakeHost();
  const s = host.session('s');
  let arrive1;
  let arrive2;
  fonts.pending = new Promise((r) => (arrive1 = r));
  let done = false;
  const p = s.whenSettled().then(() => (done = true));
  await tick();
  assert.equal(done, false, 'not while the first fonts are on their way');
  // fontsDone's reply ends the first wait; the layout it starts comes after it, settles, and meets a family it lacks, so the
  // provider is asked again in the same task (fonts.missing travels with the layout event).
  w.answers.settled = false;
  arrive1();
  await tick();
  w.onmessage({ data: { event: 'layout', data: { settled: true }, session: 's' } });
  fonts.pending = new Promise((r) => (arrive2 = r));
  w.answers.settled = true;
  await tick();
  assert.equal(done, false, 'not while the font the second layout asked for is on its way');
  arrive2();
  await p;
  host.terminate();
});

test('a read after whenSettled sees the layout the hyphenation data made, however late the data comes', { timeout: 120000 }, async () => {
  globalThis.Worker = ThreadWorker;
  const host = new EngineHost(WORKER, { fonts: false });
  const w = ThreadWorker.last;
  try {
    const s = host.session('d');
    // Long words in narrow columns, automatically hyphenated: the word list's breaks are not the heuristic's the engine uses
    // until the data comes.
    const words = ['internationalization', 'representativeness', 'characteristically', 'incomprehensibilities', 'disproportionately',
      'telecommunications', 'electroencephalograph', 'uncharacteristically', 'counterrevolutionaries', 'institutionalization'];
    for (let i = 0; i < 6; i++) {
      if (i) await s.exec('text.newParagraph', {});
      await s.exec('text.insert', { text: words.map((x, j) => words[(i + j) % words.length]).join(' '), raw: true });
    }
    await s.exec('layout.columns', { count: 3 });
    await s.exec('layout.hyphenation', { value: true });
    const read = async () => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        for (let off = 0; off < 220; off += 7) {
          const k = await s.call('caret', [{ story: 'body', path: [i], off }]);
          out.push(k && [k.page, +k.x.toFixed(2), +k.y.toFixed(2)]);
        }
      }
      return out;
    };
    await s.whenSettled();
    const got = await read();
    // The data in and laid out, whatever whenSettled did: the worker lays out with a file in the task it arrives in, so a call
    // after that answers after its layout.
    // English hyphenation reads the word list, and the patterns for the words it lacks.
    while (!['en-us.dic', 'en-us.pat'].every((n) => w.fetched.some((u) => u.endsWith(n)))) await new Promise((r) => setTimeout(r, 20));
    await s.whenSettled();
    const want = await read();
    const off = got.flatMap((k, i) => (JSON.stringify(k) === JSON.stringify(want[i]) ? [] : [{ at: i, got: k, want: want[i] }]));
    assert.deepEqual(off.slice(0, 5), [], `every caret where the data's layout puts it (${off.length} moved)`);
  } finally {
    host.terminate();
  }
});

// engine-print-bench (docs/plans/word/briefs/engine-print-bench.md): an open beside another draft never holds that draft's calls
// for the whole layout. The engine bench saw a visible draft's round trip take 1.3 s while the fixture opened in a session of the
// same worker: the engine worker laid the opened document out whole before it answered anything else. Counted by the order of
// the answers and the layout events, never a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { EngineHost } from '../src/engine/client.js';
import { installedSource } from '../src/engine/fonts/sources.mjs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
const WORKER = new URL('../src/engine/worker.js', import.meta.url);

// The page's Worker over a Node worker thread, as word-engine-main-thread-2.test.mjs runs it.
const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
globalThis.self = globalThis;
globalThis.fetch = async (url) => {
  try {
    return new Response(await fs.promises.readFile(new URL(url)), { headers: { 'content-type': String(url).endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
  } catch {
    return new Response(null, { status: 404 });
  }
};
globalThis.postMessage = (m, transfer) => parentPort.postMessage(m, transfer);
const early = [];
parentPort.on('message', (data) => (globalThis.onmessage ? globalThis.onmessage({ data }) : early.push(data)));
import(workerData).then(() => { for (const data of early.splice(0)) globalThis.onmessage({ data }); });
`;
globalThis.Worker = class {
  constructor(url) {
    this.w = new NodeWorker(BOOT, { eval: true, workerData: String(url) });
    this.w.on('message', (data) => this.onmessage?.({ data }));
    this.w.on('error', (e) => this.onerror?.({ message: e.message, preventDefault() {} }));
  }
  postMessage(m, transfer) {
    this.w.postMessage(m, transfer);
  }
  terminate() {
    this.w.terminate();
  }
};

/** A document of `n` paragraphs with a page break every 7th → its engine form. */
function typed(n) {
  const e = new Engine();
  for (let i = 0; i < n; i++) {
    e.insertText(`Paragraph ${i} `.repeat(30));
    e.exec(i % 7 === 6 ? 'text.pageBreak' : 'text.newParagraph', '{}');
  }
  const bytes = e.save('engine');
  e.free();
  return bytes;
}

test('an open beside another draft answers that draft between slices and resolves with the whole layout', { timeout: 120000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    const bytes = typed(160);
    const visible = host.session('visible');
    await visible.open(typed(3), 'engine');
    const events = [];
    host.on('layout', (e, s) => s === 'big' && events.push({ settled: e.settled, count: e.count }));
    const order = [];
    const big = host.session('big');
    const opening = big.open(bytes.slice(), 'engine').then((r) => (order.push('open'), r));
    // Sent after the open: before engine-print-bench it was answered only once the whole document was laid out.
    await visible.selection();
    order.push('visible');
    const opened = await opening;
    // The same document laid out whole: a session's own open call with nothing beside it.
    const alone = host.session('whole');
    const whole = await alone.call('open', [bytes.slice(), 'engine']);
    assert.equal(whole.settled, true);
    assert.deepEqual(order, ['visible', 'open'], 'the visible draft is answered before the open has laid out every page');
    assert.ok(events[0]?.settled === false && events[0].count < whole.pages, `the open's first layout event: ${JSON.stringify(events[0])}`);
    assert.deepEqual(events.at(-1), { settled: true, count: whole.pages });
    assert.equal(opened.pages, whole.pages, 'open counts every page, as a whole layout does');
    assert.deepEqual(await big.call('layoutDigest'), await alone.call('layoutDigest'));
  } finally {
    host.terminate();
  }
});

// The open waits for layout events, and a released draft hears none: before, it stayed pending with its listeners kept.
test('an open beside another draft ends when its draft is released before the layout settles', { timeout: 120000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    await host.session('visible').open(typed(3), 'engine');
    const big = host.session('big');
    const opening = big.open(typed(1200), 'engine');
    // At its second unsettled layout event: the open is waiting on layout events by then.
    let unsettled = 0;
    host.on('layout', (e, s) => s === 'big' && e.settled === false && ++unsettled === 2 && big.release());
    await assert.rejects(opening, /closed before its layout settled/);
  } finally {
    host.terminate();
  }
});

test('an open with no other draft beside it lays out whole, as before', { timeout: 120000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    const events = [];
    host.on('layout', (e) => events.push(e.settled));
    const alone = host.session('alone');
    const r = await alone.open(typed(160), 'engine');
    await alone.pages(); // its layout event comes before this answer
    assert.equal(r.settled, true);
    assert.deepEqual(events, [true]);
  } finally {
    host.terminate();
  }
});

// The other half of the stall: the page's thread reads an IPC reply in one piece (about 1.3 ms a MB), and the installed fonts of
// a family came in one reply, Yu Gothic's four files 54 MB (69 ms), while the visible draft's answers waited behind it.
test('the installed fonts of a family come one file a reply', async () => {
  const files = { 'a.ttc': 3, 'b.ttc': 5 };
  const replies = [];
  const api = {
    family: async (name) => (name === 'Wide' ? Object.keys(files).map((n) => ({ name: n, source: 'system' })) : []),
    file: async (name, fileName) => {
      const bytes = name === 'Wide' && files[fileName] ? new Uint8Array(files[fileName]) : null;
      replies.push(bytes?.byteLength ?? 0);
      return bytes;
    },
  };
  const faces = await installedSource(api).faces('Wide');
  assert.deepEqual(faces.map((f) => [f.name, f.bytes.byteLength]), [['a.ttc', 3], ['b.ttc', 5]]);
  assert.deepEqual(replies, [3, 5], 'each file in a reply of its own');
  assert.deepEqual(await installedSource(api).faces('Missing'), []);
});

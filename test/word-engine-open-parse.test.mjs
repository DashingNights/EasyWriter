// engine-open-parse (docs/plans/word/briefs/engine-open-parse.md): an engine form opened beside another draft is read in steps,
// so that draft's calls are answered between them. In one piece the Word fixture's 7.3 MB form held the worker about 90 ms. The
// steps are counted by the order of the answers, never a time; the document they make is the one-piece open's, byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { EngineHost } from '../src/engine/client.js';
import { initSync, Engine } from '../src/engine/wasm/ew.js';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
const WORKER = new URL('../src/engine/worker.js', import.meta.url);

// The page's Worker over a Node worker thread, as word-engine-print-bench.test.mjs runs it.
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

/** The engine form of typed(70) with its body `times` over: about 10 MB at 300, many steps' read at any speed. */
function big(times) {
  const model = JSON.parse(new TextDecoder().decode(typed(70)));
  const body = model.body;
  model.body = Array.from({ length: times }, () => body).flat();
  return new TextEncoder().encode(JSON.stringify(model));
}

const BIG = big(300);

test('an engine form opened beside another draft is read in steps: that draft is answered before the open, which makes the one-piece document', { timeout: 180000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    const visible = host.session('visible');
    await visible.open(typed(3), 'engine');
    const order = [];
    // The worker's own answer to the open (SessionClient.open waits for the layout as well).
    const opening = host.call('open', [BIG.slice(), 'engine', true], [], 'big').then((r) => (order.push('open'), r));
    const sel = visible.selection().then(() => order.push('visible'));
    const opened = await opening;
    await sel;
    assert.deepEqual(order, ['visible', 'open'], 'the visible draft is answered while the form is read');
    assert.equal(opened.sliced, true);
    // The same form opened in one piece, in a session of its own.
    const whole = await host.call('open', [BIG.slice(), 'engine'], [], 'whole');
    assert.equal(whole.settled, true);
    await host.session('big').whenSettled();
    assert.deepEqual(await host.call('save', ['engine'], [], 'big'), await host.call('save', ['engine'], [], 'whole'));
    assert.deepEqual(await host.call('layoutDigest', [], [], 'big'), await host.call('layoutDigest', [], [], 'whole'));
  } finally {
    host.terminate();
  }
});

// A shared call that lays out every draft (fontsDone here; a font burst's timer and new hyphenation data do the same) used to lay
// out the opening draft's blank document while it was read: its layout went out first, and a draft without `ahead` lost its slices
// and was laid out whole in the open (6,001 pages settled, about 3 s holding every draft).
for (const pageArea of [false, true]) {
  test(`a fontsDone during the read sends nothing of the opening draft before its open (${pageArea ? 'laid out ahead' : 'laid out whole'})`, { timeout: 180000 }, async () => {
    const host = new EngineHost(WORKER, { fonts: false });
    try {
      await host.session('visible').open(typed(3), 'engine');
      const big = host.session('big');
      // The page area's session lays out ahead (src/document/canvas/session.js); engine-helper's does not.
      if (pageArea) await big.ahead();
      let replied = false;
      const early = [];
      big.on('layout', (e) => !replied && early.push({ count: e.count, settled: e.settled }));
      const opening = host.call('open', [BIG.slice(), 'engine', true], [], 'big').then((r) => ((replied = true), r));
      await host.call('fontsDone', []);
      const opened = await opening;
      assert.deepEqual(early, [], 'no layout event before the open replies');
      assert.equal(opened.settled, false, 'only its first pages are laid out in the open');
      if (!pageArea) assert.equal(opened.sliced, true, 'the rest is laid out in slices');
    } finally {
      host.terminate();
    }
  });
}

test('a call on the draft being read waits for the open and sees the opened document', { timeout: 180000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    await host.session('visible').open(typed(3), 'engine');
    const order = [];
    const opening = host.call('open', [BIG.slice(), 'engine', true], [], 'big').then(() => order.push('open'));
    const saved = await host.call('save', ['engine'], [], 'big');
    order.push('save');
    await opening;
    assert.deepEqual(order, ['open', 'save']);
    const whole = host.session('whole');
    await whole.open(BIG.slice(), 'engine');
    assert.deepEqual(saved, await whole.save('engine'));
  } finally {
    host.terminate();
  }
});

test('a form that does not open fails in steps with the one-piece open\'s reason, and a close during the read fails the open', { timeout: 180000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    await host.session('visible').open(typed(3), 'engine');
    const text = new TextDecoder().decode(typed(3));
    const newer = new TextEncoder().encode(text.replace(/"version":\d+/, '"version":999'));
    const broken = new TextEncoder().encode(text.replace('"kind":"para"', '"kind":"list"'));
    for (const bytes of [newer, broken]) {
      const stepped = await host.call('open', [bytes.slice(), 'engine', true], [], 'bad').then(() => null, (e) => e.message);
      const whole = await host.call('open', [bytes.slice(), 'engine'], [], 'bad-whole').then(() => null, (e) => e.message);
      assert.ok(stepped, 'it fails');
      assert.equal(stepped, whole);
    }
    assert.match(await host.call('open', [newer.slice(), 'engine', true], [], 'bad').catch((e) => e.message), /newer version/);
    const closing = host.call('open', [BIG.slice(), 'engine', true], [], 'closed');
    host.call('close', [], [], 'closed');
    await assert.rejects(closing, /closed before it opened/);
    // The worker goes on: the visible draft still answers.
    assert.ok(await host.session('visible').selection());
  } finally {
    host.terminate();
  }
});

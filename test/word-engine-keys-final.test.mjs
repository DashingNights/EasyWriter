// engine-keys-final (docs/plans/word/briefs/engine-keys-final.md): what the worker asks of the engine so a key waits behind
// less, run on its WebAssembly in Node. A layout event works out damage only for the surfaces the views show (setView), so
// an edit that moves the later pages builds no display list for those off screen; and endsPassNext says which slices end a
// layout pass (a page's headers and footers or so each), which the worker holds back while keys come. The section break
// taken out, the pass ends in slices and keys during them are checked natively
// (engine/crates/doc-edit/src/session/repaginate.rs), and the keys' times in the harness case engine-keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { EngineHost } from '../src/engine/client.js';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const S = JSON.stringify;

/** A document of `n` paragraphs of running text (about 4 to a page), typed into a blank session → its engine form. */
function typed(n) {
  const e = new Engine();
  for (let i = 0; i < n; i++) {
    e.insertText(`Paragraph ${i} `.repeat(30));
    if (i + 1 < n) e.exec('text.newParagraph', '{}');
  }
  const bytes = e.save('engine');
  e.free();
  return bytes;
}

/** Paints every tile of `surface` at 1 px a point, so its display list is kept and a later edit's damage is worked out for it. */
function paintAll(e, surface) {
  const { w, h } = J(e.pages()).pages[surface];
  for (let col = 0; col * 512 < w; col++) for (let row = 0; row * 512 < h; row++) e.paintTile(surface, 1, col, row)?.free();
}

test('a layout event works out damage only for the surfaces the views show', () => {
  const e = new Engine();
  e.open(typed(40), 'engine');
  assert.ok(J(e.pages()).pages.length >= 6, 'six pages or more');
  e.takeLayout();
  for (let p = 1; p < 6; p++) paintAll(e, p);
  // Text put in at the top of page 2 runs every later line on by more than a dozen lines, not whole pages: pages 2 to the
  // last draw differently.
  const top = J(e.hit(1, 100, 80)).pos;
  const grow = (words) => {
    e.select(S(top), S(top));
    e.takeLayout();
    assert.ok(J(e.exec('text.insert', S({ text: 'word '.repeat(words), raw: true }))).ok);
    return J(e.takeLayout());
  };
  e.setView(1, 2);
  const shown = grow(150);
  assert.ok(shown.from <= 1 && shown.to - shown.from >= 4, `the edit changed pages ${shown.from} to ${shown.to}`);
  assert.deepEqual(shown.damage.map((d) => d.surface), [1], 'damage for the page on screen only');
  for (let p = 1; p < 6; p++) paintAll(e, p);
  // With no view set, every changed page whose list is kept gets its damage, as before.
  e.setView();
  const all = grow(90);
  assert.ok(all.damage.length >= 4, `damage for ${all.damage.map((d) => d.surface)}`);
});

test('an edit whose layout pauses at the view keeps the pages after it listed until the slices lay them out', () => {
  const e = new Engine();
  e.open(typed(200), 'engine');
  const before = J(e.pages()).pages;
  assert.ok(before.length > 20, `${before.length} pages`);
  e.takeLayout();
  e.setAhead(12);
  // Lines put in on page 11 run every later line on: the layout pauses past the view's pages, the rest to follow in slices.
  const at = J(e.hit(10, 100, 300)).pos;
  e.select(S(at), S(at));
  e.takeLayout();
  assert.ok(J(e.exec('text.insert', S({ text: 'word '.repeat(30), raw: true }))).ok);
  const ev = J(e.takeLayout());
  assert.equal(ev.settled, false, 'the layout paused');
  // Listed as the last settled layout had them, the count does not drop to the view's pages and back with each such key.
  assert.equal(ev.count, before.length, 'the page count while the rest is laid out');
  assert.deepEqual(J(e.pages()).pages.slice(14), before.slice(14), 'the pages not laid out again yet, as they were');
  while (!e.settle(8));
  const after = J(e.takeLayout());
  assert.equal(after.settled, true);
  assert.ok(after.count >= before.length, `settled with ${after.count} pages`);
  assert.equal(J(e.pages()).pages.length, after.count);
});

test('the slices that end a pass, and only those, say so; with no time to spare each dresses a page', () => {
  const e = new Engine();
  e.setAhead(2);
  e.open(typed(80), 'engine');
  assert.equal(e.settled(), false, 'laid out ahead');
  const ends = [];
  for (let slices = 0; ; slices++) {
    assert.ok(slices < 100000, 'the layout settles');
    ends.push(e.endsPassNext());
    if (e.settle(0)) break;
  }
  // The slices before the last block lay the body out; from it on the last block, then the pages' headers and footers a
  // page a slice, and the pass ends with the last page's (in one slice before engine-keys-final).
  const first = ends.indexOf(true);
  const pages = J(e.pages()).pages.length;
  assert.ok(first > 0 && ends.slice(first).every(Boolean), `the slices that end the pass come last: ${ends.join('')}`);
  assert.ok(ends.length - first >= pages, `${ends.length - first} slices ended the pass's ${pages} pages`);
  assert.equal(e.endsPassNext(), false, 'a settled layout has no pass to end');
});

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

test('typing in one draft holds back only its own pass ends: a draft opened beside it settles while the typing goes on', { timeout: 120000 }, async () => {
  const host = new EngineHost(new URL('../src/engine/worker.js', import.meta.url), { fonts: false });
  try {
    const a = host.session('typed');
    await a.call('open', [typed(8), 'engine']);
    // A key every 30 ms in the first draft, which the worker counts as typing (each changes the document), 600 at most.
    let typing = true;
    const keys = (async () => {
      for (let i = 0; typing && i < 600; i++) {
        await a.call('insertText', ['x']);
        await new Promise((r) => setTimeout(r, 30));
      }
    })();
    // A second draft opened beside it lays out in slices, and the slices that end its pass wait only for its own typing.
    const b = host.session('beside');
    const opened = await b.call('open', [typed(200), 'engine', true]);
    assert.equal(opened.sliced, true, 'opened beside another draft, it lays out in slices');
    const settled = await Promise.race([b.whenSettled().then(() => true), keys.then(() => false)]);
    typing = false;
    await keys;
    assert.ok(settled, 'the draft opened beside did not settle until the typing in the other stopped');
  } finally {
    host.terminate();
  }
});

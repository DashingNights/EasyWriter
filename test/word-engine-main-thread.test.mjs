// engine-main-thread (docs/plans/word/briefs/engine-main-thread.md): a key's result reaches the page without waiting on work
// nobody sees yet. An edit's batch (its layout, its caret and its tiles on screen, viewport-design.md section 4.4) goes before
// the tiles a view wishes off screen (the ring round the view): on the Word fixture's page 300 those were 4 to 7 of an Enter's
// 10 to 13 tiles and held its result 4 to 6 ms longer. This runs the real worker.js over a Node worker thread with the engine's
// .wasm; the tile canvas is stubbed (Node has none), so a tile's bitmap is an ArrayBuffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { EngineHost } from '../src/engine/client.js';

const WORKER = new URL('../src/engine/worker.js', import.meta.url);

// The page's Worker over a Node worker thread: `self`, postMessage, fetch of file: URLs (the .wasm, STAMP and bundled fonts) and
// a stand-in for the tile canvas. Messages that come before worker.js has set self.onmessage wait.
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
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.OffscreenCanvas = class {
  constructor(width, height) { Object.assign(this, { width, height }); }
  getContext() { return { putImageData() {} }; }
  transferToImageBitmap() { return new ArrayBuffer(4); }
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

test('an edit\'s batch carries its tiles on screen, and the tiles off screen follow it', { timeout: 120000 }, async () => {
  const host = new EngineHost(WORKER, { fonts: false });
  try {
    const c = host.session('d');
    for (let i = 0; i < 40; i++) {
      if (i) await c.exec('text.newParagraph', {});
      await c.exec('text.insert', { text: `Line ${i} of a page whose every line moves down when a paragraph goes in above it.`, raw: true });
    }
    // The first page's top row on screen and a tile of its middle row in the ring below the view.
    const tile = (col, row, visible) => ({ session: 'd', surface: 0, scale: 4 / 3, col, row, visible });
    const wishes = [tile(0, 0, true), tile(1, 0, true), tile(0, 1, false)];
    const log = [];
    host.on('selection', () => log.push(['selection']));
    host.on('tiles', (d) => log.push(['tiles', d.list.map((t) => `${t.col},${t.row}`)]));
    const painted = (n) => new Promise((resolve) => {
      const off = host.on('tiles', () => log.filter((e) => e[0] === 'tiles').flatMap((e) => e[1]).length >= n && (off(), resolve()));
    });
    let all = painted(3);
    await host.call('want', [wishes]);
    await all;
    // Enter at the document's start moves every line of the page: all three tiles paint again.
    const top = await c.hit(0, 100, 80);
    await c.select(top.pos, top.pos);
    await c.selection();
    log.length = 0;
    all = painted(3);
    await c.exec('text.newParagraph', {});
    await all;
    const at = log.findIndex((e) => e[0] === 'selection');
    const tiles = log.slice(at).filter((e) => e[0] === 'tiles');
    assert.ok(at >= 0, 'the Enter sent its caret');
    // How many tiles fit the edit's batch depends on the paint time (TURN_MS), so the order is checked, not the batches: the first
    // batch after the caret begins with a tile on screen, both tiles on screen come before the one off screen.
    const order = tiles.flatMap((e) => e[1]);
    assert.equal(tiles[0][1][0], '0,0', 'the first tile after the caret is on screen');
    assert.deepEqual(order.slice(0, 2), ['0,0', '1,0'], 'the tiles on screen come first');
    assert.deepEqual(order.slice(2), ['0,1'], 'the tile off screen came after');
  } finally {
    host.terminate();
  }
});

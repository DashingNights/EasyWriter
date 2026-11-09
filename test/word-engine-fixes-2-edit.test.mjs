// engine-fixes-2-edit (docs/plans/word/briefs/engine-fixes-2-edit.md): wave E's editing loose ends. Here: a font download that
// stalls no longer holds fonts.ready() (item 1), and a component never draws a session record dropped between its render and
// its mount (item 2). The crates' tests check items 4 to 6 (doc-edit's picture/bitmap tests), the harness case
// .smoke-data/word/cases/engine-fixes-2-edit.js item 3, and engine-cmd-references item 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFontProvider } from '../src/engine/fonts/provider.mjs';
import { openSource } from '../src/engine/fonts/sources.mjs';

// The engine host the records use: a stand-in Worker that answers every call at once.
class FakeWorker {
  postMessage(m) {
    if (m.id) queueMicrotask(() => this.onmessage({ data: { id: m.id, result: true } }));
  }
  terminate() {}
}
globalThis.Worker = FakeWorker;
// React DOM over a stub page: the components here draw nothing, so no element is ever made.
const doc = { nodeType: 9, baseURI: 'file:///app/', addEventListener() {}, removeEventListener() {}, activeElement: null, body: null };
globalThis.window = { document: doc, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {}, event: undefined };
doc.defaultView = globalThis.window;
globalThis.document = doc;
const container = { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
  addEventListener() {}, removeEventListener() {} };

/** Lets React's queued work run (its scheduler uses setImmediate in Node). */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A provider over the open fonts whose downloads go through `fetch`, with `stall` ms of nothing allowed → its answer for Noto
 * Sans TC (a download font) and the files it handed the engine. */
async function notoThrough(fetch, stall) {
  const files = [];
  const open = openSource({ base: 'file:///app/', fetch, caches: null, stall });
  const provider = createFontProvider({ engine: { addFont: async (b) => files.push(b.byteLength) }, sources: [open] });
  const [r] = await provider.request(['Noto Sans TC']);
  await provider.ready();
  return { missing: r.missing, files };
}

test('a font download that stalls is dropped, so the fonts are ready without it', { timeout: 10000 }, async () => {
  // Headers that never come, then a body that never comes.
  assert.deepEqual(await notoThrough(() => new Promise(() => {}), 50), { missing: true, files: [] });
  const silent = () => Promise.resolve(new Response(new ReadableStream({ start() {} })));
  assert.deepEqual(await notoThrough(silent, 50), { missing: true, files: [] });
  // A slow download that keeps sending is not cut off: ten parts, each sooner than the stall.
  const slow = () => {
    let n = 0;
    return Promise.resolve(new Response(new ReadableStream({
      pull: (c) => new Promise((r) => setTimeout(r, 10)).then(() => (n++ < 10 ? c.enqueue(new Uint8Array(100)) : c.close())),
    })));
  };
  assert.deepEqual(await notoThrough(slow, 1000), { missing: false, files: [1000] });
});

test('a component never draws a session record dropped between its render and its mount', { timeout: 10000 }, async (t) => {
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const { engineHost } = await import('../src/engine/client.js');
  const { sessionRecords } = await import('../src/document/canvas/records.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let made = 0;
  const records = sessionRecords('test', (client, id) => ({ id, n: ++made }));
  const drawn = [];
  const Pane = () => (drawn.push(records.use('s')), null);
  // A large tree drawn after it, as when an open blocks the main thread: 3 s pass, past the record's 2 s let-go.
  const Slow = () => (t.mock.timers.tick(3000), null);
  const root = createRoot(container);
  // A pane held the record and went: it is let go, its 2 s running.
  flushSync(() => root.render(createElement(Pane)));
  await settle();
  flushSync(() => root.render(null));
  await settle();
  flushSync(() => root.render([createElement(Pane, { key: 'pane' }), createElement(Slow, { key: 'slow' })]));
  await settle();
  const now = drawn.at(-1);
  assert.deepEqual({ gone: !!now?.gone, held: !!now && records.peek('s') === now }, { gone: false, held: true }, 'the pane draws the held record');
  // Once the pane goes, the record goes and its watcher with it.
  flushSync(() => root.unmount());
  await settle();
  t.mock.timers.tick(2000);
  assert.deepEqual({ record: records.peek('s'), watching: engineHost().watching('s') }, { record: null, watching: 0 });
});

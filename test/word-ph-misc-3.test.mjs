// ph-misc-3: View > Split's state, the views it works in, its row and the spec entry it lands in. Expected values come from
// Word's Split (two panes from 10 to 90 % of the page area, in Print Layout, Web Layout, Outline and Draft with Vertical page
// movement) and from the brief, never from a run of the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROLS } from '../src/document/ribbon/spec.mjs';
import { REVIEW } from '../src/document/canvas/rows/review.mjs';
import { canSplit, onSplit, setSplit, splitAt } from '../src/document/canvas/split.mjs';

test('setSplit clamps to 10 to 90 % and its listeners hear every call', () => {
  let heard = 0;
  const off = onSplit(() => heard++);
  setSplit(0.02);
  assert.equal(splitAt(), 0.1);
  setSplit(0.99);
  assert.equal(splitAt(), 0.9);
  setSplit(0.5);
  assert.equal(splitAt(), 0.5);
  setSplit(null);
  assert.equal(splitAt(), null);
  assert.equal(heard, 4);
  off();
  setSplit(0.5);
  assert.equal(heard, 4);
  setSplit(null);
});

test('canSplit takes Print Layout, Web Layout, Outline and Draft, moving vertically', () => {
  assert.equal(canSplit('print', null), true);
  assert.equal(canSplit('web', undefined), true);
  assert.equal(canSplit('draft', { kind: 'vertical' }), true);
  assert.equal(canSplit('outline', { kind: 'vertical' }), true);
  assert.equal(canSplit('read'), false);
  assert.equal(canSplit('focus'), false);
  assert.equal(canSplit('immersive'), false);
  assert.equal(canSplit('print', { kind: 'side' }), false);
  assert.equal(canSplit('print', { kind: 'multi' }), false);
});

test('Split is a real control in the spec, with no Windows placeholder', () => {
  assert.equal(CONTROLS['view.window.split'].label, 'Split');
  assert.equal(CONTROLS['view.window.split'].needs, undefined);
  assert.equal(CONTROLS['view.window.newWindow'].needs, 'windows');
  assert.equal(CONTROLS['view.window.arrangeAll'].needs, 'windows');
  assert.equal(CONTROLS['keys.splitKey'], undefined);
});

test('the row reads Remove Split while the page area is split', () => {
  const row = REVIEW['view.window.split'];
  assert.ok(row);
  setSplit(null);
  assert.equal(row.label(), 'Split');
  assert.equal(row.run(), true);
  assert.equal(splitAt(), 0.5);
  assert.equal(row.label(), 'Remove Split');
  assert.equal(row.run(), true);
  assert.equal(splitAt(), null);
  assert.equal(row.label(), 'Split');
});

// The key row Ctrl+Alt+S is what the harness checks through keys.splitKey; its command stays this feature's id.
test('Ctrl+Alt+S is bound to view.window.split', async () => {
  const { WORD_KEYS } = await import('../src/document/word/keymap.mjs');
  const row = WORD_KEYS.find((k) => k.chord === 'Ctrl+Alt+S');
  assert.equal(row?.cmd, 'view.window.split');
  assert.equal(row?.kind, 'bind');
});

// A split paints a tile once and gives each pane a copy: the event's bitmap must be closed once, after the last pane took it,
// or every repaint in a split leaves an ImageBitmap open. The worker and the DOM are stubbed; the tile layer itself runs.
test('a split closes each tile event bitmap once, however many repaints it sees', async () => {
  const received = [];
  class Bitmap {
    constructor(w = 512, h = 512) {
      this.width = w;
      this.height = h;
      this.closed = 0;
      this.consumed = 0;
      received.push(this);
    }
    close() {
      this.closed++;
    }
  }
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return { drawImage() {} };
    }
    transferToImageBitmap() {
      return new Bitmap(this.width, this.height);
    }
  };
  globalThis.document = {
    createElement() {
      return {
        dataset: {}, style: {}, width: 300, height: 150, parentNode: null,
        getContext: (kind) => (kind === 'bitmaprenderer' ? { transferFromImageBitmap: (b) => { if (b) b.consumed++; } } : { drawImage() {} }),
        prepend() {}, insertBefore() {}, querySelector: () => null, remove() { this.parentNode = null; },
      };
    },
  };
  globalThis.requestAnimationFrame = (fn) => (fn(0), 1);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.devicePixelRatio = 1;

  const { createTileLayer } = await import('../src/engine/view/tiles.js');
  const { scaleOf, wanted } = await import('../src/engine/view/tiles.mjs');

  const events = { tiles: [] };
  const host = { dead: false, on: (ev, fn) => ((events[ev] ??= []).push(fn), () => {}), call: async () => ({}) };
  const placement = { key: 's|0', session: 's', surface: 0, x: 0, y: 0, w: 612, h: 792 };
  const makeVp = () => ({
    camera: { x: 0, y: 0, zoom: 1 }, gesture: null, placements: [placement], root: { contains: () => false }, size: { w: 800, h: 600 },
    view: () => ({ x: 0, y: 0, w: 800, h: 600 }), subscribe: () => () => {},
  });
  const slots = { prepend() {}, insertBefore() {}, querySelector: () => null };
  const a = createTileLayer(makeVp(), host);
  const b = createTileLayer(makeVp(), host);
  a.slot(placement, slots);
  b.slot(placement, slots);
  await new Promise((r) => setImmediate(r)); // the two wish lists reach the host

  const tiles = wanted([placement], { x: 0, y: 0, w: 800, h: 600 }, scaleOf(1, 1));
  assert.ok(tiles.length > 0);
  const originals = [];
  for (const version of [1, 2]) { // the first paint and a repaint
    const list = tiles.map((t) => {
      const bitmap = new Bitmap();
      originals.push(bitmap);
      return { surface: t.surface, scale: t.scale, col: t.col, row: t.row, version, bitmap };
    });
    for (const fn of events.tiles) fn({ list }, 's');
  }
  a.destroy();
  b.destroy();

  // Every pane wished every tile, so each original went to two copies and is closed exactly once by the last pane.
  for (const bitmap of originals) {
    assert.equal(bitmap.closed, 1, 'the event bitmap is closed once');
    assert.equal(bitmap.consumed, 0, 'the panes show copies, not the event bitmap');
  }
  const copies = received.filter((x) => !originals.includes(x));
  assert.equal(copies.length, originals.length * 2);
  assert.ok(copies.every((c) => c.consumed === 1));
});

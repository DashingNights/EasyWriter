// zoom-settle (the user, 2026-11-03: "a short delay so that zoom actions in a burst do not each paint. The screen zoom stays
// instant: only the sharp repaint waits"): the tile layer (src/engine/view/tiles.js) over a mock viewport and engine host, in the
// style of word-zoom-race-tiles. A zoom change starts SETTLE_MS = 100: the tiles on the page stay stretched at the new size and
// place, and no tile of the new scale is wished until it fires. Ten changes 20 ms apart wish the last zoom once, 100 ms after it;
// one zoom alone is wished at 100 ms; a scroll with no zoom change wishes in its next frame; a first paint never waits.
import test from 'node:test';
import assert from 'node:assert/strict';

const frames = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
globalThis.cancelAnimationFrame = () => {};
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  activeElement: null,
  createElement: () => {
    const c = {
      style: {}, dataset: {}, parentNode: null, width: 300, height: 150, content: null,
      remove() {
        if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
        c.parentNode = null;
      },
      getContext: () => ({ transferFromImageBitmap: (b) => (c.content = b) }),
    };
    return c;
  },
};

const { createTileLayer } = await import('../src/engine/view/tiles.js');
const { kOf } = await import('../src/engine/view/camera.mjs');
const { scaleOf, TILE } = await import('../src/engine/view/tiles.mjs');

const PAGE = { w: 595, h: 842 };
const VIEW = { w: 1312, h: 816 };

/** A page slot: its children are the tile canvases and the overlay layer the tile layer keeps them under. */
function slotOf() {
  const overlay = { overlay: true, parentNode: null };
  const el = {
    children: [overlay],
    insertBefore(c, ref) {
      c.remove();
      const i = el.children.indexOf(ref);
      el.children.splice(i < 0 ? el.children.length : i, 0, c);
      c.parentNode = el;
    },
    prepend(c) {
      c.remove();
      el.children.unshift(c);
      c.parentNode = el;
    },
    querySelector: () => overlay,
  };
  overlay.parentNode = el;
  return el;
}

/** The tile layer of one page over a viewport at `zoom`; `calls` keeps every wish the layer sends, in order. */
function mount(zoom) {
  frames.length = 0;
  const listeners = { tiles: new Set(), layout: new Set(), reopened: new Set() };
  const calls = [];
  const host = {
    dead: false,
    on: (ev, fn) => (listeners[ev].add(fn), () => listeners[ev].delete(fn)),
    call: (method, args) => (method === 'want' && calls.push(args[0]), Promise.resolve(0)),
  };
  const subs = { camera: new Set(), placements: new Set() };
  const placement = { key: 'p0', session: 1, surface: 0, x: 20, y: 20, w: PAGE.w, h: PAGE.h };
  const vp = {
    camera: { x: 0, y: 0, zoom }, gesture: null, placements: [placement], root: { contains: () => false }, size: VIEW,
    subscribe: (ev, fn) => (subs[ev].add(fn), () => subs[ev].delete(fn)),
  };
  const layer = createTileLayer(vp, host);
  const slot = slotOf();
  layer.slot(placement, slot);
  const bitmap = (w) => ({ scale: w.scale, width: Math.min(TILE, Math.ceil(PAGE.w * w.scale) - w.col * TILE),
    height: Math.min(TILE, Math.ceil(PAGE.h * w.scale) - w.row * TILE), close() {} });
  const m = {
    vp, slot, calls,
    /** A frame, with the microtasks after it (the layer's wish goes out in one). */
    async frame() {
      while (frames.length) frames.shift()();
      await Promise.resolve();
    },
    /** Viewport.setCamera: the camera has the zoom, then the camera event. */
    land(z) {
      vp.camera = { x: 0, y: 0, zoom: z };
      subs.camera.forEach((fn) => fn(vp));
    },
    /** A scroll: the camera moves, the zoom stays, then the camera event. */
    scroll(dy) {
      vp.camera = { ...vp.camera, y: vp.camera.y + dy };
      subs.camera.forEach((fn) => fn(vp));
    },
    /** The worker's tiles event for every wish so far. */
    answer() {
      const tiles = (calls.at(-1) ?? []).map((w) => ({ surface: w.surface, scale: w.scale, col: w.col, row: w.row, version: 1, bitmap: bitmap(w) }));
      listeners.tiles.forEach((fn) => fn({ list: tiles }, 1));
    },
    canvases: () => slot.children.filter((x) => !x.overlay),
    /** The canvases that do not have the size and place the zoom now gives the tile they show: [tile, property, has, wants]. */
    wrong() {
      const k = kOf(vp.camera.zoom);
      const out = [];
      for (const c of m.canvases()) {
        const s = k / c.content.scale;
        const [col, row] = c.dataset.tile.split(',').map(Number);
        const want = { left: `${col * TILE * s}px`, top: `${row * TILE * s}px`, width: `${c.content.width * s}px`, height: `${c.content.height * s}px` };
        for (const key of Object.keys(want)) if (c.style[key] !== want[key]) out.push([c.dataset.tile, key, c.style[key], want[key]]);
      }
      return out;
    },
  };
  return m;
}

/** A page painted at `zoom`: the first plan and the worker's answer, with no settle (nothing was showing to stretch). */
async function painted(zoom) {
  const m = mount(zoom);
  await m.frame();
  m.answer();
  await m.frame();
  return m;
}

test('a first paint is planned at once: nothing is showing, so no repaint waits', async () => {
  const m = mount(0.26);
  await m.frame();
  assert.ok(m.calls.length > 0 && m.calls.at(-1).length > 0, 'the first plan wishes its tiles in its first frame');
  assert.ok(m.calls.at(-1).every((w) => w.scale === scaleOf(0.26, 1)));
});

test('ten zoom changes 20 ms apart wish the last zoom only, 100 ms after it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = await painted(0.26);
  m.calls.length = 0;
  const zooms = [0.32, 0.4, 0.5, 0.6, 0.72, 0.85, 1, 1.2, 1.4, 1.6];
  for (const z of zooms) {
    m.land(z);
    await m.frame();
    t.mock.timers.tick(20);
  }
  // Every zoom of the burst leaves the page stretched and at the new zoom's size and place.
  assert.deepEqual(m.wrong(), []);
  t.mock.timers.tick(79); // 99 ms after the last change
  await m.frame();
  assert.deepEqual(m.calls.flat().map((w) => w.scale), [], 'nothing is wished for a zoom the burst does not stop on');
  t.mock.timers.tick(1); // the timer fires
  await m.frame();
  const last = scaleOf(zooms.at(-1), 1);
  const wish = m.calls.at(-1);
  assert.ok(wish.length > 0, 'the last zoom is wished');
  assert.deepEqual([...new Set(wish.map((w) => w.scale))], [last], 'one wish list, for the last zoom');
});

test('one zoom alone is wished 100 ms after it, with the page stretched meanwhile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = await painted(0.26);
  m.calls.length = 0;
  m.land(0.6);
  await m.frame();
  assert.deepEqual(m.wrong(), [], 'the tiles on the page are stretched at the new zoom at once');
  t.mock.timers.tick(99);
  await m.frame();
  assert.deepEqual(m.calls.flat(), []);
  t.mock.timers.tick(1);
  await m.frame();
  assert.deepEqual([...new Set(m.calls.at(-1).map((w) => w.scale))], [scaleOf(0.6, 1)]);
});

test('a scroll with no zoom change wishes in its next frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const m = await painted(2);
  m.calls.length = 0;
  m.scroll(900);
  await m.frame();
  assert.ok(m.calls.length > 0 && m.calls[0].length > 0, 'the scrolled-in tiles are wished in the scroll\'s next frame');
  assert.ok(m.calls[0].every((w) => w.scale === scaleOf(2, 1)));
});

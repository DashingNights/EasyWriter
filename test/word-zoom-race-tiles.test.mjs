// zoom-race (the user, 2026-11-02: "spammed high speed zoom in and out ... it just gave me more and more artifacts"): the tile layer
// (src/engine/view/tiles.js) over a mock viewport and engine host. A zoom lands (Viewport.setCamera: the camera has the new zoom
// and the slots are laid out for it at once) and a Ctrl+wheel gesture begins before the tile layer's next frame: a mouse wheel
// rolled notch by notch settles 150 ms after each notch (scroll.js SETTLE_MS) and the next notch comes a frame or two later. That
// frame found the gesture and planned nothing (a gesture's transform stretches the world plane meanwhile), and the tiles on the page
// kept the size and place of the zoom before: drawn at the old size inside the new page, off it, with the tiles that arrived since at
// the new size beside them, and the zoom that landed was not planned until the gesture ended. The tiles must have the landed zoom's
// size and place as the slots do, and the layer must wish that zoom's tiles at once.
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

/** The tile layer of one page over a viewport at `zoom`, with a worker that answers what the layer wished, when the test says. */
async function mount(zoom) {
  frames.length = 0;
  const listeners = { tiles: new Set(), layout: new Set(), reopened: new Set() };
  let wished = [];
  const host = {
    dead: false,
    on: (ev, fn) => (listeners[ev].add(fn), () => listeners[ev].delete(fn)),
    call: (method, args) => (method === 'want' && (wished = args[0]), Promise.resolve(0)),
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
    vp, slot,
    /** A frame, with the microtasks after it (the layer's wish goes out in one). */
    async frame() {
      while (frames.length) frames.shift()();
      await Promise.resolve();
    },
    /** Viewport.setCamera: the camera has the zoom, no gesture, then the camera event. */
    land(z) {
      vp.gesture = null;
      vp.camera = { x: 0, y: 0, zoom: z };
      subs.camera.forEach((fn) => fn(vp));
    },
    /** The next wheel notch: a gesture from the camera now. */
    notch() {
      vp.gesture = { ...vp.camera };
    },
    /** The worker's tiles event for the first `n` wishes (all when left out); the rest are in flight → them. */
    answer(n = Infinity) {
      const tiles = wished.map((w) => ({ surface: w.surface, scale: w.scale, col: w.col, row: w.row, version: 1, bitmap: bitmap(w) }));
      const [now, late] = [tiles.slice(0, n), tiles.slice(n)];
      listeners.tiles.forEach((fn) => fn({ list: now }, 1));
      return late;
    },
    wished: () => wished,
    arrive: (list) => listeners.tiles.forEach((fn) => fn({ list }, 1)),
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

/** A page painted at 200 %. */
async function atTwoHundred() {
  const m = await mount(2);
  await m.frame();
  m.answer();
  await m.frame();
  return m;
}

test('the tiles painted at 200 % are placed for 200 %', async () => {
  const m = await atTwoHundred();
  assert.ok(m.canvases().length >= 4, `${m.canvases().length} tiles on screen`);
  assert.deepEqual(m.wrong(), []);
});

test('a zoom lands and a gesture begins before the frame: the tiles have the landed zoom\'s size and place at once', async () => {
  const m = await atTwoHundred();
  m.land(0.26);
  m.notch();
  await m.frame(); // update() finds the gesture and plans nothing
  assert.deepEqual(m.wrong(), [], 'tiles left at the size of the zoom before, off their page');
});

test('a tile that arrives while the gesture runs sits at the landed zoom\'s size with the others', async () => {
  const m = await atTwoHundred();
  // The worker still has two tiles of the 200 % wish in flight when the zoom out lands.
  m.land(2.01);
  await m.frame();
  const late = m.answer(0).slice(0, 2);
  m.land(0.26);
  m.notch();
  await m.frame();
  m.arrive(late);
  await m.frame();
  assert.deepEqual(m.wrong(), []);
});

test('a gesture that begins right after a zoom landed does not leave it unplanned: its tiles are wished, and shown in front when they arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // zoom-settle: the landed zoom's sharp repaint waits SETTLE_MS
  const m = await atTwoHundred();
  m.land(0.26);
  m.notch();
  await m.frame();
  t.mock.timers.tick(100);
  await m.frame();
  const scale = scaleOf(0.26, 1);
  assert.ok(m.wished().length > 0 && m.wished().every((w) => w.scale === scale), `wished scales ${[...new Set(m.wished().map((w) => w.scale))]}`);
  m.answer();
  await m.frame();
  const fronts = m.canvases().filter((c) => c.content.scale === scale);
  assert.ok(fronts.length > 0);
  assert.deepEqual(m.wrong(), []);
});

test('with no gesture the frame places the tiles as well, and a settled gesture leaves them at its zoom', async () => {
  const m = await atTwoHundred();
  m.land(0.26);
  await m.frame();
  assert.deepEqual(m.wrong(), []);
  m.notch();
  m.land(0.4); // the gesture settles
  await m.frame();
  m.answer();
  await m.frame();
  assert.ok(m.canvases().length > 0);
  assert.deepEqual(m.wrong(), []);
});

// engine-pan: the pan driver, its plain-wheel maths and the camera's fitRect (docs/plans/board/briefs/bd-pan.md). The driver tests
// give it the small DOM it reads (an EventTarget root with the fields it uses) and a window for blur, so node runs it without
// Chromium, as the review's simulation did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planeWheel, panDriver, PLANE } from '../src/engine/view/pan.js';
import { fitRect, kOf } from '../src/engine/view/camera.mjs';

// The window the driver hears blur on. Node's globalThis is not an EventTarget, so one stands in for the window's.
const win = new EventTarget();
globalThis.addEventListener = win.addEventListener.bind(win);
globalThis.removeEventListener = win.removeEventListener.bind(win);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.devicePixelRatio = 1.25;

/** The root the driver listens on: an event target with the fields it reads and a pointer capture that behaves as the browser's. */
class Root extends EventTarget {
  constructor() {
    super();
    this.style = {};
    this.clientWidth = 1000;
    this.clientHeight = 800;
    this.clientLeft = 0;
    this.clientTop = 0;
    this.captured = null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  setPointerCapture(id) {
    this.captured = id;
  }
  hasPointerCapture(id) {
    return this.captured === id;
  }
  releasePointerCapture(id) {
    if (this.captured === id) this.captured = null;
  }
  contains() {
    return false;
  }
}

/** A pan driver over a fresh root and a viewport that records its camera, the gestures it showed and what it settled on. */
function makeDriver() {
  const root = new Root();
  const sizer = { style: {} };
  let cam = { x: 0, y: 0, zoom: 1 };
  let settled = null;
  const vp = {
    get camera() {
      return cam;
    },
    extent: () => ({ x: 0, y: 0, w: 0, h: 0 }),
    clampZoom: (z) => z,
    moved(c) {
      cam = c;
    },
    gesture() {},
    settle(g) {
      settled = g;
    },
    resized() {},
    spacePan: () => true,
  };
  const fire = (type, props) => {
    const e = new Event(type, { cancelable: true });
    Object.assign(e, props);
    root.dispatchEvent(e);
    return e;
  };
  return { root, sizer, drv: panDriver(root, sizer, vp), fire, camera: () => cam, settled: () => settled };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
const at = { x: 0, y: 0 };
const range = (z) => z;
const same = (cam, want) => near(cam.x, want.x) && near(cam.y, want.y) && cam.zoom === want.zoom;

test('a plain wheel pans by its pixels over the scale: 40 px is 30 points at zoom 1', () => {
  const cam = planeWheel({ x: 0, y: 0, zoom: 1 }, { deltaX: 0, deltaY: 40, deltaMode: 0 }, at, range);
  assert.ok(same(cam, { x: 0, y: 30, zoom: 1 }), JSON.stringify(cam));
});

test('at zoom 2 the same wheel pans half as far', () => {
  const cam = planeWheel({ x: 0, y: 0, zoom: 2 }, { deltaX: 0, deltaY: 40, deltaMode: 0 }, at, range);
  assert.ok(same(cam, { x: 0, y: 15, zoom: 2 }), JSON.stringify(cam));
});

test('Shift+wheel from a wheel mouse pans across, not down', () => {
  const cam = planeWheel({ x: 0, y: 0, zoom: 1 }, { deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true }, at, range);
  assert.ok(same(cam, { x: 30, y: 0, zoom: 1 }), JSON.stringify(cam));
});

test('fitRect centres and fits a world rect in the view', () => {
  // 300 points is 400 px: the view's height is the tight side, and the rect centres at 150 points of a 600-point view.
  const cam = fitRect({ x: 0, y: 0, w: 300, h: 300 }, { w: 800, h: 400 }, 0);
  assert.ok(near(cam.zoom, 1) && near(cam.x, -150) && near(cam.y, 0), JSON.stringify(cam));
});

test('a middle drag pans on every move, and after it a Space keydown is not the viewport’s', () => {
  const d = makeDriver();
  d.fire('pointerdown', { button: 1, buttons: 4, pointerId: 1, clientX: 100, clientY: 100 });
  for (let i = 1; i <= 5; i++) d.fire('pointermove', { pointerId: 1, buttons: 4, clientX: 100 + 12 * i, clientY: 100 });
  // Five moves of 12 px are 60 px, which is 45 points at zoom 1.
  assert.ok(near(d.camera().x, -45) && near(d.camera().y, 0), JSON.stringify(d.camera()));
  d.fire('pointerup', { pointerId: 1, buttons: 0, clientX: 160, clientY: 100 });
  const key = d.fire('keydown', { code: 'Space' });
  assert.equal(key.defaultPrevented, false);
  d.drv.destroy();
});

test('a lost release ends the drag on the next move, and a lost pointer capture ends it too', () => {
  const d = makeDriver();
  d.fire('pointerdown', { button: 1, buttons: 4, pointerId: 1, clientX: 100, clientY: 100 });
  d.fire('pointermove', { pointerId: 1, buttons: 4, clientX: 112, clientY: 100 });
  const one = d.camera().x;
  assert.ok(near(one, -9));
  d.fire('pointermove', { pointerId: 1, buttons: 0, clientX: 124, clientY: 100 }); // the release happened where no pointerup arrived
  assert.equal(d.camera().x, one);
  d.fire('pointermove', { pointerId: 1, buttons: 4, clientX: 136, clientY: 100 });
  assert.equal(d.camera().x, one);
  const key = d.fire('keydown', { code: 'Space' });
  assert.equal(key.defaultPrevented, false);

  d.fire('pointerdown', { button: 1, buttons: 4, pointerId: 2, clientX: 100, clientY: 100 });
  d.root.captured = null; // the browser dropped it before the event
  d.fire('lostpointercapture', { pointerId: 2 });
  d.fire('pointermove', { pointerId: 2, buttons: 4, clientX: 140, clientY: 100 });
  assert.equal(d.camera().x, one);
  d.drv.destroy();
});

test('Space stops being held when the focus leaves the viewport, and when the window does', () => {
  const d = makeDriver();
  d.fire('keydown', { code: 'Space' });
  assert.equal(d.root.style.cursor, 'grab');
  d.fire('focusout', { relatedTarget: null }); // a focused child lost the focus: the root's own blur never fires
  assert.equal(d.root.style.cursor, '');
  d.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, clientX: 100, clientY: 100 });
  d.fire('pointermove', { pointerId: 1, buttons: 1, clientX: 140, clientY: 100 });
  assert.equal(d.camera().x, 0);

  d.fire('keydown', { code: 'Space' });
  assert.equal(d.root.style.cursor, 'grab');
  win.dispatchEvent(new Event('blur'));
  assert.equal(d.root.style.cursor, '');
  d.drv.destroy();
});

test('a plain-wheel pan during a zoom burst moves the burst, so the settle keeps it', async () => {
  const d = makeDriver();
  d.fire('wheel', { deltaY: -100, deltaX: 0, deltaMode: 0, ctrlKey: true, clientX: 0, clientY: 0 });
  const plain = d.fire('wheel', { deltaY: 40, deltaX: 0, deltaMode: 0, ctrlKey: false });
  assert.ok(plain.defaultPrevented && near(d.camera().y, 30), JSON.stringify(d.camera()));
  await new Promise((ok) => setTimeout(ok, 200)); // the burst settles 150 ms after the last wheel event
  const g = d.settled();
  assert.ok(g && near(g.y, 30) && near(g.zoom, Math.exp(0.1)), JSON.stringify(g));
  d.drv.destroy();
});

test('the camera is held inside the plane: the view stays within plus or minus PLANE', () => {
  const d = makeDriver();
  const c = d.drv.apply({ x: 9e6, y: -9e6, zoom: 1 });
  const span = 1000 / kOf(1);
  assert.ok(near(c.x, PLANE - span) && c.y === -PLANE, JSON.stringify(c));
  d.drv.destroy();
});

test('the sizer transform is snapped to a whole device pixel', () => {
  const d = makeDriver();
  d.drv.apply({ x: 123.456, y: 7.891, zoom: 1.37 });
  const [tx, ty] = d.sizer.style.transform.match(/-?[\d.]+/g).map(Number);
  const k = kOf(1.37);
  for (const [v, exact] of [[tx, -123.456 * k], [ty, -7.891 * k]]) {
    assert.ok(Math.abs(v - exact) <= 0.4 + 1e-6, `${v} against ${exact}`);
    assert.ok(Math.abs(v * 1.25 - Math.round(v * 1.25)) < 1e-9, `${v} is off the device pixel grid`);
  }
  d.drv.destroy();
});

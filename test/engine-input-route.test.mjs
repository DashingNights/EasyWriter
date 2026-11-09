import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createKeymap } from '../src/engine/input/keys.mjs';
import { pastEdge } from '../src/engine/input/pointer.js';
import { inputOnViewport, revealCamera } from '../src/engine/input/viewport.js';
import { createFocus } from '../src/engine/view/focus.js';
import { Engine, initSync } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

// engine-input-route (viewport-design.md P9): input follows the viewport's focused session. The real engine runs in process
// (as test/engine-input.test.mjs does); the viewport is a stand-in with two sessions side by side, one point a pixel, and an
// EditContext that behaves as Chromium's does for these events. The harness case .smoke-data/word/cases/engine-input-route.js runs
// the same in Electron on a real Viewport and the engine's worker.

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

globalThis.DOMRect ??= class DOMRect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    Object.assign(this, { x, y, width, height, left: x, top: y });
  }
};
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 16);
globalThis.cancelAnimationFrame ??= clearTimeout;
const ev = (type, props = {}) => Object.assign(new Event(type, { cancelable: true, bubbles: true }), props);

class FakeEditContext extends EventTarget {
  text = '';
  comp = null;
  updateText(s, e, t) {
    this.text = this.text.slice(0, s) + t + this.text.slice(e);
  }
  updateSelection() {}
  updateControlBounds() {}
  updateSelectionBounds() {}
  updateCharacterBounds(start, rects) {
    this.chars = rects;
  }
  type(t) {
    this.dispatchEvent(ev('textupdate', { text: t, selectionStart: t.length, selectionEnd: t.length }));
  }
  compose(t) {
    if (!this.comp) {
      this.comp = true;
      this.dispatchEvent(ev('compositionstart'));
    }
    this.updateText(0, this.text.length, t);
    this.dispatchEvent(ev('textupdate', { text: t, selectionStart: t.length, selectionEnd: t.length }));
  }
  end() {
    this.comp = null;
    this.dispatchEvent(ev('compositionend'));
  }
}
globalThis.EditContext = FakeEditContext;

const J = (s) => (s == null ? null : JSON.parse(s));
const S = JSON.stringify;
const at = (para, off) => ({ story: 'body', path: [para], off });

/** Session `id` in process, answering and sending events as src/engine/worker.js does, each call logged. */
function session(id, text) {
  const e = new Engine();
  const on = { layout: new Set(), selection: new Set() };
  let sel = null;
  const client = { id, log: [], on: (n, fn) => (on[n]?.add(fn), () => on[n]?.delete(fn)), call: (m, args = []) => client[m](...args) };
  const calls = {
    selection: () => J(e.selection()),
    selectionEvent: () => J(e.selectionEvent()),
    select: (a, h) => e.select(S(a), S(h)),
    hit: (page, x, y) => J(e.hit(page, x, y)),
    exec: (cmd, args = {}) => J(e.exec(cmd, S(args))),
    insertText: (t) => J(e.insertText(t)),
    compose: (t, s = t.length, f = s) => J(e.compose(t, s, f)),
    commit: () => e.commit(),
    undo: () => J(e.undo()),
  };
  for (const [name, fn] of Object.entries(calls)) {
    client[name] = async (...args) => {
      client.log.push(name);
      const r = fn(...args);
      e.takeLayout();
      const now = `${e.version} ${e.selection()}`;
      if (now !== sel) {
        sel = now;
        const event = J(e.selectionEvent());
        for (const fn2 of on.selection) fn2(event);
      }
      return r;
    };
  }
  text.split('\n').forEach((t, i) => {
    if (i) e.exec('text.newParagraph', '{}');
    e.insertText(t);
  });
  e.exec('caret.docStart', '{}');
  e.takeLayout();
  client.all = () => e.text(S(at(0, 0)), S(J(e.move(S(at(0, 0)), 'document', 1)).pos)).replace(/\r/g, '\n');
  client.engine = e;
  return client;
}

/** A viewport stand-in: sessions `ids` one surface each, 1,000 points apart across, the camera at the origin and 1 px a point. */
function viewport(ids) {
  const win = new EventTarget();
  const doc = { defaultView: win, activeElement: null };
  const root = Object.assign(new EventTarget(), {
    ownerDocument: doc, tabIndex: 0, editContext: null, style: {}, clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 600,
    getBoundingClientRect: () => new DOMRect(0, 0, 800, 600),
    contains: (x) => x === root,
    focus() {
      doc.activeElement = root;
    },
  });
  const fns = { focus: new Set(), camera: new Set(), placements: new Set() };
  const layers = new Map();
  const focus = createFocus(() => {});
  focus.subscribe(() => fns.focus.forEach((fn) => fn()));
  const vp = {
    root,
    camera: { x: 0, y: 0, zoom: 0.75 },
    size: { w: 800, h: 600 },
    placements: ids.map((id, i) => ({ key: id, session: id, surface: 0, x: i * 1000, y: 0, w: 612, h: 792 })),
    get focus() {
      return focus.get();
    },
    setFocus: (f) => focus.set(f),
    setCamera(c) {
      vp.camera = { ...vp.camera, ...c };
    },
    fromClient: (cx, cy) => ({ world: { x: vp.camera.x + cx, y: vp.camera.y + cy } }),
    toClient(t) {
      const p = vp.placements.find((q) => q.session === t.session && q.surface === t.surface);
      return p && { x: p.x + t.x - vp.camera.x, y: p.y + t.y - vp.camera.y };
    },
    subscribe: (n, fn) => (fns[n].add(fn), () => fns[n].delete(fn)),
    overlays: { register: (id, C) => (C ? layers.set(id, C) : layers.delete(id)) },
    layers,
  };
  return vp;
}

test('the viewport side: a caret is revealed by the least camera move, and a drag past the edge scrolls', () => {
  const v = { x: 0, y: 0, w: 600, h: 450 };
  assert.equal(revealCamera(v, { x: 100, y: 100, h: 12 }, 18), null, 'a caret in view stays put');
  assert.deepEqual(revealCamera(v, { x: 100, y: 900, h: 12 }, 18), { x: 0, y: 900 + 12 + 18 - 450 }, 'below: its bottom comes into view');
  assert.deepEqual(revealCamera({ ...v, y: 500 }, { x: 100, y: 100, h: 12 }, 18), { x: 0, y: 82 }, 'above: its top');
  const el = { getBoundingClientRect: () => ({ left: 10, top: 20 }), clientLeft: 0, clientTop: 0, clientWidth: 800, clientHeight: 600 };
  assert.deepEqual(pastEdge(el, { clientX: 400, clientY: 300 }), { dx: 0, dy: 0 });
  assert.deepEqual(pastEdge(el, { clientX: 400, clientY: 650 }), { dx: 0, dy: 650 - (20 + 600 - 8) }, 'past the bottom: scroll down');
  assert.deepEqual(pastEdge(el, { clientX: 5, clientY: 300 }), { dx: 5 - 18, dy: 0 }, 'past the left: scroll left');
});

test('the keymap comes from the host: its bindings first, then Word\'s fixed keys', () => {
  const keymap = createKeymap({
    defs: [{ id: 'text.bold', scope: 'text' }, { id: 'app.quit', scope: 'nowhere' }],
    among: (ids, e) => (ids.includes('text.bold') && e.ctrlKey && e.key === 'b' ? 'text.bold' : null),
    chordOf: (e) => [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', e.key].filter(Boolean).join('+'),
    isMac: () => false,
  });
  assert.deepEqual(keymap({ ctrlKey: true, key: 'b' }), { call: 'exec', args: ['format.bold'] });
  assert.deepEqual(keymap({ shiftKey: true, key: 'Left' }), { call: 'exec', args: ['caret.left', { extend: true }] });
  assert.equal(keymap({ key: 'x' }), null, 'a typed letter is the text source’s');
});

test('the selection event: the caret, a column block drawn row by row, a composition\'s boxes; the copy as RTF', () => {
  const e = session('x', 'abcdefgh\nijklmnop').engine;
  const sel = (s) => J(e.selectionEvent());
  let s = sel();
  assert.ok(s.caret && s.rects.length === 0 && s.comp === null && typeof s.version === 'number', S(s));
  e.select(S(at(0, 2)), S(at(1, 5)));
  const stream = sel().rects;
  e.exec('select.column', S({ anchor: at(0, 2), focus: at(1, 5) }));
  s = sel();
  assert.equal(s.rects.length, 2, 'one rectangle per block row');
  assert.ok(Math.abs(s.rects[0].x - s.rects[1].x) < 1.5 && s.rects[0].w < stream[0].w, `a block, narrower than the stream's first line: ${S(s.rects)}`);
  e.exec('edit.copy', '{}');
  assert.match(e.clipboardRtf(), /^\{\\rtf/, 'the copy as RTF');
  e.select(S(at(0, 0)), S(at(0, 0)));
  e.compose('你好', 2, 2);
  s = sel();
  assert.equal(s.comp.text, '你好');
  assert.equal(s.comp.boxes.length, 2, 'a box per character');
  assert.ok(s.comp.boxes[1].x > s.comp.boxes[0].x, 'side by side');
});

test('input follows the focused session; a composition left behind is removed, a typed letter makes no other call', async () => {
  const sessions = { a: session('a', 'alpha'), b: session('b', 'beta') };
  const vp = viewport(['a', 'b']);
  const keymap = () => null;
  const destroy = inputOnViewport(vp, { clientOf: (id) => sessions[id] ?? null, keymap });
  assert.equal(destroy.input, null, 'no focus, no input');
  assert.ok(vp.layers.has('engine-input') && vp.layers.has('engine-input-caret'), 'its overlays, in this viewport');

  vp.setFocus({ session: 'a', mode: 'text' });
  const ia = destroy.input;
  const ecA = vp.root.editContext;
  assert.ok(ia && ecA instanceof FakeEditContext, 'focus on a: input on a, an EditContext on the root');
  await ia.idle();
  sessions.a.log.length = 0;
  ecA.type('X');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sessions.a.log, ['insertText'], 'a typed letter: the edit and nothing else');
  await ia.idle();
  const caret = ia.snapshot().caret;
  assert.ok(caret?.page === 0 && caret.x > 0, `the caret came with the selection event: ${S(caret)}`);
  assert.equal(sessions.a.all(), 'Xalpha');

  ecA.compose('人弓');
  await ia.idle();
  assert.equal(sessions.a.all(), 'X人弓alpha', 'the composition is laid out in a');
  assert.equal(ecA.chars.length, 2, 'the candidate window has its character boxes');

  // Focus moves to b mid-composition: a new EditContext, the old one's late compositionend commits nothing.
  vp.setFocus({ session: 'b', mode: 'text' });
  const ib = destroy.input;
  assert.ok(ib && ib !== ia && vp.root.editContext !== ecA, 'input moved to b with a new EditContext');
  ecA.end();
  await ia.idle();
  assert.equal(sessions.a.all(), 'Xalpha', 'the unfinished composition is gone from a');
  const ecB = vp.root.editContext;
  ecB.compose('n');
  ecB.compose('你');
  ecB.end();
  await ib.idle();
  assert.equal(sessions.b.all(), '你beta', 'b takes the next composition once');
  await sessions.b.undo();
  assert.equal(sessions.b.all(), 'beta', 'and undoes it in one step');

  // Alt+click without a drag starts no column block; with one it does.
  await ib.idle();
  sessions.b.log.length = 0;
  const point = { button: 0, detail: 1, altKey: true, clientX: 1000 + 80, clientY: 80 };
  vp.root.dispatchEvent(ev('mousedown', point));
  vp.root.ownerDocument.defaultView.dispatchEvent(ev('mouseup'));
  await ib.idle();
  assert.ok(!sessions.b.log.includes('exec'), `Alt+click: no select.column (${sessions.b.log})`);
  vp.root.dispatchEvent(ev('mousedown', point));
  vp.root.ownerDocument.defaultView.dispatchEvent(ev('mousemove', { buttons: 1, clientX: 1000 + 120, clientY: 80 }));
  vp.root.ownerDocument.defaultView.dispatchEvent(ev('mouseup'));
  await ib.idle();
  assert.ok(sessions.b.log.includes('exec'), 'Alt+drag: select.column');

  destroy();
  assert.equal(vp.root.editContext, null, 'detached');
  assert.ok(!vp.layers.size, 'its overlays go with it');
});

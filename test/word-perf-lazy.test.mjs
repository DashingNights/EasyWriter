// perf-lazy (docs/plans/word/briefs/perf-lazy.md): lazy.mjs's whenNear and drawAll with a stand-in IntersectionObserver.
import assert from 'node:assert/strict';
import test from 'node:test';

let io = null;
globalThis.IntersectionObserver = class {
  constructor(cb, opts) {
    Object.assign(this, { cb, opts, els: new Set() });
    io = this;
  }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  fire(el, isIntersecting = true) { this.cb([{ target: el, isIntersecting }]); }
};
const { drawAll, waiting, whenNear } = await import('../src/document/lazy.mjs');

/** A stand-in element at layout rows [top, bottom) of a view drawn at `zoom`. */
const element = (top = 0, bottom = 10, zoom = 1) => {
  const attrs = new Set();
  return { attrs, setAttribute: (k) => attrs.add(k), removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k),
    getBoundingClientRect: () => ({ top: top * zoom, bottom: bottom * zoom }) };
};
/** A stand-in editor view: `built` once its docView exists; drawn at `zoom`. */
const viewOf = (built = false, zoom = 1) => {
  const docView = built ? {} : undefined;
  return { docView, dom: { pmViewDesc: docView, closest: (sel) => (sel === '[data-viewport]' ? 'area' : null),
    getBoundingClientRect: () => ({ top: 0, height: 1000 * zoom }), offsetHeight: 1000 } };
};

test('an object a later edit makes draws at once and never waits', () => {
  const view = viewOf(true);
  let n = 0;
  const el = element();
  whenNear(view, el, () => n++);
  assert.equal(n, 1);
  assert.equal(waiting(view), 0);
  assert.equal(el.hasAttribute('data-lazy'), false);
});

test('a first draw waits until the object comes near, then draws once and stays drawn', () => {
  const view = viewOf();
  let n = 0;
  const el = element();
  whenNear(view, el, () => n++);
  assert.equal(n, 0);
  assert.ok(el.hasAttribute('data-lazy'));
  assert.deepEqual(io.opts, { root: 'area', rootMargin: '200%' }); // the page area, two screens each side
  io.fire(el, false);
  assert.equal(n, 0);
  io.fire(el);
  io.fire(el);
  assert.equal(n, 1);
  assert.equal(el.hasAttribute('data-lazy'), false);
  assert.equal(io.els.has(el), false);
  assert.equal(waiting(view), 0);
});

test('a rebuild of every node view waits in the task that built the view, and draws at once after it', async () => {
  const view = viewOf();
  const kinds = [];
  whenNear(view, element(), () => kinds.push('constructor'));
  // TipTap adds its plugins' node views at once: ProseMirror builds a new docView before it replaces the old one.
  Object.assign(view, { docView: { old: true } });
  view.dom.pmViewDesc = { fresh: true };
  whenNear(view, element(), () => kinds.push('same task'));
  assert.deepEqual(kinds, []);
  assert.equal(waiting(view), 2);
  await Promise.resolve();
  whenNear(view, element(), () => kinds.push('later rebuild'));
  assert.deepEqual(kinds, ['later rebuild']);
});

test('now() draws at once, stop() forgets, drawAll draws the rest and settles after their pictures load', async () => {
  const view = viewOf();
  const drawn = [];
  let loaded = false;
  const [a, b, c] = [element(), element(), element()];
  const la = whenNear(view, a, () => drawn.push('a'));
  const lb = whenNear(view, b, () => drawn.push('b'));
  whenNear(view, c, () => new Promise((r) => setTimeout(() => r(drawn.push('c')), 5)).then(() => { loaded = true; }));
  la.now();
  la.now();
  lb.stop();
  assert.deepEqual(drawn, ['a']);
  assert.equal(waiting(view), 1);
  await drawAll(view);
  assert.ok(loaded);
  assert.deepEqual(drawn, ['a', 'c']);
  assert.equal(b.hasAttribute('data-lazy'), false);
  assert.equal(waiting(view), 0);
  await drawAll(view); // nothing left: settles at once
});

test('drawAll with a band draws only the objects that meet it, in zoom-free layout px', async () => {
  const view = viewOf(false, 0.5);
  const drawn = [];
  const els = { above: element(0, 100, 0.5), inside: element(950, 1100, 0.5), below: element(2200, 2300, 0.5) };
  for (const [k, el] of Object.entries(els)) whenNear(view, el, () => drawn.push(k));
  await drawAll(view, { top: 1000, bottom: 2000 });
  assert.deepEqual(drawn, ['inside']);
  assert.equal(waiting(view), 2);
});

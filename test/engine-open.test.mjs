// engine-open (docs/plans/word/briefs/engine-open.md): the first pages within 500 ms of an open, the rest in slices. The engine's
// WebAssembly in Node: after setAhead a layout from the start lays out the first pages and says it is not settled; settle()
// lays out the rest a slice at a time, and the settled layout is the one a whole layout makes (its layout digest). On the Word
// fixture the open, the reopen from the engine form, the slices and select all and copy are timed. The randomised check of
// slices and edits against whole layouts runs natively (engine/: cargo test --release -p ew-wasm --test open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const J = JSON.parse;

/** The pages where two digests differ. */
const differing = (a, b) => a.map((p, i) => (JSON.stringify(p) === JSON.stringify(b[i]) ? -1 : i)).filter((i) => i >= 0);

/** Settles `e` in slices of `ms` → {slices, ms (the whole time), longest (the longest slice)}. */
function settle(e, ms = 8) {
  const t0 = performance.now();
  let slices = 0;
  let longest = 0;
  for (;;) {
    const t = performance.now();
    const done = e.settle(ms);
    longest = Math.max(longest, performance.now() - t);
    slices++;
    if (done) break;
    assert.ok(slices < 100000, 'the layout settles');
  }
  return { slices, ms: performance.now() - t0, longest };
}

/** A document of `n` paragraphs with a page break every 7th, typed into a blank session → its engine form. */
function typed(n) {
  const e = new Engine();
  for (let i = 0; i < n; i++) {
    e.insertText(`Paragraph ${i} `.repeat(30));
    if (i % 7 === 6) e.exec('text.pageBreak', '{}');
    else e.exec('text.newParagraph', '{}');
  }
  const bytes = e.save('engine');
  e.free();
  return bytes;
}

test('a layout ahead lays out the first pages, and settle lays out the rest as a whole layout does', () => {
  const bytes = typed(120);
  const whole = new Engine();
  whole.open(bytes, 'engine');
  const pages = J(whole.pages()).pages.length;
  assert.ok(pages >= 15, `${pages} pages`);

  const e = new Engine();
  e.setAhead(2);
  const opened = J(e.open(bytes, 'engine'));
  assert.equal(opened.settled, false, JSON.stringify(opened));
  assert.ok(opened.pages >= 2 && opened.pages < pages, `${opened.pages} pages first`);
  const first = J(e.takeLayout());
  assert.equal(first.settled, false);
  assert.equal(first.count, opened.pages);
  assert.equal(J(e.pages()).settled, false);
  assert.equal(J(e.surfaces()).settled, false);
  // Slices add pages, and the layout event of the first that finishes one names them. A slice can end between the blocks of a
  // page (engine-repaginate-2), and then has no page to name yet.
  let change;
  for (let i = 0; i < 1000 && !change; i++) {
    e.settle(0);
    change = e.takeLayout();
  }
  const ev = J(change);
  assert.ok(ev.count > first.count && ev.from >= first.count - 1 && ev.to === ev.count, JSON.stringify({ ...ev, pages: undefined }));
  settle(e, 0);
  const last = J(e.takeLayout());
  assert.equal(last.settled, true);
  assert.equal(last.count, pages);
  assert.equal(e.settled(), true);
  assert.deepEqual(J(e.layoutDigest()), J(whole.layoutDigest()));
  e.free();
  whole.free();
});

test('the layout digest settles a layout still being made', () => {
  const bytes = typed(60);
  const whole = new Engine();
  whole.open(bytes, 'engine');
  const e = new Engine();
  e.setAhead(1);
  assert.equal(J(e.open(bytes, 'engine')).settled, false);
  assert.deepEqual(J(e.layoutDigest()), J(whole.layoutDigest()));
  assert.equal(e.settled(), true);
  e.free();
  whole.free();
});

test('typing while the rest is laid out keeps the pages laid out and settles as a whole layout', () => {
  const bytes = typed(120);
  const e = new Engine();
  e.setAhead(2);
  e.open(bytes, 'engine');
  while (J(e.pages()).pages.length < 8) e.settle(0);
  const before = J(e.pages()).pages.length;
  assert.equal(e.settled(), false);
  const pos = J(e.hit(0, 200, 200)).pos;
  e.select(JSON.stringify(pos), JSON.stringify(pos));
  for (const c of 'typed while laying out') e.insertText(c);
  const now = J(e.pages());
  assert.equal(now.settled, false);
  assert.ok(now.pages.length >= before, `${now.pages.length} pages after typing, ${before} before`);
  settle(e);
  const whole = new Engine();
  whole.open(e.save('engine'), 'engine');
  assert.deepEqual(J(e.layoutDigest()), J(whole.layoutDigest()));
  e.free();
  whole.free();
});

test('the rectangles of a highlight cover the pages asked for, so select all costs what a view shows', () => {
  const e = new Engine();
  e.open(typed(120), 'engine');
  e.exec('select.all', '{}');
  const pages = (ev) => [...new Set(ev.rects.map((r) => r.page))].sort((a, b) => a - b);
  const all = pages(J(e.selectionEvent()));
  const count = J(e.pages()).pages.length;
  assert.deepEqual(all, [...Array(count).keys()], 'every page without a range');
  const some = pages(J(e.selectionEvent(4, 6)));
  assert.ok(some.includes(4) && some.includes(5), JSON.stringify(some));
  assert.ok(some.every((p) => p >= 3 && p <= 6), `only the pages asked for and the paragraphs running over their edges: ${some}`);
  e.free();
});

test('the Word fixture: its first pages long before a whole layout, the reopen, the slices, and select all and copy', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here', timeout: 900000 }, () => {
  const docx = fs.readFileSync(FIXTURE);
  // A whole layout first: the fonts layout falls back to load when first needed, and it is the digest to compare with.
  let t = performance.now();
  const whole = new Engine();
  whole.open(docx, 'docx');
  const wholeMs = performance.now() - t;
  const digest = J(whole.layoutDigest());
  const model = whole.save('engine');

  const e = new Engine();
  e.setAhead(4);
  t = performance.now();
  const opened = J(e.open(docx, 'docx'));
  const openMs = performance.now() - t;
  t = performance.now();
  e.paint(0, 4 / 3);
  const paintMs = performance.now() - t;
  const rest = settle(e);
  // The fixture's DATE and TIME fields show the time of each open, so their pages differ between any two opens: those are
  // the pages two whole layouts opened a second apart differ on.
  const sliced = J(e.layoutDigest());
  const later = new Engine();
  const until = Date.now() + 1100;
  while (Date.now() < until);
  later.open(docx, 'docx');
  const timed = differing(digest, J(later.layoutDigest()));
  later.free();

  // Reopen: the engine form, as a draft saved by the canvas editor opens.
  const r = new Engine();
  r.setAhead(4);
  t = performance.now();
  r.open(model, 'engine');
  const reopenMs = performance.now() - t;
  r.free();

  // Select all and copy on the settled layout: the command, the selection event the worker sends after it, the copy and the
  // RTF the worker adds to it.
  t = performance.now();
  e.exec('select.all', '{}');
  const selectMs = performance.now() - t;
  t = performance.now();
  const sel = e.selectionEvent(0, 3);
  const eventMs = performance.now() - t;
  t = performance.now();
  const copy = J(e.exec('edit.copy', '{}'));
  const copyMs = performance.now() - t;
  t = performance.now();
  const rtf = e.clipboardRtf();
  const rtfMs = performance.now() - t;
  assert.ok(copy.ok && copy.value.text.length > 100000, 'the whole text is copied');
  const r1 = (x) => Math.round(x);
  const odd = differing(sliced, digest);
  console.log(`engine-open fixture (Node, wasm): whole open ${r1(wholeMs)} ms; open with setAhead(4) ${r1(openMs)} ms (${opened.pages} pages) and page 1 painted ${r1(paintMs)} ms; the rest ${r1(rest.ms)} ms in ${rest.slices} slices of 8 ms (longest ${r1(rest.longest)}); reopen from the engine form ${r1(reopenMs)} ms; select all ${r1(selectMs)} ms, its selection event ${r1(eventMs)} ms (${sel.length} chars), copy ${r1(copyMs)} ms (text ${copy.value.text.length}, html ${copy.value.html.length} chars), RTF ${r1(rtfMs)} ms (${rtf.length} chars); pages unlike the whole layout's ${JSON.stringify(odd)}, of those showing the time ${JSON.stringify(timed)}`);
  // The budgets (page 1 within 500 ms, select all and copy within 500 ms) are the harness case's, in the app; npm test runs
  // test files side by side, so here the open is checked by its work: the pages it laid out before it returned.
  assert.equal(opened.settled, false);
  assert.ok(opened.pages < 20 && sliced.length > 850, `the open laid out ${opened.pages} pages of ${sliced.length}`);
  assert.equal(sliced.length, digest.length, 'settled, as many pages as the whole layout');
  assert.deepEqual(odd.filter((i) => !timed.includes(i)), [], 'settled, the layout is the whole layout but for the time shown');
  e.free();
  whole.free();
});

test('the slice that settles a layout always brings a layout event that says so', () => {
  const e = new Engine();
  e.setAhead(2);
  e.open(typed(60), 'engine');
  e.takeLayout();
  while (!e.settle(0)) e.takeLayout();
  const last = e.takeLayout();
  assert.ok(last, 'an event after the slice that settled it');
  assert.equal(J(last).settled, true);
  e.settle(0);
  assert.equal(e.takeLayout(), undefined, 'settle on a settled layout brings none');
  e.free();
});

// The main thread's side (client.js) over a stand-in worker that answers every call at once and records what it was sent.
class FakeWorker {
  static all = [];
  sent = [];
  answers = {};
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    this.sent.push(m);
    if (m.id) queueMicrotask(() => this.onmessage({ data: { id: m.id, result: this.answers[m.method] ?? true } }));
  }
  emit(event, data, session) {
    this.onmessage({ data: { event, data, session } });
  }
  terminate() {}
}

test('the host reopens a session that laid out ahead with ahead again, before its open, after a crash', async () => {
  globalThis.Worker = FakeWorker;
  const { EngineHost } = await import('../src/engine/client.js');
  FakeWorker.all.length = 0;
  const host = new EngineHost(new URL('file:///worker.js'), { fonts: false });
  const [a, b] = [host.session('a'), host.session('b')];
  await a.ahead(6);
  await a.open(new Uint8Array(1), 'engine');
  await b.open(new Uint8Array(1), 'engine');
  FakeWorker.all[0].emit('crash', { message: 'boom' });
  const next = FakeWorker.all[1].sent;
  assert.deepEqual(next.map((m) => `${m.session} ${m.method}`), ['a ahead', 'a open', 'b open']);
  assert.deepEqual(next[0].args, [6]);
  host.terminate();
});

test('whenSettled resolves at once on a settled layout, else at the layout event that says it settled', async () => {
  globalThis.Worker = FakeWorker;
  const { EngineHost } = await import('../src/engine/client.js');
  FakeWorker.all.length = 0;
  const host = new EngineHost(new URL('file:///worker.js'), { fonts: false });
  const w = FakeWorker.all[0];
  const s = host.session('s');
  await s.whenSettled();
  w.answers.settled = false;
  let done = false;
  const p = s.whenSettled().then(() => (done = true));
  await new Promise((r) => setTimeout(r));
  w.emit('layout', { settled: false }, 's');
  await new Promise((r) => setTimeout(r));
  assert.equal(done, false);
  w.emit('layout', { settled: true }, 's');
  await p;
  host.terminate();
});

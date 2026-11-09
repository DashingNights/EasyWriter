// engine-incremental (docs/plans/word/briefs/engine-incremental.md): an edit lays out only what it changes. The engine's
// WebAssembly in Node: a typed letter's layout event names the pages it changed (from..to, to not included), and on the Word
// fixture a letter's edit, layout and the paint of its page are timed at pages 1, 300 and 900. The randomised check of
// edits against a whole layout runs natively (engine/: cargo test --release -p ew-wasm --test incremental).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const J = JSON.parse;
const S = JSON.stringify;
// 200 keystrokes a page by default (the brief's count); ENGINE_KEYS changes it.
const KEYS = Number(process.env.ENGINE_KEYS) || 200;

/** Median and 95th percentile of `v`, rounded to 0.1. */
function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const at = (f) => Math.round(s[Math.round((s.length - 1) * f)] * 10) / 10;
  return { median: at(0.5), p95: at(0.95) };
}

test('a typed letter reports the page it changed', () => {
  const e = new Engine();
  e.insertText('Hello');
  e.takeLayout();
  e.insertText('x');
  const ev = J(e.takeLayout());
  assert.deepEqual([ev.from, ev.to, ev.pages.length], [0, 1, 1], S(ev));
  assert.equal(e.takeLayout(), undefined, 'one event a change');
  e.free();
});

test('typing on the Word fixture lays out only the page it types on', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here', timeout: 600000 }, () => {
  const e = new Engine();
  J(e.open(fs.readFileSync(FIXTURE), 'docx'));
  e.takeLayout();
  const { pages } = J(e.pages());
  const report = {};
  for (const page of [0, 299, 899]) {
    const p = pages[page];
    // Typed in body text, the nearest to the page's middle: a row split over pages lays out every page it is on (engine-fidelity-5
    // moved a three-page table row to page 300's middle), and where layout changes put such a row is not this test's subject.
    const pos = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8].map((f) => J(e.hit(page, p.w / 2, p.h * f)).pos).find((at) => at?.story === 'body' && at.path.length === 1);
    assert.ok(pos, `a body paragraph on page ${page + 1}`);
    e.select(S(pos), S(pos));
    e.takeLayout();
    const times = { edit: [], layout: [], paint: [], total: [] };
    let wide = 0;
    for (let i = 0; i < KEYS; i++) {
      const t0 = performance.now();
      const r = J(e.insertText('x'));
      const t1 = performance.now();
      const ev = J(e.takeLayout() ?? 'null');
      const t2 = performance.now();
      // The page the caret is on, painted as the worker repaints it (1.5 px a point: 150% scaling at 100% zoom).
      const caret = J(e.caret(S(J(e.selection()).head)));
      const img = e.paint(caret.page, 1.5);
      img.free();
      const t3 = performance.now();
      assert.ok(r.ok && r.changed, S(r));
      assert.ok(ev && ev.from <= caret.page && caret.page < ev.to, `keystroke ${i} on page ${caret.page + 1}: ${S(ev && { from: ev.from, to: ev.to })}`);
      if (ev.to - ev.from > 2) wide++;
      times.edit.push(t1 - t0);
      times.layout.push(t2 - t1);
      times.paint.push(t3 - t2);
      times.total.push(t3 - t0);
    }
    report[`page ${page + 1}`] = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, stats(v)]));
    // A letter that moves a line onto the next page lays out what follows until the pages are back where they were.
    assert.ok(wide <= KEYS / 20, `${wide} of ${KEYS} keystrokes on page ${page + 1} changed more than 2 pages`);
  }
  console.log(`keystrokes on the fixture (ms, ${KEYS} a page; the gate is 16 ms):`, JSON.stringify(report));
  e.free();
});

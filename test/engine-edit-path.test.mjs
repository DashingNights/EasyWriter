// engine-edit-path (docs/plans/word/briefs/engine-edit-path.md): a typed letter's edit costs the same on page 1 and page 900.
// The engine's WebAssembly in Node: a letter typed into an open typing step changes its paragraph only, still undoes with the
// rest of its word, and on the Word fixture, at the middle of pages 1, 300 and 900, each letter takes the bounded edit path
// (stats().lightEdits) instead of copying the document; its edit (the insertText call alone) is timed for the log only, since
// npm test runs every file at once. The randomised comparison with the whole-document path runs natively
// (engine/: cargo test --release -p ew-wasm --test edit_path).
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
const KEYS = Number(process.env.ENGINE_KEYS) || 200;

function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const at = (f) => Math.round(s[Math.round((s.length - 1) * f)] * 100) / 100;
  return { median: at(0.5), p95: at(0.95) };
}

test('a typed word undoes in one step and redoes', () => {
  const e = new Engine();
  for (const c of 'Hello') assert.ok(J(e.insertText(c)).changed);
  assert.equal(e.text(S(J(e.selection()).head), S({ ...J(e.selection()).head, off: 0 })), 'Hello');
  J(e.undo());
  const head = J(e.selection()).head;
  assert.equal(e.text(S({ ...head, off: 0 }), S(head)), '');
  J(e.redo());
  assert.equal(e.text(S({ ...head, off: 0 }), S({ ...head, off: 5 })), 'Hello');
  e.free();
});

test('a typed letter on the Word fixture takes the bounded edit path at pages 1, 300 and 900', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here', timeout: 600000 }, () => {
  const e = new Engine();
  J(e.open(fs.readFileSync(FIXTURE), 'docx'));
  e.takeLayout();
  const { pages } = J(e.pages());
  const report = {};
  const light = {};
  for (const page of [0, 299, 899]) {
    const p = pages[page];
    const pos = J(e.hit(page, p.w / 2, p.h / 2)).pos;
    e.select(S(pos), S(pos));
    e.takeLayout();
    const edit = [];
    let from = 0;
    for (let i = 0; i < KEYS; i++) {
      // The first letter opens the typing step and the second makes the content control index: both whole-document.
      if (i === 2) from = J(e.stats()).lightEdits;
      const t0 = performance.now();
      const r = J(e.insertText('x'));
      edit.push(performance.now() - t0);
      assert.ok(r.ok && r.changed, S(r));
      e.takeLayout();
    }
    report[`page ${page + 1}`] = stats(edit.slice(2));
    light[`page ${page + 1}`] = J(e.stats()).lightEdits - from;
  }
  console.log(`a typed letter's edit on the fixture (ms, ${KEYS} a page; the gate is the harness case's):`, S(report));
  const all = KEYS - 2;
  assert.deepEqual(light, { 'page 1': all, 'page 300': all, 'page 900': all }, 'letters on the bounded path, of each page\'s last ' + all);
  e.free();
});

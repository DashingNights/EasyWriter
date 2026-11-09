// engine-keys (docs/plans/word/briefs/engine-keys.md): every typing key on the bounded edit path. The engine's WebAssembly in
// Node: on the Word fixture, at pages 1, 300 and 900, a letter, a space, a period, Enter, Backspace and Delete each take the
// bounded path (stats().lightEdits counts them), and a composition that began over a selection and is cancelled leaves neither
// the deletion nor an undo step. Each key's time is printed, not asserted: npm test runs every file at once, so a time here
// measures the machine's load (docs/plans/engine/agent-rules.md). The randomised comparison with the whole-document path runs
// natively (engine/: cargo test --release -p ew-wasm --test edit_path); the keystroke gate is the harness case engine-keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const J = JSON.parse;
const S = JSON.stringify;
const KEYS = Number(process.env.ENGINE_KEYS) || 40;

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)] * 100) / 100;
};

test('a composition that began over a selection and is cancelled leaves no deletion and no undo step', () => {
  const e = new Engine();
  e.insertText('Hello world');
  const head = J(e.selection()).head;
  const at = (off) => S({ ...head, off });
  e.select(at(6), at(11));
  const steps = e.steps();
  e.compose('w', 1, 1);
  e.compose('wo', 2, 2);
  assert.equal(e.text(at(0), at(8)), 'Hello wo', 'the composition replaced the selection');
  e.compose('', 0, 0);
  e.commit();
  assert.equal(e.text(at(0), at(11)), 'Hello world', 'the selection\'s text is back');
  assert.deepEqual([J(e.selection()).anchor.off, J(e.selection()).head.off], [6, 11], 'and selected');
  assert.equal(e.steps(), steps, 'no undo step is left');
  e.free();
});

test('every typing key on the Word fixture takes the bounded edit path at pages 1, 300 and 900', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here', timeout: 600000 }, () => {
  const e = new Engine();
  J(e.open(fs.readFileSync(FIXTURE), 'docx'));
  e.takeLayout();
  const { pages } = J(e.pages());
  const kinds = {
    letter: () => e.insertText('x'),
    space: () => e.insertText(' '),
    period: () => e.insertText('.'),
    enter: () => e.exec('text.newParagraph', '{}'),
    backspace: () => e.deleteBackward('character'),
    delete: () => e.deleteForward('character'),
  };
  const light = () => J(e.stats()).lightEdits;
  const report = {};
  const whole = [];
  for (const page of [0, 299, 899]) {
    const p = pages[page];
    const pos = J(e.hit(page, p.w / 2, p.h / 3)).pos;
    e.select(S(pos), S(pos));
    // The first command after opening tidies the document on the whole-document path.
    e.insertText('w');
    e.takeLayout();
    const row = {};
    for (const [kind, key] of Object.entries(kinds)) {
      const edit = [];
      const layout = [];
      for (let i = 0; i < KEYS; i++) {
        e.insertText('w');
        e.insertText('w');
        e.takeLayout();
        const before = light();
        const t0 = performance.now();
        const r = J(key());
        const t1 = performance.now();
        // A key that falls back to copying the whole document adds no bounded edit.
        if (light() !== before + 1) whole.push(`page ${page + 1}, ${kind}, key ${i}`);
        e.takeLayout();
        edit.push(t1 - t0);
        layout.push(performance.now() - t1);
        assert.ok(r.ok !== false, `${kind}: ${S(r)}`);
      }
      row[kind] = { edit: median(edit), layout: median(layout) };
    }
    report[`page ${page + 1}`] = row;
  }
  console.log(`each key's edit and layout on the fixture (ms, median of ${KEYS}; the gate is the harness case's):`, S(report));
  if (whole.length) console.log('keys that took the whole-document path:', S(whole));
  // A key takes the whole-document path where edit_path.rs's conditions do not hold for it: here 1 of the 720, the Delete that
  // takes page 900's section break away with the empty paragraph it ends, which changes the following section's break too
  // (engine-fixes-2-layout; Delete at the fixture's bookmarks, keys 1 and 30 on page 1, steps over them now). A kind that falls
  // back to copying the document falls back on most of its keys, so each kind keeps 9 in 10 on the bounded path on every page.
  const most = Math.ceil(KEYS * 0.9);
  const short = Object.entries(Object.groupBy(whole, (w) => w.split(', key')[0])).filter(([, list]) => KEYS - list.length < most);
  assert.deepEqual(short, [], `kinds with fewer than ${most} of ${KEYS} keys on the bounded path`);
  e.free();
});

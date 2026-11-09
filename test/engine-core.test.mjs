// engine-core (docs/plans/word/briefs/engine-core.md): the document engine's WebAssembly (src/engine/wasm, built from
// engine/crates/wasm) runs in Node: it opens and lays out the Word fixture, runs a command and undoes it, composes, and
// paints, hit-tests and places the caret on a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const START = { story: 'body', path: [0], off: 0 };
const J = JSON.parse;

test('opens the Word fixture, lays it out, runs a command and undoes it', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here' }, () => {
  const e = new Engine();
  const t0 = performance.now();
  const { pages } = J(e.open(fs.readFileSync(FIXTURE), 'docx'));
  const ms = performance.now() - t0;
  console.log(`fixture: ${pages} pages, read and laid out in ${Math.round(ms)} ms`);
  // 966 in Word; 932 to 966 in WordCraft, by the fonts it has (wordcraft-eval.md section 3).
  assert.ok(pages > 850 && pages < 1100, `${pages} pages`);
  const layout = J(e.takeLayout());
  assert.equal(layout.from, 0);
  assert.equal(layout.pages.length, pages);

  const at = JSON.stringify(J(e.selection()).anchor);
  assert.equal(e.text(at, at), '');
  const r = J(e.exec('text.insert', JSON.stringify({ text: 'Engine check ', raw: true })));
  assert.ok(r.ok && r.changed, JSON.stringify(r));
  const head = J(e.selection()).head;
  assert.equal(e.text(JSON.stringify(START), JSON.stringify(head)), 'Engine check ');
  assert.equal(J(e.takeLayout()).from, 0, 'the edit relays the first page');
  const u = J(e.undo());
  assert.ok(u.ok && u.changed, JSON.stringify(u));
  assert.ok(!e.text(JSON.stringify(START), JSON.stringify(head)).startsWith('Engine check'), 'undo took the text away');
  e.free();
});

test('composes, paints, hit-tests and places the caret on a blank page', () => {
  const e = new Engine();
  // An input method's composition stands in the text and is replaced as it changes.
  J(e.compose('ni', 2, 2));
  const c = J(e.compose('你好', 2, 2));
  assert.equal(e.text(JSON.stringify(c.anchor), JSON.stringify(c.head)), '你好');
  e.commit();
  J(e.undo());
  assert.equal(e.text(JSON.stringify(START), JSON.stringify(c.head)), '', 'the composition is one undo step');
  e.insertText('Hello 你好');

  const { pages } = J(e.pages());
  assert.ok(pages[0].w > 500 && pages[0].h > 700, JSON.stringify(pages[0]));
  const r = e.paint(0, 1);
  assert.equal(r.width, Math.round(pages[0].w));
  const px = r.pixels;
  let ink = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128) ink++;
  r.free();
  assert.ok(ink > 20, `${ink} dark pixels`);

  const caret = J(e.caret(JSON.stringify(J(e.selection()).head)));
  assert.equal(caret.page, 0);
  assert.ok(caret.h > 5 && caret.x > 50, JSON.stringify(caret));
  const hit = J(e.hit(0, caret.x - 1, caret.y + caret.h / 2)).pos;
  assert.ok(hit && hit.off > 0, JSON.stringify(hit));
  const next = J(e.move(JSON.stringify(START), 'word', 1));
  assert.ok(next.pos.off > 0, JSON.stringify(next));
  assert.equal(J(e.state('["format.bold"]'))['format.bold'].enabled, true);
  e.free();
});

test('a change that moves no line still sends a layout event, and commit leaves the caret at the composition end', () => {
  const e = new Engine();
  e.insertText('Hello');
  const { version } = J(e.takeLayout());
  assert.ok(J(e.exec('design.pageColor', JSON.stringify({ color: '123ABC' }))).changed);
  const ev = J(e.takeLayout() ?? 'null');
  assert.ok(ev && ev.version > version, 'the page colour sends a layout event');
  assert.equal(e.takeLayout(), undefined, 'and only one');

  // The input method's own selection sits at the composition's start; commit moves the caret to its end.
  const c = J(e.compose('你好', 0, 0));
  e.commit();
  const sel = J(e.selection());
  assert.deepEqual([sel.anchor, sel.head], [c.head, c.head]);
  e.free();
});

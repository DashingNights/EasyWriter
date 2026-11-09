// engine-paint-damage (docs/plans/word/briefs/engine-paint-damage.md): a tile on screen (paintTile's `shown`) is kept in the
// engine, and its repaint after an edit starts from those pixels: rows the edit did not reach are kept, rows whose lines only
// moved are copied (by whole rows: text lands on whole rows), and only the rest are painted (`painted`). Through the engine's WebAssembly in Node, on a
// page of text: after an Enter and after a join every tile is the whole paint's to within 1 in a byte (a copied line's edge
// pixels round the other way in a few bytes: engine/crates/scene/src/scene_tests.rs says why), and far fewer pixels are
// painted than the tiles hold. Counts, not times. The fixture's page 300 is the native test (engine/crates/wasm/src/tiles_tests.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

const wasm = initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const TILE = 512;
const pos = (para, off = 0) => JSON.stringify({ story: 'body', path: [para], off });

/** Bytes of `a` more than 1 from `b`'s, and those 1 off: [far, near], or [-1, 0] when one is missing or the sizes differ.
 * A repaint is the whole paint's bytes, but a band renders at its own origin and a copied line sits at another absolute device
 * row, where vello_cpu rounds a glyph's edge pixels the other way: 1 in a byte, never more. */
function off(a, b) {
  if (!a || !b || a.length !== b.length) return a === b ? [0, 0] : [-1, 0];
  let [far, near] = [0, 0];
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 1) far++;
    else if (d) near++;
  }
  return [far, near];
}

/** Tile (col, row) of page 0: {px, painted} (a copy of the pixels), or null when nothing is drawn there. */
function tile(e, scale, col, row, shown) {
  const v = e.paintTile(0, scale, col, row, shown);
  if (!v) return null;
  const out = { px: new Uint8Array(wasm.memory.buffer, v.ptr, v.width * v.height * 4).slice(), painted: v.painted };
  v.free();
  return out;
}

test('after an Enter and a join, the tiles on screen repainted over their kept pixels are the whole paint', () => {
  const e = new Engine();
  for (let i = 0; i < 30; i++) {
    if (i) e.exec('text.newParagraph', '{}');
    e.insertText(`Paragraph ${i}, one line that moves.`);
  }
  e.takeLayout();
  // A scale at which a paragraph's step down the page is not a whole number of pixels (about 21.2 at 4/3): the lines below an
  // Enter still move by whole rows, since text lands on whole rows.
  const scale = 4 / 3;
  const step = (J(e.caret(pos(6))).y - J(e.caret(pos(5))).y) * scale;
  assert.ok(Math.abs(step - Math.round(step)) > 0.02, `a step of ${step} px is not a whole number`);
  const { w, h } = J(e.pages()).pages[0];
  const [cols, rows] = [Math.ceil((w * scale) / TILE), Math.ceil((h * scale) / TILE)];
  e.setView(0, 1);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) tile(e, scale, col, row, true);
  const counts = {};
  for (const [name, edit] of [['enter', () => (e.select(pos(5, 9), pos(5, 9)), e.exec('text.newParagraph', '{}'))],
    ['join', () => (e.select(pos(6), pos(6)), e.deleteBackward('character'))]]) {
    edit();
    assert.ok(e.takeLayout(), `${name}: a layout event`);
    let [painted, area, near] = [0, 0, 0];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const got = tile(e, scale, col, row, true);
        const want = tile(e, scale, col, row);
        const [far, n] = off(got?.px, want?.px);
        assert.equal(far, 0, `${name}: tile ${col},${row} is the whole paint to within 1 in a byte`);
        near += n;
        if (got) [painted, area] = [painted + got.painted, area + got.px.length / 4];
        // The whole paint above dropped the kept tile: keep it again for the next edit.
        tile(e, scale, col, row, true);
      }
    }
    counts[name] = { painted, area, near };
    assert.ok(painted * 4 < area, `${name}: ${painted} of ${area} px painted`);
  }
  console.log(`pixels painted against the tiles' at ${scale} px a point: ${JSON.stringify(counts)}; ${e.sceneStats()}`);
  e.free();
});

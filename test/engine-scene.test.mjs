// engine-scene (docs/plans/word/briefs/engine-scene.md, viewport-design.md P6): the 2D renderer's tiles through the
// engine's WebAssembly in Node. A page's 512 px tiles stitch into the page painted whole, a margin tile nothing reaches
// paints nothing, an edit repaints from the new layout, and on the Word fixture the tile paint is timed at 100 % and 200 % for
// the log (the gate, 8 ms at p95, is the harness case engine-scene's: npm test runs every file at once).
// The renderer's own contract (paths, fills, groups, effects, hit testing, damage, the list cache) is tested natively:
//   engine/: cargo test -p ew-scene; the no-change check: cargo run --release -p ew-wasm --example scene_check -- <docx>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

const wasm = initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const FIXTURE = new URL('../.smoke-data/word/fixture/all-features.docx', import.meta.url);
const J = JSON.parse;
const TILE = 512;

/** Tile (col, row) of surface `s` at `scale`: {w, h, px} (a copy) or null when it is not painted. */
function tile(e, s, scale, col, row) {
  const v = e.paintTile(s, scale, col, row);
  if (!v) return null;
  const out = { w: v.width, h: v.height, px: new Uint8ClampedArray(wasm.memory.buffer, v.ptr, v.width * v.height * 4).slice() };
  v.free();
  return out;
}

/** Channels of `t` at (col, row) that differ from the whole page `page` ({width, height, pixels}, read once: the Raster's
 * getter copies) by more than 1; a null tile is paper. */
function offBy(page, t, col, row, paper) {
  let off = 0;
  const [x0, y0] = [col * TILE, row * TILE];
  const w = t ? t.w : Math.min(TILE, page.width - x0);
  const h = t ? t.h : Math.min(TILE, page.height - y0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((y0 + y) * page.width + x0 + x) * 4;
      for (let c = 0; c < 4; c++) {
        const want = page.pixels[a + c];
        const got = t ? t.px[(y * w + x) * 4 + c] : paper[c];
        if (Math.abs(want - got) > 1) off++;
      }
    }
  }
  return off;
}

function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const at = (f) => Math.round(s[Math.round((s.length - 1) * f)] * 1000) / 1000;
  return { median: at(0.5), p95: at(0.95), n: s.length };
}

test('surfaces list the pages with their paper', () => {
  const e = new Engine();
  const s = J(e.surfaces());
  assert.equal(s.list.length, 1);
  const { kind, label, paper } = s.list[0];
  assert.deepEqual({ kind, label, paper }, { kind: 'page', label: '1', paper: '#ffffff' });
  assert.ok(s.list[0].w > 500 && s.list[0].h > 700, JSON.stringify(s.list[0]));
  e.free();
});

test("a page's tiles stitch into the page painted whole, and a blank margin tile is not painted", () => {
  const e = new Engine();
  for (const c of 'Tiles meet without a seam. ') e.insertText(c);
  for (const scale of [4 / 3, 2, 3]) {
    const raster = e.paint(0, scale);
    const page = { width: raster.width, height: raster.height, pixels: raster.pixels };
    raster.free();
    const [cols, rows] = [Math.ceil(page.width / TILE), Math.ceil(page.height / TILE)];
    let blank = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const t = tile(e, 0, scale, col, row);
        if (!t) blank++;
        else assert.deepEqual([t.w, t.h], [Math.min(TILE, page.width - col * TILE), Math.min(TILE, page.height - row * TILE)]);
        assert.equal(offBy(page, t, col, row, [255, 255, 255, 255]), 0, `scale ${scale} tile ${col},${row}`);
      }
    }
    assert.ok(blank > 0, `scale ${scale}: the margin tiles are blank`);
    // The bottom-right tile is margin: nothing is painted and nothing is returned.
    assert.equal(e.paintTile(0, scale, cols - 1, rows - 1), undefined);
    assert.equal(e.paintTile(0, scale, cols, 0), undefined, 'past the page');
  }
  e.free();
});

test('an edit repaints from the new layout, and the list cache holds the session', () => {
  const e = new Engine();
  for (const c of 'Before') e.insertText(c);
  const before = tile(e, 0, 2, 0, 0);
  const version = e.version;
  e.insertText(' and after');
  const after = tile(e, 0, 2, 0, 0);
  assert.ok(before && after);
  assert.ok(e.version > version, 'the tile shows a newer layout version');
  assert.notDeepEqual(after.px, before.px, 'the new text is in the tile');
  const { lists, bytes } = J(e.sceneStats());
  assert.ok(lists >= 1 && bytes > 0, e.sceneStats());
  e.free();
});

test('tile paint on the Word fixture at 100 % and 200 %', { skip: !fs.existsSync(FIXTURE) && 'no Word fixture here', timeout: 600000 }, () => {
  const e = new Engine();
  J(e.open(fs.readFileSync(FIXTURE), 'docx'));
  const { list } = J(e.surfaces());
  const report = {};
  const painted = {};
  for (const [zoom, scale] of [['100 %', 4 / 3], ['200 %', 8 / 3]]) {
    const times = [];
    let blank = 0;
    painted[zoom] = 0;
    for (let s = 0; s < 20; s++) {
      const [cols, rows] = [Math.ceil((list[s].w * scale) / TILE), Math.ceil((list[s].h * scale) / TILE)];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const t0 = performance.now();
          const v = e.paintTile(s, scale, col, row);
          times.push(performance.now() - t0);
          if (v) (v.free(), painted[zoom]++);
          else blank++;
        }
      }
    }
    report[zoom] = { ...stats(times), blank };
  }
  console.log('a 512 px tile on pages 1 to 20 of the fixture (ms; the gate is the harness case\'s):', JSON.stringify(report));
  // Twice the zoom covers each page with about four times the tiles, and the pages' text reaches more of them.
  assert.ok(painted['100 %'] > 20 && painted['200 %'] > 2 * painted['100 %'], JSON.stringify(painted));
  e.free();
});

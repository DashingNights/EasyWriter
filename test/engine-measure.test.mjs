// engine-measure (docs/plans/engine/viewport-design.md P1): the engine's `stats()` (section 8) answers the worker's memory, the
// allocator's bytes in use, the fonts' bytes and the session's undo steps, and the allocator count follows what the engine
// holds. The measurements themselves run in .smoke-data/word/cases/_engine-measure.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

test('stats() reports memory, heap, fonts, undo steps and bounded edits', () => {
  const e = new Engine();
  const before = JSON.parse(e.stats());
  assert.deepEqual(Object.keys(before).sort(), ['fonts', 'heap', 'lightEdits', 'undo', 'wasm']);
  assert.equal(before.lightEdits, 0);
  assert.ok(before.wasm > 0 && before.wasm % 65536 === 0, `wasm memory is whole pages: ${before.wasm}`);
  assert.ok(before.heap > 0 && before.heap < before.wasm, `the heap in use fits in memory: ${before.heap}`);
  assert.equal(before.undo, 0);

  // A second session's document is allocator bytes in use; freeing it gives them back.
  const other = new Engine();
  other.insertText('x'.repeat(200000));
  const held = JSON.parse(e.stats()).heap;
  assert.ok(held > before.heap + 200000, `200,000 letters are in use: ${held - before.heap} bytes more`);
  other.free();
  assert.ok(JSON.parse(e.stats()).heap < held - 200000, 'freed with the session');

  e.insertText('a');
  assert.equal(JSON.parse(e.stats()).undo, 1);
});

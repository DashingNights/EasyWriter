// engine-keystroke (docs/plans/engine/viewport-design.md P12): which tiles a layout's damage spares (tiles.mjs untouched, the rule
// the worker and the tile layer share), the tile budget, and the accessibility copy's page cache (a11y/blocks.js blocksOf).
// The pixels behind the rule are checked by the wrapper crate's test (engine/crates/wasm/tests/keystroke.rs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { blocksOf } from '../src/engine/a11y/blocks.js';
import { BUDGET, untouched } from '../src/engine/view/tiles.mjs';

test('a tile painted at the damage\'s base version and met by no rect keeps its pixels; any other repaints', () => {
  const tile = { surface: 2, scale: 1, col: 0, row: 1 }; // points 0..512 across, 512..1024 down
  const e = (rects, since = 7, surface = 2) => ({ version: 9, damage: [{ surface, since, rects }] });
  assert.equal(untouched(tile, 7, e([{ x: 10, y: 100, w: 50, h: 12 }])), true, 'damage above the tile');
  assert.equal(untouched(tile, 7, e([{ x: 10, y: 505, w: 50, h: 5.5 }])), true, 'ends a pixel and a half above it');
  assert.equal(untouched(tile, 7, e([{ x: 10, y: 505, w: 50, h: 6.5 }])), false, 'ends within a device pixel of it');
  assert.equal(untouched(tile, 6, e([{ x: 10, y: 100, w: 50, h: 12 }])), false, 'painted at another version');
  assert.equal(untouched(tile, 7, e([], 7, 3)), false, 'its surface has no damage entry');
  assert.equal(untouched(tile, null, e([])), false, 'never painted');
  assert.equal(untouched(tile, 7, { version: 9 }), false, 'an event without damage');
  assert.equal(untouched({ ...tile, scale: 4 }, 7, e([{ x: 10, y: 127.5, w: 5, h: 0.2 }])), true, 'at 4 px a point the margin is a quarter point');
  assert.equal(untouched({ ...tile, scale: 4 }, 7, e([{ x: 10, y: 127.5, w: 5, h: 0.3 }])), false);
});

test('the tile budget holds the plan\'s 256 MiB at the measured 3.3 to 3.6 MiB a tile', () => {
  assert.equal(BUDGET, 72);
  assert.ok(BUDGET * 3.55 <= 256);
});

test('blocksOf asks the engine only for pages its cache lacks, and the merge leaves the cache as the engine gave it', async () => {
  const asked = [];
  const para = (page) => ({ id: '4', kind: 'p', text: 'over two pages', boxes: [{ line: page, x: 0, y: 0, w: 1, h: 1 }] });
  const client = { blocks: async (page) => (asked.push(page), [para(page)]) };
  const cache = new Map();
  const one = await blocksOf(client, [0, 1], cache);
  assert.deepEqual(asked, [0, 1]);
  assert.equal(one[0].boxes.length, 2, 'the paragraph carries the boxes of both pages');
  const two = await blocksOf(client, [0, 1], cache);
  assert.deepEqual(asked, [0, 1], 'nothing asked again');
  assert.equal(two[0].boxes.length, 2, 'the same merge, not boxes added again');
  assert.equal(cache.get(0)[0].boxes.length, 1);
  cache.delete(1);
  await blocksOf(client, [0, 1], cache);
  assert.deepEqual(asked, [0, 1, 1], 'a changed page is asked again');
});

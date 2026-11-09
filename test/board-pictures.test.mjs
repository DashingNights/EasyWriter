// bd-pictures (docs/plans/board/briefs/bd-pictures.md): the pure parts of a board's pictures, the sizes and the row they land in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extOf, fitted, mediaKey, naturalSize, rowAt } from '../src/board/tools/pictures.js';

const enc = new TextEncoder();
const svg = (attrs) => enc.encode(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`);
/** A PNG's first bytes: signature, IHDR chunk with `w` x `h`, and a stub tail (the header is all a size reads). */
const pngBytes = (w, h) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  ...[w, h].flatMap((n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]), 8, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

test('fitted caps the longest side at 600 and never grows a picture', () => {
  assert.deepEqual(fitted({ w: 1200, h: 600 }), { w: 600, h: 300 });
  assert.deepEqual(fitted({ w: 100, h: 50 }), { w: 100, h: 50 });
  assert.deepEqual(fitted({ w: 300, h: 900 }), { w: 200, h: 600 });
});

test('rowAt centres a row on the point, with the gap between the pictures', () => {
  const spots = rowAt([{ w: 100, h: 50 }, { w: 100, h: 50 }], { x: 0, y: 0 }, 16);
  assert.deepEqual(spots, [{ x: -108, y: -25 }, { x: 8, y: -25 }]);
});

test('mediaKey hashes the bytes, so equal pictures share one key, and ends in the extension', async () => {
  const one = await mediaKey(new Uint8Array([1, 2, 3]), 'png');
  assert.equal(one, await mediaKey(new Uint8Array([1, 2, 3]), 'png'));
  assert.notEqual(one, await mediaKey(new Uint8Array([1, 2, 4]), 'png'));
  assert.match(one, /^[0-9a-f]{64}\.png$/);
});

test('an SVG is sized by its own width and height, never by stroke-width', async () => {
  assert.deepEqual(await naturalSize(svg('viewBox="0 0 24 24" stroke-width="1.5"'), 'svg'), { w: 18, h: 18 });
  assert.deepEqual(await naturalSize(svg('width="24px" height="12px"'), 'svg'), { w: 18, h: 9 });
});

test('an SVG width is a number, and a dot or nothing falls back to the viewBox', async () => {
  const big = await naturalSize(svg('width="1e10" height="4"'), 'svg');
  assert.ok(Math.abs(big.w - 7.5e9) < 1e3 && Math.abs(big.h - 3) < 1e-6, JSON.stringify(big));
  assert.deepEqual(await naturalSize(svg('width="." height="." viewBox="0 0 24 24"'), 'svg'), { w: 18, h: 18 });
  assert.deepEqual(await naturalSize(svg('height="12" viewBox="0 0 24 24"'), 'svg'), { w: 18, h: 9 });
});

test('an SVG with no usable size is refused', async () => {
  assert.equal(await naturalSize(svg('width="0" height="0"'), 'svg'), null);
  assert.equal(await naturalSize(svg('width="0" height="0" viewBox="0 0 0 0"'), 'svg'), null);
});

test('a raster size comes from its header, so an enormous picture is refused before it decodes', async () => {
  const small = await naturalSize(pngBytes(300, 200), 'png');
  assert.deepEqual([small.w, small.h, small.pixels], [225, 150, 60000]);
  const huge = await naturalSize(pngBytes(20000, 20000), 'png');
  assert.equal(huge.pixels, 4e8);
  assert.equal(huge.w, 15000);
});

test('a file that is not a metafile has no size, so it is refused', async () => {
  assert.equal(await naturalSize(enc.encode('this is not an EMF'), 'emf'), null);
  assert.equal(await naturalSize(enc.encode('nor a WMF'), 'wmf'), null);
});

test('extOf names a picture by its type, else by its name', () => {
  assert.equal(extOf('image/svg+xml'), 'svg');
  assert.equal(extOf('image/jpeg', 'beach.jpg'), 'jpeg');
  assert.equal(extOf('', 'logo.EMF'), 'emf');
  assert.equal(extOf('image/x-wmf', 'old.wmf'), 'wmf');
  assert.equal(extOf('', 'photo.tif'), 'tiff');
  assert.equal(extOf('', 'screenshot.png'), 'png');
});

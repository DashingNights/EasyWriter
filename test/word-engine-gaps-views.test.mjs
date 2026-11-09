// engine-gaps-views (docs/plans/engine/stage2b.md): Read Mode, Web Layout, Draft, Immersive Reader and Side to Side on a canvas
// draft. The pure parts: the viewport's arrangements (src/engine/view/arrange.mjs), the engine view and room each store view
// gives the session (views/canvas.mjs), and the rows that now run on a canvas draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenRow, screenStart, spread } from '../src/engine/view/arrange.mjs';
import { engineView, readerOf, readPages, windowOf } from '../src/document/wp/views/canvas.mjs';
import { REVIEW } from '../src/document/canvas/rows/review.mjs';
import { APP } from '../src/document/canvas/rows/forms.mjs';

const LETTER = { w: 612, h: 792 };

test('screens start at the first page of their spread', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => screenStart(i, 2, 5)), [0, 0, 2, 2, 4]);
  assert.equal(screenStart(9, 2, 5), 4, 'past the end: the last screen');
  assert.equal(screenStart(3, 1, 5), 3);
});

test('Side to Side fits the pages to the height and shows two when two fit across', () => {
  const wide = spread([LETTER, LETTER], { w: 1600, h: 900 }, { pad: 24, top: 32, gap: 16 });
  assert.equal(wide.cols, 2);
  assert.ok(Math.abs(wide.zoom * (4 / 3) * 792 - (900 - 32 - 48)) < 0.5, 'one page tall fills the height');
  const narrow = spread([LETTER, LETTER], { w: 700, h: 900 }, { pad: 24, top: 32, gap: 16 });
  assert.equal(narrow.cols, 1);
  assert.ok(narrow.zoom * (4 / 3) * 612 <= 700 - 48 + 0.5, 'one page still fits across');
});

test('a screen row places only its pages, centred below the bar, and does not scroll', () => {
  const sizes = [LETTER, LETTER, LETTER];
  const { placements, extent } = screenRow(sizes, { first: 2, count: 2, zoom: 0.5, view: { w: 1000, h: 800 }, top: 32, session: 's' });
  assert.deepEqual(placements.map((p) => p.surface), [2], 'the last screen has one page');
  const k = 0.5 * (4 / 3);
  assert.ok(Math.abs(placements[0].x - (1000 / k - 612) / 2) < 1e-6);
  assert.ok(placements[0].y >= 32 / k);
  assert.equal(extent.w, 1000 / k);
  assert.equal(extent.h, 800 / k);
  const two = screenRow(sizes, { first: 0, count: 2, zoom: 0.5, view: { w: 1000, h: 800 }, gap: 16 }).placements;
  assert.ok(Math.abs(two[1].x - two[0].x - 612 - 16 / (4 / 3)) < 1e-6, 'the gap is px at 100 %, so points at any zoom');
});

test('each store view runs its engine view', () => {
  assert.deepEqual(engineView('web'), ['view.webLayout', {}]);
  assert.deepEqual(engineView('draft'), ['view.draft', {}]);
  assert.deepEqual(engineView('read'), ['view.readMode', {}]);
  assert.deepEqual(engineView('immersive'), ['view.immersiveReader', { value: true }]);
  assert.deepEqual(engineView('outline'), ['view.outline', {}]);
  for (const v of ['print', 'focus', undefined]) assert.deepEqual(engineView(v), ['view.printLayout', {}]);
});

const WORD = {
  readMode: { columnWidth: 'default', pageColor: 'sepia', layout: 'column', syllables: true, textSpacing: false },
  immersive: { columnWidth: 'narrow', pageColor: 'inverse', lineFocus: 1, textSpacing: true, syllables: false },
  display: { wrapToWindow: true },
};

test('the room each view flows to follows the page area and the zoom', () => {
  const at100 = windowOf({ w: 1048, h: 800 }, 1, WORD);
  assert.equal(at100.web, 750, 'the view less its pads, in points');
  assert.equal(windowOf({ w: 1048, h: 800 }, 2, WORD).web, 375, 'zoomed in, fewer points across');
  assert.equal(at100.reader, 50 * 5.5 + 36, "Narrow is 50 ch with the reflow page's margins");
  assert.equal(windowOf({ w: 1048, h: 800 }, 1, { ...WORD, immersive: { columnWidth: 'default' } }).reader, null, 'Default keeps the page width');
  assert.equal(at100.wrap, true);
  const r = readPages({ w: 1600, h: 900 }, WORD.readMode);
  assert.ok(r.count >= 2 && Math.abs(at100.read[1] - readPages({ w: 1048, h: 800 }, WORD.readMode).h) < 0.01);
  assert.ok(readPages({ w: 1600, h: 900 }, { columnWidth: 'narrow' }).count > r.count, 'narrow columns fit more');
  assert.equal(readPages({ w: 1600, h: 900 }, { layout: 'paper' }).count, 1, 'Paper Layout is one column');
});

test('Read Mode and the Reader each push their own options; other views none', () => {
  assert.deepEqual(readerOf('read', WORD), { pageColor: 'sepia', spacing: false, syllables: true });
  assert.deepEqual(readerOf('immersive', WORD), { pageColor: 'inverse', spacing: true, syllables: false });
  assert.deepEqual(readerOf('print', WORD), { pageColor: 'none', spacing: false, syllables: false });
});

test('the views rows run on a canvas draft', () => {
  const ids = ['view.views.readMode', 'view.views.webLayout', 'view.views.draft', 'view.immersive.immersiveReader',
    ...['columnWidth', 'pageColor', 'lineFocus', 'textSpacing', 'syllables'].map((k) => `immersiveReader.immersiveReader.${k}`),
    'view.pageMovement.sideToSide', 'views.thumbnails'];
  for (const id of ids) assert.equal(REVIEW[id], APP, id);
});

// views' pure logic (src/document/wp/views/views.mjs): the Zoom dialog's conversions, Read Mode's screens and columns, the Line
// Focus band, the Switch Windows list and Syllables.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  focusBand, GAP, nextDraft, readColumns, READ_WIDTHS, screenAt, screenCount, sideFit, syllabify, windowList, zoomFor,
} from '../src/document/wp/views/views.mjs';

// A4 at 96 dpi: 794 x 1123 px with 2.54 cm margins (text 642 px).
const A4 = { area: { w: 1200, h: 800 }, page: { w: 794, h: 1123 }, text: 642 };

test('Zoom dialog conversions', () => {
  assert.equal(zoomFor('200', A4), 200);
  assert.equal(zoomFor('75', A4), 75);
  assert.equal(zoomFor('pageWidth', A4), Math.round((100 * 1200) / 794));
  assert.equal(zoomFor('textWidth', A4), Math.round((100 * 1200) / 642));
  assert.equal(zoomFor('wholePage', A4), Math.round((100 * 800) / 1123)); // height limits
  // Two pages across with the 16 px gap between them: the height limits here (800 / 1123 < 1200 / 1604), and on a wide area the width.
  assert.equal(zoomFor('manyPages', { ...A4, grid: { cols: 2, rows: 1 } }), Math.round((100 * 800) / 1123));
  assert.equal(zoomFor('manyPages', { ...A4, area: { w: 1200, h: 2000 }, grid: { cols: 2, rows: 1 } }), Math.round((100 * 1200) / (2 * 794 + GAP)));
  assert.equal(zoomFor('manyPages', { ...A4, grid: { cols: 4, rows: 2 } }), Math.round(100 * Math.min(1200 / (4 * 794 + 3 * GAP), 800 / (2 * 1123 + GAP))));
  // Word's 10 to 500 percent.
  assert.equal(zoomFor('textWidth', { ...A4, area: { w: 10000, h: 800 } }), 500);
  assert.equal(zoomFor('wholePage', { ...A4, area: { w: 20, h: 20 } }), 10);
});

test('Side to Side fits the pages to the height, two across when two fit', () => {
  const page = A4.page;
  assert.deepEqual(sideFit({ w: 1600, h: 800 }, page), { cols: 2, scale: 800 / 1123 }); // wide: two at the window's height
  assert.deepEqual(sideFit({ w: 900, h: 800 }, page), { cols: 1, scale: 800 / 1123 }); // two would not fit: one, still height-fitted
  assert.deepEqual(sideFit({ w: 400, h: 800 }, page), { cols: 1, scale: 400 / 794 }); // one too wide: fitted to the width
});

test('Read Mode screens and the screen of a position', () => {
  assert.equal(screenCount(1000, 1000, 48), 1);
  assert.equal(screenCount(1000 + 48 + 1000, 1000, 48), 2);
  assert.equal(screenCount(1000 + 48 + 10, 1000, 48), 2);
  assert.equal(screenCount(0, 1000, 48), 1);
  assert.equal(screenAt(0, 1000, 48), 0);
  assert.equal(screenAt(1047, 1000, 48), 0);
  assert.equal(screenAt(1048, 1000, 48), 1);
  assert.equal(screenAt(3 * 1048 + 5, 1000, 48), 3);
});

test('Read Mode column widths per setting', () => {
  const W = 1600;
  const narrow = readColumns(W, 'narrow', 48);
  const normal = readColumns(W, 'default', 48);
  const wide = readColumns(W, 'wide', 48);
  assert.ok(narrow.count > normal.count && normal.count > wide.count, JSON.stringify({ narrow, normal, wide }));
  for (const [c, setting] of [[narrow, 'narrow'], [normal, 'default'], [wide, 'wide']]) {
    assert.ok(c.width <= READ_WIDTHS[setting] + 0.001, setting);
    assert.equal(Math.round(c.count * c.width + (c.count - 1) * 48), W);
  }
  assert.deepEqual(readColumns(300, 'wide', 48), { count: 1, width: 300 });
  assert.deepEqual(readColumns(1600, 'default', 48, 642), { count: 1, width: 642 }); // Paper Layout
});

test('Line Focus band for 1, 3 and 5 lines', () => {
  const line = { top: 200, bottom: 220 };
  assert.equal(focusBand(line, 0), null);
  assert.deepEqual(focusBand(line, 1), { top: 200, bottom: 220 });
  assert.deepEqual(focusBand(line, 3), { top: 180, bottom: 240 });
  assert.deepEqual(focusBand(line, 5), { top: 160, bottom: 260 });
  // Kept inside the text: at its first line the band starts there.
  assert.deepEqual(focusBand({ top: 100, bottom: 120 }, 5, { top: 100, bottom: 1000 }), { top: 100, bottom: 200 });
  assert.deepEqual(focusBand({ top: 980, bottom: 1000 }, 3, { top: 100, bottom: 1000 }), { top: 940, bottom: 1000 });
});

test('Switch Windows numbering and order', () => {
  const drafts = Array.from({ length: 11 }, (_, i) => ({ id: `d${i}`, title: i === 2 ? '' : `Doc ${i}` }));
  const list = windowList(drafts, 'd1');
  assert.equal(list.length, 9);
  assert.deepEqual(list.slice(0, 3), [
    { id: 'd0', label: '1 Doc 0', active: false }, { id: 'd1', label: '2 Doc 1', active: true }, { id: 'd2', label: '3 Untitled', active: false },
  ]);
  assert.equal(list[8].label, '9 Doc 8');
  assert.equal(nextDraft(drafts, 'd1', 1), 'd2');
  assert.equal(nextDraft(drafts, 'd10', 1), 'd0');
  assert.equal(nextDraft(drafts, 'd0', -1), 'd10');
  assert.equal(nextDraft([{ id: 'a' }], 'a', 1), null);
});

test('Syllables put a middle dot at each break', () => {
  assert.equal(syllabify('reading', () => [4]), 'read·ing');
  assert.equal(syllabify('wonderful', () => [6, 3, 3, 0, 9]), 'won·der·ful');
  assert.equal(syllabify('word', () => []), 'word');
});

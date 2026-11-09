// table-row-layout (docs/plans/word/briefs/table-row-layout.md): Word's row-wide top margin and rows that split at a page end, in
// the page engine's pure layout (src/document/wp/page-engine/layout.mjs rowTop, rowSplits, rowLines and planPages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPages, rowLines, rowSplits, rowTop } from '../src/document/wp/page-engine/layout.mjs';

test('row-wide top margin: the largest of the cells, null when they all have it', () => {
  assert.equal(rowTop([36, 0, 0]), 36);
  assert.equal(rowTop([4, 2]), 4);
  assert.equal(rowTop([4, 4]), null);
  assert.equal(rowTop([0]), null);
});

test('which rows split: not cantSplit, header rows or exact heights', () => {
  assert.equal(rowSplits({}), true);
  assert.equal(rowSplits({ height: { value: 36, rule: 'atLeast' } }), true);
  assert.equal(rowSplits({ cantSplit: true }), false);
  assert.equal(rowSplits({ header: true }), false);
  assert.equal(rowSplits({ height: { value: 36, rule: 'exact' } }), false);
});

const lines = (n, h = 20, top = 0) => Array.from({ length: n }, (_, i) => ({ top: top + i * h, bottom: top + (i + 1) * h }));

test('row lines: the cells\' line ends, close ones merged, the next page starting at the row foot less the tallest rest', () => {
  // A: one line with 5 px of padding below; B: three lines and 5 px.
  const L = rowLines([{ lines: lines(1), end: 25 }, { lines: lines(3), end: 65 }], 65, 3);
  assert.deepEqual(L.map((l) => l.bottom), [20, 25, 40, 65]);
  // After 20 px both cells go on (A's 25 px foot, B's lines from 20): the tallest rest is B's 45 px, so the next page starts at 20.
  assert.deepEqual(L.map((l) => l.top), [0, 20, 20, 40]);
  // Line ends 1 px apart are one cut: a breaker 3 px below the first would leave the second on its page.
  const M = rowLines([{ lines: lines(2), end: 40 }, { lines: [{ top: 0, bottom: 21 }, { top: 21, bottom: 42 }], end: 42 }], 42, 3);
  assert.deepEqual(M.map((l) => l.bottom), [21, 42]);
  // An at-least height past the text stays with the last line.
  assert.deepEqual(rowLines([{ lines: lines(2), end: 40 }], 100, 3).map((l) => l.bottom), [20, 100]);
});

test('row lines: a short cell with tall lines starts the next page where the tall cell\'s rest begins', () => {
  // A: ten 20 px lines; B: two 30 px lines. Cut after 30: A goes on from 20, B from 30; A's rest (180) is the tallest.
  const L = rowLines([{ lines: lines(10), end: 200 }, { lines: lines(2, 30), end: 60 }], 200, 3);
  const k = L.findIndex((l) => l.bottom === 30);
  assert.equal(L[k + 1].top, 20);
});

// planPages units: a paragraph, a table with a header row, a short row and a tall splitting row, then a paragraph.
const unit = (u, y, h) => ({ kind: 'block', section: 0, keepNext: false, keepLines: false, widow: false, breakBefore: false, table: null, header: false, ...u, ft: y, fb: y + h });
const size = () => ({ bodyH: 300, topOff: 0, botOff: 0, box: { h: 300 } });
const sectOf = () => ({});

function plan(tall, { cantSplit = false } = {}) {
  const rowL = rowLines([{ lines: lines(1), end: 20 }, { lines: lines(tall), end: tall * 20 }], tall * 20, 3);
  const units = [
    unit({ kind: 'text' }, 0, 200),
    unit({ table: 1, header: true }, 200, 20),
    unit({ table: 1 }, 220, 20),
    unit({ kind: cantSplit ? 'block' : 'text', table: 1, row: true }, 240, tall * 20),
    unit({ kind: 'text' }, 240 + tall * 20, 20),
  ];
  const flow = (j) => (j === 3 ? rowL.map((l) => ({ top: 240 + l.top, bottom: 240 + l.bottom })) : [{ top: units[j].ft, bottom: units[j].fb }]);
  return planPages({ units, linesOf: flow, sectOf, size });
}

test('planner: a row that does not fit splits at a line, the header repeats and the rest starts the next page', () => {
  const p = plan(10);
  // Page 1 holds 300 px: the row's first 3 lines (240 to 300) stay.
  assert.deepEqual(p[0].cut, { unit: 3, line: 3, flow: 300, forced: false });
  assert.equal(p[0].lastBottom, 300);
  assert.equal(p[1].header, 1);
  assert.equal(p[1].push, 20);
  assert.equal(p[1].F, 300);
  assert.equal(p[1].firstUnit, 3);
  assert.equal(p[1].firstLine, 3);
  // The rest (140 px) and the paragraph after fit page 2 under the header.
  assert.equal(p[1].cut, null);
});

test('planner: a cantSplit row moves whole, the header repeating above it', () => {
  const p = plan(10, { cantSplit: true });
  assert.deepEqual(p[0].cut, { unit: 3, line: 0, flow: 240, forced: false });
  assert.equal(p[1].header, 1);
  assert.equal(p[1].F, 240);
});

test('planner: a row taller than a page splits on every page it crosses', () => {
  const p = plan(40);
  assert.deepEqual(p.map((q) => q.firstLine), [0, 3, 17, 31]);
  assert.ok(p.every((q) => q.cut === null || q.cut.unit === 3 || q.cut.unit === 4));
});

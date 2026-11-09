// page-chunking (docs/plans/word/briefs/page-chunking.md): where each page's sheet goes after the page above it as drawn, whole-pixel
// vertical alignment, and the page ends a layout that keeps changing keeps (planPages pins).
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeAfter, planPages, vAlignShift } from '../src/document/wp/page-engine/layout.mjs';

const page = (bodyTop, extra = {}) => ({ bodyTop, bodyH: 900, topOff: 96, botOff: 96, over: 0, ...extra });
const opts = { gap: 16, thin: 6, slack: 3 };

test('a page starts the gap below the paper above when that page end was drawn on its paper', () => {
  const a = page(0);
  // The breaker starts at the body's last line plus the slack: the next paper follows a's paper (996) after the 16 px gap.
  assert.deepEqual(placeAfter(a, page(0), 903, opts), { bodyTop: 996 + 16 + 96, cover: 0 });
  // A breaker that starts inside a's bottom margin changes nothing either.
  assert.deepEqual(placeAfter(a, page(0), 990, opts), { bodyTop: 1108, cover: 0 });
});

test('a page starts below text that ran past the paper above, and the cover hides the run-on', () => {
  // a's breaker was drawn 500 px past its paper (996): a line taller than the page, a misjudged page end or a forced break after it.
  const q = placeAfter(page(0), page(0), 996 + 500, opts);
  assert.equal(q.bodyTop, 996 + 16 + 500 + 96);
  assert.equal(q.cover, 516); // from a's paper bottom to b's paper top
});

test('a page end not drawn yet follows the plan: its overflow, as stackPages counts it', () => {
  const q = placeAfter(page(100, { over: 250 }), page(0), null, opts);
  assert.equal(q.bodyTop, 100 + 900 + 96 + 16 + 250 + 96);
  assert.equal(q.cover, 266);
});

test('with white space hidden pages follow the body, a thin line apart', () => {
  // A full page's breaker starts BIAS below its last line, past the body: the next page moves by that much, with no cover.
  assert.deepEqual(placeAfter(page(0), page(0), 903, { ...opts, hidden: true }), { bodyTop: 909, cover: 0 });
  const q = placeAfter(page(0), page(0), 1000, { ...opts, hidden: true });
  assert.equal(q.bodyTop, 900 + 6 + 100);
  assert.equal(q.cover, 106);
});

test('vertical alignment shifts the text by whole pixels', () => {
  assert.deepEqual(vAlignShift('center', 101, 2), { top: 50, gap: 0 });
  assert.deepEqual(vAlignShift('bottom', 100.7, 2), { top: 100, gap: 0 });
  assert.deepEqual(vAlignShift('both', 90, 3), { top: 0, gap: 30 }); // Justified's gaps are translates: left as they are
});

// Text units of `lines` lines of 20 px each, laid out in one flow.
const flow = (counts) => {
  let y = 0;
  return counts.map((lines) => {
    const L = Array.from({ length: lines }, (_, i) => ({ top: y + i * 20, bottom: y + (i + 1) * 20 }));
    const u = { kind: 'text', section: 0, keepNext: false, keepLines: false, widow: false, breakBefore: false, table: null, header: false, ft: y, fb: y + lines * 20, L };
    y += lines * 20;
    return u;
  });
};
const run = (units, pins = null) => planPages({ units, linesOf: (j) => units[j].L, sectOf: () => ({}), size: () => ({ bodyH: 100, topOff: 10, botOff: 10, box: {} }), pins });
const cuts = (pages) => pages.map((p) => (p.cut ? `${p.cut.unit}.${p.cut.line}` : '-'));

test('a pinned page end stays where it was drawn, and the pages after it follow from there', () => {
  const units = flow([3, 3, 3, 3]);
  assert.deepEqual(cuts(run(units)), ['1.2', '3.1', '-']);
  // The page starting at unit 1 line 2 was drawn ending before unit 3: it keeps that end.
  const pages = run(units, new Map([['1.2', { unit: 3, line: 0, forced: false }]]));
  assert.deepEqual(cuts(pages), ['1.2', '3.0', '-']);
  assert.equal(pages[1].lastBottom, 180); // unit 2 ends at 180
  // A pin past a page break, or not after the page's start, is left out.
  assert.deepEqual(cuts(run(units, new Map([['0.0', { unit: 0, line: 0 }]]))), ['1.2', '3.1', '-']);
});

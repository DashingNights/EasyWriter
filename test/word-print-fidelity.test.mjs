// print-fidelity (docs/plans/word/briefs/print-fidelity.md): content taller than a page holds a page of its own and the next page
// starts below it (planPages over, stackPages), and line boxes come from the block's own box, so a line far taller than its
// neighbours keeps its own leading (lineBoxes with a content box and page ends).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSect } from '../src/document/defaults.mjs';
import { withDefaults } from '../src/document/model/sections.mjs';
import { lineBoxes, planPages, stackPages } from '../src/document/wp/page-engine/layout.mjs';

const A4 = withDefaults(defaultSect('a4'));
const base = { kind: 'text', section: 0, keepNext: false, keepLines: false, widow: true, breakBefore: false, table: null, header: false };
/** planPages over text units of given line heights (px), stacked from 0; pages hold `bodyH` px. */
const plan = (paras, bodyH = 100) => {
  let y = 0;
  const units = paras.map((hs) => {
    const L = hs.map((h) => ({ top: y, bottom: (y += h) }));
    return { ...base, ft: L[0].top, fb: y, L };
  });
  const pages = planPages({ units, linesOf: (j) => units[j].L, sectOf: () => A4, size: () => ({ bodyH, topOff: 10, botOff: 10, box: {} }) });
  return stackPages(pages, { gap: 16 });
};

test('a line taller than the page holds a page alone and the next page starts below it', () => {
  // A label line, then a paragraph whose second line is 250 px on 100 px pages: widow control takes the label line along to a
  // new page, the tall line gets the page after, and the next paragraph starts on a third.
  const pages = plan([[20, 20], [20, 250], [20]]);
  assert.deepEqual(pages.map((p) => [p.firstUnit, p.firstLine]), [[0, 0], [1, 0], [1, 1], [2, 0]]);
  assert.deepEqual(pages.map((p) => p.over), [0, 0, 150, 0]);
  // Each body follows the one before after its bottom margin, the gap and its own top margin, and after its overflow.
  assert.deepEqual(pages.map((p) => p.bodyTop), [0, 136, 272, 272 + 100 + 150 + 36]);
});

test('a block taller than the page runs past its body by the rest', () => {
  const pages = plan([[20], [], [20]].map((hs, i) => (i === 1 ? [300] : hs)));
  const tall = pages.find((p) => p.firstUnit === 1);
  assert.equal(tall.over, 200);
  assert.equal(pages.at(-1).bodyTop - tall.bodyTop, 100 + 200 + 36);
});

test('line boxes stack from the content box: a tall line keeps its own leading', () => {
  // An 11 pt label line (glyphs 19 px, line 22.6 px) over a 1,638 pt letter (glyphs 2,666 px, line 3,086 px), one page.
  const rects = [{ top: 1.8, bottom: 20.8, left: 0, right: 300 }, { top: 22.6 + 210, bottom: 22.6 + 210 + 2666, left: 0, right: 1264 }];
  const [a, b] = lineBoxes(rects, { top: 0, bottom: 22.6 + 3086 });
  assert.equal(a.top, 0);
  assert.ok(Math.abs(a.bottom - 22.3) < 0.5, `the label line ends near its own leading, not half the gap: ${a.bottom}`);
  assert.equal(b.top, a.bottom);
  assert.equal(b.bottom, 22.6 + 3086);
  // Even lines split their gaps evenly, as the smallest-gap rule did.
  const even = lineBoxes([{ top: 2, bottom: 18 }, { top: 22, bottom: 38 }, { top: 42, bottom: 58 }], { top: 0, bottom: 60 });
  assert.deepEqual(even, [{ top: 0, bottom: 20 }, { top: 20, bottom: 40 }, { top: 40, bottom: 60 }]);
});

test('line boxes part at a page end: the next line starts at the next page top', () => {
  // Line 1 on page 1 (glyphs 2..18), page 2's text starts at 200, line 2's glyphs at 202..218.
  const [a, b] = lineBoxes([{ top: 2, bottom: 18 }, { top: 202, bottom: 218 }], { top: 0, bottom: 220 }, [200]);
  assert.deepEqual(a, { top: 0, bottom: 20 });
  assert.deepEqual(b, { top: 200, bottom: 220 });
  // A block whose first line moved to the next page starts there.
  assert.deepEqual(lineBoxes([{ top: 202, bottom: 218 }], { top: 0, bottom: 220 }, [200]), [{ top: 200, bottom: 220 }]);
});

test('text lowered further than its line is tall stays on its line', () => {
  // A label, then a run lowered by 2,000 px to its right: one line from the content top to the content bottom.
  const lines = lineBoxes([{ top: 2, bottom: 20, left: 0, right: 500 }, { top: 2020, bottom: 2040, left: 505, right: 560 }], { top: 0, bottom: 2045 });
  assert.deepEqual(lines, [{ top: 0, bottom: 2045 }]);
  // Two ordinary lines with a wide gap (132 lines' spacing) stay two: the second starts back at the left.
  assert.equal(lineBoxes([{ top: 1000, bottom: 1020, left: 0, right: 500 }, { top: 3000, bottom: 3020, left: 0, right: 200 }], { top: 0, bottom: 4020 }).length, 2);
});

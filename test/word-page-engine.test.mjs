// Pagination engine 2's pure layout (src/document/wp/page-engine/layout.mjs): section starts, numbers, labels and parts, body
// boxes from reservations, the keep rules at a cut, vertical alignment and the flow planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSect } from '../src/document/defaults.mjs';
import { pageLabel } from '../src/document/geometry.mjs';
import { withDefaults } from '../src/document/model/sections.mjs';
import { bodyOf, chainStart, collapse, fitCount, frameAt, groupLines, lineBoxes, needsBlank, numberOf, pageInfo, paperOf, partOf, planPages, stackPages, startOf,
  toFlow, vAlignShift } from '../src/document/wp/page-engine/layout.mjs';

const A4 = withDefaults(defaultSect('a4'));
const A4L = { ...A4, w: A4.h, h: A4.w, orient: 'landscape' };
const LETTER = withDefaults(defaultSect('letter'));

test('section starts: next page, continuous on the same or a new size, even and odd, next column in one column', () => {
  assert.equal(startOf('nextPage', A4, A4), 'page');
  assert.equal(startOf('continuous', A4, A4), 'none');
  assert.equal(startOf('continuous', A4, A4L), 'page');
  assert.equal(startOf('continuous', A4, LETTER), 'page');
  assert.equal(startOf('evenPage', A4, A4), 'even');
  assert.equal(startOf('oddPage', A4, A4), 'odd');
  assert.equal(startOf('nextColumn', A4, A4), 'page');
});

test('blank pages by number parity, after a restart too', () => {
  assert.equal(needsBlank('odd', 2), true);
  assert.equal(needsBlank('odd', 3), false);
  assert.equal(needsBlank('even', 3), true);
  assert.equal(needsBlank('even', 4), false);
  const restart = { ...A4, pgNum: { ...A4.pgNum, start: 1 } };
  assert.equal(numberOf(5, restart, true), 1);
  assert.equal(needsBlank('odd', numberOf(5, restart, true)), false);
  assert.equal(numberOf(5, A4, true), 6);
  assert.equal(numberOf(5, restart, false), 6);
});

test('page numbers, labels and parts', () => {
  assert.deepEqual(['decimal', 'numberInDash', 'lowerRoman', 'upperRoman', 'lowerLetter', 'upperLetter'].map((f) => pageLabel(4, f)),
    ['4', '- 4 -', 'iv', 'IV', 'd', 'D']);
  assert.equal(pageLabel(27, 'lowerLetter'), 'aa');
  const titled = { ...A4, titlePg: true };
  assert.equal(partOf(titled, true, 1, true), 'first');
  assert.equal(partOf(titled, false, 2, true), 'even');
  assert.equal(partOf(titled, false, 3, true), 'odd');
  assert.equal(partOf(A4, false, 2, false), 'odd');
  assert.deepEqual(pageInfo(null, { ...A4, pgNum: { fmt: 'upperRoman', start: 3 } }, true, false), { number: 3, label: 'III', part: 'odd' });
});

test('paper: gutter on the left or the top, mirror margins swap on even pages', () => {
  const s = { ...A4, margin: { ...A4.margin, left: 90, right: 54, gutter: 18 } };
  const odd = paperOf(s, { mirror: true, number: 1 });
  const even = paperOf(s, { mirror: true, number: 2 });
  assert.equal(odd.left, 144);
  assert.equal(even.left, 72);
  assert.equal(even.right, 144);
  const top = paperOf(s, { gutterAtTop: true });
  assert.equal(top.top, 96 + 24);
  assert.equal(top.left, 120);
});

test('body boxes from reservations: the larger of margin and reserve, notes below; a negative margin ignores its side', () => {
  const box = paperOf(A4);
  const b = bodyOf(box, [{ top: 150 }, { top: 120, bottom: 40 }, { below: 30 }, { below: 10 }]);
  assert.equal(b.topOff, 150);
  assert.equal(b.botOff, 96 + 40);
  assert.ok(Math.abs(b.height - (box.h - 150 - 136)) < 1e-9);
  const neg = paperOf({ ...A4, margin: { ...A4.margin, top: -72 } });
  assert.equal(neg.top, 96);
  assert.equal(bodyOf(neg, [{ top: 300 }]).topOff, 96);
});

test('cut decisions: 1 to 4 lines left with widow control on and off, keepLines, a paragraph at the page top', () => {
  // n = 4 lines, fit lines on this page
  assert.deepEqual([0, 1, 2, 3].map((fit) => fitCount(4, fit)), [0, 0, 2, 2]);
  assert.deepEqual([0, 1, 2, 3].map((fit) => fitCount(4, fit, { widow: false })), [0, 1, 2, 3]);
  assert.equal(fitCount(3, 2), 0); // a 3-line paragraph that would split moves whole
  assert.equal(fitCount(3, 1), 0);
  assert.equal(fitCount(2, 1), 0);
  assert.equal(fitCount(6, 3, { keepLines: true }), 0);
  assert.equal(fitCount(6, 5, { atTop: true }), 4); // at a page top it cannot move: keeps two for the next page
  assert.equal(fitCount(6, 0, { atTop: true }), 1);
  assert.equal(fitCount(3, 3), 3);
});

test('keep with next chains; a chain longer than a page breaks at the block anyway', () => {
  const keep = [false, false, true, true, false];
  assert.equal(chainStart(keep, 4, 0), 2);
  assert.equal(chainStart([true, true, true, false], 3, 0), 3);
  assert.equal(chainStart(keep, 1, 0), 1);
});

test('vertical alignment offsets for top, center, bottom and both', () => {
  assert.deepEqual(vAlignShift('top', 100, 3), { top: 0, gap: 0 });
  assert.deepEqual(vAlignShift('center', 100, 3), { top: 50, gap: 0 });
  assert.deepEqual(vAlignShift('bottom', 100, 3), { top: 100, gap: 0 });
  assert.deepEqual(vAlignShift('both', 90, 3), { top: 0, gap: 30 });
});

test('margins collapse, lines group, frames map layout to flow', () => {
  assert.equal(collapse(10, 20), 20);
  assert.equal(collapse(10, -4), 6);
  assert.equal(collapse(-3, -8), -8);
  assert.deepEqual(groupLines([{ top: 20, bottom: 40 }, { top: 0, bottom: 20 }, { top: 2, bottom: 18 }, { top: 0, bottom: 0 }]),
    [{ top: 0, bottom: 20 }, { top: 20, bottom: 40 }]);
  // Glyphs of neighbouring lines overlapping by 1.5 px stay two lines.
  assert.equal(groupLines([{ top: 0, bottom: 20 }, { top: 18.5, bottom: 38.5 }]).length, 2);
  // Line boxes add half the smallest gap between glyph lines: a raised mark on a line ends above its line box's bottom.
  assert.deepEqual(lineBoxes([{ top: 0, bottom: 16 }, { top: 20, bottom: 36 }, { top: 21, bottom: 30 }]), [{ top: -2, bottom: 18 }, { top: 18, bottom: 38 }]);
  const frames = [{ contentTop: 0, F: 0 }, { contentTop: 1000, F: 800 }];
  assert.equal(frameAt(frames, 900), frames[0]); // a box top in the dead zone maps through the page above
  assert.equal(toFlow(frames, 790), 790);
  assert.equal(toFlow(frames, 1010), 810);
});

// A flow of units for planPages: each text unit's lines are 20 px; pages hold `bodyH` px.
const plan = (units, { bodyH = 100, sects = [A4], linesPer, notes = null } = {}) => {
  let y = 0;
  const us = units.map((u) => {
    const lines = u.kind === 'text' || !u.kind ? u.lines ?? 1 : 0;
    const h = u.kind === 'break' ? 0 : u.h ?? lines * 20;
    const out = { kind: 'text', section: 0, keepNext: false, keepLines: false, widow: true, breakBefore: false, table: null, header: false, ...u, ft: y, fb: y + h };
    out.L = Array.from({ length: lines }, (_, i) => ({ top: y + i * 20, bottom: y + (i + 1) * 20 }));
    y += h;
    return out;
  });
  void linesPer;
  return planPages({ units: us, linesOf: (j) => us[j].L, sectOf: (i) => sects[i], size: () => ({ bodyH, topOff: 10, botOff: 10, box: {} }), notes });
};
const cuts = (pages) => pages.map((p) => (p.cut ? `${p.cut.unit}.${p.cut.line}` : '-'));

test('planner: lines fill pages; widow control moves a line along or the whole paragraph', () => {
  // 4 + 3 lines: page holds 5 lines. Without widow control the 3-line paragraph splits 1/2.
  assert.deepEqual(cuts(plan([{ lines: 4 }, { lines: 3, widow: false }])), ['1.1', '-']);
  // With it a 3-line paragraph that would split moves whole.
  assert.deepEqual(cuts(plan([{ lines: 4 }, { lines: 3 }])), ['1.0', '-']);
  // 3 + 3 lines: the second would leave one line on the next page: it splits 1/2 → moves whole (orphan rule).
  assert.deepEqual(cuts(plan([{ lines: 3 }, { lines: 3 }])), ['1.0', '-']);
  // 2 + 4 lines: 3 of 4 fit, a widow would follow: two go along.
  assert.deepEqual(cuts(plan([{ lines: 2 }, { lines: 4 }])), ['1.2', '-']);
  // A paragraph longer than a page splits at each page end.
  assert.deepEqual(cuts(plan([{ lines: 12 }])), ['0.5', '0.10', '-']);
});

test('planner: footnotes stay with their reference lines; a line goes on with its note when not even its first line fits', () => {
  const one = (y, h = 20, first = 20) => ({ sep: 5, list: [{ y, h, first }] });
  // 10 one-line paragraphs, pages of 5 lines. A note (20 + 5 separator) referenced on line 2 leaves room for 3 lines and itself.
  const ten = Array.from({ length: 10 }, () => ({ lines: 1, widow: false }));
  assert.deepEqual(cuts(plan(ten, { notes: one(30) })), ['3.0', '8.0', '-']);
  // Referenced on line 5: the line and its note do not fit, so the line goes to page 2 with it (and stays there: no flip).
  assert.deepEqual(cuts(plan(ten, { notes: one(90) })), ['4.0', '7.0', '-']);
  // A tall note whose first line fits under its line 4 stays on page 1 with its line; the rest carries to page 2's foot.
  assert.deepEqual(cuts(plan(ten, { notes: one(70, 60, 10) })), ['4.0', '6.0', '-']);
  // No notes: unchanged.
  assert.deepEqual(cuts(plan(ten)), ['5.0', '-']);
});

test('planner: keepNext chains move together, a chain longer than a page breaks anyway; keepLines; pageBreakBefore; breaks', () => {
  assert.deepEqual(cuts(plan([{ lines: 3 }, { lines: 1, keepNext: true }, { lines: 3 }])), ['1.0', '-']);
  assert.deepEqual(cuts(plan([{ lines: 1, keepNext: true }, { lines: 1, keepNext: true }, { lines: 1, keepNext: true }, { lines: 1, keepNext: true },
    { lines: 1, keepNext: true }, { lines: 1 }])), ['5.0', '-']);
  assert.deepEqual(cuts(plan([{ lines: 2 }, { lines: 4, keepLines: true }])), ['1.0', '-']);
  assert.deepEqual(cuts(plan([{ lines: 1 }, { lines: 1, breakBefore: true }])), ['1.0', '-']);
  const p = plan([{ lines: 1 }, { kind: 'break', start: 'page', section: 0 }, { lines: 1 }]);
  assert.deepEqual(cuts(p), ['1.0', '-']);
  assert.equal(p[0].cut.forced, true);
  // A page break inside a section with a numbering restart and a first-page header: page 2 counts on and takes the odd part.
  const t = plan([{ lines: 1 }, { kind: 'break', start: 'page', section: 0 }, { lines: 1 }], { sects: [{ ...A4, titlePg: true, pgNum: { ...A4.pgNum, start: 5 } }] });
  assert.deepEqual(t.map((x) => [x.number, partOf({ titlePg: true }, x.first, x.number, false)]), [[5, 'first'], [6, 'odd']]);
});

test('planner: an odd page start from page 1 adds a blank page counted in the numbers; a restart after it', () => {
  const p = plan([{ lines: 1 }, { kind: 'break', start: 'odd', section: 1 }, { lines: 1, section: 1 }], { sects: [A4, A4] });
  assert.deepEqual(p.map((x) => [x.number, x.blank, x.section]), [[1, false, 0], [2, true, 1], [3, false, 1]]);
  const r = plan([{ lines: 1 }, { kind: 'break', start: 'odd', section: 1 }, { lines: 1, section: 1 }],
    { sects: [A4, { ...A4, pgNum: { ...A4.pgNum, start: 1 } }] });
  assert.deepEqual(r.map((x) => [x.number, x.blank]), [[1, false], [1, false]]);
  const e = plan([{ lines: 1 }, { kind: 'break', start: 'even', section: 1 }, { lines: 1, section: 1 }], { sects: [A4, A4] });
  assert.deepEqual(e.map((x) => x.blank), [false, false]);
});

test('planner: a continuous section begun mid-page counts on past its page; one that starts a page restarts there', () => {
  // Section 1 starts after 2 lines of page 1 (a continuous break), restarts at 5 with a first-page header, and overflows.
  const sects = [A4, { ...A4, titlePg: true, pgNum: { ...A4.pgNum, start: 5 } }];
  const parts = (pages) => pages.map((x) => [x.section, x.number, partOf(sects[x.section], x.first, x.number, false)]);
  assert.deepEqual(parts(plan([{ lines: 2 }, { lines: 6, section: 1, widow: false }], { sects })), [[0, 1, 'odd'], [1, 2, 'odd']]);
  // The same section starting at the top of page 2 opens it: the restart and the first-page part apply there.
  assert.deepEqual(parts(plan([{ lines: 5 }, { lines: 2, section: 1 }], { sects })), [[0, 1, 'odd'], [1, 5, 'first']]);
});

test('planner: header rows repeat on the next page and take its room; vertical alignment of a page that ends early', () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ kind: 'block', h: 20, table: 1, header: i === 0 }));
  const p = plan(rows);
  assert.equal(p[0].header, null);
  assert.equal(p[1].header, 1);
  assert.equal(p[1].push, 20);
  assert.deepEqual(cuts(p), ['5.0', '-']);
  const c = plan([{ lines: 1 }], { sects: [{ ...A4, vAlign: 'center' }] });
  assert.equal(c[0].vShift, 40);
  const full = plan([{ lines: 7 }], { sects: [{ ...A4, vAlign: 'bottom' }] });
  assert.equal(full[0].vShift, 0); // a full page stays
  assert.equal(full[1].vShift, 60); // the last page ends early
  // Justified: 3 one-line blocks on a 100 px body leave 40 px over 2 gaps; the block rows of one table count once.
  const both = plan([{ lines: 1, child: 0 }, { lines: 1, child: 1 }, { kind: 'block', h: 10, child: 2 }, { kind: 'block', h: 10, child: 2 }],
    { sects: [{ ...A4, vAlign: 'both' }] });
  assert.equal(both[0].vShift, 0);
  assert.equal(both[0].vGap, 20);
  assert.equal(plan([{ lines: 7 }], { sects: [{ ...A4, vAlign: 'both' }] })[0].vGap, 0); // a page ending inside a block stays
});

test('stacking: pages follow each other with margins and the gap, or a thin line with white space hidden; blank pages take no room', () => {
  const pages = [{ bodyH: 100, topOff: 10, botOff: 20 }, { blank: true, bodyH: 100, topOff: 10, botOff: 20 }, { bodyH: 50, topOff: 30, botOff: 20 }];
  stackPages(pages, { gap: 16 });
  assert.deepEqual(pages.map((p) => p.bodyTop), [0, 166, 166]);
  assert.equal(pages[2].top, 136);
  stackPages(pages, { hidden: true, thin: 6 });
  assert.equal(pages[2].bodyTop, 106);
});

// Page geometry, the pure part (docs/plans/word/plan.md §1.9): page labels, the page box of a sect, the PageBox and SectionBox
// lists both engines publish, the frame's loop guard and the per-page layer key comparison. No DOM: pagination.js measures and
// geometry.js reads the plugin state; node tests load this file.
import { ptToPx } from '../office.mjs';
import { sectionAt } from './model/sections.mjs';
import { GAP, pageAt } from './pages.mjs';

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

const roman = (n) => {
  let s = '';
  for (const [v, r] of ROMAN) for (; n >= v; n -= v) s += r;
  return s;
};

/** Page number `n` formatted by `fmt` (sect.pgNum.fmt): 'decimal', 'numberInDash' ('- 3 -'), 'lowerLetter' and 'upperLetter'
 * (Word repeats the letter past z: 27 is 'aa', 53 'aaa'), 'lowerRoman' and 'upperRoman'. Numbers below 1 and unknown formats
 * show as decimal. */
export function pageLabel(n, fmt = 'decimal') {
  if (n < 1 || !Number.isInteger(n)) return String(n);
  switch (fmt) {
    case 'numberInDash': return `- ${n} -`;
    case 'lowerLetter': return String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.ceil(n / 26));
    case 'upperLetter': return String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.ceil(n / 26));
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    default: return String(n);
  }
}

/** The page of `sect` in px: paper w and h, margins, header and footer distances, gutter, the text width and body height, and the
 * breaker between two pages (bottom margin, the gap, the next top margin). */
export function pageBox(sect) {
  const m = sect.margin ?? {};
  const px = Object.fromEntries(['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'].map((k) => [k, ptToPx(m[k] ?? 0)]));
  const w = ptToPx(sect.w);
  const h = ptToPx(sect.h);
  return { w, h, ...px, text: w - px.left - px.right, body: h - px.top - px.bottom, breaker: px.bottom + GAP + px.top };
}

/** The last index i with `sorted[i] <= v` (0 when none). */
export function indexAt(sorted, v) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sorted[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The 0-based page of `pos` from `blocks` (each top-level block's page) and `starts` (their positions). */
export const pageOfPos = (blocks, starts, pos) => (blocks.length ? blocks[indexAt(starts, pos)] : 0);

/** Engine 1's geometry from a measure: `segments` the runs, `box` the one page box, `starts` and `tops` each top-level block's
 * position and layout y, `size` the doc's content size, `sections` sectionsOf(doc), `evenAndOdd` the doc setting. Pages count
 * whole top-level blocks by their first line → {pages: PageBox[], sections: SectionBox[], blocks, starts}. */
export function buildPages({ segments, box, starts, tops, size, sections, evenAndOdd = false }) {
  const step = box.body + box.breaker;
  const blocks = tops.map((y) => pageAt(y, segments, step, box.body));
  const count = segments.reduce((a, s) => a + s.pages, 0);
  // from: where the first block whose first line is on or after the page starts; to: the next page's from.
  const from = new Array(count + 1).fill(size);
  for (let i = 0, p = 0; i < blocks.length; i++) while (p <= blocks[i] && p <= count) from[p++] = starts[i];
  from[0] = 0;
  const pages = [];
  let index = 0;
  for (const s of segments) {
    for (let k = 0; k < s.pages; k++, index++) {
      const sec = sectionAt(sections, from[index]);
      const prev = pages.at(-1);
      const inSection = prev && prev.section === sec.index ? prev.inSection + 1 : 0;
      const start = sec.sect.pgNum?.start ?? (index === 0 ? sec.sect.pageNumber?.start : null);
      const number = inSection === 0 && start != null ? start : (prev ? prev.number + 1 : 1);
      const bodyTop = s.top + k * step;
      pages.push({
        index, from: from[index], to: Math.max(from[index], from[index + 1]), section: sec.index, inSection, number,
        label: pageLabel(number, sec.sect.pgNum?.fmt),
        part: sec.sect.titlePg && inSection === 0 ? 'first' : evenAndOdd && number % 2 === 0 ? 'even' : 'odd',
        blank: false, top: bodyTop - box.top, bodyTop, bodyHeight: box.body, box,
      });
    }
  }
  // A section runs until the next one starts: to the page before when the next starts a page, else onto that shared page; the
  // last runs to the last page, so the pages a long final block runs onto count too.
  const firsts = sections.map((s) => pageOfPos(blocks, starts, s.from));
  const sectionBoxes = sections.map((s, j) => {
    const firstPage = firsts[j];
    const next = sections[j + 1];
    const last = !next ? pages.length - 1 : Math.max(firstPage, firsts[j + 1] - (pages[firsts[j + 1]]?.from === next.from ? 1 : 0));
    return { index: s.index, from: s.from, to: s.to, sect: s.sect, firstPage, pages: last - firstPage + 1, cols: null };
  });
  return { pages, sections: sectionBoxes, blocks, starts };
}

/** One pagination frame under the loop guard: the 'before' passes until none reports a change, the measure, then the 'after'
 * passes, measuring again while they report one; at most `limit` repeats in all, then the last layout stays.
 * → {rounds, capped} (capped: the guard stopped a pass that kept reporting changes). */
export function runFrame({ before, measure, after }, limit = 3) {
  let rounds = 0;
  let capped = false;
  const more = () => {
    if (++rounds < limit) return true;
    capped = true;
    return false;
  };
  do {
    while (before() && more());
  } while ((measure(), !capped) && after() && more());
  return { rounds, capped };
}

/** The layer drawings that must change: per page, each layer's key(state, page) against the key last drawn, kept in `keysOf(i)`
 * (a Map layer id → key per page, which this updates) → [{i, layer, key}] in page order. */
export function layerWork(layers, pages, state, keysOf) {
  const out = [];
  pages.forEach((page, i) => {
    const keys = keysOf(i);
    if (!keys) return;
    for (const layer of layers) {
      const key = String(layer.key(state, page));
      if (keys.get(layer.id) === key) continue;
      keys.set(layer.id, key);
      out.push({ i, layer, key });
    }
  });
  return out;
}

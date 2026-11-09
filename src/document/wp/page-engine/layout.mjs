// Pagination engine 2, the pure part (docs/plans/word/plan.md §1.9 Engine 2, briefs/page-engine.md): a section's paper with
// gutter and mirror margins, the text body a page keeps after the layers' reservations, how a section starts, page numbers and
// header parts, the keep rules (widow and orphan control, keep with next, keep lines together) as line counts at a page end,
// and vertical alignment. No DOM: pagination.js measures and calls these; node tests load this file.
import { pageBox, pageLabel } from '../../geometry.mjs';
import { styleChain, styleIdOf } from '../../model/styles.mjs';
import { effectivePara } from '../paragraph/rules.mjs';

/** The paper of `sect` in px for page `number`: pageBox plus Word's gutter (on the left margin, or the top with `gutterAtTop`)
 * and mirror margins (left is the inside margin: on even pages the left and right swap). A negative top or bottom margin is
 * kept at its absolute value and flagged (topNeg, bottomNeg): the header or footer then overlaps the body instead of pushing it
 * (index-layout.md 152). */
export function paperOf(sect, { mirror = false, gutterAtTop = false, number = 1 } = {}) {
  const b = pageBox(sect);
  let { left, right } = b;
  const topNeg = b.top < 0;
  const bottomNeg = b.bottom < 0;
  let top = Math.abs(b.top);
  const bottom = Math.abs(b.bottom);
  if (gutterAtTop) top += b.gutter;
  else left += b.gutter;
  if (mirror && number % 2 === 0) [left, right] = [right, left];
  return { ...b, top, bottom, left, right, topNeg, bottomNeg, text: b.w - left - right, body: b.h - top - bottom, breaker: 0 };
}

const r2 = (v) => Math.round(v * 100) / 100;

/** Each section's text width against the editor's one text column (px, from the page setup alone): the column is the last
 * section's text width (doc.attrs.sect, which the page takes outside paged views too), and shifts[i] is how much narrower
 * section i's text is (negative: wider), 0 where it matches. Mirror margins swap sides and never change a width. `sects` are
 * sectionsOf's sects (defaults filled), `settings` the doc's settings (gutterAtTop). → {column, shifts}. */
export function sectionShifts(sects, settings) {
  const widths = sects.map((s) => r2(paperOf(s, { gutterAtTop: !!settings?.gutterAtTop }).text));
  const column = widths.at(-1) ?? 0;
  return { column, shifts: widths.map((w) => r2(column - w)) };
}

/** Each section's text height (px) from the page plan `pages` ([{section, bodyH, blank}]) of a document of `n` sections: the
 * least body of its pages, as a header taller than its margin takes from one. A section with no page of its own (one begun
 * mid-page) sits on the page of the section before it. An object fits the page of its own section (document.css --pg-body):
 * the least body of the whole document shrank every picture to a 1 pt text area of one section. → px per section, or null. */
export function sectionBodies(pages, n) {
  const out = Array.from({ length: n }, () => null);
  for (const p of pages) if (!p.blank && out[p.section] !== undefined) out[p.section] = r2(Math.min(out[p.section] ?? Infinity, p.bodyH));
  for (let s = 1; s < n; s++) out[s] ??= out[s - 1];
  return out;
}

/** The text body of a page on paper `box` after the layers' reservations `res` ([{top?, bottom?, below?}]): the body starts at
 * max(margin, every reserve.top) below the paper top and ends max(margin, every reserve.bottom) plus the sum of reserve.below
 * above the paper bottom (index-layout.md 199). A negative margin ignores the reservations on its side.
 * → {topOff, botOff, height} in px. */
export function bodyOf(box, res = []) {
  const most = (k) => Math.max(0, ...res.map((r) => Number(r?.[k]) || 0));
  const below = res.reduce((a, r) => a + (Number(r?.below) || 0), 0);
  const topOff = box.topNeg ? box.top : Math.max(box.top, most('top'));
  const botOff = (box.bottomNeg ? box.bottom : Math.max(box.bottom, most('bottom'))) + below;
  return { topOff, botOff, height: Math.max(1, box.h - topOff - botOff) };
}

const size = (s) => `${s.w}x${s.h}x${s.orient}`;

/** How a section starts after a break of `kind` ('nextPage', 'continuous', 'evenPage', 'oddPage', 'nextColumn') from section
 * `prev` to `sect`: 'none' (the same page), 'page', 'even' or 'odd' (the next page with that number, a blank page between when
 * needed). A continuous break to another paper size or orientation starts a page; New Column acts as Next Page in one column.
 * The kind of the break before a section decides how it starts (plan.md §1.8). */
export function startOf(kind, prev, sect) {
  if (kind === 'continuous') return prev && sect && size(prev) !== size(sect) ? 'page' : 'none';
  if (kind === 'evenPage') return 'even';
  if (kind === 'oddPage') return 'odd';
  return 'page';
}

/** The number of a page: `sect.pgNum.start` on its section's first page (`first`) when set, else the previous page's number
 * `prev` + 1 (blank pages count). `v1Start` is the v1 sect.pageNumber.start, honoured on the document's first page. */
export function numberOf(prev, sect, first, v1Start = null) {
  const start = sect?.pgNum?.start ?? (prev == null ? v1Start : null);
  return first && start != null ? start : (prev ?? 0) + 1;
}

/** Whether a section starting on an `start` page ('even' or 'odd') needs a blank page before a first page numbered `number`. */
export const needsBlank = (start, number) => (start === 'even' && number % 2 !== 0) || (start === 'odd' && number % 2 === 0);

/** The header and footer part of a page: 'first' on its section's first page with titlePg, 'even' on even numbers with the
 * document's evenAndOddHeaders (Word goes by the page number), else 'odd'. */
export const partOf = (sect, first, number, evenAndOdd) => (sect?.titlePg && first ? 'first' : evenAndOdd && number % 2 === 0 ? 'even' : 'odd');

/** A page's number, label and part → {number, label, part}. */
export function pageInfo(prev, sect, first, evenAndOdd, v1Start = null) {
  const number = numberOf(prev, sect, first, v1Start);
  return { number, label: pageLabel(number, sect?.pgNum?.fmt), part: partOf(sect, first, number, evenAndOdd) };
}

/** How many of a paragraph's `n` lines stay on the page when `fit` of them fit (index-layout.md 138-145): keepLines moves it
 * whole; widow control never leaves one line alone at the next page's top (it takes one more along) nor one at this page's
 * bottom (the paragraph moves whole), so a 3-line paragraph that would split moves whole. A paragraph at the page's top
 * (`atTop`) cannot move: it splits where it must, keeping two lines for the next page with widow control. → lines kept (0 to n). */
export function fitCount(n, fit, { widow = true, keepLines = false, atTop = false } = {}) {
  if (fit >= n) return n;
  let m = Math.max(0, fit);
  if (atTop) {
    if (widow && n - m === 1 && m > 1) m--;
    return Math.max(1, m);
  }
  if (keepLines) return 0;
  if (!widow) return m;
  if (n - m === 1 && m > 0) m--;
  return m === 1 ? 0 : m;
}

/** Where a page ends when block `x` moves to the next page: before the start of the keep-with-next chain that leads to it
 * (`keep[i]` is block i's effective keepNext). A chain that reaches the page's first block `first` is longer than a page, so
 * the page breaks at `x` anyway (Word, v). → block index to break before. */
export function chainStart(keep, x, first) {
  let j = x;
  while (j > first && keep[j - 1]) j--;
  return j === first ? x : j;
}

/** Vertical alignment of a page that ends early (sect.vAlign, index-layout.md 161): `free` px between the text and the body's
 * bottom, `gaps` the number of paragraph gaps on the page. → {top: px the text moves down, gap: px added to each gap} ('both'
 * is Word's Justified). The shift is whole px: the room is read through offsetTop's whole pixels, so a fraction of it moved the
 * text by a fraction, which moved the room read next round, and a centred page crept round after round (the Word fixture's
 * section pages, page ends 124 to 127). Justified's gaps are translates, which the reads leave out. */
export function vAlignShift(vAlign, free, gaps = 0) {
  if (!(free > 0.5)) return { top: 0, gap: 0 };
  if (vAlign === 'center') return { top: Math.floor(free / 2), gap: 0 };
  if (vAlign === 'bottom') return { top: Math.floor(free), gap: 0 };
  if (vAlign === 'both' && gaps > 0) return { top: 0, gap: free / gaps };
  return { top: 0, gap: 0 };
}

const NONE = Object.freeze({ keepNext: false, keepLines: false, widow: true, breakBefore: false });
const props = new WeakMap(); // node → {styles, value}

/** The effective keep rules of top-level block `node` in `doc`: its own attribute, else the last style in its chain that sets
 * it (Heading 1 to 9 carry keepNext and keepLines); widowControl unset through the whole chain counts as on, as Word's Normal.
 * → {keepNext, keepLines, widow, breakBefore}. */
export function keepsOf(doc, node) {
  if (!node.isTextblock) return NONE;
  const styles = doc.attrs?.styles;
  const hit = props.get(node);
  if (hit && hit.styles === styles) return hit.value;
  const chain = styleChain(doc, styleIdOf(node));
  const pick = (k) => {
    if (node.attrs[k] != null) return node.attrs[k];
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].para?.[k] != null) return chain[i].para[k];
    return null;
  };
  // Word's built-in Heading 1 to 9 keep with next and keep lines together; a document without their definitions gets the same.
  const heading = /^Heading[1-9]$/.test(styleIdOf(node));
  // Multiple line spacing above single (Word's auto rule): planPages lets a page's last line run its extra leading into the margin.
  const line = effectivePara(doc, node).spacing?.line;
  const value = { keepNext: !!(pick('keepNext') ?? heading), keepLines: !!(pick('keepLines') ?? heading), widow: pick('widowControl') !== false,
    breakBefore: !!pick('pageBreakBefore'), multiple: line?.rule === 'auto' && line.value > 1 ? line.value : 1 };
  props.set(node, { styles, value });
  return value;
}

/** Whether a table row with attributes `attrs` splits at a page end (Word's "Allow row to break across pages", w:cantSplit off):
 * header rows and rows of an exact height move whole, as the layout predictor takes them too. */
export const rowSplits = (attrs) => !attrs?.cantSplit && !attrs?.header && attrs?.height?.rule !== 'exact';

/** The top margin Word gives every cell of a row: the largest of its cells' top margins `tops` (pt; a cell without its own takes
 * the table's). → that margin, or null when the cells have it already. */
export function rowTop(tops) {
  const max = Math.max(...tops);
  return tops.some((t) => t < max) ? max : null;
}

/** A splitting row's lines for planPages, from its cells: `cells` [{lines: [{top, bottom}], end}] in px from the row's top as laid
 * out with no page end, `end` the cell's foot (its last block's space after, its padding and border, which stay with its last
 * line); `h` the row's height. Word cuts a row at a line boundary in every cell: each cut keeps every cell's lines that end above
 * it, so the cuts are the cells' line ends (those closer than `slack` px merged into the lower one: a page end between them would
 * leave one of them on the wrong side of the breaker). On the next page each cell's rest starts at the text's top, so the row
 * there is as tall as its tallest rest and the next page's flow starts that far above the row's foot: line k's top is that start
 * after cut k - 1, which can lie above cut k - 1 itself. → [{top, bottom}] (the last line ends at the row's foot). */
export function rowLines(cells, h = 0, slack = 0) {
  const ends = cells.map((c) => c.lines.map((l, i, a) => (i === a.length - 1 ? Math.max(l.bottom, c.end ?? l.bottom) : l.bottom)));
  const foot = Math.max(h, ...ends.map((e) => e.at(-1) ?? 0));
  const cuts = [];
  for (const b of ends.flat().sort((x, y) => x - y)) {
    if (cuts.length && b - cuts.at(-1) <= slack) cuts[cuts.length - 1] = b;
    else cuts.push(b);
  }
  if (!cuts.length) return [{ top: 0, bottom: foot }];
  cuts[cuts.length - 1] = foot;
  const out = [];
  let top = 0;
  for (const b of cuts) {
    out.push({ top, bottom: b });
    let rest = 0;
    cells.forEach((c, i) => {
      const j = ends[i].findIndex((e) => e > b + 0.5);
      if (j >= 0) rest = Math.max(rest, ends[i].at(-1) - c.lines[j].top);
    });
    top = foot - rest;
  }
  return out;
}

/** Two adjoining vertical margins collapsed (CSS 2.1 §8.3.1): the largest positive plus the most negative. */
export const collapse = (a, b) => Math.max(0, a, b) + Math.min(0, a, b);

/** Line boxes from text rects ([{top, bottom}, with left and right when known], one coordinate space): rects whose vertical ranges
 * overlap by more than half the shorter one are one line (the glyphs of neighbouring lines may overlap by a pixel or two).
 * → [{top, bottom, left?, right?}] in order. */
export function groupLines(rects) {
  const out = [];
  for (const r of [...rects].filter((x) => x.bottom - x.top > 0).sort((a, b) => a.top - b.top)) {
    const last = out.at(-1);
    if (last && last.bottom - r.top > Math.min(r.bottom - r.top, last.bottom - last.top) / 2) {
      last.bottom = Math.max(last.bottom, r.bottom);
      if (r.left != null) [last.left, last.right] = [Math.min(last.left, r.left), Math.max(last.right, r.right)];
    } else out.push({ top: r.top, bottom: r.bottom, ...(r.left != null && { left: r.left, right: r.right }) });
  }
  return out;
}

/** A block's line boxes from its text rects (groupLines). Text rects hold the glyphs; a line box adds half the leading above and
 * below (negative when the glyphs are taller than the line). Neighbouring lines on one page show it as the gap between their rects,
 * an overlap when negative; the smallest such gap counts (a page end between two lines makes a much larger one).
 * With the block's content box `box` ({top, bottom}) and the page ends `breaks` (each page's content top after the first,
 * ascending), all in the rects' space, the boxes are the block's own: they stack from its content top to its content bottom, and only a
 * page end parts two of them (the line after it starts at the next page's content top). Two lines on one page split the gap
 * between their glyphs in proportion to the glyphs' heights, since the leading grows with the font size: a 1,638 pt letter has
 * 210 px above and below it where its 11 pt neighbour has 2, which the smallest gap gave both. A line before a page end has
 * the leading it has above its glyphs below them too. */
export function lineBoxes(rects, box = null, breaks = []) {
  let glyphs = groupLines(rects);
  if (!box) {
    const gaps = glyphs.slice(1).map((l, i) => l.top - glyphs[i].bottom).filter((g) => g < 12);
    const half = gaps.length ? Math.min(...gaps) / 2 : 0;
    return glyphs.map((l) => ({ top: l.top - half, bottom: l.bottom + half }));
  }
  // The content top of the last page that starts between a and b, or null. Glyphs can reach past their line box (a tall run in
  // exact line spacing), so a and b are glyph middles.
  const after = (a, b) => {
    let at = null;
    for (const next of breaks) if (next > a && next < b) at = next;
    return at;
  };
  const mid = (g) => (g.top + g.bottom) / 2;
  // Text raised or lowered further than its line is tall (Word's position runs to 1,584 pt) sits apart from the rest of its
  // line: a group that starts where the one above it ends, across a gap taller than both, is that line's own run, not a line.
  glyphs = glyphs.reduce((acc, g) => {
    const p = acc.at(-1);
    if (p && g.left >= p.right - 1 && g.top - p.bottom > Math.max(p.bottom - p.top, g.bottom - g.top) && after(mid(p), mid(g)) == null) {
      acc[acc.length - 1] = { top: p.top, bottom: g.bottom, left: p.left, right: g.right };
    } else acc.push(g);
    return acc;
  }, []);
  const out = glyphs.map((g) => ({ top: g.top, bottom: g.bottom }));
  out.forEach((l, i) => {
    const g = glyphs[i];
    if (!i) {
      l.top = after(box.top - 0.5, mid(g)) ?? box.top;
      return;
    }
    const p = glyphs[i - 1];
    const q = out[i - 1];
    const next = after(mid(p), mid(g));
    if (next != null) {
      q.bottom = p.bottom + Math.max(0, p.top - q.top);
      l.top = next;
    } else {
      const h = p.bottom - p.top;
      q.bottom = l.top = p.bottom + (g.top - p.bottom) * (h / (h + g.bottom - g.top || 1));
    }
  });
  if (out.length) out.at(-1).bottom = Math.max(box.bottom, glyphs.at(-1).bottom);
  return out;
}

/** The page frame holding layout y: the last frame whose content starts at or above y (frames in order, {contentTop, F}). A y in
 * the dead zone below a page's cut maps through that page, as a block box top that sits there is still the page's. */
export function frameAt(frames, y) {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].contentTop <= y + 0.5) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo];
}

/** Layout y to flow y (the text laid out with no page ends) through the frame holding it. */
export const toFlow = (frames, y) => {
  const f = frameAt(frames, y);
  return y - f.contentTop + f.F;
};

/** The pages of `units` laid out in one flow (px, no page ends), Word's way: lines fill each page's body; widow and orphan control,
 * keep lines together, keep with next and page break before move text to the next page earlier; a 'break' unit ends its page and
 * starts its section on a new page, an even or odd one with a blank page before it when the number needs one; a split table's
 * header rows repeat at the top of each page it continues on, a page that starts inside a row too; a page that ends early takes
 * its section's vertical alignment. A row that splits is a 'text' unit with rowLines' lines and no widow control; a page cut
 * inside it ends at its last kept line (lastBottom), while the next page starts at cut.flow.
 *   units[i]: {kind: 'text' (splits by lines) | 'block' (moves whole) | 'break', ft, fb (flow top and bottom), hold (a frame out of
 *     the flow: the height that has to fit below ft), keepNext, keepLines,
 *     widow, breakBefore, section, table (id of its split table) and header (a header row), start ('page' | 'even' | 'odd', breaks)}
 *   linesOf(i) → the flow lines [{top, bottom}] of text unit i; sectOf(i) → section i's sect; size(spec) → the page's
 *   {bodyH, ...} for {index, section, number, first, blank} (reservations applied); v1Start: the v1 sect.pageNumber.start.
 *   units[i].child: the top-level block holding it (the rows of one table share it), for Justified's gaps.
 *   notes: the footnotes kept with their reference lines, {sep (px of separator above a page's notes), list: [{y (the reference's
 *   flow y), h (the note's height), first (its first line's)}] ascending by y}: a page's text ends where its notes still fit below.
 *   pins: Map `${firstUnit}.${firstLine}` → {unit, line, forced}: the page starting there ends at that cut whatever fits (the engine
 *   keeps the page ends it drew once a layout keeps changing), when the cut lies after the page's start with no break between.
 * → pages [{...size(spec), section, number, first, blank, F (flow at the content top), push (px above the content: header rows and
 *   vertical alignment), header (table id), vShift, vGap (Justified: px added above each block after the page's first), firstUnit,
 *   firstLine, cut: {unit, line, flow, forced} | null, lastBottom, over (px the page's content runs past its body: a line or block
 *   taller than the room)}]. */
export function planPages({ units, linesOf, sectOf, size, v1Start = null, maxPages = 5000, notes = null, pins = null }) {
  const heads = new Map(); // table id → height of its header rows
  for (const x of units) if (x.header && x.table != null) heads.set(x.table, (heads.get(x.table) ?? 0) + (x.fb - x.ft));
  const firstTop = (j) => (units[j].kind === 'text' ? linesOf(j)[0]?.top : null) ?? units[j].ft;
  const keep = units.map((x) => x.keepNext && x.kind !== 'break');
  const pages = [];
  let u = 0;
  let line = 0;
  let F = 0;
  let section = units[0]?.section ?? 0;
  let start = null;
  let first = true;
  let header = null;
  const refs = notes?.list ?? [];
  const sep = notes?.sep ?? 0;
  let k0 = 0; // the first reference not on an earlier page
  let carry = 0; // px of note text carried over from the page before
  while (pages.length < maxPages) {
    const sect = sectOf(section);
    const prev = pages.at(-1)?.number ?? null;
    let number = numberOf(prev, sect, first, v1Start);
    if (first && needsBlank(start, number)) {
      const blank = (prev ?? 0) + 1;
      pages.push({ ...size({ index: pages.length, section, number: blank, first: false, blank: true }), section, number: blank, first: false,
        blank: true, F, push: 0, header: null, vShift: 0, vGap: 0, firstUnit: u, firstLine: line, cut: null, lastBottom: F });
      number = sect.pgNum?.start ?? blank + 1;
    }
    const box = size({ index: pages.length, section, number, first, blank: false });
    const headH = header == null ? 0 : heads.get(header) ?? 0;
    const limit = F + box.bodyH - headH;
    while (k0 < refs.length && refs[k0].y < F - 0.5) k0++;
    // The room the footnotes of the text down to flow y `b` take at the page's bottom: the separator, the note text carried over
    // and each note referenced on the page, the one referenced on the line starting at `top` with only its first line. A reference
    // line goes to the next page, with its note, only when not even the note's first line fits under it (Word); the rest of that
    // note then carries over. A page holding only carried text gives it at most half its body (notes/area.js splits the same way).
    const cont = carry > 0 ? Math.min(carry + sep, box.bodyH / 2) : 0;
    const need = (b, top = Infinity) => {
      let h = 0;
      let last = null;
      for (let k = k0; k < refs.length && refs[k].y <= b + 0.5; k++) [h, last] = [h + refs[k].h, refs[k]];
      if (!last) return cont;
      return carry + sep + h - (last.y >= top - 0.5 ? last.h - last.first : 0);
    };
    // Word puts the extra leading of multiple line spacing below the text and lets a page's last line run it into the bottom
    // margin: only the text has to fit (WordCraft flow.rs fit_height, measured in Word). Not where notes or a footer taller than
    // the margin hold the page's foot. A line box is the multiple of its single line, its text the first 1/multiple of it.
    const atMargin = !box.box || Math.abs(box.botOff - box.box.bottom) < 0.5; // a size without its paper (the predictor's) is at it
    const textEnd = (x, l) => (atMargin && x.multiple > 1 ? l.top + (l.bottom - l.top) / x.multiple : l.bottom);
    // Word fits that text exactly: in a probe (fixture/walk/pagefoot_docx.py, Aptos 12 pt at 278/240) a page's 28th line stays
    // with its text end 0.9 twip above the bottom margin and moves on 0.1 twip below it. A line box read from the layout is good
    // to a few hundredths of a px, so the text end gets 0.1 px where a whole line keeps 0.5 (Word fixture page 137: its Intense
    // Reference line's text ends 0.29 px past the margin and starts the next page).
    const textFits = (x, l) => textEnd(x, l) <= limit + (atMargin && x.multiple > 1 ? 0.1 : 0.5);
    let cut = null;
    let lastBottom = F;
    let full = false; // a block taller than the page's room holds the page alone
    for (let j = u; j < units.length; j++) {
      const x = units[j];
      if (x.kind === 'break') {
        cut = { unit: j, line: 0, flow: x.ft, forced: true };
        break;
      }
      if (full || (x.breakBefore && j > u)) {
        cut = { unit: j, line: 0, flow: firstTop(j), forced: !full };
        break;
      }
      // A frame in the flow (hold: its height) fits whole below its place or moves to the next page with what follows; at a page's
      // top it stays.
      const fits = !x.hold || j === u || x.ft + x.hold <= limit + 0.5;
      if (fits && x.fb + need(x.fb) <= limit + 0.5) {
        lastBottom = x.fb;
        continue;
      }
      const from = j === u ? line : 0;
      const L = x.kind === 'text' ? linesOf(j) : [];
      if (L.length > from) {
        const n = L.length - from;
        let m = 0;
        while (m < n) {
          const l = L[from + m];
          const nb = need(l.bottom, l.top);
          if (nb > 0 ? l.bottom + nb > limit + 0.5 : !textFits(x, l)) break;
          m++;
        }
        const kept = fitCount(n, m, { widow: x.widow, keepLines: x.keepLines, atTop: j === u });
        if (kept >= n) {
          lastBottom = x.fb;
          continue;
        }
        if (kept > 0) {
          cut = { unit: j, line: from + kept, flow: L[from + kept].top, forced: false };
          lastBottom = L[from + kept - 1].bottom;
          break;
        }
      }
      if (j === u) {
        lastBottom = x.fb;
        full = true;
        continue;
      }
      // x moves whole, with the keep-with-next chain before it unless that chain fills the page.
      const p = chainStart(keep, j, u);
      cut = { unit: p, line: 0, flow: firstTop(p), forced: false };
      lastBottom = p > u ? units[p - 1].fb : F;
      break;
    }
    const pin = pins?.get(`${u}.${line}`);
    if (pin && pin.unit < units.length && (pin.unit > u || pin.line > line) && !units.slice(u, pin.unit).some((x) => x.kind === 'break')) {
      const L = pin.line > 0 && units[pin.unit].kind === 'text' ? linesOf(pin.unit) : null;
      if (!pin.line || L?.length > pin.line) {
        const brk = units[pin.unit].kind === 'break';
        cut = { unit: pin.unit, line: pin.line, flow: L ? L[pin.line].top : brk ? units[pin.unit].ft : firstTop(pin.unit), forced: brk || !!pin.forced };
        lastBottom = L ? L[pin.line - 1].bottom : pin.unit > u ? units[pin.unit - 1].fb : F;
        full = false;
      }
    }
    const next = cut && units[cut.unit];
    const early = !cut || cut.forced || next.section !== section;
    // Justified spreads the room over the gaps between the page's blocks; a page that ends inside a block is never early.
    const blocks = new Set();
    if (early && sect.vAlign === 'both' && !(cut?.line > 0)) for (let j = u; j < (cut ? cut.unit : units.length); j++) if (units[j].kind !== 'break') blocks.add(units[j].child ?? j);
    const notesH = need(lastBottom);
    const align = early ? vAlignShift(sect.vAlign, box.bodyH - headH - (lastBottom - F) - notesH, Math.max(0, blocks.size - 1)) : { top: 0, gap: 0 };
    // A line or block taller than the room holds the page alone and runs past its body: Word clips it at the paper's edge and
    // starts the next page below it (layout-spike.md), so the page takes the overflow along (stackPages).
    // The page's last line, its leading in the margin (textEnd): that runs past no paper, so it is no overflow; the page end goes
    // below it (lead, pagination's bodyBottom).
    const endUnit = cut ? (cut.line > 0 ? cut.unit : cut.unit - 1) : units.length - 1;
    const ex = units[endUnit];
    const EL = lastBottom > limit + 0.5 && ex?.kind === 'text' && ex.multiple > 1 && notesH === 0 ? linesOf(endUnit) : null;
    const el = EL && (cut?.line > 0 && cut.unit === endUnit ? EL[cut.line - 1] : EL.at(-1));
    const lead = el && textFits(ex, el) ? lastBottom - limit : 0;
    const over = !lead && lastBottom > limit + 0.5 ? lastBottom - limit : 0;
    // Note text that does not fit under the page's last line goes on to the next page.
    const own = k0 < refs.length && refs[k0].y <= lastBottom + 0.5;
    carry = own ? Math.max(0, notesH - (limit - lastBottom)) : Math.max(0, carry - Math.max(0, Math.min(limit - lastBottom, box.bodyH / 2) - sep));
    while (k0 < refs.length && refs[k0].y <= lastBottom + 0.5) k0++;
    pages.push({ ...box, section, number, first, blank: false, F, push: headH + align.top, header, vShift: align.top, vGap: align.gap, firstUnit: u,
      firstLine: line, cut, lastBottom, over, lead });
    if (!cut) break;
    if (next.kind === 'break') {
      // A manual page break keeps its section going: only a section break starts a section's first page (numbering restart, titlePg).
      [F, u, line, first, start, section, header] = [next.ft, cut.unit + 1, 0, next.section !== section || next.start !== 'page', next.start, next.section, null];
      continue;
    }
    // An automatic cut starts its section's first page only at the section's first unit: a continuous section begun mid-page
    // goes on numbering and keeps its default header on the pages after.
    const opens = cut.line === 0 && units[cut.unit - 1]?.section !== next.section;
    [F, u, line, first, start] = [cut.flow, cut.unit, cut.line, opens, null];
    section = next.section;
    header = next.table != null && heads.has(next.table) && !next.header && units[u - 1]?.table === next.table ? next.table : null;
  }
  return pages;
}

/** Where page `b`'s body starts below page `a` (layout px), with the room the browser actually gave a's page end: b's paper starts
 * the gap below a's paper, further down by as much as a's breaker, drawn at `breakerAt`, starts below that paper (content that ran
 * past it, as a line taller than the page does), so every sheet sits where its text starts, a forced page start too. `slack`: how
 * far below a page's last line its breaker starts, where no text runs on, so no cover (it still moves the next page). Without
 * `breakerAt` (a page end not drawn yet) a's planned `over` stands in, as stackPages counts it. → {bodyTop, cover: px below a's
 * paper that the cover hides, 0 for none}. */
export function placeAfter(a, b, breakerAt = null, { hidden = false, gap = 16, thin = 6, slack = 0 } = {}) {
  const end = a.bodyTop + a.bodyH + (hidden ? 0 : a.botOff);
  const run = breakerAt == null ? a.over || 0 : Math.max(0, breakerAt - end);
  const paper = end + (hidden ? thin : gap) + run;
  return { bodyTop: paper + (hidden ? 0 : b.topOff), cover: run > slack + 0.5 ? paper - end : 0 };
}

/** Each page's place in layout px (zoom-free, 0 at the first page's body top): a body follows the one before it after that page's
 * overflow (content taller than the page), bottom margin, the gap and its own top margin, or after a thin line while white space
 * is hidden. Blank pages take no room on screen (they print only) and take the next page's place. Adds {top, bodyTop} to every
 * page. */
export function stackPages(pages, { hidden = false, gap = 16, thin = 6 } = {}) {
  let prev = null;
  for (const p of pages) {
    if (p.blank) continue;
    p.bodyTop = !prev ? 0 : prev.bodyTop + prev.bodyH + (prev.over || 0) + (hidden ? thin : prev.botOff + gap + p.topOff);
    p.top = p.bodyTop - p.topOff;
    prev = p;
  }
  for (let i = pages.length - 1, next = null; i >= 0; i--) {
    const p = pages[i];
    if (!p.blank) next = p;
    else Object.assign(p, { bodyTop: next?.bodyTop ?? 0, top: (next?.bodyTop ?? 0) - p.topOff });
  }
  return pages;
}

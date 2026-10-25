// A Document's page setup (docs/plans/document.md Ribbon Layout, doc.pageSetup): the next doc.attrs.sect for a size,
// orientation and margins, as the Layout tab, the Page Setup dialog and doc.pageSetup all write it. Pure: Node tests read it.
import { MARGIN_PRESETS, PAPER_SIZES } from '../office.mjs';

const SIDES = ['top', 'right', 'bottom', 'left'];
/** Smallest text column and body height a page setup may leave, in points (ours: Word's own limit is unmeasured). */
export const MIN_TEXT = 36;
/** Largest paper side, in points (Word's 22 in). */
export const MAX_PAPER = 1584;

/** `sect` with `size` (a PAPER_SIZES key or {widthPt, heightPt}), `orientation` ('portrait' | 'landscape') and `margins` (a
 * MARGIN_PRESETS key or {topPt, rightPt, bottomPt, leftPt}) applied; each left out keeps the current one. A named size takes
 * the page's orientation, a custom one its own (wider than tall is landscape) unless `orientation` is given. Changing the
 * orientation swaps w and h and keeps the margins. `pageNumber` ({at, align, start?}, or null for none) replaces the page
 * number; header, footer and gutter stay. */
export function sectFor(sect, { size, orientation, margins, pageNumber } = {}) {
  let { w, h } = sect;
  let orient = orientation ?? sect.orient;
  if (typeof size === 'string') ({ w, h } = PAPER_SIZES[size]);
  else if (size) {
    [w, h] = [size.widthPt, size.heightPt];
    orient = orientation ?? (w > h ? 'landscape' : 'portrait');
  }
  if ((orient === 'landscape') !== (w > h) && w !== h) [w, h] = [h, w];
  const margin = { ...sect.margin };
  if (typeof margins === 'string') for (const k of SIDES) margin[k] = MARGIN_PRESETS[margins][k];
  else if (margins) for (const k of SIDES) margin[k] = margins[`${k}Pt`];
  const out = { ...sect, w, h, orient, margin };
  if (pageNumber !== undefined) out.pageNumber = pageNumber && { at: pageNumber.at, align: pageNumber.align, start: pageNumber.start ?? null };
  return out;
}

/** Why `sect` leaves no room for text (less than MIN_TEXT across or down), or null. */
export function tooSmall(sect) {
  const { w, h, margin: m } = sect;
  if (w - m.left - m.right < MIN_TEXT) return 'The left and right margins leave no room for text';
  if (h - m.top - m.bottom < MIN_TEXT) return 'The top and bottom margins leave no room for text';
  return null;
}

const near = (a, b) => Math.abs(a - b) < 0.5;
/** The MARGIN_PRESETS key `sect`'s margins match, or null (custom). */
export const marginPreset = (sect) => Object.keys(MARGIN_PRESETS).find((k) => SIDES.every((s) => near(sect.margin[s], MARGIN_PRESETS[k][s]))) ?? null;
/** The PAPER_SIZES key `sect`'s paper matches in either orientation, or null (custom). */
export const paperSize = (sect) => Object.keys(PAPER_SIZES).find((k) => {
  const p = PAPER_SIZES[k];
  return (near(sect.w, p.w) && near(sect.h, p.h)) || (near(sect.w, p.h) && near(sect.h, p.w));
}) ?? null;

/** The unit page lengths show in: inches where the paper is Letter (settings.paper, from the Windows region), else cm. */
export const unitOf = (paper) => (paper === 'letter' ? { name: 'in', pt: 72 } : { name: 'cm', pt: 72 / 2.54 });
/** `pt` in `unit`, to two decimals, as text. */
export const showIn = (pt, unit) => String(Math.round((pt / unit.pt) * 100) / 100);

// ---------- pagination (document/pagination.js) ----------
/** The gap between two pages on screen, in px (docs/plans/document.md Page view). */
export const GAP = 16;

/** Pages a run of content `height` px tall takes when it starts at the top of a page's text area: each page holds `body` px of
 * text, then `breaker` px (bottom margin, gap, top margin) the text skips. A height that ends inside a breaker is on the next
 * page; half a pixel of rounding is let through. */
export function pagesFor(height, body, breaker) {
  if (height <= body + 0.5) return 1;
  return 1 + Math.ceil((height - body - 0.5) / (body + breaker));
}

/** The page (0-based, over the whole document) at layout y `y`: `segments` are the runs between manual page breaks in order,
 * each {top: the y its first page's text starts at, pages}; `step` is a page's body plus breaker. */
export function pageAt(y, segments, step) {
  let first = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (i + 1 < segments.length && y >= segments[i + 1].top) {
      first += s.pages;
      continue;
    }
    return first + Math.min(s.pages - 1, Math.max(0, Math.floor((y - s.top) / step)));
  }
  return 0;
}

/** The loop guard of the page count (research-tech.md Pagination): page counts that flip back and forth for one doc version
 * (more pages push a block below the next breaker, fewer let it back) settle on the largest count seen; counts that keep
 * changing (a block taller than a page, pushed below every new breaker) stop after `limit` changes. Returns settle(version,
 * counts) giving the counts to draw. */
export function pageGuard(limit = 12) {
  let version;
  let seen = [];
  let drawn = null;
  return (v, counts) => {
    if (v !== version) {
      version = v;
      seen = [];
    }
    const key = counts.join();
    if (key === seen.at(-1) || seen.length > limit) return drawn; // a repeat (a caret move) is no change
    const flip = seen.length > 1 && seen.includes(key) && seen.at(-1) !== key;
    seen.push(key);
    drawn = flip ? counts.map((n, i) => Math.max(n, ...seen.map((k) => Number(k.split(',')[i]) || 0))) : counts;
    if (flip) seen.length = limit + 1; // settled for this version
    return drawn;
  };
}

/** The @page rule printing `sect` (Phase 2's PDF view): paper size and margins in points, and the page number in a margin box
 * (Chromium 131+). @page cannot read the sheet's custom properties, so the print view writes this rule itself. */
export function printCss(sect) {
  const m = sect.margin;
  const pn = sect.pageNumber;
  const box = pn && `@${pn.at}-${pn.align}`;
  const counter = pn && (pn.start ? `counter-reset: page ${pn.start - 1}; ` : '');
  return `@page { size: ${sect.w}pt ${sect.h}pt; margin: ${m.top}pt ${m.right}pt ${m.bottom}pt ${m.left}pt; ${counter ?? ''}`
    + `${box ? `${box} { content: counter(page); font-size: 12pt; }` : ''}}`;
}

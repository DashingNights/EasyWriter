// Print page choice and job options (docs/plans/word/briefs/print.md): the Pages box, odd and even pages, book fold order and
// the mapping from the Print page's Settings to api.word.print's arguments. Pure, so test/word-print.test.mjs loads it in Node.

/** Word's Pages box hint, shown under the box and in its messages. */
export const PAGES_HINT = 'Type pages such as 1,3,5-12, or p1s2 for page 1 of section 2.';

// One end of a range: p<n>s<m>, p<n>, s<m> or a plain number (the shown page number).
const ITEM = /^(?:p(\d+)(?:s(\d+))?|s(\d+)|(\d+))$/;

/** The 0-based pages of item `text` among `pages` ({index, number, section}) → page indices (all of a section for s<m>), [] when
 * none matches, null when it is not an item. Plain numbers are shown numbers: with restarted numbering the first page showing it. */
function itemPages(text, pages) {
  const m = ITEM.exec(text);
  if (!m) return null;
  const [, p, ps, s, n] = m;
  if (s) return pages.filter((g) => g.section === s - 1).map((g) => g.index);
  const num = Number(p ?? n);
  const hit = pages.find((g) => g.number === num && (ps == null || g.section === ps - 1));
  return hit ? [hit.index] : [];
}

/** Parses the Pages box `text` against `pages` (geometry pages: {index, number, section}) → {indices (0-based, ascending, no
 * repeats), error (a message in our words, or null)}. Empty text is every page. */
export function parsePages(text, pages) {
  const all = pages.map((g) => g.index);
  const clean = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  if (!clean) return { indices: all, error: null };
  const out = new Set();
  for (const tok of clean.split(/[,;]/)) {
    if (!tok) continue;
    const ends = tok.split('-');
    if (ends.length > 2) return { indices: [], error: `"${tok}" is not a page or a range. ${PAGES_HINT}` };
    const [a, b] = ends.map((e) => itemPages(e, pages));
    if (a == null || (ends.length === 2 && b == null)) return { indices: [], error: `"${tok}" is not a page or a range. ${PAGES_HINT}` };
    if (!a.length || (b && !b.length)) return { indices: [], error: `There is no page ${tok} in this document.` };
    const from = a[0];
    const to = b ? b.at(-1) : a.at(-1);
    if (to < from) return { indices: [], error: `The range ${tok} runs backwards. Put the earlier page first.` };
    for (let i = from; i <= to; i++) out.add(i);
  }
  return { indices: all.filter((i) => out.has(i)), error: null };
}

/** The pages Settings (1) picks: `what` 'all' | 'selection' | 'current' | 'custom' | 'info', with `text` the Pages box, `current`
 * the 0-based page of the cursor and `selection` [from page, to page] → {indices, error}. 'info' prints no document pages. */
export function pickPages({ what = 'all', text = '', current = 0, selection = null, odd = false, even = false }, pages) {
  let r;
  if (what === 'info') r = { indices: [], error: null };
  else if (what === 'current') r = { indices: [current], error: null };
  // ponytail: Print Selection prints the pages the selection spans, not the selection laid out alone; a fresh layout of the slice when asked.
  else if (what === 'selection' && selection) r = { indices: pages.map((g) => g.index).filter((i) => i >= selection[0] && i <= selection[1]), error: null };
  else if (what === 'custom' || text) r = parsePages(text, pages);
  else r = { indices: pages.map((g) => g.index), error: null };
  if (odd !== even) {
    const byIndex = new Map(pages.map((g) => [g.index, g.number]));
    r.indices = r.indices.filter((i) => (byIndex.get(i) % 2 === 1) === odd);
  }
  return r;
}

/** Book fold order for `n` pages, `sheets` sheets per booklet (0 = one booklet of every page), `reverse` for right-to-left
 * booklets → the sides to print in order, each [left, right] with 0-based page indices or null for a blank half. Each booklet is
 * padded to a multiple of 4 pages; side one of each sheet holds the booklet's last and first pages. */
export function bookletOrder(n, sheets = 0, reverse = false) {
  const per = sheets > 0 ? sheets * 4 : Math.max(4, Math.ceil(n / 4) * 4);
  const sides = [];
  for (let start = 0; start < n; start += per) {
    const at = (k) => (start + k - 1 < n ? start + k - 1 : null); // k is 1-based inside the booklet
    for (let s = 0; s < per / 4; s++) {
      const front = [at(per - 2 * s), at(1 + 2 * s)];
      const back = [at(2 + 2 * s), at(per - 1 - 2 * s)];
      sides.push(reverse ? front.reverse() : front, reverse ? back.reverse() : back);
    }
  }
  return sides;
}

/** Consecutive runs of ascending `indices` → [{from, to}] (0-based, api.word.print's pageRanges). */
export function runsOf(indices) {
  const runs = [];
  for (const i of indices) {
    const last = runs.at(-1);
    if (last && i === last.to + 1) last.to = i;
    else runs.push({ from: i, to: i });
  }
  return runs;
}

/** `runs` as printToPDF's pageRanges text ('2-3, 5', 1-based). */
export const pdfRanges = (runs) => runs.map((r) => (r.from === r.to ? `${r.from + 1}` : `${r.from + 1}-${r.to + 1}`)).join(', ');

const DUPLEX = { one: 'simplex', long: 'longEdge', short: 'shortEdge', manual: 'simplex' };
const MICRONS = 25400 / 72; // per pt

/** The api.word.print arguments of the Print page's options `o` ({copies, printer, sides, collate, perSheet}) for a job whose
 * sheets are `sheet` ({w, h} in pt, the first printed one) and whose `runs` select pages of the copy (null: print it all). */
export function printArgs(o, { sheet, runs = null, silent = false }) {
  const args = {
    silent,
    copies: Math.max(1, Math.round(o.copies) || 1),
    collate: o.collate !== false,
    duplexMode: DUPLEX[o.sides] ?? 'simplex',
    landscape: !!sheet && sheet.w > sheet.h,
    margins: { marginType: 'none' },
    pagesPerSheet: o.perSheet ?? 1,
    printBackground: true,
  };
  if (o.printer) args.deviceName = o.printer;
  if (sheet) args.pageSize = { width: Math.round(Math.min(sheet.w, sheet.h) * MICRONS), height: Math.round(Math.max(sheet.w, sheet.h) * MICRONS) };
  if (runs) args.pageRanges = runs;
  return args;
}

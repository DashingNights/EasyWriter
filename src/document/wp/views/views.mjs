// Views' pure logic (docs/plans/word/plan.md §3 views, briefs/views.md): the Zoom dialog's conversions, Read Mode's screens and
// columns, Immersive Reader's column widths and Line Focus band, and the Switch Windows list. No DOM, so node tests load it.

export const ZOOM_MIN = 10;
export const ZOOM_MAX = 500; // Word's range (Zoom dialog Percent)
export const GAP = 16; // px between pages, as pagination's breaker gap

const clamp = (pct) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(pct)));

/** The zoom percent of Zoom dialog choice `kind` ('200', '100', '75', 'pageWidth', 'textWidth', 'wholePage', 'manyPages') for an
 * editor area `area` {w, h} (px it can show), paper `page` {w, h} and text width `text` (layout px), and for Many pages `grid`
 * {cols, rows} → the percent, 10 to 500. */
export function zoomFor(kind, { area, page, text, grid = { cols: 2, rows: 1 } }) {
  if (/^\d+$/.test(kind)) return clamp(Number(kind));
  if (kind === 'pageWidth') return clamp((100 * area.w) / page.w);
  if (kind === 'textWidth') return clamp((100 * area.w) / text);
  if (kind === 'wholePage') return clamp(100 * Math.min(area.w / page.w, area.h / page.h));
  if (kind === 'manyPages') {
    const w = grid.cols * page.w + (grid.cols - 1) * GAP;
    const h = grid.rows * page.h + (grid.rows - 1) * GAP;
    return clamp(100 * Math.min(area.w / w, area.h / h));
  }
  return null;
}

/** Side to Side's pages for a room `area` {w, h} (px) and paper `page` {w, h} (layout px): Word fits the pages to the window's
 * height and shows two across when two fit there, else one, scaled down further if one is still too wide → {cols, scale}. */
export function sideFit(area, page) {
  const tall = area.h / page.h;
  const cols = 2 * page.w * tall + GAP <= area.w ? 2 : 1;
  return { cols, scale: Math.min(tall, (area.w - (cols - 1) * GAP) / (cols * page.w)) };
}

// Read Mode's column widths (settings.word.readMode.columnWidth), the widest a column may be in px; Word fits as many columns of
// at most that width as the screen holds. ponytail: the three widths are eyeballed from Word's Read Mode at 1920 px, not measured.
export const READ_WIDTHS = { narrow: 360, default: 560, wide: 900 };

/** Read Mode's columns for a screen `width` px wide with `gap` px between columns, at column width setting `setting` → {count,
 * width} (px of one column). 'paper' layout takes one column the page's text width `paper` (px), centred by the caller. */
export function readColumns(width, setting = 'default', gap = 48, paper = null) {
  if (paper) return { count: 1, width: Math.min(width, paper) };
  const most = READ_WIDTHS[setting] ?? READ_WIDTHS.default;
  const count = Math.max(1, Math.ceil((width + gap) / (most + gap)));
  return { count, width: (width - (count - 1) * gap) / count };
}

/** How many screens text `scrollWidth` px wide makes when one screen is `width` px and the next starts `gap` px after it. */
export function screenCount(scrollWidth, width, gap) {
  return Math.max(1, Math.ceil((scrollWidth + gap - 1) / (width + gap)));
}

/** The 0-based screen of a position `x` px from the text's left edge (a caret or a heading the reader jumps to). */
export const screenAt = (x, width, gap) => Math.max(0, Math.floor(x / (width + gap)));

// Immersive Reader's Column Width items, in Word's order, as the text's width in ch; 'default' keeps the page's text width.
export const IMMERSIVE_WIDTHS = { veryNarrow: 35, narrow: 50, moderate: 70, wide: 100 };

/** The Line Focus band around the caret's line `line` {top, bottom} (px) for `n` lines (1, 3 or 5), kept inside `bounds` {top,
 * bottom} → {top, bottom}; null when Line Focus is off (n 0). Lines are taken as tall as the caret's line. */
export function focusBand(line, n, bounds = { top: -Infinity, bottom: Infinity }) {
  if (!n) return null;
  const h = line.bottom - line.top;
  let top = line.top - h * ((n - 1) / 2);
  let bottom = top + h * n;
  if (top < bounds.top) [top, bottom] = [bounds.top, Math.min(bounds.bottom, bounds.top + h * n)];
  else if (bottom > bounds.bottom) [top, bottom] = [Math.max(bounds.top, bounds.bottom - h * n), bounds.bottom];
  return { top, bottom };
}

/** Switch Windows' list: `drafts` [{id, title}] in the sidebar's order, numbered 1 to 9 as Word numbers its windows ('1 Document1'),
 * the open draft `openId` checked → [{id, label, active}]. */
export function windowList(drafts, openId) {
  return drafts.slice(0, 9).map((d, i) => ({ id: d.id, label: `${i + 1} ${d.title || 'Untitled'}`, active: d.id === openId }));
}

/** The draft after (`step` 1) or before (-1) `openId` in `drafts`, wrapping round → its id, or null with fewer than two drafts. */
export function nextDraft(drafts, openId, step = 1) {
  if (drafts.length < 2) return null;
  const i = drafts.findIndex((d) => d.id === openId);
  return drafts[(Math.max(0, i) + step + drafts.length) % drafts.length].id;
}

/** The words Syllables splits: runs of four or more letters. */
export const SYLLABLE_WORD = /\p{L}{4,}/gu;

/** The syllable breaks inside `word` (offsets from `breaks(word)`, unique, sorted, never at either end). Shared by the editor's dots
 * (syllables.js) and Read Mode's copy (syllabify). */
export function syllableBreaks(word, breaks) {
  return [...new Set(breaks(word) ?? [])].filter((i) => i > 0 && i < word.length).sort((a, b) => a - b);
}

/** `word` with a middle dot at each syllable break `breaks(word)` gives (offsets), for Syllables. */
export function syllabify(word, breaks) {
  let out = '';
  let from = 0;
  for (const i of syllableBreaks(word, breaks)) {
    out += `${word.slice(from, i)}·`;
    from = i;
  }
  return out + word.slice(from);
}

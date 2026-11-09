// Where a draft's pages go on a board (docs/plans/board/briefs/bd-instance.md): the import grid, its footprint, the nearest
// free area to the attention point, and the point the user means. Pure, so the node test and the board read the same rules.

/** Pages in one row of the import grid. */
export const ROW = 12;
/** The gap between pages and between rows, points. */
export const GAP = 24;
/** How much room round a placed draft's box is kept clear, points. */
export const PAD = 48;
/** A step of the ring search for a free spot, points. */
const STEP = 48;
const RINGS = 200;

/** The import grid of `pages` ([{w, h}]) placed with its top left at `at` → each page's top left, in page order. A row is as
 * tall as its tallest page. */
export function grid(pages, at) {
  const out = [];
  let y = at.y;
  for (let i = 0; i < pages.length; i += ROW) {
    const row = pages.slice(i, i + ROW);
    let x = at.x;
    let tallest = 0;
    for (const page of row) {
      out.push({ x, y });
      x += page.w + GAP;
      tallest = Math.max(tallest, page.h);
    }
    y += tallest + GAP;
  }
  return out;
}

/** The box a grid of `pages` takes: its widest row and its rows' heights with the gaps between them, no trailing gap. */
export function footprint(pages) {
  let w = 0;
  let h = 0;
  for (let i = 0; i < pages.length; i += ROW) {
    const row = pages.slice(i, i + ROW);
    const width = row.reduce((n, page) => n + page.w, 0) + GAP * (row.length - 1);
    const height = Math.max(...row.map((page) => page.h));
    w = Math.max(w, width);
    h += height + (h ? GAP : 0);
  }
  return { w, h };
}

/** Whether a box of `size` at (x, y), grown by `PAD`, touches no rect of `taken`. */
const free = (size, taken, x, y) => !taken.some((r) => x - PAD < r.x + r.w && r.x < x + size.w + PAD
  && y - PAD < r.y + r.h && r.y < y + size.h + PAD);

/** The point nearest `want` where a box of `size` plus PAD touches no rect of `taken`: `want` itself when it is free, else the
 * first free point on square rings round it, 48 pt a step, each ring's points tried nearest first. */
export function freeSpot(size, taken, want) {
  if (free(size, taken, want.x, want.y)) return { x: want.x, y: want.y };
  for (let ring = 1; ring <= RINGS; ring++) {
    const points = [];
    for (let i = -ring; i <= ring; i++) {
      points.push({ x: want.x + i * STEP, y: want.y + ring * STEP });
      if (i < ring && i > -ring) points.push({ x: want.x + i * STEP, y: want.y - ring * STEP });
    }
    for (let j = -ring + 1; j < ring; j++) {
      points.push({ x: want.x + ring * STEP, y: want.y + j * STEP });
      points.push({ x: want.x - ring * STEP, y: want.y + j * STEP });
    }
    points.sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
    for (const p of points) if (free(size, taken, p.x, p.y)) return p;
  }
  return { x: want.x, y: want.y };
}

/** The point the user means: `pointer` when it is in `view` ({x, y, w, h}), else the view's centre. */
export function attention(pointer, view) {
  const inside = pointer && pointer.x >= view.x && pointer.x <= view.x + view.w && pointer.y >= view.y && pointer.y <= view.y + view.h;
  return inside ? { x: pointer.x, y: pointer.y } : { x: view.x + view.w / 2, y: view.y + view.h / 2 };
}

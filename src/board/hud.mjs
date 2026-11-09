// The board's focus rules (docs/plans/board/briefs/bd-hud.md, design section 8): whether a document counts (a quarter of the
// view), which page a double-click homes to, the camera that puts a point at the view's centre, and which format's HUD wins
// (format.hudRank). Pure, so the node test and the board read the same rules. Points and CSS px as the viewport keeps them.
import { PX_PER_PT, kOf } from '../engine/view/camera.mjs';

/** The share of the view a document's pages must fill for a double-click to focus it (the user's rule). */
export const QUARTER = 0.25;

/** The overlap of rect `r` with view `v`, in square points. */
const overlap = (r, v) => {
  const w = Math.min(r.x + r.w, v.x + v.w) - Math.max(r.x, v.x);
  const h = Math.min(r.y + r.h, v.y + v.h) - Math.max(r.y, v.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** The summed area of `rects` inside `view` over the view's area (0 to 1). */
export function coverage(rects, view) {
  const area = view.w * view.h;
  if (!(area > 0) || !rects?.length) return 0;
  let sum = 0;
  for (const r of rects) sum += overlap(r, view);
  return Math.min(1, sum / area);
}

/** Whether a document's pages (`slots` and their `pages` sizes) fill a quarter of the view. */
export function counts(slots, pages, view) {
  return coverage(slots.map((s, k) => ({ x: s.x, y: s.y, w: pages[k].w, h: pages[k].h })), view) >= QUARTER;
}

const on = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The page a double-click homes to: the page under `cursor`, else the page whose centre is nearest the view's centre and the
 * point on it nearest that centre → {doc, page, x, y}, or null with no document in view.
 */
export function homePoint(cursor, docs, view) {
  for (const doc of docs ?? []) {
    for (const r of doc.rects) if (cursor && on(cursor, r)) return { doc: doc.id, page: r.page, x: cursor.x, y: cursor.y };
  }
  const c = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  let best = null;
  let near = Infinity;
  for (const doc of docs ?? []) {
    for (const r of doc.rects) {
      if (!overlap(r, view)) continue; // a page out of view is not "in view"
      const [dx, dy] = [r.x + r.w / 2 - c.x, r.y + r.h / 2 - c.y];
      const d = dx * dx + dy * dy;
      if (d < near) { near = d; best = { doc: doc.id, r }; }
    }
  }
  if (!best) return null;
  const r = best.r;
  return { doc: best.doc, page: r.page, x: clamp(c.x, r.x, r.x + r.w), y: clamp(c.y, r.y, r.y + r.h) };
}

/** The camera that puts `point` at the view's centre, at `max(zoom, min(pageWidthFit, 2))`: never below the current zoom, which
 * the cap of 2 limits only when it raises. `view` carries the view's CSS px size (pxW, pxH). */
export function homeCamera(point, pageW, view, zoom) {
  const fit = (view.pxW - 48) / (pageW * PX_PER_PT);
  const z = Math.max(zoom, Math.min(fit, 2));
  const k = kOf(z);
  return { x: point.x - view.pxW / 2 / k, y: point.y - view.pxH / 2 / k, zoom: z };
}

/** The format whose HUD shows: the most verbose of `focusFormat` and the documents in view (`inView`), a tie going to the
 * focus. Null when nothing has the focus. */
export function hudOf(focusFormat, inView, formats) {
  if (focusFormat == null) return null;
  let best = focusFormat;
  for (const id of inView ?? []) {
    if (id === focusFormat) continue;
    if ((formats[id]?.hudRank ?? -Infinity) > (formats[best]?.hudRank ?? -Infinity)) best = id;
  }
  return best;
}

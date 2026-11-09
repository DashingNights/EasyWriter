// A viewport's camera (docs/plans/engine/viewport-design.md section 4.2): {x, y, zoom}, the world point at the view's top left and
// the zoom (1 = Word's 100 %). World lengths are points; screen lengths are CSS px from the view's top left, so
// screen = (world - camera) x zoom x 4/3 and device px = CSS px x devicePixelRatio. Pure, so node tests load it.
import { nearest, worldOf } from './placements.mjs';

export const PX_PER_PT = 4 / 3;
/** Chromium lays out at most about 33.5 million px in one element: the scroll driver's column stays under this. */
export const MAX_COLUMN_PX = 33_000_000;

/** CSS px per point at `zoom`. */
export const kOf = (zoom) => zoom * PX_PER_PT;

/** The engine's paint scale for CSS px per pt `k` on a screen of device pixel ratio `dpr`: device px per pt. */
export const paintScale = (k, dpr) => k * (dpr || 1);

/** `v` CSS px moved to the nearest whole device pixel, so a surface origin or a translate does not resample text (measure.md
 * section 6: a fractional translate blurs; layout snaps a placed element by itself). */
export const snap = (v, dpr) => Math.round(v * (dpr || 1)) / (dpr || 1);

/** World point `p` on screen under camera `cam` → {x, y} CSS px from the view's top left. */
export function toScreen(cam, p) {
  const k = kOf(cam.zoom);
  return { x: (p.x - cam.x) * k, y: (p.y - cam.y) * k };
}

/** Screen point `s` (CSS px from the view's top left) in the world under camera `cam` → {x, y} points. */
export function toWorld(cam, s) {
  const k = kOf(cam.zoom);
  return { x: cam.x + s.x / k, y: cam.y + s.y / k };
}

/** The camera at `zoom` that shows world point `w` at screen point `at`. */
export const cameraAt = (w, at, zoom) => ({ x: w.x - at.x / kOf(zoom), y: w.y - at.y / kOf(zoom), zoom });

/** The camera at `zoom` that keeps the world point under screen point `anchor` where `cam` shows it. */
export const zoomAbout = (cam, zoom, anchor) => cameraAt(toWorld(cam, anchor), anchor, zoom);

/** `zoom` held to `range` ({min, max}) and low enough that a column of `extent` ({w, h} points) stays under MAX_COLUMN_PX both
 * ways; the column limit wins over `min`. */
// ponytail: clamping the zoom keeps Chromium's layout limit (the Word fixture is 5.5 million px at 500 %); a drawn scroll bar over
// a shorter sizer when a real document needs more.
export function clampZoom(zoom, range = {}, extent = null) {
  let max = range.max ?? Infinity;
  if (extent) max = Math.min(max, MAX_COLUMN_PX / (Math.max(extent.w, extent.h, 1) * PX_PER_PT));
  return Math.min(max, Math.max(range.min ?? 0, zoom));
}

/** The camera that fits world rect `r` in a view `view` ({w, h} CSS px) with `pad` px round it, centred. */
export function fitRect(r, view, pad = 0) {
  const zoom = Math.min((view.w - 2 * pad) / (Math.max(r.w, 1e-6) * PX_PER_PT), (view.h - 2 * pad) / (Math.max(r.h, 1e-6) * PX_PER_PT));
  return cameraAt({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, { x: view.w / 2, y: view.h / 2 }, zoom);
}

/** The zoom at which a grid of `cols` by `rows` of the largest of `sizes` ([{w, h}] points), `gap` px apart at 100 % (it scales
 * with the zoom) and `pad` px from the view's edges, fits a view `viewW` by `viewH` px, held to `min`..`max` (Multiple Pages,
 * a slide sorter). */
export function fitZoom(sizes, viewW, viewH, cols, rows, { gap = 0, pad = 0, min = 0.1, max = 5 } = {}) {
  const w = Math.max(1, ...sizes.map((p) => p.w)) * PX_PER_PT;
  const h = Math.max(1, ...sizes.map((p) => p.h)) * PX_PER_PT;
  const across = (viewW - 2 * pad) / (cols * w + (cols - 1) * gap);
  const down = (viewH - 2 * pad) / (rows * h + (rows - 1) * gap);
  return Math.max(min, Math.min(max, across, down));
}

/** The camera at `zoom` over placements `next` that keeps the surface point under screen point `anchor` where `cam` showed it over
 * placements `prev` (a zoom, or a relayout that moved the surfaces) → a camera, or null when that surface is gone. */
export function keepPoint(prev, cam, next, zoom, anchor) {
  const w = worldOf(next, nearest(prev, toWorld(cam, anchor)));
  return w && cameraAt(w, anchor, zoom);
}

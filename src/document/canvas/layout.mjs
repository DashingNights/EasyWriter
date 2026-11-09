// Where the canvas page area (docs/plans/engine/plan.md section 1) puts each page: rows of page slots in a scrolling column, from
// the engine's page sizes in points. layoutPages gives CSS px for stage 1's page area; placePages gives the same rows in world
// points as viewport placements (viewport-design.md section 4.1). Pure, so node tests load it (pages.mjs loads in node too).

import { fitZoom as fitGrid, paintScale, PX_PER_PT } from '../../engine/view/camera.mjs';
import { GAP } from '../pages.mjs';

export { paintScale, PX_PER_PT };
export { GAP }; // px between pages at 100 %, the DOM editor's page gap; it scales with the zoom as there
export const PAD = 24; // px above the first row, below the last and at least beside each row (actions.js VIEW_TOP, VIEW_RIGHT)

/** Lays out `pages` ([{w, h}] in pt) at `zoom` (1 = 100 %) in a view `viewW` px wide. A row takes as many pages as fit across, as
 * Word's Print Layout puts pages side by side once they fit, or exactly `cols` when given (Multiple Pages). Rows are centred, their
 * pages top aligned. → {slots: [{x, y, w, h}], width, height, zoom, k}, `k` the CSS px per pt. */
export function layoutPages(pages, zoom, viewW, cols = 0) {
  const k = PX_PER_PT * zoom;
  const gap = GAP * zoom;
  const slots = [];
  let y = PAD;
  let width = viewW;
  for (let i = 0; i < pages.length;) {
    let n = 0;
    let rowW = 0;
    let rowH = 0;
    while (i + n < pages.length) {
      const w = pages[i + n].w * k;
      const next = rowW + (n ? gap : 0) + w;
      if (n && (cols ? n >= cols : next + 2 * PAD > viewW)) break;
      rowW = next;
      rowH = Math.max(rowH, pages[i + n].h * k);
      n++;
    }
    width = Math.max(width, rowW + 2 * PAD);
    let x = Math.max(PAD, (viewW - rowW) / 2);
    for (let j = i; j < i + n; j++) {
      const s = { x, y, w: pages[j].w * k, h: pages[j].h * k };
      slots.push(s);
      x += s.w + gap;
    }
    y += rowH + gap;
    i += n;
  }
  return { slots, width, height: slots.length ? y - gap + PAD : 0, zoom, k };
}

/** The indices of the slots of `layout` that reach into the band from `top` to `bottom` (px). */
export function inView(layout, top, bottom) {
  const out = [];
  layout.slots.forEach((s, i) => {
    if (s.y < bottom && s.y + s.h > top) out.push(i);
  });
  return out;
}

/** The page point under content point (x, y) px of `layout`: the slot holding it, else the nearest one, with the offset clamped to
 * the page → {page, x, y} in pt, or null without pages. Points survive a zoom and a relayout, where px do not. */
export function pointAt(layout, x, y) {
  let best = null;
  let dist = Infinity;
  layout.slots.forEach((s, i) => {
    const dx = Math.max(s.x - x, 0, x - s.x - s.w);
    const dy = Math.max(s.y - y, 0, y - s.y - s.h);
    const d = dx * dx + dy * dy;
    if (d < dist) [best, dist] = [i, d];
  });
  if (best == null) return null;
  const s = layout.slots[best];
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  return { page: best, x: clamp(x - s.x, s.w) / layout.k, y: clamp(y - s.y, s.h) / layout.k };
}

/** The content point (px) of page point `p` in `layout`, or null when the page is gone. */
export function placeOf(layout, p) {
  const s = p && layout.slots[Math.min(p.page, layout.slots.length - 1)];
  return s ? { x: s.x + p.x * layout.k, y: s.y + p.y * layout.k } : null;
}

/** The scroll offsets that keep the page point under view point `anchor` ({x, y} px from the view's top left) where it was
 * when `prev` showed at `scroll` ({left, top}), now that `next` shows → {left, top}, or null when nothing holds. */
export function keepPoint(prev, next, scroll, anchor) {
  const p = pointAt(prev, scroll.left + anchor.x, scroll.top + anchor.y);
  const at = placeOf(next, p);
  return at && { left: Math.max(0, at.x - anchor.x), top: Math.max(0, at.y - anchor.y) };
}

/** The zoom at which a grid of `cols` by `rows` of the largest of `pages` fits a view `viewW` by `viewH` px (Multiple Pages). */
export const fitZoom = (pages, viewW, viewH, cols, rows) => fitGrid(pages, viewW, viewH, cols, rows, { gap: GAP, pad: PAD });

/** The Documents host's placements for session `session`: layoutPages' rows in world points (the page gap scales with the zoom, so
 * it is GAP x 3/4 pt at any zoom, and the pad stays PAD px, so it shrinks in points as the zoom grows) → {placements: [{key,
 * session, surface, x, y, w, h, paper}], extent: {x, y, w, h}}, the extent being the scrolling column with its pad. */
export function placePages(pages, zoom, viewW, cols = 0, session = null) {
  const l = layoutPages(pages, zoom, viewW, cols);
  const placements = l.slots.map((s, i) => ({ key: `${session ?? ''}:${i}`, session, surface: i, x: s.x / l.k, y: s.y / l.k, w: pages[i].w,
    h: pages[i].h, paper: pages[i].paper }));
  return { placements, extent: { x: 0, y: 0, w: l.width / l.k, h: l.height / l.k } };
}

// Surface arrangements beyond a scrolling column (docs/plans/engine/viewport-design.md sections 3 and 4.1, engine-gaps-views):
// a screen of surfaces side by side that fits the view and turns a screen at a time (Word's Side to Side and Read Mode's
// columns; a slide show's spread or a designer's frames later). A host gives sizes in points and the view in CSS px and gets
// placements in world points; a grid of small copies (thumbnails, a slide sorter) is a host's own column at a small zoom.
// Pure, so node tests load it.
import { kOf, PX_PER_PT } from './camera.mjs';

/** The first surface of the screen holding surface `i`: screens of `per` surfaces from the first, as a book's spreads. */
export const screenStart = (i, per, count) => {
  const at = Math.max(0, Math.min(i, count - 1));
  return at - (at % Math.max(1, per));
};

/** How many of the largest of `sizes` ([{w, h}] pt) a screen shows side by side, at most `most`, and the zoom that fits them
 * to a view `view` ({w, h} px) less a band `top` px at its top, `pad` px round them and `gap` px between them at 100 % (it
 * scales with the zoom): as many as fit across once the surfaces fit the view's height, at least one → {cols, zoom}. */
export function spread(sizes, view, { most = 2, gap = 0, pad = 0, top = 0, min = 0.05, max = 5 } = {}) {
  const w = Math.max(1, ...sizes.map((p) => p.w)) * PX_PER_PT;
  const h = Math.max(1, ...sizes.map((p) => p.h)) * PX_PER_PT;
  const room = { w: Math.max(1, view.w - 2 * pad), h: Math.max(1, view.h - top - 2 * pad) };
  const tall = room.h / h;
  let cols = 1;
  while (cols < most && (cols + 1) * w * tall + cols * gap * tall <= room.w) cols++;
  const zoom = Math.min(tall, room.w / (cols * w + (cols - 1) * gap));
  return { cols, zoom: Math.max(min, Math.min(max, zoom)) };
}

/** Surfaces `first` to `first + count` of `sizes` in one row, `gap` px apart at 100 %, at `zoom`, centred in view `view` ({w, h}
 * px) below a band `top` px tall → {placements: [{key, session, surface, x, y, w, h}], extent}. The extent is the view, so
 * nothing scrolls: a host turns screens by placing the next ones. */
export function screenRow(sizes, { first = 0, count = 1, zoom = 1, view, gap = 0, top = 0, session = null }) {
  const k = kOf(zoom);
  const shown = sizes.slice(first, first + count);
  const g = (gap * zoom) / k;
  const rowW = shown.reduce((s, p) => s + p.w, 0) + g * Math.max(0, shown.length - 1);
  const rowH = Math.max(0, ...shown.map((p) => p.h));
  const W = view.w / k;
  const H = view.h / k;
  const t = top / k;
  let x = Math.max(0, (W - rowW) / 2);
  const y = t + Math.max(0, (H - t - rowH) / 2);
  const placements = shown.map((p, i) => {
    const out = { key: `${session ?? ''}:${first + i}`, session, surface: first + i, x, y, w: p.w, h: p.h };
    x += p.w + g;
    return out;
  });
  return { placements, extent: { x: 0, y: 0, w: Math.max(W, rowW), h: Math.max(H, y + rowH) } };
}

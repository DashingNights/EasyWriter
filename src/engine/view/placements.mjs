// Placements (docs/plans/engine/viewport-design.md section 4.1): where a format host puts each surface of a session in the world,
// as {key, session, surface, x, y, w, h} in world points (a placement may also carry `paper`, the surface's colour). A placement
// only translates: the camera scales everything. A surface point is {session, surface, x, y} in points from the surface's top left;
// `page` is read as an alias of `surface`, as the session API keeps it. Pure, so node tests load it.

const same = (a, b) => (a ?? null) === (b ?? null);
const surfaceOf = (t) => t.surface ?? t.page;

/** The world rect {x, y, w, h} that holds every placement of `list`, or null for none. */
export function bounds(list) {
  if (!list.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of list) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w);
    y1 = Math.max(y1, p.y + p.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The placements of `list` that reach into world rect `r`, in list order. */
// ponytail: a linear scan, fine for a document's thousand pages; a grid index when a board holds thousands of placements.
export function visible(list, r) {
  return list.filter((p) => p.x < r.x + r.w && p.x + p.w > r.x && p.y < r.y + r.h && p.y + p.h > r.y);
}

/** The placement of surface `surface` of `session`, or undefined. */
export function find(list, session, surface) {
  return list.find((p) => p.surface === surface && same(p.session, session));
}

/** The topmost placement under world point `w` (later in the list is above) → {placement, session, surface, x, y} with the
 * surface point, or null over no surface (section 4.6's first step). */
export function hit(list, w) {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (w.x >= p.x && w.x < p.x + p.w && w.y >= p.y && w.y < p.y + p.h) return { placement: p, session: p.session, surface: p.surface, x: w.x - p.x, y: w.y - p.y };
  }
  return null;
}

/** The surface point of the placement nearest world point `w`, its offset clamped to the surface → {session, surface, x, y}, or
 * null without placements. A click in the gap between pages lands on the nearest page; surface points survive a zoom and a
 * relayout, where world points of a Documents column do not. */
export function nearest(list, w) {
  let best = null;
  let dist = Infinity;
  for (const p of list) {
    const dx = Math.max(p.x - w.x, 0, w.x - p.x - p.w);
    const dy = Math.max(p.y - w.y, 0, w.y - p.y - p.h);
    const d = dx * dx + dy * dy;
    if (d < dist) [best, dist] = [p, d];
  }
  if (!best) return null;
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  return { session: best.session, surface: best.surface, x: clamp(w.x - best.x, best.w), y: clamp(w.y - best.y, best.h) };
}

/** The world point of surface point `t`, or null when its surface has no placement. */
export function worldOf(list, t) {
  const p = t && find(list, t.session, surfaceOf(t));
  return p ? { x: p.x + t.x, y: p.y + t.y } : null;
}

/** The world rect of surface rect `r` ({session, surface, x, y, w, h}), or null when its surface has no placement. */
export function worldRect(list, r) {
  const w = worldOf(list, r);
  return w && { x: w.x, y: w.y, w: r.w ?? 0, h: r.h ?? 0 };
}

// The board's pure gestures (docs/plans/board/briefs/bd-select.md): boxes, turned boxes and corners, move, resize, rotate and
// marquee. No DOM, no store write and no engine call, so node tests load it. Points throughout, clockwise rotation (screen y is
// down), which is the engine's own order (engine/crates/board: flips in the item's frame, then the turn about the page centre).
import { derived } from './surfaces.mjs';

export const DRAG_PX = 3; // CSS px a press must move before it is a drag
export const NUDGE = 1; // points one arrow press moves
export const BIG_NUDGE = 10; // points one Shift+arrow press moves
export const TURN_STEP = 15; // degrees Shift snaps a rotation to

const r6 = (n) => Math.round(n * 1e6) / 1e6; // a point to 1e-6, so a turned 90 is 25 and not 25.000000000000004
const rad = (deg) => (deg * Math.PI) / 180;
const centreOf = (box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** Point `p` turned `deg` clockwise about `c`. */
function turn(p, c, deg) {
  const a = rad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: r6(c.x + dx * cos - dy * sin), y: r6(c.y + dx * sin + dy * cos) };
}

/** An item's box {x, y, w, h}: stored, derived through its type's registry rule, or, for a group, the union of its children's
 * turned boxes (a group keeps no geometry of its own). A group with no live children (a merge can leave one) has no box, rather
 * than one at the origin: its callers skip it, as every union already skips a null. */
export function boxOf(item, store) {
  const d = item ? derived(item, store) : null;
  if (d && d.w != null && d.h != null) return { x: d.x ?? 0, y: d.y ?? 0, w: d.w, h: d.h };
  if (item?.type === 'group' && store) {
    return unionBox(store.children(item.id).map((child) => turnedBox(boxOf(child, store), child.rot ?? 0)));
  }
  return { x: d?.x ?? 0, y: d?.y ?? 0, w: d?.w ?? 0, h: d?.h ?? 0 };
}

/** The item ids a drag carried, for its end hook: a move's ids, a turn's base keys, else the one item a resize works on. */
export function dragIds(drag) {
  return drag?.ids ?? (drag?.base ? Object.keys(drag.base) : drag?.id ? [drag.id] : []);
}

/** The edge-pan speed at `depth` px past the view's edge line: 0 at the line, 1 at and beyond `m` px, never more. */
export const edgeDepth = (depth, m) => Math.min(1, Math.abs(depth) / m);

/** The smallest box round `boxes`, or null for none. */
export function unionBox(boxes) {
  const list = (boxes ?? []).filter(Boolean);
  if (!list.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of list) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: r6(x0), y: r6(y0), w: r6(x1 - x0), h: r6(y1 - y0) };
}

/** `box`'s four corners (nw, ne, se, sw) turned `rot` degrees clockwise about its centre; none for no box. */
export function turnedCorners(box, rot = 0) {
  if (!box) return [];
  const c = centreOf(box);
  const corners = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h }];
  return corners.map((p) => turn(p, c, rot));
}

/** The box round `box` turned `rot` degrees about its centre. */
export function turnedBox(box, rot = 0) {
  return unionBox(turnedCorners(box, rot).map((p) => ({ ...p, w: 0, h: 0 })));
}

/** `start` {x, y} moved by `dx`, `dy`; Shift keeps the axis the press moved further along. */
export function moved(start, dx, dy, { shift = false } = {}) {
  if (shift) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  return { x: r6(start.x + dx), y: r6(start.y + dy) };
}

/** The rotation `startRot` plus the turn from `from` to `to` about `centre`, snapped to fifteen degree steps for Shift. */
export function rotated(startRot, centre, from, to, { shift = false } = {}) {
  const angle = (p) => (Math.atan2(p.y - centre.y, p.x - centre.x) * 180) / Math.PI;
  let out = startRot + angle(to) - angle(from);
  if (shift) out = Math.round(out / TURN_STEP) * TURN_STEP;
  return r6(out);
}

/**
 * Box `start` {x, y, w, h} resized by handle `nw`..`w` with a world delta `dx`, `dy` → {x, y, w, h, flipX, flipY}. The delta
 * is read in the item's own axes when `rot` is set, and the corner opposite the handle holds in the world. Shift keeps the
 * aspect, the larger relative change winning; Alt holds the centre. Past the opposite edge the box flips.
 */
export function resized(start, handle, dx, dy, { shift = false, alt = false, rot = 0 } = {}) {
  const { x, y, w, h } = start;
  const a = rad(rot);
  const lx = dx * Math.cos(a) + dy * Math.sin(a);
  const ly = -dx * Math.sin(a) + dy * Math.cos(a);
  const hx = /w/.test(handle) ? -1 : /e/.test(handle) ? 1 : 0;
  const hy = /n/.test(handle) ? -1 : /s/.test(handle) ? 1 : 0;
  let [L, T, R, B] = [x, y, x + w, y + h];
  if (hx === 1) { R += lx; if (alt) L -= lx; } else if (hx === -1) { L += lx; if (alt) R -= lx; }
  if (hy === 1) { B += ly; if (alt) T -= ly; } else if (hy === -1) { T += ly; if (alt) B -= ly; }
  if (shift) {
    const sx = w ? (R - L) / w : 1;
    const sy = h ? (B - T) / h : 1;
    const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    const width = w * s;
    const height = h * s;
    if (hx) {
      if (alt) { const c = (L + R) / 2; L = c - width / 2; R = c + width / 2; } else if (hx === 1) R = L + width;
      else L = R - width;
    } else {
      const c = (L + R) / 2;
      L = c - width / 2;
      R = c + width / 2;
    }
    if (hy) {
      if (alt) { const c = (T + B) / 2; T = c - height / 2; B = c + height / 2; } else if (hy === 1) B = T + height;
      else T = B - height;
    } else {
      const c = (T + B) / 2;
      T = c - height / 2;
      B = c + height / 2;
    }
  }
  if (Math.abs(R - L) < 1) R = L + (R < L ? -1 : 1); // minimum 1 pt
  if (Math.abs(B - T) < 1) B = T + (B < T ? -1 : 1);
  const c0 = { x: x + w / 2, y: y + h / 2 };
  const c1 = { x: (L + R) / 2, y: (T + B) / 2 };
  // The point held in the world: the centre under Alt, else the corner or edge opposite the handle.
  const ax0 = alt ? c0.x : hx === 1 ? x : hx === -1 ? x + w : c0.x;
  const ay0 = alt ? c0.y : hy === 1 ? y : hy === -1 ? y + h : c0.y;
  const ax = alt ? c1.x : hx === 1 ? L : hx === -1 ? R : c1.x;
  const ay = alt ? c1.y : hy === 1 ? T : hy === -1 ? B : c1.y;
  const was = turn({ x: ax0, y: ay0 }, c0, rot);
  const now = turn({ x: ax, y: ay }, c1, rot);
  const flipX = !!start.flipX !== R < L;
  const flipY = !!start.flipY !== B < T;
  return { x: r6(Math.min(L, R) + was.x - now.x), y: r6(Math.min(T, B) + was.y - now.y),
    w: r6(Math.max(1, Math.abs(R - L))), h: r6(Math.max(1, Math.abs(B - T))), flipX, flipY };
}

/** The ids of `boxes` ([{id, box}]) whose box meets world rect `rect` {x, y, w, h}. */
export function marqueeHits(rect, boxes) {
  const [x0, x1] = [Math.min(rect.x, rect.x + rect.w), Math.max(rect.x, rect.x + rect.w)];
  const [y0, y1] = [Math.min(rect.y, rect.y + rect.h), Math.max(rect.y, rect.y + rect.h)];
  return (boxes ?? []).filter(({ box }) => box.x < x1 && box.x + box.w > x0 && box.y < y1 && box.y + box.h > y0).map((b) => b.id);
}

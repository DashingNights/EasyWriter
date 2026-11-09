// The tile planner (docs/plans/engine/viewport-design.md section 4.3, measure.md's decisions): which 512 px tiles a viewport wants
// painted, which held tiles it shows (a tile at an old scale or of an old layout stays, stretched, until its replacement lands) and
// which it drops to stay within the budget. The tile layer (tiles.js) keeps the canvases; this keeps the choices, so node tests
// load it.
//
// A tile is {session, surface, scale, col, row, w, h, opts}: `scale` device px per point (zoom x 4/3 x dpr),
// `col` and `row` its place in the surface's grid of TILE device px, `w` and `h` the surface's size in points, `opts` the
// session's paint options version (forced colours), so a change of options re-keys every tile of the session. A held tile also
// has `used` (the frame it last showed in) and `dirty` (a layout change damaged it: it shows until it is repainted).
import { PX_PER_PT } from './camera.mjs';
import { visible } from './placements.mjs';

export const TILE = 512; // device px a side: a 512 tile paints in a quarter of a 1,024 tile's time (measure.md)
// Full tiles' worth of pixels held per viewport: the plan's 256 MiB at the measured 3.5 MiB a tile (renderer and GPU memory,
// measure.md section 6), so 72. A 2,560 x 1,440 view needs about 24 tiles at dpr 1 and 54 at dpr 1.5, so scroll-back keeps
// about two views at dpr 1 and a third of one at dpr 1.5 (bench.log, engine-keystroke). A tile counts by its share of a full
// tile's pixels (weight), so Multiple Pages at 10 %, a small tile a page, holds every page in view.
export const BUDGET = 72;

/** The paint scale at `zoom` on a screen of device pixel ratio `dpr`: device px per point, rounded to a millionth so a key
 * compares exactly. Not to 1/64, as the design first had it: 100 % is 4/3 px a point, no multiple of 1/64, and a tile painted
 * at a rounded scale shows stretched, so its text blurs and drifts from the overlay by up to 3 px a page. */
export const scaleOf = (zoom, dpr) => Math.round(zoom * PX_PER_PT * (dpr || 1) * 1e6) / 1e6;

export const keyOf = (t) => `${t.session ?? ''}|${t.surface}|${t.opts ?? 0}|${t.scale}|${t.col}|${t.row}`;

/** Tile `t`'s rect in its surface's points, cut at the surface's edge. */
export function tileRect(t) {
  const side = TILE / t.scale;
  const x = t.col * side;
  const y = t.row * side;
  return { x, y, w: Math.min(side, (t.w ?? Infinity) - x), h: Math.min(side, (t.h ?? Infinity) - y) };
}

/** Tile `t`'s share of a full tile's pixels: a tile cut at its surface's edge, or a whole small page, counts for less. */
export function weight(t) {
  const r = tileRect(t);
  return Math.min(1, (r.w * t.scale * r.h * t.scale) / (TILE * TILE));
}

const meets = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const sameSurface = (a, b) => (a.session ?? null) === (b.session ?? null) && a.surface === b.surface && (a.opts ?? 0) === (b.opts ?? 0);

/** The tiles of placement `p` at `scale` that meet world rect `r`. */
export function tilesIn(p, r, scale, opts = 0) {
  const side = TILE / scale;
  const cols = Math.ceil((p.w * scale) / TILE);
  const rows = Math.ceil((p.h * scale) / TILE);
  const c0 = Math.max(0, Math.floor((r.x - p.x) / side));
  const c1 = Math.min(cols, Math.ceil((r.x + r.w - p.x) / side));
  const r0 = Math.max(0, Math.floor((r.y - p.y) / side));
  const r1 = Math.min(rows, Math.ceil((r.y + r.h - p.y) / side));
  const out = [];
  for (let row = r0; row < r1; row++) {
    for (let col = c0; col < c1; col++) out.push({ session: p.session, surface: p.surface, scale, col, row, w: p.w, h: p.h, opts });
  }
  return out;
}

/** The tiles a view wants over placements `list` at `scale`: those meeting world rect `view` (`visible: true`), nearest `focus`
 * (the caret or the pointer, a world point; the view's centre by default) first, then a ring of `ring` tiles round the view and,
 * with `dir` ({x, y} signs of the last scroll), the next view that way, nearest the view first. `opts(session)` gives a session's
 * paint options version. Each tile carries its `key`. */
export function wanted(list, view, scale, { focus, dir, ring = 1, opts = () => 0 } = {}) {
  const m = (ring * TILE) / scale;
  const area = { x: view.x - m, y: view.y - m, w: view.w + 2 * m, h: view.h + 2 * m };
  if (dir?.x) {
    area.w += view.w;
    if (dir.x < 0) area.x -= view.w;
  }
  if (dir?.y) {
    area.h += view.h;
    if (dir.y < 0) area.y -= view.h;
  }
  const f = focus ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  const out = [];
  for (const p of visible(list, area)) {
    for (const t of tilesIn(p, area, scale, opts(p.session))) {
      const r = tileRect(t);
      const w = { x: p.x + r.x, y: p.y + r.y, w: r.w, h: r.h };
      const dx = Math.max(w.x - f.x, 0, f.x - w.x - w.w);
      const dy = Math.max(w.y - f.y, 0, f.y - w.y - w.h);
      out.push({ ...t, key: keyOf(t), visible: meets(w, view), d: dx * dx + dy * dy });
    }
  }
  return out.sort((a, b) => b.visible - a.visible || a.d - b.d);
}

/** Whether a held tile of `t`'s surface at another scale meets tile `t`: it shows there, stretched, until `t` is painted. */
export function standIn(held, t) {
  const r = tileRect(t);
  for (const h of held.values()) if (h.scale !== t.scale && sameSurface(h, t) && meets(tileRect(h), r)) return true;
  return false;
}

/** How much coarser a rough tile is than the view's: one covers sixteen of the view's tiles and paints in about one's time. */
export const ROUGH = 4;

/** The rough tiles a view wishes before its own (low-resolution tiles, as Chrome paints them): for each visible tile of
 * `want` with nothing to show (not held, no stand-in), the tiles at 1/ROUGH of its scale over it, so a jump or a stop on a
 * heavy page shows the page, blurred, after one cheap paint and not after a dozen. None for a surface one tile holds, as
 * at 10 %. Each carries its `key`; they are not `visible`, so they never count as wanted tiles of the view. */
export function rough(held, want, factor = ROUGH) {
  const out = new Map();
  for (const t of want) {
    if (!t.visible || held.has(t.key) || (t.w * t.scale <= TILE && t.h * t.scale <= TILE) || standIn(held, t)) continue;
    const scale = Math.round((t.scale / factor) * 1e6) / 1e6;
    const p = { session: t.session, surface: t.surface, x: 0, y: 0, w: t.w, h: t.h };
    for (const c of tilesIn(p, tileRect(t), scale, t.opts)) {
      const key = keyOf(c);
      if (!out.has(key)) out.set(key, { ...c, key, visible: false });
    }
  }
  return [...out.values()];
}

/** One frame's choice over `held` (Map key → held tile) for `want` (wanted()'s list), `budget` counted in weight() →
 *   need: the wanted tiles with no current paint, in want's order, up to `budget`;
 *   show: keys of the held tiles to show: each visible wanted tile's own when held (a dirty one too, until it is repainted),
 *     else the held tiles of its surface at other scales that cover part of it, stretched;
 *   drop: keys to free: tiles at another scale whose area the current scale's clean tiles cover (they never show again), then,
 *     over `budget`, those not shown, unwanted before wanted ahead, stale before clean, least recently shown first. */
export function plan(held, want, budget = BUDGET) {
  const clean = (k) => held.has(k) && !held.get(k).dirty;
  const need = [];
  let room = budget;
  for (const t of want) {
    if (clean(t.key)) continue;
    room -= weight(t);
    if (room < 0) break;
    need.push(t);
  }
  const show = new Set();
  const scale = want[0]?.scale;
  for (const t of want) {
    if (!t.visible) continue;
    if (held.has(t.key)) {
      show.add(t.key);
      continue;
    }
    const r = tileRect(t);
    for (const [k, h] of held) if (h.scale !== t.scale && sameSurface(h, t) && meets(tileRect(h), r)) show.add(k);
  }
  // An old-scale tile is covered when every current-scale tile over its area is held clean.
  const covered = (h) => {
    if (scale == null) return false;
    const r = tileRect(h);
    return tilesIn({ session: h.session, surface: h.surface, x: 0, y: 0, w: h.w, h: h.h }, r, scale, h.opts)
      .every((t) => clean(keyOf(t)));
  };
  const drop = [];
  let over = -budget;
  for (const [k, h] of held) {
    if (!show.has(k) && h.scale !== scale && covered(h)) drop.push(k);
    else over += weight(h);
  }
  if (over > 0) {
    const gone = new Set(drop);
    const wantedKeys = new Set(want.map((t) => t.key));
    const rank = ([k, h]) => [wantedKeys.has(k) ? 1 : 0, h.scale !== scale || h.dirty ? 0 : 1, h.used ?? 0];
    const order = (a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    };
    const rest = [...held].filter(([k]) => !show.has(k) && !gone.has(k)).sort(order);
    for (const [k, h] of rest) {
      if (over <= 0) break;
      drop.push(k);
      over -= weight(h);
    }
  }
  return { need, show: [...show], drop };
}

/** Whether tile `t` ({surface, scale, col, row}, a held tile or a worker's wish), painted at layout version `have`, still shows
 * what layout event `e` draws: `e.damage` names its surface with `since` equal to `have`, and none of its rects, grown by a
 * device pixel for antialiasing, meets the tile (the wrapper crate's tiles.rs `damage`). The worker and the tile layer both
 * apply it to every event, so they agree on which tiles repaint without a message about the others. */
export function untouched(t, have, e) {
  const d = e.damage?.find((x) => x.surface === t.surface);
  if (!d || have == null || d.since !== have) return false;
  const r = tileRect(t);
  const m = 1 / t.scale;
  return !d.rects.some((q) => meets({ x: q.x - m, y: q.y - m, w: q.w + 2 * m, h: q.h + 2 * m }, r));
}

/** The keys of the held tiles that layout damage `damage` ([{session, surface, x, y, w, h}] in points) meets: they repaint and
 * show their old pixels meanwhile. */
export function damaged(held, damage) {
  const out = [];
  for (const [k, h] of held) {
    const r = tileRect(h);
    if (damage.some((d) => sameSurface({ ...d, surface: d.surface ?? d.page, opts: h.opts }, h) && meets(d, r))) out.push(k);
  }
  return out;
}

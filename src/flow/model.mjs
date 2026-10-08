// Flowchart data model (docs/plans/flowchart.md §3.3, SPEC §6d): connector validation and defaults, dangling-end repair,
// moving, cloning, hit-testing, aligning and resizing board items. Pure (no DOM): whiteboard.js, route.mjs and the Node tests share it.
import { anchorPoint, outlineOf, portsOf, rotatePoint, rotBox } from './shapes.mjs';

export const ROUTES = ['straight', 'ortho', 'curve'];
export const DASHES = ['solid', 'dashed', 'dotted'];
export const JUMPS = ['none', 'arc', 'gap'];
export const HEADS = ['none', 'arrow', 'triangle', 'triangle-open', 'diamond', 'diamond-open', 'circle', 'circle-open', 'bar', 'cross',
  'one', 'many', 'one-many', 'zero-one', 'zero-many', 'exactly-one'];
export const LABEL_SLOTS = { start: 0.15, mid: 0.5, end: 0.85 }; // slot → default t (fraction of the path from the `from` end)
export const MAX_POINTS = 32;
const DERIVED = ['x', 'y', 'w', 'h', 'd', 'tips', 'lps']; // written by resolveConnectors (route.mjs)
export const ANCHOR_NAMES = { n: [0.5, 0], e: [1, 0.5], s: [0.5, 1], w: [0, 0.5], ne: [1, 0], nw: [0, 0], se: [1, 1], sw: [0, 1], c: [0.5, 0.5] };

const num = Number.isFinite;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fit = (v, min, max) => Math.max(min, Math.min(v, max));
const bound = (e) => typeof e?.item === 'string';

// An end: bound {item, anchor: null (floating) | [rx, ry] in 0..1 | an anchor name} or free {x, y}.
const validEnd = (e) => isObj(e) && (bound(e)
  ? e.anchor == null || Object.hasOwn(ANCHOR_NAMES, e.anchor) || (Array.isArray(e.anchor) && e.anchor.length === 2 && e.anchor.every((v) => num(v) && v >= 0 && v <= 1))
  : num(e.x) && num(e.y));

/** A connector item parseBoard keeps: valid ends; optional fields, when present, of the right kind. */
export function validConnector(c) {
  const opt = (v, ok) => v === undefined || ok(v);
  const oneOf = (list) => (v) => list.includes(v);
  return validEnd(c.from) && validEnd(c.to) && opt(c.route, oneOf(ROUTES)) && opt(c.dash, oneOf(DASHES)) && opt(c.jump, oneOf(JUMPS)) &&
    opt(c.heads, (h) => isObj(h) && opt(h.start, oneOf(HEADS)) && opt(h.end, oneOf(HEADS))) &&
    opt(c.points, (p) => Array.isArray(p) && p.every((q) => isObj(q) && num(q.x) && num(q.y))) &&
    ['corner', 'width', 'opacity'].every((k) => opt(c[k], num)) && opt(c.color, (v) => typeof v === 'string') &&
    opt(c.labels, isObj) && opt(c.label, (v) => typeof v === 'string');
}

/** Defaults filled, anchor names → fractions, a string `label` → labels.mid, label slots cleaned (start | mid | end with a
 * non-empty html; t clamped to 0..1), at most MAX_POINTS waypoints; derived fields that are not all valid are dropped (the next
 * resolve writes them). */
export function cleanConnector(c) {
  const end = (e) => (bound(e)
    ? { item: e.item, anchor: typeof e.anchor === 'string' ? [...ANCHOR_NAMES[e.anchor]] : e.anchor ? [e.anchor[0], e.anchor[1]] : null }
    : { x: e.x, y: e.y });
  const { label, ...rest } = c;
  const src = { ...(typeof label === 'string' && { mid: { html: label } }), ...(isObj(c.labels) ? c.labels : {}) };
  const labels = {};
  for (const [slot, t] of Object.entries(LABEL_SLOTS)) {
    const l = src[slot];
    if (!isObj(l) || typeof l.html !== 'string' || !l.html) continue;
    labels[slot] = {
      html: l.html, t: num(l.t) ? fit(l.t, 0, 1) : t, dx: num(l.dx) ? l.dx : 0, dy: num(l.dy) ? l.dy : 0,
      size: num(l.size) && l.size > 0 ? l.size : 14, textColor: typeof l.textColor === 'string' ? l.textColor : '#ffffff', bold: l.bold === true,
    };
  }
  const out = {
    route: 'ortho', corner: 8, color: '#ffffff', width: 2, opacity: 1, dash: 'solid', jump: 'none', ...rest,
    from: end(c.from), to: end(c.to), heads: { start: 'none', end: 'arrow', ...c.heads },
    points: (c.points ?? []).slice(0, MAX_POINTS).map(({ x, y }) => ({ x, y })), labels,
  };
  const derived = ['x', 'y', 'w', 'h'].every((k) => num(out[k])) && typeof out.d === 'string' && isObj(out.lps) &&
    Array.isArray(out.tips) && out.tips.length === 2 && out.tips.every((t) => isObj(t) && num(t.x) && num(t.y) && num(t.a));
  if (!derived) for (const k of DERIVED) delete out[k];
  return out;
}

/** {x, y, w, h}: an item's unrotated box. Text without a stored `h`: the estimate size · 1.3 · lines + 12. */
export function defaultMeasure(i) {
  if (i.type !== 'text' || num(i.h)) return { x: i.x, y: i.y, w: i.w, h: i.h };
  const lines = 1 + (String(i.html).match(/<br|<div|<p[\s>]/gi)?.length ?? 0);
  return { x: i.x, y: i.y, w: i.w, h: Math.round((i.size || 20) * 1.3 * lines + 12) };
}

const centreOf = (i) => {
  const b = defaultMeasure(i);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};

/** Connector ends bound to an item that is not among `items` (or is a connector): (a) free at the end's stored tip; (b) without
 * tips, free 100 px right of the other end (its item's centre or its point); (c) neither resolves: the connector is dropped.
 * → `items` itself when nothing needed repair. */
export function repairEnds(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ok = (e) => !bound(e) || (byId.has(e.item) && byId.get(e.item).type !== 'connector');
  if (items.every((c) => c.type !== 'connector' || (ok(c.from) && ok(c.to)))) return items;
  const out = [];
  for (const c of items) {
    if (c.type !== 'connector' || (ok(c.from) && ok(c.to))) {
      out.push(c);
      continue;
    }
    const ends = [c.from, c.to].map((e, k) => {
      if (ok(e)) return e;
      const tip = c.tips?.[k];
      return tip && num(c.x) && num(c.y) ? { x: c.x + tip.x, y: c.y + tip.y } : null;
    });
    for (const k of [0, 1]) {
      const other = ends[1 - k];
      if (ends[k] || !other) continue;
      const ref = bound(other) ? centreOf(byId.get(other.item)) : other;
      ends[k] = { x: ref.x + 100, y: ref.y };
    }
    if (ends[0] && ends[1]) out.push({ ...c, from: ends[0], to: ends[1] });
  }
  return out;
}

/** `items` without the ids in `removed` (a Set); ends bound to them become free at their tips (repairEnds). */
export const unbindFrom = (items, removed) => repairEnds(items.filter((i) => !removed.has(i.id)));

/** A copy of `item` moved by dx, dy: its box, and for a connector its free ends and waypoints (bound ends stay on their item,
 * so the route re-flows; the derived d / tips / lps are bbox-relative and stay). */
export function moveItem(item, dx, dy) {
  const out = { ...item, x: item.x + dx, y: item.y + dy };
  if (item.type !== 'connector') return out;
  const end = (e) => (bound(e) ? e : { x: e.x + dx, y: e.y + dy });
  return { ...out, from: end(item.from), to: end(item.to), points: (item.points ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

/** Deep copies with new ids (`makeId()`); connector ends bound inside the copied set follow the copies, ends bound outside it
 * become free at their tips. */
export function cloneItems(items, makeId) {
  const ids = new Map(items.map((i) => [i.id, makeId()]));
  return items.map((i) => {
    const copy = { ...structuredClone(i), id: ids.get(i.id) };
    if (i.type !== 'connector') return copy;
    const end = (e, k) => {
      if (!bound(e)) return e;
      if (ids.has(e.item)) return { ...e, item: ids.get(e.item) };
      const tip = i.tips?.[k];
      return tip ? { x: i.x + tip.x, y: i.y + tip.y } : e;
    };
    return { ...copy, from: end(copy.from, 0), to: end(copy.to, 1) };
  });
}

/** Map item id → Set of the ids of the connectors bound to it. */
export function boundIndex(items) {
  const index = new Map();
  for (const c of items) {
    if (c.type !== 'connector') continue;
    for (const e of [c.from, c.to]) {
      if (!bound(e)) continue;
      if (!index.has(e.item)) index.set(e.item, new Set());
      index.get(e.item).add(c.id);
    }
  }
  return index;
}

// Even-odd point in polygon ([{x, y}]).
function inside(poly, p) {
  let hit = false;
  for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
    const [a, b] = [poly[k], poly[j]];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** What a connector end at board point `p` sticks to: the topmost item (reverse z-order; connectors and `exclude` ids never)
 * with a port within `tol` → {item, anchor: port}, or whose turned outline holds p → {item, anchor: null}; else null.
 * Geometric, so unfilled and rotated shapes hit as drawn. `measure(item)` → its unrotated box (default defaultMeasure). */
export function hitTarget(items, p, { exclude = new Set(), tol = 0, measure = defaultMeasure } = {}) {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it.type === 'connector' || exclude.has(it.id)) continue;
    const b = measure(it);
    const port = portsOf(it).find((a) => {
      const q = anchorPoint(it, a, b);
      return Math.hypot(q.x - p.x, q.y - p.y) <= tol;
    });
    if (port) return { item: it.id, anchor: port };
    if (inside(outlineOf(it, b), p)) return { item: it.id, anchor: null };
  }
  return null;
}

/** The ids of the non-connector items whose (turned) box lies fully inside `container`'s (a lane or frame moving its content). */
export function containedIn(container, items, measure = defaultMeasure) {
  const c = rotBox({ ...measure(container), rot: container.rot });
  return items.filter((i) => {
    if (i === container || i.type === 'connector') return false;
    const b = rotBox({ ...measure(i), rot: i.type === 'shape' ? i.rot : 0 });
    return b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h;
  }).map((i) => i.id);
}

// --- arrangement (§6d Arrange): pure over boxes {x, y, w, h}, in order; the input is never changed ---

const bounds = (boxes) => {
  const [x, y] = [Math.min(...boxes.map((b) => b.x)), Math.min(...boxes.map((b) => b.y))];
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

/** The boxes moved onto their group box's left | centre | right | top | middle | bottom (edge or centre line). The Board
 * passes item bounds (a turned shape: its turned box) and moves each item by its box's change. */
export function align(boxes, where) {
  const g = bounds(boxes);
  const to = {
    left: () => ({ x: g.x }), centre: (b) => ({ x: g.x + (g.w - b.w) / 2 }), right: (b) => ({ x: g.x + g.w - b.w }),
    top: () => ({ y: g.y }), middle: (b) => ({ y: g.y + (g.h - b.h) / 2 }), bottom: (b) => ({ y: g.y + g.h - b.h }),
  }[where];
  return boxes.map((b) => ({ ...b, ...to(b) }));
}

/** Equal gaps between the boxes along axis 'h' (x) | 'v' (y), taken in their order along it; the first and the last stay.
 * Fewer than three: unchanged. */
export function distribute(boxes, axis) {
  const out = boxes.map((b) => ({ ...b }));
  if (boxes.length < 3) return out;
  const [p, s] = axis === 'h' ? ['x', 'w'] : ['y', 'h'];
  const order = boxes.map((_, k) => k).sort((a, b) => boxes[a][p] - boxes[b][p]);
  const [first, last] = [boxes[order[0]], boxes[order.at(-1)]];
  const gap = (last[p] + last[s] - first[p] - boxes.reduce((n, b) => n + b[s], 0)) / (boxes.length - 1);
  let at = first[p];
  for (const k of order) {
    out[k][p] = at;
    at += boxes[k][s] + gap;
  }
  return out;
}

/** Every box with the largest width ('w') or height ('h') among them; a turned one ({rot}) keeps its centre, the others
 * their top-left. */
export function sameSize(boxes, axis) {
  const max = Math.max(...boxes.map((b) => b[axis]));
  const p = axis === 'w' ? 'x' : 'y';
  return boxes.map((b) => ({ ...b, [axis]: max, ...(b.rot && { [p]: b[p] - (max - b[axis]) / 2 }) }));
}

/** A resize of box `start` ({x, y, w, h, rot}) by `handle` (corner nw ne sw se, edge n e s w) moved dx, dy board px, done in
 * the item's own frame: the move turned by −rot, the box resized with the opposite corner (edge) fixed, then placed so that
 * point keeps its board position (Konva Transformer). `aspect`: one scale for both axes (corners only); `min`: the smallest
 * side, or a side's start size when that is smaller. Sizes whole px. → {x, y, w, h}. */
export function resizeInFrame(start, handle, dx, dy, { aspect = false, min = 20 } = {}) {
  const rot = start.rot || 0;
  const d = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -rot);
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  let [w, h] = [start.w + sx * d.x, start.h + sy * d.y];
  if (aspect && sx && sy) {
    const k = (start.w * w + start.h * h) / (start.w ** 2 + start.h ** 2); // the pointer projected on the diagonal
    const s = Math.max(k, Math.min(1, min / Math.max(start.w, start.h)));
    [w, h] = [Math.max(1, Math.round(start.w * s)), Math.max(1, Math.round(start.h * s))];
  } else {
    w = sx ? Math.max(Math.min(min, start.w), Math.round(w)) : start.w;
    h = sy ? Math.max(Math.min(min, start.h), Math.round(h)) : start.h;
  }
  // The fixed point, from the box's top-left in the item frame: the opposite corner, or the middle of the opposite edge.
  const fixed = (bw, bh) => ({ x: sx > 0 ? 0 : sx < 0 ? bw : bw / 2, y: sy > 0 ? 0 : sy < 0 ? bh : bh / 2 });
  const f0 = fixed(start.w, start.h);
  const F = rotatePoint({ x: start.x + f0.x, y: start.y + f0.y }, { x: start.x + start.w / 2, y: start.y + start.h / 2 }, rot);
  const f1 = fixed(w, h);
  const v = rotatePoint({ x: f1.x - w / 2, y: f1.y - h / 2 }, { x: 0, y: 0 }, rot); // the fixed point from the new centre
  const r2 = (n) => Math.round(n * 100) / 100;
  return { x: r2(F.x - v.x - w / 2), y: r2(F.y - v.y - h / 2), w, h };
}

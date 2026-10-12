// Flowchart data model (docs/plans/flowchart.md §3.3, SPEC §6d): connector validation and defaults, dangling-end repair,
// moving, cloning, hit-testing, aligning and resizing board items. Pure (no DOM): whiteboard.js, route.mjs and the Node tests share it.
import { anchorPoint, outlineOf, portsOf, rotatePoint, rotBox, rotOf } from './shapes.mjs';

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
  ? (e.anchor == null || Object.hasOwn(ANCHOR_NAMES, e.anchor) || (Array.isArray(e.anchor) && e.anchor.length === 2 && e.anchor.every((v) => num(v) && v >= 0 && v <= 1)))
    && (e.pin === undefined || typeof e.pin === 'boolean')
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
  const end = (e) => {
    if (!bound(e)) return { x: e.x, y: e.y };
    const anchor = typeof e.anchor === 'string' ? [...ANCHOR_NAMES[e.anchor]] : e.anchor ? [e.anchor[0], e.anchor[1]] : null;
    return { item: e.item, anchor, ...(e.pin === true && anchor && { pin: true }) }; // pin: the tip at the anchor itself (§6d)
  };
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
  return cleanLayers(out);
}

// --- layers (SPEC §6 Layer fields; docs/plans/board-tools-layers.md Layering) ---

const GROUP_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Item `out` (changed in place) without layer fields of the wrong kind: `hidden` and `locked` only as true, `groups` only as a
 * non-empty array of distinct group ids, innermost first. */
export function cleanLayers(out) {
  for (const k of ['hidden', 'locked']) if (k in out && out[k] !== true) delete out[k];
  const g = out.groups;
  const ok = Array.isArray(g) && g.length && g.every((id) => typeof id === 'string' && GROUP_ID.test(id)) && new Set(g).size === g.length;
  if (g !== undefined && !ok) delete out.groups;
  return out;
}

/** `items` with their groups made whole: (3) items that share an inner group share its outer groups (the chain of the topmost
 * item naming that group wins); (1) a group id stays only while 2 or more items carry it; (2) a group's members sit next to each
 * other, gathered at its topmost member's place in z-order (nested groups likewise). Runs on a whole board's items only (Board
 * render and commit, the agent writes' settle), never on one item. → `items` itself when nothing changed. */
export function normalizeGroups(items) {
  if (!items.some((i) => i.groups)) return items;
  const parent = new Map(); // group id → its outer group id | null
  for (let k = items.length - 1; k >= 0; k--) {
    const gs = items[k].groups ?? [];
    for (let j = 0; j < gs.length && !parent.has(gs[j]); j++) parent.set(gs[j], gs[j + 1] ?? null);
  }
  const chain = (g) => {
    const out = [];
    for (; g && !out.includes(g); g = parent.get(g)) out.push(g);
    return out;
  };
  let lists = items.map((i) => (i.groups?.length ? chain(i.groups[0]) : []));
  const count = new Map();
  for (const l of lists) for (const g of l) count.set(g, (count.get(g) ?? 0) + 1);
  lists = lists.map((l) => l.filter((g) => count.get(g) > 1));
  // Sort key: each enclosing group's topmost member index, outermost first, then the item's own index.
  const top = new Map();
  lists.forEach((l, k) => l.forEach((g) => top.set(g, k)));
  const keys = lists.map((l, k) => [...l.map((g) => top.get(g)).reverse(), k]);
  const order = items.map((_, k) => k).sort((a, b) => {
    const [p, q] = [keys[a], keys[b]];
    for (let j = 0; j < Math.min(p.length, q.length); j++) if (p[j] !== q[j]) return p[j] - q[j];
    return 0;
  });
  const same = (k) => (items[k].groups ?? []).join() === lists[k].join() && (!items[k].groups || lists[k].length);
  if (order.every((k, j) => k === j && same(k))) return items;
  return order.map((k) => {
    if (same(k)) return items[k];
    const { groups, ...rest } = items[k];
    return lists[k].length ? { ...rest, groups: lists[k] } : rest;
  });
}

/** Normalised `items` (normalizeGroups) cut into z-order units at group `scope` (null: the top level; a group: `items` are its
 * members): the members of each group directly inside `scope` together, every other item alone. */
export function units(items, scope = null) {
  const out = [];
  let last;
  for (const i of items) {
    const gs = i.groups ?? [];
    const g = gs[(scope ? gs.indexOf(scope) : gs.length) - 1];
    if (g && g === last) out.at(-1).push(i);
    else out.push([i]);
    last = g;
  }
  return out;
}

/** The layers panel's rows (SPEC §6c Layers panel) for normalised `items` at group `scope` (null: the top level): its units
 * topmost first, each {group, scope, items, rows}: an item alone (`group` null, `items` [it], `rows` null) or a group (`group`
 * its id, `items` its members, `rows` its own rows). */
export function layerRows(items, scope = null) {
  return units(items, scope).reverse().map((u) => {
    const gs = u[0].groups ?? [];
    const group = gs[(scope ? gs.indexOf(scope) : gs.length) - 1] ?? null;
    return { group, scope, items: u, rows: group ? layerRows(u, group) : null };
  });
}

/** Item `id`'s unit at group `scope` (null: the top level; SPEC §6c Groups) → {group, scope, ids}: `scope` is where it counts
 * from (the scope itself when the item is inside it, else the innermost group around the scope that holds the item, else null),
 * `group` the item's outermost group inside that (null: the item alone) and `ids` its members, or [id]. */
export function unitOf(items, id, scope = null) {
  const gs = items.find((i) => i.id === id)?.groups ?? [];
  const around = items.find((i) => i.groups?.includes(scope))?.groups ?? [];
  const at = around.slice(around.indexOf(scope)).find((g) => gs.includes(g)) ?? null;
  const group = gs[(at ? gs.indexOf(at) : gs.length) - 1] ?? null;
  return { group, scope: at, ids: group ? items.filter((i) => i.groups?.includes(group)).map((i) => i.id) : [id] };
}

// Whether the ids in `want` (a Set) hold every member of group `g` but the hidden ones (the board never selects those).
const fills = (items, want, g) => items.every((i) => i.hidden || !i.groups?.includes(g) || want.has(i.id));

/** `items` with a new group (id `makeId()`) around the items `ids` names, as whole units: its parent is the innermost group they
 * all carry that `ids` does not fill (null: the top level), and each of them brings its unit there (unitOf), so the new group
 * sits between those units and the parent. Fewer than 2 items: `items` itself. Not normalised (normalizeGroups gathers it). */
export function groupItems(items, ids, makeId) {
  const want = new Set(ids);
  const on = items.filter((i) => want.has(i.id));
  const parent = (on[0]?.groups ?? []).find((g) => on.every((i) => i.groups?.includes(g)) && !fills(items, want, g)) ?? null;
  const take = new Set(on.flatMap((i) => unitOf(items, i.id, parent).ids));
  if (take.size < 2) return items;
  const id = makeId();
  return items.map((i) => {
    if (!take.has(i.id)) return i;
    const gs = i.groups ?? [];
    const k = parent ? gs.indexOf(parent) : gs.length;
    return { ...i, groups: [...gs.slice(0, k), id, ...gs.slice(k)] };
  });
}

/** `items` without the groups `ids` selects: for each item it names, the outermost group of its own whose members `ids` all
 * names (a selected group; several selected groups each lose theirs). None: `items` itself. */
export function ungroupItems(items, ids) {
  const want = new Set(ids);
  const drop = new Set(items.filter((i) => want.has(i.id)).map((i) => i.groups?.findLast((g) => fills(items, want, g))).filter(Boolean));
  if (!drop.size) return items;
  return items.map((i) => {
    if (!i.groups?.some((g) => drop.has(g))) return i;
    const { groups, ...rest } = i;
    const gs = groups.filter((g) => !drop.has(g));
    return gs.length ? { ...rest, groups: gs } : rest;
  });
}

/** `items` with the units (units()) that hold any of `ids` moved in z-order, keeping their order among themselves. where:
 * 'front' | 'back' | 'forward' | 'backward' (one step: each moved unit swaps with the unit above / below it) | {index} (put in at
 * that place among the other units, 0 the back). `scope`: a group stepped into (§6c Groups), whose members move among
 * themselves, its units at that level. → a new array. */
export function arrangeItems(items, ids, where, scope = null) {
  const inside = (i) => i.groups?.includes(scope);
  const s = scope && items.some(inside) ? scope : null;
  const [a, b] = s ? [items.findIndex(inside), items.findLastIndex(inside) + 1] : [0, items.length]; // the scope's members
  const want = new Set(ids);
  const all = units(items.slice(a, b), s);
  const on = (u) => u.some((i) => want.has(i.id));
  const up = (list) => {
    for (let k = list.length - 2; k >= 0; k--) if (on(list[k]) && !on(list[k + 1])) [list[k], list[k + 1]] = [list[k + 1], list[k]];
    return list;
  };
  const [sel, rest] = [all.filter(on), all.filter((u) => !on(u))];
  const at = Number.isInteger(where?.index) ? Math.max(0, Math.min(where.index, rest.length)) : 0;
  const next = {
    front: () => [...rest, ...sel],
    back: () => [...sel, ...rest],
    forward: () => up([...all]),
    backward: () => up([...all].reverse()).reverse(),
  }[where]?.() ?? [...rest.slice(0, at), ...sel, ...rest.slice(at)];
  return [...items.slice(0, a), ...next.flat(), ...items.slice(b)];
}

/** Whether a click, the selection rectangle, Tab or Ctrl+A on the board may select `i`: not hidden and not locked. */
export const selectable = (i) => !i.hidden && !i.locked;

/** `items` with `field` ('hidden' | 'locked') set on the items `ids` names, or cleared on them when every one already has it.
 * → a new array, or `items` itself when `ids` names none. */
export function toggleLayer(items, ids, field) {
  const want = new Set(ids);
  const on = items.filter((i) => want.has(i.id));
  if (!on.length) return items;
  const set = !on.every((i) => i[field]);
  return items.map((i) => {
    if (!want.has(i.id)) return i;
    const { [field]: _, ...rest } = i;
    return set ? { ...rest, [field]: true } : rest;
  });
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

/** A copy of `item` turned `deg` degrees clockwise about point `c` (a group turn, §6d): its box centre goes round c and it turns
 * by deg; a connector's free ends and waypoints go round c (bound ends stay on their item). `h`: its height (text: rendered). */
export function turnItem(item, c, deg, h = item.h) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const round = (p) => {
    const q = rotatePoint(p, c, deg);
    return { x: r2(q.x), y: r2(q.y) };
  };
  if (item.type === 'connector') {
    const end = (e) => (bound(e) ? e : { ...e, ...round(e) });
    return { ...item, from: end(item.from), to: end(item.to), ...(item.points && { points: item.points.map(round) }) };
  }
  const m = round({ x: item.x + item.w / 2, y: item.y + h / 2 });
  return { ...item, x: r2(m.x - item.w / 2), y: r2(m.y - h / 2), rot: (((Math.round((item.rot || 0) + deg) % 360) + 360) % 360) };
}

/** A copy of `item` mirrored across the line through `c` (axis 'x': the vertical line, left ↔ right; 'y': top ↔ bottom; a
 * flip, §6d): its box centre mirrored, its angle negated and its flag `field` (null: none) toggled; a connector's free ends and
 * waypoints mirrored (bound ends stay on their item). `h`: its height (text: rendered). */
export function flipItem(item, c, axis, field = null, h = item.h) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const m = (p) => (axis === 'x' ? { x: r2(2 * c.x - p.x), y: p.y } : { x: p.x, y: r2(2 * c.y - p.y) });
  if (item.type === 'connector') {
    const end = (e) => (bound(e) ? e : { ...e, ...m(e) });
    return { ...item, from: end(item.from), to: end(item.to), ...(item.points && { points: item.points.map(m) }) };
  }
  const q = m({ x: item.x + item.w / 2, y: item.y + h / 2 });
  return { ...item, x: r2(q.x - item.w / 2), y: r2(q.y - h / 2), ...(item.rot && { rot: (360 - item.rot) % 360 }), ...(field && { [field]: !item[field] }) };
}

/** Deep copies with new ids (`makeId()`); connector ends bound inside the copied set follow the copies, ends bound outside it
 * become free at their tips. A group copied whole (no shown item of `all`, the board's items, outside the set carries it) gets
 * a new id (`makeId()`); a group copied in part is dropped from the copies. */
export function cloneItems(items, makeId, all = items) {
  const ids = new Map(items.map((i) => [i.id, makeId()]));
  const partial = new Set(all.filter((i) => !ids.has(i.id) && !i.hidden).flatMap((i) => i.groups ?? []));
  const groups = new Map(); // old group id → new
  return items.map((i) => {
    const copy = { ...structuredClone(i), id: ids.get(i.id) };
    if (i.groups) {
      const gs = i.groups.filter((g) => !partial.has(g)).map((g) => groups.get(g) ?? groups.set(g, makeId()).get(g));
      if (gs.length) copy.groups = gs;
      else delete copy.groups;
    }
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
    const b = rotBox({ ...measure(i), rot: rotOf(i) });
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
 * the item's own frame: the move turned by −rot, the box resized with the opposite corner (edge) fixed (`flip`: past it the box
 * goes on there and `fx` / `fy` say which axes went past), then placed so that
 * point keeps its board position (Konva Transformer). `aspect`: one scale for both axes (an edge scales both, the other side
 * about its middle); `min`: the smallest
 * side, or a side's start size when that is smaller. Sizes whole px. → {x, y, w, h}. */
export function resizeInFrame(start, handle, dx, dy, { aspect = false, min = 20, flip = false } = {}) {
  const rot = start.rot || 0;
  const d = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -rot);
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  let [w, h] = [start.w + sx * d.x, start.h + sy * d.y];
  let [fx, fy] = [false, false]; // flip: past the fixed side the box goes on there (mirrored)
  if (aspect) {
    // Corner: the pointer projected on the diagonal; edge: that side's scale (the other side about its middle).
    let k = sx && sy ? (start.w * w + start.h * h) / (start.w ** 2 + start.h ** 2) : sx ? w / start.w : h / start.h;
    if (flip && k < 0) [k, fx, fy] = [-k, !!sx, !!sy];
    const s = Math.max(k, Math.min(1, min / Math.max(start.w, start.h)));
    [w, h] = [Math.max(1, Math.round(start.w * s)), Math.max(1, Math.round(start.h * s))];
  } else {
    if (flip && sx && w < 0) [w, fx] = [-w, true];
    if (flip && sy && h < 0) [h, fy] = [-h, true];
    w = sx ? Math.max(Math.min(min, start.w), Math.round(w)) : start.w;
    h = sy ? Math.max(Math.min(min, start.h), Math.round(h)) : start.h;
  }
  // The fixed point, from the box's top-left in the item frame: the opposite corner, or the middle of the opposite edge (`ex`,
  // `ey`: the side the box lies on from it).
  const fixed = (bw, bh, ex, ey) => ({ x: ex > 0 ? 0 : ex < 0 ? bw : bw / 2, y: ey > 0 ? 0 : ey < 0 ? bh : bh / 2 });
  const f0 = fixed(start.w, start.h, sx, sy);
  const F = rotatePoint({ x: start.x + f0.x, y: start.y + f0.y }, { x: start.x + start.w / 2, y: start.y + start.h / 2 }, rot);
  const f1 = fixed(w, h, fx ? -sx : sx, fy ? -sy : sy);
  const v = rotatePoint({ x: f1.x - w / 2, y: f1.y - h / 2 }, { x: 0, y: 0 }, rot); // the fixed point from the new centre
  const r2 = (n) => Math.round(n * 100) / 100;
  return { x: r2(F.x - v.x - w / 2), y: r2(F.y - v.y - h / 2), w, h, ...(flip && { fx, fy }) };
}

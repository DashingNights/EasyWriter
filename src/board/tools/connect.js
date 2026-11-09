// bd-connect (docs/plans/board/briefs/bd-connect.md, design sections 3, 4 and 9): a connector stores only its route's inputs
// (from, to, route, corner, points, heads, color, width, dash, jump, labels, free) and every drawn field is derived on read by
// routing the connector and its ends through flow/route.mjs in board px, so moving either end cannot tear it. The drawn line
// is one freeform of the engine's own stored form: the routed path's SVG commands (rounded corners and line jumps included)
// and its heads, sampled into polylines in the item's own space. The A tool drags one end out of a shape's port; a selected
// connector's end and segment handles reshape it; labels are the item session's stories (bd-text).
import { keyAmong } from '../../app/keybinds.js';
import { kOf } from '../../engine/view/camera.mjs';
import { midHandles, dragSegment } from '../../flow/edit.mjs';
import { headPath, resolveConnectors } from '../../flow/route.mjs';
import { PORTS, rotatePoint } from '../../flow/shapes.mjs';
import { ink, planeTools } from '../../whiteboard.js';
import { LATER } from '../api.js';
import { DRAG_PX, boxOf } from '../gestures.mjs';
import { legacyOf, rgb, toPt, toPx } from '../look.mjs';
import { derived, placementsOf, registerType } from '../surfaces.mjs';
import { registerTool } from './registry.js';

const SLOTS = ['start', 'mid', 'end'];
const ACCENT = '#0d99ff';
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const DASH = { solid: 'solid', dashed: 'dash', dotted: 'dot' }; // the board's names → line_dash.rs LineDash
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const ENC = new TextEncoder();

// --- the derived form ---

/** The px geometry of every board item, for routing: `legacyOf` with a measure that reads the item's own box in points. */
function measureOf(store, stampOf) {
  return (legacy) => {
    const item = store.get(legacy.id);
    if (!item || item.gone) return { x: legacy.x ?? 0, y: legacy.y ?? 0, w: legacy.w ?? 0, h: legacy.h ?? 0 };
    if (item.type === 'connector') return { x: 0, y: 0, w: 0, h: 0 }; // repaired before it is measured
    const src = item.type === 'group' ? boxOf(item, store) : derived(item, store, stampOf);
    return { x: toPx(src.x ?? 0), y: toPx(src.y ?? 0), w: toPx(src.w ?? 0), h: toPx(src.h ?? 0) };
  };
}

function legacyItem(store, id) {
  const item = typeof id === 'string' ? store.get(id) : null;
  return item && !item.gone ? legacyOf(item) : null;
}

/** The connector and its ends as old-form items (px), for `resolveConnectors`. */
function oldForm(item, store) {
  const list = [legacyOf(item)];
  for (const end of [item.from, item.to]) {
    const other = legacyItem(store, end?.item);
    if (other && !list.some((i) => i.id === other.id)) list.push(other);
  }
  return list.filter(Boolean);
}

/** The routed connector `id` (px, route.mjs's finished fields) and its polyline, or null when it cannot route. */
function resolved(item, store, stampOf, map) {
  if (map) {
    const routed = map.routed.get(item.id);
    return routed ? { routed, pts: map.geo.get(item.id)?.pts ?? null } : null;
  }
  const { items, geo } = resolveConnectors(oldForm(item, store), measureOf(store, stampOf), new Set([item.id]));
  const routed = items.find((i) => i.id === item.id);
  return routed ? { routed, pts: geo.get(item.id)?.pts ?? null } : null;
}

let jumped = null; // {store, clock, on}: whether a connector jumps, read once per store change

/** Whether any connector asks for line jumps: then every connector reroutes together (its jumps depend on the lines below). */
function jumpy(store) {
  const clock = store.board.clock;
  if (jumped && jumped.store === store && jumped.clock === clock) return jumped.on;
  let on = false;
  for (const item of store.live()) {
    if (item.type === 'connector' && item.route !== 'curve' && (item.jump === 'arc' || item.jump === 'gap')) {
      on = true;
      break;
    }
  }
  jumped = { store, clock, on };
  return on;
}

let cache = null; // {store, clock, routed: Map, geo: Map}: one pass over every connector, kept for one store change

/** Every connector and every item they end at, routed in one pass (the jump case only). */
function routeAll(store, stampOf) {
  const list = [];
  const seen = new Set();
  for (const item of store.live()) {
    if (item.type !== 'connector') continue;
    list.push(legacyOf(item));
    for (const end of [item.from, item.to]) {
      const other = legacyItem(store, end?.item);
      if (other && !seen.has(other.id)) {
        seen.add(other.id);
        list.push(other);
      }
    }
  }
  const { items, geo } = resolveConnectors(list, measureOf(store, stampOf));
  return { routed: new Map(items.map((i) => [i.id, i])), geo };
}

function jumpMap(store, stampOf) {
  const clock = store.board.clock;
  if (cache && cache.store === store && cache.clock === clock) return cache;
  cache = { store, clock, ...routeAll(store, stampOf) };
  return cache;
}

/** SVG path → [{pts, closed}], sampling curves and arcs: route.mjs's output (rounded corners, sampler points, jumps). */
export function svgPaths(d) {
  const out = [];
  let cur = null;
  let at = { x: 0, y: 0 };
  const push = (p) => {
    if (!cur) {
      cur = { pts: [], closed: false };
      out.push(cur);
    }
    cur.pts.push(p);
    at = p;
  };
  for (const m of String(d).matchAll(/([MLCQAZ])([^MLCQAZ]*)/gi)) {
    const cmd = m[1].toUpperCase();
    const n = (m[2].match(NUM) ?? []).map(Number);
    if (cmd === 'M') {
      cur = { pts: [], closed: false };
      out.push(cur);
      push({ x: n[0], y: n[1] });
    } else if (cmd === 'L') {
      for (let i = 0; i + 1 < n.length; i += 2) push({ x: n[i], y: n[i + 1] });
    } else if (cmd === 'C') {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const [p0, c1, c2, p1] = [at, { x: n[i], y: n[i + 1] }, { x: n[i + 2], y: n[i + 3] }, { x: n[i + 4], y: n[i + 5] }];
        for (let k = 1; k <= CURVE_STEPS; k++) push(cubicAt(p0, c1, c2, p1, k / CURVE_STEPS));
      }
    } else if (cmd === 'Q') {
      for (let i = 0; i + 3 < n.length; i += 4) {
        const [p0, c, p1] = [at, { x: n[i], y: n[i + 1] }, { x: n[i + 2], y: n[i + 3] }];
        for (let k = 1; k <= CORNER_STEPS; k++) push(quadAt(p0, c, p1, k / CORNER_STEPS));
      }
    } else if (cmd === 'A') {
      for (let i = 0; i + 6 < n.length; i += 7) {
        const p1 = { x: n[i + 5], y: n[i + 6] };
        for (const p of halfArc(at, p1, n[i + 4])) push(p);
      }
    } else if (cmd === 'Z' && cur) {
      cur.closed = true;
    }
  }
  return out.filter((p) => p.pts.length);
}

const CURVE_STEPS = 16;
const CORNER_STEPS = 8;
const cubicAt = (a, b, c, d, t) => {
  const m = 1 - t;
  return { x: m * m * m * a.x + 3 * m * m * t * b.x + 3 * m * t * t * c.x + t * t * t * d.x,
    y: m * m * m * a.y + 3 * m * m * t * b.y + 3 * m * t * t * c.y + t * t * t * d.y };
};
const quadAt = (a, b, c, t) => {
  const m = 1 - t;
  return { x: m * m * a.x + 2 * m * t * b.x + t * t * c.x, y: m * m * a.y + 2 * m * t * b.y + t * t * c.y };
};

/** A half-turn arc from `a` to `b` (sweep 1 clockwise) as points: every arc route.mjs writes is one (circular heads, jumps). */
// ponytail: half turns only; a full SVG arc-to-centre conversion if a route ever writes another.
function halfArc(a, b, sweep) {
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const radius = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  const start = Math.atan2(a.y - c.y, a.x - c.x);
  const out = [];
  for (let k = 1; k <= CORNER_STEPS; k++) {
    const t = start + (sweep ? 1 : -1) * Math.PI * (k / CORNER_STEPS);
    out.push({ x: c.x + Math.cos(t) * radius, y: c.y + Math.sin(t) * radius });
  }
  return out;
}

// The text box's own margins (ew_doc TEXT_BOX_INSET: 7.2 and 3.6 pt) in board px, and the least content width a label keeps.
const LABEL_INSET = { x: 9.6, y: 4.8 };
const LABEL_MIN = 32;
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/** A line's width in ems: a wide (CJK) character is one, anything else six tenths. */
function ems(line) {
  let sum = 0;
  for (const ch of line) sum += WIDE_CHAR.test(ch) ? 1 : 0.6;
  return sum;
}

/** An old-form label's box in px: its text plus the text box's insets and a minimum width. The same rule sizes the painted
 * label (modelOf's text box) and the edit box (bd-text), so neither wraps on its own. */
function labelBox(l) {
  if (!l?.html) return null;
  const lines = String(l.html).replace(/<br\s*\/?>(?=<\/(?:div|p)>)/gi, '').replace(/<br\s*\/?>|<(?:div|p)(?:\s[^>]*)?>/gi, '\n')
    .replace(/^\n/, '').replace(/<[^>]*>/g, '').replace(/&[#\w]+;/g, 'x').split('\n');
  const size = l.size ?? 14;
  const content = Math.max(LABEL_MIN, Math.max(...lines.map((s) => ems(s))) * size + 2);
  return { w: content + 2 * LABEL_INSET.x, h: lines.length * size * 1.3 + 2 * LABEL_INSET.y };
}

/** The colour a connector draws with: its stored sRGB triple (a hex from an old record reads too). */
const strokeOf = (item) => (Array.isArray(item.color) ? item.color : rgb(item.color));

/**
 * The derive rule: route `item` against `store` → {x, y, w, h, freeform, kind, stroke, strokeWidth, fill, extra, labelAt, tips}
 * in points. The box is the drawn path's extent plus its heads and labels (grow it, or a label near an end is cut).
 */
export function routeOf(item, store, stampOf = null) {
  if (!item || !store) return null;
  // A drag's temporary connector (not the stored one) routes on its own: the jump cache holds the stored route.
  const map = store.get(item.id) === item && jumpy(store) ? jumpMap(store, stampOf) : null;
  const r = resolved(item, store, stampOf, map);
  if (!r) return null;
  const { routed } = r;
  const widthPx = Number.isFinite(routed.width) ? routed.width : 2;
  const stroke = strokeOf(item) ?? [0, 0, 0];
  const legacy = legacyOf(item);
  const paths = [];
  const ext = [];
  let filled = false;
  // route.mjs's `d` is relative to the routed box; a head's own path is absolute.
  const add = (d, ox = 0, oy = 0) => {
    for (const p of svgPaths(d)) {
      const shifted = { pts: p.pts.map((q) => ({ x: q.x + ox, y: q.y + oy })), closed: p.closed };
      paths.push(shifted);
      ext.push(...shifted.pts);
    }
  };
  add(routed.d, routed.x, routed.y);
  for (const [k, kind] of [[0, routed.heads?.start ?? 'none'], [1, routed.heads?.end ?? 'arrow']]) {
    const tip = routed.tips?.[k];
    if (!tip || kind === 'none') continue;
    const head = headPath(kind, { x: routed.x + tip.x, y: routed.y + tip.y, a: tip.a }, widthPx);
    if (head.d) add(head.d);
    if (head.fill) filled = true;
  }
  const anchors = {};
  for (const slot of SLOTS) {
    const at = routed.lps?.[slot];
    const box = at && labelBox(legacy?.labels?.[slot]);
    if (!box) continue;
    const q = { x: routed.x + at.x, y: routed.y + at.y };
    anchors[slot] = { at: q, box };
    ext.push({ x: q.x - box.w / 2, y: q.y - box.h / 2 }, { x: q.x + box.w / 2, y: q.y + box.h / 2 });
  }
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of ext) [x0, y0, x1, y1] = [Math.min(x0, p.x), Math.min(y0, p.y), Math.max(x1, p.x), Math.max(y1, p.y)];
  if (!ext.length) return null;
  // A line with no width or height still stamps: its box is its stroke, centred on it.
  if (!(x1 - x0 > 1e-9)) [x0, x1] = [x0 - widthPx / 2, x1 + widthPx / 2];
  if (!(y1 - y0 > 1e-9)) [y0, y1] = [y0 - widthPx / 2, y1 + widthPx / 2];
  const [w, h] = [toPt(x1 - x0), toPt(y1 - y0)];
  const local = (p) => [r6(toPt(p.x - x0)), r6(toPt(p.y - y0))];
  const labelAt = {};
  for (const [slot, { at, box }] of Object.entries(anchors)) {
    const [x, y] = local(at);
    labelAt[slot] = { x, y, w: r6(toPt(box.w)), h: r6(toPt(box.h)) };
  }
  return {
    x: r6(toPt(x0)), y: r6(toPt(y0)), w: r6(w), h: r6(h),
    kind: 'freeform',
    freeform: { w: r6(w), h: r6(h), paths: paths.map((p) => ({ pts: p.pts.map(local), closed: p.closed })), alpha: item.opacity ?? 1 },
    stroke,
    strokeWidth: Number.isFinite(item.width) ? item.width : toPt(2),
    fill: filled ? stroke : null,
    extra: { dash: DASH[item.dash] ?? 'solid', cap: 'round' },
    labelAt,
    tips: (routed.tips ?? []).map((t) => ({ x: r6(toPt(routed.x + t.x)), y: r6(toPt(routed.y + t.y)), a: t.a })),
  };
}

export const rule = { derive: routeOf, dependsOn: (c) => [c.from?.item, c.to?.item].filter(Boolean), paints: true };

// --- gestures, the screen-plane overlay and the chrome's methods ---

let ctxRef = null; // the mounted board's context (methods get it here)
let gesture = null; // the connector, end or segment in hand
let hoverId = null; // the shape under the connector tool's pointer (its ports show)
let overlay = null; // {root, wrap} in the screen plane
let show = { busy: false, next: null }; // the drag's preview stamp, one at a time
let textModule = null; // bd-text, loaded on first use so this module registers before it (tools run in registration order)

/** Opens bd-text's item session on a label (loaded lazily: a static import would reorder the tools). */
const startTextEdit = (ctx, target, opts) => (textModule ??= import('./text.js'))
  .then(({ startEdit }) => startEdit(ctx, target, null, opts))
  .catch((err) => console.warn('The label was not opened', err));

const div = (style = {}) => {
  const el = document.createElement('div');
  Object.assign(el.style, { position: 'absolute', pointerEvents: 'none' }, style);
  return el;
};

/** World point `p` in the viewport's own px. The overlay hangs on the view's root, outside the sizer the pan driver moves, so
 * the camera is the origin here (beyond the sizer the extent is not). */
function screenPoint(ctx, p) {
  const v = ctx.vp;
  const k = kOf(v.camera.zoom);
  return { left: (p.x - v.camera.x) * k, top: (p.y - v.camera.y) * k };
}

/** The port point of `item` at box fractions `anchor`, turned with the item (points). */
function portPoint(item, box, anchor) {
  return rotatePoint({ x: box.x + anchor[0] * box.w, y: box.y + anchor[1] * box.h }, centreOf(box), item.rot ?? 0);
}

/** The live shape (not a connector, instance or group) under world point `p`, by the placements' boxes. */
function shapeAt(ctx, p) {
  if (!p) return null;
  const list = ctx.vp?.placements ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const pl = list[i];
    if (p.x < pl.x || p.x > pl.x + pl.w || p.y < pl.y || p.y > pl.y + pl.h) continue;
    const item = ctx.store.get(pl.key);
    if (!item || item.gone || item.hidden || item.locked) continue;
    if (item.type === 'connector' || item.type === 'doc' || item.type === 'group') continue;
    return item;
  }
  return null;
}

/** The port under `p` ({item, anchor}) within the tool's reach in screen px, or null. */
function portAt(ctx, p) {
  const item = shapeAt(ctx, p);
  if (!item) return null;
  const box = boxOf(item, ctx.store);
  if (!box || !box.w || !box.h) return null;
  const reach = 10 / kOf(ctx.vp.camera.zoom);
  for (const anchor of PORTS) {
    const q = portPoint(item, box, anchor);
    if (Math.hypot(p.x - q.x, p.y - q.y) <= reach) return { item: item.id, anchor: [...anchor] };
  }
  return null;
}

/** The one selected connector, or null. */
function selectedConnector(ctx) {
  const ids = ctx.selection.ids;
  if (ids.length !== 1) return null;
  const item = ctx.store.get(ids[0]);
  return item && !item.gone && item.type === 'connector' ? item : null;
}

/** The selected connector's end handles and segment handles, in points ({tips, mids}). */
function handlesOf(ctx, item) {
  const r = resolved(item, ctx.store, ctx.surfaces.stampOf, null);
  if (!r?.pts?.length) return null;
  const tips = (r.routed.tips ?? []).map((t) => ({ x: toPt(r.routed.x + t.x), y: toPt(r.routed.y + t.y) }));
  const points = (item.points ?? []).map((p) => ({ x: toPx(p.x), y: toPx(p.y) }));
  const mids = midHandles(item.route ?? 'ortho', r.pts, points).map((h) => ({ ...h, x: toPt(h.x), y: toPt(h.y) }));
  return { tips, mids, pts: r.pts, points };
}

function hideOverlay() {
  overlay?.wrap.remove();
  overlay = null;
}

/** Draws the hovered shape's ports and the selected connector's handles, rebuilt on every call. */
function paint(ctx) {
  const vp = ctx.vp;
  if (!vp?.root) return;
  const dots = [];
  if (ctx.api?.mode === 'connector' && hoverId) {
    const item = ctx.store.get(hoverId);
    const box = item && !item.gone ? boxOf(item, ctx.store) : null;
    if (box) for (const anchor of PORTS) dots.push({ p: portPoint(item, box, anchor), port: true });
  }
  const one = ctx.api?.mode == null ? selectedConnector(ctx) : null;
  const handles = one ? handlesOf(ctx, one) : null;
  if (handles) {
    handles.tips.forEach((p) => dots.push({ p, end: true }));
    handles.mids.forEach((p) => dots.push({ p }));
  }
  if (!dots.length) return hideOverlay();
  if (!overlay || overlay.root !== vp.root) {
    hideOverlay();
    const wrap = div({ inset: '0', zIndex: 6 });
    wrap.dataset.boardConnect = '';
    vp.root.append(wrap);
    overlay = { root: vp.root, wrap };
  }
  overlay.wrap.replaceChildren(...dots.map(({ p, port, end }) => {
    const at = screenPoint(ctx, p);
    const el = div({ left: `${at.left}px`, top: `${at.top}px`, width: '8px', height: '8px', marginLeft: '-4px', marginTop: '-4px',
      borderRadius: '50%', boxSizing: 'border-box',
      background: port || end ? ACCENT : '#ffffff', border: `1px solid ${port || end ? '#ffffff' : ACCENT}` });
    el.dataset.boardPort = port ? '' : end ? 'end' : 'mid';
    return el;
  }));
}

/** Sends the drag's temporary stamp and follows it with the placements, one preview at a time. */
function preview(ctx, item) {
  const fields = routeOf(item, ctx.store, ctx.surfaces.stampOf);
  show.next = fields ? { id: item.id, fields } : null;
  if (show.busy || !show.next) return;
  show.busy = true;
  (async () => {
    while (show.next) {
      const { id, fields } = show.next;
      show.next = null;
      await ctx.surfaces.preview(id, fields).catch(() => {});
      const v = ctx.vp;
      if (v) v.setPlacements(placementsOf(ctx.store, ctx.surfaces, ctx.client.id, ctx, { [id]: fields }));
    }
    show.busy = false;
  })();
}

const worldOf = (ctx, e) => ctx.vp?.fromClient(e.clientX, e.clientY).world ?? null;

/** A connector's fields from the tool's own look, its ends both at `p` until the drag moves one. */
function connectorFields(from, to) {
  const look = planeTools.conn;
  return { type: 'connector', from, to, route: look.route ?? 'ortho', corner: look.corner ?? 8, points: [],
    heads: { ...(look.heads ?? { start: 'none', end: 'arrow' }) }, color: rgb(look.color) ?? rgb(ink()) ?? [0, 0, 0],
    width: toPt(look.width ?? 2), dash: look.dash ?? 'solid', jump: look.jump ?? 'none', labels: {} };
}

/** Creates the connector a drag started (the first move past the press, so a click leaves no step and no redo cleared). */
function beginConnector(ctx) {
  const g = gesture;
  if (!g || g.id) return g?.id ?? null;
  let id = null;
  const step = ctx.store.change('Add connector', (tx) => {
    id = tx.create({ ...connectorFields(g.from, { x: r6(g.world.x), y: r6(g.world.y) }),
      at: [null, ctx.store.orderKey(null, ctx.store.children(null).length, tx)] });
  });
  if (!id) return null;
  g.id = id;
  g.step = step;
  ctx.selection.set([id]);
  return id;
}

/** Ends the connector tool's drag: the final end written in the create's step. A click with no drag made nothing. */
function finishConnector(ctx) {
  const g = gesture;
  gesture = null;
  if (!g?.id) return;
  const item = ctx.store.get(g.id);
  const end = g.world ? portAt(ctx, g.world) ?? { x: r6(g.world.x), y: r6(g.world.y) } : null;
  if (!item || item.gone || !end) return drop(ctx, g);
  // Not a new step: the create stays the one undo step, and its revive keeps the end as it now is.
  ctx.store.change('', (tx) => tx.set(g.id, 'to', end), { silent: true });
  ctx.selection.set([g.id]);
  if (ctx.api.mode && !planeTools.keep()) ctx.api.setMode(null);
}

/** Takes back the connector a cancelled drag created, with its undo step. */
function drop(ctx, g) {
  if (!g.id) return;
  if (ctx.store.steps.at(-1) === g.step) ctx.store.steps.pop();
  if (ctx.store.get(g.id)) ctx.store.change('', (tx) => tx.remove(g.id), { silent: true });
  ctx.selection.clear();
}

/** Ends a handle drag: the new end or waypoints, in one undo step. */
function finishHandle(ctx) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  const item = ctx.store.get(g.id);
  if (!item || item.gone) return;
  const fields = g.kind === 'end' ? { [g.endK ? 'to' : 'from']: g.end } : { points: g.points };
  ctx.store.change(g.kind === 'end' ? 'Reconnect' : 'Reshape', (tx) => tx.patch(g.id, fields));
}

/** The engine steps a label's style patch names (px size, hex colour, bold). */
function styleSteps(patch) {
  const steps = [];
  if (Number.isFinite(patch.size) && patch.size > 0) steps.push(['format.size', { size: toPt(patch.size) }]);
  const c = rgb(patch.textColor);
  if (c) steps.push(['format.color', { color: c.map((v) => v.toString(16).padStart(2, '0')).join('') }]);
  if (typeof patch.bold === 'boolean') steps.push(['format.bold', { value: patch.bold }]);
  return steps;
}

/** The story with a style patch on every run: what a label's controls write while its text is not being edited. */
function styledStory(story, patch) {
  const props = {};
  if (Number.isFinite(patch.size) && patch.size > 0) props.size = toPt(patch.size);
  const c = rgb(patch.textColor);
  if (c) props.color = { Rgb: c };
  if (typeof patch.bold === 'boolean') props.bold = patch.bold;
  if (!Object.keys(props).length) return story;
  const blocks = (story?.blocks ?? []).map((b) => {
    if (b.kind !== 'para') return b;
    const runs = b.runs?.length ? b.runs : [{ len: ENC.encode(b.text ?? '').length }];
    return { ...b, runs: runs.map((r) => ({ ...r, props: { ...(r.props ?? {}), ...props } })) };
  });
  return { ...story, blocks };
}

/** The label under world point `p`, or null (a connector with labels at its three slots). */
function slotAt(item, p, store) {
  const labels = item.labels ?? {};
  const box = rule.derive(item, store, null);
  if (!box) return null;
  for (const slot of ['mid', 'start', 'end']) {
    if (!labels[slot]) continue;
    const at = box.labelAt?.[slot];
    if (!at) continue;
    const x = box.x + at.x;
    const y = box.y + at.y;
    if (p.x >= x - at.w / 2 && p.x <= x + at.w / 2 && p.y >= y - at.h / 2 && p.y <= y + at.h / 2) return slot;
  }
  return null;
}

export default registerTool({
  id: 'connect',
  modes: ['connector'], // the A tool

  mount(ctx) {
    ctxRef = ctx;
    registerType('connector', rule);
    for (const name of ['reverseConnector', 'straighten']) delete LATER[name];
    const root = ctx.vp?.root;
    const repaint = () => paint(ctx);
    const hover = (e) => {
      if (gesture || !ctx.vp) return;
      const item = ctx.api.mode === 'connector' ? shapeAt(ctx, worldOf(ctx, e)) : null;
      const id = item?.id ?? null;
      if (id === hoverId) return;
      hoverId = id;
      repaint();
    };
    const leave = () => {
      if (!hoverId) return;
      hoverId = null;
      repaint();
    };
    const offApi = ctx.api?.subscribe(repaint);
    // A connector's handles follow its ends: any store change redraws them (and the overlay's dots are rebuilt whole).
    const offStore = ctx.store.subscribe(() => {
      if (!gesture) repaint();
    });
    const offCam = ctx.vp?.subscribe?.('camera', repaint);
    root?.addEventListener('pointermove', hover);
    root?.addEventListener('pointerleave', leave);
    return () => {
      root?.removeEventListener('pointermove', hover);
      root?.removeEventListener('pointerleave', leave);
      offApi?.();
      offStore();
      offCam?.();
      gesture = null;
      hoverId = null;
      hideOverlay();
      if (ctxRef === ctx) ctxRef = null;
    };
  },

  pick(ctx, world) {
    if (ctx.api.mode === 'connector') return { kind: 'connector', port: portAt(ctx, world) };
    const one = ctx.api.mode == null ? selectedConnector(ctx) : null;
    const handles = one ? handlesOf(ctx, one) : null;
    if (!handles) return null;
    const reach = 6 / kOf(ctx.vp.camera.zoom);
    for (const [end, p] of handles.tips.entries()) {
      if (Math.hypot(world.x - p.x, world.y - p.y) <= reach) return { kind: 'connector-end', id: one.id, end };
    }
    for (const h of handles.mids) {
      if (Math.hypot(world.x - h.x, world.y - h.y) <= reach) return { kind: 'connector-seg', id: one.id, k: h.k, at: h };
    }
    return null;
  },

  down(ctx, hit, e) {
    const world = worldOf(ctx, e);
    if (hit?.kind === 'connector') {
      const from = hit.port ? { item: hit.port.item, anchor: hit.port.anchor } : { x: r6(world.x), y: r6(world.y) };
      // No item yet: a click that never drags must not add a step (which would clear the redo stack).
      gesture = { kind: 'connector', from, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, world };
      return true;
    }
    if (hit?.kind === 'connector-end') {
      const item = ctx.store.get(hit.id);
      if (!item) return false;
      gesture = { kind: 'end', id: hit.id, endK: hit.end, end: item[hit.end ? 'to' : 'from'], world };
      return true;
    }
    if (hit?.kind === 'connector-seg') {
      const item = ctx.store.get(hit.id);
      const handles = item ? handlesOf(ctx, item) : null;
      if (!handles) return false;
      gesture = { kind: 'seg', id: hit.id, k: hit.k, points: [...(item.points ?? [])], pts: handles.pts,
        pointsPx: handles.points, at: world };
      return true;
    }
    return false;
  },

  move(ctx, e) {
    if (!gesture) return;
    const world = worldOf(ctx, e);
    if (!world) return;
    gesture.x = e.clientX;
    gesture.y = e.clientY;
    gesture.world = world;
    if (gesture.kind === 'connector' && !gesture.id) {
      if (Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) < DRAG_PX) return;
      if (!beginConnector(ctx)) return;
    }
    const item = ctx.store.get(gesture.id);
    if (!item || item.gone) return;
    if (gesture.kind === 'connector' || gesture.kind === 'end') {
      const end = portAt(ctx, world) ?? { x: r6(world.x), y: r6(world.y) };
      const field = gesture.kind === 'end' && !gesture.endK ? 'from' : 'to';
      gesture.end = end;
      preview(ctx, { ...item, [field]: end });
      return;
    }
    // An elbow segment moves across (the board's own rule); a straight or curve segment drags out a waypoint.
    const route = item.route ?? 'ortho';
    const d = { x: toPx(world.x - gesture.at.x), y: toPx(world.y - gesture.at.y) };
    if (route === 'ortho') {
      gesture.points = dragSegment(gesture.pointsPx, gesture.pts, gesture.k, { x: d.x, y: d.y }).map((p) => ({ x: r6(toPt(p.x)), y: r6(toPt(p.y)) }));
    } else {
      const p = { x: r6(world.x), y: r6(world.y) };
      const before = (item.points ?? []).slice(0, gesture.k);
      const after = (item.points ?? []).slice(gesture.k);
      gesture.points = [...before, p, ...after];
    }
    preview(ctx, { ...item, points: gesture.points });
  },

  up(ctx) {
    if (!gesture) return;
    if (gesture.kind === 'connector') finishConnector(ctx);
    else finishHandle(ctx);
    paint(ctx);
  },

  cancel(ctx) {
    const g = gesture;
    gesture = null;
    show.next = null;
    if (g?.kind === 'connector') drop(ctx, g);
    else if (g) ctx.surfaces.preview(g.id, {});
    paint(ctx);
  },

  /** The generic pointer path may not resize, turn or flip a connector: its geometry is its route's inputs. A move carries
   * its free ends and waypoints (a bound end stays on its shape), and the rest of a mixed selection as usual. */
  transform(ctx, ids, extra = {}) {
    if (extra.kind === 'move' && ctx.selection?.lastDrop?.altKey) return null; // Alt+drag duplicates: bd-clip's transform answers
    const connectors = ids.filter((id) => ctx.store.get(id)?.type === 'connector');
    if (!connectors.length) return null;
    if (extra.kind === 'move') {
      const { delta } = extra;
      const out = [];
      for (const id of ids) {
        const item = ctx.store.get(id);
        if (!item || item.gone || item.type === 'group') continue;
        if (item.type !== 'connector') {
          if (extra.fields[id]) out.push([id, extra.fields[id]]);
          continue;
        }
        const fields = {};
        for (const k of ['from', 'to']) {
          if (typeof item[k]?.x === 'number') fields[k] = { ...item[k], x: r6(item[k].x + delta.dx), y: r6(item[k].y + delta.dy) };
        }
        if (item.points?.length) fields.points = item.points.map((p) => ({ ...p, x: r6(p.x + delta.dx), y: r6(p.y + delta.dy) }));
        if (Object.keys(fields).length) out.push([id, fields]);
      }
      return out;
    }
    // A group's resize, turn and flip write nothing, as the default transform has it.
    return Object.entries(extra.fields).filter(([id]) => !connectors.includes(id) && ctx.store.get(id)?.type !== 'group');
  },

  /** A double-click on a connector edits its label under the pointer, or its middle one. */
  dblclick(ctx, hit, e) {
    const item = hit?.id ? ctx.store.get(hit.id) : null;
    if (!item || item.gone || item.type !== 'connector') return false;
    const world = worldOf(ctx, e);
    const slot = slotAt(item, world, ctx.store) ?? 'mid';
    ctx.api.editLabel(item.id, slot);
    return true;
  },

  keydown(ctx, e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!keyAmong(['board.connector'], e)) return false;
    ctx.api.setMode('connector');
    return true;
  },

  /** A shape about to be deleted gives its connectors a free end where that end met it, in the delete's own step; a connector
   * whose both ends go is removed too. */
  removing(ctx, ids, tx) {
    const removed = new Set(ids);
    for (const item of ctx.store.live()) {
      if (item.type !== 'connector' || removed.has(item.id)) continue;
      const dead = [item.from, item.to].map((e) => typeof e?.item === 'string' && removed.has(e.item));
      if (!dead[0] && !dead[1]) continue;
      if (dead[0] && dead[1]) {
        tx.remove(item.id);
        continue;
      }
      // The wrapped tip is the port the end sat on (route.mjs's finished tips, relative to the routed box).
      const r = resolved(item, ctx.store, ctx.surfaces?.stampOf ?? null, null);
      const tips = r?.routed?.tips;
      if (!tips) {
        tx.remove(item.id);
        continue;
      }
      const fields = {};
      for (const k of [0, 1]) {
        if (!dead[k]) continue;
        fields[k ? 'to' : 'from'] = { x: r6(toPt(r.routed.x + tips[k].x)), y: r6(toPt(r.routed.y + tips[k].y)) };
      }
      tx.patch(item.id, fields);
    }
  },

  // Reverse, Straighten and the Labels popover; the chrome calls these on the board.
  methods: {
    reverseConnector() {
      const ctx = ctxRef;
      if (!ctx) return false;
      const ids = ctx.selection.ids.filter((id) => ctx.store.get(id)?.type === 'connector');
      if (!ids.length) return false;
      ctx.store.change('Reverse', (tx) => {
        for (const id of ids) {
          const c = ctx.store.get(id);
          const labels = { ...(c.labels ?? {}) };
          const [start, end] = [labels.start, labels.end];
          delete labels.start;
          delete labels.end;
          if (start) labels.end = start;
          if (end) labels.start = end;
          tx.patch(id, { from: c.to, to: c.from, heads: { start: c.heads?.end ?? 'arrow', end: c.heads?.start ?? 'none' },
            points: [...(c.points ?? [])].reverse(), labels });
        }
      });
      return true;
    },

    straighten() {
      const ctx = ctxRef;
      if (!ctx) return false;
      const ids = ctx.selection.ids.filter((id) => ctx.store.get(id)?.type === 'connector' && ctx.store.get(id).points?.length);
      if (!ids.length) return false;
      ctx.store.change('Straighten', (tx) => {
        for (const id of ids) tx.set(id, 'points', []);
      });
      return true;
    },

    /** The Labels popover's checkbox: on edits the slot (never its stored text), off removes it. */
    toggleLabel(slot, on) {
      const ctx = ctxRef;
      const id = ctx?.selection.ids[0];
      const item = id ? ctx.store.get(id) : null;
      if (item?.type !== 'connector') return false;
      if (on) return this.editLabel(id, slot);
      if (!item.labels?.[slot]) return false;
      const labels = { ...item.labels };
      delete labels[slot];
      ctx.store.change('Label', (tx) => tx.set(id, 'labels', labels));
      return true;
    },

    /** Edits connector `id`'s label `slot` in the item session. A missing one opens empty and is written when the edit ends,
     * so adding a label is one undo step; nothing typed leaves nothing behind. */
    editLabel(id, slot) {
      const ctx = ctxRef;
      const item = ctx?.store.get(id);
      if (!item || item.gone || item.type !== 'connector') return false;
      const fresh = !item.labels?.[slot];
      startTextEdit(ctx, { id, slot }, { all: fresh, fresh: fresh ? {} : undefined });
      return true;
    },

    /** The label's style ({size px, textColor, bold}): the item session's own steps while its text is edited, else the story. */
    setLabel(slot, patch = {}) {
      const ctx = ctxRef;
      const id = ctx?.selection.ids[0];
      const item = id ? ctx.store.get(id) : null;
      const story = item?.labels?.[slot];
      if (!story) return false;
      const steps = styleSteps(patch);
      if (steps.length && ctx.api.editing) ctx.item.execMany([['select.all', {}], ...steps]).catch(() => {});
      ctx.store.change('Label style', (tx) => tx.set(id, 'labels', { ...item.labels, [slot]: styledStory(story, patch) }));
      return true;
    },
  },
});

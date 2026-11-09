// bd-pen: the Pen, the Eraser, and Curve and Freeform: Shape (docs/plans/board/briefs/bd-pen.md). The field builders are pure so
// node tests load them; the tool below only draws the live line and commits. Points are world points throughout.
import { keyAmong } from '../../app/keybinds.js';
import { kOf } from '../../engine/view/camera.mjs';
import { ink, planeTools } from '../../whiteboard.js';
import { patchOf, rgb, toPt } from '../look.mjs';
import { registerTool } from './registry.js';

const MODES = ['pen', 'eraser', 'curve', 'freeform']; // the rail's tools this module draws with
const CLOSE_PX = 8; // a click this near the first point closes a path
const HIT_PX = 4; // the eraser's tolerance round an ink stroke
const STEP_PX = 0.5; // screen px the pen moves before it takes another point, and its thinning tolerance
const SAMPLE_PX = 6; // CSS px between the eraser's hit tests along a drag
const SPLINE_STEPS = 8; // samples a curve takes a segment
const SVG = 'http://www.w3.org/2000/svg';
const r2 = (n) => Math.round(n * 100) / 100; // a stored point to 0.01 pt
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** The points' bounds grown by half `width` points, and the points in that box (DrawingML's freeform space, to 0.01 pt). */
function framed(points, width) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) [x0, y0, x1, y1] = [Math.min(x0, p.x), Math.min(y0, p.y), Math.max(x1, p.x), Math.max(y1, p.y)];
  const pad = width / 2;
  const [x, y] = [r6(x0 - pad), r6(y0 - pad)];
  return { x, y, w: r6(x1 - x0 + width), h: r6(y1 - y0 + width), local: points.map((p) => [r2(p.x - x), r2(p.y - y)]) };
}

/** The stored fields of an `ink` item through `points`, for pen `{color, width, opacity}` (weight in board px). */
export function inkFields(points, pen = {}) {
  const width = toPt(pen.width ?? 4);
  const { x, y, w, h, local } = framed(points, width);
  return {
    type: 'ink', x, y, w, h,
    freeform: { w, h, paths: [{ pts: local, closed: false }], alpha: pen.opacity ?? 1, ink: 'pen' },
    stroke: rgb(pen.color) ?? [0, 0, 0],
    strokeWidth: width,
    extra: { cap: 'round' },
  };
}

/** The stored fields of a `shape` item with kind 'freeform' through `points`, closed or not, in the shape tool's `look`. A
 * closed path takes the look's fill; an open one has none. */
export function pathFields(points, closed, look = {}) {
  const width = toPt(look.width || 2);
  const { x, y, w, h, local } = framed(points, width);
  const fill = closed ? (patchOf(null, { fill: look.fill ?? 'none', ...(look.fillColor != null && { fillColor: look.fillColor }) }).fill ?? null) : null;
  return {
    type: 'shape', kind: 'freeform', x, y, w, h,
    stroke: rgb(look.color ?? null) ?? rgb(ink()),
    strokeWidth: width,
    fill,
    opacity: look.opacity ?? 1,
    freeform: { w, h, paths: [{ pts: local, closed: !!closed }], alpha: 1 },
  };
}

/** Whether the last of `points` is within 8 CSS px of the first, `k` being CSS px a point (state zoom, kOf). */
export function closes(points, k = 1) {
  if (!points || points.length < 2) return false;
  const [a, b] = [points[0], points.at(-1)];
  return Math.hypot(b.x - a.x, b.y - a.y) * k <= CLOSE_PX;
}

/** The distance from `p` to the segment `a`–`b`. */
function segDist(p, a, b) {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Douglas-Peucker: the points a pen stroke keeps, every dropped point within `tol` points of the line through its neighbours. */
export function thinned(points, tol = 0.5) {
  const n = points.length;
  if (n < 3) return [...points];
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let [far, best] = [-1, tol];
    for (let i = a + 1; i < b; i++) {
      const d = segDist(points[i], points[a], points[b]);
      if (d > best) [best, far] = [d, i];
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** The points a pen stroke keeps at `k` CSS px a point: one at most every half a screen px, then thinned to half a screen px,
 * each stored to 0.01 pt, so the same scribble costs the same at any zoom. */
export function stored(points, k = 1) {
  const kept = [];
  for (const p of points) {
    const last = kept.at(-1);
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= STEP_PX / k) kept.push(p);
  }
  return thinned(kept, STEP_PX / k).map((p) => ({ x: r2(p.x), y: r2(p.y) }));
}

/** One segment of a Catmull-Rom spline through p0..p3 at `t`, 0 at p1 and 1 at p2. */
function catmull(p0, p1, p2, p3, t) {
  const [t2, t3] = [t * t, t * t * t];
  const at = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) };
}

/** A Catmull-Rom spline through `points`, sampled `SPLINE_STEPS` times a segment, so it passes through every point. */
export function spline(points) {
  const n = points.length;
  if (n < 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const at = (i) => points[Math.min(n - 1, Math.max(0, i))];
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < SPLINE_STEPS; s++) out.push(catmull(p0, p1, p2, p3, s / SPLINE_STEPS));
  }
  out.push({ x: points.at(-1).x, y: points.at(-1).y });
  return out;
}

// The gesture and the live line belong to one board's area (ctx), so two boards never share a stroke in progress.
const states = new WeakMap();

/** `ctx`'s gesture and live line, created with the tool's mount. */
function stateOf(ctx) {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { gesture: null, preview: null, drop: () => dropStroke(ctx) }));
  return s;
}

/** The live line's layer over the board, its group placed and scaled by the camera so the path stays in world points. */
function layer(ctx) {
  const s = stateOf(ctx);
  const v = ctx.vp;
  if (!v) return null;
  if (!s.preview || !s.preview.svg.isConnected || s.preview.root !== v.root) {
    hidePreview(ctx);
    const svg = document.createElementNS(SVG, 'svg');
    Object.assign(svg.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'visible',
      pointerEvents: 'none', zIndex: 5 });
    const g = document.createElementNS(SVG, 'g');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    g.append(path);
    svg.append(g);
    v.root.append(svg);
    s.preview = { svg, g, path, root: v.root };
  }
  const k = kOf(v.camera.zoom);
  s.preview.g.setAttribute('transform', `translate(${-v.camera.x * k} ${-v.camera.y * k}) scale(${k})`);
  return s.preview;
}

/** Draws `points` as the live line in `style` {color, width (pt), opacity}. */
function drawLine(ctx, points, style) {
  const p = layer(ctx);
  if (!p || !points.length) return;
  const one = points.length === 1 ? `L${r6(points[0].x)} ${r6(points[0].y)}` : '';
  p.path.setAttribute('d', points.map((q, i) => `${i ? 'L' : 'M'}${r6(q.x)} ${r6(q.y)}`).join('') + one);
  p.path.setAttribute('stroke', style.color ?? '#000000');
  p.path.setAttribute('stroke-width', style.width);
  p.path.setAttribute('stroke-opacity', style.opacity ?? 1);
}

function hidePreview(ctx) {
  const s = stateOf(ctx);
  s.preview?.svg.remove();
  s.preview = null;
}

/** Throws away the gesture in hand without committing anything (Escape, a lost pointer, a tool switch, unmount). */
function abandon(ctx) {
  stateOf(ctx).gesture = null;
  hidePreview(ctx);
}

/** A pen or eraser drag the pointer left: the pointer's own up event cannot tell a cancel, so the stroke goes here. A line
 * being placed is not a drag and keeps its points between presses. */
function dropStroke(ctx) {
  const g = stateOf(ctx).gesture;
  if (g && g.kind !== 'path') abandon(ctx);
}

const inkStyle = (pen) => ({ color: pen.color, width: toPt(pen.width ?? 4), opacity: pen.opacity });
const pathStyle = (look) => ({ color: look.color, width: toPt(look.width || 2), opacity: look.opacity });

/** One new item in one undo step. */
function create(ctx, label, fields) {
  ctx.store.change(label, (tx) => {
    tx.create({ ...fields, at: [null, ctx.store.orderKey(null, ctx.store.children(null).length, tx)] });
  });
}

const worldOf = (ctx, e) => ctx.vp?.fromClient(e.clientX, e.clientY).world ?? null;

/** Whether `item` or a group it sits in is locked or hidden: what the eraser must not reach. */
function barred(ctx, item) {
  const seen = new Set();
  for (let cur = item; cur && !seen.has(cur.id);) {
    if (cur.hidden || cur.locked) return true;
    seen.add(cur.id);
    const parent = cur.at?.[0] != null ? ctx.store.get(cur.at[0]) : null;
    cur = parent && !parent.gone ? parent : null;
  }
  return false;
}

/** The pen's points this move adds: a coalesced event's samples when the browser gives them, else the move itself. */
function extendPen(ctx, e) {
  const g = stateOf(ctx).gesture;
  const k = kOf(ctx.vp.camera.zoom);
  const events = e.getCoalescedEvents?.() ?? [];
  for (const ev of events.length ? events : [e]) {
    const p = worldOf(ctx, ev);
    const last = g.points.at(-1);
    if (p && Math.hypot(p.x - last.x, p.y - last.y) >= STEP_PX / k) g.points.push(p);
  }
  drawLine(ctx, g.points, inkStyle(g.pen));
}

function finishPen(ctx) {
  const g = stateOf(ctx).gesture;
  abandon(ctx);
  if (!g) return;
  let points = stored(g.points, kOf(ctx.vp?.camera.zoom ?? 1));
  // A click draws a dot: two points a hundredth of a point apart, which the engine's round cap paints round.
  if (points.length === 1) points = [points[0], { x: r2(points[0].x + 0.01), y: points[0].y }];
  create(ctx, 'Add ink', inkFields(points, g.pen));
}

/** The ink item under world point `world`, by the worker's own hit test, skipping `done` and anything not ink. */
async function hitInk(ctx, world, done) {
  const v = ctx.vp;
  if (!v) return [];
  const tol = HIT_PX / kOf(v.camera.zoom);
  const out = [];
  for (let i = v.placements.length - 1; i >= 0; i--) {
    const p = v.placements[i];
    if (done.has(p.key)) continue;
    if (world.x < p.x - tol || world.x > p.x + p.w + tol || world.y < p.y - tol || world.y > p.y + p.h + tol) continue;
    const item = ctx.store.get(p.key);
    if (!item || item.gone || item.type !== 'ink' || barred(ctx, item)) continue;
    let hit = false;
    try {
      hit = await ctx.client.call('boardHit', [p.surface, world.x - p.x, world.y - p.y, tol]);
    } catch {
      hit = false;
    }
    if (hit) out.push(p.key);
  }
  return out;
}

/** Removes every stroke the eraser drag met, as one `Erase` step (a whole item, never part of it). */
async function finishErase(ctx) {
  const g = stateOf(ctx).gesture;
  abandon(ctx);
  if (!g) return;
  const ids = new Set();
  for (const world of g.points) for (const id of await hitInk(ctx, world, ids)) ids.add(id);
  if (!ids.size) return;
  ctx.store.change('Erase', (tx) => {
    for (const id of ids) tx.remove(id);
  });
  ctx.selection.set(ctx.selection.ids.filter((id) => !ids.has(id)));
}

/** The eraser's samples this move adds, one every SAMPLE_PX of the drag (a hit test at each). */
function extendErase(ctx, e) {
  const g = stateOf(ctx).gesture;
  const [dx, dy] = [e.clientX - g.client.x, e.clientY - g.client.y];
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SAMPLE_PX));
  for (let i = 1; i <= steps; i++) {
    const world = worldOf(ctx, { clientX: g.client.x + (dx * i) / steps, clientY: g.client.y + (dy * i) / steps });
    if (world) g.points.push(world);
  }
  g.client = { x: e.clientX, y: e.clientY };
}

/** The line being placed, through its points and on to the pointer `hover` (world points). */
function drawPath(ctx, hover = null) {
  const d = stateOf(ctx).gesture;
  if (!d || d.kind !== 'path') return;
  const points = hover ? [...d.points, hover] : d.points;
  drawLine(ctx, d.mode === 'curve' && points.length > 1 ? spline(points) : points, pathStyle(d.look));
}

/** Ends the line being placed: open, or `closed` in its closed look's fill. Under two points leaves nothing. */
function endPath(ctx, closed) {
  const d = stateOf(ctx).gesture;
  abandon(ctx);
  if (!d || d.kind !== 'path') return;
  const points = d.mode === 'curve' ? spline(d.points) : d.points;
  if (points.length < 2) return;
  create(ctx, 'Add path', pathFields(points, closed, d.look));
}

/** A press with a path tool: the first places the line's first point, a later one adds a point or closes the line. */
function pressPath(ctx, world) {
  const s = stateOf(ctx);
  const k = kOf(ctx.vp.camera.zoom);
  if (!s.gesture || s.gesture.kind !== 'path') {
    s.gesture = { kind: 'path', mode: ctx.api.mode, points: [world], look: { ...planeTools.shape } };
  } else if (s.gesture.points.length >= 2 && closes([...s.gesture.points, world], k)) {
    endPath(ctx, true);
    return;
  } else {
    const last = s.gesture.points.at(-1);
    if (Math.hypot(world.x - last.x, world.y - last.y) * k > CLOSE_PX) s.gesture.points.push(world);
  }
  drawPath(ctx, world);
}

/** Ends the line a tool switch interrupts; a stroke in progress is thrown away, so its preview never outlives its tool. */
function switchMode(ctx, mode) {
  const s = stateOf(ctx);
  if (s.gesture?.kind === 'path') endPath(ctx, false);
  else if (s.gesture) abandon(ctx);
  ctx.api.setMode(mode);
}

/** The pointer being taken away (cancelled, its capture lost, the window blurred): pointer.js answers the first two in its
 * own bubble listener on the root and hands `up` the press, which cannot tell a cancel, so this runs first, in the capture
 * phase on the window, and throws the drag away before that. Its events target the view's root; anything else is ignored. */
function cutListener(ctx) {
  return (e) => {
    const root = ctx.vp?.root;
    if (root && e.target !== root && !root.contains(e.target)) return;
    dropStroke(ctx);
  };
}

export default registerTool({
  id: 'pen',
  modes: MODES,

  // A tool switched from the rail ends the line being placed and throws a stroke in progress away, so nothing is left behind.
  mount(ctx) {
    const s = stateOf(ctx);
    abandon(ctx);
    const cut = cutListener(ctx);
    globalThis.addEventListener?.('pointercancel', cut, true);
    globalThis.addEventListener?.('lostpointercapture', cut, true);
    globalThis.addEventListener?.('blur', s.drop);
    const off = ctx.api?.subscribe?.(() => {
      const g = s.gesture;
      if (!g || g.mode === ctx.api.mode) return;
      if (g.kind === 'path') endPath(ctx, false);
      else abandon(ctx);
    });
    return () => {
      globalThis.removeEventListener?.('pointercancel', cut, true);
      globalThis.removeEventListener?.('lostpointercapture', cut, true);
      globalThis.removeEventListener?.('blur', s.drop);
      off?.();
      abandon(ctx);
      states.delete(ctx);
    };
  },

  // With a drawing tool armed, the press is this module's, whichever item is under it.
  pick(ctx) {
    const mode = ctx.api?.mode;
    if (!mode || !MODES.includes(mode)) {
      if (stateOf(ctx).gesture?.kind === 'path') endPath(ctx, false);
      return null;
    }
    if (stateOf(ctx).gesture?.kind === 'path' && stateOf(ctx).gesture.mode !== mode) endPath(ctx, false);
    return { kind: mode };
  },

  down(ctx, hit, e) {
    if (!hit || !MODES.includes(hit.kind)) return false;
    const world = worldOf(ctx, e);
    if (!world) return false;
    const s = stateOf(ctx);
    if (hit.kind === 'pen') {
      s.gesture = { kind: 'pen', mode: 'pen', points: [world], pen: { ...planeTools.pen } };
      drawLine(ctx, s.gesture.points, inkStyle(s.gesture.pen));
    } else if (hit.kind === 'eraser') {
      s.gesture = { kind: 'erase', mode: 'eraser', points: [world], client: { x: e.clientX, y: e.clientY } };
    } else {
      pressPath(ctx, world);
    }
    return true;
  },

  move(ctx, e) {
    const g = stateOf(ctx).gesture;
    if (!g) return;
    if (g.kind === 'pen') extendPen(ctx, e);
    else if (g.kind === 'erase') extendErase(ctx, e);
    else {
      const world = worldOf(ctx, e);
      if (world) drawPath(ctx, world);
    }
  },

  up(ctx) {
    const g = stateOf(ctx).gesture;
    if (!g) return;
    if (g.kind === 'pen') finishPen(ctx);
    else if (g.kind === 'erase') finishErase(ctx).catch((err) => console.warn('The eraser did not finish', err));
  },

  cancel(ctx) {
    abandon(ctx);
  },

  // A double-click ends the line being placed, open.
  dblclick(ctx) {
    if (stateOf(ctx).gesture?.kind !== 'path') return false;
    endPath(ctx, false);
    return true;
  },

  // P and E arm the pen and the eraser; Escape throws a stroke away, ends the line, or leaves the tool.
  keydown(ctx, e) {
    const api = ctx.api;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const g = stateOf(ctx).gesture;
    if (e.code === 'Escape') {
      if (g?.kind === 'path') {
        endPath(ctx, false);
        return true;
      }
      if (g) {
        abandon(ctx);
        api.setMode(null);
        return true;
      }
      if (!api.mode || !MODES.includes(api.mode)) return false;
      api.setMode(null);
      return true;
    }
    const keys = { 'board.pen': () => switchMode(ctx, 'pen'), 'board.eraser': () => switchMode(ctx, 'eraser') };
    const id = keyAmong(Object.keys(keys), e);
    if (!id) return false;
    keys[id]();
    return true;
  },
});

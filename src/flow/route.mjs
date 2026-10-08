// Connector routing (docs/plans/flowchart.md §3.4, SPEC §6d): resolveConnectors writes each connector's derived fields (bbox
// x y w h, shaft path `d`, `tips`, label anchors `lps`) from its ends, waypoints and route, so rendering never needs the
// siblings. Pure (no DOM).
import { anchorPoint, outlineOf, perimeter, portNormal, rotBox } from './shapes.mjs';
import { ANCHOR_NAMES, defaultMeasure, LABEL_SLOTS, repairEnds } from './model.mjs';

const STUB = 20; // ortho: the straight run out of a bound end (past its turned box), and the detours' clearance
const BEND = 1e6; // ortho grid search: a turn costs more than any length, so the fewest turns win, then the shortest path
const SAMPLES = 16; // curve: polyline points per bezier segment (labels, hit-testing, marquee)
export const JUMP = 6; // line jumps: arc radius / half the gap, px
export const JUMP_CAP = 20000; // line jumps: segment pairs tested per resolve, at most
export const LABEL_PAD = { x: 4, y: 2 }; // connector label padding px (whiteboard.js draws labels with it)
const EPS = 1e-6;
const r1 = (n) => Math.round(n * 10) / 10;
const fit = (v, min, max) => Math.max(min, Math.min(v, max));
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const unit = (v) => {
  const l = Math.hypot(v.x, v.y);
  return l > EPS ? { x: v.x / l, y: v.y / l } : null;
};
const angle = (from, to) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
const axisOf = (v) => (Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) });

// --- polylines ---

// The polyline `pts` without its first `len` px (at least its last point stays).
function trimStart(pts, len) {
  const out = pts.slice();
  let rest = len;
  while (out.length > 1 && rest > 0) {
    const d = dist(out[0], out[1]);
    if (d > rest) {
      out[0] = lerp(out[0], out[1], rest / d);
      break;
    }
    rest -= d;
    out.shift();
  }
  return out;
}
const trimEnd = (pts, len) => trimStart(pts.slice().reverse(), len).reverse();

function lengths(pts) {
  const acc = [0];
  for (let k = 1; k < pts.length; k++) acc.push(acc[k - 1] + dist(pts[k - 1], pts[k]));
  return acc;
}

/** The point at fraction t (0..1) of the polyline's length. */
export function polylinePoint(pts, t) {
  const acc = lengths(pts);
  const s = fit(t, 0, 1) * acc.at(-1);
  let k = 1;
  while (k < pts.length - 1 && acc[k] < s) k++;
  const seg = (acc[k] ?? 0) - (acc[k - 1] ?? 0);
  return seg > 0 ? lerp(pts[k - 1], pts[k], (s - acc[k - 1]) / seg) : { x: pts[k]?.x ?? pts[0].x, y: pts[k]?.y ?? pts[0].y };
}

/** The fraction t of the polyline's length at its point nearest to `p`. */
export function nearestT(pts, p) {
  const acc = lengths(pts);
  if (!(acc.at(-1) > 0)) return 0;
  let [best, at] = [Infinity, 0];
  for (let k = 1; k < pts.length; k++) {
    const [a, b, len] = [pts[k - 1], pts[k], acc[k] - acc[k - 1]];
    const u = len > 0 ? fit(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len), 0, 1) : 0;
    const d = dist(lerp(a, b, u), p);
    if (d < best) [best, at] = [d, acc[k - 1] + u * len];
  }
  return at / acc.at(-1);
}

/** Whether polyline `pts` touches rectangle `r` ({x, y, w, h}, edges included): marquee selection of a connector. */
export function polylineHitsRect(pts, r) {
  const inRect = (p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (pts.length === 1) return inRect(pts[0]);
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1], pts[k]];
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    let [t0, t1] = [0, 1];
    const clip = (p, q) => {
      if (Math.abs(p) < EPS) return q >= 0;
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      return t0 <= t1;
    };
    if (clip(-dx, a.x - r.x) && clip(dx, r.x + r.w - a.x) && clip(-dy, a.y - r.y) && clip(dy, r.y + r.h - a.y)) return true;
  }
  return false;
}

// --- heads ---

const headSize = (width) => Math.max(10, width * 3.5);

// A head in a local frame: the tip at 0,0, the line arriving from -x. ops: ['M' | 'L', x, y], ['Z'], ['O', cx, r] (a circle
// centred on the axis). trim: how far before the tip the shaft stops (open heads end where their outline starts; the ER
// circles cut the shaft, and the head draws the line on from the circle to the tip, so no board colour is needed).
function headShape(kind, width) {
  const S = headSize(width);
  const [hw, r] = [S * 0.5, S * 0.35];
  const bar = (x) => [['M', x, -hw], ['L', x, hw]];
  const crow = [['M', 0, -hw], ['L', -S, 0], ['L', 0, hw]];
  const tri = [['M', 0, 0], ['L', -S, -hw], ['L', -S, hw], ['Z']];
  const dia = [['M', 0, 0], ['L', -S * 0.75, -hw * 0.75], ['L', -S * 1.5, 0], ['L', -S * 0.75, hw * 0.75], ['Z']];
  const zero = (x) => [['O', x - r, r], ['M', x, 0], ['L', 0, 0]]; // a circle ending at x, then the line on to the tip
  const c = hw * 0.7;
  return {
    arrow: { ops: [['M', -S, -hw], ['L', 0, 0], ['L', -S, hw]], trim: 0 },
    triangle: { ops: tri, fill: true, trim: S * 0.8 },
    'triangle-open': { ops: tri, trim: S + width / 2 },
    diamond: { ops: dia, fill: true, trim: S * 1.2 },
    'diamond-open': { ops: dia, trim: S * 1.5 + width / 2 },
    circle: { ops: [['O', -r, r]], fill: true, trim: r },
    'circle-open': { ops: [['O', -r, r]], trim: 2 * r + width / 2 },
    bar: { ops: bar(0), trim: width / 2 },
    cross: { ops: [['M', -S / 2 - c, -c], ['L', -S / 2 + c, c], ['M', -S / 2 - c, c], ['L', -S / 2 + c, -c]], trim: 0 },
    one: { ops: bar(-S * 0.6), trim: 0 },
    'exactly-one': { ops: [...bar(-S * 0.6), ...bar(-S)], trim: 0 },
    many: { ops: crow, trim: 0 },
    'one-many': { ops: [...crow, ...bar(-S * 1.3)], trim: 0 },
    'zero-one': { ops: [...bar(-S * 0.6), ...zero(-S * 1.1)], trim: S * 1.1 + 2 * r + width / 2 },
    'zero-many': { ops: [...crow, ...zero(-S * 1.2)], trim: S * 1.2 + 2 * r + width / 2 },
  }[kind] ?? { ops: [], trim: 0 }; // 'none'
}

/** How far before its tip the shaft stops for head `kind`. */
export const headTrim = (kind, width) => headShape(kind, width).trim;

/** Head `kind` at `tip` ({x, y, a}: the tip and the direction it points, degrees) for line width `width` → {d, fill, pts}:
 * the SVG path, whether it is filled (else stroked like the line), and its extreme points (bbox). */
export function headPath(kind, tip, width) {
  const { ops, fill = false } = headShape(kind, width);
  const a = (tip.a * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  const at = (x, y) => ({ x: tip.x + x * cos - y * sin, y: tip.y + x * sin + y * cos });
  const P = (p) => `${r1(p.x)} ${r1(p.y)}`;
  let d = '';
  const pts = [];
  for (const [op, x, y] of ops) {
    if (op === 'Z') d += 'Z';
    else if (op === 'O') {
      const [o, p, q, s] = [at(x, 0), at(x + y, 0), at(x - y, 0), r1(y)];
      d += `M${P(p)}A${s} ${s} 0 1 0 ${P(q)}A${s} ${s} 0 1 0 ${P(p)}Z`;
      pts.push({ x: o.x - y, y: o.y - y }, { x: o.x + y, y: o.y + y });
    } else {
      const p = at(x, y);
      d += `${op}${P(p)}`;
      pts.push(p);
    }
  }
  return { d, fill, pts };
}

// --- ends ---

// box: the item's turned bounds (ortho stubs leave it, routes go around it). An anchor name (a stored item that never went
// through cleanConnector, such as hand-written JSON) is its fraction; before 2026-10-07 it routed to the item's centre.
function endOf(e, byId, measure) {
  if (typeof e.item !== 'string') return { free: { x: e.x, y: e.y } };
  const it = byId.get(e.item);
  const b = measure(it);
  const anchor = typeof e.anchor === 'string' ? ANCHOR_NAMES[e.anchor] ?? null : e.anchor;
  return { it, b, anchor, c: { x: b.x + b.w / 2, y: b.y + b.h / 2 }, box: rotBox({ ...b, rot: it.type === 'shape' ? it.rot : 0 }) };
}

// The point the other end aims at: a free point, a fixed anchor's point, else the item's centre.
const refOf = (E) => E.free ?? (E.anchor ? anchorPoint(E.it, E.anchor, E.b) : E.c);

// Straight / curve attachment → {p, n: outward direction or null}: a fixed anchor's outline point; a floating end where the
// ray from the centre toward `toward` leaves the (turned) outline.
function attach(E, toward) {
  if (E.free) return { p: E.free, n: null };
  if (E.anchor) return { p: anchorPoint(E.it, E.anchor, E.b), n: portNormal(E.it, E.anchor) };
  const p = perimeter(outlineOf(E.it, E.b), E.c, toward);
  return { p, n: unit(sub(p, E.c)) };
}

// Ortho attachment: leaves along the board axis closest to the anchor's (turned) normal; a floating end from the side facing
// `toward`, where that axis from the centre crosses the outline.
function attachOrtho(E, toward) {
  if (E.free) return { p: E.free, n: null };
  const poly = outlineOf(E.it, E.b);
  if (E.anchor) return { p: anchorPoint(E.it, E.anchor, E.b), n: axisOf(portNormal(E.it, E.anchor)), box: E.box, poly, fixed: true };
  const n = axisOf(sub(toward, E.c));
  return { p: perimeter(poly, E.c, add(E.c, n)), n, box: E.box, poly };
}

// --- straight runs (draw.io-style) ---

const across = (E) => (E.n.x ? 'y' : 'x'); // the board axis an ortho end's tip slides along: across its normal
const span = (E, k) => [Math.min(...E.poly.map((q) => q[k])), Math.max(...E.poly.map((q) => q[k]))];
const ahead = (E, q) => (q.x - E.p.x) * E.n.x + (q.y - E.p.y) * E.n.y > EPS;

// End E's tip slid along its side to coordinate s (across its normal): where that line leaves its outline on the n side.
function slide(E, s) {
  const k = across(E);
  return Math.abs(s - E.p[k]) > EPS ? { ...E, p: perimeter(E.poly, { ...add(E.p, E.n, -1e4), [k]: s }, { ...E.p, [k]: s }) } : E;
}

// Ortho ends a, b slid so the run to what each faces next is straight, not a micro-jog: two facing item ends meet at one
// coordinate (the source's, else the target's, else, both floating, the middle of their outlines' overlap), else an end
// lines up with its waypoint or the other, free end. A floating end slides anywhere inside its outline's extent; a fixed
// port by at most `snap` px (max(4, 2 × width)). Coordinates a floating end picks are crisp for `width` (whole px for even
// widths, half px for odd). → [a, b, straight: one segment a.p–b.p].
function align(a, b, points, width) {
  const snap = Math.max(4, 2 * width);
  const crisp = (v) => (Math.round(width) % 2 ? Math.floor(v) + 0.5 : Math.round(v));
  const ok = (E, s) => {
    const k = across(E);
    const [lo, hi] = span(E, k);
    const d = Math.abs(s - E.p[k]);
    return d <= EPS || (s > lo + EPS && s < hi - EPS && (!E.fixed || d <= snap)); // a slid tip stays on its side (corner ports)
  };
  if (!points.length && a.n && b.n) {
    if (a.n.x !== -b.n.x || a.n.y !== -b.n.y || !ahead(a, b.p)) return [a, b, false];
    const k = across(a);
    const [[la, ha], [lb, hb]] = [span(a, k), span(b, k)];
    const own = (E) => (E.fixed ? E.p[k] : crisp(E.p[k]));
    const s = [own(a), own(b), a.fixed || b.fixed ? NaN : crisp((Math.max(la, lb) + Math.min(ha, hb)) / 2)].find((v) => ok(a, v) && ok(b, v));
    if (s === undefined) return [a, b, false];
    const [a2, b2] = [slide(a, s), slide(b, s)];
    return ahead(a2, b2.p) ? [a2, b2, true] : [a, b, false];
  }
  const end = (E, q) => (E.n && q && ahead(E, q) && ok(E, q[across(E)]) ? slide(E, q[across(E)]) : E);
  return [end(a, points[0] ?? (b.n ? null : b.p)), end(b, points.at(-1) ?? (a.n ? null : a.p)), false];
}

// --- ortho ---

// Turns along `pts` with heading `ha` before it and `hb` after it; null if a segment is diagonal or turns back.
function turns(pts, ha, hb) {
  const dirs = ha ? [ha] : [];
  for (let k = 1; k < pts.length; k++) {
    const [dx, dy] = [pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y];
    const [mx, my] = [Math.abs(dx) > EPS, Math.abs(dy) > EPS];
    if (mx && my) return null;
    if (mx || my) dirs.push({ x: mx ? Math.sign(dx) : 0, y: my ? Math.sign(dy) : 0 });
  }
  if (hb) dirs.push(hb);
  let n = 0;
  for (let k = 1; k < dirs.length; k++) {
    const dot = dirs[k].x * dirs[k - 1].x + dirs[k].y * dirs[k - 1].y;
    if (dot < 0) return null;
    if (dot === 0) n++;
  }
  return n;
}

// Whether the axis-aligned segment p–q passes through the inside of box r (running along an edge does not).
const through = (p, q, r) => Math.max(p.x, q.x) > r.x + EPS && Math.min(p.x, q.x) < r.x + r.w - EPS &&
  Math.max(p.y, q.y) > r.y + EPS && Math.min(p.y, q.y) < r.y + r.h - EPS;
const crosses = (path, boxes) => path.slice(1).some((q, k) => boxes.some((r) => through(path[k], q, r)));
const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const dirOf = (h) => (h ? DIRS.findIndex((d) => d.x === h.x && d.y === h.y) : 4); // 4: no heading yet

// The corners of the fewest-turn, then shortest, path from a (reached heading `ha`) to b (left heading `hb`) that never turns
// back and never goes through `boxes`, on the grid of the lines through a, b, their middle and STUB px outside each box;
// null when there is none. Dijkstra over (node, heading): A* without a heuristic, the grid has at most 7 × 7 nodes.
function gridLeg(a, ha, b, hb, boxes) {
  const lines = (k, size) => [...new Set([a[k], b[k], (a[k] + b[k]) / 2, ...boxes.flatMap((q) => [q[k] - STUB, q[k] + q[size] + STUB])])].sort((u, v) => u - v);
  const [xs, ys] = [lines('x', 'w'), lines('y', 'h')];
  const at = (s) => ({ i: Math.floor(s / 5 / ys.length), j: Math.floor(s / 5) % ys.length, d: s % 5 });
  const state = (i, j, d) => (i * ys.length + j) * 5 + d;
  const cost = new Map([[state(xs.indexOf(a.x), ys.indexOf(a.y), dirOf(ha)), 0]]);
  const prev = new Map();
  const open = [...cost.keys()];
  const done = new Set();
  while (open.length) {
    open.sort((u, v) => cost.get(v) - cost.get(u));
    const s = open.pop();
    if (done.has(s)) continue;
    done.add(s);
    const { i, j, d } = at(s);
    DIRS.forEach((dir, k) => {
      const [ni, nj] = [i + dir.x, j + dir.y];
      if ((d < 4 && k === (d + 2) % 4) || xs[ni] === undefined || ys[nj] === undefined) return;
      const [p, q] = [{ x: xs[i], y: ys[j] }, { x: xs[ni], y: ys[nj] }];
      if (boxes.some((r) => through(p, q, r))) return;
      const [t, c] = [state(ni, nj, k), cost.get(s) + dist(p, q) + (d < 4 && k !== d ? BEND : 0)];
      if (c >= (cost.get(t) ?? Infinity)) return;
      cost.set(t, c);
      prev.set(t, s);
      open.push(t);
    });
  }
  const [bi, bj, hd] = [xs.indexOf(b.x), ys.indexOf(b.y), dirOf(hb)];
  let [end, best] = [-1, Infinity];
  for (let k = 0; k < 5; k++) {
    const c = (cost.get(state(bi, bj, k)) ?? Infinity) + (hd < 4 && k < 4 && k !== hd ? BEND : 0);
    if (!(hd < 4 && k === (hd + 2) % 4) && c < best) [end, best] = [state(bi, bj, k), c];
  }
  if (end < 0) return null;
  const path = [];
  for (let s = prev.get(end); s !== undefined; s = prev.get(s)) path.unshift({ x: xs[at(s).i], y: ys[at(s).j] });
  return path.slice(1); // without a (simplify drops the points on straight runs)
}

// The corners from a (reached heading `ha`) to b (left heading `hb`): the candidate with the fewest turns that never turns
// back and stays out of `boxes`: straight, Z (centred), L, then detours around `box` (the bound items' bounds) for ends facing
// away from each other; when every candidate goes through a box, the grid search (gridLeg); failing that, the best candidate.
function orthoLeg(a, ha, b, hb, box, boxes) {
  const [mx, my] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  const [l, t] = [Math.min(a.x, b.x, box?.x ?? Infinity) - STUB, Math.min(a.y, b.y, box?.y ?? Infinity) - STUB];
  const [r, btm] = [Math.max(a.x, b.x, box ? box.x + box.w : -Infinity) + STUB, Math.max(a.y, b.y, box ? box.y + box.h : -Infinity) + STUB];
  const cands = [
    [], [{ x: mx, y: a.y }, { x: mx, y: b.y }], [{ x: a.x, y: my }, { x: b.x, y: my }], [{ x: b.x, y: a.y }], [{ x: a.x, y: b.y }],
    [{ x: a.x, y: t }, { x: b.x, y: t }], [{ x: a.x, y: btm }, { x: b.x, y: btm }], [{ x: l, y: a.y }, { x: l, y: b.y }], [{ x: r, y: a.y }, { x: r, y: b.y }],
  ];
  let [any, anyScore, best, score] = [[{ x: b.x, y: a.y }], Infinity, null, Infinity];
  cands.forEach((mid, k) => {
    const n = turns([a, ...mid, b], ha, hb);
    if (n === null) return;
    if (n * 100 + k < anyScore) [any, anyScore] = [mid, n * 100 + k];
    if (n * 100 + k < score && !crosses([a, ...mid, b], boxes)) [best, score] = [mid, n * 100 + k];
  });
  return best ?? (boxes.length ? gridLeg(a, ha, b, hb, boxes) : null) ?? any;
}

// Drops repeated points and points on a straight run.
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && dist(out.at(-1), p) < 0.01) continue;
    if (out.length > 1) {
      const [a, b] = [out.at(-2), out.at(-1)];
      const [u, v] = [sub(b, a), sub(p, b)];
      if (Math.abs(u.x * v.y - u.y * v.x) < EPS && u.x * v.x + u.y * v.y > 0) out.pop();
    }
    out.push(p);
  }
  return out;
}

const inside = (p, r) => p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS;

// a, b: {p, n, box, poly, fixed}, first lined up (align: then possibly one straight segment). Stubs reaching STUB px past
// the end's turned box (shorter when two facing ends are closer than the two stubs), then legs through the waypoints that
// keep out of both boxes (except a box holding the leg's own start or end).
function orthoRoute(a0, b0, points, width) {
  const [a, b, straight] = align(a0, b0, points, width);
  if (straight) return [a.p, b.p];
  const boxes = [a.box, b.box].filter(Boolean);
  const box = boxes.reduce((u, q) => (u ? { x: Math.min(u.x, q.x), y: Math.min(u.y, q.y), w: Math.max(u.x + u.w, q.x + q.w) - Math.min(u.x, q.x), h: Math.max(u.y + u.h, q.y + q.h) - Math.min(u.y, q.y) } : q), null);
  const exit = ({ p, n, box: r }) => Math.max(0, n.x > 0 ? r.x + r.w - p.x : n.x < 0 ? p.x - r.x : n.y > 0 ? r.y + r.h - p.y : p.y - r.y);
  let [sa, sb] = [a, b].map((E) => (E.n ? STUB + exit(E) : 0));
  if (a.n && b.n && a.n.x === -b.n.x && a.n.y === -b.n.y) {
    const along = (b.p.x - a.p.x) * a.n.x + (b.p.y - a.p.y) * a.n.y;
    if (along > 0) [sa, sb] = [Math.max(exit(a), Math.min(sa, along / 2)), Math.max(exit(b), Math.min(sb, along / 2))];
  }
  const pts = [a.p];
  let [cur, head] = [a.p, null];
  if (a.n) {
    cur = add(a.p, a.n, sa);
    head = a.n;
    pts.push(cur);
  }
  const targets = [...points, b.n ? add(b.p, b.n, sb) : b.p];
  targets.forEach((to, k) => {
    const hb = k === targets.length - 1 && b.n ? { x: -b.n.x, y: -b.n.y } : null;
    const mid = orthoLeg(cur, head, to, hb, box, boxes.filter((r) => !inside(cur, r) && !inside(to, r)));
    const from = [cur, ...mid].reverse().find((q) => dist(q, to) > EPS);
    if (from) head = axisOf(sub(to, from));
    pts.push(...mid, to);
    cur = to;
  });
  if (b.n) pts.push(b.p);
  return simplify(pts);
}

// --- curves ---

// Cubic segments [p0, c1, c2, p1] through P (Catmull-Rom); a bound end leaves along its normal n0 / n1.
function cubics(P, n0, n1) {
  const last = P.length - 1;
  const T = P.map((p, k) => {
    if (k === 0) return n0 ? add({ x: 0, y: 0 }, n0, dist(P[0], P[1])) : sub(P[1], P[0]);
    if (k === last) return n1 ? add({ x: 0, y: 0 }, n1, -dist(P[k - 1], P[k])) : sub(P[k], P[k - 1]);
    return { x: (P[k + 1].x - P[k - 1].x) / 2, y: (P[k + 1].y - P[k - 1].y) / 2 };
  });
  return P.slice(0, -1).map((p, k) => [p, add(p, T[k], 1 / 3), add(P[k + 1], T[k + 1], -1 / 3), P[k + 1]]);
}

const bez = ([a, b, c, d], t) => {
  const m = 1 - t;
  return { x: m * m * m * a.x + 3 * m * m * t * b.x + 3 * m * t * t * c.x + t * t * t * d.x, y: m * m * m * a.y + 3 * m * m * t * b.y + 3 * m * t * t * c.y + t * t * t * d.y };
};

function split([p0, p1, p2, p3], t) {
  const [a, b, c] = [lerp(p0, p1, t), lerp(p1, p2, t), lerp(p2, p3, t)];
  const [d, e] = [lerp(a, b, t), lerp(b, c, t)];
  const f = lerp(d, e, t);
  return [[p0, a, d, f], [f, e, c, p3]];
}

// The segment without its first `len` px (by chord distance from its start).
function trimCubic(seg, len) {
  if (!(len > 0)) return seg;
  let prev = 0;
  for (let k = 1; k <= 64; k++) {
    const t = k / 64;
    const d = dist(seg[0], bez(seg, t));
    if (d >= len) {
      const d0 = dist(seg[0], bez(seg, prev));
      return split(seg, prev + ((t - prev) * (len - d0)) / (d - d0 || 1))[1];
    }
    prev = t;
  }
  return split(seg, 0.5)[1];
}
const reverseCubic = (s) => [s[3], s[2], s[1], s[0]];

// --- paths ---

// The connector's polyline (board px; curves sampled), its Bézier segments (curves), tips and head trims.
function pathOf(c, byId, measure) {
  const { route = 'ortho', points = [], heads = {}, width = 2 } = c;
  const [A, B] = [endOf(c.from, byId, measure), endOf(c.to, byId, measure)];
  // A loop on one item with both ends floating leaves the item's east side and comes back into its north side.
  if (A.it && A.it === B.it && !A.anchor && !B.anchor && !points.length) [A.anchor, B.anchor] = [[1, 0.5], [0.5, 0]];
  let pts;
  let cubs = null;
  if (route === 'ortho') {
    pts = orthoRoute(attachOrtho(A, points[0] ?? refOf(B)), attachOrtho(B, points.at(-1) ?? refOf(A)), points, width);
  } else {
    const [a, b] = [attach(A, points[0] ?? refOf(B)), attach(B, points.at(-1) ?? refOf(A))];
    const P = [a.p, ...points, b.p];
    if (route === 'curve') {
      cubs = cubics(P, a.n, b.n);
      pts = [P[0], ...cubs.flatMap((s) => Array.from({ length: SAMPLES }, (_, k) => bez(s, (k + 1) / SAMPLES)))];
    } else pts = P;
  }
  const [hs, he] = [heads.start ?? 'none', heads.end ?? 'arrow'];
  const [ts, te] = [headTrim(hs, width), headTrim(he, width)];
  const n = pts.length - 1;
  // Tips point along the path's last run: ortho / straight its end segments; a curve the chord over the head's length.
  const aim = (list, trim) => (cubs ? trimStart(list, Math.max(trim, headSize(width)))[0] : list[1] ?? list[0]);
  const tipsAbs = [
    { x: pts[0].x, y: pts[0].y, a: n ? angle(aim(pts, ts), pts[0]) : 180 },
    { x: pts[n].x, y: pts[n].y, a: n ? angle(aim(pts.slice().reverse(), te), pts[n]) : 0 },
  ];
  return { pts, cubs, tipsAbs, hs, he, ts, te };
}

// --- line jumps ---

const jumps = (c) => (c.jump === 'arc' || c.jump === 'gap') && c.route !== 'curve';
const cross2 = (u, v) => u.x * v.y - u.y * v.x;

// Where segment p (a → b) properly crosses segment q, as a fraction of p; null when they do not cross, are parallel or only touch.
function crossAt(p, q) {
  const [r, s, w] = [sub(p.b, p.a), sub(q.b, q.a), sub(q.a, p.a)];
  const den = cross2(r, s);
  if (Math.abs(den) < EPS) return null;
  const [t, u] = [cross2(w, s) / den, cross2(w, r) / den];
  return t > EPS && t < 1 - EPS && u > EPS && u < 1 - EPS ? t : null;
}

/** Line jumps → {hits: Map id → ascending distances along its polyline where it jumps, capped}. `paths`: [{id, pts, jump,
 * curve}] in z-order. A connector with `jump` jumps where it crosses a straight segment of a connector below it (z-order
 * decides: the upper line jumps); curves neither jump nor are jumped. Segment pairs come from a sweep over x with a bbox-overlap
 * prefilter; after `cap` pair tests the rest is left out and `capped` is true. */
export function findJumps(paths, cap = JUMP_CAP) {
  const segs = [];
  paths.forEach(({ pts, jump, curve }, z) => {
    if (curve) return;
    let s = 0;
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1], pts[k]];
      segs.push({ z, a, b, s, jump, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
      s += dist(a, b);
    }
  });
  segs.sort((u, v) => u.x0 - v.x0);
  const hits = new Map();
  let [tests, active] = [0, []];
  for (const s of segs) {
    active = active.filter((q) => q.x1 >= s.x0);
    for (const q of active) {
      if (q.z === s.z || q.y1 < s.y0 || q.y0 > s.y1) continue;
      const [hi, lo] = s.z > q.z ? [s, q] : [q, s];
      if (!hi.jump) continue;
      if (++tests > cap) return { hits, capped: true };
      const t = crossAt(hi, lo);
      if (t === null) continue;
      const id = paths[hi.z].id;
      hits.set(id, [...(hits.get(id) ?? []), hi.s + t * dist(hi.a, hi.b)]);
    }
    active.push(s);
  }
  for (const list of hits.values()) list.sort((u, v) => u - v);
  return { hits, capped: false };
}

// The rounded-corner radius at shaft[k] (0: a sharp corner or none).
function cornerAt(shaft, k, ortho, corner) {
  const [a, b, q] = [shaft[k - 1], shaft[k], shaft[k + 1]];
  const rr = ortho && a && q ? Math.min(corner, dist(a, b) / 2, dist(b, q) / 2) : 0;
  return rr >= 0.5 ? rr : 0;
}

// The jumps drawn on the shaft: [{k (its segment shaft[k-1] → shaft[k]), p0, p1 (where it leaves and rejoins the line), top
// (the arc's apex), sweep}]. `hits`: distances along the untrimmed polyline (the shaft starts `offset` px in). A jump needs
// JUMP px clear of a rounded corner and 2 · JUMP from the previous one; others are left out. The arc bulges up (a vertical
// line: left).
function placeJumps(shaft, hits, offset, ortho, corner) {
  const out = [];
  let acc = 0;
  for (let k = 1; k < shaft.length; k++) {
    const [a, b] = [shaft[k - 1], shaft[k]];
    const len = dist(a, b);
    const u = unit(sub(b, a));
    const [lo, hi] = [cornerAt(shaft, k - 1, ortho, corner) + JUMP, len - cornerAt(shaft, k, ortho, corner) - JUMP];
    const up = u && (u.x > EPS || (Math.abs(u.x) <= EPS && u.y < 0)); // the normal (u.y, -u.x) points up (or left)
    let last = -Infinity;
    for (const h of hits) {
      const at = h - offset - acc;
      if (!u || at < lo || at > hi || at - last < 2 * JUMP) continue;
      last = at;
      const n = up ? { x: u.y, y: -u.x } : { x: -u.y, y: u.x };
      out.push({ k, p0: add(a, u, at - JUMP), p1: add(a, u, at + JUMP), top: add(add(a, u, at), n, JUMP), sweep: up ? 1 : 0 });
    }
    acc += len;
  }
  return out;
}

// --- resolve ---

// Its lines as drawn: <br> and the <div> / <p> lines contenteditable makes on Enter (as graph.mjs htmlToText); a <br> that ends
// a line is only its placeholder.
function labelBox(l) {
  const lines = String(l.html).replace(/<br\s*\/?>(?=<\/(?:div|p)>)/gi, '').replace(/<br\s*\/?>|<(?:div|p)(?:\s[^>]*)?>/gi, '\n')
    .replace(/^\n/, '').replace(/<[^>]*>/g, '').replace(/&[#\w]+;/g, 'x').split('\n');
  const size = l.size ?? 14;
  return { w: Math.max(...lines.map((s) => s.length)) * size * 0.6 + 2 * LABEL_PAD.x, h: lines.length * size * 1.3 + 2 * LABEL_PAD.y };
}

// The derived fields (bbox, d with any jumps spliced in, tips, label anchors) and geo of connector c routed as `path`.
function finish(c, { pts, cubs, tipsAbs, hs, he, ts, te }, hits) {
  const { route = 'ortho', corner = 8, width = 2, labels = {} } = c;
  const ortho = route === 'ortho';
  // The bbox: path, heads, jump arcs and labels, padded by half the line width + 1.
  const ext = [...pts, ...headPath(hs, tipsAbs[0], width).pts, ...headPath(he, tipsAbs[1], width).pts];
  const anchors = {};
  for (const [slot, t] of Object.entries(LABEL_SLOTS)) {
    const l = labels[slot];
    if (!l) continue;
    const p = polylinePoint(pts, l.t ?? t);
    const q = { x: p.x + (l.dx ?? 0), y: p.y + (l.dy ?? 0) };
    const { w, h } = labelBox(l);
    anchors[slot] = q;
    ext.push({ x: q.x - w / 2, y: q.y - h / 2 }, { x: q.x + w / 2, y: q.y + h / 2 });
  }
  const shaft = cubs ? null : trimEnd(trimStart(pts, ts), te);
  const js = shaft && hits && jumps(c) ? placeJumps(shaft, hits, ts, ortho, corner) : [];
  if (c.jump === 'arc') ext.push(...js.map((j) => j.top));
  const pad = width / 2 + 1;
  const x = Math.floor(Math.min(...ext.map((p) => p.x)) - pad);
  const y = Math.floor(Math.min(...ext.map((p) => p.y)) - pad);
  const w = Math.max(1, Math.ceil(Math.max(...ext.map((p) => p.x)) + pad) - x);
  const h = Math.max(1, Math.ceil(Math.max(...ext.map((p) => p.y)) + pad) - y);
  const P = (p) => `${r1(p.x - x)} ${r1(p.y - y)}`;
  let d;
  if (cubs) {
    const segs = cubs.slice();
    segs[0] = trimCubic(segs[0], ts);
    segs[segs.length - 1] = reverseCubic(trimCubic(reverseCubic(segs.at(-1)), te));
    d = `M${P(segs[0][0])}${segs.map((s) => `C${P(s[1])} ${P(s[2])} ${P(s[3])}`).join('')}`;
  } else {
    d = `M${P(shaft[0])}`;
    for (let k = 1; k < shaft.length; k++) {
      for (const j of js) if (j.k === k) d += `L${P(j.p0)}${c.jump === 'gap' ? 'M' : `A${JUMP} ${JUMP} 0 0 ${j.sweep} `}${P(j.p1)}`;
      const [a, b, q] = [shaft[k - 1], shaft[k], shaft[k + 1]];
      const rr = cornerAt(shaft, k, ortho, corner);
      d += rr ? `L${P(lerp(b, a, rr / dist(a, b)))}Q${P(b)} ${P(lerp(b, q, rr / dist(b, q)))}` : `L${P(b)}`;
    }
  }
  const rel = (p) => ({ x: r1(p.x - x), y: r1(p.y - y) });
  return {
    fields: { x, y, w, h, d, tips: tipsAbs.map((t) => ({ ...rel(t), a: r1(t.a) })), lps: Object.fromEntries(Object.entries(anchors).map(([s, p]) => [s, rel(p)])) },
    geo: { pts, segs: pts.slice(1).map((p, k) => [pts[k], p]), tipsAbs },
  };
}

/** → {items, geo, capped}: `items` with every connector (or only those whose id is in the Set `onlyIds`) re-routed (dangling
 * ends repaired first, model.mjs repairEnds); geo: Map id → {pts (board px polyline, curves sampled), segs, tipsAbs} for
 * hit-testing and marquee, never stored; capped: the line-jump work cap was hit (findJumps). `measure(item)` → its unrotated
 * box (text: its rendered height). While any connector jumps, every connector is re-routed (its jumps depend on the lines
 * below it). */
export function resolveConnectors(items, measure = defaultMeasure, onlyIds = null) {
  const list = repairEnds(items);
  const byId = new Map(list.map((i) => [i.id, i]));
  const conns = list.filter((c) => c.type === 'connector');
  const jumpy = conns.some(jumps);
  const paths = new Map(conns.filter((c) => jumpy || !onlyIds || onlyIds.has(c.id)).map((c) => [c.id, pathOf(c, byId, measure)]));
  const { hits, capped } = jumpy
    ? findJumps(conns.map((c) => ({ id: c.id, pts: paths.get(c.id).pts, jump: jumps(c), curve: c.route === 'curve' })))
    : { hits: new Map(), capped: false };
  const geo = new Map();
  const out = list.map((c) => {
    if (!paths.has(c.id)) return c;
    const r = finish(c, paths.get(c.id), hits.get(c.id));
    geo.set(c.id, r.geo);
    return { ...c, ...r.fields };
  });
  return { items: out, geo, capped };
}

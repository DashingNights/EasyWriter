// DrawingML geometry (ECMA-376 Part 1 §20.1.9 shape guides and paths, §20.1.10.56 the preset shapes): every preset of
// src/flow/preset-data.mjs (generated from the vendored presetShapeDefinitions.xml) evaluated into SVG paths at any size and
// adjustment, with its adjust handles, text rectangle and connection sites. Pure, plain JS: the board (src/flow/shapes.mjs,
// whiteboard.js), the Word gallery and the .docx import and export all draw through it.
// A path is a list of parts {d, fill, stroke}: d in SVG commands M, L, Q, C and Z only (arcs become cubic Béziers), fill one of
// 'norm' (the shape's fill), 'none', 'lighten', 'lightenLess', 'darken', 'darkenLess'; stroke false for an unstroked part.
import { PRESETS } from './preset-data.mjs';

// Radians per 60000th of a degree, for at2 and the arcs. sin, cos and tan convert through rad() below on purpose, since its
// rounding differs: keep them on rad().
const ANG = Math.PI / 10800000;
const r2 = (n) => Math.round(n * 100) / 100;
// An angle in radians as Word works it out, through degrees: sin and cos then carry Word's rounding errors (its PDFs of custom
// geometry give the same at 90, 180, 270, 360 and 450 degrees, test/word-shape-geometry-word.test.mjs), and the sign tests some
// presets make on such a value go Word's way. a * ANG rounds otherwise: leftCircularArrow at 359.99998 degrees drew no inner ring
// where Word draws a whole one.
const rad = (a) => ((a / 60000) * Math.PI) / 180;

// ---------- guides (§20.1.9.11 ST_GeomGuideFormula) ----------
const OPS = {
  '*/': (x, y, z) => (z ? (x * y) / z : 0), '+-': (x, y, z) => x + y - z, '+/': (x, y, z) => (z ? (x + y) / z : 0), '?:': (x, y, z) => (x > 0 ? y : z),
  abs: (x) => Math.abs(x), at2: (x, y) => Math.atan2(y, x) / ANG, cat2: (x, y, z) => x * Math.cos(Math.atan2(z, y)), cos: (x, y) => x * Math.cos(rad(y)),
  max: (x, y) => Math.max(x, y), min: (x, y) => Math.min(x, y), mod: (x, y, z) => Math.hypot(x, y, z), pin: (x, y, z) => (y < x ? x : y > z ? z : y),
  sat2: (x, y, z) => x * Math.sin(Math.atan2(z, y)), sin: (x, y) => x * Math.sin(rad(y)), sqrt: (x) => Math.sqrt(Math.max(0, x)),
  tan: (x, y) => x * Math.tan(rad(y)), val: (x) => x,
};
/** The built-in guides of a w × h shape (§20.1.9.11: l, t, r, b, hc, vc, ss, ls, wd2…, hd2…, ssd2…, cd2…). */
export function builtins(w, h) {
  const ss = Math.min(w, h);
  const v = { l: 0, t: 0, r: w, b: h, w, h, hc: w / 2, vc: h / 2, ss, ls: Math.max(w, h), cd2: 10800000, cd4: 5400000, cd8: 2700000,
    '3cd4': 16200000, '3cd8': 8100000, '5cd8': 13500000, '7cd8': 18900000 };
  for (const n of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) Object.assign(v, { [`wd${n}`]: w / n, [`hd${n}`]: h / n, [`ssd${n}`]: ss / n });
  return v;
}
/** A guide argument: a guide's name or a number. */
const arg = (vars, a) => (typeof a === 'number' ? a : a in vars ? vars[a] : Number.isFinite(+a) ? +a : 0);
/** Evaluates guide formulas [[name, 'op x y z'], ...] in order into `vars` (changed and returned). */
export function evalGuides(list, vars) {
  for (const [name, fmla] of list) {
    const [op, ...args] = String(fmla).trim().split(/\s+/);
    const f = OPS[op];
    const out = f ? f(...args.map((a) => arg(vars, a))) : 0;
    vars[name] = Number.isFinite(out) ? out : 0;
  }
  return vars;
}

// ---------- paths ----------
/** A path writer in some coordinate space; `pt(x, y)` formats a point. arc() follows arcTo (§20.1.9.3): radii wR, hR, start
 * and swing angles in degrees, the start angle a visual one (the ray from the centre), from the current point. `subs` holds each
 * subpath's points in the writer's own space (curves sampled), for outlines and bounds. */
export function pathWriter(pt = (x, y) => `${r2(x)} ${r2(y)}`) {
  let d = '';
  let cur = [0, 0];
  let start = [0, 0];
  const subs = [];
  let sub = null;
  const add = (x, y) => { if (!sub) subs.push(sub = { pts: [[...cur]], closed: false }); sub.pts.push([x, y]); };
  const w = {
    move(x, y) { d += `M${pt(x, y)}`; cur = start = [x, y]; subs.push(sub = { pts: [[x, y]], closed: false }); },
    line(x, y) { d += `L${pt(x, y)}`; add(x, y); cur = [x, y]; },
    quad(x1, y1, x, y) {
      d += `Q${pt(x1, y1)},${pt(x, y)}`;
      const [x0, y0] = cur;
      for (let k = 1; k <= 4; k++) { const t = k / 4; const u = 1 - t; add(u * u * x0 + 2 * u * t * x1 + t * t * x, u * u * y0 + 2 * u * t * y1 + t * t * y); }
      cur = [x, y];
    },
    cubic(x1, y1, x2, y2, x, y) {
      d += `C${pt(x1, y1)},${pt(x2, y2)},${pt(x, y)}`;
      const [x0, y0] = cur;
      for (let k = 1; k <= 6; k++) {
        const t = k / 6; const u = 1 - t;
        add(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y);
      }
      cur = [x, y];
    },
    close() { if (d) d += 'Z'; if (sub) sub.closed = true; sub = null; cur = start; },
    arc(wR, hR, st, sw) {
      if (!sw) return;
      // The visual angle as the ellipse's own; a flat ellipse (a radius of 0, an adjust value at its end) has no other.
      const par = (a) => (wR && hR ? Math.atan2(wR * Math.sin((a * Math.PI) / 180), hR * Math.cos((a * Math.PI) / 180)) : (a * Math.PI) / 180);
      const sweep = Math.max(-360, Math.min(360, sw));
      const a0 = par(st);
      let a1 = Math.abs(sweep) === 360 ? a0 + Math.sign(sweep) * 2 * Math.PI : par(st + sweep);
      while (sweep > 0 && a1 <= a0) a1 += 2 * Math.PI;
      while (sweep < 0 && a1 >= a0) a1 -= 2 * Math.PI;
      const [cx, cy] = [cur[0] - wR * Math.cos(a0), cur[1] - hR * Math.sin(a0)];
      const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
      for (let i = 0; i < n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        const b = a0 + ((a1 - a0) * (i + 1)) / n;
        const k = (4 / 3) * Math.tan((b - a) / 4);
        const [x0, y0, x3, y3] = [cx + wR * Math.cos(a), cy + hR * Math.sin(a), cx + wR * Math.cos(b), cy + hR * Math.sin(b)];
        w.cubic(x0 - k * wR * Math.sin(a), y0 + k * hR * Math.cos(a), x3 + k * wR * Math.sin(b), y3 - k * hR * Math.cos(b), x3, y3);
      }
    },
    get d() { return d; },
    subs,
  };
  return w;
}

// ---------- lines through points (Word's Curve and Freeform: Shape, the board's path tools) ----------
const r4 = (n) => Math.round(n * 1e4) / 1e4;

/** The segments of a line through `pts` ({x, y}), back to the first point when `close`: straight (Freeform: Shape) or, `smooth`
 * (Curve), cubic ones through every point along the chord of its neighbours, each handle a third of its own segment long →
 * [[p0, p1]] or [[p0, c1, c2, p1]]. route.mjs cubics() sizes a handle by the neighbours' chord instead (uniform Catmull-Rom),
 * which loops where clicked points sit unevenly apart; a connector's points are its own bends, so it keeps that rule. */
export function pathSegments(pts, smooth = false, close = false) {
  const n = pts.length;
  const at = (k) => pts[close ? (k + n) % n : Math.max(0, Math.min(n - 1, k))];
  const along = (a, b, s) => {
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: ((b.x - a.x) / l) * s, y: ((b.y - a.y) / l) * s };
  };
  const segs = [];
  for (let k = 0; k < (close ? n : n - 1); k++) {
    const [a, b] = [at(k), at(k + 1)];
    if (!smooth) {
      segs.push([a, b]);
      continue;
    }
    const s = Math.hypot(b.x - a.x, b.y - a.y) / 3;
    const [ta, tb] = [along(at(k - 1), b, s), along(a, at(k + 2), s)];
    segs.push([a, { x: a.x + ta.x, y: a.y + ta.y }, { x: b.x - tb.x, y: b.y - tb.y }, b]);
  }
  return segs;
}

// Where cubic a, b, c, d (one axis) turns: the t where its derivative is 0.
function turnsAt(a, b, c, d) {
  const [A, B, C] = [-a + 3 * b - 3 * c + d, 2 * (a - 2 * b + c), b - a];
  if (Math.abs(A) < 1e-9) return Math.abs(B) < 1e-9 ? [] : [-C / B];
  const D = B * B - 4 * A * C;
  return D < 0 ? [] : [(-B + Math.sqrt(D)) / (2 * A), (-B - Math.sqrt(D)) / (2 * A)];
}
const cubicAt = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

/** Segments `segs` (pathSegments) as SVG path data, each point written by `pt(x, y)`, closed with Z when `close`. */
export function segmentsD(segs, close = false, pt = undefined) {
  const w = pathWriter(pt);
  w.move(segs[0][0].x, segs[0][0].y);
  for (const [, p, q, e] of segs) {
    if (e) w.cubic(p.x, p.y, q.x, q.y, e.x, e.y);
    else w.line(p.x, p.y);
  }
  if (close) w.close();
  return w.d;
}

/** A line through `pts` (board px; Curve when `smooth`, Freeform: Shape when not, closed when `close`) as a 'path' shape's box and
 * geometry: {x, y, w, h, path: [{d}]}, d in the unit square of the line's own bounds (a curve's too, where it bows past its points),
 * the box those bounds grown by `pad` (the line's half width: the 'path' kind draws inside that inset, itemPath). null for fewer
 * than two points. */
export function pathShape(pts, { smooth = false, close = false, pad = 0 } = {}) {
  if (pts.length < 2) return null;
  const segs = pathSegments(pts, smooth, close);
  const xs = [];
  const ys = [];
  for (const s of segs) {
    for (const [v, axis] of [[xs, 'x'], [ys, 'y']]) {
      const c = s.map((p) => p[axis]);
      v.push(c[0], c.at(-1));
      if (c.length === 4) for (const t of turnsAt(...c)) if (t > 0 && t < 1) v.push(cubicAt(...c, t));
    }
  }
  const [l, t] = [Math.min(...xs), Math.min(...ys)];
  const [w, h] = [Math.max(...xs) - l, Math.max(...ys) - t];
  const d = segmentsD(segs, close, (x, y) => `${r4((x - l) / (w || 1))} ${r4((y - t) / (h || 1))}`);
  return { x: r2(l - pad), y: r2(t - pad), w: r2(Math.max(1, w + 2 * pad)), h: r2(Math.max(1, h + 2 * pad)), path: [{ d }] };
}

const ARGS = { M: 2, L: 2, A: 4, Q: 4, C: 6, Z: 0 };
/** Runs a command-language path (tokens of 'M x y L x y A wR hR stAng swAng Q … C … Z') with guide values `vars` on writer `w`. */
function run(tok, vars, w) {
  for (let i = 0; i < tok.length;) {
    const c = tok[i++];
    const v = tok.slice(i, i + ARGS[c]).map((a) => arg(vars, a));
    i += ARGS[c] ?? 0;
    if (c === 'M') w.move(...v);
    else if (c === 'L') w.line(...v);
    else if (c === 'A') w.arc(v[0], v[1], v[2] / 60000, v[3] / 60000);
    else if (c === 'Q') w.quad(...v);
    else if (c === 'C') w.cubic(...v);
    else if (c === 'Z') w.close();
  }
}

// ---------- the presets ----------
const tokens = (s) => (s ? s.trim().split(/\s+/).map((a) => (Number.isFinite(+a) ? +a : a)) : []);
const list = (s) => (s ? s.split(';').filter(Boolean).map(tokens) : []);
const DEFS = new Map();
/** Preset `prst` compiled once: its adjust defaults, guides, handles, sites, text rectangle and paths as tokens. */
function def(prst) {
  if (DEFS.has(prst)) return DEFS.get(prst);
  const d = Object.hasOwn(PRESETS, prst) ? PRESETS[prst] : null;
  const c = d && {
    av: d.av ?? {},
    gd: list(d.gd).map(([name, op, ...args]) => [name, OPS[op] ?? (() => 0), args]),
    // A polar handle's angle is searched before its radius: a radius found first can shrink to the centre, where no angle moves it.
    ah: list(d.ah).map(([type, r1, mn1, mx1, r2, mn2, mx2, x, y]) => ({ type, pos: [x, y],
      refs: (type === 'polar' ? [[r2, mn2, mx2], [r1, mn1, mx1]] : [[r1, mn1, mx1], [r2, mn2, mx2]]).filter(([r]) => r !== '-') })),
    cxn: list(d.cxn),
    rect: tokens(d.rect),
    path: d.path.map((p) => ({ tok: tokens(p.d), w: p.w, h: p.h, fill: p.fill ?? 'norm', stroke: p.stroke !== false })),
  };
  DEFS.set(prst, c);
  return c;
}
// The built-in guides of the last box sizes, shared as the prototype of each evaluation's values (a handle drag evaluates a preset
// some hundred times per pointer move).
const BASES = new Map();
const baseOf = (w, h) => {
  const k = `${w}|${h}`;
  if (!BASES.has(k)) {
    if (BASES.size > 64) BASES.clear();
    BASES.set(k, builtins(w, h));
  }
  return BASES.get(k);
};
/** The guide values of compiled preset `c` in a w × h box with adjust values `av` over its defaults. */
function vars(c, av, w, h) {
  const v = Object.create(baseOf(w, h));
  for (const [k, d] of Object.entries(c.av)) v[k] = Number.isFinite(av?.[k]) ? av[k] : d;
  for (const [name, f, args] of c.gd) {
    const out = f(...args.map((a) => arg(v, a)));
    v[name] = Number.isFinite(out) ? out : 0;
  }
  return v;
}

/** The 187 preset names. */
export const PRESET_NAMES = Object.keys(PRESETS);
/** Whether preset `prst` has geometry here. */
export const hasPreset = (prst) => typeof prst === 'string' && Object.hasOwn(PRESETS, prst);
/** The adjust values preset `prst` defaults to ({} when none or unknown). */
export const presetAdjust = (prst) => ({ ...(def(prst)?.av ?? {}) });

const area = (pts) => Math.abs(pts.reduce((s, [x, y], k) => { const [u, v] = pts[(k + 1) % pts.length]; return s + x * v - u * y; }, 0)) / 2;
const CACHE = new Map(); // ponytail: cleared whole at 2000 entries; an LRU if boards with thousands of distinct shapes need it
/**
 * Preset `prst` drawn in a w × h box at (ox, oy) with adjust values `av` over its defaults → {parts [{d, fill, stroke}], poly (the
 * outline: the largest filled subpath, curves sampled, [[x, y]…]), bounds {x, y, w, h} of everything drawn}, or null.
 * A path with a size of its own (w, h) is evaluated in that space and stretched to the box (as POI and Word draw it).
 */
export function presetShape(prst, av, w, h, ox = 0, oy = 0) {
  const c = def(prst);
  if (!c) return null;
  const key = `${prst}|${w}|${h}|${ox}|${oy}|${av ? JSON.stringify(av) : ''}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const base = vars(c, av, w, h);
  const outline = [];
  const all = [];
  const parts = c.path.map((p) => {
    const [sx, sy] = [p.w ? w / p.w : 1, p.h ? h / p.h : 1];
    const v = p.w || p.h ? vars(c, av, p.w || w, p.h || h) : base;
    const wr = pathWriter((x, y) => `${r2(ox + x * sx)} ${r2(oy + y * sy)}`);
    run(p.tok, v, wr);
    const subs = wr.subs.map((s) => s.pts.map(([x, y]) => [ox + x * sx, oy + y * sy]));
    all.push(...subs.flat());
    if (p.fill !== 'none') outline.push(...subs.filter((s) => s.length > 2));
    return { d: wr.d, fill: p.fill, stroke: p.stroke };
  });
  const poly = outline.length ? outline.reduce((a, b) => (area(b) > area(a) ? b : a)) : null;
  const xs = all.map((q) => q[0]);
  const ys = all.map((q) => q[1]);
  const bounds = all.length ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } : { x: ox, y: oy, w, h };
  const out = { parts, poly, bounds };
  if (CACHE.size > 2000) CACHE.clear();
  CACHE.set(key, out);
  return out;
}
/** Preset `prst` drawn in a w × h box at (ox, oy) with adjust values `av` over its defaults → parts [{d, fill, stroke}], or null. */
export const presetPath = (prst, av, w, h, ox = 0, oy = 0) => presetShape(prst, av, w, h, ox, oy)?.parts ?? null;

/** Preset `prst`'s text rectangle in its w × h box ({l, t, r, b} from its left and top), the whole box when it names none. */
export function presetTextRect(prst, av, w, h) {
  const c = def(prst);
  if (!c?.rect.length) return { l: 0, t: 0, r: w, b: h };
  const v = vars(c, av, w, h);
  const [l, t, r, b] = c.rect.map((a) => arg(v, a));
  return { l: Math.min(l, r), t: Math.min(t, b), r: Math.max(l, r), b: Math.max(t, b) };
}

/** Preset `prst`'s connection sites in its w × h box: [{x, y, ang}], ang the direction a line leaves in degrees (0 right, 90 down). */
export function presetSites(prst, av, w, h) {
  const c = def(prst);
  if (!c) return [];
  const v = vars(c, av, w, h);
  return c.cxn.map(([x, y, a]) => ({ x: arg(v, x), y: arg(v, y), ang: arg(v, a) / 60000 }));
}

/** Preset `prst`'s adjust handles in its w × h box: [{x, y, type: 'xy' | 'polar', refs: [{name, min, max}]}], each ref the adjust
 * value it drags with its range there. */
export function presetHandles(prst, av, w, h) {
  const c = def(prst);
  if (!c) return [];
  const v = vars(c, av, w, h);
  return c.ah.map((a) => ({ x: arg(v, a.pos[0]), y: arg(v, a.pos[1]), type: a.type,
    refs: a.refs.map(([name, mn, mx]) => ({ name, min: Math.min(arg(v, mn), arg(v, mx)), max: Math.max(arg(v, mn), arg(v, mx)) })) }));
}

// The value in [lo, hi] where f is least: a scan, then a golden section search around the best point of it. `start` wins ties,
// so a handle that does not move its value leaves it alone.
function least(f, lo, hi, start) {
  const N = 32;
  let best = Math.min(hi, Math.max(lo, start));
  let fb = f(best);
  const step = (hi - lo) / N;
  for (let i = 0; i <= N; i++) {
    const a = lo + step * i;
    const fa = f(a);
    if (fa < fb - 1e-9) [best, fb] = [a, fa];
  }
  let [a, b] = [Math.max(lo, best - step), Math.min(hi, best + step)];
  const g = (Math.sqrt(5) - 1) / 2;
  let [c, d] = [b - g * (b - a), a + g * (b - a)];
  let [fc, fd] = [f(c), f(d)];
  for (let i = 0; i < 40 && b - a > 0.5; i++) {
    if (fc < fd) { [b, d, fd] = [d, c, fc]; c = b - g * (b - a); fc = f(c); } else { [a, c, fc] = [c, d, fd]; d = a + g * (b - a); fd = f(d); }
  }
  const m = fc < fd ? c : d;
  return f(m) < fb - 1e-9 ? m : best;
}

/** Adjust values `av` of preset `prst` (w × h) with handle `k` dragged to point `p` ({x, y} in the box): each value the handle
 * drags set within its range so the handle comes as near the point as it can, whole numbers as Word keeps them. */
export function presetAdjusted(prst, av, w, h, k, p) {
  const c = def(prst);
  const a = c?.ah[k];
  if (!a) return { ...av };
  const cur = { ...c.av, ...av };
  const dist = (vals) => {
    const v = vars(c, vals, w, h);
    return (arg(v, a.pos[0]) - p.x) ** 2 + (arg(v, a.pos[1]) - p.y) ** 2;
  };
  for (let round = 0; round < (a.refs.length > 1 ? 2 : 1); round++) {
    for (const [name, mn, mx] of a.refs) {
      const v = vars(c, cur, w, h);
      let [lo, hi] = [Math.min(arg(v, mn), arg(v, mx)), Math.max(arg(v, mn), arg(v, mx))];
      // An open range (the callouts' ±2147483647): searched within 20 box sizes of where the value is.
      if (hi - lo > 1e9) [lo, hi] = [Math.max(lo, cur[name] - 2e6), Math.min(hi, cur[name] + 2e6)];
      cur[name] = Math.round(least((x) => dist({ ...cur, [name]: x }), lo, hi, cur[name]));
    }
  }
  return Object.fromEntries(Object.keys(c.av).map((n) => [n, cur[n]]));
}

// ---------- custom geometry and the board's 'path' kind ----------
const PAIR = /(-?\d*\.?\d+(?:e-?\d+)?) (-?\d*\.?\d+(?:e-?\d+)?)/g;
/** Custom geometry `parts` ([{d, fill, stroke}] with d in the unit square, 'x y' pairs) drawn in a w × h box at (ox, oy). */
export const customPath = (parts, w, h, ox = 0, oy = 0) => (Array.isArray(parts) ? parts : []).filter((p) => typeof p?.d === 'string')
  .map((p) => ({ d: p.d.replace(PAIR, (_, x, y) => `${r2(ox + x * w)} ${r2(oy + y * h)}`), fill: p.fill ?? 'norm', stroke: p.stroke !== false }));

/** Item `it` of kind 'path' in a w × h box inset by i: its preset (it.prst, it.av) or custom geometry (it.path) → parts. */
export const itemPath = (it, w, h, i = 0) => (it?.prst && presetPath(it.prst, it.av, w - 2 * i, h - 2 * i, i, i)) || customPath(it?.path, w - 2 * i, h - 2 * i, i, i);

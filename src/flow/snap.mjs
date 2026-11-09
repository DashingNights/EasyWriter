// Board snapping (docs/plans/board-snapping.md, SPEC §6c): which line of a moving box or point lands on which line of an
// item, the frame, an equal gap or the grid, and the guides that show it. Pure (no DOM), board px throughout: whiteboard.js
// and the Node tests share it.

export const SNAP_DISTANCES = [4, 6, 8, 12]; // screen px choices; 6 is the default
export const GUIDE_LEVELS = ['simple', 'standard', 'detailed'];

const CLASSES = ['edge', 'centre', 'point', 'spacing', 'cross']; // the tie order
const WEIGHT = { edge: 1, centre: 1, point: 1, spacing: 1.2, cross: 1.5 };
const OTHER = { x: 'y', y: 'x' };
const EPS = 0.01;
// ponytail: equal spacing pairs only the NEAR nearest row targets on each side of the box (at most 2 x 64 pairs an axis,
// each checked against every target: under 40k steps for 300 targets); a gap farther along the row is not offered.
const NEAR = 8;

// Edge hold (SPEC §6c): screen px of pointer travel past a frame edge that leave a moved box held at the edge, then the length of
// the ramp over which it eases out until it follows the pointer 1:1.
export const EDGE_HOLD = 32;
export const EDGE_RAMP = 240;

/** Edge hold on one axis, board px: where a moved box of size `s` lands when the pointer (after snapping) puts its start at `p`,
 * given its start `p0` when the drag began, the frame's span [a, b] and the board's on-screen scale `k` (screen px per board px).
 * Past a side the box began inside of (0.5 px slack, as the artboard's rounding), the pointer's overshoot u in screen px keeps
 * the box at the edge while u <= EDGE_HOLD; past that by v the box goes out v² / (2 EDGE_RAMP) while v < EDGE_RAMP, then
 * v - EDGE_RAMP / 2. A box larger than the frame, or past a side it began outside of, gets `p` back unchanged. */
export function edgeHold(p, p0, s, a, b, k) {
  if (s > b - a) return p;
  const out = (u) => {
    const v = u * k - EDGE_HOLD;
    return v <= 0 ? 0 : (v < EDGE_RAMP ? (v * v) / (2 * EDGE_RAMP) : v - EDGE_RAMP / 2) / k;
  };
  if (p < a && p0 >= a - 0.5) return a - out(a - p);
  if (p + s > b && p0 + s <= b + 0.5) return b - s + out(p + s - b);
  return p;
}

/** The three lines of box b on axis 'x' | 'y': [start, centre, end]. */
export function linesOf(b, axis) {
  const [p, s] = axis === 'x' ? [b.x, b.w] : [b.y, b.h];
  return [p, p + s / 2, p + s];
}

const span = (b, axis) => (axis === 'x' ? [b.x, b.x + b.w] : [b.y, b.y + b.h]);
const over = ([a, b], [c, d]) => Math.min(b, d) - Math.max(a, c); // > 0 when the two spans overlap
const overlap = (a, b, axis) => over(span(a, axis), span(b, axis));
// The middle of the overlap of a and b on `axis` (between them when they do not overlap).
const mid = (a, b, axis) => {
  const [p, q] = [span(a, axis), span(b, axis)];
  return (Math.max(p[0], q[0]) + Math.min(p[1], q[1])) / 2;
};

// The class of the pair (moving line m, target line t), or null: a point takes any line; the frame takes no cross pair, so
// its middle line never catches an item's edge.
function pairClass(point, m, t, frame) {
  if (point) return 'point';
  if (m === 1 || t === 1) return m === t ? 'centre' : frame ? null : 'cross';
  return 'edge';
}

// Equal spacing on `axis`. The row: the targets overlapping the box on the other axis. L and R: its nearest members wholly
// before and after the box. Pairs: two members on the same side of the box that overlap each other on the other axis, with a
// gap > 0 and no target in the gap across their shared band.
function rowOf(box, targets, axis) {
  const o = OTHER[axis];
  const [s, e] = span(box, axis);
  const row = targets.filter((t) => overlap(box, t, o) > 0);
  const before = row.filter((t) => span(t, axis)[1] <= s).sort((a, b) => span(b, axis)[1] - span(a, axis)[1]).slice(0, NEAR);
  const after = row.filter((t) => span(t, axis)[0] >= e).sort((a, b) => span(a, axis)[0] - span(b, axis)[0]).slice(0, NEAR);
  const pairs = [];
  for (const side of [before, after]) {
    for (const p of side) {
      for (const q of side) {
        const [a, b] = [span(p, axis)[1], span(q, axis)[0]];
        if (b <= a || overlap(p, q, o) <= 0) continue;
        const band = [Math.max(span(p, o)[0], span(q, o)[0]), Math.min(span(p, o)[1], span(q, o)[1])];
        if (!targets.some((t) => over(span(t, axis), [a, b]) > 0 && over(span(t, o), band) > 0)) pairs.push({ p, q, a, b });
      }
    }
  }
  return { L: before[0], R: after[0], pairs };
}

// The equal-spacing candidates on `axis` (internal: g the gap, row for gapsOf): the box centred between L and R, its start
// one pair's gap after L, its end one pair's gap before R.
function spacing(q, axis) {
  const row = rowOf(q.box, q.targets, axis);
  const ms = linesOf(q.box, axis);
  const out = [];
  const add = (line, at, g) => {
    if (q.lines[axis].includes(line)) out.push({ d: at - ms[line], at, cls: 'spacing', line, target: null, tline: null, near: 0, g, row });
  };
  const { L, R, pairs } = row;
  if (L && R) {
    const [a, b] = [span(L, axis)[1], span(R, axis)[0]];
    if (b - a >= ms[2] - ms[0]) add(1, (a + b) / 2, (b - a - ms[2] + ms[0]) / 2);
  }
  for (const { a, b } of pairs) {
    if (L) add(0, span(L, axis)[1] + b - a, b - a);
    if (R) add(2, span(R, axis)[0] - b + a, b - a);
  }
  return out;
}

// The gaps a spacing snap with gap g on `axis` shows, `box` at the snapped position: its own and every row pair's equal gap.
function gapsOf(box, axis, { L, R, pairs }, g) {
  const o = OTHER[axis];
  const out = [];
  const add = (a, b, p, q) => {
    if (Math.abs(b - a - g) <= 0.5) out.push({ axis, a, b, at: mid(p, q, o), value: b - a });
  };
  if (L) add(span(L, axis)[1], span(box, axis)[0], L, box);
  if (R) add(span(box, axis)[1], span(R, axis)[0], box, R);
  for (const { p, q, a, b } of pairs) add(a, b, p, q);
  return out;
}

// Rank keys: k ahead of j. Score (within EPS a tie), then the frame, then the nearer target, then the class order.
const ahead = (k, j) => (Math.abs(k[0] - j[0]) > EPS ? k[0] < j[0] : k[1] !== j[1] ? k[1] < j[1] : k[2] !== j[2] ? k[2] < j[2] : k[3] < j[3]);

// The winning candidate on `axis` (with the internal fields near, g and row), the grid's when none holds, or null.
function best(q, axis) {
  const { box, tol, lines } = q;
  const ms = linesOf(box, axis);
  const o = OTHER[axis];
  const cands = [];
  const add = (target, b) => {
    const ts = linesOf(b, axis);
    const near = target === 'frame' ? 0 : Math.max(0, -overlap(box, b, o)); // the gap between them across the axis
    for (const m of lines[axis]) {
      for (let t = 0; t < 3; t++) {
        const cls = pairClass(box.point, m, t, target === 'frame');
        const d = ts[t] - ms[m];
        if (cls && Math.abs(d) <= (cls === 'cross' ? tol / 2 : tol)) cands.push({ d, at: ts[t], cls, line: m, target, tline: t, near });
      }
    }
  };
  if (q.frame) add('frame', q.frame);
  for (const t of q.targets) add(t.id, t);
  if (q.spacing && lines[axis].length) cands.push(...spacing(q, axis).filter((c) => Math.abs(c.d) <= tol));
  // The previous winner (same pair and the same spot: spacing hits differ only there) counts `sticky` nearer, so two close
  // candidates do not flicker.
  const prev = q.prev?.[axis];
  let [win, key] = [null, null];
  for (const c of cands) {
    const same = prev && ['cls', 'target', 'line', 'tline'].every((f) => prev[f] === c[f]) && Math.abs(prev.at - c.at) < EPS;
    const k = [Math.abs(c.d) * WEIGHT[c.cls] - (same ? q.sticky ?? 0 : 0), c.target === 'frame' ? 0 : 1, c.near, CLASSES.indexOf(c.cls)];
    if (!win || ahead(k, key)) [win, key] = [c, k];
  }
  if (win || !(q.grid > 0) || !lines[axis].length) return win;
  const m = lines[axis][0];
  const at = Math.round(ms[m] / q.grid) * q.grid;
  return Math.abs(at - ms[m]) <= tol ? { d: at - ms[m], at, cls: 'grid', line: m, target: null, tline: null } : null;
}

/** The snap of a moving box (or point) → { x: Hit | null, y: Hit | null }. `q`: {box, lines, targets, frame, tol, sticky,
 * spacing, grid, prev} (docs/plans/board-snapping.md). Hit: {d, at, cls, line, target, tline}, plus `gaps` [{axis, a, b, at,
 * value}] on a spacing hit, computed for the snapped position. */
export function snap(q) {
  const win = { x: best(q, 'x'), y: best(q, 'y') };
  const moved = { ...q.box, x: q.box.x + (win.x?.d ?? 0), y: q.box.y + (win.y?.d ?? 0) };
  const out = { x: null, y: null };
  for (const axis of ['x', 'y']) {
    if (!win[axis]) continue;
    const { near, g, row, ...hit } = win[axis];
    if (hit.cls === 'spacing') hit.gaps = gapsOf(moved, axis, row, g);
    out[axis] = hit;
  }
  return out;
}

/** What to draw for box `box` (after the snap was applied; `q` the query, `hits` what snap() returned; `opts` {level, kind}
 * with kind 'move' | 'resize' | 'point'), in board px: {type: 'line', axis, at, a, b} (axis 'x': a vertical line at x = at
 * from y = a to b), {type: 'mark', x, y}, {type: 'gap' | 'distance', axis, a, b, at, value}, {type: 'size', x, y, w, h}. */
export function guides(box, q, hits, { level = 'standard', kind = 'move' } = {}) {
  const lines = [];
  const marks = new Map(); // one mark a spot (to 0.01 px)
  const mark = (x, y) => marks.set(`${Math.round(x * 100)},${Math.round(y * 100)}`, { type: 'mark', x, y });
  const all = [...(q.frame ? [['frame', q.frame]] : []), ...q.targets.map((t) => [t.id, t])];
  for (const axis of ['x', 'y']) {
    const o = OTHER[axis];
    const win = hits?.[axis];
    const ms = linesOf(box, axis);
    const lined = new Map(); // the box's line (to 0.01 px) → {at, a, b, ends: [[line, box]] to mark}
    for (const m of q.lines[axis]) {
      if (level === 'simple' && !(win?.target != null && win.line === m)) continue; // simple: the winner's line only
      for (const [id, b] of all) {
        const ts = linesOf(b, axis);
        for (let t = 0; t < 3; t++) {
          const cls = pairClass(box.point, m, t, id === 'frame');
          if (!cls || Math.abs(ts[t] - ms[m]) > 0.5) continue;
          if (cls === 'cross' && !(win?.cls === 'cross' && win.target === id && win.line === m && win.tline === t)) continue;
          const key = Math.round(ms[m] * 100);
          if (!lined.has(key)) lined.set(key, { at: ms[m], a: span(box, o)[0], b: span(box, o)[1], ends: [] });
          const l = lined.get(key);
          [l.a, l.b] = [Math.min(l.a, span(b, o)[0]), Math.max(l.b, span(b, o)[1])];
          l.ends.push([m, box]);
          if (id !== 'frame') l.ends.push([t, b]);
        }
      }
    }
    for (const { at, a, b, ends } of lined.values()) {
      lines.push({ type: 'line', axis, at, a, b });
      // Both ends of a lined-up edge, the middle of a lined-up centre line (a point: the point itself).
      for (const [t, bx] of ends) for (const v of t === 1 ? [linesOf(bx, o)[1]] : span(bx, o)) mark(...(axis === 'x' ? [at, v] : [v, at]));
    }
  }
  // A spacing winner's gaps show at every level (Simple too: it has no line to show).
  const gaps = ['x', 'y'].flatMap((axis) => (hits?.[axis]?.gaps ?? []).map((g) => ({ type: 'gap', ...g })));
  if (level === 'simple') return [...lines, ...gaps];
  const out = [...lines, ...marks.values(), ...gaps];
  if (level !== 'detailed') return out;
  if (kind === 'resize') out.push({ type: 'size', x: box.x, y: box.y, w: box.w, h: box.h });
  if (kind !== 'move') return out;
  // Distances: to the nearest target overlapping the box across the axis on each side, else to the frame's edge there.
  for (const axis of ['x', 'y']) {
    const o = OTHER[axis];
    const [s, e] = span(box, axis);
    let [pre, post] = [null, null];
    for (const t of q.targets) {
      if (overlap(box, t, o) <= 0) continue;
      const [ts, te] = span(t, axis);
      if (te <= s + EPS && (!pre || te > span(pre, axis)[1])) pre = t;
      if (ts >= e - EPS && (!post || ts < span(post, axis)[0])) post = t;
    }
    const dist = (a, b, other) => {
      if (b - a > EPS) out.push({ type: 'distance', axis, a, b, at: mid(box, other, o), value: b - a });
    };
    const f = q.frame && span(q.frame, axis);
    if (pre) dist(span(pre, axis)[1], s, pre);
    else if (f && f[0] < s && s <= f[1]) dist(f[0], s, q.frame);
    if (post) dist(e, span(post, axis)[0], post);
    else if (f && f[0] <= e && e < f[1]) dist(e, f[1], q.frame);
  }
  return out;
}

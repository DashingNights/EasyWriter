// Connector editing (docs/plans/flowchart.md §5.3–§5.5, SPEC §6d): label slots, reverse, segment / waypoint handles and
// keyboard navigation between connected items. Pure (no DOM): whiteboard.js and the Node tests share it.
import { LABEL_SLOTS, MAX_POINTS } from './model.mjs';
import { nearestT, polylinePoint } from './route.mjs';

export const SIDES = { n: [0.5, 0], e: [1, 0.5], s: [0.5, 1], w: [0, 0.5] }; // side → anchor of the unrotated box
export const OPPOSITE = { n: 's', e: 'w', s: 'n', w: 'e' };
export const DIRS = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
// Distance from p to the segment a–b.
function segDist(p, a, b) {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
}

/** The label slot a double-click at fraction `t` of the path edits: start below 0.25, end above 0.75, else mid. */
export const labelSlotAt = (t) => (t < 0.25 ? 'start' : t > 0.75 ? 'end' : 'mid');

/** Connector `c` reversed: ends, heads and waypoints swap; every label keeps its place (t → 1 − t; the start and end slots
 * swap, so each text stays where it was). */
export function reverseConnector(c) {
  const swap = { start: 'end', mid: 'mid', end: 'start' };
  const labels = Object.fromEntries(Object.entries(c.labels ?? {}).map(([s, l]) => [swap[s], { ...l, t: 1 - (l.t ?? LABEL_SLOTS[s]) }]));
  const heads = { start: c.heads?.end ?? 'arrow', end: c.heads?.start ?? 'none' };
  return { ...c, from: c.to, to: c.from, heads, points: [...(c.points ?? [])].reverse(), labels };
}

/** The segment handles of a selected connector routed along `pts` (board px) with waypoints `points`: ortho, one per inner
 * segment (k: the segment pts[k]–pts[k + 1]; dir 'h' | 'v' its direction); the first and last segments hold the ends'
 * stubs and move with the ends. Straight / curve: one per stretch between control points (the ends and the waypoints), on
 * the path halfway along it (k: the index a dragged-out waypoint takes). */
export function midHandles(route, pts, points) {
  // ponytail: an elbow's two stub segments get no handle (an L route has none); add stub handles if bending an L is asked for.
  if (route === 'ortho') {
    return pts.slice(1, -2).map((a, i) => {
      const b = pts[i + 2];
      return { k: i + 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dir: Math.abs(a.y - b.y) < 1e-6 ? 'h' : 'v' };
    });
  }
  const ts = [0, ...points.map((p) => nearestT(pts, p)), 1];
  return ts.slice(1).map((t, i) => ({ k: i, ...polylinePoint(pts, (ts[i] + t) / 2) }));
}

/** Ortho segment drag: the waypoints after segment k of the route `pts` moved by `d` ({x, y}, across the segment). The
 * waypoints on that segment move with it, and its two corners become waypoints where there were none, so the route keeps
 * the moved segment and re-flows on both sides. At most MAX_POINTS. */
export function dragSegment(points, pts, k, d) {
  const [a, b] = [pts[k], pts[k + 1]];
  const acc = [0];
  for (let j = 1; j < pts.length; j++) acc.push(acc[j - 1] + dist(pts[j - 1], pts[j]));
  const [before, on, after] = [[], [], []];
  for (const p of points) {
    if (segDist(p, a, b) < 0.5) on.push(p);
    else (nearestT(pts, p) * acc.at(-1) < acc[k] ? before : after).push(p);
  }
  const has = (q) => on.some((p) => dist(p, q) < 0.5);
  const moved = [...(has(a) ? [] : [a]), ...on, ...(has(b) ? [] : [b])].map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
  return [...before, ...moved, ...after].slice(0, MAX_POINTS);
}

/** `points` without the waypoints within `tol` px of the line between their neighbours (`ends`: the path's two tips). */
export function cleanPoints(points, ends, tol = 2) {
  const out = [...points];
  for (let k = 0; k < out.length;) {
    if (segDist(out[k], k ? out[k - 1] : ends[0], out[k + 1] ?? ends[1]) < tol) out.splice(k, 1);
    else k++;
  }
  return out;
}

/** The id of the candidate ([{id, x, y}]: centres) lying most in direction `dir` (n e s w) from point `c`: the smallest
 * angle off that direction, then the nearest; null when none lies ahead. */
export function pickInDirection(c, cands, dir) {
  const v = DIRS[dir];
  let [best, score] = [null, -Infinity];
  for (const q of cands) {
    const [dx, dy] = [q.x - c.x, q.y - c.y];
    const len = Math.hypot(dx, dy);
    const dot = dx * v.x + dy * v.y;
    if (dot <= 0) continue;
    const s = dot / len - len * 1e-9; // cos of the angle; ties: the nearer
    if (s > score) [best, score] = [q.id, s];
  }
  return best;
}

/** The side (n e s w) whose turned outward normal (`normal(anchor)` → {x, y}) points most along board direction `dir`. */
export const sideToward = (normal, dir) => Object.keys(SIDES).reduce((best, s) => {
  const [n, m] = [normal(SIDES[s]), normal(SIDES[best])];
  return n.x * DIRS[dir].x + n.y * DIRS[dir].y > m.x * DIRS[dir].x + m.y * DIRS[dir].y + 1e-9 ? s : best;
}, dir);

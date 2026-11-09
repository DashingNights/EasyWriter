// Edit Points' paths of points and curves (engine-tools-2; the engine's freeform EditPath in engine/crates/doc/src/freeform.rs):
// a path is {closed, nodes: [{at, cIn, cOut, kind}]}, points [x, y]; a node's cIn and cOut are the control points of the cubic
// curves into and out of it (null: that side is straight at this end), and its kind says how its handles move together:
// 'corner' apart, 'smooth' in line and equally long, 'straight' in line, 'auto' placed from its neighbours. Every function
// returns new paths and never changes the ones it is given. Pure, so node tests load it.

export const CURVE_STEPS = 16; // as the engine flattens a curve

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const len = (v) => Math.hypot(v[0], v[1]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const unit = (v) => {
  const l = len(v);
  return l > 1e-9 ? [v[0] / l, v[1] / l] : null;
};
const clone = (p) => ({ closed: p.closed, nodes: p.nodes.map((n) => ({ ...n })) });

/** A path of plain points (no handles). */
export const pathOf = (pts, closed) => ({ closed, nodes: pts.map((at) => ({ at, cIn: null, cOut: null, kind: 'corner' })) });

/** The number of sides of `p`: a closed path's last joins its first point. */
export const sides = (p) => (p.closed && p.nodes.length > 2 ? p.nodes.length : Math.max(0, p.nodes.length - 1));

/** Side `i` of `p` as its cubic's four points, or null for a straight side. */
function cubic(p, i) {
  const a = p.nodes[i];
  const b = p.nodes[(i + 1) % p.nodes.length];
  if (!a.cOut && !b.cIn) return null;
  return [a.at, a.cOut ?? a.at, b.cIn ?? b.at, b.at];
}

/** The point at `t` along side `i` of `p`. */
export function pointOn(p, i, t) {
  const c = cubic(p, i);
  if (!c) return lerp(p.nodes[i].at, p.nodes[(i + 1) % p.nodes.length].at, t);
  const [q0, q1, q2] = [lerp(c[0], c[1], t), lerp(c[1], c[2], t), lerp(c[2], c[3], t)];
  return lerp(lerp(q0, q1, t), lerp(q1, q2, t), t);
}

/** The polyline `p` draws, as the engine's EditPath::flatten makes it. */
export function flatten(p) {
  const n = p.nodes.length;
  const pts = n ? [p.nodes[0].at] : [];
  for (let i = 0; i < sides(p); i++) {
    const last = i + 1 === n;
    if (!cubic(p, i)) {
      if (!last) pts.push(p.nodes[i + 1].at);
      continue;
    }
    for (let k = 1; k <= CURVE_STEPS - (last ? 1 : 0); k++) pts.push(pointOn(p, i, k / CURVE_STEPS));
  }
  return pts;
}

/** The side of `p` nearest point `at` → {side, t, d} (d in the points' unit), or null for a path without sides. */
export function nearSide(p, at) {
  let best = null;
  const steps = CURVE_STEPS * 2;
  for (let i = 0; i < sides(p); i++) {
    for (let k = 0; k <= steps; k++) {
      const q = pointOn(p, i, k / steps);
      const d = Math.hypot(q[0] - at[0], q[1] - at[1]);
      if (!best || d < best.d) best = { side: i, t: k / steps, d };
    }
  }
  return best;
}

/** The handles node `i` of `p` shows: {cIn, cOut} as points, a straight side's a third of the way to its neighbour; a side the
 * path lacks (an open path's ends) is null. */
export function handlesOf(p, i) {
  const n = p.nodes.length;
  const at = p.nodes[i].at;
  const prev = p.closed || i > 0 ? p.nodes[(i - 1 + n) % n] : null;
  const next = p.closed || i < n - 1 ? p.nodes[(i + 1) % n] : null;
  return {
    cIn: prev && prev !== p.nodes[i] ? p.nodes[i].cIn ?? lerp(at, prev.at, 1 / 3) : null,
    cOut: next && next !== p.nodes[i] ? p.nodes[i].cOut ?? lerp(at, next.at, 1 / 3) : null,
  };
}

/** `p` with node `i`'s handle `part` ('cIn' or 'cOut') at `to`; the other follows as the node's kind says (an auto point
 * becomes smooth, as its handle is now the user's). */
export function moveHandle(p, i, part, to) {
  const q = clone(p);
  const n = q.nodes[i];
  const other = part === 'cIn' ? 'cOut' : 'cIn';
  const h = handlesOf(p, i);
  n[part] = to;
  if (n.kind === 'auto') n.kind = 'smooth';
  const d = unit(sub(n.at, to));
  if (d && h[other] && (n.kind === 'smooth' || n.kind === 'straight')) {
    const l = n.kind === 'smooth' ? len(sub(to, n.at)) : len(sub(h[other], n.at));
    n[other] = add(n.at, d, l);
  }
  return q;
}

/** `p` with node `i` moved to `to`, its handles with it. */
export function moveNode(p, i, to) {
  const q = clone(p);
  const n = q.nodes[i];
  const d = sub(to, n.at);
  n.at = to;
  if (n.cIn) n.cIn = add(n.cIn, d);
  if (n.cOut) n.cOut = add(n.cOut, d);
  return q;
}

/** `p` with node `i` of `kind`: smooth, straight and auto put its handles in line through it (smooth equally long, auto a
 * third of the way to each neighbour); corner keeps them. */
export function setKind(p, i, kind) {
  const q = clone(p);
  const n = q.nodes[i];
  n.kind = kind;
  if (kind === 'corner') return q;
  const nn = p.nodes.length;
  const prev = p.closed || i > 0 ? p.nodes[(i - 1 + nn) % nn].at : null;
  const next = p.closed || i < nn - 1 ? p.nodes[(i + 1) % nn].at : null;
  const h = handlesOf(p, i);
  const d = unit(prev && next ? sub(next, prev) : sub(h.cOut ?? n.at, h.cIn ?? n.at));
  if (!d) return q;
  let lIn = h.cIn ? (kind === 'auto' ? len(sub(n.at, prev)) / 3 : len(sub(h.cIn, n.at))) : 0;
  let lOut = h.cOut ? (kind === 'auto' ? len(sub(next, n.at)) / 3 : len(sub(h.cOut, n.at))) : 0;
  if (kind === 'smooth' && h.cIn && h.cOut) lIn = lOut = (lIn + lOut) / 2;
  if (h.cIn) n.cIn = add(n.at, d, -lIn);
  if (h.cOut) n.cOut = add(n.at, d, lOut);
  return q;
}

/** `p` with a node added at `t` along side `i`, the curve split there so it keeps its shape → {path, index} of the new node. */
export function addPoint(p, i, t) {
  const q = clone(p);
  const j = (i + 1) % q.nodes.length;
  const c = cubic(p, i);
  let node = { at: pointOn(p, i, t), cIn: null, cOut: null, kind: 'corner' };
  if (c) {
    const [q0, q1, q2] = [lerp(c[0], c[1], t), lerp(c[1], c[2], t), lerp(c[2], c[3], t)];
    const [r0, r1] = [lerp(q0, q1, t), lerp(q1, q2, t)];
    q.nodes[i].cOut = q0;
    q.nodes[j].cIn = q2;
    node = { at: lerp(r0, r1, t), cIn: r0, cOut: r1, kind: 'smooth' };
  }
  q.nodes.splice(i + 1, 0, node);
  return { path: q, index: i + 1 };
}

/** `p` without node `i` → [paths] (none when too few points are left). */
export function deletePoint(p, i) {
  const q = clone(p);
  q.nodes.splice(i, 1);
  if (q.closed && q.nodes.length < 3) q.closed = false;
  return q.nodes.length >= 2 ? [q] : [];
}

/** `p` without side `i` → [paths]: a closed path opens there, an open one splits in two. */
export function deleteSegment(p, i) {
  const q = clone(p);
  const n = q.nodes.length;
  q.nodes[i].cOut = null;
  q.nodes[(i + 1) % n].cIn = null;
  if (q.closed) return [{ closed: false, nodes: [...q.nodes.slice(i + 1), ...q.nodes.slice(0, i + 1)] }];
  return [{ closed: false, nodes: q.nodes.slice(0, i + 1) }, { closed: false, nodes: q.nodes.slice(i + 1) }].filter((x) => x.nodes.length >= 2);
}

/** Closed path `p` opened at node `i`: it starts and ends there. */
export function openAt(p, i) {
  const q = clone(p);
  const a = { ...q.nodes[i], cIn: null };
  const z = { ...q.nodes[i], cOut: null };
  return { closed: false, nodes: [a, ...q.nodes.slice(i + 1), ...q.nodes.slice(0, i), z] };
}

/** Open path `p` closed: its last side joins its first point (the last point goes when it lies on the first). */
export function closePath(p) {
  const q = clone(p);
  const [a, z] = [q.nodes[0], q.nodes.at(-1)];
  if (q.nodes.length > 2 && len(sub(a.at, z.at)) < 0.01) {
    a.cIn = z.cIn;
    q.nodes.pop();
  }
  q.closed = q.nodes.length > 2;
  return q;
}

/** Side `i` of `p` made straight (its handles go) or, `curved`, a curve whose handles sit a third of the way along it. */
export function setSegment(p, i, curved) {
  const q = clone(p);
  const a = q.nodes[i];
  const b = q.nodes[(i + 1) % q.nodes.length];
  a.cOut = curved ? lerp(a.at, b.at, 1 / 3) : null;
  b.cIn = curved ? lerp(a.at, b.at, 2 / 3) : null;
  return q;
}

/** Whether side `i` of `p` is a curve. */
export const isCurved = (p, i) => !!cubic(p, i);

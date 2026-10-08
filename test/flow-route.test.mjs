import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findJumps, headPath, nearestT, polylineHitsRect, polylinePoint, resolveConnectors } from '../src/flow/route.mjs';
import { outlineOf, rotBox } from '../src/flow/shapes.mjs';

const rect = (id, x, y, extra = {}) => ({ id, type: 'shape', shape: 'rect', x, y, w: 100, h: 60, width: 2, ...extra });
const conn = (from, to, extra = {}) => ({ id: 'k', type: 'connector', from, to, route: 'ortho', heads: { start: 'none', end: 'arrow' }, width: 2, ...extra });
const A = rect('a', 0, 0);
const B = rect('b', 400, 200);
const resolve = (items) => {
  const { items: out, geo } = resolveConnectors(items);
  return { c: out.find((i) => i.id === 'k'), g: geo.get('k') };
};
const segDist = (p, a, b) => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
};
const onPoly = (poly, p, closed = true) => poly.some((a, k) => (closed || k < poly.length - 1) && segDist(p, a, poly[(k + 1) % poly.length]) < 1e-6);
const axisAligned = (pts) => pts.slice(1).every((p, k) => Math.abs(p.x - pts[k].x) < 1e-9 || Math.abs(p.y - pts[k].y) < 1e-9);

test('straight, floating: both tips on the perimeters', () => {
  const { g } = resolve([A, B, conn({ item: 'a', anchor: null }, { item: 'b', anchor: null }, { route: 'straight' })]);
  assert.ok(onPoly(outlineOf(A), g.tipsAbs[0]) && onPoly(outlineOf(B), g.tipsAbs[1]), JSON.stringify(g.tipsAbs));
});

test('an anchor name routes as its fraction, not to the centre (the eval fixture stores s, e, w)', () => {
  for (const route of ['straight', 'ortho']) {
    const named = resolve([A, B, conn({ item: 'a', anchor: 's' }, { item: 'b', anchor: 'w' }, { route })]).g;
    const fraction = resolve([A, B, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: [0, 0.5] }, { route })]).g;
    assert.deepEqual(named.tipsAbs, fraction.tipsAbs, route);
    assert.ok(Math.abs(named.tipsAbs[0].y - 60) <= 2 && Math.abs(named.tipsAbs[1].x - 400) <= 2, JSON.stringify(named.tipsAbs)); // a's bottom, b's left (not 30 / 450)
  }
});

test('ortho: axis-aligned segments, ≥ 20 px stubs along the port normals; a waypoint lies on the path', () => {
  const { g } = resolve([A, B, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: [0, 0.5] })]);
  assert.ok(axisAligned(g.pts), JSON.stringify(g.pts));
  const [p0, p1] = g.pts;
  assert.ok(Math.abs(p1.x - p0.x) < 1e-9 && p1.y - p0.y >= 20, 'leaves down from the bottom port');
  const [q1, q0] = [g.pts.at(-2), g.pts.at(-1)];
  assert.ok(Math.abs(q1.y - q0.y) < 1e-9 && q0.x - q1.x >= 20, 'arrives moving right into the west port');
  const wp = { x: 250, y: 400 };
  const w = resolve([A, B, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: [0, 0.5] }, { points: [wp] })]).g;
  assert.ok(axisAligned(w.pts) && onPoly(w.pts, wp, false), JSON.stringify(w.pts));
});

test('the bbox holds both heads and all three labels', () => {
  const labels = { start: { html: '1', t: 0.15, size: 14 }, mid: { html: 'yes, long label', t: 0.5, size: 14, dy: 30 }, end: { html: 'n', t: 0.85, size: 14 } };
  const { c, g } = resolve([A, B, conn({ item: 'a', anchor: null }, { item: 'b', anchor: null }, { heads: { start: 'zero-many', end: 'triangle' }, labels })]);
  const inBox = (p) => p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
  for (const [k, kind] of [[0, 'zero-many'], [1, 'triangle']]) assert.ok(headPath(kind, g.tipsAbs[k], 2).pts.every(inBox), kind);
  assert.deepEqual(Object.keys(c.lps).sort(), ['end', 'mid', 'start']);
  for (const p of Object.values(c.lps)) assert.ok(inBox({ x: c.x + p.x, y: c.y + p.y }));
  assert.ok(c.lps.mid.y + c.y - polylinePoint(g.pts, 0.5).y === 30, 'dy offsets the mid label');
});

test('a label counts the <div> lines Enter makes as <br> lines (a line-ending <br> is a placeholder)', () => {
  const h = (html) => resolve([conn({ x: 0, y: 0 }, { x: 300, y: 0 }, { route: 'straight', labels: { mid: { html, t: 0.5, size: 14 } } })]).c.h;
  assert.equal(h('no<div>x</div>'), h('no<br>x'));
  assert.equal(h('no<div>x</div><div><br></div>'), h('a<br>b<br>c'));
  assert.ok(h('no<br>x') > h('no'));
});

test('polylinePoint / nearestT', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  assert.deepEqual(polylinePoint(pts, 0.5), { x: 100, y: 0 });
  for (const t of [0, 0.2, 0.5, 0.77, 1]) assert.ok(Math.abs(nearestT(pts, polylinePoint(pts, t)) - t) < 1e-9, String(t));
  assert.ok(polylineHitsRect(pts, { x: 90, y: 40, w: 20, h: 5 }) && !polylineHitsRect(pts, { x: 10, y: 10, w: 50, h: 50 }));
});

test('ortho from a port on a 30° shape leaves along the board axis closest to its turned normal', () => {
  const { g } = resolve([rect('a', 0, 0, { rot: 30 }), B, conn({ item: 'a', anchor: [1, 0.5] }, { item: 'b', anchor: null })]);
  const [p0, p1] = g.pts;
  assert.ok(Math.abs(p1.y - p0.y) < 1e-9 && p1.x > p0.x, JSON.stringify(g.pts.slice(0, 2))); // east turned 30° → +x
});

test('corner radius does not change the tips; moving an unrelated item changes nothing', () => {
  const items = [A, B, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: [0, 0.5] })];
  const sharp = resolve([A, B, { ...items[2], corner: 0 }]).c;
  const round = resolve([A, B, { ...items[2], corner: 20 }]).c;
  assert.deepEqual(sharp.tips, round.tips);
  assert.notEqual(sharp.d, round.d);
  assert.deepEqual(resolve([...items, rect('z', 700, 0)]).c, resolve([...items, rect('z', 900, 300)]).c);
});

// --- routing quality (roadmap C2) ---

// Whether the axis-aligned segment a–b passes through the inside of box r (0.01 px tolerance).
const through = (a, b, r) => Math.max(a.x, b.x) > r.x + 0.01 && Math.min(a.x, b.x) < r.x + r.w - 0.01 &&
  Math.max(a.y, b.y) > r.y + 0.01 && Math.min(a.y, b.y) < r.y + r.h - 0.01;
const outside = (p, r) => p.x <= r.x + 0.01 || p.x >= r.x + r.w - 0.01 || p.y <= r.y + 0.01 || p.y >= r.y + r.h - 0.01;

test('ortho never goes through a bound box (a turned shape: its turned bounds); the stubs leave their boxes', () => {
  const SIDES = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], null];
  let n = 0;
  for (const rot of [0, 30]) {
    const a = rect('a', 0, 0, { rot });
    for (const bx of [-300, -160, 0, 160, 300]) {
      for (const by of [-200, -110, 0, 110, 200]) {
        const b = rect('b', bx, by, { rot: rot ? 75 : 0 });
        const [ra, rb] = [rotBox(a), rotBox(b)];
        const gap = Math.max(rb.x - (ra.x + ra.w), ra.x - (rb.x + rb.w), rb.y - (ra.y + ra.h), ra.y - (rb.y + rb.h));
        if (gap < 45) continue; // closer boxes leave no room for two stubs and a turn
        for (const fa of SIDES) {
          for (const fb of SIDES) {
            const { pts } = resolve([a, b, conn({ item: 'a', anchor: fa }, { item: 'b', anchor: fb })]).g;
            const last = pts.length - 2; // the first segment starts on a's outline, the last ends on b's
            const bad = pts.slice(1).some((q, k) => (k > 0 && through(pts[k], q, ra)) || (k < last && through(pts[k], q, rb)));
            const where = JSON.stringify({ rot, bx, by, fa, fb, pts });
            assert.ok(axisAligned(pts) && !bad, where);
            assert.ok(outside(pts[1], ra) && outside(pts.at(-2), rb), `stubs ${where}`);
            n++;
          }
        }
      }
    }
  }
  assert.ok(n > 900, String(n));
  // Facing away with the boxes overlapping in y: the centred Z went through both; now the route goes around them.
  const [a, b] = [rect('a', 200, 0, { h: 100 }), rect('b', 0, 30, { h: 100 })];
  const { pts } = resolve([a, b, conn({ item: 'a', anchor: [1, 0.5] }, { item: 'b', anchor: [0, 0.5] })]).g;
  assert.ok(!pts.slice(2, -1).some((q, k) => through(pts[k + 1], q, a) || through(pts[k + 1], q, b)), JSON.stringify(pts)); // inner segments
  // Every candidate goes through the turned box: the grid search finds the way.
  const [c, d] = [rect('c', 0, 0, { w: 160 }), rect('d', -90, 160, { w: 180, h: 150, rot: 140 })];
  const g = resolve([c, d, conn({ item: 'c', anchor: [0, 0.5] }, { item: 'd', anchor: [0, 0] })]).g.pts;
  assert.ok(axisAligned(g) && !g.slice(2, -1).some((q, k) => through(g[k + 1], q, rotBox(c)) || through(g[k + 1], q, rotBox(d))), JSON.stringify(g));
});

test('a self-loop (both ends floating on one item) leaves its east side and comes back into its north side: 4 segments', () => {
  const { pts } = resolve([A, conn({ item: 'a', anchor: null }, { item: 'a', anchor: null })]).g;
  const [p0, p1, q1, q0] = [pts[0], pts[1], pts.at(-2), pts.at(-1)];
  assert.ok(pts.length === 5 && p0.y === 30 && p1.y === 30 && p1.x > p0.x && q0.x === 50 && q1.x === 50 && q1.y < q0.y, JSON.stringify(pts));
  assert.ok(axisAligned(pts) && !pts.slice(2, -1).some((q, k) => through(pts[k + 1], q, A)), JSON.stringify(pts));
});

test('nearly aligned stacked shapes: one straight segment, no micro-jog; fixed ports kept; a real offset keeps its elbow', () => {
  const top = rect('a', 0, 0, { shape: 'round', w: 120 });
  const down = (pts) => pts.length === 2 && pts[0].x === pts[1].x && pts[1].y > pts[0].y;
  for (const off of [1, 3, 6]) {
    const bot = rect('b', off, 160, { shape: 'diam', w: 120, h: 80 });
    const { pts } = resolve([top, bot, conn({ item: 'a', anchor: null }, { item: 'b', anchor: null })]).g;
    assert.ok(down(pts) && pts[0].x === 60 && onPoly(outlineOf(top), pts[0]) && onPoly(outlineOf(bot), pts[1]), `floating ${off} ${JSON.stringify(pts)}`);
    const fixed = resolve([top, bot, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: [0.5, 0] })]).g.pts;
    if (off <= 4) assert.ok(down(fixed) && fixed[0].x === 60 && onPoly(outlineOf(bot), fixed[1]), `fixed ${off} snapped ${JSON.stringify(fixed)}`);
    else assert.ok(fixed.length === 4 && fixed[1].y === fixed[2].y && fixed.at(-1).x === 60 + off, `fixed ${off} elbow ${JSON.stringify(fixed)}`);
  }
  // Centres half a px apart on a 2 px line: whole px.
  const odd = resolve([top, rect('b', 0, 160, { w: 121 }), conn({ item: 'b', anchor: null }, { item: 'a', anchor: null })]).g.pts;
  assert.ok(odd.length === 2 && Number.isInteger(odd[0].x) && odd[0].x === odd[1].x, JSON.stringify(odd));
  // A real offset: fixed ports keep their elbow; a floating end slides under the fixed port (still on its outline).
  const far = rect('b', 40, 160);
  const el = resolve([top, far, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: [0.5, 0] })]).g.pts;
  assert.ok(el.length === 4 && axisAligned(el) && el[0].x === 60 && el.at(-1).x === 90 && el[1].y === el[2].y, JSON.stringify(el));
  const fl = resolve([top, far, conn({ item: 'a', anchor: [0.5, 1] }, { item: 'b', anchor: null })]).g.pts;
  assert.ok(down(fl) && fl[0].x === 60 && onPoly(outlineOf(far), fl[1]), JSON.stringify(fl));
  // No overlap across the axis: the normal elbow.
  const apart = resolve([top, rect('b', 300, 160), conn({ item: 'a', anchor: null }, { item: 'b', anchor: null })]).g.pts;
  assert.ok(apart.length === 4 && axisAligned(apart), JSON.stringify(apart));
  // A floating end lines up with a waypoint inside its extent; the waypoint stays on the path.
  const wp = { x: 30, y: 300 };
  const w = resolve([top, rect('b', 200, 400), conn({ item: 'a', anchor: null }, { item: 'b', anchor: [0, 0.5] }, { points: [wp] })]).g.pts;
  assert.ok(w[0].x === 30 && w[1].x === 30 && onPoly(w, wp, false) && axisAligned(w), JSON.stringify(w));
  // A fixed corner port never snaps past the end of its side (the tip stays on the outline, the path near the shapes).
  const cb = rect('b', 300, 32);
  const cn = resolve([A, cb, conn({ item: 'a', anchor: [1, 0.5] }, { item: 'b', anchor: [0, 0] })]).g.pts;
  assert.ok(onPoly(outlineOf(A), cn[0]) && onPoly(outlineOf(cb), cn.at(-1)) && cn.every((p) => p.x < 500), JSON.stringify(cn));
});

// n horizontal straight lines (below) and n vertical elbow lines (above, with `jump`), 100 px apart: n × n crossings.
const grid = (n, jump, extra = {}) => [
  ...Array.from({ length: n }, (_, k) => conn({ x: 0, y: 100 * (k + 1) }, { x: 100 * (n + 1), y: 100 * (k + 1) }, { id: `h${k}`, route: 'straight' })),
  ...Array.from({ length: n }, (_, k) => conn({ x: 100 * (k + 1), y: 0 }, { x: 100 * (k + 1), y: 100 * (n + 1) }, { id: `v${k}`, jump, ...extra })),
];
// The arcs in d: [x0, y0, sweep, x1, y1] (bbox px).
const arcs = (d) => [...d.matchAll(/L([-\d.]+) ([-\d.]+)A6 6 0 0 (\d) ([-\d.]+) ([-\d.]+)/g)].map((m) => m.slice(1).map(Number));

test('line jumps: the upper line jumps every line below it, 6 px either side of the crossing; gaps; never curves or the lower line', () => {
  const { items, capped } = resolveConnectors(grid(3, 'arc'));
  assert.equal(capped, false);
  for (const c of items) {
    const found = arcs(c.d);
    if (c.id[0] === 'h') {
      assert.equal(found.length, 0, c.id);
      continue;
    }
    const x = 100 * (Number(c.id[1]) + 1);
    assert.deepEqual(found.map(([x0, y0, sweep, x1, y1]) => [x0 + c.x, y0 + c.y, sweep, x1 + c.x, y1 + c.y]),
      [100, 200, 300].map((y) => [x, y - 6, 0, x, y + 6]), `${c.id} ${c.d}`); // downward: sweep 0 bulges left
    assert.ok(c.x <= x - 6, 'the bbox holds the arcs');
  }
  const gaps = resolveConnectors(grid(3, 'gap')).items.find((c) => c.id === 'v1').d;
  assert.equal(gaps.match(/M/g).length, 4, gaps);
  assert.ok(!resolveConnectors(grid(3, 'arc', { route: 'curve' })).items.some((c) => /A/.test(c.d)), 'curves never jump');
  const flipped = [...grid(3, 'none').slice(3), ...grid(3, 'arc').slice(0, 3).map((c) => ({ ...c, jump: 'arc' }))]; // verticals below
  assert.deepEqual(resolveConnectors(flipped).items.map((c) => arcs(c.d).length), [0, 0, 0, 3, 3, 3], 'only the upper (horizontal) lines jump');
  // Re-routing one line (onlyIds) also redraws the jumps of the line above it.
  const moved = resolveConnectors(grid(1, 'arc').map((c) => (c.id === 'h0' ? { ...c, from: { x: 0, y: 50 }, to: { x: 200, y: 50 } } : c)), undefined, new Set(['h0']));
  const v0 = moved.items.find((c) => c.id === 'v0');
  assert.deepEqual(arcs(v0.d).map((a) => a[1] + v0.y), [44]);
});

// Brute force: every pair of straight segments, the upper connector jumping.
function jumpsBrute(paths) {
  const hits = new Map();
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  paths.forEach((hi, z) => {
    if (!hi.jump || hi.curve) return;
    let s = 0;
    for (let k = 1; k < hi.pts.length; k++) {
      const [a, b] = [hi.pts[k - 1], hi.pts[k]];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (const lo of paths.slice(0, z)) {
        if (lo.curve) continue;
        for (let m = 1; m < lo.pts.length; m++) {
          const [c, e] = [lo.pts[m - 1], lo.pts[m]];
          const [d1, d2, d3, d4] = [cross(c, e, a), cross(c, e, b), cross(a, b, c), cross(a, b, e)];
          if (d1 * d2 < 0 && d3 * d4 < 0) hits.set(hi.id, [...(hits.get(hi.id) ?? []), s + len * (d1 / (d1 - d2))]);
        }
      }
      s += len;
    }
  });
  for (const l of hits.values()) l.sort((u, v) => u - v);
  return hits;
}

test('line jumps: the x sweep with its bbox prefilter finds exactly the brute-force crossings; the work cap', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 600;
  const paths = Array.from({ length: 40 }, (_, z) => ({
    id: `c${z}`, jump: z % 3 !== 0, curve: z % 7 === 0, pts: Array.from({ length: 2 + (z % 4) }, () => ({ x: Math.round(rnd()), y: Math.round(rnd()) })),
  }));
  const { hits, capped } = findJumps(paths);
  const want = jumpsBrute(paths);
  const key = (m) => JSON.stringify([...m].sort().map(([id, l]) => [id, l.map((s) => s.toFixed(6))]));
  assert.ok(!capped && want.size > 10 && key(hits) === key(want), `${key(hits)}\n${key(want)}`);
  assert.equal(findJumps(paths, 5).capped, true);
  assert.equal(resolveConnectors(grid(150, 'arc')).capped, true, '150 × 150 crossings pass the 20 000 test cap');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorPoint, KINDS, kindOf, outlineOf, perimeter, rotBox } from '../src/flow/shapes.mjs';
import { shapeGeometry } from '../src/whiteboard.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const shape = (kind, extra = {}) => ({ id: 's', type: 'shape', shape: kind, x: 100, y: 50, w: 160, h: 90, width: 2, ...extra });
// Distance from p to segment ab.
const segDist = (p, a, b) => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
};
const onOutline = (poly, p) => poly.some((a, k) => segDist(p, a, poly[(k + 1) % poly.length]) < 1e-6);

test('every kind: a closed outline path and a poly of ≥ 3 points (line and arrow: none, they attach on their box)', () => {
  for (const k of KINDS) {
    const { d, poly } = k.path(160, 90, 1);
    if (k.kind === 'line' || k.kind === 'arrow') {
      assert.equal(poly, null, k.kind);
      continue;
    }
    assert.ok(poly.length >= 3, k.kind);
    const drawn = d ?? shapeGeometry({ shape: k.kind, w: 160, h: 90, width: 2 }).d; // the 9 older kinds: whiteboard.js draws them
    assert.match(drawn, k.open ? /^M[^Z]*$/ : /^M.*Z/, k.kind); // an open kind (the annotation brace) is never closed or filled
  }
});

test('perimeter: on the ray from the centre, inside the box, on the outline', () => {
  for (const k of KINDS) {
    const it = shape(k.kind);
    const c = { x: 180, y: 95 };
    const toward = { x: 400, y: 160 };
    const p = perimeter(outlineOf(it), c, toward);
    assert.ok(near((p.x - c.x) * (toward.y - c.y) - (p.y - c.y) * (toward.x - c.x), 0, 1e-6), `${k.kind} on the ray`);
    assert.ok(p.x >= 100 - 1e-6 && p.x <= 260 + 1e-6 && p.y >= 50 - 1e-6 && p.y <= 140 + 1e-6, `${k.kind} inside the box`);
    assert.ok(onOutline(outlineOf(it), p), `${k.kind} on the outline`);
  }
});

test('ports: a diamond\'s east port is its east vertex; a rect turned 90° has its east port at the bottom middle', () => {
  const e = anchorPoint(shape('diam'), [1, 0.5]);
  assert.ok(near(e.x, 259) && near(e.y, 95), JSON.stringify(e)); // w - inset
  const corner = anchorPoint(shape('diam'), [1, 0]); // a box corner lands on the diamond's edge
  assert.ok(onOutline(outlineOf(shape('diam')), corner));
  const r = anchorPoint({ type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 60, width: 0, rot: 90 }, [1, 0.5]);
  assert.ok(near(r.x, 50) && near(r.y, 80), JSON.stringify(r));
});

test('rotBox: w × h at 0°, h × w at 90°, a square of side (w + h) / √2 at 45°, about the same centre', () => {
  const b = { x: 0, y: 0, w: 100, h: 60 };
  assert.deepEqual(rotBox({ ...b, rot: 0 }), b);
  const q = rotBox({ ...b, rot: 90 });
  assert.ok(near(q.w, 60) && near(q.h, 100) && near(q.x, 20) && near(q.y, -20), JSON.stringify(q));
  const s = rotBox({ ...b, rot: 45 });
  assert.ok(near(s.w, 160 / Math.SQRT2) && near(s.h, s.w) && near(s.x + s.w / 2, 50) && near(s.y + s.h / 2, 30), JSON.stringify(s));
});

test('a 30° diamond: the perimeter point lies on its turned outline', () => {
  const it = shape('diam', { rot: 30 });
  const poly = outlineOf(it);
  const p = perimeter(poly, { x: 180, y: 95 }, { x: 500, y: 95 });
  assert.ok(onOutline(poly, p) && p.x > 180, JSON.stringify(p));
  assert.ok(kindOf('diam') && !kindOf('nope'));
});

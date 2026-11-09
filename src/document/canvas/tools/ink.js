// Ink on the page (docs/plans/engine/stage2b.md, engine-page-tools): the Draw tab's pens (draw.stroke, one undo step a stroke),
// its eraser (draw.erase at each point the drag passes), the stencil ruler strokes snap to, and Ink Replay (draw.replay's strokes
// drawn again in order over the page). The pens are the app's (settings.word.pens, src/document/wp/draw/pens.mjs).

const PT_PER_MM = 72 / 25.4;
const MIN_STEP = 0.75; // points between two kept pen points
const SNAP = 8; // points from the ruler's edge where a stroke's ends snap to it
const ERASE_STEP = 2; // points between two places the eraser tries along a drag
const KIND = { pen: 'pen', fountainPen: 'pen', brushPen: 'pen', pencil: 'pencil', highlighter: 'highlighter' };
const OPACITY = { highlighter: 0.35, pencil: 0.7 };

/** The stencil ruler: `at` is {surface, x, y, deg, len} in surface points (its top edge from (x, y) along `deg` degrees) or null;
 * set(at) moves it, and the overlay hears it through subscribe and version. */
export const ruler = (() => {
  const fns = new Set();
  let v = 0;
  return {
    at: null,
    set(at) {
      this.at = at;
      v++;
      for (const fn of fns) fn();
    },
    subscribe: (fn) => (fns.add(fn), () => fns.delete(fn)),
    version: () => v,
  };
})();

/** The ruler's top edge as a line ({a, b} in surface points) on `surface`, or null. */
export function rulerEdge(surface) {
  const r = ruler.at;
  if (!r || r.surface !== surface) return null;
  const t = (r.deg * Math.PI) / 180;
  return { a: { x: r.x, y: r.y }, b: { x: r.x + Math.cos(t) * r.len, y: r.y + Math.sin(t) * r.len } };
}

/** `pts` straightened onto `edge` when both its ends lie within SNAP points of it, else null. */
export function snapToEdge(pts, edge) {
  if (!edge || pts.length < 2) return null;
  const { a, b } = edge;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const on = ([x, y]) => {
    const t = ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1);
    return [a.x + t * dx, a.y + t * dy];
  };
  const ends = [pts[0], pts.at(-1)].map((p) => [p, on(p)]);
  if (!ends.every(([p, q]) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= SNAP)) return null;
  return ends.map(([, q]) => q);
}

/** A pen of the gallery ({kind, color '#rrggbb', width mm}) as draw.stroke's params. */
export const strokeOf = (pen) => ({ tool: KIND[pen.kind] ?? 'pen', color: pen.color.slice(1).toUpperCase(), width: Math.round(pen.width * PT_PER_MM * 100) / 100 });

/** A pen: each drag is one stroke on its page (snapped to the ruler's edge when both ends lie on it). */
export const penTool = (pen) => (env) => {
  let pts = null;
  let surface = null;
  const s = strokeOf(pen);
  return {
    cursor: 'crosshair',
    down(at) {
      surface = at.surface;
      pts = [[at.x, at.y]];
      env.redraw();
    },
    move(at) {
      if (!pts || at.surface !== surface) return;
      const [x, y] = pts.at(-1);
      if (Math.hypot(at.x - x, at.y - y) < MIN_STEP) return;
      pts.push([at.x, at.y]);
      env.redraw();
    },
    async up() {
      if (!pts) return;
      let points = pts;
      pts = null;
      env.redraw();
      if (points.length === 1) points = [points[0], [points[0][0] + 0.01, points[0][1]]]; // a dot
      points = snapToEdge(points, rulerEdge(surface)) ?? points;
      await env.exec('draw.stroke', { page: surface, points, ...s });
    },
    preview: (surf) => (pts && surf === surface
      ? [{ path: pts, stroke: pen.color, width: Math.max(1, s.width * env.vp.camera.zoom * (4 / 3)), opacity: OPACITY[pen.kind] }]
      : []),
  };
};

/** The ink eraser: the strokes the drag passes over go (draw.erase every ERASE_STEP points along it), each one undo step. */
export const inkEraserTool = (env) => {
  let busy = Promise.resolve();
  let last = null;
  const erase = (at) => {
    const from = last && last.surface === at.surface ? last : at;
    const n = Math.max(1, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / ERASE_STEP));
    for (let i = from === at ? 0 : 1; i <= n; i++) {
      const p = { x: from.x + ((at.x - from.x) * i) / n, y: from.y + ((at.y - from.y) * i) / n };
      busy = busy.then(() => env.exec('draw.erase', { page: at.surface, ...p }));
    }
    last = at;
  };
  return {
    cursor: 'cell',
    down(at) {
      last = null;
      erase(at);
    },
    move(at) {
      if (last) erase(at);
    },
    up() {
      last = null;
    },
  };
};

/** Lasso Select (the Draw gallery, engine-tools-2): a loop drawn on a page selects the ink inside it (draw.lasso), shown as a
 * dashed box; a drag inside the box moves that ink (draw.lassoMove) and Delete deletes it (draw.lassoDelete), each one undo step.
 * A loop elsewhere selects again; Esc or another tool ends it and drops the selection. */
export const lassoTool = (env) => {
  let loop = null; // {surface, pts}
  let box = null; // the selection's {page, x, y, w, h}
  let drag = null; // {x, y, dx, dy} while the selection moves
  const bounds = async () => {
    box = await env.query('draw.lassoBounds');
    env.redraw();
  };
  const inside = (at) => box && at.surface === box.page && at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h;
  return {
    cursor: 'crosshair',
    down(at) {
      if (inside(at)) drag = { x: at.x, y: at.y, dx: 0, dy: 0 };
      else loop = { surface: at.surface, pts: [[at.x, at.y]] };
      env.redraw();
    },
    move(at) {
      if (drag) {
        [drag.dx, drag.dy] = [at.x - drag.x, at.y - drag.y];
        env.redraw();
        return;
      }
      if (!loop || at.surface !== loop.surface) return;
      const [x, y] = loop.pts.at(-1);
      if (Math.hypot(at.x - x, at.y - y) < MIN_STEP) return;
      loop.pts.push([at.x, at.y]);
      env.redraw();
    },
    async up() {
      if (drag) {
        const { dx, dy } = drag;
        drag = null;
        if (Math.hypot(dx, dy) > 0.5) await env.exec('draw.lassoMove', { dx, dy });
        return bounds();
      }
      if (!loop) return;
      const { surface, pts } = loop;
      loop = null;
      if (pts.length >= 3) await env.exec('draw.lasso', { page: surface, points: pts });
      else await env.exec('draw.lasso', { clear: true });
      await bounds();
    },
    key(e) {
      if (!box || (e.key !== 'Delete' && e.key !== 'Backspace')) return false;
      box = null;
      env.exec('draw.lassoDelete', {}).then(() => env.redraw());
      return true;
    },
    end: () => void env.exec('draw.lasso', { clear: true }),
    preview(surface) {
      const out = [];
      if (loop?.surface === surface) out.push({ path: loop.pts, closed: true, dash: true, stroke: '#404040' });
      if (box?.page === surface) out.push({ rect: { x: box.x + (drag?.dx ?? 0), y: box.y + (drag?.dy ?? 0), w: box.w, h: box.h }, dash: true });
      return out;
    },
  };
};

/** Ink Replay: the document's strokes drawn again over the pages in the order they were drawn, then the tool ends and `after()`
 * runs. The tiles leave the ink out while the engine's draw.replay is on (engine-tools-2), so the strokes appear as they replay,
 * as in Word; `after` turns it off. */
export const replayTool = (strokes, ms = 2000, after = null) => (env) => {
  const shown = new Map(); // index → points shown
  const total = strokes.reduce((n, s) => n + s.paths.reduce((m, p) => m + p.length, 0), 0) || 1;
  const t0 = performance.now();
  let raf = 0;
  const step = () => {
    let left = ((performance.now() - t0) / ms) * total;
    for (const [i, s] of strokes.entries()) {
      const n = s.paths.reduce((m, p) => m + p.length, 0);
      shown.set(i, Math.min(n, Math.max(0, Math.ceil(left))));
      left -= n;
    }
    env.redraw();
    raf = left >= 0 ? (env.done(), 0) : requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return {
    cursor: 'default',
    anywhere: true,
    down: () => env.done(),
    end: () => {
      cancelAnimationFrame(raf);
      after?.();
    },
    preview(surface) {
      const out = [];
      for (const [i, s] of strokes.entries()) {
        if (s.page !== surface) continue;
        let n = shown.get(i) ?? 0;
        for (const p of s.paths) {
          if (n <= 0) break;
          out.push({ path: p.slice(0, n), stroke: `#${s.color ?? '000000'}`, width: Math.max(1, (s.width ?? 1) * env.vp.camera.zoom * (4 / 3)) });
          n -= p.length;
        }
      }
      return out;
    },
  };
};

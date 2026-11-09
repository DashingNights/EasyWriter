// Shapes on the page (docs/plans/engine/stage2b.md, engine-page-tools): Insert > Shapes' and Draw Text Box's crosshair, Edit
// Points (shape.points, shape.setPoints, with curve handles and point types from engine-tools-2: curves.mjs) and Edit Wrap Points
// (arrange.wrapPoints, arrange.setWrapPoints). Each commit is one undo step.
import * as C from './curves.mjs';

const CLICK = 3; // points a press may move and still count as a click
const ONE_INCH = 72; // a click's shape, as Word's
const REACH = 6; // screen px from a point that still grabs it

/** The box from `a` to `b` (surface points): Shift keeps it square (a line at 45 degrees, `line`), Ctrl draws from the centre. */
export function dragBox(a, b, { square = false, centre = false, line = false } = {}) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square && line) {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    [dx, dy] = [Math.cos(ang) * len, Math.sin(ang) * len];
  } else if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [Math.sign(dx || 1) * s, Math.sign(dy || 1) * s];
  }
  const [x0, y0] = centre ? [a.x - dx, a.y - dy] : [a.x, a.y];
  const [x1, y1] = [a.x + dx, a.y + dy];
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), flipH: x1 < x0, flipV: y1 < y0 };
}

/** The crosshair: a drag draws a box on one page (a click a 1 inch one there), and the object goes in there: `steps` (the engine
 * steps that make it at the caret) run with In Front of Text and the drawn place as one undo step. A text box leaves the caret in
 * its own text, so the box is selected again by its character before it is placed. */
export const crosshair = (steps, { line = false } = {}) => ({ redraw, done, execMany, client }) => {
  const textBox = steps[0]?.[0] === 'insert.textBox';
  let start = null;
  let box = null;
  const opts = (e) => ({ square: e.shiftKey, centre: e.ctrlKey, line });
  return {
    cursor: 'crosshair',
    down(at) {
      start = at;
      box = null;
    },
    move(at, e) {
      if (!start || at.surface !== start.surface) return;
      box = dragBox(start, at, opts(e));
      redraw();
    },
    async up(at, e) {
      if (!start) return;
      const s = start;
      let b = at.surface === s.surface ? dragBox(s, at, opts(e)) : box;
      start = null;
      box = null;
      if (!b || (b.w < CLICK && b.h < CLICK)) b = { x: s.x, y: s.y, w: ONE_INCH, h: line ? 0 : ONE_INCH };
      done();
      const size = { width: Math.max(1, b.w), height: Math.max(line ? 0.01 : 1, b.h) };
      let make = steps;
      if (textBox) {
        const at = (await client.exec('select.collapse', {}))?.value?.focus;
        if (!at) return;
        make = [['insert.textBox', size], ['select.range', { anchor: at, focus: { ...at, off: at.off + 3 } }], ...steps.slice(1)];
      }
      const place = [['arrange.wrap', { wrap: 'inFrontOfText' }], ['arrange.bounds', { page: s.surface, x: b.x, y: b.y, ...size }]];
      const flips = [b.flipH && ['arrange.rotate', { direction: 'flipHorizontal' }], b.flipV && line && ['arrange.rotate', { direction: 'flipVertical' }]].filter(Boolean);
      await execMany([...make, ...place, ...flips]);
    },
    preview: (surface) => (box && start?.surface === surface
      ? [line ? { path: [[box.flipH ? box.x + box.w : box.x, box.flipV ? box.y + box.h : box.y], [box.flipH ? box.x : box.x + box.w, box.flipV ? box.y : box.y + box.h]] } : { rect: box, dash: true }]
      : []),
  };
};

/** A crosshair that draws a box on one page (a click a 1 inch one there) and hands it to `place(box, surface)`, then ends:
 * Insert Frame's (engine-tools-2). */
export const boxTool = (place) => ({ redraw, done }) => {
  let start = null;
  let box = null;
  return {
    cursor: 'crosshair',
    down(at) {
      start = at;
      box = null;
    },
    move(at, e) {
      if (!start || at.surface !== start.surface) return;
      box = dragBox(start, at, { square: e.shiftKey, centre: e.ctrlKey });
      redraw();
    },
    async up(at, e) {
      if (!start) return;
      const s = start;
      let b = at.surface === s.surface ? dragBox(s, at, { square: e.shiftKey, centre: e.ctrlKey }) : box;
      start = null;
      box = null;
      if (!b || (b.w < CLICK && b.h < CLICK)) b = { x: s.x, y: s.y, w: ONE_INCH, h: ONE_INCH };
      done();
      await place(b, s.surface);
    },
    preview: (surface) => (box && start?.surface === surface ? [{ rect: box, dash: true }] : []),
  };
};

/** Create Link's pick: a click on an empty text box links the selected box to it, and any click ends the pick. `toast(text)` says
 * why nothing linked. */
export const linkPick = (toast) => ({ done, exec, query }) => {
  let start = null;
  return {
    cursor: 'copy',
    down(at) {
      start = at;
    },
    async up(at) {
      if (!start) return;
      start = null;
      const hit = await query('object.at', { page: at.surface, x: at.x, y: at.y });
      done();
      if (hit?.kind !== 'textbox') toast('Click an empty text box to link to.');
      else if (!(await exec('shape.link', { target: hit.pos }))) toast('The text box to link to must be empty and not linked already.');
    },
  };
};

/** The selected object's frame on the page now → {surface, x, y, w, h, rotation, obj} or null: object.get gives its character,
 * the frames of the page its character is on (else of any page shown) its place. */
export async function frameOf(env) {
  const o = await env.query('object.get');
  if (!o?.pos) return null;
  const at = await Promise.resolve(env.client.caret(o.pos)).catch(() => null);
  const pages = env.vp.placements.filter((q) => q.session === env.client.id).map((q) => q.surface);
  for (const surface of at ? [at.page, ...pages.filter((p) => p !== at.page)] : pages) {
    const hit = ((await env.client.frames(surface)) ?? []).find((x) => x.pos && JSON.stringify(x.pos) === JSON.stringify(o.pos));
    if (hit) return { surface, x: hit.x, y: hit.y, w: hit.w, h: hit.h, rotation: o.rotation ?? 0, obj: o };
  }
  return null;
}

/** Index of the point of `pts` (surface points) within REACH screen px of `at`, or -1. */
const nearPoint = (pts, at, k) => pts.findIndex(([x, y]) => Math.hypot(x - at.x, y - at.y) * k <= REACH);

/** A tool that drags the points of an outline over the selected object's frame. `read(env, frame)` → [{pts, closed}] in surface
 * points; `write(env, paths, frame)` commits them. A drag on a segment adds a point there, as Word's Edit Points does. */
const pointEditor = (read, write, look) => (env) => {
  let frame = null;
  let paths = null;
  let grab = null; // {p, i}
  const k = () => env.vp.camera.zoom * (4 / 3);
  const load = async () => {
    frame = await frameOf(env);
    if (!frame) return env.done();
    paths = await read(env, frame);
    if (!paths) return env.done();
    env.redraw();
  };
  load();
  return {
    cursor: 'default',
    down(at) {
      if (!paths || at.surface !== frame.surface) return env.done();
      for (const [p, path] of paths.entries()) {
        const i = nearPoint(path.pts, at, k());
        if (i >= 0) return void (grab = { p, i });
      }
      // On a segment: a new point there.
      for (const [p, path] of paths.entries()) {
        const n = path.pts.length;
        for (let i = 0; i < (path.closed ? n : n - 1); i++) {
          const [a, b] = [path.pts[i], path.pts[(i + 1) % n]];
          if (segDist(a, b, at) * k() <= REACH) {
            path.pts.splice(i + 1, 0, [at.x, at.y]);
            grab = { p, i: i + 1 };
            env.redraw();
            return;
          }
        }
      }
      env.done(); // a press away from the outline ends point editing, as in Word
    },
    move(at) {
      if (!grab || at.surface !== frame.surface) return;
      paths[grab.p].pts[grab.i] = [at.x, at.y];
      env.redraw();
    },
    async up() {
      if (!grab) return;
      grab = null;
      await write(env, paths, frame);
      env.redraw();
    },
    preview: (surface) => (paths && frame?.surface === surface
      ? [
        ...paths.map((path) => ({ path: path.pts, closed: path.closed, stroke: look.line, dash: look.dash })),
        ...paths.flatMap((path) => path.pts.map((pt) => ({ handle: pt, fill: look.handle, stroke: look.handleStroke }))),
      ]
      : []),
  };
};

function segDist([ax, ay], [bx, by], { x, y }) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** A path's points moved by (dx, dy): its nodes and their handles. */
const shifted = (p, dx, dy) => {
  const m = (q) => q && [q[0] + dx, q[1] + dy];
  return { closed: p.closed, nodes: p.nodes.map((n) => ({ ...n, at: m(n.at), cIn: m(n.cIn), cOut: m(n.cOut) })) };
};

/** Edit Points: the shape's points as black squares on its red outline, as Word draws them. A press on a point selects it and
 * shows its curve handles (white squares), a drag moves the point or a handle (a smooth or straight point's other handle
 * following), a drag on a side adds a point there, Ctrl+click deletes a point or adds one on a side. The right-click menu has
 * Word's point and segment entries (probe/context-menus.tsv, Curve Node and Curve Segment). Each change is one undo step
 * (shape.setPoints with the nodes, which the engine keeps beside the drawn polyline). */
export const editPoints = (env) => {
  let frame = null;
  let paths = null; // curves.mjs paths in surface points
  let sel = null; // {p, i}: the selected point
  let grab = null; // {p, i, part: 'at' | 'cIn' | 'cOut'}
  let moved = false;
  const k = () => env.vp.camera.zoom * (4 / 3);
  const load = async () => {
    frame = await frameOf(env);
    const got = frame && (await env.query('shape.points'));
    if (!got?.paths?.length) return env.done();
    paths = got.paths.map((p) => (p.nodes ? { closed: p.closed, nodes: p.nodes.map((n) => ({ cIn: null, cOut: null, kind: 'corner', ...n })) }
      : C.pathOf(p.pts, p.closed))).map((p) => shifted(p, frame.x, frame.y));
    env.redraw();
  };
  load();
  const commit = async () => {
    if (!paths.length) return;
    const local = paths.map((p) => shifted(p, -frame.x, -frame.y));
    await env.exec('shape.setPoints', { paths: local.map((p) => ({ closed: p.closed, nodes: p.nodes })) });
    env.redraw();
  };
  /** What lies under `at`: {p, i, part} for a handle of the selected point or a point, {p, side, t} for a side, or null. */
  const hitAt = (at) => {
    if (!paths || at.surface !== frame.surface) return null;
    const near = (q) => q && Math.hypot(q[0] - at.x, q[1] - at.y) * k() <= REACH;
    if (sel) {
      const h = C.handlesOf(paths[sel.p], sel.i);
      for (const part of ['cIn', 'cOut']) if (near(h[part])) return { ...sel, part };
    }
    for (const [p, path] of paths.entries()) {
      const i = path.nodes.findIndex((n) => near(n.at));
      if (i >= 0) return { p, i, part: 'at' };
    }
    for (const [p, path] of paths.entries()) {
      const s = C.nearSide(path, [at.x, at.y]);
      if (s && s.d * k() <= REACH) return { p, side: s.side, t: s.t };
    }
    return null;
  };
  /** Paths `list` in place of path `p`; the selection goes. */
  const replace = async (p, list) => {
    if (paths.length === 1 && !list.length) return; // the shape keeps a path
    paths.splice(p, 1, ...list);
    sel = null;
    await commit();
  };
  const addAt = async (h) => {
    const { path, index } = C.addPoint(paths[h.p], h.side, h.t);
    paths[h.p] = path;
    sel = { p: h.p, i: index };
    await commit();
  };
  return {
    cursor: 'default',
    down(at, e) {
      const h = hitAt(at);
      if (!h) return env.done(); // a press away from the outline ends point editing, as in Word
      moved = false;
      if (e?.ctrlKey) {
        if (h.part === 'at') return void replace(h.p, C.deletePoint(paths[h.p], h.i));
        if (h.side != null) return void addAt(h);
        return;
      }
      if (h.side != null) {
        // A drag on a side adds a point there and moves it, as Word's Edit Points does.
        const { path, index } = C.addPoint(paths[h.p], h.side, h.t);
        paths[h.p] = path;
        sel = { p: h.p, i: index };
        grab = { ...sel, part: 'at' };
        moved = true;
      } else {
        if (h.part === 'at') sel = { p: h.p, i: h.i };
        grab = h;
      }
      env.redraw();
    },
    move(at) {
      if (!grab || at.surface !== frame.surface) return;
      const to = [at.x, at.y];
      paths[grab.p] = grab.part === 'at' ? C.moveNode(paths[grab.p], grab.i, to) : C.moveHandle(paths[grab.p], grab.i, grab.part, to);
      moved = true;
      env.redraw();
    },
    async up() {
      if (!grab) return;
      grab = null;
      if (moved) await commit();
    },
    menu(at) {
      const h = hitAt(at);
      if (!h || h.part === 'cIn' || h.part === 'cOut') return null;
      const path = paths[h.p];
      const exit = { label: 'Exit &Edit Point', run: () => env.done() };
      // Word lists both of each pair (probe context-menus.tsv, Curve Node and Curve Segment), the one that does not apply disabled.
      const ends = [
        { label: 'Ope&n Path', disabled: !path.closed, run: () => replace(h.p, [C.openAt(path, h.i ?? (h.side + 1) % path.nodes.length)]) },
        { label: 'C&lose Path', disabled: path.closed, run: () => replace(h.p, [C.closePath(path)]) },
      ];
      if (h.part === 'at') {
        sel = { p: h.p, i: h.i };
        env.redraw();
        const kind = (k2, label) => ({ label, run: () => replace(h.p, [C.setKind(path, h.i, k2)]) });
        const next = path.closed || h.i < path.nodes.length - 1;
        return [
          { label: '&Add Point', disabled: !next, run: () => addAt({ p: h.p, side: h.i, t: 0.5 }) },
          { label: 'De&lete Point', run: () => replace(h.p, C.deletePoint(path, h.i)) },
          ...ends,
          null,
          kind('auto', 'Au&to Point'), kind('smooth', '&Smooth Point'), kind('straight', 'St&raight Point'), kind('corner', '&Corner Point'),
          null,
          exit,
        ];
      }
      const curved = C.isCurved(path, h.side);
      return [
        { label: '&Add Point', run: () => addAt(h) },
        { label: 'De&lete Segment', run: () => replace(h.p, C.deleteSegment(path, h.side)) },
        ...ends,
        null,
        { label: '&Straight Segment', disabled: !curved, run: () => replace(h.p, [C.setSegment(path, h.side, false)]) },
        { label: '&Curved Segment', disabled: curved, run: () => replace(h.p, [C.setSegment(path, h.side, true)]) },
        null,
        exit,
      ];
    },
    preview(surface) {
      if (!paths || frame?.surface !== surface) return [];
      const out = paths.map((p) => ({ path: C.flatten(p), closed: p.closed && p.nodes.length > 2, stroke: '#c00000' }));
      for (const p of paths) for (const n of p.nodes) out.push({ handle: n.at, fill: '#000000', stroke: '#ffffff' });
      if (sel && paths[sel.p]?.nodes[sel.i]) {
        const at = paths[sel.p].nodes[sel.i].at;
        const h = C.handlesOf(paths[sel.p], sel.i);
        for (const q of [h.cIn, h.cOut].filter(Boolean)) {
          out.push({ path: [at, q], stroke: '#000000' });
          out.push({ handle: q, fill: '#ffffff', stroke: '#000000' });
        }
      }
      return out;
    },
  };
};

/** Edit Wrap Points: the wrap polygon as a dashed red line with black points (arrange.wrapPoints, 0..1 across the frame). */
export const editWrapPoints = pointEditor(
  async (env, f) => {
    const g = await env.query('arrange.wrapPoints');
    return g ? [{ closed: true, pts: g.points.map(([u, v]) => [f.x + u * f.w, f.y + v * f.h]) }] : null;
  },
  (env, [p], f) => env.exec('arrange.setWrapPoints', { points: p.pts.map(([x, y]) => [(x - f.x) / (f.w || 1), (y - f.y) / (f.h || 1)]) }),
  { line: '#c00000', dash: true, handle: '#000000', handleStroke: '#ffffff' },
);

// bd-snap: snapping for the board's gestures (docs/plans/board/briefs/bd-snap.md). The engine and its rules are the shared
// flow/snap.mjs, which works in board px; a board's world is points, so this file is the one place the two meet (look.mjs's
// toPx / toPt) and the guides it draws are the screen-plane overlay in Guides.jsx.
import { planeTools } from '../../whiteboard.js';
import { snap } from '../../flow/snap.mjs';
import { boxOf, turnedBox, unionBox } from '../gestures.mjs';
import { toPt, toPx } from '../look.mjs';
import { registerTool } from './registry.js';

const GRID = 10; // board px
const ALL = [0, 1, 2]; // every line of a moving box: start, centre, end
const EDGE = { w: 0, e: 2, n: 0, s: 2 };

/** The guides a gesture is showing: {box, q, hits, kind, level} in board px, or null. Guides.jsx draws it through
 * useSyncExternalStore, and a drag's frame sets it, so it is module state like the tool's own gesture (place.js has one). */
let guides = null;
const subs = new Set();
let version = 0;

export const guideState = {
  get current() {
    return guides;
  },
  set(next) {
    if (next === guides) return;
    guides = next;
    version++;
    for (const fn of subs) fn();
  },
  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  version: () => version,
};

const px = (b) => ({ x: toPx(b.x ?? 0), y: toPx(b.y ?? 0), w: toPx(b.w ?? 0), h: toPx(b.h ?? 0) });
const r4 = (n) => Math.round(n * 1e4) / 1e4; // 1e-4 pt: a snapped edge lands on its target, with no px round-trip residue

/** The board's visible part, in points: off-screen items never catch a snap (board-snapping.md). */
const viewOf = (vp) => vp?.view?.() ?? null;

const inView = (b, view) => !view || !(b.x > view.x + view.w || view.x > b.x + b.w || b.y > view.y + view.h || view.y > b.y + b.h);

/** Every snap target on the board (points `b` kept for the view test, the px box for the engine): all non-hidden items but
 * connectors, instances (their pages are not targets in version 1) and skipped ones, by their turned bounds. Locked items count. */
function allTargets(store, skip) {
  const gone = new Set(skip);
  const out = [];
  for (const item of store.live()) {
    if (item.hidden || gone.has(item.id) || item.type === 'connector' || item.type === 'doc') continue;
    const b = turnedBox(boxOf(item, store), item.rot ?? 0);
    if (!b) continue; // a group a merge left with no live children: nothing to snap to
    out.push({ id: item.id, ...px(b), b });
  }
  return out;
}

/** The snap targets for a gesture over `view` (points), as {id, x, y, w, h} in px: every target (allTargets) meeting the view. */
export function targetsOf(store, skip = [], view = null) {
  const out = [];
  for (const t of allTargets(store, skip)) if (inView(t.b, view)) out.push({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h });
  return out;
}

// The drag's target list, built once: the store's clock and the skip set name it, and the camera moving does not change it.
let list = null;

/** Every target of the drag in hand, filtered by `view` each frame (a pan during a drag moves it). Rebuilt only when the
 * store or the moved items change, which is not within one drag. */
function targetsFor(store, skip, view) {
  const key = `${store.board.clock}|${[...skip].sort().join(',')}`;
  if (list?.key !== key) list = { key, all: allTargets(store, skip) };
  return list.all.filter((t) => inView(t.b, view));
}

/** The query `snap(q)` takes for a box (points) as whiteboard.js builds it: every length in px, `tol` the snap distance in
 * screen px over the zoom, so a snap feels the same at any zoom. `targets` answers a caller that keeps its own list. */
export function queryOf({ box, lines, store, skip, view, rules, zoom, prev, targets }) {
  return {
    box: px(box),
    lines,
    targets: targets ?? (rules.items === false ? [] : targetsOf(store, skip, view)),
    frame: rules.board === false || !store.board.frame ? null : px(store.board.frame),
    tol: rules.distance / zoom,
    sticky: 1 / zoom,
    spacing: !!rules.spacing,
    grid: rules.grid ? GRID : 0,
    prev: prev ?? null,
  };
}

/** The snap of `q` back in points: {dx, dy, hits}, `hits` the engine's own. The delta is rounded to 1e-4 pt so a snapped
 * position sits exactly on its target rather than 1e-6 pt off it from the px round trip. */
export function snapped(q) {
  const hits = snap(q);
  return { dx: r4(toPt(hits.x?.d ?? 0)), dy: r4(toPt(hits.y?.d ?? 0)), hits };
}

let prev = null; // the last frame's hits: the engine counts the previous winner 1 screen px nearer

/** Ends a gesture: no guides, and the next one starts without a sticky winner. */
function end() {
  prev = null;
  guideState.set(null);
}

const idsOf = (sel) => (Array.isArray(sel) ? sel : sel?.ids ?? []);

/** The items a gesture moves, and so must not snap to: each moved item with its descendants (a group moves its children),
 * plus each ancestor group (a child moved inside one: the group's union box reads its start positions). */
function related(store, ids) {
  const out = new Set();
  const add = (id) => {
    const item = store.get(id);
    if (!item || item.gone || out.has(id)) return;
    out.add(id);
    for (const child of store.children(id)) add(child.id);
  };
  for (const id of ids) {
    add(id);
    const seen = new Set();
    for (let item = store.get(id); item && !seen.has(item.id);) {
      seen.add(item.id);
      const parent = item.at?.[0] != null ? store.get(item.at[0]) : null;
      if (!parent || parent.gone) break;
      if (!out.has(parent.id)) out.add(parent.id);
      item = parent;
    }
  }
  return out;
}

export default registerTool({
  id: 'snap',

  mount(ctx) {
    let off = null;
    let dead = false;
    // Guides.jsx is JSX, so it is loaded when a board mounts and node tests can still load this file.
    import('../Guides.jsx').then(({ Guides }) => {
      const overlays = ctx.vp?.overlays;
      if (dead || !overlays) return;
      overlays.register('board-guides', Guides, { plane: 'screen' });
      off = () => overlays.register('board-guides', null);
    }, () => {});
    return () => {
      dead = true;
      off?.();
      off = null;
      end();
    };
  },

  // Every drag ends through pointer.js, whether by a release, a lost capture or a cancel: the guides go once, not on a
  // pointerup a lost capture never sends.
  end() {
    end();
  },

  // A drag's delta after pointer.js's own one (and any earlier tool's). `sel` is the moved ids from a selection's move; a
  // resize or a draw passes {ids, box, edges} with `box` the box at the pointer (points) and `edges` the moving sides, as the
  // brief describes. Ctrl held skips snapping, and Shift locks an axis in pointer.js, so only the free axis snaps.
  moveFrame(ctx, sel, dx, dy, e) {
    const rules = planeTools.snap;
    const v = ctx.vp;
    // The live keys: pointer.js passes {ctrl, shift, alt} each frame, and a tool's own drag may pass its pointer event.
    const ctrl = !!(e?.ctrl ?? e?.ctrlKey);
    const shift = !!(e?.shift ?? e?.shiftKey);
    if (!v || !rules.on || ctrl) {
      end();
      return { dx, dy };
    }
    const ids = idsOf(sel);
    const skip = related(ctx.store, ids);
    const items = ids.map((id) => ctx.store.get(id)).filter((item) => item && !item.gone);
    const start = Array.isArray(sel) ? unionBox(items.map((item) => turnedBox(boxOf(item, ctx.store), item.rot ?? 0))) : null;
    if (!start && !sel?.box) return { dx, dy };
    const edges = Array.isArray(sel) ? null : sel.edges ?? null;
    const lock = shift ? (dx === 0 ? 'x' : dy === 0 ? 'y' : null) : null;
    const lineOf = (axis, names) => {
      if (lock === axis) return [];
      if (!edges) return ALL;
      return names.filter((n) => edges.includes(n)).map((n) => EDGE[n]);
    };
    // The box the pointer asks for: the gesture's start box moved by the raw delta.
    const want = start ? { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h } : sel.box;
    const view = viewOf(v);
    const q = queryOf({ box: want, lines: { x: lineOf('x', ['w', 'e']), y: lineOf('y', ['n', 's']) }, store: ctx.store,
      skip, view, rules, zoom: v.camera.zoom, prev, targets: rules.items === false ? [] : targetsFor(ctx.store, skip, view) });
    const s = snapped(q);
    prev = s.hits;
    guideState.set({ box: { ...q.box, x: q.box.x + (s.hits.x?.d ?? 0), y: q.box.y + (s.hits.y?.d ?? 0) },
      q, hits: s.hits, kind: 'move', level: rules.guides });
    return { dx: dx + s.dx, dy: dy + s.dy };
  },
});

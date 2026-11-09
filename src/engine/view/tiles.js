// The tile layer (docs/plans/engine/viewport-design.md section 4.3, measure.md section 6): a viewport's painted tiles, shown as
// 'bitmaprenderer' canvases inside each surface's slot div, so they move with native scrolling and a zoom gesture's transform.
// Each frame in which the view, the zoom or the placements changed it plans with tiles.mjs, sends the wished tiles to the
// engine host's worker (`want`, merged with the other viewports' on that host, since a new list replaces the worker's) and
// places the tiles the worker sends in 'tiles' events. A tile keeps showing while it is stale (at an old scale, stretched, or
// damaged by a layout until it is repainted), so a scroll or a zoom never waits on the worker and never blanks an area that was
// seen; an area never seen gets a rough quarter-scale tile first (tiles.mjs rough()). The canvases are the cache: one out of
// view keeps its pixels until the budget needs the room. Plain web APIs only.
import { kOf } from './camera.mjs';
import { BUDGET, keyOf, plan, rough, scaleOf, standIn, TILE, untouched, wanted, weight } from './tiles.mjs';

const KEEP = 500; // arrival timings kept for the harness: a ring, so memory stays flat however long the scroll
const SETTLE_MS = 100; // a burst of zoom changes paints once, when it stops: the sharp repaint waits this long after the last change

/** A copy of ImageBitmap `b`, for a tile two viewports of one host show. */
function copyOf(b) {
  const c = new OffscreenCanvas(b.width, b.height);
  c.getContext('2d').drawImage(b, 0, 0);
  return c.transferToImageBitmap();
}

// The worker holds one wish list, so the viewports on one host send theirs as one: the focused viewport's first.
const lists = new WeakMap(); // host → {layers: Map(layer → list), queued}

/** Whether a tile layer on `host` other than `layer` wishes tile `key`: a 'tiles' event reaches every layer, and the bitmap
 * one of them closes is gone for the others. */
const wishedElsewhere = (host, layer, key) => [...(lists.get(host)?.layers.keys() ?? [])].some((l) => l !== layer && l.keys?.has(key));

/** How many tile layers on `host` wish tile `key` (a split's two panes count two). */
const wishCount = (host, key) => [...(lists.get(host)?.layers.keys() ?? [])].filter((l) => l.keys?.has(key)).length;

/** The panes that still have to take a tile event's bitmap which `n` panes wish: the last one closes it. */
const shares = new WeakMap(); // ImageBitmap → panes left to take it
const taken = (b, n) => {
  const left = (shares.get(b) ?? n) - 1;
  if (left > 0) shares.set(b, left);
  else shares.delete(b);
  return left <= 0;
};

function wish(host, layer, list) {
  let w = lists.get(host);
  if (!w) lists.set(host, (w = { layers: new Map(), queued: false }));
  if (list) w.layers.set(layer, list);
  else w.layers.delete(layer);
  if (w.queued) return;
  w.queued = true;
  queueMicrotask(() => {
    w.queued = false;
    if (host.dead) return;
    const all = [...w.layers].sort(([a], [b]) => b.focused() - a.focused()).flatMap(([, l]) => l);
    Promise.resolve(host.call('want', [all])).catch(() => {});
  });
}

const sid = (session, surface) => `${session ?? ''}|${surface}`;

/** The tile layer of viewport `vp` on engine host `host` (src/engine/client.js EngineHost: call('want'), on('tiles' | 'layout' |
 * 'reopened')) → {slot(placement, el), stats(), destroy()}. The Viewport hands each shown surface's slot div to slot(). */
export function createTileLayer(vp, host) {
  const held = new Map(); // key → {session, surface, scale, col, row, w, h, opts, key, version, dirty, used, canvas, bw, bh, k, front}
  const slots = new Map(); // sid → the surface's slot div
  const asked = new Map(); // key → when it was first wished without a paint, for the arrival timings
  const paints = [];
  let arrived = 0;
  let wantedNow = new Map(); // key → the wanted tile, as of the last plan
  let lastWant = [];
  let lows = new Set(); // keys of the rough tiles of the last plan, shown as soon as they land
  let shown = new Set();
  let scale = 0;
  let frame = 0;
  let raf = 0;
  let sig = '';
  let force = false;
  let last = null; // the camera of the last plan, for the scroll direction
  let dir = null;
  let timer = 0; // the settle timer of a zoom change: no tile of the new scale is wished until it fires
  let settling = false;
  let dead = false;

  const schedule = () => {
    if (!dead) raf ||= requestAnimationFrame(update);
  };

  const settle = () => {
    timer = 0;
    settling = false;
    schedule();
  };

  /** Sets the size and place of held tile `h`'s canvas in its surface's slot for the zoom with `k` CSS px a point. */
  function box(h, k) {
    const s = k / h.scale; // CSS px per device px of this tile: 1 / dpr at the current scale
    Object.assign(h.canvas.style, { left: `${h.col * TILE * s}px`, top: `${h.row * TILE * s}px`, width: `${h.bw * s}px`, height: `${h.bh * s}px` });
    h.k = k;
  }

  /** The tiles on the page take the size and place of the zoom the camera has, as it lands: in the task that lays the slots out
   * for it, not in the next frame. Between the two a page is drawn with its slot at the new zoom and its tiles at the zoom before:
   * tiles off their page, beside the ones that arrive at the new zoom. */
  function fit() {
    const k = kOf(vp.camera.zoom);
    for (const h of held.values()) if (h.canvas?.parentNode && h.k !== k) box(h, k);
  }

  /** Shows held tile `h` in its surface's slot (`on`), or takes it out of the page (its pixels stay in the canvas). Tiles at the
   * current scale go above stretched ones, both under the surface's overlay layer. */
  function place(h, on) {
    const c = h.canvas;
    if (!c) return;
    const el = on && slots.get(sid(h.session, h.surface));
    if (!el) {
      if (c.parentNode) c.remove();
      return;
    }
    const k = kOf(vp.camera.zoom);
    if (h.k !== k) box(h, k);
    const front = h.scale === scale;
    if (c.parentNode === el && h.front === front) return;
    h.front = front;
    if (front) el.insertBefore(c, el.querySelector(':scope > [data-surface-overlay]'));
    else el.prepend(c);
  }

  function free(key) {
    const h = held.get(key);
    held.delete(key);
    if (!h?.canvas) return;
    h.canvas.remove();
    try {
      h.canvas.getContext('bitmaprenderer').transferFromImageBitmap(null); // its pixels go now, not at the next collection
    } catch {}
  }

  function update() {
    raf = 0;
    if (dead) return;
    // Tiles are planned for the settled camera, a zoom gesture or not: a gesture's transform stretches the world plane's tiles
    // meanwhile, and one that begins right after a zoom landed must not leave that zoom unplanned until it ends.
    const cam = vp.camera;
    const next = scaleOf(cam.zoom, devicePixelRatio);
    // A zoom change plans its tiles only once the changes stop, SETTLE_MS after the last: a burst paints the last zoom once,
    // not every step, while the page stays stretched at the new zoom's size and place. A first paint has nothing to stretch and
    // is planned at once, and a scroll with no zoom change waits for nothing.
    if (next !== scale) {
      clearTimeout(timer);
      timer = 0;
      settling = held.size > 0; // nothing held is a first paint: it has nothing to stretch, so it is planned at once
      if (settling) timer = setTimeout(settle, SETTLE_MS);
    }
    if (last && next === scale && (cam.x !== last.x || cam.y !== last.y)) dir = { x: Math.sign(cam.x - last.x), y: Math.sign(cam.y - last.y) };
    else if (next !== scale) dir = null;
    last = cam;
    scale = next;
    const kNow = kOf(cam.zoom);
    const view = { x: cam.x, y: cam.y, w: vp.size.w / kNow, h: vp.size.h / kNow }; // the settled camera's, a gesture's own view left out
    const want = wanted(vp.placements.filter((p) => !p.plain), view, scale, { dir });
    frame++;
    wantedNow = new Map(want.map((t) => [t.key, t]));
    lastWant = want;
    const r = plan(held, want);
    // Rough tiles for the visible tiles with nothing to show go first (tiles.mjs rough()); they leave once the view's own
    // tiles cover them (plan()'s covered rule) or the budget needs their room. The drop below only takes tiles not shown.
    const low = rough(held, want);
    lows = new Set(low.map((t) => t.key));
    for (const t of low) wantedNow.set(t.key, t);
    for (const k of r.drop) {
      if (wantedNow.has(k)) force = true; // the worker thinks this view holds it
      free(k);
    }
    shown = new Set(r.show);
    for (const k of shown) held.get(k).used = frame;
    for (const h of held.values()) place(h, h.scale === scale || shown.has(h.key));

    // The wishes: the rough tiles, then the wanted tiles in order, as many as the budget holds, each with the layout version
    // this view holds.
    const list = [];
    let room = BUDGET;
    for (const t of settling ? low : [...low, ...want]) {
      room -= weight(t);
      if (room < 0) break;
      const have = held.get(t.key)?.version ?? null;
      // `visible`: the tile is on screen (a rough one stands in for one that is), so an edit's own turn paints it before its batch
      // goes (worker.js flushSession); the rest follow in the next turn.
      list.push({ session: t.session, surface: t.surface, scale: t.scale, col: t.col, row: t.row, have, visible: !!t.visible || lows.has(t.key) });
      if (have == null && t.scale === scale && !asked.has(t.key)) asked.set(t.key, performance.now());
    }
    // Only a new set of tiles goes to the worker: between two, it keeps its list and repaints what a layout changes by itself.
    const keys = list.map((t) => keyOf(t));
    const s = keys.join();
    if (s !== sig || force) {
      sig = s;
      force = false;
      const now = new Set(keys);
      layer.keys = now;
      wish(host, layer, list);
      // A tile no longer wished is timed again from its next wish.
      for (const k of asked.keys()) if (!now.has(k)) asked.delete(k);
    }
  }

  /** For the harness: the visible tiles of the last plan still waiting for a current paint (their surfaces), and those with
   * nothing at all to show. Counted when asked, not at the last frame: a tile placed since shows at the next paint. */
  function tally() {
    const pending = [];
    let blank = 0;
    let vis = 0;
    for (const t of lastWant) {
      if (!t.visible) continue;
      vis++;
      const h = held.get(t.key);
      if (h && !h.dirty) continue;
      pending.push(t.surface);
      if (!h && !standIn(held, t)) blank++;
    }
    return { pending, blank, visible: vis };
  }

  /** A 'tiles' event of `session`: each tile wished by this view takes its place; a tile no view wants any more is let go. */
  function onTiles({ list }, session) {
    let any = false;
    for (const t of list ?? []) {
      const key = keyOf({ session, surface: t.surface, scale: t.scale, col: t.col, row: t.row });
      let h = held.get(key);
      const info = h ?? wantedNow.get(key);
      if (!info || (h && h.version > t.version)) {
        // A tile no view on this host wishes goes now; one another view wishes (another scale, another session) is left to it,
        // and panes this one shares it with count it as taken.
        if (t.bitmap) {
          const n = layer.keys?.has(key) ? wishCount(host, key) : 0;
          if (n > 1 ? taken(t.bitmap, n) : !wishedElsewhere(host, layer, key)) t.bitmap.close?.();
        }
        continue;
      }
      if (!h) {
        const { session: s, surface, scale: sc, col, row, w, h: ht, opts } = info;
        h = { session: s, surface, scale: sc, col, row, w, h: ht, opts, key, used: frame, canvas: null };
        held.set(key, h);
      }
      h.version = t.version;
      h.dirty = false;
      if (t.bitmap) {
        if (!h.canvas) {
          h.canvas = document.createElement('canvas');
          h.canvas.dataset.tile = `${t.col},${t.row}`;
          Object.assign(h.canvas.style, { position: 'absolute', contain: 'strict', pointerEvents: 'none' });
        }
        h.bw = t.bitmap.width;
        h.bh = t.bitmap.height;
        h.k = null;
        // The canvas's own size is the bitmap's, or it keeps 300 x 150 and shows the bitmap resampled through that.
        if (h.canvas.width !== h.bw) h.canvas.width = h.bw;
        if (h.canvas.height !== h.bh) h.canvas.height = h.bh;
        try {
          // Two panes wish this tile (View > Split): each shows a copy, and the last one closes the event's bitmap, so a repaint
          // never leaves one open.
          const n = layer.keys?.has(key) ? wishCount(host, key) : 1;
          h.canvas.getContext('bitmaprenderer').transferFromImageBitmap(n > 1 ? copyOf(t.bitmap) : t.bitmap);
          if (n > 1 && taken(t.bitmap, n)) t.bitmap.close?.();
        } catch {
          continue;
        }
      } else if (h.canvas) {
        h.canvas.remove();
        h.canvas = null;
      }
      place(h, h.scale === scale || shown.has(key) || lows.has(key));
      const at = asked.get(key);
      if (at != null) {
        asked.delete(key);
        paints.push({ page: t.surface, ms: performance.now() - at });
        if (paints.length > KEEP) paints.shift();
      }
      arrived++;
      any = true;
    }
    if (!any) return;
    // Tiles land between frames: past the budget, the plan of the last frame's wishes drops the spare ones now.
    let w = 0;
    for (const h of held.values()) w += weight(h);
    if (w > BUDGET) for (const k of plan(held, lastWant).drop) free(k);
    schedule(); // a fresh tile may cover stretched ones, which then go
  }

  /** A layout event of `session`: its tiles on the surfaces it changed show their old pixels until the worker repaints them,
   * except those its damage spared (tiles.mjs untouched), which take the new version as they are. */
  function onLayout(e, session) {
    const count = e.count ?? e.pages?.length ?? Infinity;
    for (const h of held.values()) {
      if (h.session !== session) continue;
      if (h.surface >= count) h.dirty = true;
      else if (h.surface >= e.from && h.surface < e.to) {
        if (!h.dirty && untouched(h, h.version, e)) h.version = e.version;
        else h.dirty = true;
      }
    }
    schedule();
  }

  /** A new worker opened `session` again: its layout versions start over, so every tile of it is painted again. */
  function onReopened(_d, session) {
    for (const h of held.values()) {
      if (h.session !== session) continue;
      h.dirty = true;
      h.version = -1;
    }
    force = true;
    schedule();
  }

  const offs = [host.on('tiles', onTiles), host.on('layout', onLayout), host.on('reopened', onReopened),
    vp.subscribe('camera', () => (fit(), schedule())), vp.subscribe('placements', schedule)];
  addEventListener('resize', schedule); // a move to a screen of another pixel ratio
  const layer = { focused: () => (vp.root.contains(document.activeElement) ? 1 : 0), keys: null };

  return {
    /** Surface `p`'s slot div `el` mounted (null: it went): the tiles held for it go in. */
    slot(p, el) {
      const id = sid(p.session, p.surface);
      if (!el) return void slots.delete(id);
      slots.set(id, el);
      for (const h of held.values()) if (h.session === p.session && h.surface === p.surface) place(h, h.scale === scale || shown.has(h.key));
      schedule();
    },
    /** For the harness: tiles held, their canvases and weight, the visible tiles still pending (their surfaces) and blank, every
     * tile taken in so far (`arrived`, repaints too) and each newly wished tile's time to arrive. */
    stats() {
      let w = 0;
      let canvases = 0;
      for (const h of held.values()) {
        w += weight(h);
        if (h.canvas) canvases++;
      }
      const counts = tally();
      return { held: held.size, canvases, weight: Math.round(w * 100) / 100, budget: BUDGET, scale, pending: counts.pending.length,
        unpainted: [...new Set(counts.pending)], blank: counts.blank, visible: counts.visible, arrived, paints: paints.slice() };
    },
    destroy() {
      dead = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      for (const off of offs) off();
      removeEventListener('resize', schedule);
      wish(host, layer, null);
      for (const k of [...held.keys()]) free(k);
      slots.clear();
    },
  };
}

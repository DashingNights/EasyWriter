// The viewport (docs/plans/engine/viewport-design.md sections 4.1 to 4.8): one for every format. A format host gives it placements
// (surfaces of sessions in world points) and it shows them through a camera moved by a driver (scroll.js here; a pan driver later),
// with a world plane that moves and scales with the tiles and a screen plane that never scales (overlay.jsx), its own marks and
// overlays, a focus target, and with an engine host the tiles its sessions paint (tiles.js). The root carries data-viewport, so the
// HUD and anything "centred in the view" use it.
//   const vp = createViewport(root, { sizer, host, driver, zoomRange, frames, onFocus });
//   vp.setPlacements([{ key, session, surface, x, y, w, h, paper }], { extent, more });   // world points; more: a line while
//                                                                                        // more surfaces are coming
//   vp.camera; vp.setCamera(next, { anchor });           // a zoom keeps the anchor's (client px) height, see show()
//   vp.toClient({ session, surface, x, y }); vp.rectOf(rect, 'world' | 'screen'); vp.fromClient(clientX, clientY);
//   vp.marks.set(owner, kind, items); vp.frameKinds.register(kind, C); vp.overlays.register(id, C, { plane });
//   vp.focus; vp.setFocus({ session, mode }); vp.subscribe('camera' | 'placements' | 'focus', fn); vp.destroy();
//   vp.tools.set(tool): the pointer tool that takes the surfaces' pointer until Esc (tools.jsx).
// React gets <Viewport> and useViewport() with the same object. Plain web APIs and React only: src/engine imports nothing outside it.
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cameraAt, clampZoom, kOf, snap, toScreen, toWorld, zoomAbout } from './camera.mjs';
import { createFocus, nextSession } from './focus.js';
import { createOverlays, ScreenLayer, SurfaceLayer } from './overlay.jsx';
import { bounds, find, hit, nearest, visible } from './placements.mjs';
import { scrollDriver } from './scroll.js';
import { createTileLayer } from './tiles.js';
import { createTools, ToolLayer, ToolMenu } from './tools.jsx';

const ZOOM = { min: 0.1, max: 5 }; // Documents' 10 to 500 %
const MORE_PX = 96; // the band after the last surface while more are coming (setPlacements' `more`)

/** A viewport over scroll container `root` holding `sizer`. `host`: the engine host whose sessions paint the placements' tiles
 * (src/engine/client.js EngineHost; without one the surfaces show their paper). `frames(placement)` → the placement's frames
 * ([{id, kind, x, y, w, h}] in surface points, or a promise of them), fetched again when the placement's `version` changes;
 * `onFocus(focus)` hears focus changes (the host mirrors them into the store). */
export function createViewport(root, { sizer, host = null, driver = scrollDriver, zoomRange = ZOOM, frames = null, onFocus = null,
  spacePan = null, pressFocus = true } = {}) {
  let placements = [];
  let extent = { x: 0, y: 0, w: 0, h: 0 }; // the world rect the sizer spans
  let more = null; // the host's line for surfaces still to come, shown in a band after the extent (setPlacements)
  let camera = { x: 0, y: 0, zoom: 1 };
  let gesture = null; // the camera a zoom gesture shows until it settles
  let pending = null; // {target, at}: the surface point a zoom keeps under view point `at` until the user scrolls
  let raf = 0;
  let version = 0;
  let surfaceCache = null; // the surface slots, read once a drag and dropped by each React commit of the planes
  const kept = new Set(); // keys of the placements `keep` holds drawn
  const fns = { camera: new Set(), placements: new Set(), focus: new Set() };
  const watchers = new Set(); // the React shell: anything that changes what shows
  const emit = (ev) => {
    version++;
    for (const fn of fns[ev]) fn(vp);
    for (const fn of watchers) fn();
  };
  // Scroll and resize events land once a frame.
  const later = () => {
    raf ||= requestAnimationFrame(() => {
      raf = 0;
      emit('camera');
    });
  };
  const overlayHost = createOverlays();
  const focus = createFocus(onFocus);
  focus.subscribe(() => emit('focus'));

  const size = () => ({ w: root.clientWidth, h: root.clientHeight });
  const origin = () => {
    const r = root.getBoundingClientRect();
    return { x: r.left + root.clientLeft, y: r.top + root.clientTop };
  };
  const viewOf = (cam) => {
    const s = size();
    const k = kOf(cam.zoom);
    return { x: cam.x, y: cam.y, w: s.w / k, h: s.h / k };
  };
  // The world point of surface point `t` as drawn: a surface's origin sits on a whole device pixel.
  const contentOf = (t) => {
    const p = t && find(placements, t.session, t.surface ?? t.page);
    if (!p) return null;
    const k = kOf(camera.zoom);
    return { x: snap((p.x - extent.x) * k, devicePixelRatio) + t.x * k, y: snap((p.y - extent.y) * k, devicePixelRatio) + t.y * k };
  };
  // The gesture's map from the world plane's settled CSS px to what shows: translate, then scale about the plane's origin.
  const gestureMap = () => {
    if (!gesture) return null;
    const [k, kg] = [kOf(camera.zoom), kOf(gesture.zoom)];
    return { x: (extent.x - gesture.x) * kg + (camera.x - extent.x) * k, y: (extent.y - gesture.y) * kg + (camera.y - extent.y) * k, s: kg / k };
  };
  const show = (cam, keep) => {
    if (free) return void (camera = drv.apply(cam));
    const t = keep?.target;
    const p = t && find(placements, t.session, t.surface);
    if (!p) return void (camera = drv.apply(cam));
    const c = cameraAt({ x: p.x + t.x, y: p.y + t.y }, keep.at, cam.zoom);
    // A zoom keeps the height of the point under its anchor (the pointer, else the view's centre) and, while the point's surface
    // fits across the view, centres the surface, as the DOM editor's page stays centred until it is wider than the view; from
    // there the point holds both ways.
    // ponytail: a pan driver (the whiteboard) keeps the point both ways at any size; it gets an option when it is built.
    const k = kOf(cam.zoom);
    if (keep.centre && p.w * k <= size().w) c.x = p.x + p.w / 2 - size().w / 2 / k;
    camera = drv.apply(c);
  };

  function setCamera(next, { anchor, from } = {}) {
    const base = from ?? camera;
    const zoom = clampZoom(next.zoom ?? camera.zoom, zoomRange, extent);
    let at = null;
    if (anchor) {
      const o = origin();
      at = { x: anchor.x - o.x, y: anchor.y - o.y };
    } else if (zoom !== camera.zoom && next.x == null && next.y == null) {
      const s = size();
      at = { x: s.w / 2, y: s.h / 2 }; // a zoom with no anchor keeps the view's centre
    }
    pending = free ? null : at && { target: nearest(placements, toWorld(base, at)), at, centre: true };
    gesture = null;
    show(at ? zoomAbout(base, zoom, at) : { x: next.x ?? camera.x, y: next.y ?? camera.y, zoom }, pending);
    // At once, so a host whose placements follow the zoom (Documents' rows and pad) places them before the browser paints.
    emit('camera');
  }

  /** New placements keep what the view showed: a zoom's anchor until the user scrolls, else the surface point at the view's top
   * centre. At the top the top stays: the pad above the first surface is no surface point. `opts.more`: a line saying that more
   * surfaces are coming (an engine layout not settled yet, engine-open), shown in a band MORE_PX tall after the extent, so the
   * scroll range does not end as if the list were whole. */
  function setPlacements(list, opts = {}) {
    const top = { x: size().w / 2, y: 0 };
    const keep = free ? null : pending ?? (placements.length && camera.y > extent.y + 0.01 ? { target: nearest(placements, toWorld(camera, top)), at: top } : null);
    placements = list;
    const b = bounds(list);
    extent = opts.extent ?? (free ? { x: 0, y: 0, w: 0, h: 0 } : { x: 0, y: 0, w: b ? b.x + b.w : 0, h: b ? b.y + b.h : 0 });
    more = opts.more || null;
    if (more) extent = { ...extent, h: extent.h + MORE_PX / kOf(camera.zoom) };
    const was = camera.zoom;
    // A clamp under 0.1 % is left alone: a Documents column's pad in points changes with the zoom, so chasing it would lay out
    // without end. MAX_COLUMN_PX keeps that much room under Chromium's limit.
    const z = clampZoom(camera.zoom, zoomRange, extent);
    show({ ...camera, zoom: z < was * 0.999 ? z : was }, keep);
    emit('placements');
    if (camera.zoom !== was) emit('camera');
  }

  const drv = driver(root, sizer, {
    get camera() {
      return camera;
    },
    extent: () => extent,
    clampZoom: (z) => clampZoom(z, zoomRange, extent),
    moved(cam, user) {
      camera = cam;
      if (user) pending = null;
      later();
    },
    gesture(g) {
      gesture = g;
      later();
    },
    settle: (g, client) => setCamera({ zoom: g.zoom }, { anchor: client, from: g }),
    resized: later,
    spacePan: () => spacePan?.() ?? false,
  });
  // A free driver (the pan driver) moves the world plane itself: no scroll range, and surfaces may sit at negative world points.
  const free = !!drv.free;
  if (free) sizer.style.overflow = 'visible';

  // A pointer down on a surface gives its session the focus. Object mode waits for the session's hit (engine-host).
  const onDown = (e) => {
    if (!pressFocus) return;
    const o = origin();
    if (e.clientX - o.x >= root.clientWidth || e.clientY - o.y >= root.clientHeight) return; // the scroll bars
    const { target } = vp.fromClient(e.clientX, e.clientY);
    if (target) focus.set({ session: target.session, mode: 'text' });
  };
  root.addEventListener('pointerdown', onDown);

  const vp = {
    root,
    get camera() {
      return camera;
    },
    /** The camera a zoom gesture shows until it settles, else null. */
    get gesture() {
      return gesture;
    },
    get placements() {
      return placements;
    },
    get extent() {
      return extent;
    },
    /** The host's line for surfaces still to come (setPlacements' `more`), else null. */
    get more() {
      return more;
    },
    get focus() {
      return focus.get();
    },
    /** The view's size {w, h} in CSS px, scroll bars left out: a host lays its placements out for this width. */
    get size() {
      return size();
    },
    overlayHost,
    marks: overlayHost.marks,
    frameKinds: overlayHost.frameKinds,
    overlays: overlayHost.overlays,
    frames,
    setPlacements,
    /** Moves the slots of placement `keys` by `dx`, `dy` points as a CSS transform, with no render (a drag's frames); null
     * `keys` clears every slot. */
    nudge(keys, dx, dy) {
      const on = keys && new Set(keys);
      const t = on ? `translate(${dx * kOf(camera.zoom)}px, ${dy * kOf(camera.zoom)}px)` : '';
      surfaceCache ??= [...root.querySelectorAll('[data-surface]')];
      for (const el of surfaceCache) if (!on || on.has(el.dataset.key)) el.style.transform = t;
    },
    /** The slots after a React commit of the planes: mounted, moved or unmounted since the last read. */
    clearSlots() {
      surfaceCache = null;
    },
    setCamera,
    setFocus: (f) => focus.set(f),
    /** Tab and Shift+Tab between the sessions shown (`dir` 1 or -1). */
    focusNext: (dir = 1) => focus.set({ session: nextSession(placements, focus.get().session, dir), mode: 'text' }),
    /** The world rect the view shows: the gesture's while one runs. */
    view: () => viewOf(gesture ?? camera),
    /** The placements to draw: those within a view above or below the view, so a scroll shows drawn surfaces, and the kept ones. */
    shown() {
      const v = vp.view();
      const near = visible(placements, { x: v.x - v.w, y: v.y - v.h, w: 3 * v.w, h: 3 * v.h });
      return kept.size ? [...near, ...placements.filter((p) => kept.has(p.key) && !near.includes(p))] : near;
    },
    /** Keeps the placement `key` drawn while it is out of view, until the function returned runs: a page whose canvas is being
     * edited, which a scroll would otherwise unmount with the edit. */
    keep(key) {
      kept.add(key);
      return () => {
        kept.delete(key);
        version++;
        for (const fn of watchers) fn();
      };
    },
    /** Surface point `t` in client px (as shown, a gesture included), or null when its surface has no placement. */
    toClient(t) {
      const p = t && find(placements, t.session, t.surface ?? t.page);
      if (!p) return null;
      const s = toScreen(gesture ?? camera, { x: p.x + t.x, y: p.y + t.y });
      const o = origin();
      return { x: o.x + s.x, y: o.y + s.y };
    },
    /** Surface rect `r` ({session, surface, x, y, w, h}) as a CSS box {left, top, width, height} in `plane`: 'world' in the world
     * plane's settled px (the plane's transform shows a gesture), 'screen' in the screen plane's px as shown. Null off the plane. */
    rectOf(r, plane = 'world') {
      const c = contentOf(r);
      if (!c) return null;
      const k = kOf(camera.zoom);
      const box = { left: c.x, top: c.y, width: (r.w ?? 0) * k, height: (r.h ?? 0) * k };
      const g = plane === 'screen' && gestureMap();
      return g ? { left: g.x + box.left * g.s, top: g.y + box.top * g.s, width: box.width * g.s, height: box.height * g.s } : box;
    },
    /** Client point → {world, target}: the world point and the surface point of the topmost placement under it, or null. */
    fromClient(cx, cy) {
      const o = origin();
      const world = toWorld(gesture ?? camera, { x: cx - o.x, y: cy - o.y });
      const h = hit(placements, world);
      return { world, target: h && { session: h.session, surface: h.surface, x: h.x, y: h.y } };
    },
    /** The world plane's transform during a zoom gesture → {x, y, s} (translate px, then scale about the plane's origin), or null. */
    gestureTransform: gestureMap,
    subscribe(ev, fn) {
      fns[ev].add(fn);
      return () => fns[ev].delete(fn);
    },
    /** For the React shell: hears every change of what shows; version() changes with it. */
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    version: () => version,
    destroy() {
      cancelAnimationFrame(raf);
      vp.tiles?.destroy();
      vp.tools.destroy();
      root.removeEventListener('pointerdown', onDown);
      drv.destroy();
      for (const s of Object.values(fns)) s.clear();
      watchers.clear();
    },
  };
  /** The tile layer, with a host: {slot(placement, el), stats()}. */
  vp.tiles = host ? createTileLayer(vp, host) : null;
  /** The pointer tool layer, its preview drawn over every surface of the tool's session. */
  vp.tools = createTools(vp);
  const tools = vp.tools;
  overlayHost.overlays.register('engine-tool', (p) => <ToolLayer tools={tools} session={p.session} surface={p.surface} k={p.k} />);
  overlayHost.overlays.register('engine-tool-menu', () => <ToolMenu tools={tools} />, { plane: 'screen' });
  return vp;
}

const Ctx = createContext(null);

/** The viewport of the <Viewport> around the calling component, or null outside one. */
export const useViewport = () => useContext(Ctx);

const Surface = memo(function Surface({ vp, p, k, left, top, slotStyle }) {
  const ref = useRef(null);
  const [frames, setFrames] = useState(null);
  // The frames shown: the same list read again (a key that moved no frame) sets nothing, since React renders a component once
  // more for a state set to the value it has right after a render (engine-main-thread-2: two renders per page edited).
  const had = useRef(null);
  had.current = frames;
  useLayoutEffect(() => {
    if (p.plain) return;
    vp.tiles?.slot(p, ref.current);
    return () => vp.tiles?.slot(p, null);
  }, [vp, p.session, p.surface, p.plain]);
  useEffect(() => {
    let dead = false;
    Promise.resolve(vp.frames?.(p)).then((f) => !dead && (f ?? null) !== had.current && setFrames(f ?? null), () => {});
    return () => {
      dead = true;
    };
  }, [vp, p.session, p.surface, p.version]);
  return (
    <div ref={ref} data-surface={p.surface} data-key={p.key} data-session={p.session ?? undefined}
      style={{ position: 'absolute', left, top, width: p.w * k, height: p.h * k, ...slotStyle, background: p.paper ?? slotStyle?.background }}>
      <SurfaceLayer ov={vp.overlayHost} placement={p} k={k} frames={frames} />
    </div>
  );
});

function Planes({ vp, slotStyle }) {
  useSyncExternalStore(vp.watch, vp.version);
  // A drag's frames read the surface slots once; each commit (a camera move mounting the ones it brings into view) says they
  // changed, so the next frame reads them again instead of nudging the DOM that was there before the commit.
  useLayoutEffect(() => vp.clearSlots());
  const k = kOf(vp.camera.zoom);
  const e = vp.extent;
  const dpr = devicePixelRatio;
  const g = vp.gestureTransform();
  return (
    <>
      <div data-plane="world" style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: g ? `translate(${g.x}px, ${g.y}px) scale(${g.s})` : undefined }}>
        {vp.shown().map((p) => <Surface key={p.key} vp={vp} p={p} k={k} left={snap((p.x - e.x) * k, dpr)} top={snap((p.y - e.y) * k, dpr)}
          slotStyle={p.slotStyle ?? slotStyle} />)}
        {vp.more && (
          <div data-viewport-more="" style={{ position: 'absolute', left: 0, top: e.h * k - MORE_PX, width: e.w * k, height: MORE_PX, display: 'flex',
            alignItems: 'center', justifyContent: 'center', font: '13px system-ui, sans-serif', color: 'var(--muted-foreground, #6b6b6b)' }}>
            {vp.more}
          </div>
        )}
      </div>
      <ScreenLayer vp={vp} />
    </>
  );
}

/** A viewport in React: the scroll container (data-viewport, focusable), its sizer and planes, and `children` inside with
 * useViewport(), before the sizer so a sticky bar among them stays at the top; they take no room (absolute, sticky with no height,
 * or nothing drawn). `host`: the engine host that paints the tiles, read once. `driver`: scrollDriver (the default) or panDriver, read
 * once. `spacePan()`: whether the host lets Space+drag pan (false while text is edited). `pressFocus`: whether a pointer down on a
 * surface focuses it. `slotStyle`: the style of each surface's slot div (the page shadow); a placement's `paper` is its background.
 * `onViewport(vp)` hears the viewport once made, and null when it goes. Other props (data-* and aria-* attributes) go on the root. */
export function Viewport({ host, driver, zoomRange, frames, onFocus, onViewport, spacePan, pressFocus = true, label, slotStyle, className,
  style, children, ...rest }) {
  const root = useRef(null);
  const sizer = useRef(null);
  const props = useRef(null);
  props.current = { frames, onFocus, onViewport, spacePan };
  const [vp, setVp] = useState(null);
  useLayoutEffect(() => {
    const v = createViewport(root.current, {
      sizer: sizer.current,
      host,
      driver,
      zoomRange,
      frames: (p) => props.current.frames?.(p),
      onFocus: (f) => props.current.onFocus?.(f),
      spacePan: () => props.current.spacePan?.() ?? false,
      pressFocus,
    });
    setVp(v);
    props.current.onViewport?.(v);
    return () => {
      props.current.onViewport?.(null);
      v.destroy();
    };
  }, []);
  return (
    <div ref={root} data-viewport="" {...rest} tabIndex={0} role="region" aria-label={label} className={className}
      style={{ position: 'relative', overflow: 'auto', outline: 'none', ...style }}>
      {vp && <Ctx.Provider value={vp}>{children}</Ctx.Provider>}
      <div ref={sizer} data-viewport-sizer="" style={{ position: 'relative', overflow: 'clip', minWidth: '100%', minHeight: '100%' }}>
        {vp && <Planes vp={vp} slotStyle={slotStyle} />}
      </div>
    </div>
  );
}

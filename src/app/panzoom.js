// Zoom and pan of a scrollable area holding a CSS-zoomed wrapper (the editor area and its page, §7; the flowchart library
// editor from roadmap B4).

/** Sets the CSS zoom of `wrap` (inside the scrolling `area`) to `zoom`, keeping the content point under `anchor`
 * (area-relative {x, y}; default: the centre of the view) where it was. */
export function zoomAround(area, wrap, zoom, anchor) {
  const old = Number(wrap.style.zoom) || 1;
  const a = anchor ?? { x: area.clientWidth / 2, y: area.clientHeight / 2 };
  // Content point (unzoomed px) under the anchor before the change, then scroll so it is under the anchor again. Measured
  // with client rects: offsetLeft / offsetTop of the zoomed element itself are divided by its own zoom.
  const view = area.getBoundingClientRect();
  const before = wrap.getBoundingClientRect();
  const px = (view.left + a.x - before.left) / old;
  const py = (view.top + a.y - before.top) / old;
  wrap.style.zoom = String(zoom);
  if (zoom !== old) {
    const after = wrap.getBoundingClientRect();
    area.scrollLeft += after.left + px * zoom - (view.left + a.x);
    area.scrollTop += after.top + py * zoom - (view.top + a.y);
  }
}

/** Keeps `wrap` where it sits in the view while `area` changes size (the window, the sidebar, a side pane, the chat panel).
 * The room is the area minus `insets()` ({left, right, top, bottom} px the home view keeps clear). On each axis the gaps
 * between the page and the room's edges keep their ratio: gapStart' = f * (room' - size'), f = gapStart / (gapStart + gapEnd)
 * as it was before the resize (0.5 when that sum is about 0). This holds when the page is larger than the room too (both gaps
 * negative). When the gaps have opposite signs (the page partly past one edge) f is held to 0 or 1, so one of the page's
 * edges lines up with the room's; unheld, a sum near 0 gives a ratio that throws the page far off on the next resize.
 * f is recorded whenever the page moves for another reason (a scroll, a zoom, the page growing, a Ctrl+wheel burst), never
 * from the scroll a resize itself causes (the browser clamps scrollLeft before the observer runs). `before()` runs first on a
 * resize, so a fit zoom is recomputed before the page is placed. Returns {stop, mark}: `mark()` records f at once, for a
 * placement (the home view) that a resize may follow before its scroll event arrives. */
export function keepPlace(area, wrap, insets, before = () => {}) {
  let size = null; // the area's [clientWidth, clientHeight] when f was recorded
  let f = [0.5, 0.5];
  let placed = ''; // the geometry this function last set: its own scroll events are not a move
  let frame = 0;
  const geometry = () => [area.scrollLeft, area.scrollTop, wrap.offsetWidth, wrap.offsetHeight, wrap.style.zoom, wrap.style.transform].join();
  // [gapStart, gapStart + gapEnd] per axis
  const gaps = () => {
    const [a, p, i] = [area.getBoundingClientRect(), wrap.getBoundingClientRect(), insets()];
    return [
      [p.left - a.left - i.left, area.clientWidth - i.left - i.right - p.width],
      [p.top - a.top - i.top, area.clientHeight - i.top - i.bottom - p.height],
    ];
  };
  const measure = () => {
    placed = '';
    f = gaps().map(([g, free]) => (Math.abs(free) < 2 ? 0.5 : Math.min(1, Math.max(0, g / free))));
  };
  const record = () => {
    if (size && size[0] === area.clientWidth && size[1] === area.clientHeight && geometry() !== placed) measure();
  };
  const mark = () => {
    if (!area.clientWidth || !area.clientHeight) return;
    size = [area.clientWidth, area.clientHeight];
    measure();
  };
  const ro = new ResizeObserver(() => {
    if (!area.clientWidth || !area.clientHeight) return; // hidden: keep f for when it shows again
    if (size && (size[0] !== area.clientWidth || size[1] !== area.clientHeight)) {
      before();
      const [[gx, fx], [gy, fy]] = gaps();
      area.scrollLeft += gx - f[0] * fx;
      area.scrollTop += gy - f[1] * fy;
      size = [area.clientWidth, area.clientHeight];
      placed = geometry();
      return;
    }
    size = [area.clientWidth, area.clientHeight];
    record(); // the page grew or shrank (typing, a zoom)
  });
  // A wheel zoom burst (bindPanZoom) only transforms `wrap`, which fires neither scroll nor the observer: look on the next frame.
  const wheel = (e) => {
    if (e.ctrlKey && !frame) frame = requestAnimationFrame(() => { frame = 0; record(); });
  };
  ro.observe(area);
  ro.observe(wrap);
  area.addEventListener('scroll', record, { passive: true });
  area.addEventListener('wheel', wheel, { passive: true });
  const stop = () => {
    ro.disconnect();
    cancelAnimationFrame(frame);
    area.removeEventListener('scroll', record);
    area.removeEventListener('wheel', wheel);
  };
  return { stop, mark };
}

const SETTLE_MS = 150; // a wheel pause this long ends a zoom burst

/** Middle-button drag pans `area` (within its scroll limits); Ctrl + wheel over it zooms around the pointer. During a burst
 * `wrap` is only scaled by a compositor transform, so no wheel step restyles or relays out the page however fast or far it
 * turns (each one cost a full layout, 2026-10-25); once the wheel rests, `zoomTo(percent)` applies the real zoom and the
 * page is scrolled to where the transform showed it. `preview(percent)` follows the burst (the zoom readout). */
export function bindPanZoom(area, wrap, zoomTo, preview = () => {}) {
  let panning = null;
  // {z0, s, tx, ty, left, top, timer}: the zoom before the burst, the scale and screen translation shown, and the untransformed
  // origin of `wrap` in scrolled coordinates.
  let burst = null;
  const settle = () => {
    const { z0, s, tx, ty, left, top } = burst;
    burst = null;
    const want = { x: left - area.scrollLeft + tx, y: top - area.scrollTop + ty }; // the page's origin as shown
    Object.assign(wrap.style, { transform: '', transformOrigin: '', willChange: '' });
    zoomTo(z0 * s * 100);
    const r = wrap.getBoundingClientRect();
    area.scrollLeft += r.left - want.x;
    area.scrollTop += r.top - want.y;
  };
  area.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    // About 10 % per mouse-wheel notch (deltaY 100), proportionally less for touchpad deltas.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (!burst) {
      const r = wrap.getBoundingClientRect();
      burst = { z0: Number(wrap.style.zoom) || 1, s: 1, tx: 0, ty: 0, left: r.left + area.scrollLeft, top: r.top + area.scrollTop };
      Object.assign(wrap.style, { transformOrigin: '0 0', willChange: 'transform' });
    }
    const b = burst;
    const s = Math.min(4, Math.max(0.1, b.z0 * b.s * Math.exp(-dy / 1000))) / b.z0; // 10…400 %
    // Scale by f about the pointer (px, py: relative to the untransformed origin), which stays put.
    const f = s / b.s;
    const px = e.clientX - (b.left - area.scrollLeft);
    const py = e.clientY - (b.top - area.scrollTop);
    [b.s, b.tx, b.ty] = [s, f * b.tx + px * (1 - f), f * b.ty + py * (1 - f)];
    wrap.style.transform = `translate(${b.tx / b.z0}px, ${b.ty / b.z0}px) scale(${s})`; // translate is in the zoomed px of `wrap`
    preview(b.z0 * s * 100);
    clearTimeout(b.timer);
    b.timer = setTimeout(settle, SETTLE_MS);
  }, { passive: false });
  // A resize moves the page's untransformed origin in scrolled coordinates (the area's padding follows its size): measure it
  // again, so the rest of the burst and settle() start from where the page is now.
  new ResizeObserver(() => {
    if (!burst) return;
    const r = wrap.getBoundingClientRect(); // the transformed box: its origin is the untransformed one plus (tx, ty)
    [burst.left, burst.top] = [r.left - burst.tx + area.scrollLeft, r.top - burst.ty + area.scrollTop];
  }).observe(area);
  area.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault()); // no Windows autoscroll
  area.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    panning = { id: e.pointerId, x: e.clientX, y: e.clientY };
    area.setPointerCapture(e.pointerId);
    area.classList.add('cursor-grabbing');
  });
  area.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panning.id) return;
    area.scrollBy(panning.x - e.clientX, panning.y - e.clientY);
    [panning.x, panning.y] = [e.clientX, e.clientY];
  });
  const end = (e) => {
    if (!panning || e.pointerId !== panning.id) return;
    panning = null;
    area.classList.remove('cursor-grabbing');
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
}

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

/** Middle-button drag pans `area` (within its scroll limits); Ctrl + wheel over it calls `zoomTo(percent, anchor)` around the
 * pointer, from the exact current zoom of `wrap`. */
export function bindPanZoom(area, wrap, zoomTo) {
  let panning = null;
  area.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = area.getBoundingClientRect();
    // About 10 % per mouse-wheel notch (deltaY 100), proportionally less for touchpad deltas.
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const current = (Number(wrap.style.zoom) || 1) * 100;
    zoomTo(current * Math.exp(-dy / 1000), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
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

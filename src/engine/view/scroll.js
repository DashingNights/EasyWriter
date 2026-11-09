// The scroll driver (docs/plans/engine/viewport-design.md section 4.2): a native scroll container whose sizer is the placements'
// extent at the current zoom, so scroll bars, Page Up and Down, touchpad momentum and screen reader scrolling behave as in the DOM
// editor. The camera's x and y follow scrollLeft and scrollTop. Ctrl+wheel shows the zoom as a compositor transform on the world
// plane (the viewport's gesture camera) and settles the real zoom SETTLE_MS after the last wheel event, as src/app/panzoom.js does.
// Layout snaps the tiles to device pixels under native scrolling, so this driver rounds nothing (measure.md section 6).
//
// The viewport (Viewport.jsx) hands it `vp`: {camera, extent(), clampZoom(z), moved(camera, user), gesture(camera), settle(camera,
// client point), resized()}. It returns {apply(camera) → the camera shown, destroy()}.
import { kOf, zoomAbout } from './camera.mjs';

const SETTLE_MS = 150; // a wheel pause this long ends a zoom gesture
const clamp = (v, max) => Math.min(Math.max(0, max), Math.max(0, v));

/** The camera after wheel event `ev` over the plane at `at` (CSS px from the view's top left): Ctrl+wheel or pinch (browsers send
 * pinch as a ctrlKey wheel) zooms about `at` with `clampZoom` holding the zoom in range, a plain wheel pans, and Shift+wheel pans
 * across when the browser sends no `deltaX` (a wheel mouse). Line-mode deltas count 33 px a line. Pure, so the pan driver's wheel
 * hands it the work and the node test checks it without a DOM. */
export function planeWheel(cam, ev, at, clampZoom) {
  const unit = ev.deltaMode === 1 ? 33 : 1;
  const dy = ev.deltaY * unit;
  if (ev.ctrlKey) return zoomAbout(cam, clampZoom(cam.zoom * Math.exp(-dy / 1000)), at);
  const k = kOf(cam.zoom);
  const across = ev.shiftKey && ev.deltaX === 0;
  return { x: cam.x + (across ? dy : ev.deltaX * unit) / k, y: cam.y + (across ? 0 : dy) / k, zoom: cam.zoom };
}

/** The Ctrl+wheel and pinch burst both drivers share: each wheel event shows the world plane as a gesture zoomed about the pointer,
 * and the real zoom settles SETTLE_MS after the last. `wheel(ev)` handles a zoom wheel (true) and leaves any other to the caller
 * (false); the driver destroys it with its other listeners. */
export function zoomBurst(root, vp) {
  let burst = null; // the gesture's camera while a Ctrl+wheel burst runs
  let client = null; // the pointer's client point at the burst's last wheel event
  let timer = 0;
  return {
    wheel(ev) {
      if (!ev.ctrlKey) return false;
      ev.preventDefault();
      const r = root.getBoundingClientRect();
      const at = { x: ev.clientX - r.left - root.clientLeft, y: ev.clientY - r.top - root.clientTop };
      burst = planeWheel(burst ?? vp.camera, ev, at, vp.clampZoom);
      client = { x: ev.clientX, y: ev.clientY };
      vp.gesture(burst);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const g = burst;
        burst = null;
        vp.settle(g, client);
      }, SETTLE_MS);
      return true;
    },
    /** A pan of `dx`, `dy` points while a burst runs moves the burst's camera with it, so the settle keeps the pan; with no
     * burst it does nothing (a plain wheel before any zoom is just a pan). */
    pan(dx, dy) {
      if (!burst) return;
      burst = { x: burst.x + dx, y: burst.y + dy, zoom: burst.zoom };
      vp.gesture(burst);
    },
    destroy() {
      clearTimeout(timer);
    },
  };
}

/** The scroll driver of scroll container `root` holding `sizer`, for viewport `vp`. */
export function scrollDriver(root, sizer, vp) {
  let wrote = null; // the offsets apply() set: their scroll event is not the user's
  const burst = zoomBurst(root, vp);

  const onScroll = () => {
    const left = root.scrollLeft;
    const top = root.scrollTop;
    const ours = wrote && Math.abs(left - wrote.left) < 1 && Math.abs(top - wrote.top) < 1;
    wrote = null;
    const e = vp.extent();
    const k = kOf(vp.camera.zoom);
    vp.moved({ x: e.x + left / k, y: e.y + top / k, zoom: vp.camera.zoom }, !ours);
  };

  const onWheel = (ev) => {
    burst.wheel(ev);
  };

  const ro = new ResizeObserver(() => vp.resized());
  ro.observe(root);
  root.addEventListener('scroll', onScroll, { passive: true });
  root.addEventListener('wheel', onWheel, { passive: false });

  return {
    /** Sizes the sizer for `cam`'s zoom and scrolls to it, held to the scroll range → the camera now shown. */
    apply(cam) {
      const e = vp.extent();
      const k = kOf(cam.zoom);
      sizer.style.width = `${e.w * k}px`;
      sizer.style.height = `${e.h * k}px`;
      const left = clamp((cam.x - e.x) * k, root.scrollWidth - root.clientWidth);
      const top = clamp((cam.y - e.y) * k, root.scrollHeight - root.clientHeight);
      if (Math.abs(root.scrollLeft - left) >= 0.5 || Math.abs(root.scrollTop - top) >= 0.5) {
        root.scrollLeft = left;
        root.scrollTop = top;
        wrote = { left: root.scrollLeft, top: root.scrollTop };
      }
      return { x: e.x + root.scrollLeft / k, y: e.y + root.scrollTop / k, zoom: cam.zoom };
    },
    destroy() {
      burst.destroy();
      ro.disconnect();
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('wheel', onWheel);
    },
  };
}

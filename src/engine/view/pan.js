// The pan driver (docs/plans/board/design.md section 3): an infinite plane with no scroll bars. The wheel pans, Ctrl+wheel and
// pinch zoom about the pointer (the burst scroll.js shares), the middle button and Space+drag pan, and one compositor transform on
// the sizer moves the world plane, so a pan never lays anything out again. The camera is the world point at the view's top left,
// held so the view stays within plus or minus PLANE points.
//
// The viewport (Viewport.jsx) hands it `vp`: {camera, extent(), clampZoom(z), moved(camera, user), gesture(camera), settle(camera,
// client point), resized(), spacePan()}. It returns {free: true, apply(camera) → the camera shown, destroy()}, as scroll.js does.
import { kOf, snap } from './camera.mjs';
import { planeWheel, zoomBurst } from './scroll.js';

export { planeWheel };

/** The plane reaches this far either way from the world origin, in points: nothing else bounds a view with no scroll container. */
export const PLANE = 500000;

/** `v` held so a view `span` points long stays inside the plane. */
const hold = (v, span) => Math.min(Math.max(-PLANE, PLANE - span), Math.max(-PLANE, v));

/** The pan driver of `root` holding `sizer`, for viewport `vp`. */
export function panDriver(root, sizer, vp) {
  const burst = zoomBurst(root, vp);
  let drag = null; // {id, x, y}: the pointer at its last move, while a middle or Space+drag pan runs
  let space = false; // Space is down and vp.spacePan() says the host is not editing text

  root.style.overflow = 'hidden';

  const apply = (cam) => {
    const e = vp.extent();
    const k = kOf(cam.zoom);
    const next = { x: hold(cam.x, root.clientWidth / k), y: hold(cam.y, root.clientHeight / k), zoom: cam.zoom };
    sizer.style.transform = `translate(${snap(-(next.x - e.x) * k, devicePixelRatio)}px, ${snap(-(next.y - e.y) * k, devicePixelRatio)}px)`;
    return next;
  };

  const onWheel = (ev) => {
    ev.preventDefault(); // a wheel over an overlay control still pans; a portalled popover has its own
    if (burst.wheel(ev)) return;
    const cam = apply(planeWheel(vp.camera, ev));
    burst.pan(cam.x - vp.camera.x, cam.y - vp.camera.y); // a pan between two zoom wheel events stays when the burst settles
    vp.moved(cam, true);
  };

  const onDown = (ev) => {
    if (ev.button !== 1 && !(ev.button === 0 && space)) return;
    ev.preventDefault();
    drag = { id: ev.pointerId, bits: ev.buttons || (ev.button === 1 ? 4 : 1), x: ev.clientX, y: ev.clientY };
    try {
      root.setPointerCapture(ev.pointerId);
    } catch {}
  };

  const end = () => {
    const d = drag;
    drag = null;
    if (d && root.hasPointerCapture?.(d.id)) root.releasePointerCapture(d.id);
    root.style.cursor = space ? 'grab' : '';
  };

  const onMove = (ev) => {
    if (ev.pointerId !== drag?.id) return;
    if (!(ev.buttons & drag.bits)) return end(); // the release was lost (outside the window, say)
    const k = kOf(vp.camera.zoom);
    const cam = { x: vp.camera.x - (ev.clientX - drag.x) / k, y: vp.camera.y - (ev.clientY - drag.y) / k, zoom: vp.camera.zoom };
    drag = { ...drag, x: ev.clientX, y: ev.clientY };
    vp.moved(apply(cam), true);
  };

  const onUp = (ev) => {
    if (ev.pointerId === drag?.id) end();
  };

  const onLost = (ev) => {
    if (ev.pointerId === drag?.id) end();
  };

  // A middle press must not start Chromium's autoscroll.
  const onMouseDown = (ev) => {
    if (ev.button === 1) ev.preventDefault();
  };

  const onKeyDown = (ev) => {
    if (ev.code !== 'Space') return;
    if (drag) ev.preventDefault(); // while a Space+drag pan runs, Space does nothing else
    if (space || !vp.spacePan()) return;
    space = true;
    root.style.cursor = 'grab';
  };

  const onKeyUp = (ev) => {
    if (ev.code !== 'Space' || !space) return;
    space = false;
    if (!drag) root.style.cursor = '';
  };

  // Space must not stay held when the focus leaves the viewport: the root's own blur does not fire for a focused child's, and no
  // keyup arrives once the window loses focus.
  const onBlur = () => {
    space = false;
    if (!drag) root.style.cursor = '';
  };
  const onFocusOut = (ev) => {
    if (!root.contains?.(ev.relatedTarget)) onBlur();
  };

  const ro = new ResizeObserver(() => vp.resized());
  ro.observe(root);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);
  root.addEventListener('lostpointercapture', onLost);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('keyup', onKeyUp);
  root.addEventListener('focusout', onFocusOut);
  globalThis.addEventListener?.('blur', onBlur);

  return {
    free: true,
    apply,
    destroy() {
      burst.destroy();
      ro.disconnect();
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
      root.removeEventListener('lostpointercapture', onLost);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('keyup', onKeyUp);
      root.removeEventListener('focusout', onFocusOut);
      globalThis.removeEventListener?.('blur', onBlur);
      root.style.cursor = '';
    },
  };
}

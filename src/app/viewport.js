// The shown page's viewport (SPEC §7g): the area where its content is viewed and edited, marked [data-viewport] — the editor
// page's #editor-area, the library editor's #flow-area (beside the shape panel), the library list's and the plan's page below
// its header row. What is centred "in the view" is centred in it, never in the window.
import { useLayoutEffect, useState } from 'react';
import { dismissOnly } from '../whiteboard.js';
import { afterSlide } from './sliding.js';
import { useStore } from './store.js';

/** The working viewport's client rect {left, top, right, bottom, width, height} and its element `el`: the last [data-viewport] in
 * document order (a workspace's after the editor page hidden behind it, a nested mark after its page's), below a header row it
 * contains and inside the strips chrome marks [data-viewport-inset="left" | "right" | "top" | "bottom"] (a Document's vertical
 * ruler, on the DOM editor and on a canvas draft), so the HUD and the islands placed by it keep clear of them (the user,
 * 2026-10-28 and 2026-11-01). `raw`: the whole viewport, for that chrome itself. */
export function viewportRect(raw = false) {
  // A viewport a module's slot mounts over the editor area (the canvas page area) sits in that slot's raw box: raw measures skip
  // it, or the slot would measure itself and stop following the editor area.
  const el = [...document.querySelectorAll('[data-viewport]')].filter((v) => !raw || !v.closest('[data-viewport-slots]')).at(-1);
  const r = el.getBoundingClientRect();
  let top = el.querySelector(':scope > header')?.getBoundingClientRect().bottom ?? r.top;
  let { left, right, bottom } = r;
  // Every strip over the viewport that marks the edge it holds counts the same way, whichever chrome draws it, so what is placed
  // by this box follows the strip's measured size rather than an offset for one kind of chrome.
  if (!raw) for (const s of document.querySelectorAll('[data-viewport-inset]')) {
    const o = s.getBoundingClientRect();
    if (!o.width || !o.height || o.right <= r.left || o.left >= r.right || o.bottom <= r.top || o.top >= r.bottom) continue;
    const side = s.dataset.viewportInset;
    if (side === 'left') left = Math.max(left, o.right);
    else if (side === 'right') right = Math.min(right, o.left);
    else if (side === 'top') top = Math.max(top, o.bottom);
    else if (side === 'bottom') bottom = Math.min(bottom, o.top);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top, el };
}

/** For a [data-viewport-inset] strip's component: announces the strip while `shown` and again when it goes. */
export function useViewportInset(shown) {
  useLayoutEffect(() => {
    if (!shown) return undefined;
    insetChanged();
    return insetChanged;
  }, [shown]);
}

/** Keeps `--px` on the root at one device pixel (1px / devicePixelRatio) while the display scale is a fraction (125 %, 150 %),
 * for app.css's islands, whose spacing snaps to it; unset at a whole scale. It follows a move to another monitor and the UI scale. */
export function trackDevicePixel() {
  const set = () => {
    const k = devicePixelRatio;
    if (Number.isInteger(k)) document.documentElement.style.removeProperty('--px');
    else document.documentElement.style.setProperty('--px', `${1 / k}px`);
    matchMedia(`(resolution: ${k}dppx)`).addEventListener('change', set, { once: true });
  };
  set();
}

/** A [data-viewport-inset] strip came or went: the viewport boxes measure again. */
export const insetChanged = () => dispatchEvent(new Event('viewportinset'));

/** A primary pointer-down on a view's empty background (§7 Background clicks): the target passes `isBackground`, the press is
 * not on the target's own scrollbar and does not only close an open popup (§6c Dismiss-only clicks) → true. */
export function backgroundClick(e, isBackground) {
  const t = e.target;
  if (e.button !== 0 || !(t instanceof Element) || !isBackground(t)) return false;
  const r = t.getBoundingClientRect();
  const k = r.width / t.offsetWidth || 1; // a CSS-zoomed target (the editor's page)
  if ((e.clientX - r.left) / k - t.clientLeft >= t.clientWidth || (e.clientY - r.top) / k - t.clientTop >= t.clientHeight) return false;
  return !dismissOnly(e);
}

/** The working viewport's box (`raw`: the whole one; viewportRect) {left, top, width, height, right, bottom, scrollbar} relative
 * to the main column's area while `on`, following its resizes and its inset strips; right and bottom are its gaps to the area's right and bottom edges, which hold while the sidebar opens
 * or closes (so a thing placed by them stays put in the frame before the next measure); `scrollbar` is the px its vertical
 * scrollbar takes at the right edge. */
export function useViewportBox(on, raw = false) {
  const view = useStore((s) => s.view);
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    if (!on) return undefined;
    const area = document.querySelector('main > div');
    // The viewport measured is observed, not the one found at setup, and so is the modules' slot box (App.jsx ViewportSlots): a
    // slot's viewport (a canvas draft's page area) and the inset strips in a slot (the vertical ruler) take their new place a
    // render after the editor area's resize, so a box measured off that resize alone kept the place from before a pane, ruler or
    // view opened or closed (app-island-return). A viewport that goes reports a 0 size, and the next one is observed then.
    const seen = new Map();
    const track = (key, el) => {
      const was = seen.get(key);
      if (was === el) return;
      if (was) ro.unobserve(was);
      if (el) ro.observe(el);
      seen.set(key, el);
    };
    const measure = () => {
      if (afterSlide(measure)) return; // the sidebar's slide keeps the box right relative to the area (sliding.js)
      const v = viewportRect(raw);
      track('viewport', v.el);
      if (!raw) track('slots', document.querySelector('[data-viewport-slots]'));
      if (!raw) for (const s of document.querySelectorAll('[data-viewport-inset]')) ro.observe(s); // a strip that changes size
      const a = area.getBoundingClientRect();
      setBox({ left: v.left - a.left, top: v.top - a.top, width: v.width, height: v.height, right: a.right - v.right, bottom: a.bottom - v.bottom,
        scrollbar: v.el.offsetWidth - v.el.clientWidth - 2 * v.el.clientLeft });
    };
    const ro = new ResizeObserver(() => measure());
    ro.observe(area);
    measure();
    addEventListener('viewportinset', measure);
    return () => {
      ro.disconnect();
      removeEventListener('viewportinset', measure);
    };
  }, [on, view, raw]);
  return on ? box : null;
}

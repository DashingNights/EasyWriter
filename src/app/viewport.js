// The shown page's viewport (SPEC §7g): the area where its content is viewed and edited, marked [data-viewport] — the editor
// page's #editor-area, the library editor's #flow-area (beside the shape panel), the library list's and the plan's page below
// its header row. What is centred "in the view" is centred in it, never in the window.
import { useLayoutEffect, useState } from 'react';
import { dismissOnly } from '../whiteboard.js';
import { useStore } from './store.js';

/** The viewport's client rect {left, top, right, bottom, width, height} and its element `el`: the last [data-viewport] in document order (a
 * workspace's after the editor page hidden behind it, a nested mark after its page's), below a header row it contains. */
export function viewportRect() {
  const el = [...document.querySelectorAll('[data-viewport]')].at(-1);
  const r = el.getBoundingClientRect();
  const top = el.querySelector(':scope > header')?.getBoundingClientRect().bottom ?? r.top;
  return { left: r.left, top, right: r.right, bottom: r.bottom, width: r.width, height: r.bottom - top, el };
}

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

/** The viewport's box {left, top, width, height} relative to the main column's area while `on`, following its resizes. */
export function useViewportBox(on) {
  const view = useStore((s) => s.view);
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    if (!on) return undefined;
    const area = document.querySelector('main > div');
    const measure = () => {
      const v = viewportRect();
      const a = area.getBoundingClientRect();
      setBox({ left: v.left - a.left, top: v.top - a.top, width: v.width, height: v.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of [area, viewportRect().el]) ro.observe(el);
    return () => ro.disconnect();
  }, [on, view]);
  return on ? box : null;
}

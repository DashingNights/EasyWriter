import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DELAY = 700; // ms the pointer rests on an object before its hint shows
const SLOP = 4; // px the pointer may drift while resting
const TOP = 34; // the title strip

// The hint for element `t` in the document: a smart canvas, plan chart or whiteboard (each NodeView's hint(): what a click
// and a double-click do, null once it is selected or in use); null elsewhere.
function hintAt(t) {
  const el = t instanceof Element && t.closest('.ProseMirror') ? t.closest('.sc, .pc, .wb') : null;
  const v = el && (el.scView ?? el.pcView ?? el.wbView);
  return v?.hint?.(t) ?? null;
}

/** §6b hover hint (one instance in App): the pointer resting on a document object shows what a click and a double-click do,
 * just below-right of the pointer, kept inside the window and below the title strip. Click-through; any move beyond a few
 * px, pointer down, wheel, scroll, key press or leaving the window hides it. */
export function HoverHint() {
  const [hint, setHint] = useState(null); // {text, x, y}
  const ref = useRef(null);

  useEffect(() => {
    let timer = 0;
    let at = null; // where the pointer came to rest over an object
    let shown = false;
    const hide = () => {
      clearTimeout(timer);
      at = null;
      if (shown) setHint((shown = null));
    };
    const move = (e) => {
      if (at && Math.hypot(e.clientX - at.x, e.clientY - at.y) <= SLOP) return;
      hide();
      if (e.buttons || e.pointerType === 'touch' || !hintAt(e.target)) return;
      const p = (at = { x: e.clientX, y: e.clientY });
      timer = setTimeout(() => {
        const text = hintAt(document.elementFromPoint(p.x, p.y)); // its state now (selected, being edited)
        if (text) setHint((shown = { text, ...p }));
      }, DELAY);
    };
    const out = (e) => e.relatedTarget || hide(); // the pointer left the window
    const on = [['pointermove', move], ['pointerout', out], ['pointerdown', hide], ['wheel', hide], ['scroll', hide], ['keydown', hide], ['blur', hide]];
    for (const [type, fn] of on) window.addEventListener(type, fn, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      for (const [type, fn] of on) window.removeEventListener(type, fn, { capture: true });
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    let [x, y] = [hint.x + 14, hint.y + 22]; // clear of the pointer
    if (x + w > innerWidth - 8) x = Math.max(8, innerWidth - 8 - w);
    if (y + h > innerHeight - 8) y = hint.y - 8 - h;
    Object.assign(el.style, { left: `${x}px`, top: `${Math.max(TOP + 4, y)}px` });
  }, [hint]);

  if (!hint) return null;
  // The shared tooltip look (components/ui/tooltip.jsx).
  return (
    <div ref={ref} role="tooltip" data-hover-hint=""
      className="pointer-events-none fixed z-50 w-fit max-w-xs animate-in fade-in-0 rounded-md bg-foreground/80 px-3 py-1.5 text-xs text-balance text-background backdrop-blur-sm">
      {hint.text}
    </div>
  );
}

// What input draws over a viewport (viewport-design.md section 4.5): the selection's rectangles in the world plane, where they
// scale with the pages, and the caret and an input method's composition underlines in the screen plane, where they keep their
// size at any zoom and follow a zoom gesture. Both read `input`, viewport.js's handle on the focused session's input:
// subscribe(fn) and snapshot() → {session, focused, caret, rects, comp}, in surface points. Pages are paper, so the caret and
// underlines are black on white in either theme, as in Word. Plain createElement (no JSX), so the Node tests load viewport.js.
import { createElement as h, Fragment, useEffect, useRef, useSyncExternalStore } from 'react';

const BLINK = 530; // ms, the Windows default caret blink
const at = (b) => ({ position: 'absolute', left: b.left, top: b.top, pointerEvents: 'none' });

function Caret({ box }) {
  const ref = useRef(null);
  // Restarted on every move, so the caret shows while the user types or moves it, then blinks.
  useEffect(() => {
    const el = ref.current;
    if (!el?.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const a = el.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
      { duration: 2 * BLINK, iterations: Infinity, delay: BLINK });
    return () => a.cancel();
  }, [box.left, box.top, box.height]);
  return h('div', { ref, 'data-engine-caret': '', style: { ...at(box), width: 1, height: box.height, background: '#000' } });
}

/** The world plane's layer over surface `surface` of `session` at `k` CSS px a point: the focused session's selection, over Reading
 * Highlight's matches (Mark, yellow by default, as Word marks them). A column selection's rectangles are its block rows, so it
 * draws as a block. */
export function SelectionLayer({ input, session, surface, k }) {
  // What this surface draws, kept while it is the same: a caret move (every key) leaves the layers of every page it has no
  // rectangle on as they are (engine-main-thread-2).
  const mine = useRef(null);
  const s = useSyncExternalStore(input.subscribe, () => {
    const all = input.snapshot();
    const on = (r) => r.page === surface;
    const next = all.session == null || all.session !== session ? null : { found: (all.found ?? []).filter(on), rects: all.rects.filter(on) };
    const key = JSON.stringify(next);
    if (mine.current?.key !== key) mine.current = { key, next };
    return mine.current.next;
  });
  if (!s) return null;
  const box = (r) => ({ position: 'absolute', left: r.x * k, top: r.y * k, width: r.w * k, height: r.h * k, mixBlendMode: 'multiply', pointerEvents: 'none' });
  return h(Fragment, null,
    s.found.map((r, i) => h('div', { key: `f${i}`, 'data-engine-found': '', style: { ...box(r), background: 'Mark' } })),
    s.rects.map((r, i) => h('div', { key: i, 'data-engine-selection': '', style: { ...box(r), background: 'Highlight', opacity: 0.35 } })));
}

/** The screen plane's layer of viewport `viewport`: the focused session's caret and composition underlines, placed by
 * viewport.rectOf at their surface points and drawn at screen size (a 1 px caret, 1 or 2 px underlines). */
export function CaretLayer({ input, viewport: vp }) {
  const s = useSyncExternalStore(input.subscribe, input.snapshot);
  if (s.session == null) return null;
  const box = (b, w = b.w ?? 0) => vp.rectOf({ session: s.session, surface: b.page, x: b.x, y: b.y, w, h: b.h ?? 0 }, 'screen');
  // Both panes of a split show the caret at the session's point: each draws it for the session it holds the focus for, whether
  // or not the focus is in its own DOM. Word shows no caret over a selection.
  const shown = s.focused || vp.focus.session === s.session;
  const caret = shown && s.caret && !s.rects.length && box(s.caret, 0);
  return h(Fragment, null,
    s.comp.map((u, i) => {
      const b = box({ ...u, h: 0 });
      if (!b) return null;
      const w = u.thick ? 2 : 1;
      return h('div', { key: i, 'data-engine-composition': '', 'data-thick': u.thick ? '' : undefined, style: { ...at(b), top: b.top - w,
        width: b.width, height: 0, borderBottom: `${w}px ${u.style === 'wavy' ? 'dotted' : u.style} #000` } });
    }),
    caret && h(Caret, { box: caret }));
}

// Input on a viewport (docs/plans/engine/viewport-design.md sections 4.7 and 6, P9): typing, keys, the pointer and the clipboard
// on the viewport's root go to the session that has the viewport's focus, in any viewport and for any number of sessions on it.
// The viewport answers which surface point a client point is on and back, scrolls the caret into view and a drag past its edge
// through its camera, and draws what input shows in its own overlay planes (layer.js). When the focus moves to another session,
// input moves with it: a new EditContext on the same root, which makes the input method end its composition in the old one
// and start the next in the new one, as the user's hand check of 2026-10-31 found (measure.md, "EditContext switch"). The input
// method leaves that unfinished composition (Changjie's radicals) in the draft it leaves, so it is removed there.
// ponytail: whether Word commits an unfinished composition when the focus moves to another document was not checked here (it
// needs a real input method); input-checklist.md asks the user. If Word commits it, aim() destroys without `drop`.
import { createElement } from 'react';
import { kOf } from '../view/camera.mjs';
import { nearest, worldOf } from '../view/placements.mjs';
import { attachInput } from './index.js';
import { CaretLayer, SelectionLayer } from './layer.js';

const MARGIN = 24; // px kept between a revealed caret and the view's edge

/** The input handle of the session that last took a viewport's text focus (attachInput's handle), for the keys that need the
 * view (Ctrl+Alt+PageUp and PageDown: windowEdge); null with none. */
export const focusedInput = { current: null };
const NONE = Object.freeze({ session: null, focused: false, caret: null, rects: [], comp: [] });

/** The camera {x, y} that shows world rect `r` ({x, y, h}) with `margin` points round it in view `v` ({x, y, w, h} points),
 * moving as little as it can → null when it shows already. */
export function revealCamera(v, r, margin) {
  let { x, y } = v;
  if (r.y - margin < y) y = r.y - margin;
  else if (r.y + r.h + margin > y + v.h) y = r.y + r.h + margin - v.h;
  if (r.x - margin < x) x = r.x - margin;
  else if (r.x + margin > x + v.w) x = r.x + margin - v.w;
  return x === v.x && y === v.y ? null : { x, y };
}

/**
 * Input on viewport `vp` (src/engine/view/Viewport.jsx) → destroy(). `clientOf(session)` → the SessionClient of a session the
 * viewport shows, or null for one that takes no text input. `keymap`: the focused kind's keys (keys.mjs createKeymap, from the
 * host). `clipboard`, `pasteHtml` and `pasteFiles`: as attachInput takes. The focused session's input handle is on destroy.input (null without
 * one): the ribbon's copy, cut and paste, the harness's timings.
 */
export function inputOnViewport(vp, { clientOf, keymap, clipboard, pasteHtml, pasteFiles, editContext, takes }) {
  const fns = new Set();
  let cur = null; // {client, input, off}: the focused session's input
  let snap = NONE;
  const notify = () => {
    snap = cur ? { session: cur.client.id, ...cur.input.snapshot() } : NONE;
    for (const fn of fns) fn();
  };
  const shown = { subscribe: (fn) => (fns.add(fn), () => fns.delete(fn)), snapshot: () => snap };

  /** attachInput's viewport side for session `id`. */
  const through = (id) => ({
    // The nearest surface of this session: a click in the gap between pages lands on the nearest page.
    locate(cx, cy) {
      const t = nearest(vp.placements.filter((p) => p.session === id), vp.fromClient(cx, cy).world);
      return t && { page: t.surface, x: t.x, y: t.y };
    },
    toClient: (page, x, y) => vp.toClient({ session: id, surface: page, x, y }) ?? { x: 0, y: 0 },
    // Keys and typing keep the caret in view, as Word scrolls to it.
    reveal(c) {
      const w = c && worldOf(vp.placements, { session: id, surface: c.page, x: c.x, y: c.y });
      const k = kOf(vp.camera.zoom);
      const to = w && revealCamera({ ...vp.camera, w: vp.size.w / k, h: vp.size.h / k }, { ...w, h: c.h }, MARGIN / k);
      if (to) vp.setCamera(to);
    },
    scrollBy(dx, dy) {
      const k = kOf(vp.camera.zoom);
      vp.setCamera({ x: vp.camera.x + dx / k, y: vp.camera.y + dy / k });
    },
    // The first (or, with `end`, last) of this session's pages in view and the part of it in view: {page, top, bottom} in points.
    edge(end) {
      const k = kOf(vp.camera.zoom);
      const top = vp.camera.y;
      const bottom = top + vp.size.h / k;
      const shown = vp.placements.filter((p) => p.session === id && p.y < bottom && p.y + p.h > top).sort((a, b) => a.y - b.y);
      const p = end ? shown.at(-1) : shown[0];
      return p ? { page: p.surface, top: Math.max(0, top - p.y), bottom: Math.min(p.h, bottom - p.y) } : null;
    },
  });

  function aim() {
    const f = vp.focus;
    const client = f.session != null && f.mode === 'text' ? clientOf(f.session) ?? null : null;
    if (client === (cur?.client ?? null)) return;
    if (cur) {
      cur.off();
      cur.input.destroy({ drop: true });
      if (focusedInput.current === cur.input) focusedInput.current = null;
    }
    cur = null;
    if (client) {
      const input = attachInput(vp.root, { client, keymap, clipboard, pasteHtml, pasteFiles, editContext, takes, ...through(client.id) });
      cur = { client, input, off: input.subscribe(notify) };
      destroy.input = input;
      focusedInput.current = input;
    } else destroy.input = null;
    notify();
  }

  // The last pane to mount holds focusedInput: a split's two panes are one session, and the keys that need the view (windowEdge)
  // read the pane whose focus is in it.
  const claim = () => {
    if (cur) focusedInput.current = cur.input;
  };
  vp.root.addEventListener('focusin', claim);

  const offs = [
    vp.subscribe('focus', aim),
    // A scroll or zoom moves the caret on screen: the candidate window follows, and a composition carries on.
    vp.subscribe('camera', () => cur?.input.place()),
    vp.subscribe('placements', () => cur?.input.place()),
  ];
  vp.overlays.register('engine-input', (p) => createElement(SelectionLayer, { ...p, input: shown }));
  vp.overlays.register('engine-input-caret', (p) => createElement(CaretLayer, { ...p, input: shown }), { plane: 'screen' });
  function destroy() {
    for (const off of offs) off();
    vp.root.removeEventListener('focusin', claim);
    vp.overlays.register('engine-input', null);
    vp.overlays.register('engine-input-caret', null);
    // Not dropped: the host releases the session as it goes, and a call after its close would open it again.
    cur?.off();
    cur?.input.destroy();
    if (focusedInput.current === cur?.input) focusedInput.current = null;
    cur = null;
    destroy.input = null;
  }
  destroy.input = null;
  aim();
  return destroy;
}

import { edgeSpeed } from '../../../whiteboard.js';
import { dropTarget } from './drag.mjs';

// Pointer drag of Board cards (Gantt plan §6.3; the sidebar's dragRow pattern, no OS drag and drop): it starts after 4 px of
// movement, so a click stays a click; the click that ends a drag does nothing. Cards are `[data-card]` elements and columns
// `[data-column]` ones ('' = "No status"), both carrying data-column.

const col = (v) => (v === '' ? null : v);

/** From a card's pointerdown: drags the cards `ids`; `onMove(target)` while dragging with the drop target under the
 * pointer ({column, beforeId} | null, drag.mjs), `onDrop(target)` once it ends. `scroller` scrolls sideways near its edges. */
export function startDrag(e, { ids, scroller, onMove, onDrop }) {
  if (e.button !== 0 || e.target.closest('button, input, textarea, a, [role=menuitem]')) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let x = x0;
  let y = y0;
  let moved = false;
  let target = null;
  let frame = 0;
  const locate = () => {
    const cards = [...document.querySelectorAll('[data-card]')].filter((el) => !ids.includes(el.dataset.card))
      .map((el) => ({ id: el.dataset.card, column: col(el.dataset.column), rect: el.getBoundingClientRect() }));
    const columns = [...document.querySelectorAll('[data-column]:not([data-card])')].map((el) => ({ id: col(el.dataset.column), rect: el.getBoundingClientRect() }));
    target = dropTarget(cards, columns, x, y);
    onMove(target);
  };
  // Auto-scroll of the column strip while the pointer is near (or past) its left or right edge.
  const tick = () => {
    const r = scroller.getBoundingClientRect();
    const by = edgeSpeed(r.right - x) - edgeSpeed(x - r.left);
    if (by) {
      scroller.scrollLeft += by;
      locate();
    }
    frame = requestAnimationFrame(tick);
  };
  const move = (ev) => {
    x = ev.clientX;
    y = ev.clientY;
    if (!moved && Math.hypot(x - x0, y - y0) <= 4) return;
    if (!moved) frame = requestAnimationFrame(tick);
    moved = true;
    locate();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    cancelAnimationFrame(frame);
    if (!moved) return;
    const swallow = (c) => c.stopPropagation();
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true));
    onDrop(target);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

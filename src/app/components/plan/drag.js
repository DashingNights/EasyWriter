import { edgeSpeed } from '../../../whiteboard.js';
import { dispatch } from '../../plans.js';
import { getState } from '../../store.js';
import { dropTarget } from './drag.mjs';

// Pointer drag of Board cards (Gantt plan §6.3; the sidebar's dragRow pattern, no OS drag and drop): it starts after 4 px of
// movement, so a click stays a click; the click that ends a drag does nothing. Cards are `[data-card]` elements and columns
// `[data-column]` ones ('' = "No status"), both carrying data-column.
// The ticket rows of the Backlog and the Gantt task list reorder the same way (dragRows, shiftRows).

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

/** Moves the sibling tickets `moving` one place up (-1) or down (1) among their siblings (Backlog and Gantt Shift+↑/↓). */
export function shiftRows(plan, moving, by) {
  const parentOf = (id) => plan.tickets.find((t) => t.id === id).parent;
  const sibs = plan.order.filter((id) => parentOf(id) === parentOf(moving[0]));
  const other = sibs[by < 0 ? sibs.indexOf(moving[0]) - 1 : sibs.indexOf(moving.at(-1)) + 1];
  if (other && !moving.includes(other)) dispatch('plan.tickets.reorder', { planId: plan.id, ticketIds: moving, ...(by < 0 ? { beforeId: other } : { afterId: other }) });
}

/** Drag of ticket rows (the Backlog handle, a Gantt task-list row), from its pointerdown: the ticket `id`, with the selected
 * tickets when it is one of them and they are siblings, after 4 px. Rows are the elements with the attribute `attr` (= the
 * ticket id) in `scroller`, which scrolls near its top and bottom edges; `ids` is their order. A drop on a sibling's row is one
 * `plan.tickets.reorder` (before it in its top half); with Alt held, on any other row it makes that row the parent.
 * `onMove({ids, target: {id, before} | {id, parent: true} | null} | null)` shows the drag (null once it ends). */
export function dragRows(e, plan, id, { ids, scroller, attr, onMove }) {
  const ticketOf = (x) => plan.tickets.find((t) => t.id === x);
  const { parent } = ticketOf(id);
  const cur = getState().planUi.selection;
  const moving = cur.includes(id) && cur.every((x) => ticketOf(x)?.parent === parent) ? ids.filter((x) => cur.includes(x)) : [id];
  const below = new Set(moving);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of plan.tickets) if (!below.has(x.id) && below.has(x.parent)) grew = below.add(x.id);
  }
  const y0 = e.clientY;
  let y = y0;
  let alt = false;
  let moved = false;
  let target = null;
  let frame = 0;
  const locate = () => {
    const els = [...scroller.querySelectorAll(`[${attr}]`)].filter((el) => !moving.includes(el.getAttribute(attr)));
    const hit = els.find((el) => y < el.getBoundingClientRect().bottom) ?? els.at(-1);
    const at = hit?.getAttribute(attr);
    const r = hit?.getBoundingClientRect();
    if (!at) target = null;
    else if (alt) target = below.has(at) ? null : { id: at, parent: true };
    else target = ticketOf(at).parent === parent ? { id: at, before: y < (r.top + r.bottom) / 2 } : null;
    onMove({ ids: moving, target });
  };
  const tick = () => {
    const r = scroller.getBoundingClientRect();
    const by = edgeSpeed(r.bottom - y) - edgeSpeed(y - r.top);
    if (by) {
      scroller.scrollTop += by;
      locate();
    }
    frame = requestAnimationFrame(tick);
  };
  const move = (ev) => {
    y = ev.clientY;
    alt = ev.altKey;
    if (!moved && Math.abs(y - y0) <= 4) return;
    if (!moved) frame = requestAnimationFrame(tick);
    moved = true;
    locate();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    cancelAnimationFrame(frame);
    onMove(null);
    if (!moved || !target) return;
    if (target.parent) dispatch('plan.tickets.update', { planId: plan.id, ticketIds: moving, patch: { parent: target.id } });
    else dispatch('plan.tickets.reorder', { planId: plan.id, ticketIds: moving, ...(target.before ? { beforeId: target.id } : { afterId: target.id }) });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

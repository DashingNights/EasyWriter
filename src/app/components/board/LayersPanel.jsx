import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronRight, Eye, EyeOff, Group, Image, Lock, LockOpen, PenLine, Spline, Square, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { htmlToText } from '../../../flow/graph.mjs';
import { layerRows, selectable } from '../../../flow/model.mjs';
import { kindOf } from '../../../flow/shapes.mjs';
import { saveSettings } from '../../actions.js';
import { getState, useStore } from '../../store.js';
import { CHROME, keepFocus, ShapeIcon } from './controls.jsx';

/** Shows or hides the layers panel's rows, kept in settings (`layersPanel`): its title, the rail's Layers button, tool search.
 * Hidden, the panel is its title bar. */
export function toggleLayers() {
  return saveSettings({ layersPanel: !(getState().settings?.layersPanel ?? true) });
}

const text = (html) => htmlToText(html).replace(/\s+/g, ' ').trim().slice(0, 80);
// A row's type icon and label by its item's type.
const LOOK = {
  text: (i) => [<Type />, text(i.html) || 'Text'],
  shape: (i) => [kindOf(i.shape) ? <ShapeIcon shape={i.shape} /> : <Square />, text(i.html) || kindOf(i.shape)?.label || 'Shape'],
  connector: (i) => [<Spline />, text((i.labels?.mid ?? Object.values(i.labels ?? {})[0])?.html) || 'Connector'],
  image: () => [<Image />, 'Image'],
  stroke: () => [<PenLine />, 'Pen stroke'],
};
const keyOf = (r) => (r.group ? `g:${r.group}` : r.items[0].id);
const idsOf = (rows) => rows.flatMap((r) => r.items.map((i) => i.id));
/** Insertion line on the top edge of a row, or on its bottom edge with `after` (as the sidebar's). */
const line = (after) => cn('relative before:absolute before:inset-x-1 before:z-10 before:h-0.5 before:rounded-full before:bg-primary',
  after ? 'before:-bottom-px' : 'before:-top-px');

/** §6c Layers panel: the active board's items as rows, topmost first (model.mjs layerRows), right of the rail and level with
 * its top (`style`: BoardRail places it). Persistent chrome: board presses keep working and the board keeps the focus. Each
 * board's expanded groups are kept while the rail is mounted. Its title shows or hides the rows (toggleLayers). */
export function LayersPanel({ board, className, style }) {
  const open = useStore((s) => s.settings?.layersPanel ?? true);
  const expanded = useRef(new WeakMap()); // board → its expanded group ids
  if (!board) return null;
  if (!expanded.current.has(board)) expanded.current.set(board, new Set());
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div {...CHROME} aria-label="Layers" onMouseDown={keepFocus} style={style}
      // left: past the rail (0.5rem + 2.5rem + its border) with a small gap
      className={cn('absolute left-[3.5rem] z-30 flex flex-col overflow-y-auto rounded-island border bg-island p-1 text-sm shadow-xl [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]', open ? 'w-60' : 'w-fit', className)}>
      <button type="button" aria-expanded={open} aria-label={open ? 'Hide layers' : 'Show layers'}
        onClick={() => { toggleLayers(); board.focus(); }}
        className="flex items-center gap-1 rounded-md py-1 pr-2 text-xs font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground">
        <span className="flex w-5 shrink-0 justify-center"><Chevron className="size-3.5" /></span>
        Layers
      </button>
      {open && <Rows board={board} expanded={expanded.current.get(board)} />}
    </div>
  );
}

/** The rows: rebuilt on the board's `rev` (each render and commit) and its selection, never during a drag on the board (it
 * commits on release). */
function Rows({ board, expanded }) {
  const subscribe = useCallback((fn) => board.subscribe(fn), [board]);
  const rev = useSyncExternalStore(subscribe, () => board.rev);
  const selKey = useSyncExternalStore(subscribe, () => [...board.sel].join(' '));
  const rows = useMemo(() => layerRows(board.items), [board, rev]);
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [drop, setDrop] = useState(null); // {key, after}: where a dragged row goes
  const list = useRef(null);
  const anchor = useRef(null); // the key of the row last clicked: Shift + click selects the rows from it
  const seen = useRef(null);
  const sel = board.sel;
  // A row is selected while every one of its items but the hidden ones is.
  const on = (r) => r.items.some((i) => !i.hidden) && r.items.every((i) => i.hidden || sel.has(i.id));
  if (seen.current !== selKey) {
    // A new selection opens every group around a selected item that is not selected whole, so its row shows (as in Figma).
    seen.current = selKey;
    for (const i of board.items) {
      if (!sel.has(i.id)) continue;
      for (const g of i.groups ?? []) if (!board.items.every((m) => m.hidden || !m.groups?.includes(g) || sel.has(m.id))) expanded.add(g);
    }
  }
  // A block body: scrollIntoView returns a Promise in Chromium, and React calls whatever an effect returns as its cleanup.
  useEffect(() => {
    list.current?.querySelector('[data-on]')?.scrollIntoView({ block: 'nearest' });
  }, [selKey]);
  useEffect(() => () => board.hover(), [board]);

  // Click: the row's unit (a locked one too, not a hidden one), scrolled into view; Shift: the sibling rows from the last one
  // clicked; Ctrl: the row added or removed. The scope becomes the row's group (§6c Groups).
  const click = (e, r, siblings) => {
    if (!r.items.some((i) => !i.hidden)) return;
    const a = siblings.findIndex((s) => keyOf(s) === anchor.current);
    let ids = idsOf([r]);
    if (e.shiftKey && a >= 0) {
      const b = siblings.indexOf(r);
      ids = idsOf(siblings.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.ctrlKey || e.metaKey) ids = on(r) ? [...sel].filter((id) => !ids.includes(id)) : [...sel, ...ids];
    if (!e.shiftKey) anchor.current = keyOf(r);
    board.finishEdit();
    if (board.mode) board.setMode(null);
    board.select(ids, r.scope);
    // Centred on each axis it is not wholly in the viewport on, by hand as commands/ui.mjs scrollToBlock (the page's CSS zoom
    // misleads scrollIntoView); 'nearest' would leave it at the left edge, under the rail and this panel.
    const el = board.sel.size > 1 ? board.groupEl : board.itemEl([...board.sel][0]);
    const area = el?.closest('[data-viewport]');
    if (area) {
      const b = el.getBoundingClientRect();
      const v = area.getBoundingClientRect();
      if (b.top < v.top || b.bottom > v.bottom) area.scrollTop += b.top - v.top - Math.max(0, (v.height - b.height) / 2);
      if (b.left < v.left || b.right > v.right) area.scrollLeft += b.left - v.left - Math.max(0, (v.width - b.width) / 2);
    }
    board.focus();
  };

  // Drags a row among its siblings with pointer events after 4 px (as the sidebar's rows): a row inside an expanded sibling
  // counts as that sibling. The drop moves the row (the selected siblings, when it is one of them) to that place: one
  // Board.arrange with {index} at the row's group, one undo step. The click that ends a drag selects nothing.
  const drag = (e, r, siblings) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const [x0, y0] = [e.clientX, e.clientY];
    let moved = false;
    let gap = null;
    const move = (ev) => {
      moved ||= Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4;
      if (!moved) return;
      let el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-layer]');
      while (el && !siblings.some((s) => keyOf(s) === el.dataset.layer)) el = el.parentElement.closest('[data-layer]');
      gap = null;
      if (!el) return setDrop(null);
      const k = siblings.findIndex((s) => keyOf(s) === el.dataset.layer);
      const box = el.getBoundingClientRect();
      gap = k + (ev.clientY > box.top + box.height / 2 ? 1 : 0);
      setDrop({ key: el.dataset.layer, after: gap > k });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      setDrop(null);
      const swallow = (c) => c.stopPropagation();
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true));
      if (gap === null) return;
      const moving = on(r) ? siblings.filter(on) : [r];
      board.arrange({ index: siblings.slice(gap).filter((s) => !moving.includes(s)).length }, idsOf(moving), r.scope);
      board.focus();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Eye and padlock: Hide / Lock on the row's items (Board.setLayer), its own undo step. Shown on hover and while set.
  const flag = (r, field, set, [On, Off], label) => (
    <Button variant="ghost" size="icon-xs" aria-label={label} className={cn('shrink-0', !set && 'invisible group-hover/row:visible')}
      onClick={(e) => {
        e.stopPropagation();
        board.setLayer(field, false, idsOf([r]));
        board.focus();
      }}>
      {set ? <On /> : <Off />}
    </Button>
  );

  const tree = (siblings, depth) => siblings.map((r) => {
    const key = keyOf(r);
    const one = !r.group && r.items[0];
    const [icon, label] = one ? LOOK[one.type](one) : [<Group />, 'Group'];
    const hidden = r.items.every((i) => i.hidden);
    const locked = r.items.every((i) => i.locked);
    const open = r.group && expanded.has(r.group);
    return (
      <li key={key} data-layer={key} className={cn(drop?.key === key && line(drop.after))}>
        <div data-on={on(r) || undefined} style={{ paddingLeft: depth * 12 }}
          onPointerDown={(e) => drag(e, r, siblings)} onClick={(e) => click(e, r, siblings)}
          onDoubleClick={(e) => !e.target.closest('button') && one && selectable(one) && board.editItem(one)}
          onPointerEnter={() => board.hover(idsOf([r]))} onPointerLeave={() => board.hover()}
          className={cn('group/row flex h-7 items-center gap-1 rounded-md pr-1 select-none hover:bg-accent/60', on(r) && 'bg-accent hover:bg-accent')}>
          {r.group ? (
            <button type="button" aria-label={open ? 'Collapse' : 'Expand'} className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                if (!expanded.delete(r.group)) expanded.add(r.group);
                redraw();
              }}>
              {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : <span className="w-5 shrink-0" />}
          <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground', (hidden || locked) && 'opacity-50')}>
            {icon}
            <span className="truncate">{label}</span>
          </span>
          {flag(r, 'locked', locked, [Lock, LockOpen], locked ? 'Unlock' : 'Lock')}
          {flag(r, 'hidden', hidden, [EyeOff, Eye], hidden ? 'Show' : 'Hide')}
        </div>
        {open && <ul>{tree(r.rows, depth + 1)}</ul>}
      </li>
    );
  });

  return rows.length ? <ul ref={list}>{tree(rows, 0)}</ul> : <p className="px-2 py-1 text-xs text-muted-foreground">No items</p>;
}

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronRight, Eye, EyeOff, FileText, Group, Image, Lock, LockOpen, MoveUpRight, PenLine, Slash, Spline, Square, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { htmlToText } from '../../../flow/graph.mjs';
import { layerRows, selectable } from '../../../flow/model.mjs';
import { kindOf } from '../../../flow/shapes.mjs';
import { saveSettings } from '../../actions.js';
import { getState, useStore } from '../../store.js';
import { lineOf, shapeName } from '../../../tooling/shape-picker.mjs';
import { CHROME, isArrow, keepFocus, ShapeIcon } from './controls.jsx';

/** Shows or hides the layers panel's rows, kept in settings (`layersPanel`): its title, the rail's Layers button, tool search.
 * Hidden, the panel is its title bar. */
export function toggleLayers() {
  return saveSettings({ layersPanel: !(getState().settings?.layersPanel ?? true) });
}

const text = (html) => htmlToText(html).replace(/\s+/g, ' ').trim().slice(0, 80);
// A row's type icon and label by its item's type: its text, else the name every picker gives its shape or its Lines entry (a free
// line: the tool that drew it, Line or Arrow).
const LOOK = {
  text: (i) => [<Type />, text(i.html) || 'Text'],
  shape: (i) => [kindOf(i.shape) ? <ShapeIcon shape={i.shape} /> : <Square />, text(i.html) || (kindOf(i.shape) ? shapeName(i.shape) : 'Shape')],
  connector: (i) => {
    const label = text((i.labels?.mid ?? Object.values(i.labels ?? {})[0])?.html);
    if (i.free) return isArrow(i) ? [<MoveUpRight />, label || 'Arrow'] : [<Slash />, label || 'Line'];
    return [<Spline />, label || lineOf(i) || 'Connector'];
  },
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
// Where the panel sits: right of a rail at the ancestor's left edge ('rail'), or beside a rail at its right edge, left of it
// ('before') or right of it ('after'), each past the rail (0.5rem + 2.5rem + its border) with a small gap.
const SIDE = { rail: 'left-[3.5rem]', before: 'right-[3.5rem]', after: 'left-[calc(100%-2px)]' };

export function LayersPanel({ board, side = 'rail', className, style }) {
  const open = useStore((s) => s.settings?.layersPanel ?? true);
  const expanded = useRef(new WeakMap()); // board → its expanded group ids
  if (!board) return null;
  if (!expanded.current.has(board)) expanded.current.set(board, new Set());
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div {...CHROME} aria-label="Layers" onMouseDown={keepFocus} style={style}
      className={cn('absolute z-30 flex', SIDE[side], 'flex-col overflow-y-auto rounded-island border bg-island p-1 text-sm shadow-xl [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]', open ? 'w-60' : 'w-fit', className)}>
      <button type="button" aria-expanded={open} aria-label={open ? 'Hide layers' : 'Show layers'}
        onClick={() => { toggleLayers(); board.focus(); }}
        className="flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-semibold hover:bg-accent/60">
        <span className="flex w-5 shrink-0 justify-center"><Chevron className="size-3.5" /></span>
        Layers
      </button>
      {open && (board.tree
        ? <TreeRows board={board} expanded={expanded.current.get(board)} />
        : <Rows board={board} expanded={expanded.current.get(board)} />)}
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
          onDoubleClick={(e) => !e.target.closest('button') && one && selectable(one) && board.can?.('editItem') !== false && board.editItem(one)}
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

// The plane board's row icons by stored type (`board.tree`); a shape's own name picks its icon.
const TREE_ICON = { group: Group, text: Type, picture: Image, ink: PenLine, connector: Spline, doc: FileText, page: FileText };
const treeIcon = (row) => {
  if (row.type === 'shape') return row.name === 'Line' ? Slash : row.name === 'Arrow' ? MoveUpRight : Square;
  return TREE_ICON[row.type] ?? Square;
};

/** The engine board's rows (§6c): `board.tree` gives the hierarchy topmost first, expansion lives here, a name double-clicks
 * into an inline edit (`renameLayer`), and a row drags to reorder or into a group (`moveLayer`). Rows rebuild on the board's
 * `rev`. */
function TreeRows({ board, expanded }) {
  const subscribe = useCallback((fn) => board.subscribe(fn), [board]);
  const rev = useSyncExternalStore(subscribe, () => board.rev);
  const selKey = useSyncExternalStore(subscribe, () => [...board.sel].join(' '));
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [drop, setDrop] = useState(null); // {id, after, into}: where a dragged row would go
  const [edit, setEdit] = useState(null); // {id, value}: the name being typed
  const list = useRef(null);
  const anchor = useRef(null); // the id of the row last clicked: Shift+click selects the rows between
  const cancelled = useRef(false); // Esc was pressed: the blur that follows must not save the typed name
  const rows = board.tree(expanded);
  const sel = board.sel;

  // Scroll the first selected row into view on a new selection, as the flow rows do.
  useEffect(() => {
    list.current?.querySelector('[data-on]')?.scrollIntoView({ block: 'nearest' });
  }, [selKey]);

  // `board.renameItem` (a double-click on the name, or another surface): its layer opens for renaming here.
  useEffect(() => {
    const id = board.renameId;
    if (!id) return;
    board.renameId = null;
    const row = board.tree(expanded).find((r) => r.id === id);
    if (row) {
      cancelled.current = false;
      setEdit({ id, value: row.name });
    }
  }, [rev]);

  useEffect(() => () => board.hover(), [board]);

  // Click: the row's item; Shift: the rows from the last one clicked; Ctrl: the row added or removed (L13). A locked row selects
  // (it can then be unlocked), and the board's scope is left as it is.
  const click = (e, row, i) => {
    if (e.target.closest('input')) return;
    if (row.type === 'page') return; // a document's pages are read only here
    const a = rows.findIndex((r) => r.id === anchor.current);
    let ids = [row.id];
    if (e.shiftKey && a >= 0) ids = rows.slice(Math.min(a, i), Math.max(a, i) + 1).map((r) => r.id);
    else if (e.ctrlKey || e.metaKey) ids = sel.has(row.id) ? [...sel].filter((id) => id !== row.id) : [...sel, row.id];
    if (!e.shiftKey) anchor.current = row.id;
    board.finishEdit();
    if (board.mode) board.setMode(null);
    board.select(ids);
    board.focus();
  };

  // Drags a row with pointer events (rows live in a portal, so no HTML drag): a line between rows, or a ring on a group it
  // would move into. The drop calls `moveLayer` (one `Reorder` step).
  const drag = (e, row) => {
    if (row.type === 'page' || e.button !== 0 || e.target.closest('button, input')) return;
    const [x0, y0] = [e.clientX, e.clientY];
    let moved = false;
    let slot = null;
    const move = (ev) => {
      moved ||= Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4;
      if (!moved) return;
      slot = null;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-layer]');
      const at = el ? rows.findIndex((r) => r.id === el.dataset.layer) : -1;
      if (at < 0) return setDrop(null);
      const r = rows[at];
      const box = el.getBoundingClientRect();
      const rel = (ev.clientY - box.top) / box.height;
      if (r.type === 'group' && rel > 0.3 && rel < 0.7) {
        slot = { parent: r.id, before: null };
        return setDrop({ id: r.id, into: true });
      }
      // The parent: the nearest row above, one level out. The sibling above it on screen is this row's paint successor.
      let parent = null;
      let before = rel < 0.5 ? null : r.id;
      for (let j = at - 1; j >= 0; j--) {
        const other = rows[j];
        if (other.depth > r.depth) continue;
        if (other.depth === r.depth) {
          if (before == null) before = other.id;
          continue;
        }
        parent = other.depth === r.depth - 1 ? other.id : null;
        break;
      }
      slot = { parent, before };
      setDrop({ id: r.id, after: rel >= 0.5 });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!moved) return;
      setDrop(null);
      const swallow = (c) => c.stopPropagation();
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true));
      if (slot) board.moveLayer(row.id, slot.parent, slot.before);
      board.focus();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The name edit (L6): Enter commits, Esc cancels, a click away commits. Esc takes the focus out of the input first, so the
  // blur that follows reads `cancelled` and saves nothing.
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const current = edit;
    if (!current) return;
    setEdit(null);
    if (current.value.trim()) board.renameLayer(current.id, current.value);
    board.focus();
  };

  const flag = (row, field, set, [On, Off], label) => (
    <Button variant="ghost" size="icon-xs" aria-label={label} className={cn('shrink-0', !set && 'invisible group-hover/row:visible')}
      onClick={(e) => {
        e.stopPropagation();
        board.setLayer(field, false, [row.id]);
        board.focus();
      }}>
      {set ? <On /> : <Off />}
    </Button>
  );

  return rows.length ? (
    <ul ref={list} onPointerDown={(e) => e.stopPropagation()}>
      {rows.map((row, i) => {
        const Icon = treeIcon(row);
        const open = row.open;
        return (
          <li key={row.id} data-layer={row.id} className={cn(drop?.id === row.id && drop.into && 'rounded-md ring-1 ring-inset ring-primary')}>
            <div data-on={row.selected || undefined} style={{ paddingLeft: row.depth * 12 }}
              onPointerDown={(e) => drag(e, row)} onClick={(e) => click(e, row, i)}
              onPointerEnter={() => board.hover(row.id)} onPointerLeave={() => board.hover()}
              className={cn('group/row flex h-7 items-center gap-1 rounded-md pr-1 select-none hover:bg-accent/60',
                row.selected && 'bg-accent hover:bg-accent', drop?.id === row.id && !drop.into && line(drop.after))}>
              {row.type === 'group' ? (
                <button type="button" aria-label={open ? 'Collapse' : 'Expand'} className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!expanded.delete(row.id)) expanded.add(row.id);
                    redraw();
                  }}>
                  {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </button>
              ) : <span className="w-5 shrink-0" />}
              <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
                (row.hidden || row.locked) && 'opacity-50')}>
                <Icon />
                {edit?.id === row.id ? (
                  <input autoFocus aria-label="Layer name" value={edit.value}
                    onChange={(e) => setEdit({ id: row.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); commit(); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelled.current = true; setEdit(null); board.focus(); }
                    }}
                    onBlur={commit}
                    className="min-w-0 flex-1 rounded border bg-background px-1 text-sm" />
                ) : (
                  <span className="truncate" onDoubleClick={(e) => { e.stopPropagation(); board.renameItem(row.id); }}>{row.name}</span>
                )}
              </span>
              {row.type !== 'page' && flag(row, 'locked', row.locked, [Lock, LockOpen], row.locked ? 'Unlock' : 'Lock')}
              {row.type !== 'page' && flag(row, 'hidden', row.hidden, [EyeOff, Eye], row.hidden ? 'Show' : 'Hide')}
            </div>
          </li>
        );
      })}
    </ul>
  ) : <p className="px-2 py-1 text-xs text-muted-foreground">No items</p>;
}

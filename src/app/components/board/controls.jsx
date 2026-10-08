import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import {
  AlignCenter, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowLeft, ArrowRight, Bold,
  ChevronDown, ChevronRight, CopyPlus, Package, Pencil, RotateCcw, RotateCw, Star, Trash2, Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HEADS } from '../../../flow/model.mjs';
import { headPath, headTrim } from '../../../flow/route.mjs';
import { kindOf, stylePresets } from '../../../flow/shapes.mjs';
import { activeBoard, colorPicker, FILLS, NOTE_COLORS, PEN_STYLES, PEN_WIDTHS, resolveBg, shapeGeometry, TEXT_SIZES } from '../../../whiteboard.js';
import {
  armPrefab, createPrefab, customOrder, dropShape, duplicatePrefab, prefabList, prefabTile, removePrefab, renamePrefab, resetShapeSection,
  shapeLayout, toggleShapeFavourite, usePrefabs,
} from '../../prefabs.js';
import { keyLabel, withKey } from '../../keybinds.js';
import { getState, useStore } from '../../store.js';
import { rankTool } from '../../tool-rank.mjs';
import { Tip } from '../Tip.jsx';
import { PointerMenu } from './BoardMenu.jsx';

// Shared pieces of the board chrome (§6c): the rail, its flyouts and the item ribbon.

/** Marks chrome outside a board's DOM (incl. Radix portals): focus moving there never ends a text edit. */
export const CHROME = { 'data-board-chrome': '' };

/** onMouseDown of chrome bars: buttons and backgrounds never take focus, so the board (or the edited text with its caret)
 * keeps it. Colour inputs do take focus: it keeps a text edit open while their native picker deactivates the window. */
export const keepFocus = (e) => {
  if (e.target.tagName !== 'INPUT') e.preventDefault();
};

/** The board this chrome serves: the active board of the document (also a canvas being edited), or null. */
export function useBoard() {
  return useSyncExternalStore(activeBoard.subscribe, activeBoard.get);
}

/** The board's snapshot (kind, mode, selected item, tool settings, snapping, bg, undo / redo), or null. */
export function useSnapshot(board) {
  const subscribe = useCallback((fn) => (board ? board.subscribe(fn) : () => {}), [board]);
  return useSyncExternalStore(subscribe, () => board?.getSnapshot() ?? null);
}

/** onCloseAutoFocus of chrome popups: focus goes back to the board (the edited text gets its caret back), unless the
 * user has moved it elsewhere meanwhile. */
export const refocus = (board) => (e) => {
  e.preventDefault();
  const a = document.activeElement;
  if (!a || a === document.body || a.closest('[data-board-chrome]')) board?.focus();
};

/** Native colour input styled as a swatch. `live`: onChange on every pick while the picker is open (tool settings);
 * otherwise once, when the picker closes (item colours). Focus then returns to the board. While its picker is open a click
 * on a board only closes it (colorPicker, §6c). */
export function ColorSwatch({ board, title, value, live = false, onChange }) {
  const ref = useRef(null);
  const latest = useRef(null);
  latest.current = { board, onChange };
  useEffect(() => {
    ref.current.value = value;
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    const pick = () => latest.current.onChange(el.value);
    const close = () => {
      if (!live) pick();
      latest.current.board?.focus();
    };
    const blur = () => document.hasFocus() && colorPicker.closed(); // not the window losing focus to the picker
    if (live) el.addEventListener('input', pick);
    el.addEventListener('click', colorPicker.open);
    el.addEventListener('change', colorPicker.closed);
    el.addEventListener('change', close);
    el.addEventListener('blur', blur);
    return () => {
      el.removeEventListener('input', pick);
      el.removeEventListener('click', colorPicker.open);
      el.removeEventListener('change', colorPicker.closed);
      el.removeEventListener('change', close);
      el.removeEventListener('blur', blur);
    };
  }, [live]);
  return (
    <Tip title={title} {...CHROME}>
      <input
        ref={ref}
        type="color"
        aria-label={title}
        defaultValue={value}
        className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-input/30 p-1 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0"
      />
    </Tip>
  );
}

// Small previews in the option lists (and the trigger), drawn in the text colour.
const PREVIEW = { className: 'size-4 shrink-0 text-foreground', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };

// A kind's preview box: its click-placed size (circles, the bar), a swimlane large enough to show its band, else square
// (basic kinds) or 3 : 2.
const previewBox = (k) => (k?.kind === 'lane' ? [150, 100] : k?.box ?? (k?.group === 'basic' ? [48, 48] : [60, 40]));

/** A shape kind drawn with the board's own geometry (shapeGeometry: the registry's path for the flowchart kinds), in the
 * text colour; a 1.5 px line at any size. */
export function ShapeIcon({ shape, className = 'size-4' }) {
  const [w, h] = previewBox(kindOf(shape));
  const { d, head } = shapeGeometry({ shape, w, h, width: Math.max(w, h) / 12 });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} overflow="visible" {...PREVIEW} strokeWidth="1.5" className={cn(PREVIEW.className, className)}>
      <path d={d} vectorEffect="non-scaling-stroke" />
      {head && <path d={head} fill="currentColor" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
const WidthPreview = ({ width }) => (
  <svg viewBox="0 0 16 16" strokeWidth={1 + (width - 1) * 0.5} {...PREVIEW}><path d="M3 8H13" /></svg>
);
const StylePreview = ({ opacity }) => (
  <svg viewBox="0 0 16 16" strokeWidth="3" strokeOpacity={opacity} {...PREVIEW}><path d="M2 11C4 4 7 4 8 8S12 12 14 5" /></svg>
);
const FillPreview = ({ fill }) => (
  <svg viewBox="0 0 16 16" strokeWidth="1.5" {...PREVIEW}>
    <rect x="2" y="2" width="12" height="12" rx="1.5" fill={fill === 'solid' ? 'currentColor' : 'none'} />
    {fill === 'hatch' && <path strokeWidth="1" d="M2 8L8 2M2 14L14 2M8 14L14 8" />}
  </svg>
);
/** The px sizes of `list` plus `value` when it is not one of them (an item's size in post px, §6c Units), sorted. */
export const withValue = (list, value) => (list.includes(value) ? list : [...list, value].sort((a, b) => a - b));
const STYLE_OPTIONS = PEN_STYLES.map(([v, label]) => [v, label, undefined, <StylePreview opacity={v} />]);
const FILL_OPTIONS = FILLS.map(([v, label]) => [v, label, undefined, <FillPreview fill={v} />]);

/** Select over [value, label, colour?, preview?] options; values may be numbers (Radix wants strings). Fixed width, so the
 * controls after it never shift. */
export function OptionSelect({ board, title, value, options, onChange, className }) {
  // Never narrower than its longest label (+ padding, chevron and any preview / colour mark), so no value is clipped.
  const chars = Math.max(...options.map((o) => String(o[1]).length));
  const marks = options.some((o) => o[3]) * 1.5 + options.some((o) => o[2] !== undefined) * 1.25;
  return (
    <Select value={String(value)} onValueChange={onChange}>
      <Tip title={title} {...CHROME}>
        <SelectTrigger size="sm" aria-label={title} className={className} style={{ minWidth: `calc(${chars}ch + ${3 + marks}rem)` }}>
          <SelectValue />
        </SelectTrigger>
      </Tip>
      <SelectContent {...CHROME} onCloseAutoFocus={refocus(board)}>
        {options.map(([v, label, color, preview]) => (
          <SelectItem key={v} value={String(v)}>
            {color !== undefined && <span className="size-3 rounded-sm border" style={{ background: color || 'transparent' }} />}
            {preview}
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Colour, width and style of the pen, the shape tool or a selected stroke / shape (`value`); `set(patch)` applies. */
// Colour swatches sit in a row with their select (PAIR), so a stacked layout (the rail flyout) keeps them together.
const PAIR = 'flex items-center gap-1';

export function StrokeControls({ board, value, set, live }) {
  return (
    <>
      <div className={PAIR}>
        <ColorSwatch board={board} title="Line colour" value={value.color} live={live} onChange={(color) => set({ color })} />
        <OptionSelect board={board} title="Line width" className="w-24" value={value.width}
          options={withValue(PEN_WIDTHS, value.width).map((w) => [w, `${w} px`, undefined, <WidthPreview width={w} />])}
          onChange={(v) => set({ width: Number(v) })} />
      </div>
      <OptionSelect board={board} title="Line style" className="w-34" value={value.opacity} options={STYLE_OPTIONS}
        onChange={(v) => set({ opacity: Number(v) })} />
    </>
  );
}

// The shape list's sections (§6d, §6g): Favourites, the registry groups, Prefabs (shape-list.mjs shapeSections); the shape
// panel's also Connectors and Text & notes.
const SECTION_TITLES = {
  favourites: 'Favourites', basic: 'Basic', flow: 'Flowchart', container: 'Containers', prefabs: 'Prefabs', connectors: 'Connectors', text: 'Text & notes',
  results: 'Results',
};
const noFocus = (e) => e.preventDefault();

// Shape panel tiles beyond kinds and prefabs: connector styles (a click arms the connector tool in that style) and text /
// notes (a click arms Text with that note colour). `what`: what a drop adds (Board.spawnItems). Icon: path, head path, dash.
const ARROW = { start: 'none', end: 'arrow' };
const CONNECTOR_TILES = [
  ['elbow', 'Elbow arrow', { route: 'ortho', heads: ARROW, dash: 'solid' }, 'M2 13H8V3H14', 'M11 0.5L14 3L11 5.5'],
  ['straight', 'Straight arrow', { route: 'straight', heads: ARROW, dash: 'solid' }, 'M2 14L14 2', 'M9.5 2H14V6.5'],
  ['curve', 'Curved arrow', { route: 'curve', heads: ARROW, dash: 'solid' }, 'M2 14C2 6 14 10 14 2', 'M11.5 4.5L14 2L16.5 4.5'],
  ['dashed', 'Dashed arrow', { route: 'ortho', heads: ARROW, dash: 'dashed' }, 'M2 13H8V3H14', 'M11 0.5L14 3L11 5.5', '2.5 2'],
  ['two-way', 'Two-way arrow', { route: 'straight', heads: { start: 'arrow', end: 'arrow' }, dash: 'solid' }, 'M2 14L14 2', 'M9.5 2H14V6.5M2 9.5V14H6.5'],
  ['line', 'Line', { route: 'straight', heads: { start: 'none', end: 'none' }, dash: 'solid' }, 'M2 14L14 2', ''],
].map(([id, label, conn, d, head, dash]) => ({
  ref: `conn:${id}`, label, keywords: ['connector', 'arrow', 'line', 'link', 'edge', id], what: { conn },
  icon: <svg viewBox="0 0 16 16" overflow="visible" strokeWidth="1.5" {...PREVIEW} className={cn(PREVIEW.className, 'size-5')}><path d={d} strokeDasharray={dash} />{head && <path d={head} />}</svg>,
}));
const TEXT_TILES = [
  { ref: 'text:', label: 'Text', keywords: ['text', 'label', 'type', 'words'], what: { note: null }, icon: <Type className="size-5" /> },
  ...NOTE_COLORS.filter(([c]) => c).map(([c, label]) => ({
    ref: `text:${c}`, label, keywords: ['note', 'sticky', 'post-it', 'comment', 'text'], what: { note: c },
    icon: <span className="grid size-5 place-items-center rounded-sm border text-[0.6rem] font-semibold text-black" style={{ background: c }}>T</span>,
  })),
];

/** What a shape list tile adds to `board` (Board.spawnItems): a kind, a prefab's items (loaded: a promise), a connector
 * style or a text / note. */
const tileWhat = (board, x) => (x.kind ? { kind: x.kind } : x.prefab ? prefabTile(board, x.prefab.id) : x.what);

/** A shape panel tile's click (§6g): arms `board`'s tool with tile `x` (a kind or a prefab: the shape tool; a connector style:
 * the connector tool in that style; text / a note: Text with that note colour). */
export function armTile(board, x) {
  if (x.kind) {
    board.setShapeTool({ shape: x.kind });
    board.setMode('shape');
  } else if (x.prefab) armPrefab(board, x.prefab.id);
  else if (x.what.conn) {
    board.setConnTool(structuredClone(x.what.conn));
    board.setMode('connector');
  } else board.setMode('text', { note: x.what.note });
}

/** A prefab's thumbnail on the post background (its items are drawn on a transparent one), or a generic icon. */
function PrefabThumb({ prefab, className = 'h-10 w-full' }) {
  if (!prefab?.thumb) return <Package className={cn('text-muted-foreground', className)} />;
  const bg = resolveBg('post', document.documentElement.dataset.theme);
  return <img src={prefab.thumb} alt="" draggable={false} className={cn('rounded-sm object-contain', className)} style={{ background: bg }} />;
}

/** The shape list (§6d, §6g): a button showing the kind (`value`) or the armed prefab; its popover holds the sections as
 * preview tiles with a search over names and keywords. `prefabs`: the shape tool's list (Prefabs section; a prefab tile arms
 * the tool); without it (the ribbon) only kinds show. `openAt` 'prefabs': opens at once, scrolled to Prefabs. */
export function ShapePicker({ board, value, onChange, prefabs = false, openAt = null }) {
  const [open, setOpen] = useState(!!openAt);
  const armed = useSnapshot(prefabs ? board : null)?.prefab ?? null;
  const prefab = armed && prefabList().find((p) => p.id === armed);
  const current = kindOf(value);
  const pick = (ref) => {
    setOpen(false);
    if (ref.startsWith('kind:')) onChange(ref.slice(5));
    else armPrefab(board, ref.slice(7));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip title="Shape" {...CHROME}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Shape" className="w-42 justify-start gap-1.5 px-2.5 font-normal">
            {prefab ? <PrefabThumb prefab={prefab} className="size-4" /> : <ShapeIcon shape={value} />}
            <span className="truncate">{prefab ? prefab.name : current?.label}</span><ChevronDown className="ml-auto opacity-50" />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent {...CHROME} align="start" className="w-auto p-1.5" onCloseAutoFocus={refocus(board)}>
        <ShapeList board={board} current={armed ? `prefab:${armed}` : `kind:${value}`} withPrefabs={prefabs} openAt={openAt} pick={pick}
          close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The shape list's content (the popover's, and the shape panel's with `panel`): search, sections, tiles; `current`: the
 * pressed tile's ref; `pick(ref, entry)`: a tile's click. Keys: typing filters (one Results section, best match first), Enter
 * picks the focused tile (in the search: the best match), arrows move between tiles (Up from the top row: the search),
 * Alt+arrows move the focused tile within its section, Shift+F10 / the context-menu key open its entry menu. Tiles drag
 * (after 4 px): within their section to reorder, into Favourites (starred there), a favourite onto another section
 * (unstarred), out of the list over the board (a ghost of what it adds follows the pointer; released over the board: added
 * centred there). A double-click adds it at the centre of the visible board. Panel: collapsible sections (`closed`: the ids
 * of the closed ones, `toggle(id)`), Connectors and Text & notes, and board items dragged onto Prefabs make a prefab. */
export function ShapeList({ board, current, withPrefabs, openAt, pick, close, panel = false, closed = [], toggle }) {
  usePrefabs();
  useStore((s) => s.settings?.shapeFavourites);
  useStore((s) => s.settings?.shapeOrder);
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState(null); // {ref, section?, target?, after?} while a tile is dragged
  const [menu, setMenu] = useState(null); // {x, section, at} while a tile's entry menu is open
  const list = useRef(null);
  const search = useRef(null);
  const altUsed = useRef(false);
  const q = query.trim();
  const prefabs = withPrefabs ? prefabList() : [];
  const byId = new Map(prefabs.map((p) => [p.id, p]));
  const entry = (ref) => {
    if (ref.startsWith('kind:')) {
      const k = kindOf(ref.slice(5));
      return k && { ref, kind: k.kind, label: k.label, keywords: k.keywords };
    }
    const p = byId.get(ref.slice(7));
    return p && { ref, prefab: p, label: p.name, keywords: p.keywords };
  };
  let sections = shapeLayout(prefabs).map((s) => ({ ...s, entries: s.refs.map(entry).filter(Boolean) }));
  if (panel) {
    const [favs, ...rest] = sections;
    sections = [favs, ...rest.filter((s) => s.id === 'prefabs'), ...rest.filter((s) => s.id !== 'prefabs'),
      { id: 'connectors', entries: CONNECTOR_TILES }, { id: 'text', entries: TEXT_TILES }];
  }
  const rank = (x) => rankTool(q, x.label, x.keywords);
  const all = sections.flatMap((s) => s.entries);
  const byRef = new Map(all.map((x) => [x.ref, x]));
  sections = (q ? [{ id: 'results', entries: all.filter((x) => rank(x) > 0).sort((a, b) => rank(b) - rank(a)) }] : sections)
    .map((s) => ({ ...s, title: SECTION_TITLES[s.id] }))
    .filter((s) => s.entries.length || (s.id === 'favourites' && drag) || (s.id === 'prefabs' && withPrefabs && !prefabs.length));
  const choose = (ref) => pick(ref, byRef.get(ref));
  useEffect(() => {
    if (openAt) list.current?.querySelector(`[data-drop="${openAt}"]`)?.scrollIntoView({ block: 'start' });
  }, []);
  // Board items dragged onto Prefabs (whiteboard.js dispatches `boarddrop` on the [data-board-drop] under the release).
  useEffect(() => {
    const el = list.current;
    const take = (e) => createPrefab(e.detail);
    el?.addEventListener('boarddrop', take);
    return () => el?.removeEventListener('boarddrop', take);
  }, []);
  const focusRef = (ref) => requestAnimationFrame(() => list.current?.querySelector(`[data-ref="${CSS.escape(ref)}"]`)?.focus());
  // Alt+arrows, Move earlier / later: one place within the section as shown.
  const step = (ref, section, dir) => {
    const refs = sections.find((s) => s.id === section)?.entries.map((x) => x.ref) ?? [];
    const next = refs[refs.indexOf(ref) + dir];
    if (refs.includes(ref) && next) dropShape(ref, section, next, dir > 0);
  };
  const onKeyDown = (e) => {
    if (!list.current?.parentElement.contains(e.target)) return; // the entry menu's keys (a portal: React bubbles them here)
    const tiles = [...list.current.querySelectorAll('[data-ref]')];
    const i = tiles.indexOf(document.activeElement);
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
    let next;
    if (arrow && e.altKey) {
      if (i < 0) return;
      e.preventDefault();
      altUsed.current = true; // its keyup must not open the window menu
      step(tiles[i].dataset.ref, tiles[i].dataset.section, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'Enter') {
      if (i < 0 && e.target.tagName === 'BUTTON') return; // Reset order, a section header: their own click
      const ref = i >= 0 ? tiles[i].dataset.ref : sections.flatMap((s) => s.entries).reduce((a, x) => (a && rank(a) >= rank(x) ? a : x), null)?.ref;
      if (!ref) return;
      e.preventDefault();
      choose(ref);
      return;
    }
    if (i < 0) {
      if (e.key === 'ArrowDown') next = tiles[0];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') next = tiles[i + (e.key === 'ArrowRight' ? 1 : -1)];
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const top = (el) => el.getBoundingClientRect().top;
      const left = (el) => el.getBoundingClientRect().left;
      const [y, x, dir] = [top(tiles[i]), left(tiles[i]), e.key === 'ArrowDown' ? 1 : -1];
      next = tiles.filter((el) => (top(el) - y) * dir > 4)
        .sort((a, b) => Math.abs(top(a) - y) - Math.abs(top(b) - y) || Math.abs(left(a) - x) - Math.abs(left(b) - x))[0]
        ?? (dir < 0 ? search.current : null);
    } else return;
    if (!next) return;
    e.preventDefault();
    next.focus();
  };
  const onKeyUp = (e) => {
    if (e.key === 'Alt' && altUsed.current) {
      e.preventDefault();
      altUsed.current = false;
    }
  };
  // Enter is the list's own while it is open: taken in the window's capture phase, before the tool search options panel's
  // document listener, which closes the panel on Enter (§7c) and would drop the pick.
  const keys = useRef(null);
  keys.current = onKeyDown;
  useEffect(() => {
    const onEnter = (e) => {
      if (e.key !== 'Enter' || !list.current?.parentElement.contains(e.target)) return;
      e.stopPropagation();
      keys.current(e);
    };
    window.addEventListener('keydown', onEnter, true);
    return () => window.removeEventListener('keydown', onEnter, true);
  }, []);
  // Pointer drag of a tile (no OS drag and drop), after 4 px so a click still picks. The click ending a drag picks nothing.
  const startDrag = (e, x, section) => {
    if (e.button !== 0) return;
    const [x0, y0] = [e.clientX, e.clientY];
    let moved = false;
    let to = null;
    let what = null; // what it adds, once known (a prefab loads)
    let asked = false;
    let ghost = null;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) moved = true;
      if (!moved) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const tile = el?.closest('[data-ref]');
      if (tile && tile.dataset.ref !== x.ref && list.current.contains(tile)) {
        const r = tile.getBoundingClientRect();
        to = { section: tile.dataset.section, target: tile.dataset.ref, after: ev.clientX > r.left + r.width / 2 };
      } else to = list.current.contains(el) ? { section: el.closest('[data-drop]')?.dataset.drop ?? null } : { out: true };
      // Loaded once the tile leaves the list (a reorder loads no prefab, so no "Canvases cannot go inside a canvas" toast).
      if (to.out && !asked) {
        asked = true;
        Promise.resolve(tileWhat(board, x)).then((w) => (what = w));
      }
      // Out of the list a ghost of what it adds follows the pointer, at the board's scale.
      if (to.out && what && !board.destroyed) {
        ghost ??= document.body.appendChild(board.ghost(what));
        ghost.hidden = false;
        ghost.style.transform = `translate(${ev.clientX - ghost.offsetWidth / 2}px, ${ev.clientY - ghost.offsetHeight / 2}px)`;
      } else if (ghost) ghost.hidden = true;
      setDrag({ ref: x.ref, ...to });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost?.remove();
      if (!moved) return;
      setDrag(null);
      const swallow = (c) => c.stopPropagation();
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true));
      if (to?.out) {
        if (what && !board.destroyed && board.drop(what, ev)) close?.();
      } else if (!x.what && to?.section && (to.section === 'favourites' || to.section !== section || to.target)) dropShape(x.ref, to.section, to.target, to.after);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Double-click: added at the centre of the visible board, selected (the click before it armed the tool).
  const insert = async (x) => {
    const what = await tileWhat(board, x);
    if (what && !board.destroyed) board.insert(what, board.visibleCentre());
  };
  // Right-click or Shift+F10 / the context-menu key on a tile: its entry menu at the pointer (keys: under the tile).
  const openMenu = (e, x, section) => {
    e.preventDefault();
    if (x.what || section === 'results') return;
    const r = e.currentTarget.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    setMenu({ x, section, at: inside ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom } });
  };
  const tile = (s, x) => {
    const starred = s.id === 'favourites';
    const props = {
      size: 'sm', 'data-ref': x.ref, 'data-section': s.id, 'aria-label': x.label, pressed: x.ref === current, onPressedChange: () => choose(x.ref),
      onPointerDown: (e) => startDrag(e, x, s.id), onContextMenu: (e) => openMenu(e, x, s.id), onDoubleClick: () => insert(x),
    };
    return (
      <div key={x.ref} className={cn('group relative', x.prefab && 'col-span-3')}>
        {x.prefab ? (
          <Toggle {...props} className="h-auto w-full flex-col gap-0.5 p-1">
            <PrefabThumb prefab={x.prefab} />
            <span className="w-full truncate text-[0.7rem] leading-tight font-normal">{x.label}</span>
          </Toggle>
        ) : (
          <Tip title={x.label} {...CHROME}>
            <Toggle {...props} data-kind={x.kind} className={cn(panel && 'w-full')}>{x.icon ?? <ShapeIcon shape={x.kind} className="size-5" />}</Toggle>
          </Tip>
        )}
        {!x.what && (
          <button type="button" tabIndex={-1} aria-label={starred ? `Remove ${x.label} from favourites` : `Add ${x.label} to favourites`}
            onMouseDown={noFocus} onClick={() => toggleShapeFavourite(x.ref)}
            className={cn('absolute -top-1 -right-1 grid size-4 place-items-center rounded-full border bg-popover text-muted-foreground opacity-0',
              'group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground')}>
            <Star className={cn('size-2.5', starred && 'fill-amber-400 text-amber-400')} />
          </button>
        )}
        {drag?.target === x.ref && <span className={cn('pointer-events-none absolute inset-y-0 w-0.5 rounded bg-ring', drag.after ? '-right-px' : '-left-px')} />}
      </div>
    );
  };
  const m = menu && sections.find((s) => s.id === menu.section)?.entries.map((x) => x.ref);
  return (
    <div onKeyDown={onKeyDown} onKeyUp={onKeyUp} className={cn(panel && 'flex min-h-0 flex-1 flex-col')}>
      <Input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={panel && keyLabel('flows.find') ? `Search shapes... ( ${keyLabel('flows.find')} )` : 'Search shapes...'}
        aria-label="Search shapes" className={cn('h-7 px-2 text-sm', panel ? 'mx-1.5 mb-1 w-auto' : 'mb-1')} />
      <div ref={list} className={cn('flex flex-col gap-1 overflow-x-hidden overflow-y-auto select-none', panel
        ? 'min-h-0 flex-1 px-1.5 pb-2'
        : 'max-h-[min(30rem,calc(var(--radix-popover-content-available-height)-3rem))] w-[16.5rem] pr-1')}>
        {sections.map((s) => {
          const open = !panel || q || !closed.includes(s.id);
          return (
            <section key={s.id} aria-label={s.title} data-drop={s.id} {...(panel && s.id === 'prefabs' && { 'data-board-drop': '' })}
              className={cn('rounded-md', drag?.section === s.id && !drag.target && 'bg-accent/60')}>
              <div className="flex h-5 items-center px-1 text-xs text-muted-foreground">
                {panel && !q ? (
                  <button type="button" aria-expanded={!!open} onMouseDown={noFocus} onClick={() => toggle(s.id)}
                    className="flex flex-1 items-center gap-0.5 text-left hover:text-foreground">
                    <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />{s.title}
                  </button>
                ) : <span className="flex-1">{s.title}</span>}
                {s.id !== 'results' && customOrder(s.id) && (
                  <Tip title="Reset order" {...CHROME}>
                    <button type="button" aria-label={`Reset ${s.title} order`} onMouseDown={noFocus} onClick={() => resetShapeSection(s.id)}
                      className="grid size-4 place-items-center rounded-sm hover:text-foreground"><RotateCcw className="size-3" /></button>
                  </Tip>
                )}
              </div>
              {open && (
                <div className={cn('grid gap-0.5', panel ? 'grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))]' : 'grid-cols-7')}>{s.entries.map((x) => tile(s, x))}</div>
              )}
              {open && !s.entries.length && (
                <div className="px-1 pb-1 text-xs text-muted-foreground">
                  {s.id === 'favourites' ? 'Drop here to add to favourites' : panel ? 'Drag selected items here, or right-click, Create prefab...' : 'Select items, right-click, Create prefab...'}
                </div>
              )}
            </section>
          );
        })}
        {!sections.length && <div className="px-1 py-2 text-sm text-muted-foreground">No shape found.</div>}
      </div>
      {menu && (
        <PointerMenu at={menu.at} board={board} onClose={() => setMenu(null)}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const { dialog, confirm } = getState();
            if (!dialog && !confirm) focusRef(menu.x.ref);
          }}>
          <DropdownMenuItem onSelect={() => toggleShapeFavourite(menu.x.ref)}>
            <Star />{menu.section === 'favourites' ? 'Remove from favourites' : 'Add to favourites'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={m?.[0] === menu.x.ref} onSelect={() => step(menu.x.ref, menu.section, -1)}>
            <ArrowLeft />Move earlier<DropdownMenuShortcut>Alt+Left</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={m?.at(-1) === menu.x.ref} onSelect={() => step(menu.x.ref, menu.section, 1)}>
            <ArrowRight />Move later<DropdownMenuShortcut>Alt+Right</DropdownMenuShortcut>
          </DropdownMenuItem>
          {menu.x.prefab && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => renamePrefab(menu.x.prefab.id)}><Pencil />Rename...</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => duplicatePrefab(menu.x.prefab.id)}><CopyPlus />Duplicate</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => removePrefab(menu.x.prefab.id)}><Trash2 />Delete...</DropdownMenuItem>
            </>
          )}
        </PointerMenu>
      )}
    </div>
  );
}

const CHECKER = 'repeating-conic-gradient(#8a8ca0 0 25%, #d0d0da 0 50%) 0 0 / 6px 6px'; // transparent

/** The 10 style presets (§6d) as paired swatches (fill inside, line around): a click sets a shape's fill, line and label
 * colours (the transparent pair: no fill), or with `connector` a connector's line colour. */
export function PresetRow({ set, connector }) {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return (
    <div className="grid w-max grid-cols-5 gap-1" role="group" aria-label="Style presets">
      {stylePresets(theme).map((p, k) => {
        const title = `Style ${k + 1}`;
        const patch = connector ? { color: p.stroke }
          : { color: p.stroke, textColor: p.text, ...(p.fill === 'transparent' ? { fill: 'none' } : { fill: 'solid', fillColor: p.fill }) };
        return (
          <Tip key={title} title={title} {...CHROME}>
            <button type="button" aria-label={title} onMouseDown={keepFocus} onClick={() => set(patch)}
              className="size-5 rounded-sm border-2 hover:ring-2 hover:ring-ring/50"
              style={{ background: p.fill === 'transparent' ? CHECKER : p.fill, borderColor: p.stroke }} />
          </Tip>
        );
      })}
    </div>
  );
}

/** Rotate (+90°) and the angle field (0–359°) of the selected shapes; `value`: the one selected shape's angle. A typed angle
 * applies at once (the history merges quick changes); Enter or Escape hands the focus back to the board. */
export function RotateControls({ board, value = 0 }) {
  const [text, setText] = useState(String(Math.round(value)));
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(String(Math.round(value)));
  }, [value]);
  const type = (v) => {
    setText(v);
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) board.rotate(0, ((Math.round(n) % 360) + 360) % 360);
  };
  return (
    <div className={PAIR}>
      <Tip title={withKey('Rotate 90 degrees', 'board.rotate')} {...CHROME}>
        <Button variant="ghost" size="icon-sm" aria-label="Rotate 90 degrees" onClick={() => { board.rotate(90); board.focus(); }}><RotateCw /></Button>
      </Tip>
      <Tip title="Angle in degrees" {...CHROME}>
        <Input type="number" min={0} max={359} step={1} aria-label="Angle" value={text} className="h-8 w-16 px-2 text-sm"
          onFocus={() => { typing.current = true; }} onBlur={() => { typing.current = false; setText(String(Math.round(value))); }}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); board.focus(); } }} />
      </Tip>
    </div>
  );
}

/** Shape, line colour, width, style, fill and fill colour of the shape tool (`live`; its shape list has prefabs) or a selected
 * shape (`strokeFirst`: line colour, width and style before the shape, as in the quick tools island). */
export function ShapeControls({ board, value, set, live, strokeFirst }) {
  const shape = <ShapePicker board={board} value={value.shape} onChange={(shape) => set({ shape })} prefabs={live} />;
  return (
    <>
      {!strokeFirst && shape}
      <StrokeControls board={board} value={value} set={set} live={live} />
      {strokeFirst && shape}
      <div className={PAIR}>
        <FillSelect board={board} value={value} set={set} />
        <ColorSwatch board={board} title="Fill colour" value={value.fillColor} live={live} onChange={(fillColor) => set({ fillColor })} />
      </div>
    </>
  );
}

/** A shape's or the shape tool's fill (none, filled, hatched). */
export function FillSelect({ board, value, set }) {
  return <OptionSelect board={board} title="Fill" className="w-30" value={value.fill} options={FILL_OPTIONS} onChange={(fill) => set({ fill })} />;
}

// --- flowcharts (§6d): connectors and labels ---

const ROUTE_OPTIONS = [['straight', 'Straight', 'M3 13L13 3'], ['ortho', 'Elbow', 'M2 12H8V4H14'], ['curve', 'Curve', 'M2 13C2 5 14 11 14 3']]
  .map(([v, label, d]) => [v, label, undefined, <svg viewBox="0 0 16 16" strokeWidth="1.5" {...PREVIEW}><path d={d} /></svg>]);
const DASH_OPTIONS = [['solid', 'Solid', undefined], ['dashed', 'Dashed', '4 3'], ['dotted', 'Dotted', '0.1 3']]
  .map(([v, label, dash]) => [v, label, undefined, <svg viewBox="0 0 16 16" strokeWidth="2" strokeDasharray={dash} {...PREVIEW}><path d="M2 8H14" /></svg>]);
// Line jumps (§6d): the horizontal line crossing over the vertical one.
const JUMP_OPTIONS = [['none', 'No jumps', 'M2 8H14'], ['arc', 'Arc', 'M2 8H5A3 3 0 0 1 11 8H14'], ['gap', 'Gap', 'M2 8H5M11 8H14']]
  .map(([v, label, d]) => [v, label, undefined, <svg viewBox="0 0 16 16" strokeWidth="1.5" {...PREVIEW}><path d="M8 2V14" /><path d={d} /></svg>]);
export const HEAD_LABELS = {
  none: 'None', arrow: 'Arrow', triangle: 'Triangle', 'triangle-open': 'Open triangle', diamond: 'Diamond', 'diamond-open': 'Open diamond',
  circle: 'Circle', 'circle-open': 'Open circle', bar: 'Bar', cross: 'Cross', one: 'One', many: 'Many', 'one-many': 'One or many',
  'zero-one': 'Zero or one', 'zero-many': 'Zero or many', 'exactly-one': 'Exactly one',
};

/** A head kind on a stub of line, drawn by the board's own headPath: pointing right (`end`) or left (the start head). */
function HeadPreview({ kind, end }) {
  const w = 1.5;
  const { d, fill } = headPath(kind, end ? { x: 22, y: 8, a: 0 } : { x: 2, y: 8, a: 180 }, w);
  const trim = headTrim(kind, w);
  return (
    <svg viewBox="0 0 24 16" strokeWidth={w} {...PREVIEW} className="h-4 w-6 shrink-0 text-foreground">
      <path d={end ? `M1 8H${22 - trim}` : `M${2 + trim} 8H23`} />
      {d && <path d={d} fill={fill ? 'currentColor' : 'none'} strokeWidth={fill ? 1 : w} />}
    </svg>
  );
}

/** One connector end's head: a button showing it; its popover holds the 16 kinds. */
export function HeadSelect({ board, title, end, value, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip title={title} {...CHROME}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" aria-label={title} className="px-1.5"><HeadPreview kind={value} end={end} /></Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent {...CHROME} className="grid w-auto grid-cols-4 gap-0.5 p-1" onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={refocus(board)}>
        {HEADS.map((kind) => (
          <Tip key={kind} title={HEAD_LABELS[kind]} {...CHROME}>
            <Toggle size="sm" aria-label={HEAD_LABELS[kind]} pressed={kind === value} onPressedChange={() => { setOpen(false); onChange(kind); }}>
              <HeadPreview kind={kind} end={end} />
            </Toggle>
          </Tip>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Route, start and end heads, line colour, width and style, dash and line jumps of the connector tool or a selected
 * connector (`strokeFirst`: line colour, width and style first, as in the quick tools island; `headsFirst`: the heads before
 * the route, as in the ribbon). */
export function ConnectorControls({ board, value, set, live, strokeFirst, headsFirst }) {
  const heads = value.heads ?? { start: 'none', end: 'arrow' };
  const stroke = <StrokeControls board={board} value={value} set={set} live={live} />;
  const headPair = (
    <div className={PAIR}>
      <HeadSelect board={board} title="Start head" value={heads.start} onChange={(start) => set({ heads: { ...heads, start } })} />
      <HeadSelect board={board} title="End head" end value={heads.end} onChange={(kind) => set({ heads: { ...heads, end: kind } })} />
    </div>
  );
  return (
    <>
      {strokeFirst && stroke}
      {headsFirst && headPair}
      <OptionSelect board={board} title="Route" className="w-30" value={value.route ?? 'ortho'} options={ROUTE_OPTIONS} onChange={(route) => set({ route })} />
      {!headsFirst && headPair}
      {!strokeFirst && stroke}
      <OptionSelect board={board} title="Line dash" className="w-28" value={value.dash ?? 'solid'} options={DASH_OPTIONS} onChange={(dash) => set({ dash })} />
      <OptionSelect board={board} title="Line jumps" className="w-32" value={value.jump ?? 'none'} options={JUMP_OPTIONS} onChange={(jump) => set({ jump })} />
    </>
  );
}

const ALIGNS = [['left', 'Align left', AlignLeft], ['center', 'Align centre', AlignCenter], ['right', 'Align right', AlignRight]];
const VALIGNS = [['top', 'Top', AlignVerticalJustifyStart], ['middle', 'Middle', AlignVerticalJustifyCenter], ['bottom', 'Bottom', AlignVerticalJustifyEnd]];

function IconGroup({ value, items, onChange }) {
  return (
    <ToggleGroup type="single" size="sm" value={value} onValueChange={(v) => v && onChange(v)}>
      {items.map(([v, title, Icon]) => (
        <Tip key={v} title={title} {...CHROME}>
          <ToggleGroupItem value={v} aria-label={title} className="px-1.5"><Icon /></ToggleGroupItem>
        </Tip>
      ))}
    </ToggleGroup>
  );
}

/** A label's size (post px), text colour and bold; with `align`, a shape label's alignment and vertical alignment too. */
export function LabelControls({ board, value, set, align }) {
  return (
    <>
      <OptionSelect board={board} title="Label size" className="w-22" value={value.size}
        options={withValue(TEXT_SIZES, value.size).map((s) => [s, `${s} px`])} onChange={(v) => set({ size: Number(v) })} />
      <ColorSwatch board={board} title="Label colour" value={value.textColor} onChange={(textColor) => set({ textColor })} />
      <Tip title="Bold" {...CHROME}>
        <Toggle size="sm" aria-label="Bold label" pressed={!!value.bold} onPressedChange={() => set({ bold: !value.bold })}><Bold /></Toggle>
      </Tip>
      {align && <IconGroup value={value.align} items={ALIGNS} onChange={(a) => set({ align: a })} />}
      {align && <IconGroup value={value.valign} items={VALIGNS} onChange={(valign) => set({ valign })} />}
    </>
  );
}

/** An icon button opening a popover of more controls (Label, Labels), which keeps the ribbon short. */
export function PopoverButton({ board, title, icon, children }) {
  return (
    <Popover>
      <Tip title={title} {...CHROME}>
        <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={title}>{icon}</Button></PopoverTrigger>
      </Tip>
      <PopoverContent {...CHROME} className="flex w-auto flex-wrap items-center gap-1 p-2" onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={refocus(board)}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

const SLOTS = [['start', 'Source'], ['mid', 'Middle'], ['end', 'Target']];

/** A selected connector's three labels: one row per slot (on / off, Edit); the chosen row's style below. */
export function LabelsPanel({ board, item }) {
  const [slot, setSlot] = useState('mid');
  const labels = item.labels ?? {};
  return (
    <div className="flex w-60 flex-col gap-1">
      {SLOTS.map(([s, name]) => (
        <div key={s} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1', s === slot && 'bg-accent')} onClick={() => setSlot(s)}>
          <Switch checked={!!labels[s]} aria-label={`${name} label`} onCheckedChange={(on) => { setSlot(s); board.toggleLabel(s, on); }} />
          <span className="flex-1 text-sm">{name}</span>
          <Button variant="ghost" size="xs" onClick={() => board.editLabel(item.id, s)}>Edit</Button>
        </div>
      ))}
      {labels[slot] && (
        <div className="flex items-center gap-1 border-t pt-1.5">
          <LabelControls board={board} value={labels[slot]} set={(patch) => { board.setLabel(slot, patch); board.focus(); }} />
        </div>
      )}
    </div>
  );
}

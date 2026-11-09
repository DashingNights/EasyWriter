import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import {
  AlignCenter, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowLeft, ArrowRight, Baseline, Bold,
  ChevronDown, CopyPlus, Package, PaintBucket, Pencil, PenLine, RotateCcw, RotateCw, Star, Trash2, Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectButton, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { fontLabel, fontsNow, listFonts } from '../../../document/fonts.js';
import { FONTS } from '../../../format.mjs';
import { fontStack } from '../../../office.mjs';
import { HEADS } from '../../../flow/model.mjs';
import { headPath, headTrim } from '../../../flow/route.mjs';
import { SHAPE_SECTIONS, stylePresets } from '../../../flow/shapes.mjs';
import { bindColors, ColorPick } from '../../../tooling/kit/ColorPick.jsx';
import { ColorSwatch as KitSwatch, recentColors, saveRecentColors } from '../../../tooling/kit/ColorPicker.jsx';
import { Spin } from '../../../tooling/kit/controls.jsx';
import { FontPick, SizePick } from '../../../tooling/kit/FontPick.jsx';
import { SplitButton, ToggleGroup } from '../../../tooling/ribbon/parts.jsx';
import { run } from '../../../tooling/registry.js';
import { kindEntry, LINE_KINDS, lineSection, lineSlug, shapeName } from '../../../tooling/shape-picker.mjs';
import { ShapeIcon, ShapeList } from '../../../tooling/ShapePicker.jsx';
import {
  activeBoard, fillable, FILLS, NOTE_COLORS, PEN_STYLES, PEN_WIDTHS, resolveBg, TEXT_SIZES, validFont,
} from '../../../whiteboard.js';
import {
  armPrefab, createPrefab, customOrder, dropShape, duplicatePrefab, prefabList, prefabTile, removePrefab, renamePrefab, resetShapeSection,
  shapeLayout, toggleShapeFavourite, usePrefabs,
} from '../../prefabs.js';
import { withKey } from '../../keybinds.js';
import { getState, useStore } from '../../store.js';
import { IconButton, Tip } from '../Tip.jsx';
import { PointerMenu } from './BoardMenu.jsx';

// Shared pieces of the board chrome (§6c): the rail, its flyouts and the item ribbon.

/** Marks chrome outside a board's DOM (incl. Radix portals): focus moving there never ends a text edit. */
export const CHROME = { 'data-board-chrome': '' };

/** onMouseDown of chrome bars: buttons and backgrounds never take focus, so the board (or the edited text with its caret)
 * keeps it. Text fields (sizes, the angle) do take focus. */
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
 * user has moved it elsewhere meanwhile, or into a dialog the popup opened (More Colors), which gives it back when it closes. */
export const refocus = (board) => (e) => {
  e.preventDefault();
  const a = document.activeElement;
  if (!a || a === document.body || (a.closest('[data-board-chrome]') && !a.closest('[role=dialog]'))) board?.focus();
};

/** The kit's colour swatch (tooling/kit/ColorPicker.jsx) in the board chrome: its tooltip and popover carry the chrome mark, so a
 * text edit stays open while the picker has the focus, and closing gives the focus back to `board` (with none, to the swatch). */
export function ColorSwatch({ board, ...props }) {
  return <KitSwatch {...props} tipProps={CHROME} contentProps={{ ...CHROME, ...(board && { onCloseAutoFocus: refocus(board) }) }} />;
}

// --- The board's kit pickers (docs/plans/cleanup/tool-pool-surfaces.md B3): colours, fonts, sizes, toggles ---

// The board's own colours: the kit's colour panel draws them as its standard row (no Office theme grid), with the swatches'
// recent colours and a typed hex.
const BOARD_COLORS = [['#000000', 'Black'], ['#ffffff', 'White'], ['#8a8ca0', 'Grey'], ['#e05252', 'Red'], ['#f08c3c', 'Orange'],
  ['#f2c94c', 'Yellow'], ['#4caf50', 'Green'], ['#26a69a', 'Teal'], ['#4a7fe0', 'Blue'], ['#9c6ade', 'Purple']];
const TRANSPARENT = ['#00000000', 'Transparent'];
bindColors('board', { theme: () => null, recent: recentColors, saveRecent: saveRecentColors });

/** Props of a kit popup in the board chrome: the chrome mark (focus there keeps the board and a text edit), no focus on open,
 * and the focus back to `board` on close. */
const popup = (board) => ({ ...CHROME, onOpenAutoFocus: (e) => e.preventDefault(), onCloseAutoFocus: refocus(board) });

/** A board colour (the kit's ColorPick as a toolbar button with a colour bar): the board's colours, the recent ones and a typed
 * hex; `byTheme` offers null ("By theme": the ink that reads on what it sits on), `transparent` a see-through colour. `alpha`
 * (a fill or a stroke, which the board stores as '#rrggbbaa'; every fill with `transparent`) lets More Colors pick an opacity. */
export function BoardColor({ board, title, icon, value, onChange, byTheme = false, transparent = false, alpha = transparent }) {
  return (
    <ColorPick format="board" value={value ?? null} onChange={(hex) => onChange(hex)} automatic={byTheme ? 'By theme' : null} theme={null}
      standard={transparent ? [...BOARD_COLORS, TRANSPARENT] : BOARD_COLORS} eyedropper alpha={alpha} icon={icon} label={title}
      contentProps={popup(board)} />
  );
}

/** The board's fonts: the forum post's (format.mjs FONTS), then the families the Document's Font box lists (fonts.js: Word's
 * curated list and the installed ones) that are not among them; "Default" (no `font`) first. Each is named and drawn as in a
 * Document: an open font that stands in for a missing one first ("Carlito (Calibri)"), and the row in the stack that draws it. */
const fontOption = (f, group, label = fontLabel(f)) => ({ id: f, label, css: fontStack(f), group });
const fontOptions = (more) => {
  const forum = FONTS.map(({ label, css }) => fontOption(css, 'Forum fonts', label === css ? undefined : label));
  return [{ id: '', label: 'Default' }, ...forum,
    ...more.filter((f) => validFont(f) && !forum.some((o) => o.id === f)).map((f) => fontOption(f, 'More fonts'))];
};

/** A text item's or shape label's font family (item field `font`; absent: the board's font). `mixed`: the selection differs. */
export function BoardFont({ board, value, mixed, onChange }) {
  const [more, setMore] = useState(fontsNow);
  return (
    <Tip title="Font" {...CHROME}>
      <FontPick size="sm" className="w-36" value={mixed ? null : value ?? ''} placeholder={mixed ? '' : 'Default'} options={fontOptions(more)}
        onOpen={() => listFonts().then(setMore)} onDone={() => board.focus()} contentProps={CHROME}
        onChange={(f) => (!f ? onChange(null) : validFont(f) && onChange(f))} />
    </Tip>
  );
}

/** Bold, alignment or vertical alignment as the kit's toggle group: `items` [[value, label, Icon]]; `value` the active one.
 * At 32 px, the height of the board controls beside it (the ribbon keeps its own 22 px). */
export function Toggles({ label, items, value, onChange }) {
  return (
    <ToggleGroup label={label} size="regular" items={items.map(([v, l, icon]) => ({ id: `board-${label.toLowerCase().replace(/ /g, '-')}-${v}`, label: l, icon,
      active: value === v, onClick: () => onChange(v) }))} />
  );
}

// Small previews in the option lists (and the trigger), drawn in the text colour.
const PREVIEW = { className: 'size-4 shrink-0 text-foreground', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };

// The shape icon is the shape picker's (src/tooling/ShapePicker.jsx); the rail, layers and tool search take it from here.
export { ShapeIcon };
const WidthPreview = ({ width }) => (
  <svg viewBox="0 0 16 16" strokeWidth={1 + (width - 1) * 0.5} {...PREVIEW}>{width > 0 && <path d="M3 8H13" />}</svg>
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

/** An icon gallery over [value, label, colour?, preview] options, as the kit's head gallery (HeadSelect): the button shows the
 * chosen option's preview, its menu every option as an icon tile named by its tooltip. */
export function IconGallery({ board, title, value, options, onChange }) {
  const shown = options.find(([v]) => String(v) === String(value));
  return (
    <DropdownMenu>
      <IconButton size="regular" label={title} slot={DropdownMenuTrigger} tip={CHROME} onMouseDown={keepFocus} className="w-auto gap-0.5 px-1.5">
        {shown?.[3]}<ChevronDown className="size-3 opacity-70" />
      </IconButton>
      <DropdownMenuContent {...CHROME} data-board-gallery={title} align="start" className="grid min-w-0 gap-0.5 p-0.5"
        style={{ gridTemplateColumns: `repeat(${options.length}, auto)` }} onCloseAutoFocus={refocus(board)}>
        {options.map(([v, label, , preview]) => (
          <Tip key={v} title={label} {...CHROME}>
            <DropdownMenuItem role="menuitemradio" aria-checked={v === shown?.[0]} aria-label={label} onSelect={() => onChange(v)}
              className="size-8 justify-center p-0 aria-checked:bg-accent [&_svg]:size-5">
              {preview}
            </DropdownMenuItem>
          </Tip>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A text or label size in px (the kit's SizePick): any whole size from 1 to 999 typed (Enter), or TEXT_SIZES from its list.
 * Enter, Escape or a picked size hands the focus back to the board. */
export function SizeSelect({ board, title, value, onChange, className }) {
  const take = (v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= 999) onChange(n);
  };
  return (
    <Tip title={title} {...CHROME}>
      <SizePick size="sm" aria-label={title} inputMode="numeric" unit="px" className={className} value={value} options={TEXT_SIZES} onChange={take}
        onDone={() => board.focus()} contentProps={CHROME} />
    </Tip>
  );
}

/** Colour, width and style of the pen, the shape tool or a selected stroke / shape (`value`); `set(patch)` applies. A selected
 * item (`opacity`) shows its opacity from 0 to 100 % in place of the pen's styles. A shape (`noLine`) can have no line, width 0,
 * the flat default. */
// Colour swatches sit in a row with their select (PAIR), so a stacked layout (the rail flyout) keeps them together.
const PAIR = 'flex items-center gap-1';

export function StrokeControls({ board, value, set, byTheme, opacity, noLine }) {
  return (
    <>
      <div className={PAIR}>
        <BoardColor board={board} title="Line colour" icon={<PenLine />} value={value.color} byTheme={byTheme} alpha onChange={(color) => set({ color })} />
        <OptionSelect board={board} title="Line width" className="w-24" value={value.width}
          options={withValue(noLine ? [0, ...PEN_WIDTHS] : PEN_WIDTHS, value.width).map((w) => [w, w ? `${w} px` : 'No line', undefined, <WidthPreview width={w} />])}
          onChange={(v) => set({ width: Number(v) })} />
      </div>
      {opacity ? <OpacityBox board={board} value={value.opacity} />
        : <IconGallery board={board} title="Line style" value={value.opacity} options={STYLE_OPTIONS} onChange={(opacity) => set({ opacity })} />}
    </>
  );
}

/** The selected items' opacity (field `opacity`, 0 to 1) as 0 to 100 % in the kit's spin box. A typed value applies at once (the
 * history merges quick changes) and the focus stays in the box, so the next digit goes there too (the ribbon's own setter hands the
 * focus to the board); Enter or Escape hands it back. */
export function OpacityBox({ board, value = 1 }) {
  return (
    <div className="text-xs" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); board.focus(); } }}>
      <Spin label="Opacity" unit="pct" min={0} max={100} width="4.5rem" value={Math.round(value * 100)} onChange={(n) => board.setItem({ opacity: Math.round(n) / 100 })} />
    </div>
  );
}

// The board's shape list sections (§6d, §6g): Favourites, Word's Lines and the library's other sections, Prefabs (shape-list.mjs
// shapeSections); the shape panel's also Text & notes.
const SECTION_TITLES = {
  ...Object.fromEntries(SHAPE_SECTIONS.map((s) => [s.id, s.title])), favourites: 'Favourites', prefabs: 'Prefabs', text: 'Text & notes',
};
const noFocus = (e) => e.preventDefault();

// Shape panel tiles beyond kinds, lines and prefabs: text / notes (a click arms Text with that note colour). `what`: what a drop adds
// (Board.spawnItems).
const TEXT_TILES = [
  { ref: 'text:', label: 'Text', keywords: ['text', 'label', 'type', 'words'], what: { note: null }, icon: <Type className="size-5" /> },
  ...NOTE_COLORS.filter(([c]) => c).map(([c, label]) => ({
    ref: `text:${c}`, label, keywords: ['note', 'sticky', 'post-it', 'comment', 'text'], what: { note: c },
    icon: <span className="grid size-5 place-items-center rounded-sm border text-xs font-semibold text-black" style={{ background: c }}>T</span>,
  })),
];

/** What a shape list tile adds to `board` (Board.spawnItems): a kind, a prefab's items (loaded: a promise), a line's connector
 * (a pen line adds nothing) or a text / note. */
const tileWhat = (board, x) => (x.kind ? { kind: x.kind } : x.prefab ? prefabTile(board, x.prefab.id) : x.line ? x.line.conn && { conn: x.line.conn } : x.what);
// A tile the user keeps in the list's sections (a kind or a prefab: starred, reordered, its entry menu); lines and text are fixed.
const own = (x) => !!(x.kind || x.prefab);

/** A shape panel tile's click (§6g): arms `board`'s tool with tile `x` (a kind or a prefab: the shape tool; a line: its pool
 * command, the connector tool with its route and heads or the pen; text / a note: Text with that note colour). */
export function armTile(board, x) {
  board.focus(); // the board the commands act on (ctx.board) is the focused one
  if (x.kind) run(`board.shape.${x.kind}`);
  else if (x.line) run(`board.lines.${lineSlug(x.id)}`);
  else if (x.prefab) armPrefab(board, x.prefab.id);
  else board.setMode('text', { note: x.what.note });
}

/** A prefab's thumbnail on the post background (its items are drawn on a transparent one), or a generic icon. */
function PrefabThumb({ prefab, className = 'h-10 w-full' }) {
  if (!prefab?.thumb) return <Package className={cn('text-muted-foreground', className)} />;
  const bg = resolveBg('post', document.documentElement.dataset.theme);
  return <img src={prefab.thumb} alt="" draggable={false} className={cn('rounded-sm object-contain', className)} style={{ background: bg }} />;
}

/** The shape button (§6d, §6g): it shows the kind (`value`) or the armed prefab; its popover holds the shape picker
 * (BoardShapeList). `prefabs`: the shape tool's list (Lines and Prefabs: a line tile arms its tool, a prefab tile the shape tool);
 * without it (a selected shape's ribbon, like Word's Change Shape) only kinds show. `openAt` 'prefabs': opens at once, scrolled to
 * Prefabs. */
export function ShapePicker({ board, value, onChange, prefabs = false, openAt = null }) {
  const [open, setOpen] = useState(!!openAt);
  const armed = useSnapshot(prefabs ? board : null)?.prefab ?? null;
  const prefab = armed && prefabList().find((p) => p.id === armed);
  const pick = (ref, x) => {
    setOpen(false);
    if (x.line) armTile(board, x);
    else if (ref.startsWith('kind:')) onChange(ref.slice(5));
    else armPrefab(board, ref.slice(7));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip title="Shape" {...CHROME}>
        <PopoverTrigger asChild>
          <SelectButton aria-label="Shape" className="w-42">
            <span className="flex min-w-0 items-center gap-1.5">
              {prefab ? <PrefabThumb prefab={prefab} className="size-4" /> : <ShapeIcon shape={value} />}
              <span className="truncate">{prefab ? prefab.name : shapeName(value)}</span>
            </span>
          </SelectButton>
        </PopoverTrigger>
      </Tip>
      <PopoverContent {...CHROME} align="start" className="w-auto p-1.5" onCloseAutoFocus={refocus(board)}>
        <BoardShapeList board={board} current={armed ? `prefab:${armed}` : `kind:${value}`} tools={prefabs} openAt={openAt} pick={pick}
          close={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** The board's shape list (the popover's, and the shape panel's with `panel`): the shape picker (tooling ShapePicker.jsx, its
 * search, tiles and keys) over Favourites, the library's sections in the user's order and, with `tools` (a list that arms tools),
 * Word's Lines (shape-picker.mjs; the board's own Line and Arrow kinds are two of them, so they are listed nowhere else) and Prefabs;
 * `current`: the pressed tile's ref; `pick(ref, entry)`: a tile's click. What the board adds: a star on each tile; Alt+arrows
 * move the focused tile within its section; right-click, Shift+F10 or the context-menu key open its entry menu. Tiles drag
 * (after 4 px): within their section to reorder, into Favourites (starred there), a favourite onto another section
 * (unstarred), out of the list over the board (a ghost of what it adds follows the pointer; released over the board: added
 * centred there). A double-click adds it at the centre of the visible board. Panel: folding sections (`closed`: the ids of the
 * folded ones, `toggle(id)`), Text & notes, and board items dragged onto Prefabs make a prefab. */
export function BoardShapeList({ board, current, tools, openAt, pick, close, panel = false, closed = [], toggle }) {
  usePrefabs();
  useStore((s) => s.settings?.shapeFavourites);
  useStore((s) => s.settings?.shapeOrder);
  const [drag, setDrag] = useState(null); // {ref, section?, target?, after?} while a tile is dragged
  const [menu, setMenu] = useState(null); // {x, section, at} while a tile's entry menu is open
  const list = useRef(null);
  const prefabs = tools ? prefabList() : [];
  const byId = new Map(prefabs.map((p) => [p.id, p]));
  const entry = (ref) => {
    if (ref.startsWith('kind:')) return LINE_KINDS[ref.slice(5)] ? null : kindEntry(ref.slice(5));
    const p = byId.get(ref.slice(7));
    return p && { ref, prefab: p, label: p.name, keywords: p.keywords, wide: true, icon: <PrefabThumb prefab={p} /> };
  };
  let sections = shapeLayout(prefabs).map((s) => ({ id: s.id, entries: s.id === 'lines' ? (tools ? lineSection().entries : []) : s.refs.map(entry).filter(Boolean) }));
  if (panel) {
    const [favs, ...rest] = sections;
    sections = [favs, ...rest.filter((s) => s.id === 'prefabs'), ...rest.filter((s) => s.id !== 'prefabs'), { id: 'text', entries: TEXT_TILES }];
  }
  const EMPTY = {
    favourites: drag && 'Drop here to add to favourites',
    prefabs: tools && !prefabs.length && (panel ? 'Drag selected items here, or right-click, Create prefab...' : 'Select items, right-click, Create prefab...'),
  };
  sections = sections.map((s) => ({
    ...s, title: SECTION_TITLES[s.id], empty: EMPTY[s.id] || null,
    props: { 'data-drop': s.id, ...(panel && s.id === 'prefabs' && { 'data-board-drop': '' }), className: drag?.section === s.id && !drag.target ? 'bg-accent/60' : undefined },
  }));
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
  // Alt+arrows on a tile: one place earlier or later in its section.
  const onKey = (e, t) => {
    if (!e.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return false;
    e.preventDefault();
    if (t.section !== 'results') step(t.ref, t.section, e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1);
    return true;
  };
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
      } else if (own(x) && to?.section && (to.section === 'favourites' || to.section !== section || to.target)) dropShape(x.ref, to.section, to.target, to.after);
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
    if (!own(x) || section === 'results') return;
    const r = e.currentTarget.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    setMenu({ x, section, at: inside ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom } });
  };
  // Beside each tile: its star (Favourites) and, while a tile is dragged over it, the mark where it would go.
  const decorate = (x, s) => (
    <>
      {own(x) && (
        <button type="button" tabIndex={-1} aria-label={s.id === 'favourites' ? `Remove ${x.label} from favourites` : `Add ${x.label} to favourites`}
          onMouseDown={noFocus} onClick={() => toggleShapeFavourite(x.ref)}
          className={cn('absolute -top-1 -right-1 grid size-4 place-items-center rounded-full border bg-popover text-muted-foreground opacity-0',
            'group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground')}>
          <Star className={cn('size-2.5', s.id === 'favourites' && 'fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400')} />
        </button>
      )}
      {drag?.target === x.ref && <span className={cn('pointer-events-none absolute inset-y-0 w-0.5 rounded bg-ring', drag.after ? '-right-px' : '-left-px')} />}
    </>
  );
  const header = (s) => s.id !== 'results' && customOrder(s.id) && (
    <Tip title="Reset order" {...CHROME}>
      <button type="button" aria-label={`Reset ${s.title} order`} onMouseDown={noFocus} onClick={() => resetShapeSection(s.id)}
        className="grid size-4 place-items-center rounded-sm hover:text-foreground"><RotateCcw className="size-3" /></button>
    </Tip>
  );
  const m = menu && sections.find((s) => s.id === menu.section)?.entries.map((x) => x.ref);
  return (
    <>
      <ShapeList sections={sections} current={current} onPick={(x) => pick(x.ref, x)} layout={panel ? 'panel' : 'popover'} closed={closed} toggle={panel ? toggle : undefined}
        placeholder={panel ? withKey('Search shapes...', 'flows.find') : 'Search shapes...'} listRef={list} tipProps={CHROME} onKey={onKey} decorate={decorate} header={header}
        tileProps={(x, s) => ({ onPointerDown: (e) => startDrag(e, x, s.id), onContextMenu: (e) => openMenu(e, x, s.id), onDoubleClick: () => insert(x) })} />
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
    </>
  );
}

const CHECKER = 'repeating-conic-gradient(#8a8ca0 0 25%, #d0d0da 0 50%) 0 0 / 6px 6px'; // transparent

/** The 10 style presets (§6d) as paired swatches (fill inside, line around): a click gives a shape the preset's flat fill with no
 * line, its line colour kept for a line added later, and its label colour (the transparent pair: no fill, a line in its colour), or
 * with `connector` a connector's line colour. */
export function PresetRow({ set, connector }) {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return (
    <div className="grid w-max grid-cols-5 gap-1" role="group" aria-label="Style presets">
      {stylePresets(theme).map((p, k) => {
        const title = `Style ${k + 1}`;
        const patch = connector ? { color: p.stroke }
          : { color: p.stroke, textColor: p.text, ...(p.fill === 'transparent' ? { fill: 'none', width: 2 } : { fill: 'solid', fillColor: p.fill, width: 0 }) };
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

/** Rotate (+90°, board.items.rotate) and the angle (the kit's spin box, 0–359°) of the selected shapes; `value`: the one
 * selected shape's angle. A typed angle applies at once (the history merges quick changes); Enter or Escape hands the focus
 * back to the board. */
export function RotateControls({ board, value = 0 }) {
  return (
    <div className={PAIR}>
      <IconButton size="regular" label="Rotate 90 degrees" keybind="board.rotate" tip={CHROME} onClick={() => run('board.items.rotate')}>
        <RotateCw />
      </IconButton>
      <div className="text-xs" onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); board.focus(); } }}>
        <Spin label="Angle" unit="int" min={0} max={359} width="4.5rem" value={Math.round(value)}
          onChange={(n) => board.rotate(0, ((Math.round(n) % 360) + 360) % 360)} />
      </div>
    </div>
  );
}

/** Shape, line colour, width, style, fill and fill colour of the shape tool (`live`; its shape list has prefabs) or a selected
 * shape (`strokeFirst`: line colour, width and style before the shape, as in the quick tools island). */
export function ShapeControls({ board, value, set, live, strokeFirst, picker = true }) {
  const shape = picker && <ShapePicker board={board} value={value.shape} onChange={(shape) => set({ shape })} prefabs={live} />;
  return (
    <>
      {!strokeFirst && shape}
      <StrokeControls board={board} value={value} set={set} noLine />
      {strokeFirst && shape}
      {fillable(value.shape) && (
        <div className={PAIR}>
          <FillSelect board={board} value={value} set={set} />
          <BoardColor board={board} title="Fill colour" icon={<PaintBucket />} value={value.fillColor} transparent onChange={(fillColor) => set({ fillColor })} />
        </div>
      )}
    </>
  );
}

/** A shape's or the shape tool's fill (none, filled, hatched). */
export function FillSelect({ board, value, set }) {
  return <IconGallery board={board} title="Fill" value={value.fill} options={FILL_OPTIONS} onChange={(fill) => set({ fill })} />;
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

// Each head kind drawn as an icon component, per end (the split button draws its icon as a component).
const HEAD_ICONS = Object.fromEntries(HEADS.flatMap((kind) => [[`${kind}:start`, () => <HeadPreview kind={kind} />], [`${kind}:end`, () => <HeadPreview kind={kind} end />]]));
const lastHead = { start: 'arrow', end: 'arrow' }; // the kind the main part puts back

/** One connector end's head (the kit's split button): the main part turns the head off, or back on as the kind it had; the arrow
 * opens the 16 kinds. */
export function HeadSelect({ board, title, end, value, onChange }) {
  const side = end ? 'end' : 'start';
  if (value !== 'none') lastHead[side] = value;
  return (
    <SplitButton id={`board-head-${side}`} size="regular" label={title} icon={HEAD_ICONS[`${value}:${side}`]} active={value !== 'none'} onDone={() => board.focus()}
      contentProps={CHROME} onClick={() => onChange(value === 'none' ? lastHead[side] : 'none')}>
      {(close) => (
        <div className="grid grid-cols-4 gap-0.5 p-0.5">
          {HEADS.map((kind) => (
            <Tip key={kind} title={HEAD_LABELS[kind]} {...CHROME}>
              <Toggle size="sm" aria-label={HEAD_LABELS[kind]} pressed={kind === value} onPressedChange={() => { close(); onChange(kind); }}>
                <HeadPreview kind={kind} end={end} />
              </Toggle>
            </Tip>
          ))}
        </div>
      )}
    </SplitButton>
  );
}

/** Whether the line tool's look `line` (a snapshot's `line`) is the Arrow's: a head at either end. Else it is the Line's. */
export const isArrow = (line) => ['start', 'end'].some((k) => (line?.heads?.[k] ?? 'none') !== 'none');

/** Route, start and end heads, line colour, width and style, dash and line jumps of the connector tool or a selected
 * connector (`strokeFirst`: line colour, width and style first, as in the quick tools island; `headsFirst`: the heads before
 * the route, as in the ribbon; `opacity`: a selected item's opacity box in place of the styles). A free line (`value.free`: the
 * Line and Arrow tools, one drawn with them) is always straight: no route and no line jumps. */
export function ConnectorControls({ board, value, set, strokeFirst, headsFirst, opacity }) {
  const heads = value.heads ?? { start: 'none', end: 'arrow' };
  const stroke = <StrokeControls board={board} value={value} set={set} byTheme opacity={opacity} />;
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
      {!value.free && <IconGallery board={board} title="Route" value={value.route ?? 'ortho'} options={ROUTE_OPTIONS} onChange={(route) => set({ route })} />}
      {!headsFirst && headPair}
      {!strokeFirst && stroke}
      <IconGallery board={board} title="Line dash" value={value.dash ?? 'solid'} options={DASH_OPTIONS} onChange={(dash) => set({ dash })} />
      {!value.free && <IconGallery board={board} title="Line jumps" value={value.jump ?? 'none'} options={JUMP_OPTIONS} onChange={(jump) => set({ jump })} />}
    </>
  );
}

export const ALIGNS = [['left', 'Align left', AlignLeft], ['center', 'Align centre', AlignCenter], ['right', 'Align right', AlignRight]];
const VALIGNS = [['top', 'Top', AlignVerticalJustifyStart], ['middle', 'Middle', AlignVerticalJustifyCenter], ['bottom', 'Bottom', AlignVerticalJustifyEnd]];
export const BOLD = [[true, 'Bold', Bold]];

/** A label's size (post px), text colour and bold; with `align`, a shape label's font, alignment and vertical alignment too
 * (`mixed`: the fields a multi-selection differs in). */
export function LabelControls({ board, value, set, align, mixed = [] }) {
  return (
    <>
      <SizeSelect board={board} title="Label size" className="w-22" value={value.size} onChange={(size) => set({ size })} />
      <BoardColor board={board} title="Label colour" icon={<Baseline />} value={value.textColor} byTheme onChange={(textColor) => set({ textColor })} />
      {align && <BoardFont board={board} value={value.font} mixed={mixed.includes('font')} onChange={(font) => set({ font })} />}
      <Toggles label="Bold" items={BOLD} value={!!value.bold} onChange={() => set({ bold: !value.bold })} />
      {align && <Toggles label="Alignment" items={ALIGNS} value={value.align} onChange={(a) => set({ align: a })} />}
      {align && <Toggles label="Vertical alignment" items={VALIGNS} value={value.valign} onChange={(valign) => set({ valign })} />}
    </>
  );
}

/** An icon button opening a popover of more controls (Label, Labels), which keeps the ribbon short. */
export function PopoverButton({ board, title, icon, children }) {
  return (
    <Popover>
      <IconButton size="regular" label={title} slot={PopoverTrigger} tip={CHROME}>{icon}</IconButton>
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
        <div key={s} className={cn('flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60', s === slot && 'bg-accent hover:bg-accent')} onClick={() => setSlot(s)}>
          <Checkbox checked={!!labels[s]} aria-label={`${name} label`} onCheckedChange={(v) => { setSlot(s); board.toggleLabel(s, v === true); }} />
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

// The one shape picker (docs/plans/word/briefs/shape-picker.md): a search box over sections of shape tiles, drawn alike in Word's
// Insert Shapes and Change Shape dropdowns (src/document/wp/shapes), the board's shape list and the flowchart editor's shape panel
// (src/app/components/board/controls.jsx BoardShapeList). Hosts pass the sections (shape-picker.mjs builds the library's and Word's
// Lines) and add their own parts: Word its Recently Used Shapes row and text boxes; the board its favourites, prefabs, drags and
// entry menus.
import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronRight, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { Tip } from '../app/components/Tip.jsx';
import { headPath } from '../flow/route.mjs';
import { iconOf, kindOf } from '../flow/shapes.mjs';
import { shapeGeometry } from '../whiteboard.js';
import { LINE_SHAPES, shownSections } from './shape-picker.mjs';

const PREVIEW = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' };
// A kind's icon box: its click-placed size (circles, the bar), a swimlane large enough to show its band, else square (basic
// kinds) or 3 : 2.
const previewBox = (k) => (k?.kind === 'lane' ? [150, 100] : k?.box ?? (k?.group === 'basic' ? [48, 48] : [60, 40]));

/** Shape kind `shape` drawn with its own geometry (iconOf; whiteboard.js draws the line, arrow and bubbles), in the text colour,
 * a 1.5 px line at any size. */
export function ShapeIcon({ shape, className = 'size-4' }) {
  const [w, h] = previewBox(kindOf(shape));
  const { d, head } = iconOf(shape, w, h, Math.max(w, h) / 24) ?? shapeGeometry({ shape, w, h, width: Math.max(w, h) / 12 });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} overflow="visible" {...PREVIEW} strokeWidth="1.5" className={cn('shrink-0 text-foreground', className)}>
      <path d={d} vectorEffect="non-scaling-stroke" />
      {head && <path d={head} fill="currentColor" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

// Word's Lines in a 40 x 32 box: a connector's route with its ends ([x, y, the direction a head there points, degrees]), the pen's
// stroke per entry.
const ROUTES = {
  straight: ['M6 26L34 6', [6, 26, 144.5], [34, 6, -35.5]],
  ortho: ['M6 26H20V6H34', [6, 26, 180], [34, 6, 0]],
  curve: ['M6 26C22 26 18 6 34 6', [6, 26, 180], [34, 6, 0]],
};
const STROKES = {
  Curve: 'M5 24C9 8 17 6 20 16S31 26 35 8',
  'Freeform: Shape': 'M8 27L5 11L18 5L22 17L34 9L33 27Z',
  'Freeform: Scribble': 'M5 20C8 6 14 6 13 16S17 28 22 16S28 4 31 12S33 24 36 20',
};

/** Lines entry `name` (shape-picker.mjs LINE_SHAPES) drawn as its connector, its heads drawn as the board draws them, or as a pen
 * stroke; in the text colour, a 1.5 px line at any size. */
export function LineIcon({ name, className = 'size-4' }) {
  const c = LINE_SHAPES[name]?.conn;
  const [d, start, end] = c ? ROUTES[c.route] : [STROKES[name] ?? STROKES.Curve];
  const heads = c ? [[c.heads.start, start], [c.heads.end, end]].filter(([k]) => k !== 'none').map(([k, [x, y, a]]) => headPath(k, { x, y, a }, 1.5)) : [];
  return (
    <svg viewBox="0 0 40 32" overflow="visible" {...PREVIEW} strokeWidth="1.5" className={cn('shrink-0 text-foreground', className)}>
      <path d={d} vectorEffect="non-scaling-stroke" />
      {heads.map((h, i) => <path key={i} d={h.d} fill={h.fill ? 'currentColor' : 'none'} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** The picker. `sections` [{id, title, entries, empty?, props?}]: entries {ref, label, keywords, kind?, line?, id?, icon?, wide?}; a
 * section without entries shows only with its `empty` hint; `props` go on its element. `current`: the pressed tile's ref;
 * `onPick(entry, section)`: a tile's click.
 * `layout`: 'popover' (a compact grid), 'panel' (fills its column; with `toggle(id)` the sections fold, `closed` the folded ones) or
 * 'menu' (a ribbon dropdown: named tiles, the sections in a column beside them to jump to, the search focused on open).
 * Keys: typing searches (one Results section, best first), Enter picks the focused tile (in the search, the best match), arrows
 * move between tiles (Up from the top row: the search; Down from the search: the first tile). A host's additions: `onKey(e, tile)`
 * sees a tile's keys first (true: handled; tile = its dataset {ref, section}), `tileProps(entry, section)` go on each tile,
 * `decorate(entry, section)` draws beside it, `header(section)` at the end of a section's heading, `tipProps` on each tooltip,
 * and `listRef` gets the scrolling list. */
export function ShapeList({
  sections, current, onPick, layout = 'popover', closed = [], toggle, placeholder = 'Search shapes...', autoFocus = layout === 'menu',
  onKey, tileProps, decorate, header, tipProps, listRef,
}) {
  const [query, setQuery] = useState('');
  const root = useRef(null);
  const own = useRef(null);
  const list = listRef ?? own;
  const search = useRef(null);
  const altUsed = useRef(false);
  const q = query.trim();
  const shown = shownSections(sections, q);
  const byRef = new Map(shown.flatMap((s) => s.entries.map((e) => [e.ref, [e, s]])).reverse()); // the first tile of each ref wins
  const choose = (ref) => byRef.has(ref) && onPick(...byRef.get(ref));
  // After a menu has put the focus on itself: the search box takes it, so typing searches.
  useEffect(() => {
    if (autoFocus) requestAnimationFrame(() => search.current?.focus());
  }, []);

  const onKeyDown = (e) => {
    if (!root.current?.contains(e.target)) return; // a host's portal (an entry menu): React bubbles its keys here
    const tiles = [...list.current.querySelectorAll('[data-ref]')];
    const i = tiles.indexOf(document.activeElement);
    if (i >= 0 && onKey?.(e, tiles[i].dataset)) {
      if (e.altKey) altUsed.current = true; // its keyup must not open the window menu
      return;
    }
    if (e.key === 'Enter') {
      if (i < 0 && e.target !== search.current) return; // a heading's button: its own click
      const ref = i >= 0 ? tiles[i].dataset.ref : shown.find((s) => s.entries.length)?.entries[0].ref;
      if (!ref) return;
      e.preventDefault();
      choose(ref);
      return;
    }
    if (!ARROWS.includes(e.key) || e.altKey) return;
    let next;
    if (i < 0) {
      if (e.key === 'ArrowDown') next = tiles[0];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') next = tiles[i + (e.key === 'ArrowRight' ? 1 : -1)];
    else {
      const top = (el) => el.getBoundingClientRect().top;
      const left = (el) => el.getBoundingClientRect().left;
      const [y, x, dir] = [top(tiles[i]), left(tiles[i]), e.key === 'ArrowDown' ? 1 : -1];
      next = tiles.filter((el) => (top(el) - y) * dir > 4)
        .sort((a, b) => Math.abs(top(a) - y) - Math.abs(top(b) - y) || Math.abs(left(a) - x) - Math.abs(left(b) - x))[0]
        ?? (dir < 0 ? search.current : null);
    }
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView?.({ block: 'nearest' });
  };
  // Enter is the picker's own while the focus is in it: taken in the window's capture phase, before the tool search options
  // panel's document listener, which closes the panel on Enter (§7c) and would drop the pick.
  const keys = useRef(null);
  keys.current = onKeyDown;
  useEffect(() => {
    const onEnter = (e) => {
      if (e.key !== 'Enter' || !root.current?.contains(e.target)) return;
      e.stopPropagation();
      keys.current(e);
    };
    window.addEventListener('keydown', onEnter, true);
    return () => window.removeEventListener('keydown', onEnter, true);
  }, []);
  const onKeyUp = (e) => {
    if (e.key === 'Alt' && altUsed.current) {
      e.preventDefault();
      altUsed.current = false;
    }
  };

  const named = layout === 'menu';
  const tile = (s, e) => {
    const props = {
      size: 'sm', 'data-ref': e.ref, 'data-section': s.id, ...(e.kind && { 'data-kind': e.kind }), ...(e.id != null && { 'data-item': e.id }),
      'aria-label': e.label, pressed: e.ref === current, onPressedChange: () => onPick(e, s), ...tileProps?.(e, s),
    };
    const icon = e.icon ?? (e.line ? <LineIcon name={e.id} className="size-5" /> : <ShapeIcon shape={e.kind} className="size-5" />);
    let body;
    if (e.wide) {
      body = (
        <Toggle {...props} className="h-auto w-full flex-col gap-0.5 p-1">
          {icon}
          <span className="w-full truncate text-xs leading-tight font-normal">{e.label}</span>
        </Toggle>
      );
    } else if (named) {
      // Its picture large, its name under it.
      body = (
        <Toggle {...props} title={e.label} className="h-auto w-full flex-col justify-start gap-1 px-1 py-1.5 font-normal">
          <span className="grid h-9 w-full place-items-center [&_path]:[stroke-width:1.5] [&_path]:[vector-effect:non-scaling-stroke] [&_svg]:h-7! [&_svg]:w-9!">{icon}</span>
          <span className="line-clamp-2 w-full text-center text-[11px] leading-tight whitespace-normal text-muted-foreground">{e.label}</span>
        </Toggle>
      );
    } else body = <Tip title={e.label} {...tipProps}><Toggle {...props} className={cn(layout === 'panel' && 'w-full')}>{icon}</Toggle></Tip>;
    return <div key={e.ref} className={cn('group relative', e.wide && 'col-span-3')}>{body}{decorate?.(e, s)}</div>;
  };
  const grid = layout === 'panel' ? 'grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))]' : named ? 'grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1' : 'grid-cols-7';
  const body = shown.map((s) => {
    const open = !toggle || q || !closed.includes(s.id);
    return (
      <section key={s.id} aria-label={s.title} data-section={s.id} data-gallery-group={s.title} {...s.props} className={cn('rounded-md', s.props?.className)}>
        <div className={cn('flex items-center px-1 text-xs font-medium text-muted-foreground', named ? 'h-7' : 'h-5')}>
          {toggle && !q ? (
            <button type="button" aria-expanded={!!open} onMouseDown={(ev) => ev.preventDefault()} onClick={() => toggle(s.id)}
              className="flex flex-1 items-center gap-0.5 text-left hover:text-foreground">
              <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />{s.title}
            </button>
          ) : <span className="flex-1">{s.title}</span>}
          {header?.(s)}
        </div>
        {open && <div className={cn('grid gap-0.5', grid)}>{s.entries.map((e) => tile(s, e))}</div>}
        {open && !s.entries.length && <div className="px-1 pb-1 text-xs text-muted-foreground">{s.empty}</div>}
      </section>
    );
  });
  const none = !shown.some((s) => s.entries.length || s.empty) && <div className="px-1 py-2 text-sm text-muted-foreground">No shape found.</div>;
  const field = { ref: search, value: query, onChange: (e) => setQuery(e.target.value), placeholder, 'aria-label': 'Search shapes' };

  if (named) {
    return (
      <div ref={root} data-shape-picker="menu" data-long-gallery="" onKeyDown={onKeyDown} onKeyUp={onKeyUp} className="flex w-[60rem] max-w-full flex-col">
        <label className="flex items-center gap-2 border-b px-2 pb-1">
          <Search className="size-4 shrink-0 opacity-50" />
          <input {...field} className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </label>
        <div className="flex min-h-0">
          {!q && shown.length > 1 && <SectionNav titles={shown.map((s) => s.title)} list={list} />}
          <div ref={list} className="relative h-[24rem] min-w-0 flex-1 overflow-y-auto p-1 select-none">{body}{none}</div>
        </div>
      </div>
    );
  }
  const panel = layout === 'panel';
  return (
    <div ref={root} data-shape-picker={layout} onKeyDown={onKeyDown} onKeyUp={onKeyUp} className={cn(panel && 'flex min-h-0 flex-1 flex-col')}>
      <Input {...field} className={cn('px-2', panel ? 'mx-1.5 mb-1 w-auto' : 'mb-1')} />
      <div ref={list} className={cn('flex flex-col gap-1 overflow-x-hidden overflow-y-auto select-none', panel
        ? 'min-h-0 flex-1 px-1.5 pb-2'
        : 'max-h-[min(30rem,calc(var(--radix-popover-content-available-height)-3rem))] w-[16.5rem] pr-1')}>
        {body}{none}
      </div>
    </div>
  );
}

/** The menu's column of section titles: a click scrolls the list to one; the one at the top of the list is marked. */
function SectionNav({ titles, list }) {
  const [at, setAt] = useState(titles[0]);
  const top = (t) => list.current?.querySelector(`[data-gallery-group="${CSS.escape(t)}"]`)?.offsetTop ?? Infinity;
  useEffect(() => {
    const el = list.current;
    const follow = () => {
      const last = el.scrollTop + el.clientHeight >= el.scrollHeight - 2; // a short last section never reaches the top
      setAt(last ? titles.at(-1) : titles.findLast((t) => top(t) <= el.scrollTop + 8) ?? titles[0]);
    };
    el?.addEventListener('scroll', follow);
    return () => el?.removeEventListener('scroll', follow);
  }, [titles.join('\n')]);
  const jump = (t) => {
    list.current.scrollTop = top(t);
    setAt(t);
  };
  return (
    <nav aria-label="Sections" className="grid w-40 shrink-0 content-start gap-0.5 border-r p-1">
      {titles.map((t) => (
        <button key={t} type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => jump(t)} aria-current={at === t || undefined} data-gallery-jump={t}
          className="rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground aria-[current]:bg-accent/60 aria-[current]:text-foreground">
          {t}
        </button>
      ))}
    </nav>
  );
}

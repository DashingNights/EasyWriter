// The ribbon's controls (docs/plans/word/plan.md §1.4 Rendering contract, §2.8): large, medium and small buttons, toggles,
// split buttons, dropdowns, combo boxes, spinners, check boxes, edit and list boxes and in-ribbon galleries, drawn from the
// layout model (layout.mjs) and the registry's command state. Sizes follow the probe at its 1.25 scale: large 32 px icons
// over one or two label lines, medium and small 16 px icons in 22 px rows. Product-neutral: the spec, the icon set and the
// fallback boxes come in through RibbonContext; nothing here names a Word control.
import { Component, createContext, useContext, useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { refocusEditor } from '../../app/actions.js';
import { Tip } from '../../app/components/Tip.jsx';
import { keepFocus } from '../../app/components/Toolbar.jsx';
import { grants } from '../profile.mjs';
import { REASONS } from '../reasons.mjs';
import { commandOf, galleryOf, panelOf, run } from '../registry.js';
import { FontPick, SizePick } from '../kit/FontPick.jsx';
import { formatLength, parseLength, UNITS, unitOf } from '../kit/units.mjs';
import { splitLabel } from './layout.mjs';
import { ItemMenu, MenuView } from './menus.jsx';

/** What the ribbon hands its parts: {spec, icons, boxes, ctx, done}. done() runs after a control acts (it closes a
 * collapsed ribbon shown over the page). */
export const RibbonContext = createContext(null);
const useRibbon = () => useContext(RibbonContext);

/** A CommandSpec property that may be a function of the context. */
const dyn = (v, ctx) => (typeof v === 'function' ? v(ctx) : v);

/** The icon component of `name` in the icon set `icons` (a map or a resolver function), or a plain square. A control may name
 * a component instead (the Quick Access Toolbar's own buttons, which the spec's icon set lacks). */
export function iconOf(icons, name) {
  if (name && typeof name !== 'string') return name;
  const Icon = typeof icons === 'function' ? icons(name) : icons?.[name];
  return Icon ?? Blank;
}
const Blank = ({ className }) => <span className={cn('inline-block rounded-xs border border-dashed border-current opacity-40', className)} />;

/** Whether menu `id` of `ribbon` (the spec) offers something that works now: a built item, a gallery with items, a registered
 * panel or such a submenu. A dropdown only opens its menu, so with no command of its own it opens while its menu holds one. */
function menuLive(ribbon, id, ctx, depth = 0) {
  return depth < 3 && (ribbon?.MENUS?.[id] ?? []).some((e) => {
    if (e.sub) return menuLive(ribbon, e.sub, ctx, depth + 1);
    if (e.item) return !ribbon.ITEMS?.[e.item]?.needs && !!commandOf(ribbon.ITEMS?.[e.item]?.cmd ?? e.item);
    if (e.gallery) return galleryOf(e.gallery, ctx).length > 0;
    return !!e.panel && !!panelOf(e.panel);
  });
}

/** What `item` shows now for `ctx`: {label, icon, spec, off, reason, active, value}, or null when the active profile does not
 * grant its command (§1.19: not granted means not drawn; a placeholder is drawn disabled with its reason). `ribbon`: the spec,
 * for a dropdown whose menu works while it has no command (Table Layout > Delete). */
export function stateOf(item, ctx, ribbon) {
  if (ctx?.profile && !grants(ctx.profile, item.cmd)) return null;
  const spec = commandOf(item.cmd);
  const label = dyn(spec?.label, ctx) ?? item.control.label;
  const icon = dyn(spec?.icon, ctx) ?? item.control.icon;
  if (!spec && !item.placeholder && item.control.type === 'dropdown' && menuLive(ribbon, item.control.menu ?? item.id, ctx)) return { label, icon, off: false };
  if (item.placeholder || !spec) return { label, icon, off: true, reason: REASONS[item.placeholder] ?? REASONS.pending };
  const on = spec.enabled ? spec.enabled(ctx) : true;
  return { label, icon, spec, off: !on, reason: on ? null : spec.reason?.(ctx) ?? null, active: spec.active?.(ctx), value: spec.value?.(ctx) };
}

/** A tooltip's body: the label as its title and the reason (or the control's tip) under it. */
const TipBody = ({ label, body }) => (
  <div className="flex max-w-64 flex-col gap-0.5 text-left">
    <span className="font-medium">{label}</span>
    {body && <span className="text-pretty opacity-80">{body}</span>}
  </div>
);

/** The attributes every control root carries (§1.4 Rendering contract). */
const marks = (item, st) => ({
  'data-feature': item.id, 'data-keytip': item.control.keytip, 'aria-label': st.label,
  ...(st.off && { 'aria-disabled': true, 'data-reason': st.reason ?? undefined }), // KeyTips toast the reason of a disabled control
});

export const BTN = 'inline-flex items-center rounded-md text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 '
  + 'aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-pressed:bg-accent data-[state=open]:bg-accent';

/** A colour bar under a small or medium icon when the command's value is a colour (Font Color, Highlight, Shading). */
const Bar = ({ value }) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
  ? <span className="absolute bottom-[2px] left-1/2 h-[3px] w-3.5 -translate-x-1/2 rounded-xs" style={{ background: value }} /> : null);

/** One clickable face: the icon (and label by size) of `st` ({label, icon, value}; outside a ribbon the icon is a component).
 * `part`: 'main' (the icon half of a split) or 'arrow'. Size 'regular' is a small face at 32 px, the height of the app's own
 * toolbar buttons (IconButton regular), for kit parts outside the ribbon (a board's chrome). */
export function Face({ item, st, size, part, chevron, ...props }) {
  const { icons } = useRibbon() ?? {};
  const Icon = iconOf(icons, st.icon);
  const lines = splitLabel(st.label);
  // data-part names a split button's halves for harness cases: 'main' runs, 'menu' opens the menu.
  const mark = part && { 'data-part': part === 'arrow' ? 'menu' : part };
  if (size === 'large') {
    return (
      <button type="button" {...mark} {...props} className={cn(BTN, 'flex-col justify-start gap-0.5 px-1 text-[12px] leading-[14px]',
        part === 'main' ? 'h-[42px] w-full justify-center rounded-b-none pt-1' : part === 'arrow' ? 'h-[34px] w-full rounded-t-none' : 'h-full min-w-[42px] pt-1', props.className)}>
        {part !== 'arrow' && <Icon className="size-8 shrink-0" strokeWidth={1.25} />}
        {part !== 'main' && (
          <span className="flex flex-col items-center whitespace-nowrap">
            <span>{lines[0]}</span>
            <span className="inline-flex items-center gap-0.5">{lines[1]}{chevron && <ChevronDown className="size-3 opacity-70" />}</span>
          </span>
        )}
      </button>
    );
  }
  return (
    <button type="button" {...mark} {...props} className={cn(BTN, 'relative h-[22px] gap-1 text-[12px] whitespace-nowrap',
      size === 'small' ? 'min-w-[24px] justify-center px-1' : size === 'regular' ? 'h-8 min-w-8 justify-center px-1.5' : 'px-1', props.className)}>
      {part !== 'arrow' && <Icon className="size-4 shrink-0" strokeWidth={1.5} />}
      {part !== 'arrow' && size === 'medium' && <span data-face-label="">{st.label}</span>}
      {chevron && <ChevronDown className="size-3 opacity-70" />}
      {part !== 'arrow' && <Bar value={st.value} />}
    </button>
  );
}

/** A button's press: run the command (a placeholder or a disabled command does nothing), then done(). */
function useAct(item, st) {
  const { done } = useRibbon();
  return (arg) => {
    if (st.off) return;
    run(item.cmd, arg);
    done?.();
  };
}

/** A menu opened from `trigger` (a Face as Radix trigger): the control's MENUS entry drawn by MenuView. A pick runs once the
 * menu has closed and the focus is back in the editor, so a paste lands in the text (the island's SplitMenu pattern). */
export function MenuButton({ item, st, trigger, align = 'start' }) {
  const { spec, ctx, done } = useRibbon();
  const [open, setOpen] = useState(false);
  const pending = useRef(null);
  // On close the editor takes the focus at once, after the commit that releases the menu's focus trap: onCloseAutoFocus waits for
  // the exit animation, and a key pressed meanwhile (Alt+Q right after Escape) would land in the closing menu.
  const shut = () => {
    setOpen(false);
    queueMicrotask(() => refocusEditor());
  };
  return (
    <DropdownMenu open={open} onOpenChange={(o) => (o ? !st.off && setOpen(true) : shut())}>
      <DropdownMenuTrigger asChild disabled={st.off}>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-w-[28rem] min-w-[10rem] has-[[data-long-gallery]]:max-w-[calc(100vw-2rem)]" onCloseAutoFocus={(e) => {
        // The editor has the focus since the close; taking it again here would pull it from what opened meanwhile (tool search).
        e.preventDefault();
        const fn = pending.current;
        pending.current = null;
        if (fn) {
          fn();
          done?.();
        }
      }}>
        {open && <MenuView spec={spec} menu={item.control.menu ?? item.id} ctx={ctx} cmd={item.cmd} close={shut}
          fire={(fn) => { pending.current = fn; }} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A button, toggle, split, split toggle or dropdown of any size. */
function ButtonControl({ item, st, size }) {
  const act = useAct(item, st);
  const { type } = item.control;
  const pressed = type === 'toggle' || type === 'splitToggle' ? !!st.active : undefined;
  const common = { item, st, size, onMouseDown: keepFocus, 'aria-pressed': pressed };
  if (type === 'dropdown') return <MenuButton item={item} st={st} trigger={<Face {...common} {...marks(item, st)} chevron />} />;
  if (type !== 'split' && type !== 'splitToggle') return <Face {...common} {...marks(item, st)} onClick={() => act()} />;
  const arrow = <Face item={item} st={st} size={size} part="arrow" chevron onMouseDown={keepFocus} aria-label={`${st.label} options`}
    aria-disabled={st.off || undefined} className={size === 'large' ? undefined : 'min-w-0 px-0.5'} />;
  return (
    <span {...marks(item, st)} aria-pressed={pressed} className={cn('group/split inline-flex', size === 'large' ? 'h-full min-w-[42px] flex-col' : 'items-center')}>
      <Face {...common} part="main" aria-label={st.label} aria-disabled={st.off || undefined} onClick={() => act()} className={size === 'large' ? undefined : 'rounded-r-none'} />
      <MenuButton item={item} st={st} trigger={arrow} />
    </span>
  );
}

/** Toggle buttons side by side in the ribbon's look, for a compact toolbar outside the ribbon (marks, alignment, lists):
 * `items` [{id, label, icon (a component), active, off, reason, onClick}]. `size` 'small' (icons) or 'medium' (icon and label). */
export function ToggleGroup({ label, items, size = 'small' }) {
  return (
    <span role="group" aria-label={label} className="inline-flex items-center">
      {items.map((it) => (
        <Tip key={it.id} title={<TipBody label={it.label} body={it.off ? it.reason : null} />} side="bottom">
          <Face st={it} size={size} data-feature={it.id} aria-label={it.label} aria-pressed={!!it.active} aria-disabled={it.off || undefined}
            onMouseDown={keepFocus} onClick={() => !it.off && it.onClick?.()} />
        </Tip>
      ))}
    </span>
  );
}

/** A split button in the ribbon's look outside the ribbon: the main part runs `onClick`, the arrow opens `children` (menu items, or
 * a function of close() for a panel). `value` draws a colour bar under the icon; `active` presses it (a split toggle). `onDone`
 * takes the focus back when the menu closes (default: the editor); `contentProps` go to the menu (a board's chrome mark). */
export function SplitButton({ id, label, icon, value, active, off, onClick, size = 'small', onDone = refocusEditor, contentProps, children }) {
  const [open, setOpen] = useState(false);
  const st = { label, icon, value };
  const shut = () => {
    setOpen(false);
    queueMicrotask(() => onDone());
  };
  return (
    <span data-feature={id} aria-label={label} aria-pressed={active} className="group/split inline-flex items-center">
      <Tip title={label} side="bottom">
        <Face st={st} size={size} part="main" aria-label={label} aria-pressed={active} aria-disabled={off || undefined} onMouseDown={keepFocus}
          onClick={() => !off && onClick?.()} className="rounded-r-none" />
      </Tip>
      <DropdownMenu open={open} onOpenChange={(o) => (o ? !off && setOpen(true) : shut())}>
        <DropdownMenuTrigger asChild disabled={off}>
          <Face st={st} size={size} part="arrow" chevron aria-label={`${label} options`} aria-disabled={off || undefined} onMouseDown={keepFocus} className="min-w-0 px-0.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[10rem]" onCloseAutoFocus={(e) => e.preventDefault()} {...contentProps}>
          {typeof children === 'function' ? children(shut) : children}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

// From this many rows a combo's list narrows to what is typed (the Font box; Font Size's 16 presets keep the whole list).
const LONG_COMBO = 25;

/** A combo box: a provider's list (§1.4: group headings, each row its preview) when its id has a gallery, drawn by the kit's
 * FontPick (a long list, searched as typed) or SizePick; else the fallback box the ribbon was given for its id (FontBox,
 * SizeBox). Typed text runs the command with the text. */
function ComboControl({ item, st, items, Box }) {
  const { ctx } = useRibbon();
  const act = useAct(item, st);
  // The fallback box keeps its own field and tooltip, sized to the ribbon's row.
  if (Box) {
    return (
      <span {...marks(item, st)} className="inline-flex [&_[data-slot=combobox]]:!w-full [&_input]:!h-[22px] [&_input]:!text-[12px] [&>span]:w-full"
        style={{ width: `${item.box}rem` }}><Box ctx={ctx} st={st} /></span>
    );
  }
  const Pick = items.length >= LONG_COMBO ? FontPick : SizePick;
  return (
    <span {...marks(item, st)} className="inline-flex" style={{ width: `${item.box}rem` }}>
      <Pick aria-label={st.label} disabled={st.off} className="w-full" value={st.value} options={items} onChange={act} contentProps={{ className: 'w-64' }} />
    </span>
  );
}

// The document's length unit (the kit's unitOf: settings.word.units, the profile's, else the paper's unit the island used).
const lenUnit = (ctx) => unitOf(ctx?.settings, ctx?.profile, ctx?.T?.unit?.name);
const STEP = { pt: 6, pct: 10, int: 1 };

/** A spinner (§1.4 unit): its label, a box showing the value in its unit, and up and down arrows that run the More and Less
 * parts when they are registered, else step the value. Enter or leaving the box applies typed text; Escape drops it. */
function SpinnerControl({ item, st, caption }) {
  const { ctx } = useRibbon();
  const act = useAct(item, st);
  const { unit: kind = 'pt', parts } = item.control;
  const unit = kind === 'len' ? lenUnit(ctx) : kind === 'pt' ? 'pt' : null;
  const show = (v) => (v == null ? '' : unit ? formatLength(v, unit, unit === 'pt' ? 1 : 2) : kind === 'pct' ? `${v}%` : String(v));
  const [text, setText] = useState(null);
  // The typed text also lives in a ref: refocusEditor() blurs the box synchronously, before the state update lands, so the
  // blur's commit must see that Enter already applied it or Escape dropped it.
  const typed = useRef(null);
  const type = (t) => { typed.current = t; setText(t); };
  const parse = (t) => (unit ? parseLength(t, unit) : Number.isFinite(parseFloat(t)) ? parseFloat(t) : null);
  const commit = () => {
    const n = typed.current == null ? null : parse(typed.current);
    type(null);
    if (n != null) act(n);
  };
  const step = (dir) => {
    const part = parts?.[dir > 0 ? 'more' : 'less'];
    if (part && commandOf(part)) return !st.off && run(part);
    const by = kind === 'len' ? 0.1 * UNITS[unit] : STEP[kind];
    act(Math.max(0, Math.round(((st.value ?? 0) + dir * by) * 100) / 100));
  };
  const { icons } = useRibbon();
  const Icon = iconOf(icons, st.icon);
  // Word draws "Left:" under an "Indent" caption for the control it names "Indent Left".
  const short = caption && st.label.startsWith(`${caption} `) ? st.label.slice(caption.length + 1) : st.label;
  return (
    <span {...marks(item, st)} className={cn('inline-flex h-[22px] items-center gap-1 text-[12px]', st.off && 'opacity-40')}>
      <Icon className="size-4 shrink-0" strokeWidth={1.5} />
      <span className="whitespace-nowrap">{short}:</span>
      <span className="flex h-[22px] items-stretch rounded-sm border bg-background" style={{ width: `${item.box}rem` }}>
        <input aria-label={st.label} disabled={st.off} value={text ?? show(st.value)} className="min-w-0 flex-1 bg-transparent px-1 text-[12px] tabular-nums outline-none"
          onChange={(e) => type(e.target.value)} onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            e.preventDefault();
            if (e.key === 'Escape') type(null);
            else commit();
            refocusEditor();
          }} />
        <span className="flex flex-col border-l">
          {[[1, ChevronUp, parts?.more], [-1, ChevronDown, parts?.less]].map(([dir, Arrow, id]) => (
            <button key={dir} type="button" tabIndex={-1} aria-label={dir > 0 ? 'More' : 'Less'} data-feature={id} disabled={st.off} onMouseDown={keepFocus}
              onClick={() => step(dir)} className="grid h-[10px] w-3.5 place-items-center hover:bg-accent/60"><Arrow className="size-2.5" /></button>
          ))}
        </span>
      </span>
    </span>
  );
}

/** A check box with its label (View > Ruler, Header & Footer > Different First Page). */
function CheckControl({ item, st }) {
  const act = useAct(item, st);
  return (
    <label {...marks(item, st)} onMouseDown={keepFocus} className={cn('inline-flex h-[22px] items-center gap-1.5 px-1 text-[12px] whitespace-nowrap', st.off && 'opacity-40')}>
      <input type="checkbox" checked={!!st.active} disabled={st.off} onChange={() => act()} className="size-3.5 accent-[var(--ui-accent)]" />
      {st.label}
    </label>
  );
}

/** An edit box: the value as text; Enter runs the command with the typed text. */
function EditControl({ item, st }) {
  const act = useAct(item, st);
  const [text, setText] = useState(null);
  return (
    <span {...marks(item, st)} className={cn('inline-flex h-[22px] items-center gap-1 text-[12px]', st.off && 'opacity-40')}>
      <span className="whitespace-nowrap">{st.label}:</span>
      <input aria-label={st.label} disabled={st.off} value={text ?? String(st.value ?? '')} style={{ width: `${item.box}rem` }}
        className="h-[22px] rounded-sm border bg-background px-1 text-[12px] outline-none" onChange={(e) => setText(e.target.value)}
        onBlur={() => setText(null)} onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== 'Escape') return;
          e.preventDefault();
          if (e.key === 'Enter' && text != null) act(text);
          setText(null);
          refocusEditor();
        }} />
    </span>
  );
}

/** A read-only list box showing value(ctx) (Outline Level, Display for Review) that opens its menu. */
function ListControl({ item, st }) {
  const trigger = (
    <button type="button" {...marks(item, st)} onMouseDown={keepFocus} style={{ width: `${item.box}rem` }}
      className={cn(BTN, 'h-[22px] justify-between gap-1 rounded-sm border bg-background px-1.5 text-[12px] hover:bg-background')}>
      <span className="truncate">{st.value == null ? '' : typeof st.value === 'object' ? st.value : String(st.value)}</span>
      <ChevronDown className="size-3 shrink-0 opacity-70" />
    </button>
  );
  return <MenuButton item={item} st={st} trigger={trigger} />;
}

/** An in-ribbon gallery (§1.4 grid): rows x cols tiles of the provider's items, scroll arrows and More, which opens the
 * control's menu. A tile runs its item (item.run, else the command with the item id), opens its item menu on right-click and
 * the context-menu key, and opens its panel when it is clicked while active. */
function GalleryControl({ item, st }) {
  const { ctx, spec } = useRibbon();
  const act = useAct(item, st);
  const { rows = 1, cols: full = 6 } = item.control.grid ?? {};
  const cols = item.cols ?? full; // adaptive groups (layout.mjs fit) take columns away first
  const items = st.off ? [] : galleryOf(item.control.gallery ?? item.id, ctx) ?? [];
  const [top, setTop] = useState(0);
  const last = Math.max(0, Math.ceil(items.length / cols) - rows);
  const shown = items.slice(Math.min(top, last) * cols, (Math.min(top, last) + rows) * cols);
  const [pop, setPop] = useState(null); // {it, kind: 'menu'|'panel', x, y}
  const pick = (it, e) => {
    if (it.active && it.panel && panelOf(it.panel)) return setPop({ it, kind: 'panel', ...at(e) });
    if (st.off) return;
    if (it.run) it.run(ctx);
    else act(it.id);
  };
  const more = (
    <button type="button" aria-label="More" data-gallery-more onMouseDown={keepFocus} className={cn(BTN, 'h-[22px] w-4 justify-center rounded-none')}>
      <ChevronDown className="size-3" />
    </button>
  );
  return (
    <span {...marks(item, st)} className="relative inline-flex h-[68px] items-stretch self-center rounded-md border bg-background">
      <span className="grid gap-px p-px" style={{ gridTemplateColumns: `repeat(${cols}, 5.75rem)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
        {shown.map((it) => (
          <Tip key={it.id} title={<TipBody label={it.label} body={it.desc} />}>
            <button type="button" aria-label={it.label} data-item={it.id} aria-pressed={!!it.active} onMouseDown={keepFocus} onClick={(e) => pick(it, e)}
              onContextMenu={(e) => { if (it.menu?.length) { e.preventDefault(); setPop({ it, kind: 'menu', ...at(e) }); } }}
              onKeyDown={(e) => { if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && it.menu?.length) { e.preventDefault(); setPop({ it, kind: 'menu', ...at(e) }); } }}
              className={cn(BTN, 'h-full w-full justify-center overflow-hidden border border-transparent px-1 text-[13px] aria-pressed:border-[var(--ui-accent)]')}>
              {it.preview ?? <span className="truncate">{it.label}</span>}
            </button>
          </Tip>
        ))}
      </span>
      <span className="flex flex-col border-l">
        <button type="button" aria-label="Row up" disabled={top <= 0} onMouseDown={keepFocus} onClick={() => setTop(Math.max(0, Math.min(top, last) - 1))}
          className={cn(BTN, 'h-[22px] w-4 justify-center rounded-none disabled:opacity-30')}><ChevronUp className="size-3" /></button>
        <button type="button" aria-label="Row down" disabled={top >= last} onMouseDown={keepFocus} onClick={() => setTop(Math.min(last, top + 1))}
          className={cn(BTN, 'h-[22px] w-4 justify-center rounded-none disabled:opacity-30')}><ChevronDown className="size-3" /></button>
        {spec.MENUS?.[item.control.menu ?? item.id] ? <MenuButton item={item} st={st} trigger={more} align="end" /> : more}
      </span>
      {pop && <ItemPop pop={pop} cmd={item.cmd} close={() => setPop(null)} />}
    </span>
  );
}

/** The point an item menu or panel opens at: the pointer, or the element's corner for a key. */
const at = (e) => (e.clientX ? { x: e.clientX, y: e.clientY } : (({ left, bottom }) => ({ x: left, y: bottom }))(e.currentTarget.getBoundingClientRect()));

/** A gallery item's right-click menu or its panel, anchored at the point it was asked for. */
export function ItemPop({ pop, cmd, close }) {
  const { ctx, done } = useRibbon() ?? {};
  const Panel = pop.kind === 'panel' ? panelOf(pop.it.panel) : null;
  const anchor = useRef({ getBoundingClientRect: () => DOMRect.fromRect({ x: pop.x, y: pop.y, width: 0, height: 0 }) });
  return (
    <Popover open onOpenChange={(o) => !o && close()}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent align="start" className="w-auto p-1" onOpenAutoFocus={keepFocus} onCloseAutoFocus={refocusEditor}>
        {Panel ? <Panel ctx={ctx} cmd={cmd} close={close} />
          : <ItemMenu it={pop.it} close={() => { close(); done?.(); }} />}
      </PopoverContent>
    </Popover>
  );
}

const DRAW = { combo: ComboControl, spinner: SpinnerControl, checkbox: CheckControl, edit: EditControl, list: ListControl, gallery: GalleryControl };

/** One control of the layout model, wrapped in its tooltip: the label as title, the reason (placeholders, disabled commands)
 * or the control's tip as the body. `size` overrides the control's own, as does the item's `size` (adaptive groups). */
export function Control({ item, size: forced, caption }) {
  const { ctx, boxes, spec } = useRibbon();
  const size = forced ?? item.size;
  const st = stateOf(item, ctx, spec);
  if (!st) return null;
  const Draw = DRAW[item.control.type] ?? ButtonControl;
  const body = st.off ? st.reason : item.control.tip;
  let combo = null;
  if (item.control.type === 'combo') {
    // A provider's list wins; else the fallback box, which draws its own tooltip, so this one stays off.
    const items = st.off ? [] : galleryOf(item.control.gallery ?? item.id, ctx) ?? [];
    combo = { items, Box: !items.length && !st.off ? boxes?.[item.id] ?? null : null };
    if (combo.Box) return <Draw item={item} st={st} {...combo} />;
  }
  return (
    <Tip title={<TipBody label={st.label} body={body} />} side="bottom" wrap={(size ?? item.control.size) === 'large' ? 'h-full' : undefined}>
      <Draw item={item} st={st} size={size ?? item.control.size} caption={caption} {...combo} />
    </Tip>
  );
}

/** A group's dialog launcher: the small arrow at the group's bottom right. */
export function Launcher({ item }) {
  const { ctx } = useRibbon();
  const st = stateOf(item, ctx);
  const act = useAct(item, st ?? { off: true });
  if (!st) return null;
  return (
    <Tip title={<TipBody label={st.label} body={st.off ? st.reason : item.control.tip} />} side="bottom" wrap="absolute right-0.5 bottom-0.5">
      <button type="button" {...marks(item, st)} data-launcher onMouseDown={keepFocus} onClick={() => act()} className={cn(BTN, 'size-[15px] justify-center')}>
        <svg viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1"><path d="M1 4V1h3M9 6v3H6M3 3l6 6" /></svg>
      </button>
    </Tip>
  );
}

/** Keeps one group's failure (a package's enabled or value throwing) inside that group: it draws its label and nothing else. */
export class GroupGuard extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error(`ribbon group ${this.props.id}`, error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Calls `fn` on a pointer press outside `ref` while `on`. */
export function useOutside(ref, on, fn) {
  useEffect(() => {
    if (!on) return undefined;
    const down = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('[data-radix-popper-content-wrapper]')) return;
      fn();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
}

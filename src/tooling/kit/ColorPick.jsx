// The kit's colour menus (docs/plans/word/plan.md §1.6). ColorPanel draws Automatic, a theme's grid, the standard colours and a
// typed hex. ColorPick puts it behind a colour box or a toolbar button with the recent colours, More Colors (the app's colour
// picker, ColorPicker.jsx ColorDialog, stacked over the dialog holding the menu) and the eyedropper; or, given a
// `palette`, draws a fixed list of named colours as labelled swatches (the forum post's colours). Nothing here knows a product:
// a format binds its theme and its recent colours with bindColors.
import { useRef, useState } from 'react';
import { cn } from 'cn';
import { Ban, ChevronDown, Pipette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { openDialog, refocusEditor } from '../../app/actions.js';
import { IconButton, Tip } from '../../app/components/Tip.jsx';
import { keepFocus } from '../../app/components/Toolbar.jsx';
import { getState, useStore } from '../../app/store.js';
import { formatOf } from '../../formats.mjs';
import { resolveColor, STANDARD_COLORS, STANDARD_NAMES, THEME_GRID } from '../../office.mjs';

const RECENT = 10; // Word keeps one row of recent colours

// Each format's colours: {theme() → the theme object the grid draws, recent(state) → hex list, saveRecent(list)}.
const sources = {};
/** Binds format `id`'s colour source (above); the kit's colour boxes in that format's drafts read it. */
export const bindColors = (id, source) => {
  sources[id] = source;
};
const NO_SOURCE = {};

/** Puts `hex` first in `src`'s recent colours. */
const remember = (src, state, hex) => src.saveRecent?.([hex, ...(src.recent?.(state) ?? []).filter((c) => c !== hex)].slice(0, RECENT));

/** Office's standard colours as [hex, name]. */
export const OFFICE_STANDARD = STANDARD_COLORS.map((c, i) => [c, STANDARD_NAMES[i]]);

const SLOT_NAMES = { lt1: 'Background 1', dk1: 'Text 1', lt2: 'Background 2', dk2: 'Text 2', accent1: 'Accent 1', accent2: 'Accent 2',
  accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', accent6: 'Accent 6' };
const lumName = (lum) => (!lum ? '' : `, ${lum > 0 ? 'Lighter' : 'Darker'} ${Math.round(Math.abs(lum) * 100)}%`);

/** Focus that comes into a colour panel from outside it (its popup's focus on opening) opens no cell tooltip: the tooltip would
 * take the next Escape, so closing the popup would take two. Moving between cells shows them. The preventDefault skips the
 * tooltip's own focus handler. */
const quietEntry = (e) => {
  const panel = e.currentTarget.closest('[data-slot$="-content"]');
  if (!e.relatedTarget || !panel?.contains(e.relatedTarget)) e.preventDefault();
};

/** One colour cell; `active` rings it. */
export const ColorCell = ({ label, color, active, onPick }) => (
  <Tip title={label}>
    <button type="button" aria-label={label} onMouseDown={keepFocus} onFocus={quietEntry} onClick={onPick} style={{ background: color }}
      className={cn('size-5 rounded-xs', active ? 'ring-2 ring-foreground ring-offset-1 ring-offset-popover' : 'ring-1 ring-foreground/20 ring-inset')} />
  </Tip>
);

const Heading = ({ children }) => <div className="px-0.5 text-xs text-muted-foreground">{children}</div>;

/** The colour panel: `none` (Automatic, No colour; null leaves it out), the 10 x 6 grid of `theme` (a cell passes its theme link
 * {slot, lum}; no theme, no grid), the `standard` colours ([hex, name]) and a typed hex. `onChange(hex | null, link | null)`;
 * `onPick` runs first (closing the menu). */
export function ColorPanel({ value, themeColor, onChange, theme, standard = OFFICE_STANDARD, none = 'Automatic', onPick }) {
  const [hex, setHex] = useState('');
  const pick = (color, link = null) => {
    onPick?.();
    onChange(color, link);
  };
  return (
    <div className="flex w-60 flex-col gap-1.5">
      {none && (
        <Button variant="ghost" size="xs" className={cn('justify-start', !value && 'bg-accent')} onMouseDown={keepFocus} onClick={() => pick(null)}>
          <span className={cn('size-3.5 rounded-xs ring-1 ring-foreground/20', none === 'Automatic' ? 'bg-black' : 'bg-white')} />{none}
        </Button>
      )}
      {theme && (
        <>
          <Heading>Theme colours</Heading>
          <div className="grid grid-flow-col grid-cols-10 grid-rows-6 gap-0.5">
            {THEME_GRID.flatMap(({ slot, lums }) => [0, ...lums].map((lum) => (
              <ColorCell key={`${slot}${lum}`} label={`${SLOT_NAMES[slot]}${lumName(lum)}`} color={resolveColor(theme, { slot, lum })}
                active={themeColor?.slot === slot && (themeColor.lum ?? 0) === lum} onPick={() => pick(resolveColor(theme, { slot, lum }), { slot, lum })} />
            )))}
          </div>
        </>
      )}
      {standard.length > 0 && (
        <>
          <Heading>Standard colours</Heading>
          <div className="grid grid-cols-10 gap-0.5">
            {standard.map(([c, name]) => <ColorCell key={c} label={name} color={c} active={!themeColor && value === c} onPick={() => pick(c)} />)}
          </div>
        </>
      )}
      <form className="flex items-center gap-1" onSubmit={(e) => {
        e.preventDefault();
        const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
        if (m) pick(`#${m[1].toUpperCase()}`);
      }}>
        <Input size="xs" aria-label="Custom colour" placeholder="#RRGGBB" value={hex} onChange={(e) => setHex(e.target.value)} className="flex-1 font-mono" />
        <Button type="submit" variant="outline" size="xs">Apply</Button>
      </form>
    </div>
  );
}

/** A fixed palette as labelled swatches: `none` first (Default, None; null leaves it out), then `palette` [{id, label, swatch}].
 * `onChange(id | null)`; `onPick` runs first. */
export function PalettePanel({ value, onChange, palette, none = 'Default', onPick }) {
  const pick = (id) => {
    onPick?.();
    onChange(id);
  };
  const rows = [...(none ? [{ id: null, label: none, swatch: null }] : []), ...palette];
  return (
    <div role="listbox" aria-label="Colours" className="grid w-56 grid-cols-2 gap-0.5">
      {rows.map((o) => (
        <button key={o.id ?? ''} type="button" role="option" aria-selected={(value ?? null) === o.id} data-swatch={o.id ?? ''} onMouseDown={keepFocus}
          onClick={() => pick(o.id)} className={cn('flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-accent/60', (value ?? null) === o.id && 'bg-accent')}>
          <span className={cn('grid size-4.5 shrink-0 place-items-center rounded-xs', o.swatch ? 'ring-1 ring-foreground/25 ring-inset' : 'border border-dashed border-muted-foreground text-muted-foreground')}
            style={o.swatch ? { background: o.swatch } : undefined}>{!o.swatch && <Ban className="size-3" />}</span>
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const Swatch = ({ color, label, onPick }) => (
  <button type="button" aria-label={label} title={label} onMouseDown={keepFocus} onClick={onPick} style={{ background: color }}
    className="size-5 rounded-xs ring-1 ring-foreground/20 ring-inset" />
);

/** A colour picker. The trigger is a colour box (dialogs), or with `icon` a toolbar button with a colour bar under the icon
 * (`label` its name). `onChange(hex | null, themeColor | null)`; null is `automatic` ('Automatic', 'No Color'; null hides it).
 * The open draft's format (or `format`) gives the theme grid and the recent colours (bindColors); `theme` overrides the theme
 * (null: no grid), `standard` the standard colours ([hex, name]); `recent`, `more` (More Colors...) and `eyedropper` show
 * those; `alpha` lets More Colors pick an opacity (for an owner that keeps '#RRGGBBAA'). With `palette` ([{id, label, swatch}])
 * it draws only that list as labelled swatches, `value` is an id and `onChange(id | null)`; `automatic` then names the entry for
 * null ('Default', 'None'). `contentProps` go to the popover (a board's chrome mark and its focus return). A toolbar button may
 * open its tooltip and popup on `side` of it, or the popup beside `anchor` (a ref to the island holding it), and be `disabled`. */
export function ColorPick({
  value, themeColor, onChange, automatic = 'Automatic', more = true, recent = true, eyedropper = false, alpha = false, theme, standard, palette, format, icon,
  label, id, contentProps, side, anchor, disabled,
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const fmt = useStore((s) => format ?? formatOf(s.draft, s.settings)?.id);
  const src = sources[fmt] ?? NO_SOURCE;
  const recents = useStore((s) => (recent && !palette ? src.recent?.(s) : null)) ?? [];
  const pick = (hex, link = null) => {
    setOpen(false);
    onChange(hex, link);
  };
  const keep = (hex) => {
    remember(src, getState(), hex);
    onChange(hex, null);
  };
  const moreColors = async () => {
    setOpen(false);
    trigger.current?.focus(); // the picker's dialog gives the focus back to this box (actions.js closeDialog)
    const hex = await openDialog('colors', { value, alpha });
    if (hex) keep(hex);
  };
  const dropper = async () => {
    setOpen(false);
    const hex = await new window.EyeDropper().open().then((r) => r.sRGBHex.toUpperCase(), () => null);
    if (hex) keep(hex);
  };
  const shown = palette ? palette.find((o) => o.id === value) : null;
  const swatch = palette ? shown?.swatch ?? null : value;
  const name = palette ? shown?.label ?? automatic : value ?? automatic;
  const toolbar = !!icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {anchor && <PopoverAnchor virtualRef={anchor} />}
      {toolbar ? (
        <IconButton size="regular" label={label ?? 'Colour'} slot={PopoverTrigger} tip={side && { side }} disabled={disabled} id={id} data-color={swatch ?? ''} onMouseDown={keepFocus}
          className="w-7.5 flex-col gap-0.5">
          {icon}
          <span className="h-[3px] w-4 rounded-sm ring-1 ring-foreground/25" style={{ background: swatch ?? 'transparent' }} />
        </IconButton>
      ) : (
        <PopoverTrigger asChild>
          <button ref={trigger} id={id} type="button" aria-label={name ?? 'Colour'}
            className="flex h-6 w-32 items-center gap-1.5 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            {swatch == null && name ? <span className="flex-1 truncate text-left">{name}</span>
              : <span className="h-3.5 flex-1 rounded-xs ring-1 ring-foreground/20" style={{ background: swatch ?? 'transparent' }} />}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>
      )}
      <PopoverContent side={side} align="start" sideOffset={side && 10} className="flex w-auto flex-col gap-1.5 p-2" {...(toolbar && { onOpenAutoFocus: keepFocus, onCloseAutoFocus: refocusEditor })} {...contentProps}>
        {palette ? <PalettePanel value={value} onChange={(v) => pick(v)} palette={palette} none={automatic} />
          : <ColorPanel value={value} themeColor={themeColor} onChange={pick} theme={theme === undefined ? src.theme?.() : theme} standard={standard} none={automatic} />}
        {recents.length > 0 && (
          <>
            <Heading>Recent colours</Heading>
            <div className="grid grid-cols-10 gap-0.5">{recents.map((c) => <Swatch key={c} color={c} label={c} onPick={() => pick(c)} />)}</div>
          </>
        )}
        {!palette && eyedropper && typeof window.EyeDropper === 'function' && (
          <Button variant="ghost" size="xs" className="justify-start" onMouseDown={keepFocus} onClick={dropper}><Pipette />Eyedropper</Button>
        )}
        {!palette && more && <Button variant="ghost" size="xs" className="justify-start" onMouseDown={keepFocus} onClick={moreColors}>More Colors...</Button>}
      </PopoverContent>
    </Popover>
  );
}

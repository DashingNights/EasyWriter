// The app's one colour picker (docs/plans/word/briefs/color-picker.md). Every colour choice opens it: a swatch (ColorSwatch, in a
// popover) or More Colors (ColorDialog, the dialog id 'colors', which openDialog stacks over an open dialog). It picks in a square,
// a hue ring with a triangle, or an HSL wheel, and types Hex, RGB, RGBA, HSL, HSLA or HSB; the mode and the format last chosen are
// an app setting (settings.colorPicker) the next picker opens with. Every mode draws in the same box and the same rows, so a switch
// keeps the colour and moves nothing.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Circle, Square, Triangle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { saveSettings } from '../../app/actions.js';
import { IconButton, Tip } from '../../app/components/Tip.jsx';
import { useStore } from '../../app/store.js';
import {
  AREAS, areaHandles, areaKey, areaPart, areaPick, corners, FORMATS, fieldText, formatShown, hexOfHsva, hslOfHsv, hsvaOf, hsvOfHsl, RING,
  withField, withSat,
} from './color.mjs';
import { Pick } from './controls.jsx';
import { WordDialog } from './WordDialog.jsx';

// The area's box in the units color.mjs computes in: 208 × 160, drawn as 13rem × 10rem, so the picker grows with the app's text size.
const W = 208;
const H = 160;
const BAR = 12; // a slider's height in the same units (0.75rem)
const CHECKS = 'repeating-conic-gradient(#c8c8c8 0 25%, #fff 0 50%) 0 0 / 8px 8px'; // shows through a see-through colour
const MODES = [['square', 'Saturation and brightness square', Square], ['triangle', 'Hue ring and triangle', Triangle],
  ['wheel', 'Hue and saturation wheel', Circle]];
const AREA_LABEL = { square: 'Saturation and brightness', triangle: 'Hue and triangle', wheel: 'Hue and saturation' };
const unit = (n) => Math.min(1, Math.max(0, n));

/** A drag surface whose box (sized by `className`) counts `w` × `h` units. A press picks through onPick(x, y, part) in those units,
 * the part (partAt, else 'body') holding for the drag; arrow keys move the first handle by 1 % of the box, or through
 * keyMove(key, shift) when it handles them. `handles` [[x, y]] draw as rings. */
function Area({ label, w, h, handles, onPick, partAt, keyMove, className, children, ...props }) {
  const part = useRef('body');
  const at = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) * w) / r.width, ((e.clientY - r.top) * h) / r.height];
  };
  const keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  return (
    <div role="slider" aria-label={label} tabIndex={0} {...props}
      className={cn('relative w-full shrink-0 cursor-crosshair touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const [x, y] = at(e);
        part.current = partAt?.(x, y) ?? 'body';
        onPick(x, y, part.current);
      }}
      onPointerMove={(e) => { if (e.buttons & 1) onPick(...at(e), part.current); }}
      onKeyDown={(e) => {
        if (keyMove?.(e.key, e.shiftKey)) { e.preventDefault(); return; }
        const d = keys[e.key];
        if (!d) return;
        e.preventDefault();
        onPick(handles[0][0] + (d[0] * w) / 100, handles[0][1] + (d[1] * h) / 100, 'body');
      }}>
      {children}
      {handles.map(([x, y], i) => (
        <span key={i} className="pointer-events-none absolute size-3 -translate-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#0008]" style={{ left: `${(x / w) * 100}%`, top: `${(y / h) * 100}%` }} />
      ))}
    </div>
  );
}

/** Paints the triangle (its hue ring, and the triangle at colour `c`'s hue) or the wheel (at `c`'s lightness) on canvas `el`, at
 * its drawn size in device pixels. */
function paint(el, area, c) {
  const px = Math.round(el.clientWidth * (window.devicePixelRatio || 1));
  if (el.width !== px) [el.width, el.height] = [px, Math.round((px * H) / W)];
  const g = el.getContext('2d');
  g.setTransform(px / W, 0, 0, px / W, 0, 0);
  g.clearRect(0, 0, W, H);
  const [cx, cy, R] = [W / 2, H / 2, Math.min(W, H) / 2];
  const hues = (l) => {
    const k = g.createConicGradient(0, cx, cy);
    for (let i = 0; i <= 6; i++) k.addColorStop(i / 6, `hsl(${i * 60} 100% ${l}%)`);
    return k;
  };
  if (area === 'wheel') {
    // HSL is linear in saturation, so a grey fading out from the centre over the hues at that lightness draws it exactly.
    const l = hslOfHsv([c.h, c.s, c.v])[2] * 100;
    const disc = new Path2D();
    disc.arc(cx, cy, R, 0, 2 * Math.PI);
    g.fillStyle = hues(l);
    g.fill(disc);
    const grey = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grey.addColorStop(0, `hsl(0 0% ${l}%)`);
    grey.addColorStop(1, `hsl(0 0% ${l}% / 0)`);
    g.fillStyle = grey;
    g.fill(disc);
    return;
  }
  // The triangle's colour is hue × its corner's weight + white × its corner's weight, and each weight falls linearly from its
  // corner to the far edge's middle: black plus two gradients added ('lighter'), then cut to the triangle with soft edges.
  const [hc, wc, kc] = corners(W, H);
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  for (const [from, to, color] of [[hc, mid(wc, kc), `hsl(${c.h} 100% 50%)`], [wc, mid(hc, kc), '#fff']]) {
    const lin = g.createLinearGradient(...from, ...to);
    lin.addColorStop(0, color);
    lin.addColorStop(1, '#000');
    g.fillStyle = lin;
    g.fillRect(0, 0, W, H);
  }
  const tri = new Path2D();
  tri.moveTo(...hc);
  tri.lineTo(...wc);
  tri.lineTo(...kc);
  tri.closePath();
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = '#000';
  g.fill(tri);
  g.globalCompositeOperation = 'source-over';
  const ring = new Path2D();
  ring.arc(cx, cy, R, 0, 2 * Math.PI);
  ring.arc(cx, cy, R * RING, 0, 2 * Math.PI, true);
  g.fillStyle = hues(50);
  g.fill(ring);
}

/** A typed field showing `value` (not while it has the focus: the typed text stays); each edit goes to parse(text), which applies
 * it when it is a value there. */
function Field({ label, value, parse, className }) {
  const [text, setText] = useState(value);
  const ref = useRef(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(value);
  }, [value]);
  return (
    <Input ref={ref} size="xs" aria-label={label} value={text} spellCheck={false} className={cn('px-1 text-center', className)}
      onBlur={() => setText(value)} onChange={(e) => { setText(e.target.value); parse(e.target.value); }} />
  );
}

/** The colour picker: the mode buttons (and the `recent` colours, which `onRecent(hex)` picks), the area, the hue or lightness
 * slider, the opacity slider with `alpha`, and the format menu with its typed fields. It starts at `value` (as rgbaOf reads it, else
 * grey) and focuses its area; `onChange(hex)` gets every change: '#rrggbb', or '#rrggbbaa' below full opacity. The owner applies
 * on Enter and restores on Escape. */
export function ColorPicker({ value, alpha = false, onChange, recent, onRecent }) {
  const saved = useStore((s) => s.settings?.colorPicker) ?? {};
  const area = AREAS.includes(saved.area) ? saved.area : 'square';
  const format = formatShown(saved.format, alpha);
  const [c, setC] = useState(() => withSat({ ...hsvaOf(value), ...(!alpha && { a: 1 }) }));
  const now = useRef(c); // the latest colour: several pointer moves can come between two renders
  const l = hslOfHsv([c.h, c.s, c.v])[2];
  const root = useRef(null);
  const canvas = useRef(null);
  useLayoutEffect(() => {
    if (canvas.current) paint(canvas.current, area, c);
  }, [area, c.h, area === 'wheel' ? l : 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => root.current?.querySelector('[data-picker-area]')?.focus(), []);

  const set = (next) => {
    if (!alpha) next = { ...next, a: 1 };
    next = withSat(next);
    now.current = next;
    setC(next);
    onChange(hexOfHsva(next));
  };
  const patch = (p) => set({ ...now.current, ...p });
  const remember = (p) => saveSettings({ colorPicker: { area, format: saved.format ?? format, ...p } });
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hexOfHsva({ ...c, a: 1 }).slice(i, i + 2), 16));
  const fields = FORMATS[format][1];
  const slider = (label, x, onPick, background) => (
    <Area label={label} w={W} h={BAR} handles={[[x * W, BAR / 2]]} onPick={(px) => onPick(unit(px / W))} className="h-3" style={{ background }} />
  );

  return (
    // The side padding holds a handle at either edge (half its width), so a dialog's body never scrolls sideways for it.
    <div ref={root} data-color-picker={area} data-format={format} className="box-content flex w-52 shrink-0 flex-col gap-2 px-1.5">
      <div className="flex h-6 items-center gap-0.5">
        {MODES.map(([id, name, Icon]) => (
          <IconButton key={id} label={name} pressed={area === id} onClick={() => area !== id && remember({ area: id })}><Icon /></IconButton>
        ))}
        {recent && (
          <div className="ml-auto flex gap-1">
            {Array.from({ length: 6 }, (_, k) => recent[k]).map((x, k) => (x ? (
              <Tip key={k} title={x}>
                <button type="button" aria-label={`Recent colour ${x}`} onClick={() => onRecent(x)}
                  className="size-5 cursor-pointer rounded-sm border border-input" style={{ background: `linear-gradient(${x}, ${x}), ${CHECKS}` }} />
              </Tip>
            ) : <span key={k} className="size-5 rounded-sm border border-dashed border-input" />))}
          </div>
        )}
      </div>
      <Area label={AREA_LABEL[area]} data-picker-area={area} aria-valuetext={hexOfHsva(c)} w={W} h={H} handles={areaHandles(area, c, W, H)}
        partAt={(x, y) => areaPart(area, x, y, W, H)} onPick={(x, y, part) => patch(areaPick(area, now.current, x, y, W, H, part))}
        keyMove={(key, shift) => {
          const p = areaKey(area, now.current, key, shift, W, H);
          if (p) patch(p);
          return !!p;
        }} className="h-40"
        style={area === 'square' ? { background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${c.h} 100% 50%))` } : undefined}>
        {area !== 'square' && <canvas ref={canvas} className="absolute inset-0 size-full" />}
      </Area>
      {/* One row for the hue (square) or lightness (wheel) slider; the triangle's hue is its ring, so the row stays empty. */}
      {area === 'square' ? slider('Hue', c.h / 360, (x) => patch({ h: x * 360 }), 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)')
        : area === 'wheel' ? slider('Lightness', l, (x) => {
          const [, s, v] = hsvOfHsl([now.current.h, now.current.sl, x], now.current.s);
          patch({ s, v });
        }, `linear-gradient(to right, #000, hsl(${c.h} ${c.sl * 100}% 50%), #fff)`)
          : <div className="h-3" />}
      {alpha && slider('Opacity', c.a, (x) => patch({ a: x }), `linear-gradient(to right, transparent, rgb(${r} ${g} ${b})), ${CHECKS}`)}
      <div className="flex items-start gap-1">
        <Pick aria-label="Colour format" value={format} width="4.25rem" onChange={(f) => remember({ format: f })}
          options={Object.entries(FORMATS).filter(([, [, , a]]) => alpha || !a).map(([id, [name]]) => [id, name])} />
        <div className="grid flex-1 grid-cols-4 gap-x-1 gap-y-0.5">
          {fields.map(([key, , name]) => (
            <Field key={`${format}-${key}`} label={name} value={fieldText(key, c)} className={key === 'hex' ? 'col-span-4 font-mono' : undefined}
              parse={(t) => {
                const next = withField(now.current, key, t);
                if (next) set(next);
              }} />
          ))}
          {fields.map(([key, short]) => (
            <span key={key} className={cn('text-center text-[10px] leading-3 text-muted-foreground', key === 'hex' && 'col-span-4')}>{short}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// The colours last applied with a swatch, newest first: every swatch shares them, and the board's colour menus list them
// (board/controls.jsx bindColors). Kept in this browser profile.
const RECENT = 6;
const RECENT_KEY = 'daf-writer.recentColors';
const HEX = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;
let recents = [];
try {
  const stored = JSON.parse(localStorage.getItem(RECENT_KEY));
  if (Array.isArray(stored)) recents = stored.filter((x) => HEX.test(x)).slice(0, RECENT);
} catch { /* no storage: none yet */ }
/** → the recent colours. */
export const recentColors = () => recents;
/** Sets the recent colours to `list` (newest first). */
export function saveRecentColors(list) {
  recents = list.filter((x) => HEX.test(x)).slice(0, RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
  } catch { /* no storage: this session only */ }
}
const same = (x, y) => hexOfHsva(hsvaOf(x)) === hexOfHsva(hsvaOf(y));

/** A colour swatch opening the picker in a popover, with the recent colours; a recent colour applies at once and closes it.
 * `live`: onChange on every change (tool settings); otherwise once, when the picker closes, and `onPreview` on every change
 * meanwhile. Enter or a click elsewhere keeps the colour, Escape puts it back as it was. `alpha` false: no opacity, every colour
 * opaque. `id` goes to the swatch button; `label` is its accessible name when it is not the tooltip `title`; `tipProps` and `contentProps` go to the tooltip and
 * the popover (a board's chrome mark and its focus return). */
export function ColorSwatch({ id, title, label = title, value, live = false, alpha = true, onChange, onPreview, tipProps, contentProps }) {
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState(value);
  const start = useRef(value);
  const show = live ? onChange : onPreview; // what each change calls
  const shown = hexOfHsva(hsvaOf(open ? hex : value));
  // keep: `final` stays (a changed colour applies, if not live already, and becomes a recent one); else the start comes back.
  const close = (keep, final = hex) => {
    setOpen(false);
    if (!keep) return void show?.(start.current);
    if (same(final, start.current)) return;
    if (!live) onChange(final);
    saveRecentColors([final, ...recents.filter((x) => x !== final)]);
  };
  const pickRecent = (x) => {
    if (!alpha) x = x.slice(0, 7);
    if (live) onChange(x);
    close(true, x);
  };
  return (
    <Popover open={open} onOpenChange={(o) => {
      if (!o) return close(true);
      start.current = value;
      setHex(value);
      setOpen(true);
    }}>
      <Tip title={title} {...tipProps}>
        <PopoverTrigger asChild>
          <button id={id} type="button" aria-label={label} className="size-8 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1 dark:bg-input/30">
            <span className="block size-full rounded-sm" style={{ background: `linear-gradient(${shown}, ${shown}), ${CHECKS}` }} />
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent className="w-auto p-2" {...contentProps} onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { e.preventDefault(); close(false); }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.target.closest('button, select')) return;
          e.preventDefault();
          close(true);
        }}>
        <ColorPicker value={value} alpha={alpha} recent={recents} onRecent={pickRecent} onChange={(x) => {
          setHex(x);
          show?.(x);
        }} />
      </PopoverContent>
    </Popover>
  );
}

/** More Colors: the picker in a dialog (id 'colors'), starting at `value`, with opacity when `alpha` (the colour's owner keeps
 * it). → '#RRGGBB', or '#RRGGBBAA' below full opacity; null on Cancel or Escape, which leave the colour as it was. */
export function ColorDialog({ value, alpha = false, onClose }) {
  const [hex, setHex] = useState(() => hexOfHsva({ ...hsvaOf(value), ...(!alpha && { a: 1 }) }));
  return (
    <WordDialog title="Colour" size="fit" result={() => hex.toUpperCase()} onClose={onClose}>
      <ColorPicker value={value} alpha={alpha} onChange={setHex} />
    </WordDialog>
  );
}

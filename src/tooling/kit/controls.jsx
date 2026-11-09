// The dialog kit's controls (docs/plans/word/plan.md §1.6). A `label` may hold Word's "&" access key marker ('Stri&kethrough'): the kit
// underlines that letter and WordDialog's keys find it through data-access. Lengths are points in the model and show in the user's
// unit (units.mjs unitOf); lists that name an `optionsId` show only what the active format grants (§1.19).
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { CheckboxInput } from '@/components/ui/checkbox';
import { RadioInput } from '@/components/ui/radio';
import { NativeSelect, SelectButton } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { keepFocus } from '../../app/components/Toolbar.jsx';
import { Help } from '../../app/components/Tip.jsx';
import { useStore } from '../../app/store.js';
import { grantOptions } from '../profile.mjs';
import { activeSurface } from '../surface.js';
import { formatLength, parseLength, unitOf, UNITS } from './units.mjs';
import { AccessText, accessProps } from './WordDialog.jsx';

// The region's unit ('in' or 'cm', main's app.getSystemLocale()), asked once; until it answers (or without the endpoint) unitOf
// falls back to centimetres.
let region = null;
Promise.resolve(window.api?.word?.region?.()).then((r) => { region = r ?? null; }, () => {});

/** The unit length boxes show now: settings.word.units, else the active format's default, else the region's. */
export function useUnit() {
  const settings = useStore((s) => s.settings);
  return unitOf(settings, activeSurface()?.profile, region);
}

/** `items` ([[value, label]]) as the active format grants list `id` (all of them without an id or a surface). */
function useGranted(id, items) {
  const profile = activeSurface()?.profile;
  return id && profile ? grantOptions(profile, id, items) : items;
}

const round = (n) => Number(n.toFixed(2));
const num = (t) => (/^\s*-?(\d+(\.\d*)?|\.\d+)\s*$/.test(t) ? Number(t) : null);
// Per Spin unit: how a value shows, how typed text reads (→ value or null), the default arrow step (in the shown unit).
const UNIT_KINDS = {
  len: { show: (v, u) => formatLength(v, u), read: (t, u) => parseLength(t, u), step: 0.1 },
  pt: { show: (v) => `${round(v)} pt`, read: (t) => parseLength(t, 'pt'), step: 1 },
  lines: { show: (v) => (v?.lines != null ? `${round(v.lines)} li` : `${round(v)} pt`), read: (t) => parseLength(t, 'pt', { lines: true }), step: 6 },
  pct: { show: (v) => `${round(v)}%`, read: (t) => num(t.replace('%', '')), step: 1 },
  int: { show: (v) => String(round(v)), read: (t) => num(t), step: 1 },
};

/** A list row's look, picked or not: every Word list uses this, so its colours live in one place. */
export const rowClass = (on) => (on ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60');

/** ui Textarea at the kit's size; `rows` or a height class sets its size, and it never grows with its text. */
export const TextArea = ({ className, ...props }) => <Textarea className={cn('field-sizing-fixed min-h-0 px-1.5 py-1 text-xs', className)} {...props} />;

/** Labelled text boxes in a row over a list whose columns start where the boxes' text does (the user, 2026-10-28: AutoCorrect's
 * With column stood off its box). One grid holds both: each field a label and a box, the list a subgrid of it, so a column's
 * place never depends on what is in it. `fields` [[label, id, input props]] one per column; `rows` [[key, ...cells]]; a click
 * picks a row's key. A cell runs on under the next field's label and stops at its box. */
export function FieldList({ fields, rows, value, onPick, label, className = 'h-36' }) {
  const n = fields.length;
  return (
    <div className="grid items-center gap-2" style={{ gridTemplateColumns: `repeat(${n}, auto 1fr)` }}>
      {fields.map(([l, id, input]) => [
        <label key={`${id}-label`} htmlFor={id} {...accessProps(l)}><AccessText label={l} /></label>,
        <Input key={id} id={id} size="xs" spellCheck={false} {...input} />,
      ])}
      <div role="listbox" aria-label={label} className={cn('col-span-full grid grid-cols-subgrid content-start gap-y-0 overflow-auto rounded-md border border-input bg-transparent dark:bg-input/30 text-xs', className)}>
        {rows.map(([key, ...cells]) => (
          <div key={key} role="option" aria-selected={key === value} data-value={key} onClick={() => onPick(key)}
            className={cn('col-span-full grid cursor-default grid-cols-subgrid py-0.5', rowClass(key === value))}>
            {cells.map((c, i) => (
              // From the box's left edge in by its border and padding (Input xs: 1 px, px-2)
              <span key={i} className="truncate pr-1 pl-[calc(0.5rem+1px)]" style={{ gridColumn: `${2 * i + 2} / ${i < n - 1 ? 2 * i + 4 : -1}` }}>{c}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A labelled row, label left. `htmlFor` ties the label (and its access key) to the control; `help` is a (?) after the control. */
export const Row = ({ label, htmlFor, help, children }) => (
  <div className="flex items-center gap-2">
    {label != null && <label htmlFor={htmlFor} className="shrink-0" {...accessProps(label)}><AccessText label={label} /></label>}
    {children}
    {help && <Help>{help}</Help>}
  </div>
);

/** A spin box: `value` in points ('len', 'pt'), a percent, a number ('int') or spacing ('lines': points or {lines}); null shows `auto`.
 * Typed text takes in, ", cm, mm, pt, pi and li (spacing) and converts; each valid value applies at once (so OK sees it), and the box
 * shows it in the user's unit again on blur. The arrows and Up and Down step by `step` in the shown unit, clamped to `min` and `max`. */
export function Spin({ label, value, onChange, unit = 'pt', min = -Infinity, max = Infinity, step, auto, width = '7rem' }) {
  const id = useId();
  const u = useUnit();
  const kind = UNIT_KINDS[unit];
  const show = (v) => (v == null ? auto ?? '' : kind.show(v, u));
  const [text, setText] = useState(() => show(value));
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setText(show(value));
  }, [value, u]); // eslint-disable-line react-hooks/exhaustive-deps
  const clamp = (v) => (typeof v === 'number' ? Math.min(max, Math.max(min, v)) : v);
  const read = (t) => {
    if (auto != null && (!t.trim() || t.trim().toLowerCase() === auto.toLowerCase())) return { v: null };
    const v = kind.read(t, u);
    return v == null ? null : { v: clamp(v) };
  };
  const type = (t) => {
    setText(t);
    const r = read(t);
    if (r) onChange(r.v);
  };
  // Word steps to the next multiple of the step in the shown unit.
  const bump = (dir) => {
    const s = step ?? kind.step;
    const lines = value?.lines != null;
    const k = unit === 'len' && !lines ? UNITS[u] : 1;
    const now = lines ? value.lines : value ?? (Number.isFinite(min) ? min : 0);
    const x = now / k / s;
    const next = (dir > 0 ? Math.floor(x + 1e-6) + 1 : Math.ceil(x - 1e-6) - 1) * s * k;
    const v = lines ? { lines: Math.max(0, round(next)) } : clamp(round(next * 1000) / 1000);
    onChange(v);
    setText(show(v));
  };
  const arrow = (dir, Icon) => (
    <button type="button" tabIndex={-1} aria-label={dir > 0 ? 'Up' : 'Down'} onMouseDown={keepFocus} onClick={() => bump(dir)}
      className="flex h-[calc(0.75rem-1px)] w-4 items-center justify-center text-muted-foreground hover:bg-accent/60 hover:text-foreground [&_svg]:size-3"><Icon /></button>
  );
  return (
    <Row label={label} htmlFor={id}>
      <div data-slot="spin" data-size="xs" style={{ width }}
        className="flex h-6 items-center rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
        <input id={id} value={text} aria-invalid={!read(text)} spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-xs tabular-nums outline-none aria-invalid:text-destructive"
          onFocus={() => { typing.current = true; }} onBlur={() => { typing.current = false; setText(show(value)); }}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); bump(e.key === 'ArrowUp' ? 1 : -1); } }} />
        <div className="flex flex-col">{arrow(1, ChevronUp)}{arrow(-1, ChevronDown)}</div>
      </div>
    </Row>
  );
}

/** A check box; `checked` null draws the mixed state (a selection with both). */
export function Check({ label, checked, onChange, disabled, labelClass, sample }) {
  return (
    <label className="flex w-fit items-center gap-2" {...accessProps(label)}>
      <CheckboxInput indeterminate={checked == null} checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={cn(labelClass, disabled && 'opacity-50')}><AccessText label={label} /></span>
      {sample && <span aria-hidden className="text-muted-foreground">{sample}</span>}
    </label>
  );
}

/** Radio buttons, one per `options` entry ([[value, label]]). */
export function Radio({ value, options, onChange, name }) {
  const own = useId();
  return (
    <div role="radiogroup" className="flex flex-col gap-1.5">
      {options.map(([v, label]) => (
        <label key={String(v)} className="flex w-fit items-center gap-2" {...accessProps(label)}>
          <RadioInput name={name ?? own} checked={v === value} onChange={() => onChange(v)} />
          <AccessText label={label} />
        </label>
      ))}
    </div>
  );
}

// From this many options a Pick is searchable (languages, fonts, styles; the user, 2026-10-28: "long list = bad").
const LONG_PICK = 25;

/** A drop-down list of `options` ([[value, label]]); `optionsId` filters them through the active format's grants. Other props (id,
 * aria-label, disabled) go to the select. A long list opens as a search box over the list (SearchPick). */
export function Pick({ value, options, onChange, width, optionsId, className, ...props }) {
  const list = useGranted(optionsId, options);
  if (list.length >= LONG_PICK) return <SearchPick list={list} value={value} onChange={onChange} width={width} className={className} {...props} />;
  return <NativeSelect size="xs" options={list.map(([v, label]) => [v, label])} width={width} className={className} value={String(value ?? '')}
    onChange={(e) => onChange(list.find(([v]) => String(v) === e.target.value)?.[0] ?? null)} {...props} />;
}

/** A long Pick: a button showing the value that opens a search box over the list. Typing filters by name, Up and Down move, Enter
 * or a click picks. A hidden select with the Pick's id and aria-label stays for labels, harness cases and the agent's ui.invoke. */
function SearchPick({ list, value, onChange, width, className, disabled, ...props }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const rows = useRef(null);
  const trigger = useRef(null);
  const key = String(value ?? '');
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter(([, l]) => String(l).toLowerCase().includes(q)) : list;
  const show = (o) => {
    setOpen(o);
    if (o) { setQuery(''); setAt(Math.max(0, list.findIndex(([v]) => String(v) === key))); }
  };
  const pick = (v) => { onChange(v); setOpen(false); };
  // Braces: Chromium's scrollIntoView returns a promise, which React would take for the effect's cleanup.
  useEffect(() => { rows.current?.children[at]?.scrollIntoView({ block: 'nearest' }); }, [at, open, q]);
  return (
    <>
      <select tabIndex={-1} aria-hidden="true" className="sr-only" value={key} disabled={disabled} {...props}
        onFocus={() => trigger.current?.focus()}
        onChange={(e) => onChange(list.find(([v]) => String(v) === e.target.value)?.[0] ?? null)}>
        {list.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
      </select>
      <Popover open={open} onOpenChange={show}>
        <PopoverTrigger asChild>
          <SelectButton ref={trigger} size="xs" role="combobox" aria-expanded={open} aria-label={props['aria-label']} disabled={disabled} style={{ width }} className={cn('min-w-0 text-left', className)}>
            <span className="min-w-0 flex-1 truncate">{list.find(([v]) => String(v) === key)?.[1] ?? ''}</span>
          </SelectButton>
        </PopoverTrigger>
        <PopoverContent align="start" data-search-pick="" className="w-auto min-w-(--radix-popover-trigger-width) p-1">
          <Input size="xs" autoFocus value={query} placeholder="Search" aria-label="Search" onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setAt((i) => Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
              } else if (e.key === 'Enter' && shown[at]) {
                e.preventDefault();
                pick(shown[at][0]);
              }
            }} />
          <div ref={rows} role="listbox" className="mt-1 max-h-64 max-w-80 overflow-y-auto text-xs">
            {shown.map(([v, l], i) => (
              <div key={String(v)} role="option" aria-selected={String(v) === key} onMouseDown={keepFocus} onClick={() => pick(v)} onMouseMove={() => setAt(i)}
                className={cn('cursor-default truncate rounded-md px-2 py-1', i === at && 'bg-accent', String(v) === key && 'font-medium')}>{l}</div>
            ))}
            {!shown.length && <p className="px-2 py-3 text-center text-muted-foreground">Nothing matches.</p>}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** Word's box over a list (Font, Size, Tab stop position): typing picks the first item that starts with the text; Up and Down move
 * in the list; a click picks. `text` and `onText` hold the box's text when the caller keeps it (a typed tab position). */
export function ListPick({ items, value, onChange, text, onText, height = '6rem', optionsId, width, ...props }) {
  const list = useGranted(optionsId, items);
  const [own, setOwn] = useState(null);
  const box = useRef(null);
  const labelOf = (v) => list.find(([x]) => x === v)?.[1] ?? '';
  const setText = (t) => (onText ? onText(t) : setOwn(t));
  const pick = (v) => {
    onChange(v);
    setText(labelOf(v));
  };
  const type = (t) => {
    setText(t);
    const hit = t && list.find(([, l]) => String(l).toLowerCase().startsWith(t.toLowerCase()));
    if (hit) onChange(hit[0]);
  };
  const move = (d) => {
    const i = list.findIndex(([v]) => v === value);
    const next = list[Math.min(list.length - 1, Math.max(0, i + d))];
    if (next) pick(next[0]);
  };
  // Braces: Chromium's scrollIntoView returns a promise, which React would take for the effect's cleanup.
  useEffect(() => { box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [value]);
  return (
    <div className="flex flex-col" style={{ width }}>
      <Input size="xs" spellCheck={false} value={text ?? own ?? labelOf(value)} className="rounded-b-none" onChange={(e) => type(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); move(e.key === 'ArrowUp' ? -1 : 1); } }} {...props} />
      {/* Its rows' text under the box's: both 1 px border and 0.5rem padding in */}
      <div ref={box} role="listbox" style={{ height }} className="overflow-auto rounded-b-md border border-t-0 border-input bg-transparent dark:bg-input/30 text-xs">
        {list.map(([v, label]) => (
          <div key={String(v)} role="option" aria-selected={v === value} onMouseDown={keepFocus} onClick={() => pick(v)}
            className={cn('cursor-default truncate py-0.5 pr-1.5 pl-2', rowClass(v === value))}>{label}</div>
        ))}
      </div>
    </div>
  );
}

/** Word's titled group box: the title, a rule to its right, the controls under it. `help` is a (?) after the title. */
export const Fieldset = ({ legend, help, children }) => (
  <div role="group" className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <span className="text-sm leading-none font-semibold"><AccessText label={legend} /></span>
      {help && <Help>{help}</Help>}
      <Separator className="flex-1" />
    </div>
    <div className="flex flex-col gap-2 pl-3">{children}</div>
  </div>
);

const greyLines = (n) => Array.from({ length: n }, (_, i) => (
  <div key={i} className="h-1 rounded-full bg-neutral-300" style={{ width: i === n - 1 ? '55%' : '100%' }} />
));

/** The sample: white like the sheet in either theme, with grey text lines before and after it; `page` draws it as a small page. */
export const Preview = ({ children, height = '6rem', page = false }) => (
  <div style={{ height }} className={cn('flex flex-col justify-center gap-1 overflow-hidden border border-neutral-300 bg-white px-3 py-2 text-black',
    page && 'mx-auto aspect-[3/4] shadow-sm')}>
    {greyLines(2)}
    <div className="py-1">{children}</div>
    {greyLines(3)}
  </div>
);

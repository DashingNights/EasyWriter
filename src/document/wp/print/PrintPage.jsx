// File > Print (docs/plans/word/briefs/print.md): Word's Print page inside the backstage's modal page. Left, the Print button with
// Copies, the printer and the Settings dropdowns (each with a two-line face); right, a preview of one laid-out page at a time with
// page navigation and zoom. Orientation, paper and margins run the Layout tab's commands on the selection's section.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import {
  BookOpen, Check, ChevronLeft, ChevronRight, Copy, Files, FileText, Info, Maximize, Printer, RectangleHorizontal, RectangleVertical,
  Rows2, ScrollText, StickyNote,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MARGIN_PRESETS, PAPER_SIZES } from '../../../office.mjs';
import { useUnit } from '../../../tooling/kit/controls.jsx';
import { formatLength } from '../../../tooling/kit/units.mjs';
import { REASONS } from '../../../tooling/reasons.mjs';
import { useWordCtx } from '../../../tooling/registry.js';
import { Tip } from '../../../app/components/Tip.jsx';
import { geometryOf, pageClone } from '../../geometry.js';
import { saveWord } from '../../word/settings.mjs';
import { opts, printDocument } from './printing.js';
import { parsePages, PAGES_HINT } from './ranges.mjs';

const api = () => globalThis.__wordTest?.word ?? window.api.word;

/** A Settings dropdown: a two-line face (`title`, `sub`) opening `items` ({id, title, sub, icon, active, disabled, reason, pick},
 * {label} or {sep: true}). */
function Choice({ feature, icon: Icon, title, sub, items }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" data-feature={feature} className="flex w-full items-center gap-3 rounded-md border px-3 py-1.5 text-left hover:bg-accent/60">
          {Icon && <Icon className="size-6 shrink-0 opacity-80" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{title}</span>
            {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-80 overflow-auto">
        {items.map((it, k) => {
          if (it.sep) return <DropdownMenuSeparator key={k} />;
          if (it.label) return <DropdownMenuLabel key={k} className="text-xs text-muted-foreground">{it.label}</DropdownMenuLabel>;
          const I = it.icon;
          const row = (
            <DropdownMenuItem key={it.id} data-feature={it.id} disabled={it.disabled} aria-disabled={it.disabled || undefined}
              aria-checked={it.active || undefined} onSelect={it.pick} className="gap-3">
              {I ? <I className="size-5 shrink-0 opacity-80" /> : <Check className={cn('size-4 shrink-0', !it.active && 'invisible')} />}
              <span className="min-w-0">
                <span className={cn('block', it.active && 'font-medium')}>{it.title}</span>
                {it.sub && <span className="block text-xs text-muted-foreground">{it.sub}</span>}
              </span>
            </DropdownMenuItem>
          );
          // A disabled item takes no pointer, so its reason sits on a wrapper, as the ribbon's menus do.
          return it.disabled && it.reason ? <Tip key={it.id} title={it.reason} side="right" wrap="w-full">{row}</Tip> : row;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const WHAT = {
  all: ['Print All Pages', 'The whole document', Files],
  selection: ['Print Selection', 'Only the pages of what you selected', ScrollText],
  current: ['Print Current Page', 'Only the page with the cursor', FileText],
  custom: ['Custom Print', 'Type pages, sections or ranges', Files],
  info: ['Document Info', 'A list of the properties, such as the title and author', Info],
};
const SIDES = {
  one: ['Print One Sided', 'Only print on one side of the paper'],
  long: ['Print on Both Sides', 'Flip pages on the long edge'],
  short: ['Print on Both Sides', 'Flip pages on the short edge'],
  manual: ['Manually Print on Both Sides', 'Put the paper back in when asked to print the second side'],
};
const PER_SHEET = [1, 2, 4, 6, 8, 16];

/** The preview: page `page` of `view`'s laid-out pages at `zoom` (null fits the page), redrawn after each layout. */
function Preview({ view, version, page, setPage, n }) {
  const host = useRef(null);
  const [zoom, setZoom] = useState(null);
  const [fit, setFit] = useState(1);
  const [typed, setTyped] = useState(null);
  useLayoutEffect(() => {
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const el = host.current;
        const box = geometryOf(view.state)?.pages[page]?.box;
        if (!el || !box) return el?.replaceChildren();
        const f = Math.min((el.clientWidth - 32) / box.w, (el.clientHeight - 32) / box.h);
        setFit(f);
        // match: laid out at the editor's zoom, so its lines break where the page's do (printing.js prints at 100%).
        const clone = pageClone(view, page, { scale: zoom ?? f, near: true, match: true });
        clone.classList.add('mx-auto', 'my-4', 'shadow-lg');
        el.replaceChildren(clone);
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [view, version, page, zoom]);
  const go = (p) => setPage(Math.max(0, Math.min(n - 1, p)));
  const keys = (e) => {
    const step = { PageDown: 1, PageUp: -1 }[e.key];
    if (step && !e.ctrlKey) go(page + step);
    else if (e.ctrlKey && e.key === 'Home') go(0);
    else if (e.ctrlKey && e.key === 'End') go(n - 1);
    else return;
    e.preventDefault();
  };
  const pct = Math.round((zoom ?? fit) * 100);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-muted/40" data-feature="file.print.preview">
      <div ref={host} tabIndex={0} onKeyDown={keys} aria-label="Print preview" data-print-preview=""
        className="min-h-0 flex-1 overflow-auto outline-none" />
      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs">
        <button type="button" aria-label="Previous page" disabled={page <= 0} onClick={() => go(page - 1)} className="rounded-sm p-1 hover:bg-accent disabled:opacity-40">
          <ChevronLeft className="size-4" />
        </button>
        <input aria-label="Current page" className="w-10 rounded-sm border bg-background px-1 text-center" inputMode="numeric"
          value={typed ?? String(page + 1)} onChange={(e) => setTyped(e.target.value.replace(/\D/g, ''))} onBlur={() => setTyped(null)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !typed) return;
            go(Number(typed) - 1);
            setTyped(null);
          }} />
        <span data-print-count="">of {n}</span>
        <button type="button" aria-label="Next page" disabled={page >= n - 1} onClick={() => go(page + 1)} className="rounded-sm p-1 hover:bg-accent disabled:opacity-40">
          <ChevronRight className="size-4" />
        </button>
        <span className="flex-1" />
        <input type="range" aria-label="Zoom" min={10} max={300} value={pct} onChange={(e) => setZoom(Number(e.target.value) / 100)} className="w-32" />
        <span className="w-10 text-right">{pct}%</span>
        <button type="button" aria-label="Zoom to Page" title="Zoom to Page" onClick={() => setZoom(null)} className="rounded-sm p-1 hover:bg-accent">
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** The Print backstage page. */
export function PrintPage({ close }) {
  const ctx = useWordCtx();
  const unit = useUnit();
  // Print Selection with nothing selected falls back to every page, as Word's does.
  const [o, setO] = useState(() => {
    if (opts.what === 'selection' && ctx.state?.selection.empty) opts.what = 'all';
    return { ...opts };
  });
  const [printers, setPrinters] = useState([]);
  const [busy, setBusy] = useState(false);
  const [secondSide, setSecondSide] = useState(false);
  const [page, setPage] = useState(0);
  const [version, setVersion] = useState(0);
  const set = (patch) => {
    Object.assign(opts, patch);
    setO({ ...opts });
  };
  const view = ctx.ed?.view;

  useEffect(() => {
    let live = true;
    api().printers().then((list) => {
      if (!live) return;
      const sorted = [...(list ?? [])].sort((a, b) => b.isDefault - a.isDefault);
      setPrinters(sorted);
      if (!opts.printer || !sorted.some((p) => p.name === opts.printer)) set({ printer: sorted[0]?.name ?? null });
    }).catch(() => setPrinters([]));
    return () => {
      live = false;
    };
  }, []);
  // The geometry is replaced after pagination's frame, without a transaction: redraw a frame after each change of the document.
  useEffect(() => {
    const id = requestAnimationFrame(() => setVersion((v) => v + 1));
    return () => cancelAnimationFrame(id);
  }, [ctx.state]);
  useEffect(() => {
    const geo = view && geometryOf(view.state);
    if (geo) setPage(Math.min(geo.page ?? 0, geo.pages.length - 1));
  }, [view]);

  if (!view) return <p className="text-sm text-muted-foreground">Open a document to print it.</p>;
  const geo = geometryOf(view.state);
  const pages = geo?.pages ?? [];
  const n = pages.length;
  const word = ctx.settings.word.print;
  const custom = o.what === 'custom' || (o.what === 'all' && o.text);
  const parsed = custom && o.text ? parsePages(o.text, pages) : null;
  const what = WHAT[custom ? 'custom' : o.what] ?? WHAT.all;
  const printer = printers.find((p) => p.name === o.printer);
  const { T, sect } = ctx;
  const m = sect?.margin ?? {};
  const paperKey = T.paperSize.value;
  const marginKey = T.margins.value;
  const len = (pt) => formatLength(pt, unit);
  const hasSelection = !ctx.state.selection.empty;

  const doPrint = async (extra = {}) => {
    setBusy(true);
    try {
      const r = await printDocument(ctx.ed, { ...opts, ...extra });
      if (r.ok && extra.odd && !extra.even) setSecondSide(true);
      else if (r.ok) close();
    } finally {
      setBusy(false);
    }
  };
  const print = () => (o.sides === 'manual' ? doPrint({ odd: true, even: false }) : doPrint());

  const whatItems = [
    { label: 'Document' },
    ...['all', 'selection', 'current', 'custom'].map((k) => ({
      id: `file.print.settings.pages.${k}`, title: WHAT[k][0], sub: WHAT[k][1], icon: WHAT[k][2], active: (custom ? 'custom' : o.what) === k,
      disabled: k === 'selection' && !hasSelection, reason: 'Select some text first.',
      // Any choice but Custom Print empties the Pages box, as Word's does.
      pick: () => set(k === 'custom' ? { what: k } : { what: k, text: '' }),
    })),
    { label: 'Document Info' },
    { id: 'file.print.settings.pages.info', title: WHAT.info[0], sub: WHAT.info[1], icon: Info, active: o.what === 'info', pick: () => set({ what: 'info' }) },
    { id: 'file.print.settings.pages.listOfMarkup', title: 'List of Markup', sub: 'Your tracked changes', icon: StickyNote, disabled: true, reason: REASONS.pending },
    { sep: true },
    { id: 'print.markup', title: 'Print Markup', active: word.markup, pick: () => saveWord({ print: { markup: !word.markup } }) },
    { id: 'file.print.settings.pages.odd', title: 'Only Print Odd Pages', active: o.odd && !o.even, pick: () => set({ odd: !(o.odd && !o.even), even: false }) },
    { id: 'file.print.settings.pages.even', title: 'Only Print Even Pages', active: o.even && !o.odd, pick: () => set({ even: !(o.even && !o.odd), odd: false }) },
  ];
  const sideItems = Object.entries(SIDES).map(([k, [title, sub]]) => ({
    id: `file.print.settings.sides.${k}`, title, sub, icon: k === 'one' ? FileText : Copy, active: o.sides === k, pick: () => set({ sides: k }),
  }));
  const collateItems = [
    { id: 'file.print.settings.collated.collated', title: 'Collated', sub: '1,2,3   1,2,3   1,2,3', icon: Rows2, active: o.collate, pick: () => set({ collate: true }) },
    { id: 'file.print.settings.collated.uncollated', title: 'Uncollated', sub: '1,1,1   2,2,2   3,3,3', icon: Rows2, active: !o.collate, pick: () => set({ collate: false }) },
  ];
  const orientItems = [['portrait', 'Portrait Orientation', RectangleVertical], ['landscape', 'Landscape Orientation', RectangleHorizontal]].map(([k, title, icon]) => ({
    id: `file.print.settings.orientation.${k}`, title, icon, active: T.orientation.value === k, pick: () => ctx.run(`layout.pageSetup.orientation.${k}`),
  }));
  const paperItems = [
    ...Object.entries(PAPER_SIZES).map(([k, p]) => ({
      id: `file.print.settings.paper.${k}`, title: p.label, sub: `${len(p.w)} x ${len(p.h)}`, icon: FileText, active: paperKey === k,
      pick: () => ctx.run('layout.pageSetup.size', k),
    })),
    { sep: true },
    { id: 'file.print.settings.paper.more', title: 'More Paper Sizes...', pick: () => ctx.run('layout.pageSetup.size.morePaperSizes') },
  ];
  const marginItems = [
    ...['normal', 'narrow', 'moderate', 'wide'].map((k) => {
      const p = MARGIN_PRESETS[k];
      return {
        id: `file.print.settings.margins.${k}`, title: `${p.label} Margins`, icon: BookOpen, active: marginKey === k,
        sub: `Top: ${len(p.top)} Bottom: ${len(p.bottom)} Left: ${len(p.left)} Right: ${len(p.right)}`,
        pick: () => ctx.run(`layout.pageSetup.margins.${k}Margins`),
      };
    }),
    { sep: true },
    { id: 'file.print.settings.margins.custom', title: 'Custom Margins...', pick: () => ctx.run('layout.pageSetup.margins.customMargins') },
  ];
  const perSheetItems = [
    ...PER_SHEET.map((k) => ({ id: `file.print.settings.pagesPerSheet.${k}`, title: `${k} ${k === 1 ? 'Page' : 'Pages'} Per Sheet`, active: o.perSheet === k,
      pick: () => set({ perSheet: k }) })),
    { sep: true },
    { id: 'file.print.settings.pagesPerSheet.scale', title: 'Scale to Paper Size', disabled: true, reason: REASONS.printer },
  ];

  return (
    <div data-print-page="" className="-mt-2 flex h-[calc(100%-3rem)] min-h-[28rem] gap-8 text-[13px]">
      <div className="w-80 shrink-0 space-y-3 overflow-auto pr-1">
        <div className="flex items-center gap-4">
          <button type="button" data-feature="file.print.print" disabled={busy || n === 0} onClick={print}
            className="flex size-20 flex-col items-center justify-center gap-1 rounded-md border hover:bg-accent/60 disabled:opacity-40">
            <Printer className="size-8" />
            <span>Print</span>
          </button>
          <label className="flex items-center gap-2">
            Copies:
            <input type="number" data-feature="file.print.copies" aria-label="Copies" min={1} max={32767} value={o.copies}
              onChange={(e) => set({ copies: Math.max(1, Number(e.target.value) || 1) })} className="w-16 rounded-md border bg-background px-2 py-1" />
          </label>
        </div>
        {secondSide && (
          <div className="space-y-2 rounded-lg border border-primary/50 p-3">
            <p>When the first side has printed, put the pages back in the tray to print on their other side.</p>
            <button type="button" data-feature="file.print.secondSide" className="rounded-md border px-3 py-1 hover:bg-accent/60"
              onClick={() => { setSecondSide(false); doPrint({ odd: false, even: true }); }}>
              Print the second side
            </button>
          </div>
        )}
        <h2 className="pt-2 text-base font-medium">Printer</h2>
        <Choice feature="file.print.printer" icon={Printer} title={printer?.displayName || printer?.name || 'No printer found'}
          sub={printer ? (printer.isDefault ? 'Ready, the default printer' : 'Ready') : 'Add a printer in the system settings'}
          items={printers.map((p) => ({ id: `file.print.printer.${p.name}`, title: p.displayName || p.name, sub: p.isDefault ? 'Default printer' : undefined,
            icon: Printer, active: p.name === o.printer, pick: () => set({ printer: p.name }) }))} />
        <button type="button" data-feature="file.print.printerProperties" aria-disabled title={REASONS.printer} className="text-xs text-primary opacity-50">
          Printer Properties
        </button>
        <h2 className="pt-2 text-base font-medium">Settings</h2>
        <Choice feature="file.print.settings.pages" icon={what[2]} title={what[0]} sub={what[1]} items={whatItems} />
        <label className="flex items-center gap-2">
          Pages:
          <input data-feature="file.print.pagesBox" aria-label="Pages" value={o.text} disabled={o.what === 'info'}
            onChange={(e) => set({ text: e.target.value, what: e.target.value ? 'custom' : o.what === 'custom' ? 'all' : o.what })}
            className={cn('min-w-0 flex-1 rounded-md border bg-background px-2 py-1', parsed?.error && 'border-destructive')} />
          <span title={PAGES_HINT}><Info className="size-4 opacity-60" /></span>
        </label>
        {parsed?.error && <p role="alert" className="text-xs text-destructive">{parsed.error}</p>}
        <Choice feature="file.print.settings.sides" icon={o.sides === 'one' ? FileText : Copy} title={SIDES[o.sides][0]} sub={SIDES[o.sides][1]} items={sideItems} />
        <Choice feature="file.print.settings.collated" icon={Rows2} title={o.collate ? 'Collated' : 'Uncollated'}
          sub={o.collate ? '1,2,3   1,2,3   1,2,3' : '1,1,1   2,2,2   3,3,3'} items={collateItems} />
        <Choice feature="file.print.settings.orientation" icon={T.orientation.value === 'landscape' ? RectangleHorizontal : RectangleVertical}
          title={T.orientation.value === 'landscape' ? 'Landscape Orientation' : 'Portrait Orientation'} items={orientItems} />
        <Choice feature="file.print.settings.paper" icon={FileText} title={PAPER_SIZES[paperKey]?.label ?? 'Custom size'}
          sub={sect ? `${len(sect.w)} x ${len(sect.h)}` : undefined} items={paperItems} />
        <Choice feature="file.print.settings.margins" icon={BookOpen} title={marginKey ? `${MARGIN_PRESETS[marginKey].label} Margins` : 'Custom Margins'}
          sub={`Left: ${len(m.left ?? 0)} Right: ${len(m.right ?? 0)}`} items={marginItems} />
        <Choice feature="file.print.settings.pagesPerSheet" icon={Files} title={`${o.perSheet} ${o.perSheet === 1 ? 'Page' : 'Pages'} Per Sheet`} items={perSheetItems} />
        <button type="button" data-feature="file.print.pageSetupLink" onClick={() => ctx.run('layout.pageSetup.launcher')} className="text-xs text-primary hover:underline">
          Page Setup
        </button>
      </div>
      {n ? <Preview view={view} version={version} page={Math.min(page, n - 1)} setPage={setPage} n={n} />
        : <p className="text-sm text-muted-foreground">The pages show in Print Layout.</p>}
    </div>
  );
}

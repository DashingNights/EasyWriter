// The classic ribbon (docs/plans/word/plan.md §1.4 Rendering contract, §2.8; brief.md decision 2): the tab row (File, the
// tabs, contextual tabs in the accent colour, then at the row's right end the search box, the Quick Access Toolbar and the
// row's own controls; direction.md 6 keeps them out of the title bar) over the full-height body of the active tab's
// groups, each with its label at the bottom and its dialog launcher at the bottom right. Collapse and expand with Ctrl+F1,
// a double-click on a tab or the display options at the body's bottom right; a collapsed ribbon opens over the page on a tab
// click. Adaptive groups (ribbon-chrome): the body is sized by the ribbon's own width, never the window's, through
// layout.mjs fit over group widths measured once per tab in a hidden copy. Product-neutral: the spec, the icon set and the
// fallback boxes are props, and every action goes through the registry. Only the active tab's controls are drawn, so only
// they evaluate enabled, active and value on each transaction.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from 'cn';
import { ChevronDown, Pin, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CHROME, keepFocus as keepBoardFocus } from '../../app/components/board/controls.jsx';
import { Tip } from '../../app/components/Tip.jsx';
import { keepFocus } from '../../app/components/Toolbar.jsx';
import { getState, useStore } from '../../app/store.js';
import { run, useWordCtx } from '../registry.js';
import { pickTab, setWord, useRibbonTabs } from './contexts.js';
import { fit, galleryOfGroup, groupAt, itemOf, itemsOf, layoutTab, LEVELS, loneGroup } from './layout.mjs';
import { afterSlide } from '../../app/sliding.js';
import { EXTRA } from './extra.mjs';
import { shareSpec } from './menus.jsx';
import { BTN, Control, GroupGuard, iconOf, Launcher, MenuButton, RibbonContext, stateOf, useOutside } from './parts.jsx';

// The spec drawn last, for showRibbonTab, which the tutorial calls from outside the ribbon.
let current = null;

/** Collapses the ribbon to its tab row, or pins it open again (the pin, a double-click on a tab): the registry's
 * frame.tabRow.collapse, which Ctrl+F1 runs through its window key row. */
export function toggleRibbon() {
  run('frame.tabRow.collapse');
}

/** Shows tab `id` (the tutorial, Onboarding, harness cases); a collapsed ribbon opens over the page with it. */
export function showRibbonTab(id) {
  if (current) pickTab(current, id);
  else setWord({ tab: id });
  if (getState().word?.ribbon === 'tabs') setWord({ peek: true });
}

// A Quick Access Toolbar id the spec lacks is looked up among the controls its owner added (extra.mjs).
const controlOf = (spec, id) => itemOf(spec, id) ?? (EXTRA[id] ? itemOf({ CONTROLS: EXTRA }, id) : null);

// Adaptive groups can be switched off for a harness case that needs the full layout at any width.
let adaptive = true;

// Harness cases (plan.md §1.16) reach the ribbon's state through window.__word.ribbon: show a tab, collapse, patch the store's
// word fields (a view the views package will set, the collapsed state), and turn adaptive groups off and on.
if (typeof window !== 'undefined') {
  window.__word = Object.assign(window.__word ?? {}, {
    ribbon: { show: showRibbonTab, toggle: toggleRibbon, word: setWord, adaptive: (on) => { adaptive = !!on; setWord({ fitVersion: (getState().word?.fitVersion ?? 0) + 1 }); } },
  });
}

// TAB_ROW ids the renderer draws itself: the collapse (the pin of an open collapsed ribbon) and the display options (the
// body's bottom right).
const OWN = /\.(collapse|ribbonDisplayOptions)$/;

/** One group: its columns, label and launcher (§1.4 Group), or the one large button of a collapsed group. A failing group
 * draws its label only. data-keytip stays on every group (the scaffold contract); KeyTips use only a collapsed group's. */
function Group({ g }) {
  if (g.collapsed) return <CollapsedGroup g={g} />;
  return (
    <div role="group" aria-label={g.label} data-group={g.id} data-keytip={g.keytip ?? undefined} data-level={g.level || undefined}
      className="relative flex shrink-0 flex-col border-r border-border/70 px-1 last:border-r-0">
      <GroupGuard id={g.id} fallback={<div className="flex-1" />}>
        <div className="flex min-h-0 flex-1 items-stretch gap-1 pt-[3px]">
          {g.columns.map((col, i) => <Column key={i} col={col} />)}
        </div>
      </GroupGuard>
      {/* With a launcher the label keeps its width clear on both sides, so a narrow group's label never runs under it */}
      <div className={cn('h-[17px] text-center text-[11px] leading-[16px] whitespace-nowrap text-muted-foreground', g.launcher ? 'px-[18px]' : 'px-3')}>{g.label}</div>
      {g.launcher && <Launcher item={g.launcher} />}
    </div>
  );
}

/** A collapsed group: one large button with the group's label and an arrow, which drops the whole group down at full size
 * (its Z KeyTip opens it too). A control pressed in the drop-down closes it. Its icon, label and arrow sit where a large split
 * button's do (parts.jsx Face: the 42 px icon half, then the label lines), so they line up with Paste or Dictate beside it. */
function CollapsedGroup({ g }) {
  const [open, setOpen] = useState(false);
  const outer = useContext(RibbonContext);
  const Icon = iconOf(outer.icons, itemsOf(g.columns)[0]?.control.icon);
  const inner = useMemo(() => ({ ...outer, done: () => { setOpen(false); outer.done?.(); } }), [outer]);
  return (
    <div role="group" aria-label={g.label} data-group={g.id} data-keytip={g.keytip ?? undefined} data-group-collapsed=""
      className="relative flex shrink-0 flex-col border-r border-border/70 px-1 pt-[3px] pb-1 last:border-r-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" data-group-button={g.id} data-keytip={g.keytip ?? undefined} aria-label={g.label} onMouseDown={keepFocus}
            className={cn(BTN, 'h-full min-w-[48px] flex-col justify-start px-1 text-[12px] leading-[14px]')}>
            <span className="flex h-[42px] shrink-0 items-center justify-center pt-1"><Icon className="size-8 shrink-0" strokeWidth={1.25} /></span>
            <span className="flex flex-col items-center whitespace-nowrap">
              <span>{g.label}</span>
              <span className="inline-flex items-center gap-0.5"><ChevronDown className="size-3 opacity-70" /></span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" data-group-popup={g.id} className="w-auto p-0" onOpenAutoFocus={keepFocus} onCloseAutoFocus={keepFocus}>
          <RibbonContext.Provider value={inner}>
            <div className="flex h-[99px] py-0.5"><Group g={{ ...g, collapsed: false, level: 0 }} /></div>
          </RibbonContext.Provider>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** A column: one large control or gallery, or two or three rows of medium and small controls with joined button groups and
 * an optional caption over them (Layout > Paragraph's Indent and Spacing). Two rows sit centred, as Word draws them. */
function Column({ col }) {
  if (col.kind !== 'rows') return col.item ? <div className="flex items-stretch">{<Control item={col.item} />}</div> : null;
  const n = col.rows.length + (col.caption ? 1 : 0);
  return (
    <div className={cn('flex flex-col', n >= 3 ? 'justify-start gap-[3px]' : 'justify-center gap-2 pb-1')}>
      {col.caption && <div className="h-[22px] px-1 text-[12px] leading-[22px] whitespace-nowrap">{col.caption}</div>}
      {col.rows.map((row, i) => (
        <div key={i} className="flex h-[22px] items-center gap-1.5">
          {row.map((e) => (e.join
            ? <span key={e.join[0].id} className="inline-flex items-center">{e.join.map((it) => <Control key={it.id} item={it} caption={col.caption} />)}</span>
            : <Control key={e.id} item={e} caption={col.caption} />))}
        </div>
      ))}
    </div>
  );
}

/** The search box at the tab row's right end: a field-shaped button that runs command `item` (Word's box opens its search;
 * here tool search), with the item's KeyTip or Q (Alt+Q in probe/ribbon.md's frame, which the spec does not carry yet). */
function SearchBox({ item }) {
  const { label } = item.control;
  return (
    <button type="button" data-feature={item.id} data-keytip={item.control.keytip ?? 'Q'} aria-label={label} tabIndex={-1} onMouseDown={keepFocus} onClick={() => run(item.cmd)}
      className="flex h-[24px] min-w-[28px] flex-[0_1_14rem] items-center gap-2 overflow-hidden rounded-md border bg-card px-[6px] text-[12px] text-muted-foreground hover:bg-accent/60">
      <Search className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The display options at the body's bottom right: a small arrow opening the menu of `item` (Show tabs only, Always show
 * Ribbon...). Its KeyTip belongs to the tab row's level (Alt, Z, R). */
function DisplayOptions({ item }) {
  const { ctx, spec } = useContext(RibbonContext);
  const st = stateOf(item, ctx, spec);
  if (!st) return null;
  const trigger = (
    <button type="button" data-feature={item.id} data-keytip={item.control.keytip} data-keytip-level="top" aria-label={st.label} tabIndex={-1}
      aria-disabled={st.off || undefined} onMouseDown={keepFocus} className={cn(BTN, 'grid size-5 place-items-center')}>
      <ChevronDown className="size-4" />
    </button>
  );
  return (
    <Tip title={st.label} side="bottom" wrap="shrink-0 items-end p-1">
      <MenuButton item={item} st={st} trigger={trigger} align="end" />
    </Tip>
  );
}

// Group widths measured per tab and font size: {key → {groupId: [w0, w1, w2, w3]}}.
const measured = new Map();
// The root font size is app.css's fixed 13px: read once, since getComputedStyle on each render recalculated the whole page's
// style after every keypress (plan.md section 6 risk 6).
let rem = 0;
const remPx = () => rem || (rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 0) || 16;

/** A hidden copy of tab `model` at every shrink level, measured once and dropped: onDone({groupId: [w0, w1, w2, w3]}). It sits
 * outside [data-ribbon-body] and after it, inert, so no reader (KeyTips, harness cases) takes its controls for the real ones. */
function Measure({ model, onDone }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const widths = {};
    for (const el of ref.current.querySelectorAll('[data-measure-group]')) {
      const [id, lv] = el.dataset.measureGroup.split('|');
      (widths[id] ??= [])[Number(lv)] = el.getBoundingClientRect().width;
    }
    onDone(widths);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-measure="" aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden">
      <div ref={ref} className="flex h-[99px] w-max items-stretch">
        {model.groups.flatMap((g) => LEVELS.map((lv) => (
          <div key={`${g.id}|${lv}`} data-measure-group={`${g.id}|${lv}`} className="flex shrink-0 items-stretch"><Group g={groupAt(g, lv)} /></div>
        )))}
      </div>
    </div>
  );
}

/** The fitted groups of tab `model` for the scroll box `box`: widths measured once per tab and font size, the box's width
 * followed through a ResizeObserver on the ribbon root `root` (its own width, never the window's). → {groups, measure}: the
 * groups to draw and, while a tab is unmeasured, the Measure element to mount. */
function useFit(model, root, box) {
  const key = model ? `${model.id}|${remPx()}` : null;
  const [widths, setWidths] = useState(() => (key ? measured.get(key) ?? null : null));
  const [room, setRoom] = useState(0);
  useStore((s) => s.word?.fitVersion); // window.__word.ribbon.adaptive
  useEffect(() => setWidths(key ? measured.get(key) ?? null : null), [key]);
  useEffect(() => {
    if (!root.current || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => afterSlide(read) || setRoom(box.current?.clientWidth ?? 0); // once the sidebar's slide ends (sliding.js)
    const ro = new ResizeObserver(read);
    ro.observe(root.current);
    read();
    return () => ro.disconnect();
  }, [root, box, !!model]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => {
    if (!model || !widths || !room || !adaptive) return null;
    const col = 5.75 * remPx() + 1; // a gallery tile and its gap (parts.jsx GalleryControl)
    return fit(model.groups.map((g) => {
      const gal = galleryOfGroup(g);
      return { id: g.id, widths: widths[g.id] ?? [0, 0, 0, 0], gallery: gal && { cols: gal.cols, min: Math.min(3, gal.cols), col }, lone: loneGroup(g) };
    }), room - 1);
  }, [model, widths, room, adaptive]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = model ? model.groups.map((g) => groupAt(g, result?.levels[g.id] ?? 0, result?.cols[g.id] ?? null)) : [];
  const measure = model && !widths && adaptive
    ? <Measure key={key} model={model} onDone={(w) => { measured.set(key, w); setWidths(w); }} /> : null;
  return { groups, measure, overflow: !!result?.overflow };
}

/** The ribbon for `spec` (§1.4) with `icons` (a map or resolver of icon names), `boxes` ({controlId: Component({ctx, st})}:
 * fallback combo boxes for ids without a gallery provider), `onFile` (the File tab), `qat` (the Quick Access Toolbar's ids, in
 * order; empty while it is hidden), `search` (the search box's command id), `show` (hidden tab ids to show) and
 * `autoHide` (full-screen mode and Focus: drawn over the page only while the pointer is within 8 px of its top edge or over it),
 * `titleBar` (the tab row is the window's title row: its drag region, data-titlebar, room for the window controls) and `lead`
 * (what the tab row shows before File).
 * The store's word fields qatBelow (the Quick Access Toolbar under the body) and touch (wider rows) come from ribbon-chrome.
 * The root keeps data-ribbon and data-agent-area="toolbar" for the readers codemap.md §7 lists. */
export function Ribbon({ spec, icons, boxes, onFile, qat = [], search, show = [], autoHide = false, titleBar = false, lead = null }) {
  current = spec;
  shareSpec(spec, icons);
  const ctx = useWordCtx();
  const { tabs, tab } = useRibbonTabs(spec, ctx, show);
  const collapsed = useStore((s) => s.word?.ribbon === 'tabs');
  const peek = useStore((s) => !!s.word?.peek) && collapsed;
  const below = useStore((s) => !!s.word?.qatBelow);
  const touch = useStore((s) => !!s.word?.touch);
  const model = useMemo(() => (tab ? layoutTab(spec, tab) : null), [spec, tab]);
  const right = useMemo(() => (spec.TAB_ROW ?? []).filter((id) => !OWN.test(id)).map((id) => itemOf(spec, id)).filter(Boolean), [spec]);
  const display = useMemo(() => (spec.TAB_ROW ?? []).filter((id) => /\.ribbonDisplayOptions$/.test(id)).map((id) => itemOf(spec, id)).find(Boolean), [spec]);
  // The Quick Access Toolbar's KeyTips go by position (1, 2, 3...), as Word numbers whatever the bar shows; a spec QAT control
  // with no KeyTip of its own (the customise arrow) stays without one.
  const quick = useMemo(() => {
    let n = 0;
    return qat.map((id) => controlOf(spec, id)).filter(Boolean).map((it) => {
      const own = spec.QAT?.includes(it.id) && it.control.keytip == null;
      return own || n >= 9 ? it : { ...it, control: { ...it.control, keytip: String(++n) } };
    });
  }, [spec, qat.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const find = search && itemOf(spec, search);
  const root = useRef(null);
  const box = useRef(null);
  const anchor = useRef(null);
  const [reveal, setReveal] = useState(false);
  const done = () => peek && setWord({ peek: false });
  useOutside(root, peek, () => setWord({ peek: false }));
  useOutside(root, autoHide && reveal, () => setReveal(false));
  const open = !collapsed || peek;
  const { groups, measure, overflow } = useFit(open ? model : null, root, box);

  useEffect(() => {
    if (!autoHide) return undefined;
    const move = (e) => {
      const top = anchor.current?.getBoundingClientRect().top;
      if (top != null && e.clientY >= top && e.clientY <= top + 8) setReveal(true);
    };
    const key = (e) => e.key === 'Escape' && !document.querySelector('[role="menu"]') && setReveal(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('keydown', key);
    };
  }, [autoHide]);

  const clickTab = (id) => {
    pickTab(spec, id);
    if (collapsed) setWord({ peek: !(peek && id === tab) });
  };
  const bar = quick.length > 0 && (
    <div data-qat="" data-qat-below={below || undefined} className={cn('flex shrink-0 items-center gap-0.5', below && 'mx-1.5 mb-1 h-[26px] px-1')}>
      {quick.map((it) => <Control key={it.id} item={it} size="small" />)}
    </div>
  );
  const value = { spec, icons, boxes, ctx, done };
  // The groups scroll sideways in their own box only when even the collapsed groups do not fit; the display options have
  // their own column at the right, so they never cover a group.
  const body = model && open && (
    <div data-ribbon-body data-overflow={overflow || undefined}
      className={cn('relative mx-1.5 mb-1 flex h-[99px] rounded-island border bg-card shadow-xs', peek && 'absolute inset-x-0 top-full z-40 shadow-xl')}>
      <div ref={box} onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }} className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
        {groups.map((g) => <Group key={g.id} g={g} />)}
      </div>
      {peek ? (
        <Tip title="Keep the ribbon open (Ctrl+F1)" side="bottom" wrap="shrink-0 items-end p-1">
          <button type="button" aria-label="Pin the ribbon" data-feature="frame.tabRow.collapse" tabIndex={-1} onMouseDown={keepFocus}
            onClick={toggleRibbon} className="grid size-5 place-items-center rounded-sm hover:bg-accent/60"><Pin className="size-3.5" /></button>
        </Tip>
      ) : display && <DisplayOptions item={display} />}
    </div>
  );
  const ribbon = (
    <RibbonContext.Provider value={value}>
      <div ref={root} {...CHROME} data-ribbon="" data-agent-area="toolbar" data-collapsed={collapsed || undefined} data-touch={touch || undefined}
        onMouseDown={keepBoardFocus}
        onPointerLeave={() => autoHide && !root.current?.querySelector('[data-state="open"]') && setReveal(false)}
        className={cn('relative z-20 shrink-0 bg-background text-foreground select-none', autoHide && 'absolute inset-x-0 top-0 z-40 shadow-xl')}>
        <div role="tablist" aria-label="Ribbon tabs" data-titlebar={titleBar ? '' : undefined}
          className={cn('flex gap-0.5 px-1.5 text-[13px]', titleBar ? 'titlebar items-center' : 'h-[30px] items-end')}>
          {/* The lead's slot ends where File starts at 45 px, the body's left edge beside the minimized sidebar's 40 px rail (the
              user, 2026-10-28), open or minimized alike */}
          {lead && <span className="flex w-[32.75px] shrink-0">{lead}</span>}
          <button type="button" data-tab={spec.FILE.id} data-keytip={spec.FILE.keytip} tabIndex={-1} onMouseDown={keepFocus} onClick={onFile}
            className="h-[26px] rounded-md px-2.5 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50">{spec.FILE.label}</button>
          {tabs.map((t) => (
            // The label's semibold width is held by an empty-looking copy under it (::after, data-label), so the open tab's heavier
            // name never pushes the tabs after it.
            <button key={t.id} type="button" role="tab" data-tab={t.id} data-keytip={t.keytip} data-label={t.label} aria-selected={t.id === tab && open}
              tabIndex={t.id === tab ? 0 : -1} onMouseDown={keepFocus} onClick={() => clickTab(t.id)} onDoubleClick={toggleRibbon}
              className={cn('relative h-[26px] rounded-md px-2.5 whitespace-nowrap outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50',
                'after:invisible after:block after:h-0 after:overflow-hidden after:font-semibold after:content-[attr(data-label)]',
                t.context && 'text-[var(--ui-accent)]', t.id === tab && 'font-semibold')}>
              {t.label}
              {t.id === tab && <span className="absolute inset-x-2.5 bottom-0 h-[3px] rounded-full bg-[var(--ui-accent)]" />}
            </button>
          ))}
          {/* Short of room, the search box gives up its width (down to its icon), and below 640 px Comments, Editing and Share
              drop their labels; the box clips what still does not fit, so nothing draws over the tabs (contextual tabs included). */}
          {/* As the title row, at least 48 px of it before the search box stay empty to drag the window by */}
          <div className={cn('@container ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 self-center overflow-hidden pr-1', titleBar ? 'pl-12' : 'pl-2')}>
            {find && <SearchBox item={find} />}
            {!below && bar}
            {right.map((it) => (
              <span key={it.id} className="inline-flex shrink-0 rounded-md border @max-[640px]:[&_[data-face-label]]:hidden"><Control item={it} size="medium" /></span>
            ))}
          </div>
        </div>
        {body}
        {below && bar}
        {measure}
      </div>
    </RibbonContext.Provider>
  );
  if (!autoHide) return ribbon;
  return <div ref={anchor} className="relative h-0 shrink-0">{reveal && ribbon}</div>;
}

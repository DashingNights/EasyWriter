import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cn } from 'cn';
import {
  Ban, CalendarDays, ChartGantt, CircleCheck, ExternalLink, FileText, Hash, Heading, Hourglass, Info, ListChecks, ListTodo, Minus,
  MoveHorizontal, Percent, RefreshCw, Signal, SlidersHorizontal, Snowflake, SquareKanban, Tag, Trash2, Workflow, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { activeChart, freezeCtx, planSource } from '../../../plan-chart.js';
import { VIEW_TITLES } from '../plan/ChartView.jsx';
import { columnsOf, FIELDS, OPTION_DEFAULTS, ZOOMS } from '../../../plan/plan-model.mjs';
import { refocusEditor } from '../../actions.js';
import { can } from '../../gates.mjs';
import { useStore } from '../../store.js';
import { planList, usePlans } from '../../plans.js';
import { DateField } from '../DateField.jsx';
import { Tip } from '../Tip.jsx';
import { PRIORITIES } from '../plan/Card.jsx';

const keepFocus = (e) => e.preventDefault(); // buttons never take focus: the document keeps its selection
const VIEWS = [['kanban', 'Board', SquareKanban], ['backlog', 'Backlog', ListTodo], ['gantt', 'Gantt', ChartGantt]];
// Gantt toggles: key, chip text, tooltip (when it says more).
const GANTT_SHOW = [['showDeps', 'Deps', 'Dependencies'], ['showCritical', 'Critical', 'Critical path'], ['showBaseline', 'Baseline'],
  ['showToday', 'Today', 'Today line'], ['showWeekends', 'Weekends', 'Weekends (off: working days only)'], ['showTaskList', 'Task list']];
// Card fields / Backlog columns: name (tooltip) and icon.
const FIELD_INFO = {
  num: ['Number', Hash], labels: ['Labels', Tag], due: ['Due date', CalendarDays], checklist: ['Checklist', ListChecks], priority: ['Priority', Signal],
  estimate: ['Estimate', Hourglass], progress: ['Progress', Percent], draft: ['Linked draft', FileText], pushed: ['Pushed tick', CircleCheck],
  blocked: ['Blocked', Ban], deps: ['Dependencies', Workflow],
};
const stamp = (at) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(at);
const editorArea = () => document.getElementById('editor-area').getBoundingClientRect();

/** Runs `place(el)` for the bar in `ref` every frame while `key` is set (as the canvas bar): it follows its chart. */
function useFollow(ref, key, place) {
  useLayoutEffect(() => {
    if (!key) return undefined;
    let frame;
    const tick = () => {
      if (ref.current) place(ref.current);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [key]);
}

const Dot = ({ color }) => <span className="size-2 shrink-0 rounded-full border border-muted-foreground/40" style={color ? { background: color } : undefined} />;
const CHIP = "h-6 min-w-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground data-[state=on]:text-foreground [&_svg:not([class*='size-'])]:size-3.5";

/** A small toggle of the Options panel (as the board tool options); `tip`: its tooltip (and name, for an `icon` chip). */
function Chip({ tip, icon, pressed, onChange, children }) {
  const toggle = <Toggle size="sm" aria-label={tip} pressed={pressed} onPressedChange={onChange} className={cn(CHIP, icon && 'px-1')}>{children}</Toggle>;
  return tip ? <Tip title={tip}>{toggle}</Tip> : toggle;
}

/** One row of the Options panel: a short muted label (`tip`: what the row means), then its controls, wrapping. */
function Row({ label, tip, children }) {
  const name = <span className="flex h-6 items-center text-[11px] text-muted-foreground">{label}</span>;
  return (
    <>
      {tip ? <Tip title={tip}>{name}</Tip> : name}
      <div className="flex min-w-0 flex-wrap items-center gap-0.5">{children}</div>
    </>
  );
}

/** A text box that commits on Enter or blur; Escape puts the stored value back. */
function TextOption({ value, onCommit, className, ...props }) {
  const [text, setText] = useState(null); // being typed; null: show the value
  const commit = () => {
    if (text !== null && text !== value) onCommit(text);
    setText(null);
  };
  return (
    <Input {...props} className={cn('h-6 px-2 text-xs md:text-xs', className)} value={text ?? value} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape' && text !== null) {
          e.preventDefault();
          setText(null);
        }
      }} />
  );
}

/** A date box that commits when changed (picked, Enter, blur); empty: null. */
function DateOption({ value, onCommit, ...props }) {
  const commit = (v) => (v || null) !== (value ?? null) && onCommit(v || null);
  return (
    <DateField defaultValue={value ?? ''} className="h-6 w-[7.5rem] px-2 text-xs md:text-xs [color-scheme:dark]" {...props} onPick={commit} onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
}

/** Options… (Gantt plan §7.2) in the board tool options' style: rows of small toggles. Title, columns, label / priority filters,
 * filter text, done, drafts, fields (Gantt: range, zoom, week labels, what it shows), legend, footer. Every change is one undo
 * step of the document. */
function ChartOptions({ chart, ctx, error, set }) {
  const o = { ...OPTION_DEFAULTS, ...chart.options };
  const put = (patch) => set({ options: { ...chart.options, ...patch } });
  const plan = ctx?.plan;
  const shownCols = ctx ? columnsOf(ctx, { ...o, columns: null }).map((c) => c.id) : [];
  // Columns: null shows all; unticking one lists the rest; none is [] (an empty board), all of them null again.
  const toggleColumn = (v, on) => {
    const cur = o.columns ?? shownCols;
    const next = on ? [...new Set([...cur, v])] : cur.filter((x) => x !== v);
    put({ columns: next.length === 0 ? [] : shownCols.every((x) => next.includes(x)) ? null : next });
  };
  // Label and priority filters: the ticked values; none ticked is null (no filter), as the plan header's.
  const pick = (key, v, on) => {
    const next = on ? [...(o[key] ?? []), v] : (o[key] ?? []).filter((x) => x !== v);
    put({ [key]: next.length ? next : null });
  };
  const gantt = chart.view === 'gantt';
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
      {error && <p className="col-span-2 rounded-md border border-dashed border-orange-400/70 px-1.5 py-1 text-xs text-orange-300">Push refuses this chart: {error}.</p>}
      <Row label="Title">
        <Chip tip="Title bar" icon pressed={o.title !== ''} onChange={(on) => put({ title: on ? null : '' })}><Heading /></Chip>
        <TextOption aria-label="Chart title" className="min-w-0 flex-1" disabled={o.title === ''} value={o.title ?? ''} placeholder={VIEW_TITLES[chart.view]}
          onCommit={(t) => put({ title: t.trim() || null })} />
      </Row>
      {plan && chart.view === 'kanban' && (
        <Row label="Columns" tip="Columns shown">
          {/* "No status" only while it has cards or is listed: an empty one cannot be ticked on */}
          {[...plan.columns, ...(shownCols.includes(null) || o.columns?.includes(null) ? [{ id: null, name: 'No status', color: null }] : [])].map((c) => (
            <Chip key={c.id ?? ''} pressed={o.columns ? o.columns.includes(c.id) : c.id !== null || shownCols.includes(null)} onChange={(on) => toggleColumn(c.id, on)}>
              <Dot color={c.color} /><span className="max-w-28 truncate">{c.name}</span>
            </Chip>
          ))}
        </Row>
      )}
      {plan?.labels.length > 0 && (
        <Row label="Labels" tip="Only tickets with a ticked label (none ticked: all)">
          {plan.labels.map((l) => (
            <Chip key={l.id} pressed={!!o.labels?.includes(l.id)} onChange={(on) => pick('labels', l.id, on)}>
              <Dot color={l.color} /><span className="max-w-28 truncate">{l.name}</span>
            </Chip>
          ))}
        </Row>
      )}
      <Row label="Priority" tip="Only tickets with a ticked priority (none ticked: all)">
        {PRIORITIES.map(([v, name, Icon]) => (
          <Chip key={v} tip={name} icon pressed={!!o.priority?.includes(v)} onChange={(on) => pick('priority', v, on)}>{Icon ? <Icon /> : <Minus />}</Chip>
        ))}
      </Row>
      <Row label="Tickets">
        <TextOption aria-label="Filter text" placeholder="Filter text (title, #num)" className="w-full" value={o.search} onCommit={(t) => put({ search: t.slice(0, 100) })} />
        <Chip pressed={o.hideDone} onChange={(on) => put({ hideDone: on })}>Hide done</Chip>
        {!gantt && <Chip tip="Draft cards (the thread's drafts that no ticket links)" pressed={o.showDrafts} onChange={(on) => put({ showDrafts: on })}>Drafts</Chip>}
        {!gantt && <Chip pressed={o.unpushedOnly} onChange={(on) => put({ unpushedOnly: on })}>Unpushed only</Chip>}
        <label className="flex h-6 items-center gap-1 px-1 text-xs text-muted-foreground">
          Done within
          <TextOption type="number" min={1} aria-label="Done within days" className="w-12 px-1.5" value={o.doneWithinDays == null ? '' : String(o.doneWithinDays)}
            onCommit={(t) => put({ doneWithinDays: Number.isInteger(+t) && +t >= 1 ? +t : null })} />
          days
        </label>
      </Row>
      {gantt ? (
        <>
          {/* range: {start, end}, either may be null (that end follows the plan) */}
          <Row label="Range" tip="The dates shown (an empty end follows the plan)">
            <DateOption aria-label="Range start" calendar={plan?.calendar} value={o.range?.start ?? null} onCommit={(start) => put({ range: start || o.range?.end ? { start, end: o.range?.end ?? null } : null })} />
            <DateOption aria-label="Range end" calendar={plan?.calendar} value={o.range?.end ?? null} onCommit={(end) => put({ range: end || o.range?.start ? { start: o.range?.start ?? null, end } : null })} />
            <Tip title="Whole plan (clear the range)">
              <Button variant="ghost" size="icon-xs" aria-label="Whole plan" className="text-muted-foreground" disabled={!o.range} onClick={() => put({ range: null })}><X /></Button>
            </Tip>
          </Row>
          <Row label="Zoom">
            <Select value={o.zoom} onValueChange={(zoom) => put({ zoom })}>
              <SelectTrigger size="sm" aria-label="Zoom" className="h-6! w-24 px-2 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent onCloseAutoFocus={refocusEditor}>
                {ZOOMS.map((z) => <SelectItem key={z} value={z} className="text-xs">{z[0].toUpperCase() + z.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Chip tip={`Week numbers${plan && !plan.calendar.weekOne ? ' (set week 1 in the plan\'s Calendar... first)' : ''}`} pressed={o.weekLabels === 'number'}
              onChange={(on) => put({ weekLabels: on ? 'number' : 'date' })}>Week no.</Chip>
            <Tip title="On push: at most 60 rows; a zoom too wide for the post falls back to a smaller one (the footer says so).">
              <Info aria-label="On push" className="mx-1 size-3.5 text-muted-foreground" />
            </Tip>
          </Row>
          <Row label="Show">
            {GANTT_SHOW.map(([k, name, tip]) => <Chip key={k} tip={tip} pressed={o[k]} onChange={(on) => put({ [k]: on })}>{name}</Chip>)}
          </Row>
        </>
      ) : (
        <Row label={chart.view === 'backlog' ? 'Columns' : 'Fields'} tip={chart.view === 'backlog' ? 'Backlog columns shown' : 'Card fields shown'}>
          {FIELDS.map((f) => {
            const [name, Icon] = FIELD_INFO[f];
            return (
              <Chip key={f} tip={name} icon pressed={o.fields.includes(f)} onChange={(on) => put({ fields: on ? [...o.fields, f] : o.fields.filter((x) => x !== f) })}><Icon /></Chip>
            );
          })}
        </Row>
      )}
      <Row label="Chart">
        <Chip tip="Label legend" pressed={o.legend} onChange={(on) => put({ legend: on })}>Legend</Chip>
        <Chip tip="Footer (counts, date)" pressed={o.footer} onChange={(on) => put({ footer: on })}>Footer</Chip>
      </Row>
    </div>
  );
}

/** Freeze / Refresh: chart NodeView `view` shows the plan as it is now (also the §7c tool search's Freeze, Refresh). */
export const freezeChart = (view) => view.set({ frozen: { at: Date.now(), ctx: freezeCtx(planSource.context(view.chart.planId), view.chart.view) } });

/** §6e plan chart bar above (else below) the node-selected plan chart (hovering never shows it), right-aligned (one instance in App):
 * view, Options…, plan, Live / Frozen (+ Refresh), size, Full width, Open plan, Delete. */
export function PlanChartBar() {
  usePlans();
  const snap = useSyncExternalStore(activeChart.subscribe, activeChart.get);
  const view = snap?.view;
  const ref = useRef(null);
  // Only over the editor: the chart stays selected while another page (e.g. the plan it opened) is shown.
  const editorShown = useStore((s) => can('view.editor', { view: s.view }));

  // Outside the chart, never over its content: above its top edge, right-aligned, 8 px clear; below its bottom edge when the
  // editor viewport has no room above; at the viewport's top only when neither fits (a chart taller than the viewport).
  useFollow(ref, view, (el) => {
    const r = view.dom.getBoundingClientRect();
    const a = editorArea();
    el.style.maxWidth = `${Math.max(0, a.width - 16)}px`; // a narrow viewport wraps the bar instead of cutting it off
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    const x = Math.max(a.left + 8, Math.min(r.right - w, a.right - 8 - w));
    const y = r.top - 8 - h >= a.top + 8 ? r.top - 8 - h : r.bottom + 8 + h <= a.bottom - 8 ? r.bottom + 8 : a.top + 8;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.visibility = r.bottom > a.top + 8 && r.top < a.bottom - 8 ? '' : 'hidden';
  });

  if (!snap || !editorShown) return null;
  const { chart } = view;
  const ctx = planSource.context(chart.planId); // the live plan (Freeze, Refresh, Options lists)
  const set = (patch) => view.set(patch);
  const freeze = () => freezeChart(view);
  const plans = planList();
  const tip = (title, button) => <Tip title={title}>{button}</Tip>;
  return (
    <div ref={ref} role="toolbar" aria-label="Plan chart" onMouseDown={keepFocus}
      className="fixed top-0 left-0 z-30 flex flex-wrap items-center gap-0.5 rounded-island border bg-card p-0.5 text-xs shadow-lg">
      <ToggleGroup type="single" size="sm" aria-label="Chart view" value={chart.view} onValueChange={(v) => v && set({ view: v })}>
        {VIEWS.map(([v, name, Icon]) => (
          <ToggleGroupItem key={v} value={v} aria-label={name} className="h-6 gap-1 px-1.5 text-xs" onMouseDown={keepFocus}><Icon />{name}</ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="xs" onMouseDown={keepFocus}><SlidersHorizontal />Options...</Button>
        </PopoverTrigger>
        {/* mousedown stops here: React bubbles it out of the portal to the bar's keepFocus, which would block focusing its inputs */}
        {/* On open the panel itself takes the focus, not its first control (no focus ring, no tooltip): keys no longer reach the
            document (typing over the selected chart), Tab goes into the panel, Escape closes it */}
        <PopoverContent align="end" className="w-[24rem] rounded-(--radius-island) bg-card/70 p-1.5 text-xs shadow-xl backdrop-blur-[2px]"
          onOpenAutoFocus={(e) => { e.preventDefault(); e.target.focus(); }} onCloseAutoFocus={refocusEditor} onMouseDown={(e) => e.stopPropagation()}>
          <ChartOptions chart={chart} ctx={chart.frozen?.ctx ?? ctx} error={snap.error} set={set} />
        </PopoverContent>
      </Popover>
      <Select value={plans.some((p) => p.id === chart.planId) ? chart.planId : ''} onValueChange={(planId) => set({ planId, frozen: null })}>
        <SelectTrigger size="sm" aria-label="Plan" className="h-6! max-w-44 gap-1 px-1.5 text-xs" onMouseDown={keepFocus}>
          <SelectValue placeholder="Plan not found" />
        </SelectTrigger>
        <SelectContent onCloseAutoFocus={refocusEditor}>
          {plans.map((p) => <SelectItem key={p.id} value={p.id} className="text-xs">{p.title || p.threadUrl}</SelectItem>)}
        </SelectContent>
      </Select>
      {tip(chart.frozen ? 'Frozen: shows the plan as it was. Click to show it live' : 'Live: follows the plan. Click to freeze this moment',
        <Toggle size="sm" aria-label="Frozen" className="h-6 min-w-6 gap-1 px-1.5 text-xs" pressed={!!chart.frozen} disabled={!chart.frozen && !ctx}
          onMouseDown={keepFocus} onPressedChange={(on) => (on ? freeze() : set({ frozen: null }))}>
          <Snowflake />{chart.frozen ? 'Frozen' : 'Live'}
        </Toggle>)}
      {chart.frozen && (
        <>
          <span className="px-1 text-muted-foreground">{stamp(chart.frozen.at)}</span>
          {tip('Freeze it again with the plan as it is now', <Button variant="ghost" size="icon-xs" aria-label="Refresh" disabled={!ctx} onClick={freeze}><RefreshCw /></Button>)}
        </>
      )}
      <span className="px-1.5 text-muted-foreground tabular-nums">{`${snap.w} x ${snap.h}`}</span>
      {tip('Page width', <Button variant="ghost" size="xs" disabled={chart.dw == null} onClick={() => set({ dw: null })}><MoveHorizontal />Full width</Button>)}
      {tip('Open the plan at this view (double-click, Enter)', <Button variant="ghost" size="xs" disabled={!ctx} onClick={() => view.openPlan()}><ExternalLink />Open plan</Button>)}
      {tip('Delete chart', <Button variant="ghost" size="icon-xs" aria-label="Delete chart" onClick={() => view.remove()}><Trash2 /></Button>)}
    </div>
  );
}

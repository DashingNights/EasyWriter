import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { Diamond, Eye, Milestone, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { fmt, fromDay, fromWork, nextWorkday, prevWorkday, toDay, work } from '../../../plan/dates.mjs';
import { ganttLayout, hitTest, ZOOM_PX } from '../../../plan/gantt-layout.mjs';
import { addDep, filterTickets, statusOf } from '../../../plan/plan-model.mjs';
import { schedule } from '../../../plan/schedule.mjs';
import { dismissOnly, edgeSpeed } from '../../../whiteboard.js';
import { refocusEditor } from '../../actions.js';
import { deleteTickets, dispatch, dispatchAll, editTicket, moveCards, newTicket } from '../../plans.js';
import { keyIs, withKey } from '../../keybinds.js';
import { getState, setState, useStore } from '../../store.js';
import { backgroundClick } from '../../viewport.js';
import { Tip } from '../Tip.jsx';
import { keepFocus } from '../Toolbar.jsx';
import { openDraftFromPlan, PRIORITIES } from './Card.jsx';
import { GanttDeps, GanttGrid, GanttRows, GanttTicks } from './ChartView.jsx';

// The Gantt tab (Gantt plan §6.5, §6.7): a resizable task list beside the chart drawn from ganttLayout (the drawing is the
// plan chart's, ChartView.jsx, in the app palette). Gestures (bar move / resize / progress, dependency drawing from the
// ports, Alt-drag lag, a span drawn in an unscheduled ticket's lane) change only a preview while the pointer is down and send
// one command (one undo entry) on release; a click in an unscheduled lane gives the ticket that day.
// View options (zoom, what is shown) live in planUi.options with the header's filters, so saved views and Insert into
// draft take them; the task-list width is per viewer (localStorage `daf-writer.plan.<planId>`).

const APP = { accent: '#3d99f5', critical: '#e05252', conflict: '#e09952', done: '#62d926', text: '#d4d4d4', strong: '#f5f5f5', muted: '#a1a1a1', border: '#525252' };
const ZOOMS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['fit', 'Fit']];
const STEPS = ['day', 'week', 'month', 'quarter']; // Ctrl + wheel and + / − step through them
const SHOW = [['showDeps', 'Dependencies'], ['showCritical', 'Critical path'], ['showBaseline', 'Baseline'], ['showToday', 'Today line'],
  ['showWeekends', 'Weekends (off: working days only)'], ['showTaskList', 'Task list']];
const CURSOR = { lane: 'cell', bar: 'grab', 'edge-l': 'ew-resize', 'edge-r': 'ew-resize', progress: 'ew-resize', 'port-s': 'crosshair', 'port-e': 'crosshair', dep: 'pointer' };
const LIST_MIN = 160;
const NO_STATUS = '-'; // radio value of "No status"
const ROW = { height: 28 }; // gantt-layout's row (rem sizes follow the 13 px root)

const root = () => document.getElementById('workspace-root');
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable;
const ui = (patch) => setState({ planUi: { ...getState().planUi, ...patch } });
const setOptions = (patch) => {
  const s = getState().planUi;
  setState({ planUi: { ...s, options: { ...s.options, ...patch } } });
};
const day = (d) => fmt(d, 'd MMM');
// Per-viewer conveniences (§3.4): read, or merge `patch` in.
function local(planId, patch) {
  const key = `daf-writer.plan.${planId}`;
  try {
    const v = JSON.parse(localStorage.getItem(key)) ?? {};
    if (patch) localStorage.setItem(key, JSON.stringify({ ...v, ...patch }));
    return v;
  } catch {
    return {};
  }
}
// Window pointer tracking from a pointer-down: onMove(ev) after 3 px, onUp(ev) when it moved, else onClick(ev); `end()` always.
function track(e, { onMove, onUp, onClick, end }) {
  const [x0, y0] = [e.clientX, e.clientY];
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) <= 3) return;
    moved = true;
    onMove(ev);
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    end?.();
    if (moved) onUp(ev);
    else onClick?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** The ticket dialog of the successor, scrolled to its dependencies (double-click on a dependency line). */
function editAtDeps(planId, id) {
  editTicket(planId, id);
  setTimeout(() => [...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent.startsWith('Dependencies'))?.scrollIntoView({ block: 'center' }), 80);
}

/** Right-click menu of a bar or task row (the Board card menu's entries plus Add subtask and Remove dates), acting on `ids`. */
function GanttMenu({ menu, ctx, sched, onClose }) {
  const { plan } = ctx;
  const planId = plan.id;
  const t = plan.tickets.find((x) => x.id === menu.id);
  if (!t) return null;
  const { ids } = menu;
  const update = (patch) => dispatch('plan.tickets.update', { planId, ticketIds: ids, patch });
  const n = sched.byId[t.id];
  const Dot = ({ color }) => <span className={cn('size-2 shrink-0 rounded-full', !color && 'border border-muted-foreground/60')} style={color ? { background: color } : undefined} />;
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild><span className="pointer-events-none fixed size-0" style={{ left: menu.x, top: menu.y }} /></DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>
        <DropdownMenuItem onSelect={() => editTicket(planId, t.id)}>Open...</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => newTicket(planId, { parent: t.id }, { from: n.scheduled ? fromDay(fromWork(n.s, plan.calendar)) : ctx.today })}>Add subtask...</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={statusOf(t, ctx) ?? NO_STATUS} onValueChange={(v) => moveCards(planId, ids, v === NO_STATUS ? null : v)}>
              {plan.columns.map((c) => <DropdownMenuRadioItem key={c.id} value={c.id}><Dot color={c.color} />{c.name}</DropdownMenuRadioItem>)}
              <DropdownMenuRadioItem value={NO_STATUS}><Dot />No status</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={String(t.priority)} onValueChange={(v) => update({ priority: +v })}>
              {PRIORITIES.map(([v, label, Icon]) => <DropdownMenuRadioItem key={v} value={String(v)}>{Icon ? <Icon /> : <span className="size-4" />}{label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {plan.labels.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Labels</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {plan.labels.map((l) => {
                const on = t.labels.includes(l.id);
                return (
                  <DropdownMenuCheckboxItem key={l.id} checked={on} onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() => dispatch(on ? 'plan.tickets.labels.remove' : 'plan.tickets.labels.add', { planId, ticketIds: ids, labelId: l.id })}>
                    <Dot color={l.color} />{l.name}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuCheckboxItem checked={t.milestone} onCheckedChange={(v) => update({ milestone: v })}><Milestone />Milestone</DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled={!t.start} onSelect={() => update({ start: null, end: null })}>Remove dates</DropdownMenuItem>
        <DropdownMenuSeparator />
        {t.draftId
          ? <DropdownMenuItem onSelect={() => openDraftFromPlan(t.draftId)}>Open draft</DropdownMenuItem>
          : <DropdownMenuItem onSelect={() => editTicket(planId, t.id)}>Link draft...</DropdownMenuItem>}
        <DropdownMenuItem variant="destructive" onSelect={() => deleteTickets(planId, ids)}>Delete{ids.length > 1 ? ` ${ids.length} tickets` : ''}...</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Gantt tab: toolbar (zoom, Today, Show), the task list and the chart (every matching ticket a row, dated or not). */
export function Gantt({ ctx, options }) {
  const { plan } = ctx;
  const planId = plan.id;
  const cal = plan.calendar;
  const { selection, focusId } = useStore((s) => s.planUi);
  const [listW, setListW] = useState(() => Math.max(LIST_MIN, local(planId).ganttListW ?? 300));
  const [paneW, setPaneW] = useState(800);
  const [preview, setPreview] = useState(null); // {dates: {id: {start, end}}, progress: {id, value}, ghost: {points, bad}, label: {x, y, text}}
  const [hover, setHover] = useState(null); // hitTest result under the pointer
  const [dep, setDep] = useState(null); // the selected dependency {from, to}
  const [menu, setMenu] = useState(null); // {x, y, id, ids}
  const pane = useRef(null);
  const body = useRef(null);
  const busy = useRef(false); // a gesture is running
  const anchor = useRef(null); // a zoom step keeps this {u: axis unit, at: px} under the pointer
  const [reach, setReach] = useState({}); // {from, to}: days the axis grew to past the tickets (scrolled or dragged to an edge)
  const hold = useRef(null); // the axis start a gesture began with
  const grown = useRef(false); // the axis was told to grow to the left (once per render)
  const pin = useRef({}); // the axis while the tab stays open {key, from, to, room, px}: it only grows (zoom, Weekends, a range reset it)
  const drawn = useRef(null); // the last drawn axis {start, px, key}

  const ticketOf = (id) => plan.tickets.find((t) => t.id === id);
  const hasKids = (id) => plan.tickets.some((t) => t.parent === id);
  const showList = options.showTaskList;
  const showUnscheduled = options.showUnscheduled ?? true;
  const listOff = showList ? listW : 0;
  const base = schedule(ctx);
  const shown = preview?.dates || preview?.progress ? {
    ...plan,
    tickets: plan.tickets.map((t) => {
      const d = preview.dates?.[t.id];
      const p = preview.progress?.id === t.id ? preview.progress.value : null;
      return d || p !== null ? { ...t, ...d, ...(p !== null && { progress: p }) } : t;
    }),
  } : plan;
  const vctx = shown === plan ? ctx : { ...ctx, plan: shown };
  const sched = shown === plan ? base : schedule(vctx);
  // The axis fills the chart's width past the tickets (gantt-layout `fill`). While the tab stays open it keeps its start and
  // end as limits and Fit's scale (until the chart's width changes), so a released drag never makes it jump; a gesture also
  // keeps its start as it is (the gesture's coordinates assume it).
  const key = `${options.zoom} ${options.showWeekends} ${options.range?.start} ${options.range?.end}`;
  const P = pin.current.key === key ? pin.current : (pin.current = { key });
  const room = Math.max(200, paneW - listOff);
  const h = preview && hold.current;
  const L = ganttLayout(vctx, sched, { ...options, showTaskList: false, ...(h && { range: { start: fromDay(h), end: options.range?.end ?? null } }) }, room, {
    fill: { from: Math.min(reach.from ?? Infinity, P.from ?? Infinity), to: Math.max(reach.to ?? -Infinity, P.to ?? -Infinity), px: P.room === room ? P.px : undefined },
    unscheduled: showUnscheduled,
  });
  Object.assign(P, { from: L.start, to: L.end, room, px: L.pxPerDay });
  const lay = useRef(L);
  lay.current = L;
  const rowIds = L.rows.map((r) => r.id);
  const px = L.pxPerDay;
  const wd = (d) => work(d, cal);
  const unit = (d) => (options.showWeekends ? d : wd(d)); // the axis counts calendar days, or working days while weekends are hidden
  // `d` moved by `du` axis days, landing on a working day (`back`: the one before).
  const shiftDay = (d, du, back) => (options.showWeekends ? (back ? prevWorkday : nextWorkday)(d + du, cal) : fromWork(wd(d) + du, cal));
  const dayAt = (x) => {
    const u = Math.floor((x - L.left) / px);
    return options.showWeekends ? L.start + u : fromWork(wd(L.start) + u, cal);
  };
  const todayX = (() => {
    const x = L.left + (unit(toDay(ctx.today)) - unit(L.start) + 0.5) * px;
    return x >= L.left && x <= L.width ? x : null;
  })();

  useLayoutEffect(() => {
    const el = pane.current;
    const ro = new ResizeObserver(() => setPaneW(el.clientWidth));
    ro.observe(el);
    setPaneW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // After a zoom step: the day that was under the pointer is under it again.
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    pane.current.scrollLeft = (a.u - unit(L.start)) * px + L.left + listOff - a.at;
  }, [px]);
  // After the axis grew to the left (scrolled to its start, a bar released before it): the days on screen stay in place.
  useLayoutEffect(() => {
    const d = drawn.current;
    drawn.current = { start: L.start, px, key };
    grown.current = false;
    if (d?.key === key && d.px === px && L.start < d.start) pane.current.scrollLeft += (unit(d.start) - unit(L.start)) * px;
  });
  // The axis grows by half a screen past its end (dir 1) or its start (-1, not during a gesture: it keeps the start) when
  // scrolled or dragged to within 100 px of that edge.
  const edge = (dir) => {
    const el = pane.current;
    const C = lay.current;
    const n = Math.ceil((el.clientWidth - listOff) / 2 / C.pxPerDay);
    const step = (d, k) => (options.showWeekends ? d + k : fromWork(wd(d) + k, cal));
    if (dir > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 100) {
      const to = step(C.end, n);
      setReach((r) => (r.to >= to ? r : { ...r, to }));
    } else if (dir < 0 && el.scrollLeft <= 100 && !busy.current && !grown.current) {
      grown.current = true;
      setReach((r) => ({ ...r, from: step(C.start, -n) }));
    }
  };
  const scrolled = useRef(0); // the last scrollLeft: only sideways scrolling grows the axis
  const onScroll = (e) => {
    const x = e.currentTarget.scrollLeft;
    edge(Math.sign(x - scrolled.current));
    scrolled.current = x;
  };

  const scrollToday = () => {
    if (todayX === null) toast('Today is outside the chart\'s range.');
    else pane.current.scrollLeft = todayX - (paneW - listOff) / 3;
  };
  // One zoom step in (-1, towards Day) or out (1) around the client x `at` (default: the middle of the chart).
  const zoomBy = (dir, clientX) => {
    const next = options.zoom === 'fit'
      ? (dir < 0 ? STEPS.findLast((z) => ZOOM_PX[z] > px + 0.01) : STEPS.find((z) => ZOOM_PX[z] < px - 0.01))
      : STEPS[STEPS.indexOf(options.zoom) + dir];
    if (!next || next === options.zoom) return;
    const r = pane.current.getBoundingClientRect();
    const at = (clientX ?? r.left + listOff + (r.width - listOff) / 2) - r.left;
    anchor.current = { u: unit(L.start) + (pane.current.scrollLeft + at - listOff - L.left) / px, at };
    setOptions({ zoom: next });
  };
  const wheel = useRef(null);
  wheel.current = (e) => (e.ctrlKey || e.metaKey ? zoomBy(e.deltaY < 0 ? -1 : 1, e.clientX) : edge(Math.sign(e.deltaX || (e.shiftKey ? e.deltaY : 0))));
  useEffect(() => {
    const el = pane.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault(); // Shift + wheel scrolls time natively (at an edge it grows the axis)
      wheel.current(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- selection and commands ---

  const select = (e, id) => {
    setDep(null); // a selected ticket, not a dependency, is what Del removes next
    const cur = getState().planUi;
    if (e.ctrlKey || e.metaKey) ui({ selection: cur.selection.includes(id) ? cur.selection.filter((x) => x !== id) : [...cur.selection, id], focusId: id });
    else if (e.shiftKey && rowIds.includes(cur.focusId)) {
      const [a, b] = [rowIds.indexOf(cur.focusId), rowIds.indexOf(id)].sort((x, y) => x - y);
      ui({ selection: rowIds.slice(a, b + 1) });
    } else if (!cur.selection.includes(id) || cur.focusId !== id) ui({ selection: [id], focusId: id });
  };
  const update = (id, patch) => dispatch('plan.tickets.update', { planId, ticketIds: [id], patch });
  const dates = (s, e) => ({ start: fromDay(s), end: fromDay(e) });
  // A bar one working day earlier / later (`by`), or only its end / start (keys).
  const nudge = (id, by, mode) => {
    const t = ticketOf(id);
    if (!t?.start || hasKids(id)) return;
    const [s, e] = [wd(toDay(t.start)), wd(toDay(t.end))];
    const [s2, e2] = t.milestone || mode === 'move' ? [s + by, e + by] : mode === 'end' ? [s, Math.max(s, e + by)] : [Math.min(e, s + by), e];
    if (s2 !== s || e2 !== e) update(id, dates(fromWork(s2, cal), fromWork(e2, cal)));
  };
  const successors = (id) => {
    const out = new Set();
    const walk = (x) => plan.tickets.forEach((u) => {
      if (!out.has(u.id) && u.deps.some((d) => d.on === x)) {
        out.add(u.id);
        walk(u.id);
      }
    });
    walk(id);
    return [...out].map(ticketOf).filter((u) => u.start && !hasKids(u.id));
  };

  // --- gestures on the chart (layout coordinates: the body svg starts at y = headerH) ---

  const at = (e) => {
    const r = body.current.getBoundingClientRect();
    const s = r.width / lay.current.width || 1;
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s + lay.current.headerH];
  };
  const run = (e, { onMove, onUp, onClick }) => {
    busy.current = true;
    hold.current = L.start;
    let last = null;
    let frame = 0;
    const tick = () => { // near the chart's left or right edge it scrolls (as the Board does) and grows past its end
      const r = pane.current.getBoundingClientRect();
      const by = edgeSpeed(r.right - last.clientX) - edgeSpeed(last.clientX - r.left - listOff);
      if (by) {
        pane.current.scrollLeft += by;
        edge(Math.sign(by));
        onMove(last);
      }
      frame = requestAnimationFrame(tick);
    };
    track(e, {
      onMove: (ev) => {
        if (!last) frame = requestAnimationFrame(tick);
        last = ev;
        onMove(ev);
      },
      onUp,
      onClick,
      end: () => {
        cancelAnimationFrame(frame);
        busy.current = false;
        hold.current = null;
        setPreview(null);
      },
    });
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || dismissOnly(e)) return;
    const [x, y] = at(e);
    const hit = hitTest(L, x, y);
    if (!hit) {
      setDep(null);
      ui({ selection: [] });
      return;
    }
    if (hit.kind === 'dep') {
      const d0 = ticketOf(hit.id).deps.find((d) => d.on === hit.from);
      setDep({ from: hit.from, to: hit.id });
      if (!e.altKey || !d0) return;
      let lag = d0.lag;
      run(e, { // Alt-drag: the lag in whole working days, one plan.deps.update
        onMove: (ev) => {
          const [mx, my] = at(ev);
          lag = d0.lag + Math.round((mx - x) / px);
          setPreview({ label: { x: mx + 10, y: my - 8, text: `Lag ${lag > 0 ? '+' : ''}${lag} d` } });
        },
        onUp: () => lag !== d0.lag && dispatch('plan.deps.update', { planId, from: hit.from, to: hit.id, patch: { lag } }),
      });
      return;
    }
    select(e, hit.id);
    if (hit.kind === 'lane') { // schedule in place: a click gives it that working day, a drag draws its span
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (hasKids(hit.id)) return void toast('Schedule its subtasks: a parent\'s dates come from them.');
      const d0 = nextWorkday(dayAt(x), cal);
      let span = [d0, d0];
      run(e, {
        onMove: (ev) => {
          const d1 = dayAt(at(ev)[0]);
          span = d1 < d0 ? [nextWorkday(d1, cal), d0] : [d0, Math.max(d0, prevWorkday(d1, cal))];
          setPreview({ dates: { [hit.id]: dates(...span) } });
        },
        onUp: () => update(hit.id, dates(...span)),
        onClick: () => update(hit.id, dates(d0, d0)),
      });
      return;
    }
    const row = L.rows.find((r) => r.id === hit.id);
    const t = ticketOf(hit.id);
    if (row.kind === 'summary' || e.ctrlKey || e.metaKey) return;
    const [s, en] = [toDay(t.start), toDay(t.end)];
    const du = (ev) => Math.round((at(ev)[0] - x) / px);

    if (hit.kind === 'port-s' || hit.kind === 'port-e') { // a dependency from this bar to the one it is dropped on
      const fromEnd = hit.kind === 'port-e';
      const sx = row.kind === 'milestone' ? row.bar.x + (fromEnd ? 7 : -7) : row.bar.x + (fromEnd ? row.bar.w : 0);
      const sy = row.y + L.rowH / 2;
      let drop = null;
      run(e, {
        onMove: (ev) => {
          const [mx, my] = at(ev);
          const target = lay.current.rows.find((r) => my >= r.y && my < r.y + L.rowH);
          drop = target?.bar && { to: target.id, type: (fromEnd ? 'F' : 'S') + (mx > target.bar.x + target.bar.w / 2 ? 'F' : 'S') };
          if (drop) drop.bad = addDep(ctx, t.id, drop.to, drop.type).error?.message ?? null;
          const bx = sx + (fromEnd ? 12 : -12);
          setPreview({ ghost: { points: [[sx, sy], [bx, sy], [bx, my], [mx, my]], bad: !!drop?.bad } });
        },
        onUp: () => {
          if (!drop) return;
          if (drop.bad) toast.error(drop.bad);
          else dispatch('plan.deps.add', { planId, from: t.id, to: drop.to, type: drop.type });
        },
      });
      return;
    }
    if (hit.kind === 'progress') {
      let value = t.progress;
      run(e, {
        onMove: (ev) => {
          value = Math.max(0, Math.min(100, Math.round(((at(ev)[0] - row.bar.x) / Math.max(1, row.bar.w)) * 20) * 5));
          setPreview({ progress: { id: t.id, value } });
        },
        onUp: () => value !== t.progress && update(t.id, { progress: value }),
      });
      return;
    }
    // Move (Shift: every successor by the same working days) or resize, in whole working days.
    const d = base.byId[t.id].d;
    let next = null;
    run(e, {
      onMove: (ev) => {
        const n = du(ev);
        if (hit.kind === 'edge-l') next = { [t.id]: dates(Math.min(shiftDay(s, n), en), en) };
        else if (hit.kind === 'edge-r') next = { [t.id]: dates(s, Math.max(shiftDay(en, n, true), s)) };
        else {
          const s2 = shiftDay(s, n);
          const by = wd(s2) - wd(s);
          next = { [t.id]: dates(s2, d ? fromWork(wd(s2) + d - 1, cal) : s2) };
          if (ev.shiftKey) for (const u of successors(t.id)) next[u.id] = dates(fromWork(wd(toDay(u.start)) + by, cal), fromWork(wd(toDay(u.end)) + by, cal));
        }
        setPreview({ dates: next });
      },
      onUp: () => {
        const changed = Object.entries(next ?? {}).filter(([id, v]) => ticketOf(id).start !== v.start || ticketOf(id).end !== v.end);
        if (changed.length === 1) update(changed[0][0], changed[0][1]);
        else if (changed.length) dispatchAll(planId, changed.map(([id, patch]) => ['plan.tickets.update', { ticketIds: [id], patch }]));
      },
    });
  };

  const onPointerMove = (e) => {
    if (busy.current) return;
    const [x, y] = at(e);
    const h = hitTest(L, x, y);
    if (h?.kind === 'lane') h.day = nextWorkday(dayAt(x), cal); // the ghost bar's day
    if (h?.kind !== hover?.kind || h?.id !== hover?.id || h?.from !== hover?.from || h?.day !== hover?.day) setHover(h);
  };
  const onDoubleClick = (e) => {
    const [x, y] = at(e);
    const hit = hitTest(L, x, y);
    if (hit?.kind === 'dep') editAtDeps(planId, hit.id);
    else if (hit) editTicket(planId, hit.id);
  };
  const openMenu = (e, id) => {
    e.preventDefault();
    const cur = getState().planUi.selection;
    const ids = cur.includes(id) ? rowIds.filter((x) => cur.includes(x)) : [id];
    if (!cur.includes(id)) ui({ selection: [id], focusId: id });
    setMenu({ x: e.clientX, y: e.clientY, id, ids });
  };
  const onContextMenu = (e) => {
    const [x, y] = at(e);
    const hit = hitTest(L, x, y);
    if (hit && hit.kind !== 'dep') openMenu(e, hit.id);
    else e.preventDefault();
  };

  const resizeList = (e) => {
    e.preventDefault();
    const [x0, w0] = [e.clientX, listW];
    let w = w0;
    const move = (ev) => setListW((w = Math.min(600, Math.max(LIST_MIN, w0 + ev.clientX - x0))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      local(planId, { ganttListW: w });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Gantt keys (§6.7) on #workspace-root; typing in an input, a menu or a dialog is not here.
  const keys = useRef(null);
  keys.current = (e) => {
    if (e.defaultPrevented || typing(e) || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const go = (fn) => {
      e.preventDefault();
      fn();
    };
    const focus = rowIds.includes(focusId) ? focusId : null;
    const sel = selection.length ? rowIds.filter((id) => selection.includes(id)) : focus ? [focus] : [];
    if (e.key === 'Escape' && (dep || selection.length)) go(() => { setDep(null); ui({ selection: [] }); });
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (focus) go(() => nudge(focus, e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey ? 'end' : ctrl ? 'start' : 'move'));
    } else if (ctrl && e.key.toLowerCase() === 'a') go(() => ui({ selection: rowIds }));
    else if (ctrl) return;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && dep) go(() => { dispatch('plan.deps.remove', { planId, ...dep }); setDep(null); });
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) go(() => deleteTickets(planId, sel));
    else if (e.key === 'Enter' && focus) go(() => editTicket(planId, focus));
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      go(() => {
        const i = rowIds.indexOf(focus);
        const id = rowIds[i < 0 ? 0 : Math.max(0, Math.min(rowIds.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))];
        if (id) ui({ focusId: id, selection: [id] });
      });
    } else if (e.key === 'Tab' && focus) {
      // Cycles the dependencies of the focused bar (Del removes the selected one).
      const list = L.deps.filter((d) => d.from === focus || d.to === focus);
      if (!list.length) return;
      const i = list.findIndex((d) => d.from === dep?.from && d.to === dep?.to);
      const d = list[i < 0 ? (e.shiftKey ? list.length - 1 : 0) : (i + (e.shiftKey ? list.length - 1 : 1)) % list.length];
      go(() => setDep({ from: d.from, to: d.to }));
    } else if (keyIs('plan.today', e)) go(scrollToday); // §7k
    else if (keyIs('plan.zoomIn', e)) go(() => zoomBy(-1));
    else if (keyIs('plan.zoomOut', e)) go(() => zoomBy(1));
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    const el = root();
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const conflicts = plan.tickets.filter((t) => base.byId[t.id].conflict).length;
  const bodyH = L.height - L.headerH;
  const portRow = preview?.ghost ? null : hover && hover.kind !== 'dep' && L.rows.find((r) => r.id === hover.id && r.bar && r.kind !== 'summary');
  const focusRow = L.rows.find((r) => r.id === (hover?.id ?? focusId) && r.kind === 'task');
  const laneRow = !preview && hover?.kind === 'lane' && L.rows.find((r) => r.id === hover.id && r.kind === 'unscheduled');
  const laneX = laneRow && L.left + (unit(hover.day) - unit(L.start)) * px; // the hovered unscheduled lane's day

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs select-none">
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <ToggleGroup type="single" size="sm" aria-label="Zoom" value={options.zoom} onValueChange={(v) => v && setOptions({ zoom: v })}>
          {ZOOMS.map(([v, name]) => <ToggleGroupItem key={v} value={v} aria-label={name} className="h-7 px-2 text-xs" onMouseDown={keepFocus}>{name}</ToggleGroupItem>)}
        </ToggleGroup>
        <Tip title={withKey('Scroll to today', 'plan.today')}>
          <Button variant="ghost" size="xs" onMouseDown={keepFocus} onClick={scrollToday}>Today</Button>
        </Tip>
        <DropdownMenu modal={false}>
          <Tip title="What the chart shows">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs" aria-label="Show" onMouseDown={keepFocus}><Eye />Show</Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="start" onCloseAutoFocus={refocusEditor}>
            {SHOW.map(([k, name]) => (
              <DropdownMenuCheckboxItem key={k} checked={!!options[k]} onSelect={(e) => e.preventDefault()} onCheckedChange={(v) => setOptions({ [k]: v })}>{name}</DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuCheckboxItem checked={showUnscheduled} onSelect={(e) => e.preventDefault()} onCheckedChange={(v) => setOptions({ showUnscheduled: v })}>Unscheduled tickets</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={options.weekLabels === 'number'} disabled={!cal.weekOne} onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => setOptions({ weekLabels: v ? 'number' : 'date' })}>Week numbers (week zoom)</DropdownMenuCheckboxItem>
            {!cal.weekOne && <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Set week 1 first in More plan actions > Calendar...</DropdownMenuLabel>}
          </DropdownMenuContent>
        </DropdownMenu>
        {conflicts > 0 && (
          <Tip title="Orange bars start before their predecessors allow. Auto-schedule in More plan actions moves them.">
            <span className="px-1 text-orange-400">{conflicts} conflict{conflicts === 1 ? '' : 's'}</span>
          </Tip>
        )}
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
          Click or drag in an unscheduled row to schedule it; drag a bar to move it (Shift: with its successors), its ends to resize, a dot beside it to link; Alt-drag a link: lag
        </span>
      </div>
      <div ref={pane} className="relative min-h-0 flex-1 overflow-auto border-t" onScroll={onScroll}
        onPointerDown={(e) => { // the empty space below the rows clears, as the chart's does
          const inner = pane.current.firstElementChild;
          if (!backgroundClick(e, (t) => t === pane.current || t === inner || t === inner.lastElementChild)) return;
          setDep(null);
          ui({ selection: [] });
        }}>
        <div className="relative" style={{ width: listOff + L.width, minWidth: '100%' }}>
          <div className="sticky top-0 z-20 flex bg-background">
            {showList && (
              <div className="sticky left-0 z-10 flex shrink-0 items-end border-r border-b bg-background pb-1 font-medium text-muted-foreground" style={{ width: listW, height: L.headerH }}>
                <span className="min-w-0 flex-1 px-2">Task</span><span className="w-14">Start</span><span className="w-14">End</span><span className="w-10 pr-2 text-right">Days</span>
                <span className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-ring/50" title="Drag to resize the task list" onPointerDown={resizeList} />
              </div>
            )}
            <svg width={L.width} height={L.headerH} className="shrink-0" data-gantt-head=""><GanttTicks L={L} p={APP} /></svg>
          </div>
          <div className="flex">
            {showList && (
              <div className="sticky left-0 z-10 shrink-0 border-r bg-background" style={{ width: listW }}>
                {L.rows.map((r) => {
                  const t = ticketOf(r.id);
                  const n = sched.byId[r.id];
                  const [s, e] = r.summary ? [fromWork(n.s, cal), fromWork(n.e - 1, cal)] : [toDay(t.start), toDay(t.end)];
                  return (
                    <div key={r.id} data-gantt-row={r.id} aria-selected={selection.includes(r.id)} style={ROW}
                      className={cn('flex cursor-pointer items-center tabular-nums hover:bg-accent/40', selection.includes(r.id) && 'bg-accent/70 hover:bg-accent/70',
                        focusId === r.id && 'outline outline-1 -outline-offset-1 outline-ring', hasKids(r.id) && 'font-medium')}
                      onPointerDown={(ev) => ev.button === 0 && !dismissOnly(ev) && select(ev, r.id)} onDoubleClick={() => editTicket(planId, r.id)} onContextMenu={(ev) => openMenu(ev, r.id)}>
                      <span className="flex min-w-0 flex-1 items-center gap-1 px-2" style={{ paddingLeft: 8 + r.depth * 12 }}>
                        {t.milestone && <Milestone className="size-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate text-sm">{t.title || 'Untitled'}</span>
                      </span>
                      {r.kind === 'unscheduled' ? <span className="w-38 pr-2 text-muted-foreground">{hasKids(r.id) ? '-' : 'Unscheduled'}</span> : <>
                        <span className={cn('w-14', r.summary && 'text-muted-foreground')}>{day(s)}</span>
                        <span className={cn('w-14', r.summary && 'text-muted-foreground')}>{day(e)}</span>
                        <span className={cn('w-10 pr-2 text-right', r.summary && 'text-muted-foreground')}>{t.milestone ? <Diamond className="ml-auto size-3" aria-label="Milestone" /> : `${n.d} d`}</span>
                      </>}
                    </div>
                  );
                })}
              </div>
            )}
            {L.rows.length > 0 ? (
              <svg ref={body} width={L.width} height={bodyH} viewBox={`0 ${L.headerH} ${L.width} ${bodyH}`} className="shrink-0 touch-none"
                style={{ cursor: busy.current ? undefined : laneRow && hasKids(laneRow.id) ? 'not-allowed' : CURSOR[hover?.kind] ?? 'default' }} aria-label="Gantt chart"
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={() => !busy.current && setHover(null)}
                onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}>
                <GanttGrid L={L} p={APP} />
                {L.rows.filter((r) => selection.includes(r.id) || r.id === focusId).map((r) => (
                  <rect key={r.id} x={0} y={r.y} width={L.width} height={L.rowH} fill={APP.accent} fillOpacity={selection.includes(r.id) ? 0.14 : 0.05} />
                ))}
                <GanttDeps L={L} p={APP} selected={dep} />
                <GanttRows L={{ ...L, rows: L.rows.filter((r) => r.bar) }} ctx={vctx} p={APP} sched={sched} />
                {laneRow && (hasKids(laneRow.id)
                  ? <text x={laneX + 4} y={laneRow.y + 18} fill={APP.muted} fontSize={12} fontFamily="system-ui, sans-serif">Schedule its subtasks</text>
                  : <rect x={laneX} y={laneRow.y + 5} width={Math.max(px, 3)} height={18} rx={4} fill={APP.accent} fillOpacity={0.3} data-lane-ghost="" />)}
                {focusRow && <path d={`M${focusRow.bar.x + focusRow.progressW} ${focusRow.y + 23}l-4 5h8z`} fill={APP.strong} />}
                {portRow && [['port-s', portRow.bar.x - (portRow.milestone ? 13 : 6)], ['port-e', portRow.bar.x + (portRow.milestone ? 13 : portRow.bar.w + 6)]].map(([k, cx]) => (
                  <circle key={k} cx={cx} cy={portRow.y + L.rowH / 2} r={4} fill={hover.kind === k ? APP.accent : 'none'} stroke={APP.accent} strokeWidth={1.5} />
                ))}
                {preview?.ghost && (
                  <polyline points={preview.ghost.points.map((pt) => pt.join(',')).join(' ')} fill="none" strokeWidth={2} strokeDasharray="5 3"
                    stroke={preview.ghost.bad ? APP.critical : APP.accent} />
                )}
                {preview?.label && <text x={preview.label.x} y={preview.label.y} fill={APP.strong} fontSize={12} fontFamily="system-ui, sans-serif">{preview.label.text}</text>}
              </svg>
            ) : (
              <div ref={body} className="relative shrink-0 p-3 text-muted-foreground" style={{ width: L.width, height: 3 * L.rowH }}>
                <svg width={L.width} height={3 * L.rowH} viewBox={`0 ${L.headerH} ${L.width} ${3 * L.rowH}`} className="absolute inset-0">
                  <GanttGrid L={{ ...L, height: L.headerH + 3 * L.rowH }} p={APP} />
                </svg>
                <span className="relative">
                  {!plan.tickets.length
                    ? <>No tickets yet. <Button variant="outline" size="xs" className="ml-1" onMouseDown={keepFocus} onClick={() => newTicket(planId)}><Plus />Ticket</Button></>
                    : filterTickets(ctx, options).length ? 'The matching tickets have no dates. Show > Unscheduled tickets lists them.' : 'No ticket matches the filters.'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      {menu && <GanttMenu menu={menu} ctx={ctx} sched={base} onClose={() => setMenu(null)} />}
    </div>
  );
}

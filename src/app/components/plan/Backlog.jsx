import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { ArrowDown, ArrowUp, Ban, ChevronDown, ChevronRight, Columns3, FileText, GripVertical, Milestone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fmt, toDay } from '../../../plan/dates.mjs';
import { blockers, doneColumnOf, estimateDays, filterTickets, statusOf, summary, unitOf } from '../../../plan/plan-model.mjs';
import { BACKLOG_COLS, backlogRows } from '../../../plan-chart.js';
import { edgeSpeed } from '../../../whiteboard.js';
import { withKey } from '../../keybinds.js';
import { refocusEditor } from '../../actions.js';
import { deleteTickets, dispatch, editTicket, moveCards } from '../../plans.js';
import { getState, setState, useStore } from '../../store.js';
import { backgroundClick } from '../../viewport.js';
import { DateField } from '../DateField.jsx';
import { Tip } from '../Tip.jsx';
import { keepFocus } from '../Toolbar.jsx';
import { openDraftFromPlan, PRIORITIES } from './Card.jsx';

// The Backlog tab (Gantt plan §6.4): the plan's tickets as a tree table, filtered like the Board. Hidden columns and collapsed
// parents are per-viewer conveniences in localStorage (`daf-writer.plan.<planId>`, §3.4).

const root = () => document.getElementById('workspace-root');
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable;
const ui = (patch) => setState({ planUi: { ...getState().planUi, ...patch } });
const NO_STATUS = '-'; // Radix Select items need a non-empty value
const day = (s) => fmt(toDay(s), 'd MMM');
const WIDTH = { num: '44px', title: 'minmax(200px, 1fr)', status: '130px', priority: '112px', labels: '140px', estimate: '72px', start: '96px', end: '96px', progress: '64px', deps: '90px', draft: '150px', checklist: '64px' };
const SORTS = {
  num: (t) => t.num, title: (t) => t.title.toLowerCase(), priority: (t) => t.priority || 5,
  start: (t) => t.start ?? '9999', end: (t) => t.end ?? '9999',
};

const localKey = (planId) => `daf-writer.plan.${planId}`;
function readLocal(planId) {
  try {
    return JSON.parse(localStorage.getItem(localKey(planId))) ?? {};
  } catch {
    return {};
  }
}
function writeLocal(planId, patch) {
  try {
    localStorage.setItem(localKey(planId), JSON.stringify({ ...readLocal(planId), ...patch }));
  } catch { /* a per-viewer convenience: not kept */ }
}

/** The chart `fields` of the Backlog columns this viewer shows (Insert into draft from the Backlog tab). */
export function backlogFields(planId) {
  const hidden = readLocal(planId).backlogHidden ?? [];
  return [...new Set(BACKLOG_COLS.filter(([k, , , f]) => f && !hidden.includes(k)).flatMap(([, , , f]) => f))];
}

/** A date cell: the date as text; a click edits it in a date box (a picked day, Enter or leaving it sends, Escape cancels). */
function DateCell({ value, muted, calendar, onCommit }) {
  const [edit, setEdit] = useState(false);
  const cancel = useRef(false);
  if (muted || !edit) {
    return (
      <button type="button" disabled={muted} className={cn('h-6 w-full truncate rounded px-1 text-left tabular-nums', !muted && 'hover:bg-accent/60', muted && 'text-muted-foreground')}
        onMouseDown={keepFocus} onClick={() => { cancel.current = false; setEdit(true); }}>
        {value ? day(value) : <span className="text-muted-foreground/50">-</span>}
      </button>
    );
  }
  const commit = (v) => {
    setEdit(false);
    if (!cancel.current && (v || null) !== value) onCommit(v || null);
  };
  return (
    <DateField autoFocus defaultValue={value ?? ''} aria-label="Date" calendar={calendar}
      className="h-6 w-full rounded border border-input bg-input/30 px-1 text-xs shadow-none md:text-xs [color-scheme:dark]"
      onPick={commit} onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.preventDefault(); // cancels the edit only, not the workspace
          cancel.current = true;
          e.currentTarget.blur();
        }
      }} />
  );
}

function SelectCell({ value, label, items, onChange }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" aria-label={label} className="h-6! w-full gap-1 border-transparent bg-transparent! px-1 text-xs shadow-none hover:border-input" onMouseDown={keepFocus}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent onCloseAutoFocus={refocusEditor}>
        {items.map(([v, content]) => <SelectItem key={v} value={v} className="text-xs">{content}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

const Dot = ({ color }) => <span className={cn('size-2 shrink-0 rounded-full', !color && 'border border-muted-foreground/60')} style={color ? { background: color } : undefined} />;

/** The Backlog tab: rows = the tree (children indented, collapsible), the drag handle, #, title, status, priority, labels,
 * estimate, start, end, progress, deps, draft, checklist (each but the title can be hidden). A header click sorts (again:
 * the other way); while sorted the rows are flat and cannot be dragged. Dragging the handle reorders among siblings; with
 * Alt held, a drop on a row makes it the parent. Click opens a ticket (and selects it), Ctrl+click toggles, Shift+click
 * selects a range; keys as §6.7. */
export function Backlog({ ctx, options }) {
  const { plan } = ctx;
  const planId = plan.id;
  const { selection, focusId } = useStore((s) => s.planUi);
  const [local, setLocal] = useState(() => readLocal(planId));
  const [sort, setSort] = useState(null); // {key, dir: 1 | -1}
  const [drag, setDrag] = useState(null); // {ids, target: {id, before} | {id, parent: true} | null}
  const body = useRef(null);
  const hidden = local.backlogHidden ?? [];
  const collapsed = new Set(local.backlogCollapsed ?? []);
  const keep = (patch) => {
    writeLocal(planId, patch);
    setLocal((l) => ({ ...l, ...patch }));
  };
  const done = doneColumnOf(plan);
  const ticketOf = (id) => plan.tickets.find((t) => t.id === id);
  const hasKids = (id) => plan.tickets.some((t) => t.parent === id);
  const colIndex = (t) => plan.columns.findIndex((c) => c.id === statusOf(t, ctx));
  const sorter = sort && (sort.key === 'status' ? colIndex : sort.key === 'estimate' ? (t) => estimateDays(plan, t) ?? Infinity : SORTS[sort.key]);
  const rows = sort
    ? filterTickets(ctx, options).map((ticket) => ({ ticket, depth: 0, children: [] }))
      .sort((a, b) => { const [x, y] = [sorter(a.ticket), sorter(b.ticket)]; return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; })
    : backlogRows(ctx, options, collapsed);
  const ids = rows.map((r) => r.ticket.id);
  const cols = BACKLOG_COLS.filter(([k]) => k === 'title' || !hidden.includes(k));
  const grid = { gridTemplateColumns: ['24px', ...cols.map(([k]) => WIDTH[k])].join(' ') };
  const sel = () => (selection.length ? ids.filter((id) => selection.includes(id)) : focusId && ids.includes(focusId) ? [focusId] : []);
  const toggle = (id) => keep({ backlogCollapsed: collapsed.has(id) ? [...collapsed].filter((x) => x !== id) : [...collapsed, id] });

  const click = (e, id) => {
    // Its controls act on their own; React also bubbles clicks out of their portals (a select's list) to the row.
    if (!e.currentTarget.contains(e.target) || e.target.closest('button, input, [role=combobox], [data-handle]')) return;
    const cur = getState().planUi;
    if (e.ctrlKey || e.metaKey) {
      ui({ selection: cur.selection.includes(id) ? cur.selection.filter((x) => x !== id) : [...cur.selection, id], focusId: id });
    } else if (e.shiftKey && ids.includes(cur.focusId)) {
      const [a, b] = [ids.indexOf(cur.focusId), ids.indexOf(id)].sort((x, y) => x - y);
      ui({ selection: ids.slice(a, b + 1) });
    } else {
      ui({ selection: [id], focusId: id });
      editTicket(planId, id);
    }
  };

  // Reorders the tickets `moving` (siblings) one place up (-1) or down (1) among their siblings.
  const shift = (moving, by) => {
    const t = ticketOf(moving[0]);
    const sibs = plan.order.filter((id) => ticketOf(id).parent === t.parent);
    const at = by < 0 ? sibs.indexOf(moving[0]) - 1 : sibs.indexOf(moving.at(-1)) + 1;
    const other = sibs[at];
    if (other && !moving.includes(other)) dispatch('plan.tickets.reorder', { planId, ticketIds: moving, ...(by < 0 ? { beforeId: other } : { afterId: other }) });
  };

  // Drag of a row's handle: siblings reorder (the insertion line), with Alt the row under the pointer becomes the parent.
  const startDrag = (e, t) => {
    if (e.button !== 0 || sort) return;
    e.preventDefault();
    const cur = getState().planUi.selection;
    const moving = cur.includes(t.id) && cur.every((id) => ticketOf(id)?.parent === t.parent) ? ids.filter((id) => cur.includes(id)) : [t.id];
    const below = new Set(moving);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of plan.tickets) if (!below.has(x.id) && below.has(x.parent)) grew = below.add(x.id);
    }
    const y0 = e.clientY;
    let y = y0;
    let alt = false;
    let moved = false;
    let target = null;
    let frame = 0;
    const locate = () => {
      const els = [...body.current.querySelectorAll('[data-row]')].filter((el) => !moving.includes(el.dataset.row));
      const hit = els.find((el) => y < el.getBoundingClientRect().bottom) ?? els.at(-1);
      const id = hit?.dataset.row;
      const r = hit?.getBoundingClientRect();
      if (!id) target = null;
      else if (alt) target = below.has(id) ? null : { id, parent: true };
      else target = ticketOf(id).parent === t.parent ? { id, before: y < (r.top + r.bottom) / 2 } : null;
      setDrag({ ids: moving, target });
    };
    const tick = () => {
      const r = body.current.getBoundingClientRect();
      const by = edgeSpeed(r.bottom - y) - edgeSpeed(y - r.top);
      if (by) {
        body.current.scrollTop += by;
        locate();
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (ev) => {
      y = ev.clientY;
      alt = ev.altKey;
      if (!moved && Math.abs(y - y0) <= 4) return;
      if (!moved) frame = requestAnimationFrame(tick);
      moved = true;
      locate();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(frame);
      setDrag(null);
      if (!moved || !target) return;
      if (target.parent) dispatch('plan.tickets.update', { planId, ticketIds: moving, patch: { parent: target.id } });
      else dispatch('plan.tickets.reorder', { planId, ticketIds: moving, ...(target.before ? { beforeId: target.id } : { afterId: target.id }) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Backlog keys (§6.7) on #workspace-root; typing in an input, a menu or a dialog is not here.
  const keys = useRef(null);
  keys.current = (e) => {
    if (e.defaultPrevented || typing(e) || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const go = (fn) => {
      e.preventDefault();
      fn();
    };
    const at = ids.indexOf(focusId);
    if (e.key === 'Escape' && selection.length) go(() => ui({ selection: [] }));
    else if (ctrl && e.key.toLowerCase() === 'a') go(() => ui({ selection: ids }));
    else if (ctrl) return;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel().length) go(() => deleteTickets(planId, sel()));
    else if (e.key === 'Enter' && at >= 0) go(() => editTicket(planId, focusId));
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
      e.preventDefault();
      const moving = sel();
      if (!sort && moving.length && moving.every((id) => ticketOf(id).parent === ticketOf(moving[0]).parent)) shift(moving, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = ids[at < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, at + (e.key === 'ArrowUp' ? -1 : 1)))];
      if (next) ui({ focusId: next, selection: [next] });
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && at >= 0 && !sort && hasKids(focusId)) {
      e.preventDefault();
      if (collapsed.has(focusId) === (e.key === 'ArrowRight')) toggle(focusId);
    }
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    const el = root();
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const statusItems = [...plan.columns.map((c) => [c.id, <><Dot color={c.color} />{c.name}</>]), [NO_STATUS, <><Dot />No status</>]];
  const priorityItems = PRIORITIES.map(([v, name, Icon]) => [String(v), <>{Icon ? <Icon /> : <span className="size-4" />}{name}</>]);
  const setDates = (t, key, v) => {
    const patch = !v ? { start: null, end: null }
      : key === 'start' ? { start: v, end: t.end && t.end >= v ? t.end : v } : { start: t.start && t.start <= v ? t.start : v, end: v };
    dispatch('plan.tickets.update', { planId, ticketIds: [t.id], patch });
  };

  const cell = (k, node) => {
    const t = node.ticket;
    const sum = hasKids(t.id) ? summary(plan, t.id) : null;
    switch (k) {
      case 'num': return <span className="text-muted-foreground tabular-nums">#{t.num}</span>;
      case 'title': return (
        <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: node.depth * 16 }}>
          {!sort && hasKids(t.id) ? (
            <button type="button" className="-ml-1 shrink-0 rounded text-muted-foreground hover:text-foreground" aria-label={collapsed.has(t.id) ? 'Expand' : 'Collapse'}
              onMouseDown={keepFocus} onClick={() => toggle(t.id)}>{collapsed.has(t.id) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}</button>
          ) : <span className="w-2.5 shrink-0" />}
          {t.milestone && <Milestone className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm">{t.title || 'Untitled'}</span>
        </span>
      );
      case 'status': return <SelectCell label="Status" value={statusOf(t, ctx) ?? NO_STATUS} items={statusItems} onChange={(v) => moveCards(planId, [t.id], v === NO_STATUS ? null : v)} />;
      case 'priority': return <SelectCell label="Priority" value={String(t.priority)} items={priorityItems} onChange={(v) => dispatch('plan.tickets.update', { planId, ticketIds: [t.id], patch: { priority: +v } })} />;
      case 'labels': return (
        <span className="flex min-w-0 flex-wrap gap-1">
          {t.labels.map((id) => plan.labels.find((l) => l.id === id)).filter(Boolean).map((l) => (
            <span key={l.id} className="rounded px-1 text-[10px] leading-4" style={{ background: `${l.color}33`, color: l.color }}>{l.name}</span>
          ))}
        </span>
      );
      case 'estimate': {
        if (sum) return <span className="text-muted-foreground tabular-nums">{sum.estimateDays != null ? `${+sum.estimateDays.toFixed(2)} d` : ''}</span>;
        const unit = unitOf(plan, t.unit);
        return t.estimate != null && <Tip title={unit.id === 'd' ? 'Estimate in working days' : `= ${+(t.estimate * unit.daysPer).toFixed(2)} d`}><span className="tabular-nums">{t.estimate} {unit.name}</span></Tip>;
      }
      case 'start': case 'end': return <DateCell value={sum ? sum[k] : t[k]} muted={!!sum} calendar={plan.calendar} onCommit={(v) => setDates(t, k, v)} />;
      case 'progress': return <span className={cn('tabular-nums', sum && 'text-muted-foreground')}>{sum ? sum.progress : t.progress}%</span>;
      case 'deps': {
        const open = statusOf(t, ctx) !== done ? blockers(ctx, t.id) : [];
        return (
          <span className="flex min-w-0 items-center gap-1">
            {open.length > 0 && <Tip title={`Blocked by ${open.map((b) => `#${b.num} ${b.title}`).join(', ')}`}><Ban className="size-3.5 text-orange-400" aria-label="Blocked" /></Tip>}
            <span className="truncate text-muted-foreground">{t.deps.map((d) => `#${ticketOf(d.on)?.num}`).join(', ')}</span>
          </span>
        );
      }
      case 'draft': {
        const draft = t.draftId && ctx.drafts.find((d) => d.id === t.draftId);
        return draft && (
          <button type="button" className="flex min-w-0 items-center gap-0.5 text-muted-foreground hover:text-foreground" title={`Open the draft "${draft.title}"`}
            onClick={() => openDraftFromPlan(draft.id)}>
            <FileText className="size-3.5 shrink-0" /><span className="truncate">{draft.title || 'Untitled draft'}</span>
          </button>
        );
      }
      case 'checklist': return t.checklist.length > 0 && <span className="tabular-nums">{t.checklist.filter((c) => c.done).length}/{t.checklist.length}</span>;
      default: return null;
    }
  };

  // Footer: tickets, the estimate sum in days (tooltip: per unit), done %, blocked.
  const shown = filterTickets(ctx, options);
  const perUnit = new Map();
  for (const t of shown) if (t.estimate != null && !hasKids(t.id)) perUnit.set(unitOf(plan, t.unit).name, (perUnit.get(unitOf(plan, t.unit).name) ?? 0) + t.estimate);
  const days = shown.filter((t) => !hasKids(t.id)).reduce((s, t) => s + (estimateDays(plan, t) ?? 0), 0);
  const doneCount = shown.filter((t) => statusOf(t, ctx) === done).length;
  const blocked = shown.filter((t) => statusOf(t, ctx) !== done && blockers(ctx, t.id).length).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-3 text-xs"
      onPointerDown={(e) => backgroundClick(e, (t) => t === e.currentTarget || t === body.current || t.matches('[role=table]')) && ui({ selection: [] })}>
      <div className="flex h-7 shrink-0 items-center gap-1">
        {sort && (
          <Button variant="secondary" size="xs" onMouseDown={keepFocus} onClick={() => setSort(null)}>
            Sorted by {BACKLOG_COLS.find(([k]) => k === sort.key)[1]}, clear sort<X />
          </Button>
        )}
        <span className="flex-1" />
        <DropdownMenu modal={false}>
          <Tip title="Columns">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Backlog columns" onMouseDown={keepFocus}><Columns3 /></Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end" onCloseAutoFocus={refocusEditor}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Show columns</DropdownMenuLabel>
            {BACKLOG_COLS.filter(([k]) => k !== 'title').map(([k, label]) => (
              <DropdownMenuCheckboxItem key={k} checked={!hidden.includes(k)} onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => keep({ backlogHidden: on ? hidden.filter((x) => x !== k) : [...hidden, k] })}>{k === 'num' ? '# (number)' : label}</DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-auto rounded-md border">
        <div className="min-w-max" role="table" aria-label="Backlog">
          <div role="row" className="sticky top-0 z-10 grid h-7 items-center border-b bg-muted text-muted-foreground" style={grid}>
            <span />
            {cols.map(([k, label]) => (
              <button key={k} type="button" role="columnheader" disabled={!SORTS[k] && k !== 'status' && k !== 'estimate'}
                className="flex h-full min-w-0 items-center gap-0.5 px-1.5 text-left font-medium enabled:hover:text-foreground"
                onMouseDown={keepFocus} onClick={() => setSort(sort?.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: 1 })}>
                <span className="truncate">{label}</span>
                {sort?.key === k && (sort.dir > 0 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
              </button>
            ))}
          </div>
          {rows.map((node) => {
            const t = node.ticket;
            const line = drag?.target?.id === t.id && !drag.target.parent && (drag.target.before ? 'before:top-0' : 'before:bottom-0');
            return (
              <div key={t.id} data-row={t.id} role="row" aria-selected={selection.includes(t.id)} onClick={(e) => click(e, t.id)}
                className={cn('relative grid h-8 cursor-pointer items-center border-b border-border/50 select-none hover:bg-accent/40',
                  selection.includes(t.id) && 'bg-accent/70 hover:bg-accent/70', focusId === t.id && 'outline outline-1 -outline-offset-1 outline-ring',
                  drag?.ids.includes(t.id) && 'opacity-40', drag?.target?.parent && drag.target.id === t.id && 'bg-primary/20 outline outline-1 outline-primary',
                  line && `before:absolute before:inset-x-0 before:h-0.5 before:bg-primary ${line}`)}
                style={grid}>
                <span data-handle="" className={cn('flex justify-center text-muted-foreground', sort ? 'opacity-30' : 'cursor-grab hover:text-foreground')}
                  title={sort ? 'Clear the sort to drag' : 'Drag to reorder (Alt: drop on a row to make it the parent)'} onPointerDown={(e) => startDrag(e, t)}>
                  <GripVertical className="size-3.5" />
                </span>
                {cols.map(([k]) => <div key={k} role="cell" className="min-w-0 overflow-hidden px-1.5">{cell(k, node)}</div>)}
              </div>
            );
          })}
          {!rows.length && <p className="p-3 text-muted-foreground">{plan.tickets.length ? 'No ticket matches the filters.' : withKey('No tickets yet. + Ticket', 'plan.newTicket') + ' adds one.'}</p>}
        </div>
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 px-1 text-muted-foreground tabular-nums">
        <span>{shown.length} ticket{shown.length === 1 ? '' : 's'}</span>
        <Tip title={perUnit.size ? [...perUnit].map(([u, n]) => `${+n.toFixed(2)} ${u}`).join(' + ') : 'No estimates'}><span>{+days.toFixed(2)} d</span></Tip>
        <span>{shown.length ? Math.round((doneCount / shown.length) * 100) : 0}% done</span>
        <span>{blocked} blocked</span>
      </div>
    </div>
  );
}

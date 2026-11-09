// The plan tools in the one pool (docs/plans/cleanup/tool-pool-surfaces.md B4). On the plan page (surface 'plan'): the views,
// the filters, Hide done, saved views, the More plan actions menu, the Gantt's scale, zoom, what it shows and Scroll to today,
// the Board's Done and Convert and columns, and ticket actions on the selection. On a plan chart in a draft (ctx.chart, the one
// the chart bar serves): its view, plan, fields, legend, freeze and the rest of its bar. Commands with meta get generated tool
// search entries; the plan components and their keys run every one of them through run(id). They call what the plan's agent
// commands call (plans.js dispatch and its imperative bodies) and take the catalogue's ids where one exists. A command with
// `optionsFirst` takes a value (`{value}`, with `ids` for tickets other than the selection): tool search opens its options, and
// tool.run passes its arg. Meta `headless: false` marks a dialog or file picker an agent cannot use (commands/tool.mjs).
import { createElement as h, useSyncExternalStore } from 'react';
import {
  Bookmark, CalendarDays, ChartGantt, CircleCheck, Columns3, Download, ExternalLink, EyeOff, FileText, ListFilter, ListTodo, Milestone,
  MoveHorizontal, Plus, Redo2, RefreshCw, Signal, Snowflake, SquareKanban, Tags, Trash2, Undo2, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Dot } from '@/components/ui/dot';
import { Toggle } from '@/components/ui/toggle';
import { FIELDS, OPTION_DEFAULTS } from '../plan/plan-model.mjs';
import { activeChart, freezeCtx, planSource } from '../plan-chart.js';
import { FontPick } from '../tooling/kit/FontPick.jsx';
import { ToggleGroup } from '../tooling/ribbon/parts.jsx';
import { register, run } from '../tooling/registry.js';
import { confirmDialog, openDialog } from './actions.js';
import { backlogFields } from './components/plan/Backlog.jsx';
import { PRIORITIES } from './components/plan/Card.jsx';
import { can } from './gates.mjs';
import {
  askName, canRedoPlan, canUndoPlan, copyPlan, deleteColumn, deletePlan, deleteTickets, dispatch, editColumns, editTicket, exportPlan,
  importPlan, insertPlanChart, moveCards, newTicket, openPlan, planById, planList, redoPlan, renamePlan, setPlanTab, undoPlan, usePlans,
} from './plans.js';
import { getState, setState, useStore } from './store.js';
import { closeWorkspace } from './views.js';

/** The plan page's views: tab, name, icon, chart view. Each tab's command id is `plan.<tab>`, its keybind's id. */
export const TABS = [['board', 'Board', SquareKanban, 'kanban'], ['backlog', 'Backlog', ListTodo, 'backlog'], ['gantt', 'Gantt', ChartGantt, 'gantt']];
const SCALES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['fit', 'Fit']];
const KEYS = ['plan', 'kanban', 'board', 'tickets', 'sprint', 'todo', 'task', 'project'];
const NO_STATUS = '-'; // the status value of "No status"

/** The mounted Gantt's and Board's own actions, which need their view state: each sets its entry on every render and clears it
 * when it unmounts. gantt {today(), zoomBy(dir)}; kanban {done() | null, convert() | null, addColumn() | null}. */
export const live = { gantt: null, kanban: null };

const view = () => getState().view;
const planId = () => view().planId;
const thePlan = () => planById(planId());
const ui = () => getState().planUi;
const setUi = (patch) => setState({ planUi: { ...ui(), ...patch } });
const setOptions = (patch) => setUi({ options: { ...ui().options, ...patch } });
const opt = (key) => ({ ...OPTION_DEFAULTS, ...ui().options })[key];
const tabNow = () => TABS.find((t) => t[0] === view().tab);
const onGantt = () => view().tab === 'gantt';
// Adds or removes `v` in the filter list `key` (empty: no filter).
const toggleIn = (key, v) => {
  const list = ui().options[key] ?? [];
  const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  setOptions({ [key]: next.length ? next : null });
};
const valueOf = (a) => (a && typeof a === 'object' ? a.value : a);

// --- the selection ---

/** The tickets a ticket command acts on: `a.ids`, else the selection, else the focused ticket (draft cards left out). */
function ticketsOf(a) {
  const plan = thePlan();
  const { selection, focusId } = ui();
  const ids = a?.ids ?? (selection.length ? selection : focusId ? [focusId] : []);
  return plan ? ids.filter((id) => plan.tickets.some((t) => t.id === id)) : [];
}
const hasTickets = () => ticketsOf().length > 0;
const ticketOf = (id) => thePlan()?.tickets.find((t) => t.id === id) ?? null;

// --- saved views and Insert into draft ---

/** Shows saved view `v`: its filters, fields and tab. */
function applyView(v) {
  const { search = '', ...rest } = v.options;
  setUi({ filter: search, options: rest });
  const to = TABS.find((t) => t[3] === v.view)[0];
  if (to !== view().tab) setPlanTab(to);
}
const currentOptions = () => ({ ...ui().options, ...(ui().filter && { search: ui().filter }) });
// What Insert into draft charts for this tab: its filters and fields (read when picked).
function chartOptions() {
  const kind = tabNow()[3];
  const { options } = ui();
  return {
    ...options,
    ...(kind !== 'gantt' && { fields: kind === 'backlog' ? backlogFields(planId()) : options.fields ?? [...OPTION_DEFAULTS.fields, 'estimate'] }),
    ...(ui().filter && { search: ui().filter }),
  };
}

// --- the tool search option panels (React, re-drawn on plan, store and chart changes) ---

function Panel({ draw }) {
  usePlans();
  useStore((s) => s.planUi);
  useSyncExternalStore(activeChart.subscribe, activeChart.get);
  return draw();
}
const panel = (draw) => h(Panel, { draw });
const chip = (key, label, pressed, onPress, color, Icon) => h(Toggle, {
  key, size: 'xs', 'aria-label': label, pressed, onPressedChange: onPress, className: 'font-normal',
}, color !== undefined && h(Dot, { color }), Icon && h(Icon), h('span', { className: 'max-w-28 truncate' }, label));
const chips = (children) => h('div', { className: 'flex max-w-96 flex-wrap items-center gap-0.5' }, children);
const empty = (text) => h('span', { className: 'px-1 text-xs text-muted-foreground' }, text);

// Status, priority and label picks for the tickets `ticketsOf()` names.
const statusChips = () => {
  const plan = thePlan();
  const ids = ticketsOf();
  if (!plan || !ids.length) return empty('Select a ticket first');
  const cols = [...plan.columns, { id: null, name: 'No status', color: null }];
  return chips(cols.map((c) => chip(c.id ?? NO_STATUS, c.name, false, () => run('plan.tickets.status', { value: c.id ?? NO_STATUS }), c.color)));
};
const priorityChips = () => (hasTickets()
  ? chips(PRIORITIES.map(([v, name, Icon]) => chip(v, name, ticketsOf().every((id) => ticketOf(id)?.priority === v), () => run('plan.tickets.priority', { value: v }), undefined, Icon)))
  : empty('Select a ticket first'));
const labelChips = () => {
  const plan = thePlan();
  if (!hasTickets()) return empty('Select a ticket first');
  if (!plan.labels.length) return empty('No labels yet (Labels... in More plan actions)');
  return chips(plan.labels.map((l) => chip(l.id, l.name, ticketsOf().every((id) => ticketOf(id)?.labels.includes(l.id)),
    () => run('plan.tickets.labels', { value: l.id }), l.color)));
};

// --- the chart in focus ---

/** The plan chart the bar serves (its NodeView), while the editor shows it; else null. */
const chartView = (ctx) => (view().type === 'editor' && ctx.chart?.view) || null;
const chartOf = (ctx) => chartView(ctx)?.chart ?? null;
const chartPlanFound = (ctx) => !!planSource.context(chartOf(ctx)?.planId);
const setChart = (ctx, patch) => chartView(ctx).set(patch);
const chartOpts = (ctx) => ({ ...OPTION_DEFAULTS, ...chartOf(ctx).options });
const putChart = (ctx, patch) => setChart(ctx, { options: { ...chartOf(ctx).options, ...patch } });

/** Freeze or Refresh: chart NodeView `v` shows the plan as it is now. */
export const freezeChart = (v) => v.set({ frozen: { at: Date.now(), ctx: freezeCtx(planSource.context(v.chart.planId), v.chart.view) } });

// --- commands ---

const page = {}; // surface 'plan'
const add = (id, spec, meta) => {
  page[id] = meta ? { ...spec, meta: { group: 'Plan', ...meta } } : spec;
};
const toggle = (id, label, key, icon, keywords, enabled) => add(id, {
  run: () => setOptions({ [key]: !opt(key) }), active: () => !!opt(key), ...(enabled && { enabled }),
}, { label, icon, toggle: true, keywords });

// Views
for (const [tab, name, icon] of TABS) {
  add(`plan.${tab}`, { run: () => setPlanTab(tab), enabled: () => view().tab !== tab }, {
    label: name, icon, key: `plan.${tab}`, keywords: [...KEYS, tab, name.toLowerCase(), 'view', 'tab', ...(tab === 'gantt' ? ['timeline', 'schedule', 'dates'] : [])],
  });
}

// Filters and saved views
add('plan.filter', {
  // A string sets the filter text; without one the filter box takes the focus.
  run: (ctx, text) => {
    if (typeof text === 'string') return setUi({ filter: text });
    requestAnimationFrame(() => document.getElementById('plan-filter')?.focus());
    return true;
  },
}, { label: 'Filter tickets', icon: ListFilter, key: 'plan.filter', keywords: ['filter', 'search', 'find ticket', 'find', 'title', 'number', ...KEYS] });
add('plan.filter.labels', {
  run: (ctx, a) => valueOf(a) != null && toggleIn('labels', valueOf(a)),
  options: () => panel(() => {
    const plan = thePlan();
    if (!plan?.labels.length) return empty('No labels yet (Labels... in More plan actions)');
    return chips(plan.labels.map((l) => chip(l.id, l.name, !!ui().options.labels?.includes(l.id), () => run('plan.filter.labels', { value: l.id }), l.color)));
  }),
}, { label: 'Filter by label', icon: Tags, optionsFirst: true, keywords: ['label', 'labels', 'tag', 'filter', 'show tickets with'] });
add('plan.filter.priority', {
  run: (ctx, a) => valueOf(a) != null && toggleIn('priority', valueOf(a)),
  options: () => panel(() => chips(PRIORITIES.map(([v, name, Icon]) => chip(v, name, !!ui().options.priority?.includes(v), () => run('plan.filter.priority', { value: v }), undefined, Icon)))),
}, { label: 'Filter by priority', icon: Signal, optionsFirst: true, keywords: ['priority', 'urgent', 'high', 'low', 'filter'] });
toggle('plan.hideDone', 'Hide done', 'hideDone', EyeOff, ['hide done', 'done', 'finished', 'completed', 'closed', 'filter', 'show done']);
add('plan.views', {
  run: (ctx, a) => {
    const v = thePlan()?.views.find((x) => x.id === valueOf(a));
    return !!v && (applyView(v), true);
  },
  options: () => panel(() => {
    const views = thePlan()?.views ?? [];
    return views.length ? chips(views.map((v) => chip(v.id, `${v.name} (${TABS.find((t) => t[3] === v.view)[1]})`, false, () => run('plan.views', { value: v.id }))))
      : empty('No saved views yet');
  }),
}, { label: 'Saved views', icon: Bookmark, optionsFirst: true, keywords: ['saved view', 'views', 'bookmark', 'preset', 'filter', 'apply view'] });
add('plan.views.save', {
  run: async () => {
    const name = await askName('Save current view as', '', 'Save');
    if (name) dispatch('plan.views.add', { planId: planId(), view: { name, view: tabNow()[3], options: currentOptions() } });
  },
}, { label: 'Save current view...', icon: Bookmark, headless: false, keywords: ['save view', 'saved view', 'bookmark', 'remember filters'] });
add('plan.views.remove', {
  run: async (ctx, a) => {
    const v = thePlan()?.views.find((x) => x.id === valueOf(a));
    if (v && await confirmDialog({ title: `Delete the saved view "${v.name}"?`, confirmText: 'Delete', destructive: true })) dispatch('plan.views.remove', { planId: planId(), viewId: v.id });
  },
});

// Tickets
add('plan.newTicket', { run: () => newTicket(planId()) }, {
  label: 'New ticket', icon: Plus, key: 'plan.newTicket', headless: false, keywords: ['new ticket', 'add ticket', 'create ticket', 'new task', 'add task', 'issue', 'card', 'todo', 'item'],
});
add('plan.tickets.open', {
  run: (ctx, a) => editTicket(planId(), valueOf(a) ?? ui().focusId), enabled: () => !!ticketOf(ui().focusId),
}, { label: 'Open ticket', icon: FileText, headless: false, keywords: ['open', 'edit ticket', 'details', 'ticket'] });
add('plan.tickets.status', {
  run: (ctx, a) => {
    const v = valueOf(a);
    return v !== undefined && moveCards(planId(), a?.ids ?? ticketsOf(), v === NO_STATUS ? null : v);
  },
  enabled: hasTickets, options: () => panel(statusChips),
}, { label: 'Set status', icon: Columns3, optionsFirst: true, keywords: ['status', 'move to', 'column', 'state', 'progress'] });
add('plan.tickets.priority', {
  run: (ctx, a) => valueOf(a) != null && dispatch('plan.tickets.update', { planId: planId(), ticketIds: ticketsOf(a), patch: { priority: +valueOf(a) } }).ok,
  enabled: hasTickets, options: () => panel(priorityChips),
}, { label: 'Set priority', icon: Signal, optionsFirst: true, keywords: ['priority', 'urgent', 'high', 'medium', 'low'] });
add('plan.tickets.labels', {
  // Toggles a label: `on` (default: every ticket has it) removes it, else every ticket gets it.
  run: (ctx, a) => {
    const ids = ticketsOf(a);
    const labelId = valueOf(a);
    if (labelId == null || !ids.length) return false;
    const on = a.on ?? ids.every((id) => ticketOf(id)?.labels.includes(labelId));
    return dispatch(on ? 'plan.tickets.labels.remove' : 'plan.tickets.labels.add', { planId: planId(), ticketIds: ids, labelId }).ok;
  },
  enabled: hasTickets, options: () => panel(labelChips),
}, { label: 'Label tickets', icon: Tags, optionsFirst: true, keywords: ['label', 'labels', 'tag', 'add label', 'remove label'] });
add('plan.tickets.milestone', {
  run: (ctx, a) => {
    const ids = ticketsOf(a);
    const v = typeof valueOf(a) === 'boolean' ? valueOf(a) : !ids.every((id) => ticketOf(id)?.milestone);
    return dispatch('plan.tickets.update', { planId: planId(), ticketIds: ids, patch: { milestone: v } }).ok;
  },
  enabled: hasTickets, active: () => hasTickets() && ticketsOf().every((id) => ticketOf(id)?.milestone),
}, { label: 'Milestone', icon: Milestone, toggle: true, keywords: ['milestone', 'diamond', 'deadline', 'key date'] });
add('plan.tickets.delete', { run: (ctx, a) => deleteTickets(planId(), ticketsOf(a)), enabled: hasTickets }, {
  label: 'Delete tickets', icon: Trash2, risk: 'destructive', headless: false, keywords: ['delete', 'remove', 'delete ticket', 'trash', 'del'],
});
add('plan.done', { run: () => live.kanban.done(), enabled: () => !!live.kanban?.done }, {
  label: 'Done or not done', icon: CircleCheck, key: 'plan.done', keywords: ['done', 'complete', 'finish', 'not done', 'reopen', 'board'],
});
add('plan.convert', { run: () => live.kanban.convert(), enabled: () => !!live.kanban?.convert }, {
  label: 'Convert draft card to ticket', icon: FileText, key: 'plan.convert', keywords: ['convert', 'draft card', 'make ticket', 'board'],
});

// Columns (the Board; a column command takes {columnId})
add('plan.columns.add', { run: () => live.kanban.addColumn(), enabled: () => !!live.kanban?.addColumn }, {
  label: 'Add column', icon: Plus, keywords: ['add column', 'new column', 'status', 'board', 'kanban', 'lane'],
});
add('plan.columns.edit', { run: () => editColumns(planId()) }, { label: 'Columns...', icon: Columns3, headless: false, keywords: ['columns', 'edit columns', 'statuses', 'wip', 'column colour', 'board'] });
add('plan.columns.move', { run: (ctx, a) => dispatch('plan.columns.move', { planId: planId(), ...a }).ok });
add('plan.columns.done', { run: (ctx, a) => dispatch('plan.update', { planId: planId(), patch: { doneColumn: a.columnId } }).ok });
add('plan.columns.remove', { run: (ctx, a) => deleteColumn(planId(), a.columnId) });

// The Gantt
add('plan.today', { run: () => live.gantt.today(), enabled: () => !!live.gantt }, {
  label: 'Scroll to today', icon: CalendarDays, key: 'plan.today', keywords: ['today', 'now', 'current date', 'jump to today', 'go to today', 'gantt', 'timeline'],
});
add('plan.zoomIn', { run: () => live.gantt.zoomBy(-1), enabled: () => !!live.gantt }, { label: 'Zoom in', icon: ZoomIn, key: 'plan.zoomIn', keywords: ['zoom in', 'closer', 'days', 'gantt'] });
add('plan.zoomOut', { run: () => live.gantt.zoomBy(1), enabled: () => !!live.gantt }, { label: 'Zoom out', icon: ZoomOut, key: 'plan.zoomOut', keywords: ['zoom out', 'wider', 'months', 'gantt'] });
add('plan.zoom', {
  run: (ctx, a) => SCALES.some(([z]) => z === valueOf(a)) && (setOptions({ zoom: valueOf(a) }), true),
  enabled: onGantt,
  options: () => panel(() => h(ToggleGroup, { label: 'Scale', size: 'medium', items: scaleItems() })),
}, { label: 'Gantt scale', icon: CalendarDays, optionsFirst: true, keywords: ['scale', 'zoom', 'day', 'week', 'month', 'quarter', 'fit', 'gantt', 'timeline'] });
/** The kit toggle items of the Gantt's scales (the Gantt's bar and the tool search panel). */
export const scaleItems = () => SCALES.map(([z, name]) => ({ id: `plan.zoom.${z}`, label: name, icon: NoIcon, active: opt('zoom') === z, onClick: () => run('plan.zoom', { value: z }) }));
function NoIcon() {
  return null;
}
/** What the Gantt shows: [id, option key, menu name, label for tool search]. Each is command `plan.show.<id>`. */
export const GANTT_SHOW = [['deps', 'showDeps', 'Dependencies'], ['critical', 'showCritical', 'Critical path'], ['baseline', 'showBaseline', 'Baseline'],
  ['today', 'showToday', 'Today line'], ['weekends', 'showWeekends', 'Weekends (off shows working days only)', 'Weekends'], ['taskList', 'showTaskList', 'Task list'],
  ['unscheduled', 'showUnscheduled', 'Unscheduled tickets']];
for (const [id, key, name, short] of GANTT_SHOW) {
  add(`plan.show.${id}`, {
    run: () => setOptions({ [key]: !(opt(key) ?? true) }), active: () => !!(opt(key) ?? true), enabled: onGantt,
  }, { label: `Show ${(short ?? name).toLowerCase()}`, icon: ChartGantt, toggle: true, keywords: ['show', 'hide', 'gantt', (short ?? name).toLowerCase()] });
}
add('plan.show.weekNumbers', {
  run: () => setOptions({ weekLabels: opt('weekLabels') === 'number' ? 'date' : 'number' }), active: () => opt('weekLabels') === 'number',
  enabled: () => onGantt() && !!thePlan()?.calendar.weekOne,
}, { label: 'Week numbers', icon: CalendarDays, toggle: true, keywords: ['week numbers', 'week no', 'iso week', 'gantt'] });

// History and the More plan actions menu
add('plan.undo', { run: () => undoPlan(planId()), enabled: () => canUndoPlan(planId()) }, {
  label: 'Undo plan change', icon: Undo2, key: 'edit.undo', keywords: ['undo', 'back', 'revert', 'oops', 'step back'],
});
add('plan.redo', { run: () => redoPlan(planId()), enabled: () => canRedoPlan(planId()) }, {
  label: 'Redo plan change', icon: Redo2, key: 'edit.redo', keywords: ['redo', 'again', 'repeat', 'forward'],
});
add('plan.close', { run: () => closeWorkspace() }, { label: 'Back to editor', icon: X, keywords: ['close plan', 'editor', 'back', 'exit', 'leave', 'document', 'draft'] });
add('plan.labels.edit', { run: () => openDialog('planLabels', { planId: planId() }) }, { label: 'Labels...', icon: Tags, headless: false, keywords: ['labels', 'edit labels', 'label colour', 'tags'] });
add('plan.units.edit', { run: () => openDialog('planUnits', { planId: planId() }) }, { label: 'Units...', icon: Signal, headless: false, keywords: ['units', 'estimate', 'points', 'story points'] });
add('plan.calendar.edit', { run: () => openDialog('planCalendar', { planId: planId() }) }, { label: 'Calendar...', icon: CalendarDays, headless: false, keywords: ['calendar', 'working days', 'holidays', 'week one'] });
add('plan.baseline.set', { run: () => dispatch('plan.baseline.set', { planId: planId() }).ok }, { label: 'Set baseline', icon: ChartGantt, keywords: ['baseline', 'snapshot', 'compare', 'gantt'] });
add('plan.baseline.clear', { run: () => dispatch('plan.baseline.clear', { planId: planId() }).ok, enabled: () => !!thePlan()?.baselineAt }, {
  label: 'Clear baseline', icon: ChartGantt, keywords: ['baseline', 'remove baseline', 'gantt'],
});
add('plan.autoSchedule', {
  run: () => dispatch('plan.update', { planId: planId(), patch: { autoSchedule: !thePlan().autoSchedule } }).ok, active: () => !!thePlan()?.autoSchedule,
}, { label: 'Auto-schedule', icon: CalendarDays, toggle: true, keywords: ['auto schedule', 'schedule', 'dependencies', 'conflicts'] });
add('plan.rename', { run: () => renamePlan(planId()) }, { label: 'Rename plan...', icon: FileText, headless: false, keywords: ['rename', 'title', 'plan name'] });
add('plan.insertChart', {
  // A saved view's id inserts that view; without one, this tab as shown.
  run: (ctx, a) => {
    const v = thePlan()?.views.find((x) => x.id === valueOf(a));
    return insertPlanChart(v ? { planId: planId(), view: v.view, options: v.options } : { planId: planId(), view: tabNow()[3], options: chartOptions() });
  },
  enabled: () => can('doc.open', getState()),
}, { label: 'Insert into draft', icon: SquareKanban, keywords: ['insert', 'plan chart', 'embed', 'draft', 'document', 'chart'] });
add('plan.copy.markdown', { run: () => copyPlan(planId(), 'markdown') }, { label: 'Copy as Markdown', icon: FileText, keywords: ['copy', 'markdown', 'text', 'export'] });
add('plan.copy.mermaid', { run: () => copyPlan(planId(), 'mermaid') }, { label: 'Copy as Mermaid', icon: FileText, keywords: ['copy', 'mermaid', 'gantt', 'diagram', 'export'] });
add('plan.export', { run: () => exportPlan(planId()) }, { label: 'Export plan...', icon: Download, headless: false, keywords: ['export', 'save', 'file', 'json', 'backup'] });
add('plan.import', { run: () => importPlan(planId()) }, { label: 'Import plan...', icon: Upload, headless: false, keywords: ['import', 'load', 'file', 'json', 'tasks'] });
add('plan.delete', { run: () => deletePlan(planId()) }, { label: 'Delete plan...', icon: Trash2, risk: 'destructive', headless: false, keywords: ['delete plan', 'remove plan', 'trash'] });

register('plan', page, ['plan']);

// Opening the plan page from a draft.
register('plan', {
  'plan.open': {
    run: () => openPlan(), enabled: () => !!(getState().settings?.selectedThread || getState().draft?.threadUrl),
    meta: { label: 'Open plan board', group: 'Plan', icon: SquareKanban, key: 'app.plans', keywords: [...KEYS, 'plans', 'gantt', 'backlog', 'timeline', 'schedule', 'open plan', 'workspace'] },
  },
}, ['text', 'document']);

// The plan chart in focus. Its bar shows only over the editor, so these serve the chart there; the plan kind keeps them in the
// plan profile's pool.
const chart = {};
const onChart = (more) => (ctx) => !!chartView(ctx) && (more?.(ctx) ?? true);
const addChart = (id, spec, meta) => {
  chart[id] = { ...spec, enabled: onChart(spec.enabled), ...(meta && { meta: { group: 'Item', ...meta } }) };
};
const chartToggle = (id, label, key, keywords, more) => addChart(id, {
  run: (ctx) => putChart(ctx, { [key]: !chartOpts(ctx)[key] }), active: (ctx) => !!chartView(ctx) && !!chartOpts(ctx)[key], enabled: more,
}, { label, icon: SquareKanban, toggle: true, keywords });

addChart('plan.chart.set', { run: (ctx, patch) => setChart(ctx, patch) });
addChart('plan.chart.open', { run: (ctx) => chartView(ctx).openPlan(), enabled: chartPlanFound }, {
  label: 'Open plan', icon: ExternalLink, keywords: ['open', 'go to plan', 'plan board', 'edit plan', 'edit', 'tickets', 'workspace'],
});
for (const [, name, icon, kind] of TABS) {
  addChart(`plan.chart.${kind}`, { run: (ctx) => setChart(ctx, { view: kind }), enabled: (ctx) => chartOf(ctx).view !== kind }, {
    label: `${name} view`, icon, keywords: [name.toLowerCase(), kind, 'view', 'chart view', 'switch view', 'show as'],
  });
}
addChart('plan.chart.plan', {
  run: (ctx, a) => !!planById(valueOf(a)) && (setChart(ctx, { planId: valueOf(a), frozen: null }), true),
  options: (ctx) => panel(() => h(PlanPick, { value: chartOf(ctx)?.planId, onChange: (id) => run('plan.chart.plan', { value: id }) })),
}, { label: 'Chart plan', icon: SquareKanban, optionsFirst: true, keywords: ['plan', 'pick plan', 'other plan', 'change plan', 'project'] });
addChart('plan.chart.fields', {
  run: (ctx, a) => {
    const f = valueOf(a);
    if (!FIELDS.includes(f)) return false;
    const o = chartOpts(ctx);
    return putChart(ctx, { fields: o.fields.includes(f) ? o.fields.filter((x) => x !== f) : [...o.fields, f] });
  },
  enabled: (ctx) => chartOf(ctx).view !== 'gantt',
  options: (ctx) => panel(() => chips(FIELDS.filter((f) => planSource.pushShown() || f !== 'pushed')
    .map((f) => chip(f, FIELD_NAMES[f], !!chartView(ctx) && chartOpts(ctx).fields.includes(f), () => run('plan.chart.fields', { value: f }))))),
}, { label: 'Chart fields', icon: Columns3, optionsFirst: true, keywords: ['fields', 'columns', 'card fields', 'show', 'hide'] });
chartToggle('plan.chart.legend', 'Chart legend', 'legend', ['legend', 'labels', 'key']);
chartToggle('plan.chart.footer', 'Chart footer', 'footer', ['footer', 'counts', 'date']);
chartToggle('plan.chart.hideDone', 'Hide done in chart', 'hideDone', ['hide done', 'done', 'finished', 'filter']);
addChart('plan.chart.title', {
  run: (ctx) => putChart(ctx, { title: chartOpts(ctx).title === '' ? null : '' }), active: (ctx) => !!chartView(ctx) && chartOpts(ctx).title !== '',
}, { label: 'Chart title bar', icon: SquareKanban, toggle: true, keywords: ['title', 'heading', 'title bar'] });
addChart('plan.chart.freeze', { run: (ctx) => freezeChart(chartView(ctx)), enabled: (ctx) => !chartOf(ctx).frozen && chartPlanFound(ctx) }, {
  label: 'Freeze', icon: Snowflake, keywords: ['freeze', 'frozen', 'snapshot', 'lock', 'keep as is', 'stop updating', 'static'],
});
addChart('plan.chart.refresh', { run: (ctx) => freezeChart(chartView(ctx)), enabled: (ctx) => !!chartOf(ctx).frozen && chartPlanFound(ctx) }, {
  label: 'Refresh', icon: RefreshCw, keywords: ['refresh', 'update', 'freeze again', 'reload', 'sync'],
});
addChart('plan.chart.live', { run: (ctx) => setChart(ctx, { frozen: null }), enabled: (ctx) => !!chartOf(ctx).frozen }, {
  label: 'Show live', icon: Snowflake, keywords: ['live', 'unfreeze', 'follow plan', 'dynamic', 'update automatically'],
});
addChart('plan.chart.fullWidth', { run: (ctx) => setChart(ctx, { dw: null }), enabled: (ctx) => chartOf(ctx).dw != null }, {
  label: 'Full width', icon: MoveHorizontal, keywords: ['page width', 'wide', 'wider', 'stretch', 'fit width', 'resize', 'bigger'],
});
addChart('plan.chart.delete', { run: (ctx) => chartView(ctx).remove() }, {
  label: 'Delete chart', icon: Trash2, risk: 'destructive', keywords: ['remove', 'delete', 'delete chart', 'delete plan chart', 'trash', 'bin', 'del', 'backspace'],
});

register('plan', chart, ['plan', 'text', 'document']);

/** Card fields and Backlog columns by name (the chart's Fields). */
export const FIELD_NAMES = {
  num: 'Number', labels: 'Labels', due: 'Due date', checklist: 'Checklist', priority: 'Priority', estimate: 'Estimate', progress: 'Progress',
  draft: 'Linked draft', pushed: 'Pushed tick', blocked: 'Blocked', deps: 'Dependencies',
};

/** The plan picker: every plan, searched as typed (the kit's FontPick list). `onChange(planId)`; typed text that names no plan
 * changes nothing. */
export function PlanPick({ value, onChange, ...props }) {
  usePlans();
  const options = planList().map((p) => ({ id: p.id, label: p.title || p.threadUrl }));
  return h(FontPick, {
    'aria-label': 'Plan', placeholder: 'Plan not found', className: 'w-44', ...props, value: options.some((o) => o.id === value) ? value : null, options,
    onChange: (id) => options.some((o) => o.id === id) && onChange(id),
  });
}

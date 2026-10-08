import { createElement as h } from 'react';
import { ChartGantt, ExternalLink, ListTodo, MoveHorizontal, Plus, Redo2, RefreshCw, Snowflake, SquareKanban, Trash2, Undo2, X } from 'lucide-react';
import { planSource } from '../plan-chart.js';
import { freezeChart } from './components/board/PlanChartBar.jsx';
import { can } from './gates.mjs';
import { canRedoPlan, canUndoPlan, newTicket, openPlan, redoPlan, setPlanTab, undoPlan } from './plans.js';
import { getState } from './store.js';
import { closeWorkspace } from './views.js';

// Tool search entries of the plan workspace (Gantt plan §6.10; roadmap A2–A4) and of a node-selected plan chart, spread into
// TOOLS (tools.js). Entries as there: {id, label, icon, group, keywords, when(ctx) or needs, run?(ctx), shortcut?}.

const inPlan = (c) => can('view.plan', c);
const inText = (c) => !c.board && can('doc.open', { editor: c.ed }) && can('view.editor', c); // as tools.js
const planId = (c) => c.view.planId;
const KEYS = ['plan', 'kanban', 'board', 'tickets', 'sprint', 'todo', 'task', 'project'];
const tab = (id, label, icon, value, keywords) => ({
  id, label, group: 'Plan', icon: h(icon), when: (c) => inPlan(c) && c.view.tab !== value, run: () => setPlanTab(value), keywords: [...keywords, ...KEYS],
});

// A node-selected plan chart (§6e chart bar, PlanChartBar.jsx): the bar's actions, on the same NodeView; listed first under its
// heading (tool-rank.mjs BLOCK_SECTIONS). Where the bar disables one, the entry is not listed.
const CHART = [{ gate: 'node.is', with: ['planChart'] }];
const chartOf = (c) => c.block.view.chart;
const planFound = (c) => !!planSource.context(chartOf(c).planId);
const chartView = (id, label, icon, value, keywords) => ({
  id, label, group: 'Item', icon: h(icon), needs: CHART, also: (c) => chartOf(c).view !== value, run: (c) => c.block.view.set({ view: value }),
  keywords: [...keywords, 'view', 'chart view', 'switch view', 'show as'],
});
const CHART_TOOLS = [
  { id: 'chart-open', label: 'Open plan', group: 'Item', icon: h(ExternalLink), shortcut: 'Enter', needs: CHART, also: planFound,
    run: (c) => c.block.view.openPlan(), keywords: ['open', 'go to plan', 'plan board', 'edit plan', 'edit', 'tickets', 'workspace'] },
  chartView('chart-kanban', 'Board view', SquareKanban, 'kanban', ['board', 'kanban', 'columns', 'cards']),
  chartView('chart-backlog', 'Backlog view', ListTodo, 'backlog', ['backlog', 'list', 'table', 'rows']),
  chartView('chart-gantt', 'Gantt view', ChartGantt, 'gantt', ['gantt', 'timeline', 'schedule', 'dates']),
  { id: 'chart-freeze', label: 'Freeze', group: 'Item', icon: h(Snowflake), needs: CHART, also: (c) => !chartOf(c).frozen && planFound(c), notice: 'Frozen',
    run: (c) => freezeChart(c.block.view), keywords: ['freeze', 'frozen', 'snapshot', 'lock', 'keep as is', 'stop updating', 'static'] },
  { id: 'chart-refresh', label: 'Refresh', group: 'Item', icon: h(RefreshCw), needs: CHART, also: (c) => !!chartOf(c).frozen && planFound(c), notice: 'Refreshed',
    run: (c) => freezeChart(c.block.view), keywords: ['refresh', 'update', 'freeze again', 'reload', 'sync'] },
  { id: 'chart-live', label: 'Show live', group: 'Item', icon: h(Snowflake), needs: CHART, also: (c) => !!chartOf(c).frozen, notice: 'Live',
    run: (c) => c.block.view.set({ frozen: null }), keywords: ['live', 'unfreeze', 'follow plan', 'dynamic', 'update automatically'] },
  { id: 'chart-full-width', label: 'Full width', group: 'Item', icon: h(MoveHorizontal), needs: CHART, also: (c) => chartOf(c).dw != null,
    run: (c) => c.block.view.set({ dw: null }), keywords: ['page width', 'wide', 'wider', 'stretch', 'fit width', 'resize', 'bigger'] },
  { id: 'chart-delete', label: 'Delete', group: 'Item', icon: h(Trash2), shortcut: 'Del', notice: 'Deleted', needs: CHART, risk: 'destructive',
    run: (c) => c.block.view.remove(), keywords: ['remove', 'delete chart', 'delete plan chart', 'trash', 'bin', 'del', 'backspace'] },
];

export const PLAN_TOOLS = [
  ...CHART_TOOLS,
  { id: 'plan-open', label: 'Open plan board', group: 'Plan', icon: h(SquareKanban), key: 'app.plans', run: () => openPlan(),
    when: (c) => can('view.editor', c) && !!(getState().settings?.selectedThread || getState().draft?.threadUrl),
    keywords: [...KEYS, 'plans', 'gantt', 'backlog', 'timeline', 'schedule', 'open plan', 'workspace'] },
  // The toolbar's Insert plan chart (tools.js text() entry shape).
  { id: 'plan-insert-chart', label: 'Insert plan chart', group: 'Insert', icon: h(SquareKanban), when: inText, run: (c) => c.T.planChart.onClick(),
    keywords: ['plan chart', 'kanban', 'board', 'backlog', 'tickets', 'chart', 'plan', 'sprint', 'todo', 'task', 'progress', 'status', 'embed plan'] },
  tab('plan-board', 'Board', SquareKanban, 'board', ['columns', 'cards', 'status']),
  tab('plan-backlog', 'Backlog', ListTodo, 'backlog', ['list', 'table', 'rows']),
  tab('plan-gantt', 'Gantt', ChartGantt, 'gantt', ['timeline', 'schedule', 'chart', 'dates', 'dependencies']),
  { id: 'plan-new-ticket', label: 'New ticket', group: 'Plan', icon: h(Plus), key: 'plan.newTicket', when: inPlan, run: (c) => newTicket(planId(c)),
    keywords: ['new ticket', 'add ticket', 'create ticket', 'new task', 'add task', 'issue', 'card', 'todo', 'item'] },
  { id: 'plan-undo', label: 'Undo plan change', group: 'Plan', icon: h(Undo2), key: 'edit.undo', when: (c) => inPlan(c) && canUndoPlan(planId(c)),
    run: (c) => undoPlan(planId(c)), keywords: ['undo', 'back', 'revert', 'oops', 'step back'] },
  { id: 'plan-redo', label: 'Redo plan change', group: 'Plan', icon: h(Redo2), key: 'edit.redo', when: (c) => inPlan(c) && canRedoPlan(planId(c)),
    run: (c) => redoPlan(planId(c)), keywords: ['redo', 'again', 'repeat', 'forward'] },
  { id: 'plan-close', label: 'Back to editor', group: 'Plan', icon: h(X), when: inPlan, run: () => closeWorkspace(),
    keywords: ['close plan', 'editor', 'back', 'exit', 'leave', 'document', 'draft'] },
];

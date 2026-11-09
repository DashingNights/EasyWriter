import { createElement as h } from 'react';
import { SquareKanban } from 'lucide-react';
import { can } from './gates.mjs';

// The plan's hand-made tool search entry, spread into TOOLS (tools.js): the toolbar's Insert plan chart, which the forum toolset
// package (docs/plans/cleanup/tool-pool-surfaces.md B1) moves into the pool as insert.planChart. Every other plan entry is
// generated from the plan commands' meta (pool-plan.js).

const inText = (c) => !c.board && can('doc.open', { editor: c.ed }) && can('view.editor', c); // as tools.js

export const PLAN_TOOLS = [
  // The toolbar's Insert plan chart (tools.js text() entry shape).
  { id: 'plan-insert-chart', label: 'Insert plan chart', group: 'Insert', icon: h(SquareKanban), when: inText, run: (c) => c.T.planChart.onClick(),
    keywords: ['plan chart', 'kanban', 'board', 'backlog', 'tickets', 'chart', 'plan', 'sprint', 'todo', 'task', 'progress', 'status', 'embed plan'] },
];

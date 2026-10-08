import { useEffect, useRef } from 'react';
import { OPTION_DEFAULTS } from '../../../plan/plan-model.mjs';
import { newTicket, planContext, redoPlan, setPlanTab, undoPlan, usePlans } from '../../plans.js';
import { keyAmong, keyIs } from '../../keybinds.js';
import { useStore } from '../../store.js';
import { Backlog } from './Backlog.jsx';
import { Gantt } from './Gantt.jsx';
import { Kanban } from './Kanban.jsx';
import { PlanHeader, TABS } from './PlanHeader.jsx';

const root = () => document.getElementById('workspace-root');
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable;

const TAB_KEYS = ['plan.board', 'plan.backlog', 'plan.gantt']; // TABS order (§7k)

/** The plan workspace (Gantt plan §6; SPEC §7f): its header row, then the Board, the Backlog or the Gantt. Common
 * keys (§6.7) on #workspace-root: Alt+1–3 tabs, / filter, N new ticket (the Board adds in a column), Ctrl+Z / Ctrl+Y /
 * Ctrl+Shift+Z the plan's undo and redo. */
export function PlanPage() {
  usePlans();
  const { planId, tab } = useStore((s) => s.view);
  const { filter, options } = useStore((s) => s.planUi);
  const ctx = planContext(planId);
  const keys = useRef(null);
  keys.current = (e) => {
    if (e.defaultPrevented || !ctx) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const go = (fn) => {
      e.preventDefault();
      fn();
    };
    const tabKey = keyAmong(TAB_KEYS, e); // §7k keybinds
    if (tabKey) go(() => setPlanTab(TABS[TAB_KEYS.indexOf(tabKey)][0]));
    else if (typing(e)) return;
    else if (keyIs('edit.undo', e)) go(() => undoPlan(planId));
    else if (keyIs('edit.redo', e)) go(() => redoPlan(planId));
    else if (keyIs('plan.filter', e)) go(() => document.getElementById('plan-filter')?.focus());
    else if (keyIs('plan.newTicket', e) && tab !== 'board') go(() => newTicket(planId));
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    const el = root();
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  if (!ctx) return <p className="m-auto text-sm text-muted-foreground">This plan no longer exists.</p>;
  const view = { ...OPTION_DEFAULTS, ...options, search: filter };
  return (
    <div data-viewport className="flex h-full flex-col">
      <PlanHeader plan={ctx.plan} tab={tab} />
      {tab === 'board'
        ? <Kanban key={planId} ctx={ctx} options={{ ...view, fields: options.fields }} />
        : tab === 'backlog' ? <Backlog key={planId} ctx={ctx} options={view} />
          : <Gantt key={planId} ctx={ctx} options={view} />}
    </div>
  );
}

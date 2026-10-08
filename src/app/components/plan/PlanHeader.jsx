import { Bookmark, ChartGantt, Ellipsis, EyeOff, ListFilter, ListTodo, Plus, Redo2, Signal, SquareKanban, Tags, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { OPTION_DEFAULTS } from '../../../plan/plan-model.mjs';
import { keyLabel, withKey } from '../../keybinds.js';
import { confirmDialog, refocusEditor } from '../../actions.js';
import { can } from '../../gates.mjs';
import {
  askName, canRedoPlan, canUndoPlan, copyPlan, deletePlan, dispatch, editColumns, exportPlan, importPlan, insertPlanChart, newTicket,
  redoPlan, renamePlan, setPlanTab, undoPlan,
} from '../../plans.js';
import { getState, setState, useStore } from '../../store.js';
import { closeWorkspace } from '../../views.js';
import { SidebarButton } from '../Sidebar.jsx';
import { Tip } from '../Tip.jsx';
import { keepFocus } from '../Toolbar.jsx';
import { backlogFields } from './Backlog.jsx';
import { PRIORITIES } from './Card.jsx';

export const TABS = [['board', 'Board', SquareKanban, 'kanban'], ['backlog', 'Backlog', ListTodo, 'backlog'], ['gantt', 'Gantt', ChartGantt, 'gantt']];
const root = () => document.getElementById('workspace-root');
const openDialog = (type, props) => new Promise((resolve) => setState({ dialog: { type, props, resolve } }));
const setOptions = (patch) => {
  const ui = getState().planUi;
  setState({ planUi: { ...ui, options: { ...ui.options, ...patch } } });
};
// Adds or removes `v` in the filter list `key` (an empty list: no filter).
const toggleIn = (options, key, v) => {
  const list = options[key] ?? [];
  const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  setOptions({ [key]: next.length ? next : null });
};

/** A header icon button with its tooltip. */
const IconButton = ({ title, onClick, disabled, children }) => (
  <Tip title={title}>
    <Button variant="ghost" size="icon-sm" aria-label={title} disabled={disabled} onMouseDown={keepFocus} onClick={onClick}>{children}</Button>
  </Tip>
);

/** A header filter menu (Labels, Priority, Views). */
function Menu({ title, icon, active, children }) {
  return (
    <DropdownMenu modal={false}>
      <Tip title={title}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={title} className={active ? 'bg-accent text-primary' : undefined} onMouseDown={keepFocus}>{icon}</Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="max-w-72" onCloseAutoFocus={refocusEditor}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The plan header (Gantt plan §6.2): one 36 px row. */
export function PlanHeader({ plan, tab }) {
  const planId = plan.id;
  const { filter, options } = useStore((s) => s.planUi);
  const threads = useStore((s) => s.settings?.threads) ?? [];
  const thread = threads.find((t) => t.url === plan.threadUrl);
  const label = plan.title || thread?.title || plan.threadUrl;
  const view = TABS.find((t) => t[0] === tab)[3];
  const applyView = (v) => {
    const { search = '', ...rest } = v.options;
    setState({ planUi: { ...getState().planUi, filter: search, options: rest } });
    const to = TABS.find((t) => t[3] === v.view)[0];
    if (to !== tab) setPlanTab(to);
  };
  const saveView = async () => {
    const name = await askName('Save current view as', '', 'Save');
    if (name) dispatch('plan.views.add', { planId, view: { name, view, options: { ...options, ...(filter && { search: filter }) } } });
  };
  // Insert into draft: a live chart of what this tab shows (its filters and fields), or of a saved view. Read when picked:
  // hiding a Backlog column does not re-render the header.
  const docOpen = useStore((s) => can('doc.open', s));
  const current = () => ({
    ...options, ...(view !== 'gantt' && { fields: view === 'backlog' ? backlogFields(planId) : options.fields ?? [...OPTION_DEFAULTS.fields, 'estimate'] }),
    ...(filter && { search: filter }),
  });
  const removeView = async (v) => {
    if (await confirmDialog({ title: `Delete the saved view "${v.name}"?`, confirmText: 'Delete', destructive: true })) dispatch('plan.views.remove', { planId, viewId: v.id });
  };
  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b px-1 text-xs">
      <SidebarButton />
      <span className="min-w-0 flex-1 truncate px-1 font-medium" title={thread ? `${label}\n${plan.threadUrl}` : plan.threadUrl}>{label}</span>
      <ToggleGroup type="single" size="sm" aria-label="Plan view" value={tab} onValueChange={(v) => v && setPlanTab(v)}>
        {TABS.map(([value, name, Icon], i) => (
          <Tip key={value} title={withKey(name, ['plan.board', 'plan.backlog', 'plan.gantt'][i])}>
            <ToggleGroupItem value={value} aria-label={name} className="h-7 gap-1 px-1.5 text-xs" onMouseDown={keepFocus}><Icon />{name}</ToggleGroupItem>
          </Tip>
        ))}
      </ToggleGroup>
      <Input id="plan-filter" value={filter} placeholder={(keyLabel('plan.filter') ? `Filter... ( ${keyLabel('plan.filter')} )` : 'Filter...')} aria-label="Filter tickets" className="ml-1 h-7 w-36 text-xs md:text-xs"
        onChange={(e) => setState({ planUi: { ...getState().planUi, filter: e.target.value } })}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          setState({ planUi: { ...getState().planUi, filter: '' } });
          root()?.focus();
        }} />
      <Menu title="Labels" icon={<Tags />} active={!!options.labels?.length}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Show tickets with a label</DropdownMenuLabel>
        {!plan.labels.length && <DropdownMenuItem disabled>No labels yet (Labels... in More plan actions)</DropdownMenuItem>}
        {plan.labels.map((l) => (
          <DropdownMenuCheckboxItem key={l.id} checked={!!options.labels?.includes(l.id)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggleIn(options, 'labels', l.id)}>
            <span className="size-2 rounded-full" style={{ background: l.color }} />{l.name}
          </DropdownMenuCheckboxItem>
        ))}
      </Menu>
      <Menu title="Priority" icon={<Signal />} active={!!options.priority?.length}>
        <DropdownMenuLabel className="text-xs text-muted-foreground">Show tickets with a priority</DropdownMenuLabel>
        {PRIORITIES.map(([v, name, Icon]) => (
          <DropdownMenuCheckboxItem key={v} checked={!!options.priority?.includes(v)} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggleIn(options, 'priority', v)}>
            {Icon ? <Icon /> : <span className="size-4" />}{name}
          </DropdownMenuCheckboxItem>
        ))}
      </Menu>
      <Tip title="Hide done">
        <Toggle size="sm" aria-label="Hide done" className="h-8 min-w-8" pressed={!!options.hideDone} onMouseDown={keepFocus}
          onPressedChange={(v) => setOptions({ hideDone: v })}><EyeOff /></Toggle>
      </Tip>
      <Menu title="Saved views" icon={<Bookmark />}>
        {plan.views.map((v) => (
          <DropdownMenuItem key={v.id} className="group/view" onSelect={() => applyView(v)}>
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            <span className="text-xs text-muted-foreground">{TABS.find((t) => t[3] === v.view)[1]}</span>
            <Button variant="ghost" size="icon-xs" aria-label={`Delete the view ${v.name}`} className="-my-1"
              onClick={(e) => { e.stopPropagation(); removeView(v); }}><X /></Button>
          </DropdownMenuItem>
        ))}
        {plan.views.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={saveView}><ListFilter />Save current as...</DropdownMenuItem>
      </Menu>
      <Tip title={withKey('New ticket', 'plan.newTicket')}>
        <Button variant="ghost" size="xs" onMouseDown={keepFocus} onClick={() => newTicket(planId)}><Plus />Ticket</Button>
      </Tip>
      <IconButton title={withKey('Undo', 'edit.undo')} disabled={!can('history.canUndo', { canUndo: canUndoPlan(planId) })} onClick={() => undoPlan(planId)}><Undo2 /></IconButton>
      <IconButton title={withKey('Redo', 'edit.redo')} disabled={!can('history.canRedo', { canRedo: canRedoPlan(planId) })} onClick={() => redoPlan(planId)}><Redo2 /></IconButton>
      <DropdownMenu modal={false}>
        <Tip title="More plan actions">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More plan actions" onMouseDown={keepFocus}><Ellipsis /></Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" onCloseAutoFocus={refocusEditor}>
          <DropdownMenuItem onSelect={() => openDialog('planLabels', { planId })}>Labels...</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => editColumns(planId)}>Columns...</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog('planUnits', { planId })}>Units...</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog('planCalendar', { planId })}>Calendar...</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => dispatch('plan.baseline.set', { planId })}>Set baseline{plan.baselineAt ? ' again' : ''}</DropdownMenuItem>
          <DropdownMenuItem disabled={!plan.baselineAt} onSelect={() => dispatch('plan.baseline.clear', { planId })}>Clear baseline</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={plan.autoSchedule} onCheckedChange={(v) => dispatch('plan.update', { planId, patch: { autoSchedule: v } })}>Auto-schedule</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => renamePlan(planId)}>Rename plan...</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!docOpen}>Insert into draft</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => insertPlanChart({ planId, view, options: current() })}>This view ({TABS.find((t) => t[0] === tab)[1]})</DropdownMenuItem>
              {plan.views.length > 0 && <DropdownMenuSeparator />}
              {plan.views.map((v) => (
                <DropdownMenuItem key={v.id} onSelect={() => insertPlanChart({ planId, view: v.view, options: v.options })}>
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span className="text-xs text-muted-foreground">{TABS.find((t) => t[3] === v.view)[1]}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => copyPlan(planId, 'markdown')}>Copy as Markdown</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copyPlan(planId, 'mermaid')}>Copy as Mermaid</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => exportPlan(planId)}>Export plan...</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => importPlan(planId)}>Import plan...</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => deletePlan(planId)}>Delete plan...</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip title="Back to the open draft">
        <Button variant="outline" size="xs" onMouseDown={keepFocus} onClick={() => closeWorkspace()}>Back to editor</Button>
      </Tip>
    </header>
  );
}

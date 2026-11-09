import { Bookmark, Ellipsis, EyeOff, ListFilter, Plus, Redo2, Signal, Tags, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dot } from '@/components/ui/dot';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { withKey } from '../../keybinds.js';
import { refocusEditor } from '../../actions.js';
import { can } from '../../gates.mjs';
import { canRedoPlan, canUndoPlan } from '../../plans.js';
import { TABS } from '../../pool-plan.js';
import { useStore } from '../../store.js';
import { run } from '../../../tooling/registry.js';
import { IconButton, Tip } from '../Tip.jsx';
import { keepFocus } from '../Toolbar.jsx';
import { PRIORITIES } from './Card.jsx';

const root = () => document.getElementById('workspace-root');

/** A header filter menu (Labels, Priority, Views). */
function Menu({ title, icon, active, children }) {
  return (
    <DropdownMenu modal={false}>
      <IconButton label={title} slot={DropdownMenuTrigger} onMouseDown={keepFocus} className={active ? 'bg-accent hover:bg-accent' : undefined}>{icon}</IconButton>
      <DropdownMenuContent align="end" className="max-w-72" onCloseAutoFocus={refocusEditor}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The plan header (Gantt plan §6.2): one 36 px row. Every control runs its plan command (pool-plan.js). */
export function PlanHeader({ plan, tab }) {
  const planId = plan.id;
  const { filter, options } = useStore((s) => s.planUi);
  const threads = useStore((s) => s.settings?.threads) ?? [];
  const thread = threads.find((t) => t.url === plan.threadUrl);
  const label = plan.title || thread?.title || plan.threadUrl;
  const docOpen = useStore((s) => can('doc.open', s));
  const act = (id, arg) => () => run(id, arg);
  return (
    <header className="flex h-9 shrink-0 items-center gap-1 border-b px-1 text-xs">
      <span className="min-w-0 flex-1 truncate px-1 font-medium" title={thread ? `${label}\n${plan.threadUrl}` : plan.threadUrl}>{label}</span>
      <TabsList aria-label="Plan view">
        {TABS.map(([value, name, Icon]) => (
          <Tip key={value} title={withKey(name, `plan.${value}`)}>
            <TabsTrigger value={value}><Icon />{name}</TabsTrigger>
          </Tip>
        ))}
      </TabsList>
      <Input id="plan-filter" value={filter} size="xs" placeholder={withKey('Filter...', 'plan.filter')} aria-label="Filter tickets" className="ml-1 w-36"
        onChange={(e) => run('plan.filter', e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          run('plan.filter', '');
          root()?.focus();
        }} />
      <Menu title="Labels" icon={<Tags />} active={!!options.labels?.length}>
        <DropdownMenuLabel>Show tickets with a label</DropdownMenuLabel>
        {!plan.labels.length && <DropdownMenuItem disabled>No labels yet (Labels... in More plan actions)</DropdownMenuItem>}
        {plan.labels.map((l) => (
          <DropdownMenuCheckboxItem key={l.id} checked={!!options.labels?.includes(l.id)} onSelect={(e) => e.preventDefault()} onCheckedChange={act('plan.filter.labels', { value: l.id })}>
            <Dot color={l.color} />{l.name}
          </DropdownMenuCheckboxItem>
        ))}
      </Menu>
      <Menu title="Priority" icon={<Signal />} active={!!options.priority?.length}>
        <DropdownMenuLabel>Show tickets with a priority</DropdownMenuLabel>
        {PRIORITIES.map(([v, name, Icon]) => (
          <DropdownMenuCheckboxItem key={v} checked={!!options.priority?.includes(v)} onSelect={(e) => e.preventDefault()} onCheckedChange={act('plan.filter.priority', { value: v })}>
            {Icon ? <Icon /> : <span className="size-4" />}{name}
          </DropdownMenuCheckboxItem>
        ))}
      </Menu>
      <IconButton label="Hide done" pressed={!!options.hideDone} onMouseDown={keepFocus} onClick={act('plan.hideDone')}><EyeOff /></IconButton>
      <Menu title="Saved views" icon={<Bookmark />}>
        {plan.views.map((v) => (
          <DropdownMenuItem key={v.id} className="group/view" onSelect={act('plan.views', { value: v.id })}>
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            <span className="text-xs text-muted-foreground">{TABS.find((t) => t[3] === v.view)[1]}</span>
            <IconButton label={`Delete the view ${v.name}`} variant="destructive-ghost" className="-my-1" onClick={act('plan.views.remove', { value: v.id })}><Trash2 className="text-current" /></IconButton>
          </DropdownMenuItem>
        ))}
        {plan.views.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={act('plan.views.save')}><ListFilter />Save current as...</DropdownMenuItem>
      </Menu>
      <Tip title={withKey('New ticket', 'plan.newTicket')}>
        <Button variant="ghost" size="xs" onMouseDown={keepFocus} onClick={act('plan.newTicket')}><Plus />Ticket</Button>
      </Tip>
      <IconButton label="Undo" keybind="edit.undo" disabled={!can('history.canUndo', { canUndo: canUndoPlan(planId) })} onMouseDown={keepFocus} onClick={act('plan.undo')}><Undo2 /></IconButton>
      <IconButton label="Redo" keybind="edit.redo" disabled={!can('history.canRedo', { canRedo: canRedoPlan(planId) })} onMouseDown={keepFocus} onClick={act('plan.redo')}><Redo2 /></IconButton>
      <DropdownMenu modal={false}>
        <IconButton label="More plan actions" slot={DropdownMenuTrigger} onMouseDown={keepFocus}><Ellipsis /></IconButton>
        <DropdownMenuContent align="end" onCloseAutoFocus={refocusEditor}>
          <DropdownMenuItem onSelect={act('plan.labels.edit')}>Labels...</DropdownMenuItem>
          <DropdownMenuItem onSelect={act('plan.columns.edit')}>Columns...</DropdownMenuItem>
          <DropdownMenuItem onSelect={act('plan.units.edit')}>Units...</DropdownMenuItem>
          <DropdownMenuItem onSelect={act('plan.calendar.edit')}>Calendar...</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={act('plan.baseline.set')}>Set baseline{plan.baselineAt ? ' again' : ''}</DropdownMenuItem>
          <DropdownMenuItem disabled={!plan.baselineAt} onSelect={act('plan.baseline.clear')}>Clear baseline</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={plan.autoSchedule} onCheckedChange={act('plan.autoSchedule')}>Auto-schedule</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={act('plan.rename')}>Rename plan...</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!docOpen}>Insert into draft</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={act('plan.insertChart')}>This view ({TABS.find((t) => t[0] === tab)[1]})</DropdownMenuItem>
              {plan.views.length > 0 && <DropdownMenuSeparator />}
              {plan.views.map((v) => (
                <DropdownMenuItem key={v.id} onSelect={act('plan.insertChart', { value: v.id })}>
                  <span className="min-w-0 flex-1 truncate">{v.name}</span>
                  <span className="text-xs text-muted-foreground">{TABS.find((t) => t[3] === v.view)[1]}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={act('plan.copy.markdown')}>Copy as Markdown</DropdownMenuItem>
          <DropdownMenuItem onSelect={act('plan.copy.mermaid')}>Copy as Mermaid</DropdownMenuItem>
          <DropdownMenuItem onSelect={act('plan.export')}>Export plan...</DropdownMenuItem>
          <DropdownMenuItem onSelect={act('plan.import')}>Import plan...</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={act('plan.delete')}>Delete plan...</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

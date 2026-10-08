import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CircleCheck, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { cards, doneColumnOf, MAX_COLUMNS, PLAN_GATES } from '../../../plan/plan-model.mjs';
import { confirmDialog, refocusEditor, threadLabel } from '../../actions.js';
import { deletePlan, dispatch, dispatchAll, planContext, planList, usePlans } from '../../plans.js';
import { useStore } from '../../store.js';
import { DateField } from '../DateField.jsx';
import { FormDialog } from '../FormDialog.jsx';
import { TicketDialog } from './TicketDialog.jsx';

// Form dialogs of the plan workspace (openDialog types; Gantt plan §6.2–§6.3, §6.6; roadmap A2), spread into FORMS
// (Dialogs.jsx). The list dialogs (Columns…, Labels…, Units…) run every row change at once as its own command and undo
// entry and have one Close button.

const NONE = '-'; // Radix Select items need a non-empty value
const SWATCH = 'size-8 shrink-0 cursor-pointer rounded-md border border-input bg-input/30 p-1 [&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A text box that commits on Enter or blur (when changed); Escape puts the stored value back. */
export function CommitInput({ value, onCommit, ...props }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const commit = () => text !== (value ?? '') && onCommit(text);
  return (
    <Input {...props} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape' && text !== (value ?? '')) {
          e.preventDefault(); // only the edit is cancelled, not the dialog
          setText(value ?? '');
        }
      }} />
  );
}

/** A colour swatch that commits once the native picker closes (its change event), not on every drag step. */
export function ColorInput({ value, onCommit, ...props }) {
  const ref = useRef(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    const onChange = () => el.value !== value && commit.current(el.value);
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [value]);
  return <input ref={ref} type="color" className={SWATCH} defaultValue={value} key={value} {...props} />;
}

/** The list dialogs' shell: title, rows, one Close button. */
export function ListDialog({ title, onClose, className, children }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent className={`max-h-[88vh] overflow-y-auto p-3 text-sm *:data-[slot=dialog-close]:top-3 *:data-[slot=dialog-close]:right-3 ${className ?? ''}`}
        aria-describedby={undefined} onCloseAutoFocus={refocusEditor} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle className="text-base">{title}</DialogTitle></DialogHeader>
        {children}
        <DialogFooter><Button type="button" size="sm" onClick={() => onClose(null)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const IconButton = ({ label, children, ...props }) => (
  <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} {...props}>{children}</Button>
);

/** Columns… (§6.3): colour, name, the status tag it follows, WIP limit, done, order, delete; Add column. Delete closes the
 * dialog with {remove: columnId} (plans.js asks for the target column, then opens it again). */
function ColumnsDialog({ planId, onClose }) {
  usePlans();
  const ctx = planContext(planId);
  if (!ctx) return null;
  const { plan, tags } = ctx;
  const done = doneColumnOf(plan);
  const update = (columnId, patch) => dispatch('plan.columns.update', { planId, columnId, patch });
  const room = PLAN_GATES['plan.columnRoom'].test(plan);
  return (
    <ListDialog title="Columns" onClose={onClose} className="sm:max-w-[min(640px,92vw)]">
      <div className="grid gap-1">
        {plan.columns.map((c, i) => {
          const free = tags.filter((t) => t.id === c.tagId || !plan.columns.some((x) => x.tagId === t.id));
          return (
            <div key={c.id} className="flex items-center gap-1" data-plan-column={c.id}>
              <ColorInput aria-label="Column colour" title="Column colour" value={c.color} onCommit={(color) => update(c.id, { color })} />
              <CommitInput aria-label="Column name" className="h-8 w-40" maxLength={40} value={c.name} onCommit={(name) => update(c.id, { name })} />
              <Select value={tags.some((t) => t.id === c.tagId) ? c.tagId : NONE} onValueChange={(v) => update(c.id, { tagId: v === NONE ? null : v })}>
                <SelectTrigger size="sm" aria-label="Status tag it follows" className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No status tag</SelectItem>
                  {free.map((t) => <SelectItem key={t.id} value={t.id}><span className="size-2 rounded-full" style={{ background: t.color }} />{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <CommitInput aria-label="WIP limit" title="WIP limit (empty: none)" placeholder="WIP" type="number" min={1} step={1} className="h-8 w-20"
                value={c.wip == null ? '' : String(c.wip)}
                onCommit={(v) => update(c.id, { wip: v.trim() === '' ? null : Math.max(1, Math.round(+v) || 1) })} />
              <Toggle size="sm" aria-label="Done column" title="Done column" pressed={c.id === done} className="h-8 min-w-8"
                onPressedChange={(on) => on && dispatch('plan.update', { planId, patch: { doneColumn: c.id } })}><CircleCheck /></Toggle>
              <IconButton label="Move up" disabled={!i} onClick={() => dispatch('plan.columns.move', { planId, columnId: c.id, beforeId: plan.columns[i - 1].id })}><ArrowUp /></IconButton>
              <IconButton label="Move down" disabled={i === plan.columns.length - 1}
                onClick={() => dispatch('plan.columns.move', { planId, columnId: c.id, afterId: plan.columns[i + 1].id })}><ArrowDown /></IconButton>
              {PLAN_GATES['plan.otherColumn'].test(plan) && <IconButton label="Delete column..." onClick={() => onClose({ remove: c.id })}><X /></IconButton>}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!room} onClick={() => dispatch('plan.columns.add', { planId, column: { name: 'New column' } })}>
          <Plus />Add column
        </Button>
        <span className="text-xs text-muted-foreground">{room ? `Up to ${MAX_COLUMNS} columns.` : PLAN_GATES['plan.columnRoom'].message}</span>
      </div>
      <p className="text-xs text-muted-foreground">Draft cards and linked tickets sit in the column that follows their draft's status tag.</p>
    </ListDialog>
  );
}

/** Delete column… (§6.3): where its unlinked tickets go → the column id, '' for "No status", or null (Cancel). */
function DeleteColumnDialog({ planId, columnId, onClose }) {
  const ctx = planContext(planId);
  const { plan } = ctx;
  const at = plan.columns.findIndex((c) => c.id === columnId);
  const col = plan.columns[at];
  const others = plan.columns.filter((c) => c.id !== columnId);
  const [to, setTo] = useState((plan.columns[at - 1] ?? plan.columns[at + 1]).id);
  const moving = plan.tickets.filter((t) => !t.draftId && t.status === columnId).length;
  const linked = cards(ctx).filter((c) => c.status === columnId && (c.kind === 'draft' || c.ticket.draftId)).length;
  return (
    <FormDialog title={`Delete the column "${col.name}"?`} okText="Delete" result={() => (to === NONE ? '' : to)} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        Move {plural(moving, 'ticket')} from "{col.name}" to
        <Select value={to} onValueChange={setTo}>
          <SelectTrigger size="sm" aria-label="Move the tickets to" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {others.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            <SelectItem value={NONE}>No status</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {linked > 0 && <p className="text-xs text-muted-foreground">{plural(linked, 'linked draft')} keep{linked === 1 ? 's' : ''} its status tag and show{linked === 1 ? 's' : ''} in "No status".</p>}
      {doneColumnOf(plan) === columnId && <p className="text-xs text-muted-foreground">Done moves to "{others.at(-1).name}".</p>}
      <p className="text-xs text-muted-foreground">Ctrl+Z in the plan restores the column and its tickets.</p>
    </FormDialog>
  );
}

/** Labels… (§6.2): colour, name, delete; Add label. */
function LabelsDialog({ planId, onClose }) {
  usePlans();
  const [fresh, setFresh] = useState(null); // the label just added: its name box takes the focus
  const plan = planContext(planId)?.plan;
  if (!plan) return null;
  const update = (labelId, patch) => dispatch('plan.labels.update', { planId, labelId, patch });
  const remove = async (l) => {
    const n = plan.tickets.filter((t) => t.labels.includes(l.id)).length;
    if (await confirmDialog({ title: n ? `Remove the label "${l.name}" from ${plural(n, 'ticket')}?` : `Remove the label "${l.name}"?`, confirmText: 'Remove', destructive: true })) {
      dispatch('plan.labels.remove', { planId, labelId: l.id });
    }
  };
  return (
    <ListDialog title="Labels" onClose={onClose} className="sm:max-w-[min(420px,92vw)]">
      <div className="grid gap-1">
        {!plan.labels.length && <p className="text-xs text-muted-foreground">No labels yet.</p>}
        {plan.labels.map((l) => (
          <div key={l.id} className="flex items-center gap-1">
            <ColorInput aria-label="Label colour" title="Label colour" value={l.color} onCommit={(color) => update(l.id, { color })} />
            <CommitInput aria-label="Label name" className="h-8 w-52" maxLength={40} autoFocus={fresh === l.id} onFocus={(e) => fresh === l.id && e.target.select()}
              value={l.name} onCommit={(name) => name.trim() && update(l.id, { name })} />
            <IconButton label="Delete label" onClick={() => remove(l)}><X /></IconButton>
          </div>
        ))}
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => {
          const r = dispatch('plan.labels.add', { planId, label: { name: 'New label' } });
          if (r.ok) setFresh(r.result.labelId);
        }}><Plus />Add label</Button>
      </div>
    </ListDialog>
  );
}

// A unit row's inline check (the reducers refuse the same with bad_unit): '' when fine.
const unitError = (units, id, name, days) => {
  const n = name.trim();
  if (!n || n.length > 12) return 'A unit needs a name of 1 to 12 characters.';
  if (n.toLowerCase() === 'd' || units.some((u) => u.id !== id && u.name.toLowerCase() === n.toLowerCase())) return `"${n}" is taken.`;
  return Number.isFinite(+days) && +days > 0 && String(days).trim() !== '' ? '' : 'One unit is a number of days above 0.';
};

/** A custom unit row: name and "= n d" commit together once both are valid (a new row: plan.units.add). */
function UnitRow({ planId, plan, unit, onAdded }) {
  const [name, setName] = useState(unit?.name ?? '');
  const [days, setDays] = useState(unit ? String(unit.daysPer) : '');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!unit) return;
    setName(unit.name);
    setDays(String(unit.daysPer));
  }, [unit?.name, unit?.daysPer]);
  const commit = () => {
    if (unit && name === unit.name && +days === unit.daysPer) return setError('');
    if (!unit && (!name.trim() || String(days).trim() === '')) return; // a new row: once both are filled in
    const message = unitError(plan.units, unit?.id, name, days);
    setError(message);
    if (message) return;
    if (unit) dispatch('plan.units.update', { planId, unitId: unit.id, patch: { name: name.trim(), daysPer: +days } });
    else if (dispatch('plan.units.add', { planId, unit: { name: name.trim(), daysPer: +days } }).ok) onAdded();
  };
  const remove = async () => {
    const used = plan.tickets.filter((t) => t.unit === unit.id && t.estimate != null);
    const eg = used[0] && `${used[0].estimate} ${unit.name} = ${+(used[0].estimate * unit.daysPer).toFixed(3)} d`;
    if (await confirmDialog({
      title: `Remove the unit "${unit.name}"?`,
      description: used.length ? `${plural(used.length, 'ticket')} estimated in ${unit.name} ${used.length === 1 ? 'is' : 'are'} converted to days (e.g. ${eg}).` : '',
      confirmText: 'Remove', destructive: true,
    })) dispatch('plan.units.remove', { planId, unitId: unit.id });
  };
  const keys = (e) => e.key === 'Enter' && commit();
  return (
    <>
      <div className="flex items-center gap-1" data-plan-unit={unit?.id ?? 'new'}>
        <Input aria-label="Unit name" placeholder="pt" maxLength={12} className="h-8 w-24" autoFocus={!unit} value={name}
          onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={keys} />
        <span className="text-muted-foreground">=</span>
        <Input aria-label="Days per unit" type="number" step="any" min={0} className="h-8 w-24" value={days}
          onChange={(e) => setDays(e.target.value)} onBlur={commit} onKeyDown={keys} />
        <span className="text-muted-foreground">d</span>
        <span className="flex-1" />
        {unit && (
          <>
            <Toggle size="sm" aria-label="Default unit" title="Default unit for new tickets" pressed={plan.estimateUnit === unit.id} className="h-8 px-2 text-xs"
              onPressedChange={(on) => on && dispatch('plan.update', { planId, patch: { estimateUnit: unit.id } })}>Default</Toggle>
            <IconButton label="Delete unit" onClick={remove}><X /></IconButton>
          </>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}

/** Units… (§6.2): the working day `d`, then the custom units (name, days per unit, default, delete); Add unit. */
function UnitsDialog({ planId, onClose }) {
  usePlans();
  const [adding, setAdding] = useState(false);
  const plan = planContext(planId)?.plan;
  if (!plan) return null;
  return (
    <ListDialog title="Estimate units" onClose={onClose} className="sm:max-w-[min(440px,92vw)]">
      <div className="grid gap-1">
        <div className="flex h-8 items-center gap-1">
          <span className="w-24 px-3">d</span><span className="text-muted-foreground">working day = 1 d</span>
          <span className="flex-1" />
          <Toggle size="sm" aria-label="Default unit" title="Default unit for new tickets" pressed={plan.estimateUnit === 'd'} className="h-8 px-2 text-xs"
            onPressedChange={(on) => on && dispatch('plan.update', { planId, patch: { estimateUnit: 'd' } })}>Default</Toggle>
          <span className="size-8" />
        </div>
        {plan.units.map((u) => <UnitRow key={u.id} planId={planId} plan={plan} unit={u} />)}
        {adding && <UnitRow planId={planId} plan={plan} onAdded={() => setAdding(false)} />}
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" disabled={adding} onClick={() => setAdding(true)}><Plus />Add unit</Button>
      </div>
      <p className="text-xs text-muted-foreground">Every unit says how many working days one unit is; sums and the schedule use days.</p>
    </ListDialog>
  );
}

const WEEKDAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];

/** A date box that commits a picked date, or on Enter or blur when changed (an empty value: null). */
function DateInput({ value, onCommit, ...props }) {
  const commit = (v) => (v || null) !== (value || null) && onCommit(v || null);
  return (
    <DateField defaultValue={value ?? ''} className="h-8 w-40 [color-scheme:dark]" {...props} onPick={commit} onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  );
}

/** Calendar… (§6.2): the working weekdays, the first day of week 1 (week numbers on the Gantt axis) and the holidays; every
 * change runs at once as its own command and undo entry (a holiday moved to another date: one entry). */
function CalendarDialog({ planId, onClose }) {
  usePlans();
  const [adding, setAdding] = useState(false);
  const plan = planContext(planId)?.plan;
  if (!plan) return null;
  const cal = plan.calendar;
  const setCal = (patch) => dispatch('plan.update', { planId, patch: { calendar: patch } });
  const move = (from, to) => (to ? dispatchAll(planId, [['plan.holidays.remove', { date: from }], ['plan.holidays.add', { date: to }]]) : dispatch('plan.holidays.remove', { planId, date: from }));
  return (
    <ListDialog title="Calendar" onClose={onClose} className="sm:max-w-[min(420px,92vw)]">
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">Working days</span>
        <div className="flex gap-1">
          {WEEKDAYS.map(([d, name]) => {
            const on = cal.workdays.includes(d);
            return (
              <Toggle key={d} size="sm" variant="outline" aria-label={name} pressed={on} disabled={on && cal.workdays.length === 1} className="h-8 px-2 text-xs"
                onPressedChange={(v) => setCal({ workdays: v ? [...cal.workdays, d].sort((a, b) => a - b) : cal.workdays.filter((x) => x !== d) })}>{name}</Toggle>
            );
          })}
        </div>
      </div>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">Week 1 starts on (week numbers on the Gantt axis count from it)</span>
        <div className="flex items-center gap-1">
          <DateInput aria-label="First day of week 1" calendar={cal} value={cal.weekOne} onCommit={(weekOne) => setCal({ weekOne })} />
          {cal.weekOne && <IconButton label="No week numbers" onClick={() => setCal({ weekOne: null })}><X /></IconButton>}
        </div>
      </div>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">Holidays (not working days)</span>
        {!cal.holidays.length && !adding && <p className="text-xs text-muted-foreground">None.</p>}
        {cal.holidays.map((h) => (
          <div key={h} className="flex items-center gap-1" data-plan-holiday={h}>
            <DateInput aria-label="Holiday" calendar={cal} value={h} onCommit={(to) => to !== h && !cal.holidays.includes(to) && move(h, to)} />
            <IconButton label="Remove holiday" onClick={() => dispatch('plan.holidays.remove', { planId, date: h })}><X /></IconButton>
          </div>
        ))}
        {adding && (
          <DateInput aria-label="New holiday" calendar={cal} autoFocus value={null} onCommit={(date) => {
            setAdding(false);
            if (date && !cal.holidays.includes(date)) dispatch('plan.holidays.add', { planId, date });
          }} />
        )}
        <div><Button type="button" variant="outline" size="sm" disabled={adding} onClick={() => setAdding(true)}><Plus />Add holiday</Button></div>
      </div>
      <p className="text-xs text-muted-foreground">Durations, dependencies and the critical path count working days only.</p>
    </ListDialog>
  );
}

/** The plan picker (Plans with no thread selected and no open draft's thread; Insert plan chart without a plan for the
 * draft's thread: `action` 'Insert', no Delete, and "Create a plan for this thread" when `createFor` names the thread):
 * every plan by thread, then the plans of threads no longer in the list. → the plan id, 'create', or null. */
function PlanPickDialog({ title = 'Plans', action = 'Open', createFor = null, onClose }) {
  usePlans();
  const threads = useStore((s) => s.settings?.threads) ?? [];
  const list = planList();
  const groups = [
    ...threads.map((t) => [threadLabel(t), list.filter((p) => p.threadUrl === t.url)]),
    ['Without a thread', list.filter((p) => !threads.some((t) => t.url === p.threadUrl))],
  ].filter(([, plans]) => plans.length);
  return (
    <ListDialog title={title} onClose={onClose} className="sm:max-w-[min(520px,92vw)]">
      {createFor && (
        <div><Button type="button" variant="outline" size="sm" onClick={() => onClose('create')}><Plus />Create a plan for this thread</Button></div>
      )}
      {!groups.length && !createFor && <p className="text-xs text-muted-foreground">No plans yet. Select a thread in the sidebar, then open Plans to create its plan.</p>}
      {groups.map(([heading, plans]) => (
        <div key={heading} className="grid gap-0.5">
          <div className="truncate text-xs text-muted-foreground">{heading}</div>
          {plans.map((p) => (
            <div key={p.id} className="flex items-center gap-1 rounded-md px-1 hover:bg-accent/60">
              <span className="min-w-0 flex-1 truncate">{p.title || p.threadUrl}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{plural(p.tickets.length, 'ticket')}</span>
              <Button type="button" variant="ghost" size="xs" onClick={() => onClose(p.id)}>{action}</Button>
              {action === 'Open' && <IconButton label="Delete plan..." onClick={() => deletePlan(p.id)}><X /></IconButton>}
            </div>
          ))}
        </div>
      ))}
    </ListDialog>
  );
}

/** A name (Rename plan, Save current view as) → the trimmed text, or null. */
function NameDialog({ title, value, okText, onClose }) {
  const [text, setText] = useState(value);
  return (
    <FormDialog title={title} okText={okText} validate={() => (text.trim() ? '' : 'Enter a name.')} result={() => text.trim()} onClose={onClose}>
      <Input className="h-8" autoFocus maxLength={120} value={text} aria-label="Name" onChange={(e) => setText(e.target.value)} />
    </FormDialog>
  );
}

export const PLAN_FORMS = {
  ticket: TicketDialog, planColumns: ColumnsDialog, planDeleteColumn: DeleteColumnDialog, planLabels: LabelsDialog, planUnits: UnitsDialog,
  planPick: PlanPickDialog, planName: NameDialog, planCalendar: CalendarDialog,
};

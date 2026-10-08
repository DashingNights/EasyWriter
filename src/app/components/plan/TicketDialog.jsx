import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, FileText, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { doneColumnOf, statusOf, unitOf } from '../../../plan/plan-model.mjs';
import { openInForum, refocusEditor } from '../../actions.js';
import { deleteTickets, dispatch, moveCards, planContext, usePlans } from '../../plans.js';
import { openDraftFromPlan, PRIORITIES } from './Card.jsx';
import { DateField } from '../DateField.jsx';
import { CommitInput } from './forms.jsx';

// The ticket dialog (Gantt plan §6.6). New ticket: every field and row kept here, OK = one plan.tickets.create. Edit: every
// field set or row change runs at once as its own command and undo entry; Delete (confirm) · Close.

const NONE = '-'; // Radix Select items need a non-empty value
const DEP_TYPES = ['FS', 'SS', 'FF', 'SF'];
const DEP_NAMES = { FS: 'Finish to start', SS: 'Start to start', FF: 'Finish to finish', SF: 'Start to finish' };
const WEB = /^https?:\/\/\S+$/;
let tmp = 0; // ids of the new ticket's rows (not stored)

const blank = (plan, init) => ({
  title: init.title ?? '', description: '', status: 'status' in init ? init.status : plan.columns[0].id, priority: 3, labels: [], estimate: null,
  unit: plan.estimateUnit, start: null, end: null, milestone: false, progress: 0, parent: init.parent ?? null, deps: [], checklist: [], draftId: init.draftId ?? null, urls: [],
});

const Field = ({ label, children, className }) => (
  <div className={`grid gap-1 ${className ?? ''}`}><Label className="text-xs text-muted-foreground">{label}</Label>{children}</div>
);

function Pick({ value, onChange, label, className = 'w-full', disabled, placeholder, children }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={className}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

const Row = ({ children }) => <div className="flex items-center gap-1">{children}</div>;
const IconButton = ({ label, children, ...props }) => (
  <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} {...props}>{children}</Button>
);

/** Start and end: sent as one field set once both are dates with end ≥ start, or both are empty. */
function Dates({ start, end, calendar, onCommit }) {
  const [s, setS] = useState(start ?? '');
  const [e, setE] = useState(end ?? '');
  useEffect(() => { setS(start ?? ''); setE(end ?? ''); }, [start, end]);
  const error = !!s !== !!e ? 'Set both dates, or neither.' : s && e < s ? 'The end is before the start.' : '';
  const change = (ns, ne) => {
    setS(ns);
    setE(ne);
    // Typing a year steps through 0002, 0020, 0202: only a four-digit year is sent (one command, not one per digit).
    const ok = !!ns === !!ne && !(ns && ne < ns) && [ns, ne].every((d) => !d || d >= '1000');
    if (ok && (ns !== (start ?? '') || ne !== (end ?? ''))) onCommit({ start: ns || null, end: ne || null });
  };
  return (
    <>
      <Row>
        <DateField aria-label="Start" className="h-8 w-36" calendar={calendar} value={s} onChange={(ev) => change(ev.target.value, e)} onPick={(v) => change(v, e)} />
        <span className="text-muted-foreground">to</span>
        <DateField aria-label="End" className="h-8 w-36" calendar={calendar} value={e} onChange={(ev) => change(s, ev.target.value)} onPick={(v) => change(s, v)} />
      </Row>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </>
  );
}

/** "Add …": a row that becomes an entry once it has text (Enter or blur); Enter keeps a new empty row open. */
function NewRow({ placeholder, label, valid = (v) => !!v.trim(), onAdd, onDone }) {
  const [text, setText] = useState('');
  const add = (keepOpen) => {
    if (valid(text)) onAdd(text.trim());
    setText('');
    if (!keepOpen || !valid(text)) onDone();
  };
  return (
    <Input autoFocus aria-label={label} placeholder={placeholder} className="h-8 flex-1" value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => add(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') add(true);
        if (e.key === 'Escape' && text) { e.preventDefault(); setText(''); }
      }} />
  );
}

export function TicketDialog({ planId, ticketId, init = {}, onClose }) {
  usePlans();
  const ctx = planContext(planId);
  const live = ticketId ? ctx?.plan.tickets.find((x) => x.id === ticketId) : null;
  const [local, setLocal] = useState(() => (ctx ? blank(ctx.plan, init) : null));
  const [adding, setAdding] = useState(null); // 'dep' | 'check' | 'url' | 'label': its new row is open
  const [depError, setDepError] = useState('');
  const [error, setError] = useState('');
  const isNew = !ticketId;
  const gone = !ctx || (!isNew && !live);
  useEffect(() => { if (gone) onClose(null); }, [gone]); // deleted elsewhere (an undo)
  if (gone) return null;
  const { plan } = ctx;
  const t = isNew ? local : live;
  const ticketIds = [ticketId];
  const set = (patch) => (isNew ? setLocal((l) => ({ ...l, ...patch })) : dispatch('plan.tickets.update', { planId, ticketIds, patch }));
  const status = isNew ? t.status : statusOf(t, ctx);
  const done = status === doneColumnOf(plan);
  const linkedTag = !isNew && t.draftId && ctx.tags.find((x) => x.id === ctx.draftTags[t.draftId]);
  const unit = unitOf(plan, t.unit);
  const num = (id) => plan.tickets.find((x) => x.id === id);
  // Parent candidates: every ticket but this one and those below it.
  const below = new Set(isNew ? [] : [ticketId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of plan.tickets) {
      if (x.parent && below.has(x.parent) && !below.has(x.id)) {
        below.add(x.id);
        grew = true;
      }
    }
  }
  const linkedElsewhere = new Set(plan.tickets.filter((x) => x.draftId && x.id !== ticketId).map((x) => x.draftId));
  const drafts = ctx.drafts.filter((d) => !linkedElsewhere.has(d.id));

  // --- rows: local in a new ticket, one command each otherwise ---
  const toggleLabel = (id, on) => (isNew
    ? set({ labels: on ? [...t.labels, id] : t.labels.filter((x) => x !== id) })
    : dispatch(on ? 'plan.tickets.labels.add' : 'plan.tickets.labels.remove', { planId, ticketIds, labelId: id }));
  const newLabel = (name) => {
    const r = dispatch('plan.labels.add', { planId, label: { name } });
    if (r.ok) toggleLabel(r.result.labelId, true);
  };
  const addDep = (on) => {
    setDepError('');
    if (isNew) return set({ deps: [...t.deps, { on, type: 'FS', lag: 0 }] });
    const r = dispatch('plan.deps.add', { planId, from: on, to: ticketId }, { quiet: true });
    if (!r.ok) setDepError(r.error.message);
  };
  const setDep = (on, patch) => (isNew
    ? set({ deps: t.deps.map((d) => (d.on === on ? { ...d, ...patch } : d)) })
    : dispatch('plan.deps.update', { planId, from: on, to: ticketId, patch }));
  const removeDep = (on) => (isNew ? set({ deps: t.deps.filter((d) => d.on !== on) }) : dispatch('plan.deps.remove', { planId, from: on, to: ticketId }));
  const addCheck = (text) => (isNew
    ? set({ checklist: [...t.checklist, { id: `n${++tmp}`, text, done: false }] })
    : dispatch('plan.checklist.add', { planId, ticketId, item: { text } }));
  const setCheck = (itemId, patch) => (isNew
    ? set({ checklist: t.checklist.map((c) => (c.id === itemId ? { ...c, ...patch } : c)) })
    : dispatch('plan.checklist.update', { planId, ticketId, itemId, patch }));
  const moveCheck = (i, by) => {
    if (!isNew) {
      const other = t.checklist[i + by].id;
      return dispatch('plan.checklist.move', { planId, ticketId, itemId: t.checklist[i].id, ...(by < 0 ? { beforeId: other } : { afterId: other }) });
    }
    const list = [...t.checklist];
    [list[i], list[i + by]] = [list[i + by], list[i]];
    return set({ checklist: list });
  };
  const removeCheck = (itemId) => (isNew ? set({ checklist: t.checklist.filter((c) => c.id !== itemId) }) : dispatch('plan.checklist.remove', { planId, ticketId, itemId }));
  const addUrl = (url) => (isNew ? set({ urls: [...t.urls, { id: `n${++tmp}`, url, title: '' }] }) : dispatch('plan.urls.add', { planId, ticketId, url: { url } }));
  const setUrl = (urlId, patch) => (isNew
    ? set({ urls: t.urls.map((u) => (u.id === urlId ? { ...u, ...patch } : u)) })
    : dispatch('plan.urls.update', { planId, ticketId, urlId, patch }));
  const removeUrl = (urlId) => (isNew ? set({ urls: t.urls.filter((u) => u.id !== urlId) }) : dispatch('plan.urls.remove', { planId, ticketId, urlId }));
  const openUrl = (url) => (/^https:\/\/daf\.staffs\.ac\.uk\//.test(url) ? openInForum(url) : window.open(url));
  const setDraft = (draftId) => {
    if (isNew) return set({ draftId });
    const r = dispatch('plan.tickets.update', { planId, ticketIds, patch: { draftId } });
    const moved = r.ok && r.result.status !== undefined && plan.columns.find((c) => c.id === r.result.status);
    if (moved) toast(`Moved to ${moved.name}: linked drafts follow their status tag.`);
  };

  const validate = () => {
    if (!t.title.trim()) return 'Enter a title.';
    if (!!t.start !== !!t.end) return 'Set both dates, or neither.';
    if (t.start && t.end < t.start) return 'The end is before the start.';
    return '';
  };
  const ok = () => {
    const message = validate();
    if (message) return setError(message);
    const { checklist, urls, ...rest } = t;
    onClose({ ...rest, title: t.title.trim(), checklist: checklist.map(({ text, done: d }) => ({ text, done: d })), urls: urls.map(({ url, title }) => ({ url, ...(title && { title }) })) });
  };

  const text = (key, props) => (isNew
    ? <Input {...props} value={t[key]} onChange={(e) => set({ [key]: e.target.value })} />
    : <CommitInput {...props} value={t[key]} onCommit={(v) => (key !== 'title' || v.trim()) && set({ [key]: v })} />);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-3 text-sm sm:max-w-[min(860px,94vw)] *:data-[slot=dialog-close]:top-3 *:data-[slot=dialog-close]:right-3"
        aria-describedby={undefined} onCloseAutoFocus={refocusEditor} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle className="text-base">{isNew ? 'New ticket' : `#${t.num}`}</DialogTitle></DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <Field label="Title">
              {text('title', { 'aria-label': 'Title', autoFocus: isNew, maxLength: 200, className: 'h-8', onKeyDown: isNew ? (e) => e.key === 'Enter' && ok() : undefined })}
            </Field>
            <Field label="Description">
              {isNew
                ? <Textarea aria-label="Description" className="max-h-60 min-h-16" value={t.description} onChange={(e) => set({ description: e.target.value })} />
                : <DescriptionBox value={t.description} onCommit={(description) => set({ description })} />}
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Status">
                <Pick label="Status" value={status ?? NONE} disabled={!isNew && !!t.draftId}
                  onChange={(v) => (isNew ? set({ status: v === NONE ? null : v }) : moveCards(planId, ticketIds, v === NONE ? null : v))}>
                  {plan.columns.map((c) => <SelectItem key={c.id} value={c.id}><span className="size-2 rounded-full" style={{ background: c.color }} />{c.name}</SelectItem>)}
                  <SelectItem value={NONE}>No status</SelectItem>
                </Pick>
              </Field>
              <Field label="Priority">
                <Pick label="Priority" value={String(t.priority)} onChange={(v) => set({ priority: +v })}>
                  {PRIORITIES.map(([v, name, Icon]) => <SelectItem key={v} value={String(v)}>{Icon ? <Icon /> : null}{name}</SelectItem>)}
                </Pick>
              </Field>
            </div>
            {!isNew && t.draftId && (
              <p className="text-xs text-muted-foreground">Status follows the linked draft's tag{linkedTag ? ` "${linkedTag.name}"` : ' (none)'}; move the card instead.</p>
            )}
            <Field label="Labels">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {plan.labels.map((l) => (
                  <label key={l.id} className="flex items-center gap-1.5 text-xs">
                    <Checkbox checked={t.labels.includes(l.id)} onCheckedChange={(v) => toggleLabel(l.id, v === true)} />
                    <span className="size-2 rounded-full" style={{ background: l.color }} />{l.name}
                  </label>
                ))}
                {adding === 'label'
                  ? <NewRow label="New label name" placeholder="Label name" onAdd={newLabel} onDone={() => setAdding(null)} />
                  : <Button type="button" variant="ghost" size="xs" onClick={() => setAdding('label')}><Plus />New label...</Button>}
              </div>
            </Field>
            <Field label="Estimate">
              <Row>
                <CommitInput type="number" min={0} step="any" aria-label="Estimate" className="h-8 w-24" value={t.estimate == null ? '' : String(t.estimate)}
                  onCommit={(v) => set({ estimate: v.trim() === '' ? null : Math.max(0, +v || 0), unit: t.unit })} />
                <Pick label="Unit" className="w-28" value={unit.id} onChange={(v) => set({ estimate: t.estimate, unit: v })}>
                  <SelectItem value="d">d (day)</SelectItem>
                  {plan.units.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
                </Pick>
                {unit.id !== 'd' && t.estimate != null && <span className="text-xs text-muted-foreground">= {+(t.estimate * unit.daysPer).toFixed(3)} d</span>}
              </Row>
            </Field>
            <Field label="Dates">
              {isNew
                ? <Row>
                    <DateField aria-label="Start" className="h-8 w-36" calendar={plan.calendar} value={t.start ?? ''} onChange={(e) => set({ start: e.target.value || null })} onPick={(start) => set({ start })} />
                    <span className="text-muted-foreground">to</span>
                    <DateField aria-label="End" className="h-8 w-36" calendar={plan.calendar} value={t.end ?? ''} onChange={(e) => set({ end: e.target.value || null })} onPick={(end) => set({ end })} />
                  </Row>
                : <Dates start={t.start} end={t.end} calendar={plan.calendar} onCommit={set} />}
            </Field>
            <Row>
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox checked={t.milestone} onCheckedChange={(v) => set({ milestone: v === true })} />Milestone (ends on its start day)
              </label>
            </Row>
            <Field label={`Progress ${t.progress} %${done ? ' (done)' : ''}`}>
              <ProgressSlider value={t.progress} disabled={done} onCommit={(progress) => set({ progress })} />
            </Field>
          </div>

          <div className="grid content-start gap-2">
            <Field label="Parent">
              <Pick label="Parent" value={t.parent ?? NONE} onChange={(v) => set({ parent: v === NONE ? null : v })}>
                <SelectItem value={NONE}>None (top level)</SelectItem>
                {plan.tickets.filter((x) => !below.has(x.id)).map((x) => <SelectItem key={x.id} value={x.id}>#{x.num} {x.title}</SelectItem>)}
              </Pick>
            </Field>
            <Field label="Draft">
              <Row>
                <Pick label="Linked draft" value={t.draftId ?? NONE} onChange={(v) => setDraft(v === NONE ? null : v)}>
                  <SelectItem value={NONE}>No draft</SelectItem>
                  {drafts.map((d) => <SelectItem key={d.id} value={d.id}>{d.title || 'Untitled draft'}</SelectItem>)}
                </Pick>
                {!isNew && t.draftId && <IconButton label="Open draft" onClick={() => { onClose(null); openDraftFromPlan(t.draftId); }}><FileText /></IconButton>}
              </Row>
              <p className="text-xs text-muted-foreground">A linked draft shares one status with the ticket: its tag decides the column.</p>
            </Field>
            <Field label="Dependencies (this ticket waits for)">
              {t.deps.map((d) => (
                <Row key={d.on}>
                  <span className="min-w-0 flex-1 truncate">#{num(d.on)?.num} {num(d.on)?.title}</span>
                  <Pick label="Dependency type" className="w-36" value={d.type} onChange={(type) => setDep(d.on, { type })}>
                    {DEP_TYPES.map((x) => <SelectItem key={x} value={x}>{DEP_NAMES[x]}</SelectItem>)}
                  </Pick>
                  <CommitInput type="number" step={1} aria-label="Lag (working days)" title="Lag in working days (negative: lead)" className="h-8 w-16"
                    value={String(d.lag)} onCommit={(v) => setDep(d.on, { lag: Math.round(+v) || 0 })} />
                  <IconButton label="Remove dependency" onClick={() => removeDep(d.on)}><X /></IconButton>
                </Row>
              ))}
              {adding === 'dep' ? (
                <Pick label="Predecessor" value="" placeholder="The ticket it waits for..." onChange={(v) => { addDep(v); setAdding(null); }}>
                  {plan.tickets.filter((x) => x.id !== ticketId && !t.deps.some((d) => d.on === x.id)).map((x) => <SelectItem key={x.id} value={x.id}>#{x.num} {x.title}</SelectItem>)}
                </Pick>
              ) : (
                <div><Button type="button" variant="ghost" size="xs" disabled={plan.tickets.length < (isNew ? 1 : 2)} onClick={() => setAdding('dep')}><Plus />Add dependency</Button></div>
              )}
              {depError && <p className="text-xs text-destructive">{depError}</p>}
            </Field>
            <Field label="Checklist">
              {t.checklist.map((c, i) => (
                <Row key={c.id}>
                  <Checkbox aria-label="Done" checked={c.done} onCheckedChange={(v) => setCheck(c.id, { done: v === true })} />
                  <CommitInput aria-label="Checklist item" maxLength={200} className="h-8 flex-1" value={c.text} onCommit={(v) => v.trim() && setCheck(c.id, { text: v })} />
                  <IconButton label="Move up" disabled={!i} onClick={() => moveCheck(i, -1)}><ArrowUp /></IconButton>
                  <IconButton label="Move down" disabled={i === t.checklist.length - 1} onClick={() => moveCheck(i, 1)}><ArrowDown /></IconButton>
                  <IconButton label="Remove item" onClick={() => removeCheck(c.id)}><X /></IconButton>
                </Row>
              ))}
              {adding === 'check'
                ? <Row><NewRow label="New checklist item" placeholder="Item, Enter" onAdd={addCheck} onDone={() => setAdding(null)} /></Row>
                : <div><Button type="button" variant="ghost" size="xs" onClick={() => setAdding('check')}><Plus />Add item</Button></div>}
            </Field>
            <Field label="Links">
              {t.urls.map((u) => (
                <Row key={u.id}>
                  <CommitInput aria-label="Link URL" className="h-8 flex-1" value={u.url} onCommit={(v) => WEB.test(v.trim()) && setUrl(u.id, { url: v.trim() })} />
                  <CommitInput aria-label="Link title" placeholder="Title" maxLength={80} className="h-8 w-32" value={u.title ?? ''} onCommit={(v) => setUrl(u.id, { title: v })} />
                  <IconButton label="Open link" onClick={() => openUrl(u.url)}><ExternalLink /></IconButton>
                  <IconButton label="Remove link" onClick={() => removeUrl(u.id)}><X /></IconButton>
                </Row>
              ))}
              {adding === 'url'
                ? <Row><NewRow label="New link URL" placeholder="https://..." valid={(v) => WEB.test(v.trim())} onAdd={addUrl} onDone={() => setAdding(null)} /></Row>
                : <div><Button type="button" variant="ghost" size="xs" onClick={() => setAdding('url')}><Plus />Add link</Button></div>}
            </Field>
            {!isNew && t.baseline && <p className="text-xs text-muted-foreground">Baseline {t.baseline.start} to {t.baseline.end}</p>}
          </div>
        </div>
        {error && <p className="text-destructive">{error}</p>}
        <DialogFooter className="items-center">
          {!isNew && (
            <p className="mr-auto text-xs text-muted-foreground">
              Created {new Date(t.created).toLocaleString()}, updated {new Date(t.updated).toLocaleString()}
              {t.completedAt ? `, done ${new Date(t.completedAt).toLocaleString()}` : ''}
            </p>
          )}
          {isNew ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => onClose(null)}>Cancel</Button>
              <Button type="button" size="sm" onClick={ok}>OK</Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" onClick={async () => (await deleteTickets(planId, ticketIds)) && onClose(null)}>Delete...</Button>
              <Button type="button" size="sm" onClick={() => onClose(null)}>Close</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The description of an existing ticket: sent on blur. */
function DescriptionBox({ value, onCommit }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <Textarea aria-label="Description" className="max-h-60 min-h-16" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} />;
}

/** Progress in 5 % steps: shown while dragged, sent once on release. */
function ProgressSlider({ value, disabled, onCommit }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <Slider aria-label="Progress" min={0} max={100} step={5} disabled={disabled} value={[v]} onValueChange={([x]) => setV(x)} onValueCommit={([x]) => x !== value && onCommit(x)} />;
}

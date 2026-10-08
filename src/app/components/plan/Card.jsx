import { useState } from 'react';
import { cn } from 'cn';
import { Ban, ChevronDown, ChevronsUp, ChevronUp, CircleCheck, Ellipsis, FileText, Flame, Milestone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fmt, toDay } from '../../../plan/dates.mjs';
import { blockers, doneColumnOf, unitOf } from '../../../plan/plan-model.mjs';
import { openDraft, refocusEditor } from '../../actions.js';
import { deleteTickets, dispatch, editTicket, moveCards, newTicket } from '../../plans.js';
import { closeWorkspace } from '../../views.js';
import { Tip } from '../Tip.jsx';

const NO_STATUS = '-'; // radio value of "No status" (Radix needs a non-empty value)
const stop = (e) => e.stopPropagation();
export const PRIORITIES = [
  [0, 'No priority', null], [1, 'Urgent', Flame], [2, 'High', ChevronsUp], [3, 'Medium', ChevronUp], [4, 'Low', ChevronDown],
];

/** Opening a draft from a card: back to the editor first (Gantt Q1: no split view). */
export async function openDraftFromPlan(id) {
  await closeWorkspace();
  await openDraft(id);
}

const Dot = ({ color, className }) => (
  <span className={cn('size-2 shrink-0 rounded-full', !color && 'border border-muted-foreground/60', className)} style={color ? { background: color } : undefined} />
);

/** The card's menu (… button and right-click): status, priority, labels, milestone, draft, delete. Draft cards: status,
 * Open draft, Convert to ticket. */
function CardMenu({ card, ctx, ids, open, setOpen }) {
  const { plan } = ctx;
  const planId = plan.id;
  const t = card.ticket;
  const move = (v) => moveCards(planId, ids, v === NO_STATUS ? null : v);
  const tickets = ids.filter((id) => plan.tickets.some((x) => x.id === id));
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Card actions" onClick={stop}
          className="invisible absolute top-0.5 right-0.5 bg-card group-hover:visible data-[state=open]:visible"><Ellipsis /></Button>
      </DropdownMenuTrigger>
      {/* React events bubble out of the portal to the card: a menu click must not open the ticket or start a drag. */}
      <DropdownMenuContent align="end" onCloseAutoFocus={refocusEditor} onClick={stop} onPointerDown={stop}>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={card.status ?? NO_STATUS} onValueChange={move}>
              {plan.columns.map((c) => <DropdownMenuRadioItem key={c.id} value={c.id}><Dot color={c.color} />{c.name}</DropdownMenuRadioItem>)}
              <DropdownMenuRadioItem value={NO_STATUS}><Dot />No status</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {t && (
          <>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={String(t.priority)} onValueChange={(v) => dispatch('plan.tickets.update', { planId, ticketIds: tickets, patch: { priority: +v } })}>
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
                        onCheckedChange={() => dispatch(on ? 'plan.tickets.labels.remove' : 'plan.tickets.labels.add', { planId, ticketIds: tickets, labelId: l.id })}>
                        <Dot color={l.color} />{l.name}
                      </DropdownMenuCheckboxItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuCheckboxItem checked={t.milestone} onCheckedChange={(v) => dispatch('plan.tickets.update', { planId, ticketIds: tickets, patch: { milestone: v } })}>
              <Milestone />Milestone
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {t.draftId
              ? <DropdownMenuItem onSelect={() => openDraftFromPlan(t.draftId)}><FileText />Open draft</DropdownMenuItem>
              : <DropdownMenuItem onSelect={() => editTicket(planId, t.id)}><FileText />Link draft...</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onSelect={() => deleteTickets(planId, tickets)}>Delete{tickets.length > 1 ? ` ${tickets.length} tickets` : ''}...</DropdownMenuItem>
          </>
        )}
        {!t && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openDraftFromPlan(card.id)}><FileText />Open draft</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => convertDraft(planId, card)}>Convert to ticket</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Convert to ticket: the new ticket dialog with the draft's title, column and link. */
export const convertDraft = (planId, card) => newTicket(planId, { title: card.title || 'Untitled draft', status: card.status, draftId: card.id });

/** One Board card (Gantt plan §6.3): a ticket with the chips of `fields`, or a draft card. `ids`: the cards its menu acts on
 * (the selection when it is in it). */
export function Card({ card, ctx, fields, ids, selected, focused, dragging, line, onPointerDown, onClick }) {
  const [menu, setMenu] = useState(false);
  const { plan } = ctx;
  const t = card.ticket;
  const has = (f) => fields.includes(f);
  const draftId = t ? t.draftId : card.id;
  const draft = draftId && ctx.drafts.find((d) => d.id === draftId);
  // The tag that put a linked card in "No status" (no column follows it).
  const tag = card.status === null && draftId && ctx.tags.find((x) => x.id === ctx.draftTags[draftId]);
  const done = card.status === doneColumnOf(plan);
  const blocked = t && has('blocked') && !done ? blockers(ctx, t.id) : [];
  const [, priorityName, PriorityIcon] = (t && has('priority') && PRIORITIES[t.priority]) || [];
  const unit = t && unitOf(plan, t.unit);
  const checks = t?.checklist.length ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}` : null;
  return (
    <div data-card={card.id} data-column={card.status ?? ''} role="button" aria-selected={selected}
      onPointerDown={onPointerDown} onClick={onClick} onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}
      className={cn('group relative cursor-pointer rounded-md border bg-card p-2 text-xs shadow-xs select-none hover:border-ring/60',
        selected && 'border-primary ring-1 ring-primary', focused && !selected && 'border-ring', dragging && 'opacity-40',
        line && 'before:absolute before:inset-x-1 before:-top-1.5 before:h-0.5 before:rounded-full before:bg-primary')}>
      <div className="line-clamp-2 pr-5 text-sm leading-snug break-words">
        {t?.milestone && <Milestone className="mr-1 inline size-3.5 align-[-2px] text-muted-foreground" />}
        {card.title || 'Untitled'}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground empty:hidden">
        {t && has('num') && <span className="tabular-nums">#{t.num}</span>}
        {!t && <><FileText className="size-3.5" /><Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">draft</Badge></>}
        {PriorityIcon && <Tip title={`${priorityName} priority`}><PriorityIcon className={cn('size-3.5', t.priority === 1 && 'text-destructive')} aria-label={priorityName} /></Tip>}
        {t && has('labels') && t.labels.map((id) => plan.labels.find((l) => l.id === id)).filter(Boolean).map((l) => (
          <span key={l.id} className="rounded px-1 text-[10px] leading-4" style={{ background: `${l.color}33`, color: l.color }}>{l.name}</span>
        ))}
        {t?.end && has('due') && (
          <span className={cn('tabular-nums', !done && t.end < ctx.today && 'text-destructive', !done && t.end === ctx.today && 'text-amber-400')}>
            {fmt(toDay(t.end), 'd MMM')}
          </span>
        )}
        {checks && has('checklist') && <span className="tabular-nums">{checks}</span>}
        {t?.estimate != null && has('estimate') && (
          <Tip title={unit.id === 'd' ? 'Estimate in working days' : `= ${+(t.estimate * unit.daysPer).toFixed(2)} d`}><span className="tabular-nums">{t.estimate} {unit.name}</span></Tip>
        )}
        {blocked.length > 0 && (
          <Tip title={`Blocked by ${blocked.map((b) => `#${b.num} ${b.title}`).join(', ')}`}><Ban className="size-3.5 text-orange-400" aria-label="Blocked" /></Tip>
        )}
        {t && draft && has('draft') && (
          <button type="button" className="flex min-w-0 items-center gap-0.5 hover:text-foreground" title={`Open the draft "${draft.title}"`}
            onClick={(e) => { e.stopPropagation(); openDraftFromPlan(draft.id); }}>
            <FileText className="size-3.5 shrink-0" /><span className="max-w-32 truncate">{draft.title || 'Untitled draft'}</span>
          </button>
        )}
        {card.pushedAt != null && has('pushed') && <Tip title="Pushed to the forum"><CircleCheck className="size-3.5 text-green-500" aria-label="Pushed" /></Tip>}
        {tag && (
          <Tip title={`Its draft's tag "${tag.name}" is followed by no column`}>
            <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px] text-muted-foreground"><Dot color={tag.color} className="size-1.5" />{tag.name}</Badge>
          </Tip>
        )}
      </div>
      {!t && (
        <Button variant="outline" size="xs" className="invisible absolute right-1 bottom-1 h-5 bg-card text-[11px] group-hover:visible"
          onClick={(e) => { e.stopPropagation(); convertDraft(plan.id, card); }}>Convert to ticket</Button>
      )}
      <CardMenu card={card} ctx={ctx} ids={ids} open={menu} setOpen={setMenu} />
    </div>
  );
}

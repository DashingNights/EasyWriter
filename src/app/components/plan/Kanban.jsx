import { useEffect, useRef, useState } from 'react';
import { cn } from 'cn';
import { CircleCheck, Ellipsis, Plus, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { canDrop, cards as cardsOf, columnsOf, doneColumnOf, OPTION_DEFAULTS, PLAN_GATES, wipState } from '../../../plan/plan-model.mjs';
import { refocusEditor } from '../../actions.js';
import { deleteColumn, deleteTickets, dispatch, editColumns, editTicket, moveCards } from '../../plans.js';
import { keyIs, withKey } from '../../keybinds.js';
import { getState, setState, useStore } from '../../store.js';
import { backgroundClick } from '../../viewport.js';
import { InlineInput } from '../InlineInput.jsx';
import { Tip } from '../Tip.jsx';
import { keepFocus } from '../Toolbar.jsx';
import { Card, convertDraft } from './Card.jsx';
import { startDrag } from './drag.js';

const root = () => document.getElementById('workspace-root');
const typing = (e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable;
const ui = (patch) => setState({ planUi: { ...getState().planUi, ...patch } });
/** The workspace's card fields: the chart defaults plus the estimate. */
const FIELDS = [...OPTION_DEFAULTS.fields, 'estimate'];

/** Quick add at the top of a column: Enter adds a ticket and keeps the box open; a multi-line paste adds one per line;
 * Escape (or leaving it empty) closes it. */
function QuickAdd({ add, onClose }) {
  const [value, setValue] = useState('');
  return (
    <Input autoFocus value={value} placeholder="Ticket title, Enter" aria-label="New ticket title" className="h-7 shrink-0 bg-card text-xs md:text-xs"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => !value.trim() && onClose()}
      onPaste={(e) => {
        const lines = e.clipboardData.getData('text').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length < 2) return;
        e.preventDefault();
        lines.forEach((l) => add(l));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) {
          add(value.trim());
          setValue('');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          root()?.focus();
        }
      }} />
  );
}

function ColumnMenu({ plan, col, index, onRename }) {
  const planId = plan.id;
  const cols = plan.columns;
  const move = (args) => dispatch('plan.columns.move', { planId, columnId: col.id, ...args });
  const rename = useRef(false); // Rename starts once the menu has closed (its focus return would end the edit)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`Column ${col.name} actions`} onMouseDown={keepFocus}><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => {
        if (!rename.current) return refocusEditor(e);
        e.preventDefault();
        rename.current = false;
        onRename();
      }}>
        <DropdownMenuItem onSelect={() => { rename.current = true; }}>Rename</DropdownMenuItem>
        <DropdownMenuItem disabled={!index} onSelect={() => move({ beforeId: cols[index - 1].id })}>Move left</DropdownMenuItem>
        <DropdownMenuItem disabled={index === cols.length - 1} onSelect={() => move({ afterId: cols[index + 1].id })}>Move right</DropdownMenuItem>
        <DropdownMenuItem disabled={col.done} onSelect={() => dispatch('plan.update', { planId, patch: { doneColumn: col.id } })}>Set as done column</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => editColumns(planId)}>Edit columns...</DropdownMenuItem>
        {PLAN_GATES['plan.otherColumn'].test(plan) && (
          <DropdownMenuItem variant="destructive" onSelect={() => deleteColumn(planId, col.id)}>Delete column...</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Board tab (Gantt plan §6.3): the plan's columns (and "No status" while it has cards) with their cards. Click opens a
 * ticket (and selects it), Ctrl+click toggles the selection, Shift+click selects a range in the column; dragging moves the
 * selection; keys as §6.7. */
export function Kanban({ ctx, options }) {
  const { plan } = ctx;
  const planId = plan.id;
  const { selection, focusId } = useStore((s) => s.planUi);
  const [drag, setDrag] = useState(null); // {ids, target} while cards are dragged
  const [adding, setAdding] = useState(undefined); // the column (id, null: No status) whose quick add is open
  const [renaming, setRenaming] = useState(null); // the column whose name is being edited
  const strip = useRef(null);
  const cols = columnsOf(ctx, options);
  const all = cardsOf(ctx, options);
  const wip = wipState(ctx);
  const done = doneColumnOf(plan);
  const byCol = new Map(cols.map((c) => [c.id, all.filter((x) => x.status === c.id)]));
  const ordered = cols.flatMap((c) => byCol.get(c.id));
  const cardOf = (id) => all.find((c) => c.id === id);
  const idsFor = (id) => (selection.includes(id) ? ordered.filter((c) => selection.includes(c.id)).map((c) => c.id) : [id]);
  const linkedIn = (ids) => ids.map(cardOf).filter((c) => c && (c.kind === 'draft' || c.ticket.draftId));
  const unmapped = (colId, ids) => linkedIn(ids).some((c) => canDrop(ctx, c, colId) !== true);

  // Moves `ids` to `column`: before the card `beforeId` (a ticket), else after the column's last ticket.
  const moveTo = (ids, column, beforeId = null) => {
    const rest = (byCol.get(column) ?? []).filter((c) => !ids.includes(c.id));
    const before = rest.find((c) => c.id === beforeId)?.kind === 'ticket' ? beforeId : null;
    const here = byCol.get(column) ?? [];
    const at = here.findIndex((c) => ids.includes(c.id));
    const block = here.slice(at, at + ids.length).map((c) => c.id);
    if (at >= 0 && ids.every((id, i) => block[i] === id) && (here[at + ids.length]?.id ?? null) === beforeId) return; // dropped in place
    return moveCards(planId, ids, column, before ? { beforeId: before } : { afterId: rest.filter((c) => c.kind === 'ticket').at(-1)?.id });
  };

  const click = (e, card) => {
    const cur = getState().planUi;
    if (e.ctrlKey || e.metaKey) {
      ui({ selection: cur.selection.includes(card.id) ? cur.selection.filter((x) => x !== card.id) : [...cur.selection, card.id], focusId: card.id });
    } else if (e.shiftKey && cur.focusId && cardOf(cur.focusId)?.status === card.status) {
      const list = byCol.get(card.status).map((c) => c.id);
      const [a, b] = [list.indexOf(cur.focusId), list.indexOf(card.id)].sort((x, y) => x - y);
      ui({ selection: list.slice(a, b + 1) });
    } else {
      ui({ selection: [card.id], focusId: card.id });
      if (card.kind === 'ticket') editTicket(planId, card.id);
    }
  };

  const pointerDown = (e, card) => startDrag(e, {
    ids: idsFor(card.id),
    scroller: strip.current,
    onMove: (target) => setDrag({ ids: idsFor(card.id), target }),
    onDrop: (target) => {
      const ids = idsFor(card.id);
      setDrag(null);
      if (target) moveTo(ids, target.column, target.beforeId);
    },
  });

  const add = (column, title) => {
    const first = byCol.get(column)?.find((c) => c.kind === 'ticket');
    dispatch('plan.tickets.create', { planId, ticket: { title, status: column }, ...(first && { beforeId: first.id }) });
  };

  const addColumn = () => {
    const r = dispatch('plan.columns.add', { planId, column: { name: 'New column' } });
    if (r.ok) setRenaming(r.result.columnId);
  };

  // Board keys (§6.7) on #workspace-root; typing in an input, a menu or a dialog is not here.
  const keys = useRef(null);
  keys.current = (e) => {
    if (e.defaultPrevented || typing(e) || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const focused = cardOf(focusId) ?? null;
    const colIx = focused ? cols.findIndex((c) => c.id === focused.status) : -1;
    const sel = selection.length ? ordered.filter((c) => selection.includes(c.id)).map((c) => c.id) : focused ? [focused.id] : [];
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const go = (fn) => {
      e.preventDefault();
      fn();
    };
    if (key === 'Escape' && selection.length) go(() => ui({ selection: [] }));
    else if (ctrl && key === 'a') go(() => ui({ selection: ordered.map((c) => c.id) }));
    else if (ctrl) return;
    else if (keyIs('plan.newTicket', e)) go(() => setAdding(focused ? focused.status : plan.columns[0].id)); // §7k
    else if ((key === 'Delete' || key === 'Backspace') && sel.length) go(() => deleteTickets(planId, sel));
    else if (key === 'Enter' && focused) go(() => (focused.kind === 'ticket' ? editTicket(planId, focused.id) : convertDraft(planId, focused)));
    else if (keyIs('plan.convert', e) && focused?.kind === 'draft') go(() => convertDraft(planId, focused));
    else if (keyIs('plan.done', e) && sel.length) {
      const prev = plan.columns[plan.columns.findIndex((c) => c.id === done) - 1]?.id ?? null;
      go(() => moveTo(sel, sel.every((id) => cardOf(id)?.status === done) ? prev : done));
    } else if (key.startsWith('Arrow')) {
      e.preventDefault();
      if (!focused) return void (ordered[0] && ui({ focusId: ordered[0].id, selection: [] }));
      const list = byCol.get(focused.status);
      const at = list.findIndex((c) => c.id === focused.id);
      const side = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
      if (e.shiftKey && side) {
        const to = cols[colIx + side];
        if (to) moveTo(sel, to.id);
      } else if (e.shiftKey) {
        // Reorder the focused ticket within its column (tickets only; draft cards follow them).
        const other = list[at + (key === 'ArrowUp' ? -1 : 1)];
        if (focused.kind === 'ticket' && other?.kind === 'ticket') {
          dispatch('plan.tickets.reorder', { planId, ticketIds: [focused.id], ...(key === 'ArrowUp' ? { beforeId: other.id } : { afterId: other.id }) });
        }
      } else {
        const next = side ? byCol.get(cols[colIx + side]?.id)?.[Math.min(at, (byCol.get(cols[colIx + side]?.id)?.length ?? 1) - 1)]
          : list[at + (key === 'ArrowUp' ? -1 : 1)];
        if (next) ui({ focusId: next.id, selection: [next.id] });
      }
    }
  };
  useEffect(() => {
    const onKey = (e) => keys.current(e);
    const el = root();
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  const room = PLAN_GATES['plan.columnRoom'].test(plan);
  return (
    <div ref={strip} className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-3"
      onPointerDown={(e) => backgroundClick(e, (t) => t === strip.current || t.matches('section[data-column], section[data-column] > div')) && ui({ selection: [] })}>
      {cols.map((col) => {
        const list = byCol.get(col.id);
        const index = plan.columns.findIndex((c) => c.id === col.id);
        const w = col.id === null ? { count: list.length, limit: null, over: false } : wip[col.id];
        const tag = col.tagId && ctx.tags.find((t) => t.id === col.tagId);
        const over = drag?.target?.column === col.id;
        const noTag = over && unmapped(col.id, drag.ids);
        return (
          <section key={col.id ?? ''} data-column={col.id ?? ''} aria-label={col.name}
            className={cn('relative flex w-80 shrink-0 flex-col rounded-lg border border-transparent bg-muted/40', over && 'border-ring/60 bg-muted/70')}>
            <header className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-xs">
              <span className={cn('size-2.5 shrink-0 rounded-full', col.id === null && 'border border-muted-foreground/60')} style={col.color ? { background: col.color } : undefined} />
              {renaming === col.id && col.id !== null ? (
                <InlineInput value={col.name} maxLength={40} aria-label="Column name" className="h-6 flex-1 text-xs md:text-xs"
                  onKeyDownCapture={(e) => e.key === 'Escape' && e.preventDefault()} // cancels the edit only, not the workspace
                  onDone={(name) => { setRenaming(null); if (name != null && name.trim() !== col.name) dispatch('plan.columns.update', { planId, columnId: col.id, patch: { name } }); }} />
              ) : (
                <span className="min-w-0 truncate font-medium" onDoubleClick={() => col.id !== null && setRenaming(col.id)}>{col.name}</span>
              )}
              {tag && <Tip title={`Draft cards follow the tag "${tag.name}"`}><Tag className="size-3 shrink-0 text-muted-foreground" aria-label={`Follows ${tag.name}`} /></Tip>}
              {col.done && <Tip title="Done column"><CircleCheck className="size-3 shrink-0 text-green-500" aria-label="Done column" /></Tip>}
              <span className={cn('text-muted-foreground tabular-nums', w.over && 'text-destructive')}>{w.limit ? `${w.count}/${w.limit}` : w.count}</span>
              <span className="flex-1" />
              <Tip title={withKey('Add a ticket here', 'plan.newTicket')}>
                <Button variant="ghost" size="icon-xs" aria-label={`Add a ticket to ${col.name}`} onMouseDown={keepFocus} onClick={() => setAdding(col.id)}><Plus /></Button>
              </Tip>
              {col.id !== null && <ColumnMenu plan={plan} col={col} index={index} onRename={() => setRenaming(col.id)} />}
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5 pt-0">
              {adding === col.id && <QuickAdd add={(title) => add(col.id, title)} onClose={() => setAdding(undefined)} />}
              {list.map((card) => (
                <Card key={card.id} card={card} ctx={ctx} fields={options.fields ?? FIELDS} ids={idsFor(card.id)}
                  selected={selection.includes(card.id)} focused={focusId === card.id} dragging={drag?.ids.includes(card.id)}
                  line={over && !noTag && drag.target.beforeId === card.id}
                  onPointerDown={(e) => pointerDown(e, card)} onClick={(e) => click(e, card)} />
              ))}
              {over && !noTag && drag.target.beforeId === null && <div className="h-0.5 shrink-0 rounded-full bg-primary" />}
            </div>
            {noTag && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-ring bg-background/70 p-4 text-center text-xs">
                Follows no status tag: drop to create one
              </div>
            )}
          </section>
        );
      })}
      <Tip title={room ? 'Add a column' : PLAN_GATES['plan.columnRoom'].message}>
        <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" disabled={!room} onMouseDown={keepFocus} onClick={addColumn}><Plus />Column</Button>
      </Tip>
    </div>
  );
}

// Critical-path scheduling of a plan (Gantt plan §3.7) over working-day indexes from dates.mjs. Half-open: a ticket has
// s = work(start), d working days (0 for a milestone), e = s + d. Also the status derivation that "blocked" needs
// (doneColumnOf, columnForTag, statusOf; plan-model.mjs re-exports them), so this module does not import plan-model.

import { fromDay, fromWork, toDay, work } from './dates.mjs';

/** The column that counts as done: plan.doneColumn when it is a column, else the last column. */
export const doneColumnOf = (plan) => (plan.columns.some((c) => c.id === plan.doneColumn) ? plan.doneColumn : plan.columns.at(-1).id);

/** The column that follows the global tag `tagId` while that tag exists (ctx.tags), else null ("No status"). */
export function columnForTag(ctx, tagId) {
  if (tagId == null || !ctx.tags?.some((t) => t.id === tagId)) return null;
  return ctx.plan.columns.find((c) => c.tagId === tagId)?.id ?? null;
}

/** A ticket's column id or null: a linked ticket's comes from its draft's tag, never from its stored status. */
export function statusOf(ticket, ctx) {
  if (ticket.draftId) return columnForTag(ctx, ctx.draftTags?.[ticket.draftId]);
  return ctx.plan.columns.some((c) => c.id === ticket.status) ? ticket.status : null;
}

/** Whether the tickets' dependencies (plus `extra` {from, to}: `to` depends on `from`) contain a cycle. */
export function hasCycle(tickets, extra) {
  const preds = new Map(tickets.map((t) => [t.id, t.deps.map((d) => d.on)]));
  if (extra) preds.set(extra.to, [...(preds.get(extra.to) ?? []), extra.from]);
  const state = new Map(); // 1 on the current path, 2 finished
  const visit = (id) => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    const found = (preds.get(id) ?? []).some(visit);
    state.set(id, 2);
    return found;
  };
  return [...preds.keys()].some(visit);
}

// Earliest start of a successor of duration d over one dependency on `p`, and the latest finish of the predecessor p over
// one dependency of the successor `n` (each type written as a bound on that ticket's own value).
const EARLY = { FS: (p, lag) => p.ef + lag, SS: (p, lag) => p.es + lag, FF: (p, lag, d) => p.ef + lag - d, SF: (p, lag, d) => p.es + lag - d };
const LATE = { FS: (n, lag) => n.ls - lag, SS: (n, lag, d) => n.ls - lag + d, FF: (n, lag) => n.lf - lag, SF: (n, lag, d) => n.lf - lag + d };

/** The schedule of ctx.plan: `byId[id]` = {s, e, d, es, ef, ls, lf, float, critical, conflict, blocked, ready, scheduled,
 * summary?} (indexes are absolute working-day indexes, null when unscheduled) and `span` {start, end} (dates of the first and
 * last scheduled day, null when nothing is scheduled). Tickets without dates are left out of both passes (their dependencies
 * still count for `blocked`); a parent with children is a summary of its children. Predecessor bounds use their earliest
 * dates, so autoScheduled settles the whole chain in one pass. */
export function schedule(ctx) {
  const { plan } = ctx;
  const cal = plan.calendar;
  const tickets = new Map(plan.tickets.map((t) => [t.id, t]));
  const kids = new Map();
  for (const t of plan.tickets) if (tickets.has(t.parent)) kids.set(t.parent, [...(kids.get(t.parent) ?? []), t.id]);
  const byId = {};
  const nodes = plan.tickets.filter((t) => !kids.has(t.id) && toDay(t.start) !== null && toDay(t.end) !== null);
  for (const t of nodes) {
    const s = work(toDay(t.start), cal);
    const d = t.milestone ? 0 : Math.max(1, work(toDay(t.end) + 1, cal) - s);
    byId[t.id] = { s, e: s + d, d, es: s, ef: s + d, ls: null, lf: null, float: null, critical: false, conflict: false, scheduled: true };
  }
  // Kahn's order over the dependencies between scheduled tickets; a hand-edited cycle leaves its tickets out of the passes.
  const deps = (t) => t.deps.filter((x) => byId[x.on] && EARLY[x.type]);
  const succs = new Map(nodes.map((t) => [t.id, []]));
  const waiting = new Map(nodes.map((t) => [t.id, deps(t).length]));
  for (const t of nodes) for (const x of deps(t)) succs.get(x.on).push(t);
  const topo = nodes.filter((t) => !waiting.get(t.id));
  for (let i = 0; i < topo.length; i++) {
    for (const s of succs.get(topo[i].id)) {
      waiting.set(s.id, waiting.get(s.id) - 1);
      if (!waiting.get(s.id)) topo.push(s);
    }
  }
  const sorted = new Set(topo.map((t) => t.id));
  for (const t of topo) {
    const n = byId[t.id];
    for (const x of deps(t)) n.es = Math.max(n.es, EARLY[x.type](byId[x.on], x.lag, n.d));
    n.ef = n.es + n.d;
    n.conflict = n.s < n.es;
  }
  const end = Math.max(...nodes.map((t) => byId[t.id].ef));
  for (const t of nodes) byId[t.id].lf = end;
  for (const t of [...topo].reverse()) {
    const n = byId[t.id];
    n.ls = n.lf - n.d;
    for (const x of deps(t)) if (sorted.has(x.on)) byId[x.on].lf = Math.min(byId[x.on].lf, LATE[x.type](n, x.lag, byId[x.on].d));
  }
  for (const t of nodes) {
    const n = byId[t.id];
    n.ls = n.lf - n.d;
    n.float = n.ls - n.es;
    n.critical = n.float <= 0;
  }
  const summarise = (id) => {
    const parts = kids.get(id).map((k) => (kids.has(k) ? summarise(k) : byId[k])).filter((k) => k?.scheduled);
    const min = (key) => Math.min(...parts.map((k) => k[key]));
    const max = (key) => Math.max(...parts.map((k) => k[key]));
    byId[id] = parts.length
      ? { s: min('s'), e: max('e'), d: max('e') - min('s'), es: min('es'), ef: max('ef'), ls: min('ls'), lf: max('lf'), float: min('float'),
        critical: false, conflict: false, scheduled: true, summary: true }
      : null;
    return byId[id];
  };
  for (const id of kids.keys()) if (!byId[id]) summarise(id);
  const done = doneColumnOf(plan);
  for (const t of plan.tickets) {
    const n = (byId[t.id] ??= { s: null, e: null, d: null, es: null, ef: null, ls: null, lf: null, float: null, critical: false, conflict: false, scheduled: false });
    n.blocked = t.deps.some((x) => tickets.has(x.on) && statusOf(tickets.get(x.on), ctx) !== done);
    n.ready = !n.blocked && statusOf(t, ctx) !== done;
  }
  const last = (n) => (n.d ? Math.max(n.e, n.ef) - 1 : n.es); // the last drawn day of a bar or milestone
  const span = nodes.length
    ? { start: fromDay(fromWork(Math.min(...nodes.map((t) => byId[t.id].s)), cal)), end: fromDay(fromWork(Math.max(...nodes.map((t) => last(byId[t.id]))), cal)) }
    : null;
  return { byId, span };
}

/** The plan with every conflicting ticket's start moved to its earliest start, keeping its working-day duration (the same
 * plan object when nothing moves). */
export function autoScheduled(plan, ctx) {
  const { byId } = schedule({ ...ctx, plan });
  const cal = plan.calendar;
  let moved = false;
  const tickets = plan.tickets.map((t) => {
    const n = byId[t.id];
    if (!n.conflict) return t;
    moved = true;
    return { ...t, start: fromDay(fromWork(n.es, cal)), end: fromDay(fromWork(n.d ? n.es + n.d - 1 : n.es, cal)) };
  });
  return moved ? { ...plan, tickets } : plan;
}

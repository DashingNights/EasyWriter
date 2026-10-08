import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TAGS } from '../src/app/drafts-meta.js';
import { fromDay, fromWork, normRange, toDay, work } from '../src/plan/dates.mjs';
import { addDep, addTicket, parsePlan, setParent, updateTicket } from '../src/plan/plan-model.mjs';
import { autoScheduled, hasCycle, schedule } from '../src/plan/schedule.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan-sample.json', import.meta.url), 'utf8'));
const context = (plan = parsePlan(fixture)) => ({ plan, tags: DEFAULT_TAGS, drafts: [], draftTags: {}, today: '2026-10-06' });
const byNum = (plan, n) => plan.tickets.find((t) => t.num === n);
const withTicket = (plan, n, patch) => ({ ...plan, tickets: plan.tickets.map((t) => (t.num === n ? { ...t, ...patch } : t)) });

// Gantt plan §3.7, verbatim: the acceptance table for schedule() (and, in Phase 3, for the on-screen Gantt).
const TABLE = `
| num | title | d | deps | es | ef | ls | lf | float | critical | start | end |
|---|---|---|---|---|---|---|---|---|---|---|---|
| #1 A | Design | 3 | — | 0 | 3 | 0 | 3 | 0 | yes | 2026-10-05 | 2026-10-07 |
| #2 B | Blockout | 2 | FS A | 3 | 5 | 5 | 7 | 2 | no | 2026-10-08 | 2026-10-09 |
| #3 C | Art pass | 4 | FS A | 3 | 7 | 3 | 7 | 0 | yes | 2026-10-08 | 2026-10-13 |
| #4 D | Playtest | 2 | FS B, FS C | 7 | 9 | 7 | 9 | 0 | yes | 2026-10-14 | 2026-10-15 |
| #5 M | Submission (milestone) | 0 | FS D | 9 | 9 | 9 | 9 | 0 | yes | 2026-10-16 | 2026-10-16 |
| #6 F | Write-up | 1 | SS C lag 1 | 4 | 5 | 8 | 9 | 4 | no | 2026-10-09 | 2026-10-09 |
`;

test('the §3.7 fixture table: durations, dependencies, early/late dates, float, critical path, dates', () => {
  const { plan } = context();
  const { byId } = schedule(context(plan));
  const base = work(toDay('2026-10-05'), plan.calendar); // indexes are relative to the earliest start
  const letters = {};
  const rows = TABLE.trim().split('\n').slice(2).map((line) => line.split('|').slice(1, -1).map((c) => c.trim()));
  for (const [num, title, d, deps, es, ef, ls, lf, float, critical, start, end] of rows) {
    const t = byNum(plan, +num.slice(1, num.indexOf(' ')));
    letters[num.split(' ')[1]] = t.id;
    const n = byId[t.id];
    assert.equal(t.title, title.replace(' (milestone)', ''));
    assert.deepEqual([n.d, n.es - base, n.ef - base, n.ls - base, n.lf - base, n.float, n.critical ? 'yes' : 'no'],
      [+d, +es, +ef, +ls, +lf, +float, critical], `row ${num}`);
    assert.deepEqual([t.start, t.end], [start, end]);
    assert.equal(fromDay(fromWork(n.es, plan.calendar)), start); // no conflicts: earliest = stored
    const want = deps === '—' ? [] : deps.split(', ').map((x) => { const [type, on, , lag] = x.split(' '); return { on: letters[on], type, lag: +(lag ?? 0) }; });
    assert.deepEqual(t.deps, want);
  }
  const critical = plan.tickets.filter((t) => byId[t.id].critical).map((t) => t.num);
  assert.deepEqual(critical, [1, 3, 4, 5]); // A → C → D → M
});

test('a stored start before the dependencies allow is a conflict; autoScheduled moves it and keeps its duration', () => {
  const plan = withTicket(context().plan, 2, { start: '2026-10-07', end: '2026-10-08' });
  const { byId } = schedule(context(plan));
  const b = byId[byNum(plan, 2).id];
  const base = work(toDay('2026-10-05'), plan.calendar);
  assert.equal(b.conflict, true);
  assert.equal(b.es - base, 3); // es stays 3
  assert.equal(b.s - base, 2); // the bar is drawn at the stored start
  assert.equal(Object.values(byId).filter((n) => n.conflict).length, 1);
  const moved = autoScheduled(plan, context(plan));
  assert.deepEqual([byNum(moved, 2).start, byNum(moved, 2).end], ['2026-10-08', '2026-10-09']);
  assert.equal(schedule(context(moved)).byId[byNum(plan, 2).id].conflict, false);
  const clean = context().plan;
  assert.equal(autoScheduled(clean, context(clean)), clean); // nothing to move: the same plan
});

test('stored dates are normalised to working days: a Saturday start becomes the Monday', () => {
  const cal = { workdays: [1, 2, 3, 4, 5], holidays: [] };
  assert.deepEqual(normRange('2026-10-10', '2026-10-13', cal), { start: '2026-10-12', end: '2026-10-13' });
  assert.deepEqual(normRange('2026-10-08', '2026-10-11', cal), { start: '2026-10-08', end: '2026-10-09' }); // Sunday end → Friday
  const r = updateTicket(context(), ['#2'], { start: '2026-10-10', end: '2026-10-13' });
  assert.deepEqual([byNum(r.plan, 2).start, byNum(r.plan, 2).end], ['2026-10-12', '2026-10-13']);
});

test('a holiday on 2026-10-08 shifts B, C and F by one working day', () => {
  const plan0 = context().plan;
  const plan = { ...plan0, calendar: { ...plan0.calendar, holidays: ['2026-10-08'] } };
  const { byId } = schedule(context(plan));
  const earliest = (n) => fromDay(fromWork(byId[byNum(plan, n).id].es, plan.calendar));
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(earliest), ['2026-10-05', '2026-10-09', '2026-10-09', '2026-10-14', '2026-10-16', '2026-10-12']);
});

test('each dependency type with a lag, a negative lag, and a milestone as predecessor', () => {
  const ctx = context();
  const P = byNum(ctx.plan, 1).id; // Design, 2026-10-05 … 07 (d 3)
  const base = work(toDay('2026-10-05'), ctx.plan.calendar);
  const es = (type, lag, d = 2, milestone = false) => {
    const end = milestone ? '2026-10-05' : fromDay(toDay('2026-10-05') + d - 1);
    const r = addTicket(ctx, { title: 'S', start: '2026-10-05', end, milestone, deps: [{ on: P, type, lag }] });
    return schedule({ ...ctx, plan: r.plan }).byId[r.result.ticketId].es - base;
  };
  assert.equal(es('FS', 1), 4); // e_A 3 + 1
  assert.equal(es('FS', -1), 2); // a lead
  assert.equal(es('SS', 1), 1); // s_A 0 + 1
  assert.equal(es('FF', 1), 2); // e_A 3 + 1 − d 2
  assert.equal(es('SF', 3), 1); // s_A 0 + 3 − d 2
  assert.equal(es('FS', 0, 0, true), 3); // milestone: zero duration
  const m = byNum(ctx.plan, 5);
  const r = addTicket(ctx, { title: 'After M', start: '2026-10-05', end: '2026-10-05', deps: [{ on: m.id }] });
  const { byId } = schedule({ ...ctx, plan: r.plan });
  assert.equal(byId[r.result.ticketId].es, byId[m.id].ef); // milestone e = s
});

test('FF bounds the predecessor in the backward pass', () => {
  const ctx = context({ ...parsePlan(fixture), tickets: [], order: [] });
  let r = addTicket(ctx, { title: 'P', start: '2026-10-05', end: '2026-10-07' });
  const p = r.result.ticketId;
  r = addTicket({ ...ctx, plan: r.plan }, { title: 'S', start: '2026-10-05', end: '2026-10-06', deps: [{ on: p, type: 'FF' }] });
  const s = r.result.ticketId;
  r = addTicket({ ...ctx, plan: r.plan }, { title: 'X', start: '2026-10-05', end: '2026-10-09' }); // ends the project at 5
  const { byId } = schedule({ ...ctx, plan: r.plan });
  assert.deepEqual([byId[s].es, byId[s].lf - byId[s].es], [byId[p].es + 1, 4]); // S: es 1, lf 5
  assert.deepEqual([byId[p].float, byId[s].float, byId[r.result.ticketId].critical], [2, 2, true]);
});

test('a parent with children is left out of both passes and summarised from its children', () => {
  const ctx = context();
  const r = addTicket(ctx, { title: 'Level 1', start: '2026-12-01', end: '2026-12-02' });
  const parent = r.result.ticketId;
  const plan = setParent({ ...ctx, plan: r.plan }, ['#2', '#3'], parent).plan;
  const { byId } = schedule({ ...ctx, plan });
  const [b, c] = [byId[byNum(plan, 2).id], byId[byNum(plan, 3).id]];
  assert.equal(byId[parent].summary, true);
  assert.deepEqual([byId[parent].s, byId[parent].e], [Math.min(b.s, c.s), Math.max(b.e, c.e)]); // own dates ignored
  assert.equal(byId[parent].critical, false);
  assert.equal(byId[byNum(plan, 4).id].es, schedule(context()).byId[byNum(plan, 4).id].es); // the children's schedule is unchanged
});

test('cycles and dependencies on a parent are refused', () => {
  const ctx = context();
  assert.equal(addDep(ctx, '#4', '#1').error.code, 'cycle'); // D → A: A → C → D already
  assert.equal(addDep(ctx, '#1', '#1').error.code, 'cycle');
  assert.equal(hasCycle(ctx.plan.tickets), false);
  assert.equal(hasCycle(ctx.plan.tickets, { from: byNum(ctx.plan, 5).id, to: byNum(ctx.plan, 1).id }), true);
  const r = addTicket(ctx, { title: 'Parent' });
  const plan = setParent({ ...ctx, plan: r.plan }, ['#6'], r.result.ticketId).plan; // a child keeps its own dependencies
  assert.equal(addDep({ ...ctx, plan }, '#1', `#${r.result.num}`).error.code, 'parent_dep');
  assert.equal(setParent(ctx, ['#2'], '#1').error.code, 'parent_dep'); // #1 has successors: it cannot become a parent
});

test('blocked and ready follow the done column of the dependencies', () => {
  const { byId } = schedule(context());
  const plan = context().plan;
  const flags = (n) => [byId[byNum(plan, n).id].blocked, byId[byNum(plan, n).id].ready];
  assert.deepEqual(flags(1), [false, false]); // done
  assert.deepEqual(flags(2), [false, true]); // A is done
  assert.deepEqual(flags(4), [true, false]); // B and C are not
  const unscheduled = addTicket(context(), { title: 'Later', deps: [{ on: '#2' }] });
  const n = schedule({ ...context(), plan: unscheduled.plan }).byId[unscheduled.result.ticketId];
  assert.deepEqual([n.scheduled, n.blocked, n.es], [false, true, null]);
});

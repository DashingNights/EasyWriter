import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TAGS } from '../src/app/drafts-meta.js';
import { toDay } from '../src/plan/dates.mjs';
import { ganttLayout, GANTT_MAX_ROWS, hitTest } from '../src/plan/gantt-layout.mjs';
import { addTicket, parsePlan, setBaseline, setParent, updateTicket } from '../src/plan/plan-model.mjs';
import { schedule } from '../src/plan/schedule.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan-sample.json', import.meta.url), 'utf8'));
const context = (plan = parsePlan(fixture), today = '2026-10-06') => ({ plan, tags: DEFAULT_TAGS, drafts: [], draftTags: {}, today });
const layout = (ctx, options, width = 1200, opts) => ganttLayout(ctx, schedule(ctx), options, width, opts);
const setDates = (ctx, id) => updateTicket(ctx, [id], { start: '2026-10-07', end: '2026-10-07' }).plan;
const row = (L, ctx, n) => L.rows.find((r) => r.id === ctx.plan.tickets.find((t) => t.num === n).id);
// Range: 2 days around the span 2026-10-05 … 16 → 2026-10-03 … 18 (16 days); task list 200 px.

test('bar x / w per zoom, fit, and a range that clips the bars', () => {
  const ctx = context();
  for (const [zoom, px] of [['day', 36], ['week', 10], ['month', 3], ['quarter', 1]]) {
    const L = layout(ctx, { zoom });
    assert.deepEqual([L.pxPerDay, row(L, ctx, 1).bar], [px, { x: 200 + 2 * px, w: 3 * px }], zoom); // Design: 5 … 7 Oct
    assert.equal(L.width, 200 + 16 * px);
  }
  assert.equal(layout(ctx, { zoom: 'fit' }).pxPerDay, 36); // 1000 px / 16 days, at most 36
  assert.equal(layout(ctx, { zoom: 'fit' }, 600).pxPerDay, 25);
  assert.equal(layout(ctx, { zoom: 'fit', showTaskList: false }, 160).pxPerDay, 10);
  const clipped = layout(ctx, { zoom: 'day', range: { start: '2026-10-08', end: '2026-10-12' } });
  assert.deepEqual(row(clipped, ctx, 1).bar, { x: 200, w: 0 }); // wholly before the range
  assert.deepEqual(row(clipped, ctx, 3).bar, { x: 200, w: 5 * 36 }); // 8 … 13 Oct cut at the 12th
  const m = row(layout(ctx, { zoom: 'day' }), ctx, 5);
  assert.deepEqual([m.kind, m.bar], ['milestone', { x: 200 + 13 * 36 + 18, w: 0 }]); // centred on 16 Oct
});

test('rows: tree order, filters, summaries, baselines, working-day axis, 60-row cap', () => {
  const ctx = context();
  const L = layout(ctx, { zoom: 'day' });
  assert.deepEqual(L.rows.map((r) => [r.y, r.kind]).slice(0, 2), [[40, 'task'], [68, 'task']]);
  assert.equal(L.height, 40 + 6 * 28);
  assert.deepEqual(layout(ctx, { labels: ['a1b2c3d'] }).rows.map((r) => r.id), [ctx.plan.tickets[0].id, ctx.plan.tickets[2].id]);
  const p = addTicket(ctx, { title: 'Level 1' });
  const nested = context(setParent({ ...ctx, plan: p.plan }, ['#2', '#3'], p.result.ticketId).plan);
  const withParent = layout(nested, { zoom: 'day', labels: ['a1b2c3d'] }); // C passes, so its parent shows too
  assert.deepEqual(withParent.rows.map((r) => [r.kind, r.depth]), [['task', 0], ['summary', 0], ['task', 1]]);
  assert.deepEqual(withParent.rows[1].bar, { x: 200 + 5 * 36, w: 6 * 36 }); // 8 … 13 Oct
  const m2 = addTicket(ctx, { title: 'Gate', start: '2026-10-12', end: '2026-10-12', milestone: true }); // a Monday
  const p2 = addTicket({ ...ctx, plan: m2.plan }, { title: 'Milestones' });
  const onlyMs = context(setParent({ ...ctx, plan: p2.plan }, [`#${m2.result.num}`], p2.result.ticketId).plan);
  assert.equal(row(layout(onlyMs, { zoom: 'day' }), onlyMs, p2.result.num).bar.w, 0); // never a negative width
  const based = context(setBaseline(ctx).plan);
  assert.deepEqual(row(layout(based, { zoom: 'day', showBaseline: true }), based, 2).baseline, { x: 200 + 5 * 36, w: 72 });
  const work = layout(ctx, { zoom: 'day', showWeekends: false });
  assert.equal(row(work, ctx, 3).bar.w, 4 * 36); // Thu … Tue: 4 working days
  assert.equal(work.shading.length, 0);
  const shade = layout(ctx, { zoom: 'day' }).shading;
  assert.deepEqual(shade.map((s) => [s.x, s.w, s.kind]), [[200, 72, 'weekend'], [200 + 7 * 36, 72, 'weekend'], [200 + 14 * 36, 72, 'weekend']]);

  const many = parsePlan({ ...fixture, tickets: Array.from({ length: GANTT_MAX_ROWS + 1 }, (_, i) => ({
    id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, title: `T${i}`, start: '2026-10-05', end: '2026-10-06' })), order: [] });
  assert.equal(layout(context(many), {}).rows.length, 61); // the workspace shows every row
  assert.equal(layout(context(many), {}, 1200, { exporting: true }).error.code, 'too_many_rows');
});

test('export zoom fallback and refusal of a range that cannot fit', () => {
  const ctx = context();
  const L = layout(ctx, { zoom: 'day' }, 400, { exporting: true }); // 200 px for 16 days
  assert.deepEqual([L.zoomUsed, L.pxPerDay, L.note], ['week', 10, '3 weeks shown at week zoom']);
  assert.equal(layout(ctx, { zoom: 'week' }, 400, { exporting: true }).note, undefined);
  assert.equal(layout(ctx, { zoom: 'day' }, 400).pxPerDay, 36); // the workspace keeps the zoom and scrolls
  const long = { zoom: 'fit', range: { start: '2026-01-01', end: '2027-12-31' } };
  assert.equal(layout(ctx, long, 300, { exporting: true }).error.code, 'range_too_long');
  assert.equal(layout(ctx, long, 300).pxPerDay, 1);
});

test('export fill: the axis runs past the tickets in whole days up to the chart width; a range end stops it', () => {
  // The chart node of the user's report: 1454 px less 24 padding, one milestone on Fri 9 Oct, Fit (at most 36 px a day).
  const ms = context(parsePlan({ ...fixture, order: [], tickets: [{ id: 'eeeeeeee-0000-4000-8000-000000000001', title: 'Project Proposal Draft',
    start: '2026-10-09', end: '2026-10-09', milestone: true }] }));
  const L = layout(ms, {}, 1430, { exporting: true });
  assert.deepEqual([L.pxPerDay, L.start, L.end, L.width], [36, toDay('2026-10-07'), toDay('2026-11-09'), 200 + 34 * 36]); // was 7 … 11 Oct, 380 px
  assert.deepEqual(L.rows[0].bar, { x: 200 + 2 * 36 + 18, w: 0 }); // centred on 9 Oct
  assert.equal(L.note, undefined);
  const work = layout(ms, { showWeekends: false }, 1430, { exporting: true });
  assert.deepEqual([work.width, work.end], [200 + 34 * 36, toDay('2026-11-23')]); // 34 working days from 7 Oct
  assert.equal(layout(ms, { range: { start: null, end: '2026-10-11' } }, 1430, { exporting: true }).width, 200 + 5 * 36);
  const fell = layout(context(), { zoom: 'day' }, 400, { exporting: true }); // the week fallback fills the width too
  assert.deepEqual([fell.zoomUsed, fell.width, fell.note], ['week', 400, '3 weeks shown at week zoom']);
});

test('dependency polylines: orthogonal, 12 px stubs, the right ends for each type', () => {
  const P = { id: 'cccccccc-0000-4000-8000-000000000001', title: 'P', start: '2026-10-05', end: '2026-10-07' };
  for (const type of ['FS', 'SS', 'FF', 'SF']) {
    for (const start of ['2026-10-12', '2026-10-06']) { // a gap (simple route) and an overlap (around)
      const S = { id: 'cccccccc-0000-4000-8000-000000000002', title: 'S', start, end: '2026-10-13', deps: [{ on: P.id, type }] };
      const ctx = context(parsePlan({ ...fixture, tickets: [P, S], order: [] }));
      const L = layout(ctx, { zoom: 'day' });
      const [p, s] = L.rows;
      const { points } = L.deps[0];
      const fromEnd = type[0] === 'F';
      const toEnd = type[1] === 'F';
      assert.deepEqual(points[0], [p.bar.x + (fromEnd ? p.bar.w : 0), p.y + 14], `${type} ${start} source`);
      assert.deepEqual(points.at(-1), [s.bar.x + (toEnd ? s.bar.w : 0), s.y + 14], `${type} ${start} target`);
      assert.equal(points[1][0] - points[0][0], fromEnd ? 12 : -12); // leaves away from the bar
      assert.ok(toEnd ? points.at(-2)[0] > points.at(-1)[0] : points.at(-2)[0] < points.at(-1)[0], `${type} ${start} enters from outside`);
      for (let i = 1; i < points.length; i++) assert.ok(points[i][0] === points[i - 1][0] || points[i][1] === points[i - 1][1], 'orthogonal');
    }
  }
  const ctx = context();
  const crit = layout(ctx, { zoom: 'day', showCritical: true });
  assert.deepEqual(crit.deps.map((d) => d.critical), [false, true, false, true, true, false]); // A→B, A→C, B→D, C→D, D→M, C→F
  assert.equal(layout(ctx, { showDeps: false }).deps.length, 0);
});

test('today line and header ticks', () => {
  assert.equal(layout(context(), { zoom: 'day' }).today, 200 + 3 * 36 + 18);
  assert.equal(layout(context(), { zoom: 'day', showToday: false }).today, null);
  assert.equal(layout(context(undefined, '2027-01-01'), { zoom: 'day' }).today, null);
  const day = layout(context(), { zoom: 'day' }).ticks;
  assert.deepEqual(day.slice(0, 3), [{ x: 200, label: 'Oct 2026', major: true }, { x: 200, label: '3', major: false }, { x: 236, label: '4', major: false }]);
  const plan = parsePlan({ ...fixture, calendar: { ...fixture.calendar, weekOne: '2026-09-21' } });
  const weeks = layout(context(plan), { zoom: 'week', weekLabels: 'number' }).ticks.filter((t) => !t.major).map((t) => t.label);
  assert.deepEqual(weeks, ['Wk 2', 'Wk 3', 'Wk 4']);
  assert.deepEqual(layout(context(), { zoom: 'week' }).ticks.filter((t) => !t.major).map((t) => t.label), ['3 Oct', '5 Oct', '12 Oct']);
});

test('workspace fill: a lead-in, a two-week tail, the width filled with days, from / to, a held Fit scale', () => {
  const one = (tickets) => context(parsePlan({ ...fixture, tickets, order: [] }));
  const ctx = one([{ id: 'dddddddd-0000-4000-8000-000000000001', title: 'test', start: '2026-10-05', end: '2026-10-13' }]);
  const fill = (options, f = {}, c = ctx) => layout(c, { showTaskList: false, ...options }, 2000, { fill: f });
  const [d5, d13] = [toDay('2026-10-05'), toDay('2026-10-13')];
  for (const [zoom, lead] of [['day', 3], ['week', 7], ['month', 31], ['quarter', 92], ['fit', 3]]) {
    for (const showWeekends of [true, false]) {
      const L = fill({ zoom, showWeekends });
      assert.equal(L.width, 2000, `${zoom} ${showWeekends}: the axis reaches the right edge`);
      assert.ok(L.start === d5 - lead && L.end >= d13 + 14, `${zoom} ${showWeekends}: lead-in and tail`);
    }
  }
  assert.equal(fill({ zoom: 'fit' }).pxPerDay, 36); // 26 days in 2000 px, at most 36, the rest filled
  assert.equal(layout(ctx, { zoom: 'fit', showTaskList: false }, 520, { fill: {} }).pxPerDay, 20); // 3 + 9 + 14 days fit
  assert.equal(fill({ zoom: 'fit' }, { px: 12 }).pxPerDay, 12);
  const grown = fill({ zoom: 'day' }, { from: toDay('2026-09-01'), to: toDay('2027-01-01') });
  assert.deepEqual([grown.start, grown.end, grown.width], [toDay('2026-09-01'), toDay('2027-01-01'), (toDay('2027-01-01') - toDay('2026-09-01') + 1) * 36]);
  assert.equal(fill({ zoom: 'day', range: { start: null, end: '2026-10-20' } }).width, 19 * 36); // a saved end: 2 … 20 Oct
  const empty = fill({ zoom: 'day' }, {}, one([]));
  assert.deepEqual([empty.start, empty.width, empty.today], [toDay('2026-10-03'), 2000, 3 * 36 + 18]); // around today
});

test('hitTest zones', () => {
  const ctx = context();
  const L = layout(ctx, { zoom: 'day' });
  const a = ctx.plan.tickets[0].id; // Design: x 272 … 380, row y 40 … 68, bar band 45 … 63, progress 100
  const hit = (x, y) => hitTest(L, x, y);
  assert.deepEqual(hit(326, 54), { kind: 'bar', id: a });
  assert.deepEqual(hit(274, 54), { kind: 'edge-l', id: a });
  assert.deepEqual(hit(378, 54), { kind: 'edge-r', id: a });
  assert.deepEqual(hit(265, 54), { kind: 'port-s', id: a });
  assert.deepEqual(hit(386, 54), { kind: 'port-e', id: a });
  assert.deepEqual(hit(380, 65), { kind: 'progress', id: a });
  const m = row(L, ctx, 5);
  assert.deepEqual(hit(m.bar.x, m.y + 14), { kind: 'bar', id: m.id });
  assert.deepEqual(hit(m.bar.x + 10, m.y + 14), { kind: 'port-e', id: m.id });
  const dep = L.deps[0]; // A → B around the bars: its third segment runs along the row gap
  const [[x1, y1], [x2]] = dep.points.slice(2, 4);
  assert.deepEqual(hit((x1 + x2) / 2, y1), { kind: 'dep', id: dep.to, from: dep.from });
  assert.equal(hit(1000, 54), null);
});

test('unscheduled rows (the workspace): tree order, no bar, no dependency lines, a lane hit; the export keeps scheduled only', () => {
  const ctx = context();
  const p = addTicket(ctx, { title: 'Parent' });
  const c = addTicket({ ...ctx, plan: p.plan }, { title: 'Child', parent: p.result.ticketId, deps: [{ on: '#1' }] });
  const nested = context(c.plan);
  assert.equal(layout(nested, { zoom: 'day' }).rows.length, 6); // neither has dates: no rows
  const L = layout(nested, { zoom: 'day' }, 1200, { fill: {}, unscheduled: true });
  const [pr, cr] = [row(L, nested, p.result.num), row(L, nested, c.result.num)];
  assert.deepEqual([pr.kind, pr.depth, pr.bar, cr.kind, cr.depth, cr.y - pr.y], ['unscheduled', 0, null, 'unscheduled', 1, 28]);
  assert.equal(L.rows.length, 8);
  assert.ok(!L.deps.some((d) => d.to === c.result.ticketId)); // #1 → Child is not drawn
  assert.deepEqual(hitTest(L, 600, cr.y + 14), { kind: 'lane', id: c.result.ticketId });
  const dated = context(setDates(nested, c.result.ticketId));
  const D = layout(dated, { zoom: 'day' }, 1200, { fill: {}, unscheduled: true });
  assert.deepEqual([row(D, dated, p.result.num).kind, row(D, dated, c.result.num).kind], ['summary', 'task']); // the bracket appears
});

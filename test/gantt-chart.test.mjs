import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chartLayout, freezeCtx } from '../src/plan-chart.js';
import { parsePlan, setBaseline } from '../src/plan/plan-model.mjs';

// The Gantt plan chart's export rules (Gantt plan §7.4; roadmap A4): at most 60 rows, the zoom falls back with a note, a
// range that cannot fit is refused; a frozen Gantt snapshot keeps the baselines.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan-sample.json', import.meta.url), 'utf8'));
const ctx = (plan = parsePlan(fixture)) => ({ plan, tags: [], drafts: [], draftTags: {}, today: '2026-10-06' });

test('chartLayout gantt: drawn at the post width, zoom fallback noted, refusals', () => {
  assert.deepEqual(chartLayout('gantt', ctx(), {}, 960), { layoutWidth: 960 });
  // 16 days at day zoom need 576 px; 400 − 24 padding − 200 task list leaves 176: week zoom (160 px)
  assert.deepEqual(chartLayout('gantt', ctx(), { zoom: 'day' }, 400), { layoutWidth: 400, note: '3 weeks shown at week zoom' });
  assert.match(chartLayout('gantt', ctx(), { range: { start: '2026-01-01', end: '2027-12-31' } }, 400).error, /date range is too long/);
  const many = parsePlan({ ...fixture, order: [], tickets: Array.from({ length: 61 }, (_, i) => ({
    id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, num: i + 1, title: `T${i}`, start: '2026-10-05', end: '2026-10-06' })) });
  assert.match(chartLayout('gantt', ctx(many), {}, 960).error, /more than 60 rows/);
  assert.equal(chartLayout('gantt', ctx(many), { search: 'T1' }, 960).error, undefined); // filtered below the cap
});

test('freezeCtx keeps baselines for a Gantt chart only', () => {
  const based = ctx(setBaseline(ctx()).plan);
  assert.ok(freezeCtx(based, 'gantt').plan.tickets.every((t) => t.baseline?.start === t.start));
  assert.ok(freezeCtx(based, 'kanban').plan.tickets.every((t) => t.baseline === null));
});

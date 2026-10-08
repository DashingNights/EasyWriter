import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chartLayout, freezeCtx, parseChart } from '../src/plan-chart.js';
import { parsePlan } from '../src/plan/plan-model.mjs';

const plan = parsePlan(JSON.parse(readFileSync(new URL('./fixtures/plan-sample.json', import.meta.url), 'utf8')));
const ctx = { plan, tags: [], drafts: [], draftTags: {}, today: '2026-10-06' };

test('parseChart: bad JSON → defaults; invalid keys dropped; dw ≥ 40 or null', () => {
  const d = parseChart('{nope');
  assert.match(d.id, /^[a-z0-9]{7}$/);
  assert.deepEqual({ ...d, id: null }, { id: null, planId: null, view: 'kanban', options: {}, frozen: null, dw: null });
  const c = parseChart(JSON.stringify({ id: 'q7w3e9r', planId: plan.id, view: 'pie', options: { hideDone: true, zoom: 'decade', bogus: 1 }, dw: 39.5 }));
  assert.deepEqual(c, { id: 'q7w3e9r', planId: plan.id, view: 'kanban', options: { hideDone: true }, frozen: null, dw: null });
  assert.equal(parseChart({ dw: 640.4 }).dw, 640);
});

test('a frozen snapshot round-trips through parseChart (its plan through parsePlan) without texts', () => {
  const withText = { ...ctx, plan: { ...plan, tickets: plan.tickets.map((t) => ({ ...t, description: 'secret', checklist: [{ id: 'k1q8z3v', text: 'x', done: true }] })) },
    drafts: [{ id: 'd', title: 'Draft', threadUrl: plan.threadUrl, pushedAt: null, updated: 1 }], draftTags: { d: 'todo', other: 'done' } };
  const frozen = parseChart({ planId: plan.id, frozen: { at: 5, ctx: freezeCtx(withText) } }).frozen;
  assert.equal(frozen.at, 5);
  assert.deepEqual(frozen.ctx.plan.tickets.map((t) => t.id), plan.tickets.map((t) => t.id));
  assert.ok(frozen.ctx.plan.tickets.every((t) => t.description === '' && t.checklist.length === 1 && t.checklist[0].text === '' && t.checklist[0].done));
  assert.deepEqual(frozen.ctx.drafts, [{ id: 'd', title: 'Draft', pushedAt: null }]);
  assert.deepEqual(frozen.ctx.draftTags, { d: 'todo' });
  assert.equal(frozen.ctx.today, '2026-10-06');
  assert.equal(parseChart({ frozen: { at: 1, ctx: {} } }).frozen, null);
});

test('chartLayout: Kanban columns need 180 px each; below a 0.8 scale or above 200 cards it is refused', () => {
  const n = plan.columns.length; // the fixture has no "No status" cards
  const min = n * 180 + (n - 1) * 12 + 24;
  assert.deepEqual(chartLayout('kanban', ctx, {}, 1454), { layoutWidth: 1454 });
  assert.deepEqual(chartLayout('kanban', ctx, {}, min - 50), { layoutWidth: min });
  assert.match(chartLayout('kanban', ctx, {}, Math.floor(min * 0.79)).error, /too many columns/);
  assert.deepEqual(chartLayout('kanban', ctx, { columns: ['todo'] }, 300), { layoutWidth: 300 });
  const many = { ...ctx, plan: parsePlan({ ...plan, tickets: Array.from({ length: 201 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, num: i + 1, title: `T${i}` })), order: [] }) };
  assert.match(chartLayout('kanban', many, {}, 1454).error, /more than 200 cards/);
  assert.match(chartLayout('backlog', many, {}, 1454).error, /more than 80 rows/);
  assert.equal(chartLayout('backlog', ctx, {}, 1454).error, undefined);
});

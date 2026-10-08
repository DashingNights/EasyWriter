import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TAGS } from '../src/app/drafts-meta.js';
import { GATES } from '../src/app/gates.mjs';
import { columnRef, labelRef, PLAN_COMMANDS, PLAN_GATES, ticketRef, unitRef, viewRef } from '../src/plan/plan-commands.mjs';
import { addColumn, parsePlan, removeColumn } from '../src/plan/plan-model.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan-sample.json', import.meta.url), 'utf8'));
const D1 = 'dddddddd-0000-4000-8000-000000000001';
// The sample context the descriptors' examples address.
const context = () => {
  const plan = parsePlan(fixture);
  return {
    plan, plans: [plan], tags: DEFAULT_TAGS, draftTags: { [D1]: 'progress' }, today: '2026-10-06',
    drafts: [{ id: D1, title: 'Week 3 post', threadUrl: fixture.threadUrl, pushedAt: null }],
  };
};
const byId = Object.fromEntries(PLAN_COMMANDS.map((c) => [c.id, c]));

test('ids are unique and well formed; risk, undo and examples are in range', () => {
  assert.equal(Object.keys(byId).length, PLAN_COMMANDS.length);
  for (const c of PLAN_COMMANDS) {
    assert.match(c.id, /^plan(\.[a-zA-Z]+)+$/);
    assert.ok(c.id.length <= 48, c.id);
    assert.ok(['read', 'write', 'destructive'].includes(c.risk), c.id);
    assert.ok(['own', 'doc', 'none'].includes(c.undo), c.id);
    assert.equal(c.group, 'plan');
    assert.ok(c.title && c.examples.length >= 1, c.id);
    assert.equal(c.args.type, 'object');
    assert.ok(!(c.plan && c.read), c.id);
  }
});

test('every example of a builder yields a plan that parsePlan keeps as it is; reads run', () => {
  for (const c of PLAN_COMMANDS) {
    for (const { args } of c.examples) {
      for (const key of c.args.required) assert.ok(key in args, `${c.id}: example lacks ${key}`);
      for (const key of Object.keys(args)) assert.ok(key in c.args.properties, `${c.id}: example has unknown ${key}`);
      if (c.plan) {
        const ctx = context();
        const r = c.plan(ctx, args);
        assert.ok(!r.error, `${c.id}: ${r.error?.message}`);
        assert.deepEqual(r.plan, parsePlan(r.plan), c.id);
        assert.deepEqual(ctx, context(), `${c.id} changed its context`);
      } else if (c.read) {
        assert.ok(c.read(context(), args), c.id);
      }
    }
  }
  assert.equal(byId['plan.create'].plan(context(), { threadUrl: fixture.threadUrl }).error.code, 'already_exists'); // one plan per thread
  const read = byId['plan.schedule'].read(context(), {});
  assert.deepEqual([read.critical, read.conflicts, read.byNum['#2'].float], [['#1', '#3', '#4', '#5'], [], 2]);
  assert.match(byId['plan.describe'].read(context(), { format: 'markdown' }).text, /^# Level design dev thread/);
});

test('deletes and removals are destructive, except removing a link', () => {
  for (const c of PLAN_COMMANDS) {
    if (!/\.(delete|remove)$/.test(c.id)) continue;
    const link = c.id === 'plan.deps.remove' || c.id === 'plan.tickets.labels.remove';
    assert.equal(c.risk, link ? 'write' : 'destructive', c.id);
  }
});

test('no whole-list setters: no .set command takes a top-level array, the ticket patch has no sub-list', () => {
  for (const c of PLAN_COMMANDS.filter((x) => x.id.endsWith('.set'))) {
    for (const [key, schema] of Object.entries(c.args.properties)) assert.notEqual(schema.type, 'array', `${c.id}.${key}`);
  }
  const patch = byId['plan.tickets.update'].args.properties.patch.properties;
  for (const key of ['deps', 'checklist', 'labels', 'urls', 'status']) assert.ok(!(key in patch), key);
});

test('gates: needs name known gates; the column gates hold at the limits and the reducers agree', () => {
  for (const c of PLAN_COMMANDS) for (const id of c.needs) assert.ok(PLAN_GATES[id] || GATES[id], `${c.id} needs ${id}`);
  assert.deepEqual(byId['plan.columns.add'].needs, ['plan.columnRoom']);
  assert.deepEqual(byId['plan.columns.remove'].needs, ['plan.otherColumn']);
  for (const g of Object.values(PLAN_GATES)) assert.ok(g.subject === 'plan' && g.message && g.fix);
  const ctx = context();
  let full = ctx;
  while (full.plan.columns.length < 10) full = { ...ctx, plan: addColumn(full, { name: 'More' }).plan };
  assert.equal(PLAN_GATES['plan.columnRoom'].test(ctx.plan), true);
  assert.equal(PLAN_GATES['plan.columnRoom'].test(full.plan), false);
  assert.equal(addColumn(full, { name: 'X' }).error.message, PLAN_GATES['plan.columnRoom'].message);
  const one = { ...ctx.plan, columns: [ctx.plan.columns[0]] };
  assert.equal(PLAN_GATES['plan.otherColumn'].test(one), false);
  assert.equal(removeColumn({ ...ctx, plan: one }, 'todo').error.code, 'precondition_failed');
});

test('refs resolve ids, #num and names', () => {
  const { plan } = context();
  assert.equal(ticketRef(plan, '#2'), plan.tickets[1].id);
  assert.equal(ticketRef(plan, plan.tickets[2].id), plan.tickets[2].id);
  assert.equal(ticketRef(plan, '#99'), null);
  assert.deepEqual(['done', 'Done', ' review ', null, 'nope'].map((r) => columnRef(plan, r)), ['done', 'done', 'r7k2m9q', null, undefined]);
  assert.deepEqual(['d', 'pt', 'p4t8x2q', 'h'].map((r) => unitRef(plan, r)), ['d', 'p4t8x2q', 'p4t8x2q', null]);
  assert.equal(labelRef(plan, 'art'), 'a1b2c3d');
  assert.equal(viewRef(plan, 'This sprint'), 'v1x9k2m');
  const moved = byId['plan.tickets.move'].plan(context(), { ticketIds: [D1], status: 'Review' });
  assert.equal(moved.error.code, 'unmapped_column'); // an agent gets no popup
});

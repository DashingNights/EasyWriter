// Plan command descriptors (Gantt plan §8): the automation layer's define() shape, so C4 registers them unchanged, and the
// one table A2's dispatch(id, args) reads. Builders have `plan(ctx, args)` → a reducer result (plan-model.mjs); pure reads
// have `read(ctx, args)`; the imperative ones (open, close, insertChart, chart.*, render, delete, undo, redo) get `run` from
// src/app/plans.js. `ctx` is planContext(planId) (§3.3) plus `plans` (every parsed plan) for plan.create / plan.list.
// Refs inside args (`#num`, column / unit / label / view names) are resolved by the reducers.

import {
  addCheck, addColumn, addDep, addHoliday, addLabel, addTicket, addTicketLabel, addUnit, addUrl, addView, cards, clearBaseline,
  columnRef, describe, doneColumnOf, importTasks, labelRef, moveCheck, moveColumn, moveTicket, newPlan, PLAN_GATES, ready,
  removeCheck, removeColumn, removeDep, removeHoliday, removeLabel, removeTicketLabel, removeTickets, removeUnit, removeUrl,
  removeView, reorder, setBaseline, statusOf, ticketRef, tree, unitRef, updateCheck, updateColumn, updateDep, updateLabel,
  updatePlan, updateTicket, updateUnit, updateUrl, updateView, viewRef,
} from './plan-model.mjs';
import { autoScheduled, schedule } from './schedule.mjs';

export { columnRef, labelRef, PLAN_GATES, ticketRef, unitRef, viewRef };

const ID = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
const REF = { type: 'string', pattern: '^(#\\d+|[a-f0-9-]{36})$' }; // `#num` or a ticket id (draft cards: a draft id)
const REFS = { type: 'array', items: REF, minItems: 1 };
const COL = { type: ['string', 'null'] }; // a column id or name; null = "No status"
const NAME = { type: 'string', maxLength: 64 }; // an id or a name (unit, label, view)
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const DATE_OR_NULL = { ...DATE, type: ['string', 'null'] };
const COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const SID = { type: 'string', pattern: '^[a-z0-9]{7}$' };
const WEB = { type: 'string', pattern: '^https?://' };
const DEP_TYPE = { enum: ['FS', 'SS', 'FF', 'SF'], default: 'FS' };
const LAG = { type: 'integer', default: 0 };
const BOOL = { type: 'boolean' };
const OPTIONS = { type: 'object' }; // §3.2 Options; parseOptions drops invalid keys
const VIEW = { enum: ['kanban', 'backlog', 'gantt'] };
const obj = (properties, required = []) => ({ type: 'object', required, additionalProperties: false, properties });

const TICKET_PATCH = {
  title: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 20000 }, priority: { type: 'integer', minimum: 0, maximum: 4 },
  estimate: { type: ['number', 'null'], minimum: 0 }, unit: NAME, start: DATE_OR_NULL, end: DATE_OR_NULL, milestone: BOOL,
  progress: { type: 'integer', minimum: 0, maximum: 100 }, parent: { ...REF, type: ['string', 'null'] }, draftId: { ...ID, type: ['string', 'null'] },
};
const { progress, parent, draftId, ...TASK_FIELDS } = TICKET_PATCH;
const NEW_TICKET = obj({
  ...TICKET_PATCH, status: COL, labels: { type: 'array', items: NAME }, days: { type: 'integer', minimum: 1 },
  deps: { type: 'array', items: obj({ on: REF, type: DEP_TYPE, lag: LAG }, ['on']) },
  checklist: { type: 'array', items: { type: ['string', 'object'] } }, urls: { type: 'array', items: obj({ url: WEB, title: { type: 'string', maxLength: 80 } }, ['url']) },
}, ['title']);
/** The `tasks` of plan.import: tickets whose `parent` and `deps[].on` may name another task's tempId. */
export const IMPORT_TASKS = {
  type: 'array', minItems: 1,
  items: obj({
    ...TASK_FIELDS, tempId: { type: 'string', maxLength: 64 }, parent: { type: 'string' }, status: COL, labels: { type: 'array', items: NAME },
    days: { type: 'integer', minimum: 1 }, deps: { type: 'array', items: obj({ on: { type: 'string' }, type: DEP_TYPE, lag: LAG }, ['on']) },
    checklist: { type: 'array', items: { type: ['string', 'object'] } },
  }, ['title']),
};

// Examples address test/fixtures/plan-sample.json; the draft dddddddd-…-0001 is a draft of its thread in the sample
// context of test/plan-commands.test.mjs.
const SAMPLE = '3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21';
const ex = (...list) => list.map((args) => ({ args: { planId: SAMPLE, ...args } }));

// One descriptor; `props` / `required` are the args besides planId, `more` overrides any field.
const cmd = (id, title, risk, props, required, build, more = {}) => ({
  id, title, group: 'plan', risk, undo: risk === 'read' ? 'none' : 'own', needs: [],
  args: obj({ planId: ID, ...props }, ['planId', ...required]), result: { type: 'object' }, ...more, ...(build && { plan: build }),
});

const numOf = (plan, id) => `#${plan.tickets.find((t) => t.id === id).num}`;

export const PLAN_COMMANDS = [
  // plans
  cmd('plan.list', 'List the plans', 'read', {}, [], null, {
    args: obj({}),
    examples: [{ args: {} }],
    read: (ctx) => ctx.plans.map((plan) => {
      const c = { ...ctx, plan };
      const done = doneColumnOf(plan);
      const { byId } = schedule(c);
      const closed = plan.tickets.filter((t) => statusOf(t, c) === done).length;
      return { id: plan.id, threadUrl: plan.threadUrl, title: plan.title, open: plan.tickets.length - closed, done: closed,
        blocked: plan.tickets.filter((t) => byId[t.id].blocked).length, updated: plan.updated ?? null };
    }),
  }),
  cmd('plan.get', 'Read a plan', 'read', {}, [], null, {
    // planId or threadUrl (dispatch builds ctx from either)
    args: obj({ planId: ID, threadUrl: { type: 'string' }, include: { type: 'array', items: { enum: ['schedule', 'cards', 'tree'] } } }),
    examples: ex({ include: ['schedule'] }),
    read: (ctx, a) => ({
      plan: ctx.plan,
      ...(a.include?.includes('schedule') && { schedule: schedule(ctx) }),
      ...(a.include?.includes('cards') && { cards: cards(ctx) }),
      ...(a.include?.includes('tree') && { tree: tree(ctx.plan) }),
    }),
  }),
  cmd('plan.create', "Create the plan of a thread", 'write', {}, [], (ctx, a) => {
    const url = String(a.threadUrl).replace(/[?#].*$/, '');
    if (!/^https:\/\/daf\.staffs\.ac\.uk\/topic\/\d+\S*$/.test(url)) return { error: { code: 'invalid_args', message: 'threadUrl is a forum topic url' } };
    if (ctx.plans?.some((p) => p.threadUrl === url)) return { error: { code: 'already_exists', message: 'The thread already has a plan (one plan per thread)' } };
    const plan = newPlan(url, a.title ?? '', ctx.tags);
    return { plan, result: { planId: plan.id } };
  }, {
    undo: 'none',
    args: obj({ threadUrl: { type: 'string', pattern: '^https://daf\\.staffs\\.ac\\.uk/topic/\\d+\\S*$' }, title: { type: 'string', maxLength: 120 } }, ['threadUrl']),
    examples: [{ args: { threadUrl: 'https://daf.staffs.ac.uk/topic/90001-portfolio-dev-thread/', title: 'Portfolio dev thread' } }],
  }),
  cmd('plan.update', 'Change plan settings', 'write', {
    patch: obj({ title: { type: 'string', maxLength: 120 }, calendar: obj({ workdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1 }, weekOne: DATE_OR_NULL }),
      autoSchedule: BOOL, doneColumn: COL, estimateUnit: NAME }),
  }, ['patch'], (ctx, a) => updatePlan(ctx, a.patch), { examples: ex({ patch: { calendar: { weekOne: '2026-09-21' }, estimateUnit: 'pt' } }) }),
  cmd('plan.delete', 'Delete a plan (to the trash)', 'destructive', {}, [], null, { undo: 'none', examples: ex({}) }),
  cmd('plan.holidays.add', 'Add a holiday', 'write', { date: DATE }, ['date'], (ctx, a) => addHoliday(ctx, a.date), { examples: ex({ date: '2026-12-24' }) }),
  cmd('plan.holidays.remove', 'Remove a holiday', 'destructive', { date: DATE }, ['date'], (ctx, a) => removeHoliday(ctx, a.date), { examples: ex({ date: '2026-12-25' }) }),

  // columns
  cmd('plan.columns.add', 'Add a column', 'write', {
    column: obj({ name: { type: 'string', maxLength: 40 }, color: COLOR, tagId: { type: ['string', 'null'], maxLength: 64 }, wip: { type: ['integer', 'null'], minimum: 1 } }, ['name']), beforeId: COL,
  }, ['column'], (ctx, a) => addColumn(ctx, a.column, a.beforeId), { needs: ['plan.columnRoom'], examples: ex({ column: { name: 'Blocked', wip: 2 }, beforeId: 'Done' }) }),
  cmd('plan.columns.update', 'Change a column', 'write', {
    columnId: COL, patch: obj({ name: { type: 'string', maxLength: 40 }, color: COLOR, tagId: { type: ['string', 'null'], maxLength: 64 }, wip: { type: ['integer', 'null'], minimum: 1 } }),
  }, ['columnId', 'patch'], (ctx, a) => updateColumn(ctx, a.columnId, a.patch), { examples: ex({ columnId: 'In progress', patch: { wip: 3 } }) }),
  cmd('plan.columns.move', 'Move a column', 'write', { columnId: COL, beforeId: COL, afterId: COL }, ['columnId'],
    (ctx, a) => moveColumn(ctx, a.columnId, a.beforeId, a.afterId), { examples: ex({ columnId: 'Review', afterId: 'Done' }) }),
  cmd('plan.columns.remove', 'Delete a column', 'destructive', { columnId: COL, moveTo: COL }, ['columnId'],
    (ctx, a) => removeColumn(ctx, a.columnId, a.moveTo), { needs: ['plan.otherColumn'], examples: ex({ columnId: 'Review', moveTo: 'To do' }) }),

  // units, labels, views
  cmd('plan.units.add', 'Add an estimate unit', 'write', { unit: obj({ name: { type: 'string', maxLength: 12 }, daysPer: { type: 'number', minimum: 0.001 } }, ['name', 'daysPer']) }, ['unit'],
    (ctx, a) => addUnit(ctx, a.unit), { examples: ex({ unit: { name: 'h', daysPer: 0.125 } }) }),
  cmd('plan.units.update', 'Change an estimate unit', 'write', { unitId: NAME, patch: obj({ name: { type: 'string', maxLength: 12 }, daysPer: { type: 'number', minimum: 0.001 } }) }, ['unitId', 'patch'],
    (ctx, a) => updateUnit(ctx, a.unitId, a.patch), { examples: ex({ unitId: 'pt', patch: { daysPer: 0.25 } }) }),
  cmd('plan.units.remove', 'Delete an estimate unit (its estimates become days)', 'destructive', { unitId: NAME }, ['unitId'],
    (ctx, a) => removeUnit(ctx, a.unitId), { examples: ex({ unitId: 'pt' }) }),
  cmd('plan.labels.add', 'Add a label', 'write', { label: obj({ name: { type: 'string', maxLength: 40 }, color: COLOR }, ['name']) }, ['label'],
    (ctx, a) => addLabel(ctx, a.label), { examples: ex({ label: { name: 'Code' } }) }),
  cmd('plan.labels.update', 'Change a label', 'write', { labelId: NAME, patch: obj({ name: { type: 'string', maxLength: 40 }, color: COLOR }) }, ['labelId', 'patch'],
    (ctx, a) => updateLabel(ctx, a.labelId, a.patch), { examples: ex({ labelId: 'Art', patch: { color: '#e05252' } }) }),
  cmd('plan.labels.remove', 'Delete a label', 'destructive', { labelId: NAME }, ['labelId'], (ctx, a) => removeLabel(ctx, a.labelId), { examples: ex({ labelId: 'Art' }) }),
  cmd('plan.views.add', 'Save a view', 'write', { view: obj({ name: { type: 'string', maxLength: 40 }, view: VIEW, options: OPTIONS }, ['name', 'view']) }, ['view'],
    (ctx, a) => addView(ctx, a.view), { examples: ex({ view: { name: 'Critical path', view: 'gantt', options: { showCritical: true } } }) }),
  cmd('plan.views.update', 'Change a saved view', 'write', { viewId: NAME, patch: obj({ name: { type: 'string', maxLength: 40 }, view: VIEW, options: OPTIONS }) }, ['viewId', 'patch'],
    (ctx, a) => updateView(ctx, a.viewId, a.patch), { examples: ex({ viewId: 'This sprint', patch: { options: { hideDone: false } } }) }),
  cmd('plan.views.remove', 'Delete a saved view', 'destructive', { viewId: NAME }, ['viewId'], (ctx, a) => removeView(ctx, a.viewId), { examples: ex({ viewId: 'This sprint' }) }),

  // tickets
  cmd('plan.tickets.create', 'Create a ticket', 'write', { ticket: NEW_TICKET, beforeId: REF }, ['ticket'], (ctx, a) => addTicket(ctx, a.ticket, a.beforeId), {
    examples: ex({ ticket: { title: 'Lighting pass', status: 'To do', labels: ['Art'], estimate: 4, unit: 'pt', start: '2026-10-14', days: 2, deps: [{ on: '#3' }], checklist: ['Bake'] } }),
  }),
  cmd('plan.tickets.update', 'Change tickets', 'write', { ticketIds: REFS, patch: obj(TICKET_PATCH) }, ['ticketIds', 'patch'],
    (ctx, a) => updateTicket(ctx, a.ticketIds, a.patch), { examples: ex({ ticketIds: ['#2'], patch: { start: '2026-10-08', end: '2026-10-12', progress: 50 } }) }),
  cmd('plan.tickets.move', 'Move tickets to a column', 'write', { ticketIds: REFS, status: COL, beforeId: REF, afterId: REF, createTag: { type: 'boolean', default: false } },
    ['ticketIds', 'status'], (ctx, a) => moveTicket(ctx, a.ticketIds, a.status, a.beforeId, a.afterId, { createTag: a.createTag }), {
      examples: ex({ ticketIds: ['#2'], status: 'done' }, { ticketIds: ['dddddddd-0000-4000-8000-000000000001'], status: 'Review', createTag: true }),
    }),
  cmd('plan.tickets.reorder', 'Reorder tickets', 'write', { ticketIds: REFS, beforeId: REF, afterId: REF }, ['ticketIds'],
    (ctx, a) => reorder(ctx, a.ticketIds, a.beforeId, a.afterId), { examples: ex({ ticketIds: ['#6'], beforeId: '#2' }) }),
  cmd('plan.tickets.delete', 'Delete tickets', 'destructive', { ticketIds: REFS }, ['ticketIds'], (ctx, a) => removeTickets(ctx, a.ticketIds), { examples: ex({ ticketIds: ['#6'] }) }),

  // a ticket's sub-lists
  cmd('plan.deps.add', 'Add a dependency', 'write', { from: REF, to: REF, type: DEP_TYPE, lag: LAG }, ['from', 'to'],
    (ctx, a) => addDep(ctx, a.from, a.to, a.type, a.lag), { examples: ex({ from: '#2', to: '#6', type: 'FS', lag: 1 }) }),
  cmd('plan.deps.update', 'Change a dependency', 'write', { from: REF, to: REF, patch: obj({ type: DEP_TYPE, lag: LAG }) }, ['from', 'to', 'patch'],
    (ctx, a) => updateDep(ctx, a.from, a.to, a.patch), { examples: ex({ from: '#3', to: '#6', patch: { lag: 2 } }) }),
  cmd('plan.deps.remove', 'Remove a dependency', 'write', { from: REF, to: REF }, ['from', 'to'], (ctx, a) => removeDep(ctx, a.from, a.to), { examples: ex({ from: '#2', to: '#4' }) }),
  cmd('plan.tickets.labels.add', 'Label tickets', 'write', { ticketIds: REFS, labelId: NAME, replace: NAME }, ['ticketIds', 'labelId'],
    (ctx, a) => addTicketLabel(ctx, a.ticketIds, a.labelId, a.replace), { examples: ex({ ticketIds: ['#2', '#4'], labelId: 'Art' }) }),
  cmd('plan.tickets.labels.remove', 'Remove a label from tickets', 'write', { ticketIds: REFS, labelId: NAME }, ['ticketIds', 'labelId'],
    (ctx, a) => removeTicketLabel(ctx, a.ticketIds, a.labelId), { examples: ex({ ticketIds: ['#1'], labelId: 'Art' }) }),
  cmd('plan.checklist.add', 'Add a checklist item', 'write', { ticketId: REF, item: obj({ text: { type: 'string', maxLength: 200 }, done: BOOL }, ['text']), beforeId: SID },
    ['ticketId', 'item'], (ctx, a) => addCheck(ctx, a.ticketId, a.item, a.beforeId), { examples: ex({ ticketId: '#1', item: { text: 'Collision' }, beforeId: 'k1q8z3v' }) }),
  cmd('plan.checklist.update', 'Change a checklist item', 'write', { ticketId: REF, itemId: SID, patch: obj({ text: { type: 'string', maxLength: 200 }, done: BOOL }) },
    ['ticketId', 'itemId', 'patch'], (ctx, a) => updateCheck(ctx, a.ticketId, a.itemId, a.patch), { examples: ex({ ticketId: '#1', itemId: 'k1q8z3v', patch: { done: false } }) }),
  cmd('plan.checklist.move', 'Move a checklist item', 'write', { ticketId: REF, itemId: SID, beforeId: SID, afterId: SID }, ['ticketId', 'itemId'],
    (ctx, a) => moveCheck(ctx, a.ticketId, a.itemId, a.beforeId, a.afterId), { examples: ex({ ticketId: '#1', itemId: 'k1q8z3v', afterId: 'm2w7r4t' }) }),
  cmd('plan.checklist.remove', 'Delete a checklist item', 'destructive', { ticketId: REF, itemId: SID }, ['ticketId', 'itemId'],
    (ctx, a) => removeCheck(ctx, a.ticketId, a.itemId), { examples: ex({ ticketId: '#1', itemId: 'm2w7r4t' }) }),
  cmd('plan.urls.add', 'Add a link', 'write', { ticketId: REF, url: obj({ url: WEB, title: { type: 'string', maxLength: 80 } }, ['url']) }, ['ticketId', 'url'],
    (ctx, a) => addUrl(ctx, a.ticketId, a.url), { examples: ex({ ticketId: '#3', url: { url: 'https://example.com/ref', title: 'Reference' } }) }),
  cmd('plan.urls.update', 'Change a link', 'write', { ticketId: REF, urlId: SID, patch: obj({ url: WEB, title: { type: 'string', maxLength: 80 } }) }, ['ticketId', 'urlId', 'patch'],
    (ctx, a) => updateUrl(ctx, a.ticketId, a.urlId, a.patch), { examples: ex({ ticketId: '#1', urlId: 'u3n8c5w', patch: { title: 'Tutor feedback' } }) }),
  cmd('plan.urls.remove', 'Delete a link', 'destructive', { ticketId: REF, urlId: SID }, ['ticketId', 'urlId'], (ctx, a) => removeUrl(ctx, a.ticketId, a.urlId), { examples: ex({ ticketId: '#1', urlId: 'u3n8c5w' }) }),

  // schedule
  cmd('plan.schedule', 'Read the schedule', 'read', {}, [], null, {
    examples: ex({}),
    read: (ctx) => {
      const { byId, span } = schedule(ctx);
      const flagged = (key) => ctx.plan.tickets.filter((t) => byId[t.id].scheduled && !byId[t.id].summary && byId[t.id][key]).map((t) => `#${t.num}`);
      return { byId, byNum: Object.fromEntries(Object.entries(byId).map(([id, n]) => [numOf(ctx.plan, id), { id, ...n }])), span, critical: flagged('critical'), conflicts: flagged('conflict') };
    },
  }),
  cmd('plan.schedule.apply', 'Move conflicting tickets to their earliest start', 'write', {}, [], (ctx) => {
    const plan = autoScheduled(ctx.plan, ctx);
    return { plan, result: { moved: plan.tickets.filter((t, i) => t !== ctx.plan.tickets[i]).length } };
  }, { examples: ex({}) }),
  cmd('plan.ready', 'List the tickets ready to start', 'read', {}, [], null, {
    examples: ex({}),
    read: (ctx) => ready(ctx).map((t) => ({ id: t.id, num: t.num, title: t.title, status: statusOf(t, ctx), start: t.start })),
  }),
  cmd('plan.baseline.set', 'Set the baseline', 'write', {}, [], (ctx) => setBaseline(ctx), { examples: ex({}) }),
  cmd('plan.baseline.clear', 'Clear the baseline', 'write', {}, [], (ctx) => clearBaseline(ctx), { examples: ex({}) }),
  cmd('plan.import', 'Import tasks', 'write', { tasks: IMPORT_TASKS }, ['tasks'], (ctx, a) => importTasks(ctx, a.tasks), {
    examples: ex({ tasks: [{ tempId: 'a', title: 'Polish', days: 2, start: '2026-10-19' }, { tempId: 'b', title: 'Trailer', deps: [{ on: 'a' }, { on: '#5' }], start: '2026-10-21', end: '2026-10-21' }] }),
  }),
  cmd('plan.describe', 'Describe the plan as text', 'read', { format: { enum: ['markdown', 'mermaid', 'json'] } }, ['format'], null, {
    examples: ex({ format: 'mermaid' }), read: (ctx, a) => ({ text: describe(ctx, a.format) }),
  }),

  // imperative (bodies in src/app/plans.js)
  cmd('plan.insertChart', 'Insert a plan chart into the draft', 'write', { view: VIEW, options: OPTIONS, viewId: NAME, at: { enum: ['cursor', 'end'] }, frozen: { type: 'boolean', default: false } },
    ['view'], null, { undo: 'doc', needs: ['doc.open'], examples: ex({ view: 'kanban', at: 'end' }) }),
  cmd('plan.chart.set', 'Change a plan chart', 'write', {}, [], null, {
    undo: 'doc', needs: ['doc.open'], examples: [{ args: { id: 'q7w3e9r', patch: { view: 'gantt' } } }],
    args: obj({ id: SID, patch: obj({ view: VIEW, options: OPTIONS, dw: { type: ['number', 'null'], minimum: 40 }, planId: ID, frozen: BOOL }) }, ['id', 'patch']),
  }),
  cmd('plan.chart.list', 'List the plan charts of the draft', 'read', {}, [], null, { needs: ['doc.open'], args: obj({}), examples: [{ args: {} }] }),
  cmd('plan.render', 'Render a plan chart to an image', 'read', {}, [], null, {
    args: obj({ planId: ID, chartId: SID, view: VIEW, options: OPTIONS, width: { type: 'integer', minimum: 320, maximum: 4000 }, theme: { enum: ['dark', 'light'] } }),
    examples: ex({ view: 'gantt', width: 1200 }),
  }),
  cmd('plan.open', 'Open the plan workspace', 'write', { tab: { enum: ['board', 'backlog', 'gantt'] } }, [], null, { undo: 'none', examples: ex({ tab: 'gantt' }) }),
  cmd('plan.close', 'Back to the editor', 'write', {}, [], null, { undo: 'none', args: obj({}), examples: [{ args: {} }] }),
  cmd('plan.undo', 'Undo the last plan change', 'write', {}, [], null, { examples: ex({}) }),
  cmd('plan.redo', 'Redo a plan change', 'write', {}, [], null, { examples: ex({}) }),
];

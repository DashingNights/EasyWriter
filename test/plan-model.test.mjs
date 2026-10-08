import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_TAGS } from '../src/app/drafts-meta.js';
import * as M from '../src/plan/plan-model.mjs';

const {
  addCheck, addColumn, addDep, addLabel, addTicket, addTicketLabel, addUnit, addUrl, cards, columnsOf, describe, estimateDays,
  filterTickets, importTasks, linkDraft, moveCheck, moveTicket, newPlan, parsePlan, removeCheck, removeColumn, removeLabel,
  removeTickets, removeUnit, removeUrl, statusOf, summary, syncCompleted, unlinkDraft, unmapTag, updateCheck, updateColumn,
  updateDep, updateTicket, updateUnit, wipState,
} = M;

const fixture = JSON.parse(readFileSync(new URL('./fixtures/plan-sample.json', import.meta.url), 'utf8'));
const THREAD = fixture.threadUrl;
const D1 = 'dddddddd-0000-4000-8000-000000000001';
const D2 = 'dddddddd-0000-4000-8000-000000000002';
const context = (patch = {}) => ({
  plan: parsePlan(fixture),
  tags: DEFAULT_TAGS,
  drafts: [{ id: D1, title: 'Week 3 post', threadUrl: THREAD, pushedAt: null }, { id: D2, title: 'Week 4 post', threadUrl: THREAD, pushedAt: 1759600000000 }],
  draftTags: { [D1]: 'progress' },
  today: '2026-10-06',
  ...patch,
});
const t = (plan, n) => plan.tickets.find((x) => x.num === n);
const others = (plan, n) => plan.tickets.filter((x) => x.num !== n);
// ctx with ticket #n linked to `draftId` (the draft keeps its tag).
const linked = (n, draftId, draftTags) => {
  const ctx = context(draftTags && { draftTags });
  return { ...ctx, plan: { ...ctx.plan, tickets: ctx.plan.tickets.map((x) => (x.num === n ? { ...x, draftId } : x)) } };
};

test('parsePlan fills defaults, drops invalid parts and maps an unknown status to null', () => {
  const T1 = '11111111-0000-4000-8000-000000000001';
  const T2 = '11111111-0000-4000-8000-000000000002';
  const p = parsePlan({
    id: 'nope', threadUrl: `${THREAD}?page=2#x`, labels: [{ id: 'a1b2c3d', name: 'Art', color: 'red' }],
    columns: [{ id: 'todo', name: ' ' }, { id: 'todo', name: 'dup' }, { id: 'BAD!', name: 'x' }, { id: 'done', name: 'Done', tagId: 'x' }, { id: 'more', tagId: 'x' }],
    units: [{ id: 'p4t8x2q', name: 'pt', daysPer: 0 }, { id: 'h0h0h0h', name: 'D', daysPer: 1 }],
    tickets: [
      { id: T1, num: 2, title: 'A', status: 'nope', labels: ['a1b2c3d', 'zzzzzzz'], start: '2026-10-09', end: '2026-10-05', deps: [{ on: T2 }, { on: 'gone' }, { on: T1 }], unit: 'p4t8x2q' },
      { id: T2, title: 'B', start: '2026-02-30', end: '2026-03-02', urls: [{ url: 'https://x.y/', title: 'X' }, { url: 'ftp://x' }], checklist: [{ text: 'c' }] },
      { id: 'not-a-uuid', title: 'C' },
      { id: T1, title: 'dup' },
    ],
    order: ['gone', T1],
  });
  assert.match(p.id, /^[a-f0-9-]{36}$/);
  assert.equal(p.threadUrl, THREAD);
  assert.deepEqual(p.columns.map((c) => [c.id, c.name, c.tagId]), [['todo', 'Column 1', null], ['done', 'Done', 'x'], ['more', 'Column 3', null]]);
  assert.equal(p.doneColumn, 'more'); // missing → the last column
  assert.deepEqual([p.units, p.estimateUnit, p.labels[0].color], [[], 'd', M.COLORS[0]]);
  assert.deepEqual(p.tickets.map((x) => x.id), [T1, T2]);
  const [a, b] = p.tickets;
  assert.deepEqual([a.status, b.status], [null, 'todo']); // unknown → null; missing → the first column
  assert.deepEqual([a.labels, a.unit, a.start, a.end], [['a1b2c3d'], 'd', '2026-10-09', '2026-10-09']); // end ≥ start
  assert.deepEqual(a.deps, [{ on: T2, type: 'FS', lag: 0 }]);
  assert.deepEqual([b.num, p.seq, b.start, b.end], [3, 3, null, null]);
  assert.deepEqual(b.urls.map((u) => [u.url, u.title, /^[a-z0-9]{7}$/.test(u.id)]), [['https://x.y/', 'X', true]]); // a link without id gets one
  assert.match(b.checklist[0].id, /^[a-z0-9]{7}$/);
  assert.deepEqual(p.order, [T2, T1]); // missing first, stale dropped
  assert.deepEqual(parsePlan(p), p); // idempotent
  assert.deepEqual(parsePlan('{broken').columns.map((c) => c.id), ['todo', 'progress', 'done']);
});

test('newPlan seeds To do / In progress / Done, following only the tags that exist', () => {
  const p = newPlan(THREAD, 'Thread', [{ id: 'todo', name: 'To do', color: '#e5e5e5' }, { id: 'done', name: 'Done', color: '#62d926' }]);
  assert.deepEqual(p.columns.map((c) => [c.id, c.name, c.color, c.tagId, c.wip]),
    [['todo', 'To do', '#e5e5e5', 'todo', null], ['progress', 'In progress', '#3d99f5', null, null], ['done', 'Done', '#62d926', 'done', null]]);
  assert.deepEqual([p.doneColumn, p.seq, p.tickets, p.calendar.weekOne, p.title], ['done', 0, [], null, 'Thread']); // weekOne off until set
});

test('columns: one column per tag, the 10-column limit, and removal with a target', () => {
  const ctx = context();
  assert.equal(addColumn(ctx, { name: 'Again', tagId: 'todo' }).error.code, 'tag_taken');
  assert.equal(updateColumn(ctx, 'Review', { tagId: 'progress' }).error.code, 'tag_taken');
  assert.equal(updateColumn(ctx, 'Review', { tagId: 'no-such-tag' }).error.code, 'not_found');
  const added = addColumn(ctx, { name: '' }, 'Done');
  assert.deepEqual(added.plan.columns.map((c) => c.name), ['To do', 'In progress', 'Review', 'Column 4', 'Done']);
  assert.equal(added.plan.columns[3].color, M.COLORS[4]); // the first colour no column has
  let full = ctx;
  while (full.plan.columns.length < 10) full = { ...ctx, plan: addColumn(full, { name: 'More' }).plan };
  assert.equal(addColumn(full, { name: 'Eleventh' }).error.code, 'precondition_failed');

  // #2 (unlinked) and #3 (linked to D1, tagged 'progress') sit in 'In progress'
  const lctx = linked(3, D1);
  const r = removeColumn(lctx, 'progress', 'Review');
  assert.equal(r.result.moved, 1);
  assert.equal(t(r.plan, 2).status, 'r7k2m9q');
  assert.equal(r.draftTags, undefined); // no settings write
  assert.equal(statusOf(t(r.plan, 3), { ...lctx, plan: r.plan }), null); // the draft keeps its tag, which no column maps now
  assert.equal(removeColumn(ctx, 'progress').plan.tickets.filter((x) => x.status === 'todo').length, 5); // left neighbour
  const noDone = removeColumn(ctx, 'done', null);
  assert.deepEqual([noDone.plan.doneColumn, t(noDone.plan, 1).status], ['r7k2m9q', null]);
  assert.equal(removeColumn(ctx, 'Review', 'Review').error.code, 'invalid_args');
  const single = { ...ctx, plan: { ...ctx.plan, columns: [ctx.plan.columns[0]] } };
  assert.equal(removeColumn(single, 'todo').error.code, 'precondition_failed');
});

test('every per-entry reducer changes only the entry it names', () => {
  const ctx = context();
  const a0 = t(ctx.plan, 1);
  const same = (r, n = 1) => assert.deepEqual(others(r.plan, n), others(ctx.plan, n));

  let r = addCheck(ctx, '#1', { text: 'Collision' }, 'm2w7r4t');
  same(r);
  assert.deepEqual(t(r.plan, 1).checklist.map((c) => c.text), ['Greybox', 'Collision', 'Lighting notes']);
  r = updateCheck(ctx, '#1', 'm2w7r4t', { done: true });
  assert.deepEqual(t(r.plan, 1).checklist, [a0.checklist[0], { ...a0.checklist[1], done: true }]);
  r = moveCheck(ctx, '#1', 'k1q8z3v', null, 'm2w7r4t');
  assert.deepEqual(t(r.plan, 1).checklist, [a0.checklist[1], a0.checklist[0]]);
  r = removeCheck(ctx, '#1', 'k1q8z3v');
  assert.deepEqual(t(r.plan, 1).checklist, [a0.checklist[1]]);
  r = addUrl(ctx, '#1', { url: 'https://example.com/' });
  assert.deepEqual(t(r.plan, 1).urls.slice(0, 1), a0.urls);
  assert.equal(removeUrl(ctx, '#1', 'u3n8c5w').plan.tickets[0].urls.length, 0);

  const f0 = t(ctx.plan, 6);
  const withB = addDep(ctx, '#2', '#6');
  r = updateDep({ ...ctx, plan: withB.plan }, '#3', '#6', { lag: 2 });
  assert.deepEqual(t(r.plan, 6).deps, [{ ...f0.deps[0], lag: 2 }, { on: t(ctx.plan, 2).id, type: 'FS', lag: 0 }]);
  same(r, 6);
  assert.equal(addDep(ctx, '#3', '#6').error.code, 'exists');

  for (const bad of [updateCheck(ctx, '#1', 'zzzzzzz', { done: true }), removeUrl(ctx, '#1', 'zzzzzzz'), updateDep(ctx, '#1', '#6', { lag: 1 }),
    removeCheck(ctx, '#99', 'k1q8z3v'), updateColumn(ctx, 'nope', { name: 'x' }), removeLabel(ctx, 'nope')]) {
    assert.equal(bad.error.code, 'not_found');
  }
});

test('updateTicket takes field sets only; labels swap with replace on every named ticket', () => {
  const ctx = context();
  for (const key of ['deps', 'checklist', 'labels', 'urls', 'status']) assert.equal(updateTicket(ctx, ['#1'], { [key]: [] }).error.code, 'invalid_args');
  assert.equal(updateTicket(ctx, ['#1'], { start: '2026-10-05' }).error.code, 'invalid_args'); // start without end
  const r = updateTicket(ctx, ['#2', '#4'], { priority: 3, title: 'Renamed' });
  assert.deepEqual([t(r.plan, 2).priority, t(r.plan, 4).title, t(r.plan, 3)], [3, 'Renamed', t(ctx.plan, 3)]);
  assert.deepEqual(t(updateTicket(ctx, ['#2'], { milestone: true }).plan, 2).end, '2026-10-08'); // a milestone ends on its start

  const code = addLabel(ctx, { name: 'Code' });
  const c2 = { ...ctx, plan: code.plan };
  const swapped = addTicketLabel(c2, ['#1', '#3', '#2'], 'Code', 'Art');
  assert.deepEqual([1, 3, 2].map((n) => t(swapped.plan, n).labels), [[code.result.labelId], [code.result.labelId], [code.result.labelId]]);
  assert.deepEqual(removeLabel(ctx, 'Art').plan.tickets.map((x) => x.labels), [[], [], [], [], [], []]);
  assert.equal(removeLabel(ctx, 'Art').result.tickets, 2);
});

test('derived status: linked tickets and draft cards follow their draft\'s tag through column.tagId', () => {
  const st = (ctx) => statusOf(t(ctx.plan, 2), ctx);
  assert.equal(st(linked(2, D1)), 'progress'); // mapped tag
  assert.equal(st(linked(2, D1, { [D1]: 'review' })), null); // a tag no column maps (unknown to ctx.tags)
  assert.equal(st(linked(2, D1, {})), null); // untagged
  const reviewTag = { id: 'review', name: 'Review', color: '#e09952' };
  const tagged = { ...linked(2, D1, { [D1]: 'review' }), tags: [...DEFAULT_TAGS, reviewTag] };
  assert.equal(st(tagged), null); // the tag exists but no column follows it
  const ghost = { ...linked(2, D1), tags: DEFAULT_TAGS.filter((x) => x.id !== 'progress') };
  assert.equal(st(ghost), null); // the column's tagId names a tag missing from settings
  const ctx = context();
  const draftCards = cards(ctx).filter((c) => c.kind === 'draft');
  assert.deepEqual(draftCards.map((c) => [c.id, c.status]), [[D1, 'progress'], [D2, null]]);
  assert.deepEqual(cards(linked(2, D1)).filter((c) => c.kind === 'draft').map((c) => c.id), [D2]); // a linked draft's card is hidden
  assert.deepEqual(columnsOf(ctx).map((c) => c.id), [null, 'todo', 'progress', 'r7k2m9q', 'done']);
  assert.deepEqual(columnsOf(ctx, { showDrafts: false }).map((c) => c.id), ['todo', 'progress', 'r7k2m9q', 'done']);
  assert.deepEqual(wipState(ctx).progress, { count: 3, limit: null, over: false });
});

test('moveTicket: linked cards change draftTags only; an unmapped column asks for createTag', () => {
  const ctx = linked(2, D1);
  const r = moveTicket(ctx, ['#2', D2], 'done');
  assert.deepEqual(r.plan.tickets, ctx.plan.tickets); // the plan does not change
  assert.deepEqual(r.draftTags, { [D1]: 'done', [D2]: 'done' });
  assert.deepEqual(moveTicket(ctx, [D1], null).draftTags, {}); // "No status" clears the tag
  const plain = moveTicket(ctx, ['#4'], 'Review', '#2');
  assert.deepEqual([t(plain.plan, 4).status, plain.draftTags, plain.plan.order.indexOf(t(ctx.plan, 4).id)], ['r7k2m9q', undefined, 1]);
  assert.equal(moveTicket(ctx, ['#4'], 'Review', '#99').error.code, 'not_found');
  assert.deepEqual(moveTicket(ctx, ['#4'], 'Review', D2).plan.order, ctx.plan.order); // above a draft card: status only

  const refused = moveTicket(ctx, ['#4', '#2'], 'Review');
  assert.equal(refused.error.code, 'unmapped_column');
  assert.deepEqual(refused.error.data, { columnId: 'r7k2m9q', name: 'Review', color: '#e09952', tagId: null });
  const made = moveTicket(ctx, ['#4', '#2'], 'Review', undefined, undefined, { createTag: true });
  const tag = made.tags.at(-1);
  assert.deepEqual([tag.name, tag.color, made.result.created], ['Review', '#e09952', true]);
  assert.equal(made.plan.columns[2].tagId, tag.id);
  assert.deepEqual([made.draftTags[D1], t(made.plan, 4).status], [tag.id, 'r7k2m9q']);
  const existing = { ...ctx, tags: [...DEFAULT_TAGS, { id: 'rv', name: ' review ', color: '#000000' }] };
  const used = moveTicket(existing, [D2], 'Review', undefined, undefined, { createTag: true });
  assert.deepEqual([used.tags, used.result, used.draftTags[D2]], [undefined, { tagId: 'rv', created: false }, 'rv']); // matchingTag
  assert.equal(M.canDrop(ctx, { kind: 'ticket', ticket: t(ctx.plan, 4) }, 'r7k2m9q'), true);
  assert.equal(M.canDrop(ctx, { kind: 'draft' }, 'r7k2m9q'), 'unmapped_column');
});

test('link and unlink copy rules', () => {
  const ctx = context({ draftTags: { [D2]: 'todo' } });
  const fromMapped = linkDraft(ctx, '#2', D2); // #2 sits in 'In progress', which follows 'progress'
  assert.deepEqual([fromMapped.draftTags[D2], t(fromMapped.plan, 2).draftId], ['progress', D2]);
  const review = moveTicket(ctx, ['#2'], 'Review').plan;
  const fromUnmapped = linkDraft({ ...ctx, plan: review }, '#2', D2);
  assert.deepEqual([fromUnmapped.draftTags, fromUnmapped.result.status], [undefined, 'todo']); // the draft keeps its tag
  assert.equal(statusOf(t(fromUnmapped.plan, 2), ctx), 'todo');
  const back = unlinkDraft({ ...ctx, plan: fromUnmapped.plan }, '#2');
  assert.deepEqual([t(back.plan, 2).draftId, t(back.plan, 2).status], [null, 'todo']); // keeps the derived column
  assert.equal(linkDraft({ ...ctx, plan: fromMapped.plan }, '#3', D2).error.code, 'exists');
  assert.equal(linkDraft(ctx, '#3', '99999999-0000-4000-8000-000000000000').error.code, 'not_found');
  const pruned = M.pruneDrafts({ ...ctx, plan: fromMapped.plan, drafts: [] });
  assert.deepEqual([t(pruned.plan, 2).draftId, t(pruned.plan, 2).status], [null, 'todo']);
  assert.equal(M.pruneDrafts(ctx).plan, ctx.plan);
});

test('unmapTag and completedAt with a custom done column', () => {
  const ctx = context();
  const r = unmapTag(ctx, 'progress');
  assert.deepEqual(r.plan.columns.map((c) => c.tagId), ['todo', null, null, 'done']);
  assert.equal(unmapTag(ctx, 'nothing').plan, ctx.plan);
  const custom = { ...ctx, plan: { ...ctx.plan, doneColumn: 'r7k2m9q' } };
  const moved = moveTicket(custom, ['#2'], 'Review').plan;
  const synced = syncCompleted({ ...custom, plan: moved }).plan;
  assert.equal(typeof t(synced, 2).completedAt, 'number');
  assert.equal(t(synced, 1).completedAt, null); // 'done' is not the done column here
  const left = syncCompleted({ ...custom, plan: moveTicket({ ...custom, plan: synced }, ['#2'], 'todo').plan }).plan;
  assert.equal(t(left, 2).completedAt, null);
  assert.equal(syncCompleted(ctx).plan, ctx.plan);
});

test('estimate units: checks, removal converts to days, sums and summaries in days', () => {
  const ctx = context();
  for (const unit of [{ name: 'h', daysPer: 0 }, { name: 'h', daysPer: -1 }, { name: 'PT', daysPer: 1 }, { name: 'd', daysPer: 1 }, { name: ' ', daysPer: 1 }]) {
    assert.equal(addUnit(ctx, unit).error.code, 'bad_unit', JSON.stringify(unit));
  }
  assert.equal(updateUnit(ctx, 'pt', { daysPer: 0 }).error.code, 'bad_unit');
  assert.equal(updateUnit(ctx, 'pt', { name: 'D' }).error.code, 'bad_unit');
  assert.equal(estimateDays(ctx.plan, t(ctx.plan, 2)), 2); // 4 pt × 0.5
  const asDefault = M.updatePlan(ctx, { estimateUnit: 'pt' });
  const r = removeUnit({ ...ctx, plan: asDefault.plan }, 'pt');
  assert.deepEqual([t(r.plan, 2).estimate, t(r.plan, 2).unit, r.plan.estimateUnit, r.result.converted], [2, 'd', 'd', 1]);
  const parent = addTicket(ctx, { title: 'Level 1' });
  const tree = M.setParent({ ...ctx, plan: parent.plan }, ['#2', '#3'], parent.result.ticketId).plan;
  assert.deepEqual(summary(tree, parent.result.ticketId), { start: '2026-10-08', end: '2026-10-13', progress: 27, estimateDays: 6 }); // (40·2 + 20·4) / 6
  assert.equal(summary(tree, t(tree, 1).id), null);
});

test('importTasks resolves temp ids, lets end win over days, defaults priority to Medium and refuses a cycle as a whole', () => {
  const ctx = context();
  const r = importTasks(ctx, [
    { tempId: 'p', title: 'Polish' },
    { tempId: 'a', title: 'Audio', parent: 'p', start: '2026-10-19', days: 3, labels: ['Art'], unit: 'pt', estimate: 2 },
    { tempId: 'b', title: 'Build', parent: 'p', start: '2026-10-19', end: '2026-10-20', days: 9, deps: [{ on: 'a', type: 'SS' }, { on: '#5' }], priority: 0 },
  ]);
  const [p, a, b] = r.result.created.map((c) => r.plan.tickets.find((x) => x.id === c.ticketId));
  assert.deepEqual(r.result.created.map((c) => [c.tempId, c.num]), [['p', 7], ['a', 8], ['b', 9]]);
  assert.deepEqual([a.parent, b.parent, a.end, b.end, a.labels.length, a.unit], [p.id, p.id, '2026-10-21', '2026-10-20', 1, 'p4t8x2q']);
  assert.deepEqual(b.deps, [{ on: a.id, type: 'SS', lag: 0 }, { on: t(ctx.plan, 5).id, type: 'FS', lag: 0 }]);
  assert.deepEqual([p.priority, b.priority], [3, 0]); // new tickets are Medium; an explicit value is kept
  const cyc = importTasks(ctx, [{ tempId: 'x', title: 'X', deps: [{ on: 'y' }] }, { tempId: 'y', title: 'Y', deps: [{ on: 'x' }] }]);
  assert.equal(cyc.error.code, 'cycle');
  assert.equal(importTasks(ctx, [{ tempId: 'x', title: 'X', parent: 'nope' }]).error.code, 'not_found');
});

test('selectors: filters, removal re-parents, describe', () => {
  const ctx = context();
  assert.deepEqual(filterTickets(ctx, { hideDone: true, search: 'pass' }).map((x) => x.num), [3]);
  assert.deepEqual(filterTickets(ctx, { labels: ['a1b2c3d'], priority: [2] }).map((x) => x.num), [1]);
  assert.deepEqual(filterTickets(ctx, { doneWithinDays: 7 }).map((x) => x.num), [2, 3, 4, 5, 6]); // #1 was completed in 2025
  const noArt = { ...ctx, plan: removeLabel(ctx, 'Art').plan };
  assert.equal(filterTickets(noArt, ctx.plan.views[0].options).length, 5); // a removed label is ignored (hideDone stays)
  assert.deepEqual(M.ready(ctx).map((x) => x.num), [2, 3]);
  assert.deepEqual(M.blockers(ctx, '#4').map((x) => x.num), [2, 3]);
  const parent = addTicket(ctx, { title: 'Top' });
  const nested = M.setParent({ ...ctx, plan: parent.plan }, ['#2'], parent.result.ticketId).plan;
  const gone = removeTickets({ ...ctx, plan: nested }, [`#${parent.result.num}`, '#3']);
  assert.deepEqual([t(gone.plan, 2).parent, t(gone.plan, 4).deps.length, t(gone.plan, 6).deps, gone.result.removed], [null, 1, [], 2]);
  assert.equal(describe(ctx).split('\n')[2], '- #1 Design (Done; 3 d; 5-7 Oct)');
  assert.equal(describe(ctx).split('\n')[7], '- #6 Write-up (To do; 1 d; 9 Oct; deps #3 SS +1)');
  const mermaid = describe(ctx, 'mermaid');
  assert.match(mermaid, /excludes weekends, 2026-12-25/);
  assert.match(mermaid, /Playtest :crit, t4, after t2 t3, 2d/);
  assert.match(mermaid, /Submission :crit, milestone, t5, after t4, 0d/);
  assert.deepEqual(JSON.parse(describe(ctx, 'json')), ctx.plan);
});

// Every reducer on a deep-frozen context: none mutates its input.
test('no reducer mutates its input', () => {
  const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const ctx = freeze(linked(3, D1));
  const before = structuredClone(ctx);
  const calls = [
    () => M.updatePlan(ctx, { title: 'X', calendar: { workdays: [1, 2, 3] } }), () => M.addHoliday(ctx, '2026-10-08'), () => M.removeHoliday(ctx, '2026-12-25'),
    () => addColumn(ctx, { name: 'N' }, 'todo'), () => updateColumn(ctx, 'todo', { wip: 2 }), () => M.moveColumn(ctx, 'done', 'todo'), () => removeColumn(ctx, 'progress'),
    () => unmapTag(ctx, 'todo'), () => addUnit(ctx, { name: 'h', daysPer: 0.125 }), () => updateUnit(ctx, 'pt', { daysPer: 1 }), () => removeUnit(ctx, 'pt'),
    () => addLabel(ctx, { name: 'L' }), () => M.updateLabel(ctx, 'Art', { name: 'Arts' }), () => removeLabel(ctx, 'Art'),
    () => M.addView(ctx, { name: 'V', view: 'gantt' }), () => M.updateView(ctx, 'This sprint', { options: { zoom: 'week' } }), () => M.removeView(ctx, 'This sprint'),
    () => addTicket(ctx, { title: 'New', deps: [{ on: '#1' }], draftId: D2 }), () => updateTicket(ctx, ['#2'], { start: '2026-10-10', end: '2026-10-12', parent: null }),
    () => removeTickets(ctx, ['#3']), () => moveTicket(ctx, ['#3', '#2'], 'Review', '#1', undefined, { createTag: true }), () => M.reorder(ctx, ['#6'], '#1'),
    () => { const p = addTicket(ctx, { title: 'P' }); return M.setParent({ ...ctx, plan: p.plan }, ['#2'], p.result.ticketId); }, () => linkDraft(ctx, '#2', D2), () => unlinkDraft(ctx, '#3'), () => M.pruneDrafts({ ...ctx, drafts: [] }),
    () => syncCompleted(ctx), () => M.setBaseline(ctx), () => M.clearBaseline(ctx), () => importTasks(ctx, [{ tempId: 'a', title: 'A' }]),
    () => addDep(ctx, '#2', '#6'), () => updateDep(ctx, '#1', '#2', { type: 'SS' }), () => M.removeDep(ctx, '#1', '#2'),
    () => addTicketLabel(ctx, ['#2'], 'Art'), () => M.removeTicketLabel(ctx, ['#1'], 'Art'), () => addCheck(ctx, '#1', { text: 'x' }),
    () => updateCheck(ctx, '#1', 'k1q8z3v', { text: 'y' }), () => moveCheck(ctx, '#1', 'm2w7r4t', 'k1q8z3v'), () => removeCheck(ctx, '#1', 'k1q8z3v'),
    () => addUrl(ctx, '#1', { url: 'https://a.b/' }), () => M.updateUrl(ctx, '#1', 'u3n8c5w', { title: 'T' }), () => removeUrl(ctx, '#1', 'u3n8c5w'),
  ];
  for (const call of calls) {
    const r = call();
    assert.ok(!r.error, `${call} → ${r.error?.message}`);
    assert.deepEqual(r.plan, parsePlan(r.plan), `${call}: not a parsePlan fixed point`);
  }
  assert.deepEqual(ctx, before);
});

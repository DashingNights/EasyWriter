// Plan blocks of the smoke sample (actions.js sampleDoc; roadmap A3–A4; Gantt plan §7.5): a frozen Board chart (four tickets
// across the three seeded columns and one custom column that follows no tag, a draft card, a blocked ticket and an estimate
// in a custom unit) and a frozen Gantt chart of the §3.7 fixture (critical path A → C → D → M, a baseline that slipped).
// The snapshots are embedded, so the smoke run needs no plan file.
const id = (n) => `00000000-0000-4000-8000-a0000000000${n}`;
const DRAFT = '00000000-0000-4000-8000-b00000000001';
const ticket = (n, title, status, more = {}) => ({
  id: id(n), num: n, title, status, priority: 0, labels: [], estimate: null, unit: 'd', start: null, end: null, milestone: false,
  progress: 0, parent: null, deps: [], checklist: [], draftId: null, urls: [], description: '', baseline: null, completedAt: null, ...more,
});

const plan = {
  version: 1, id: id(0), threadUrl: 'https://daf.staffs.ac.uk/topic/88136-level-design-dev-thread/', title: 'Level design dev thread', seq: 4,
  calendar: { workdays: [1, 2, 3, 4, 5], holidays: [], weekOne: null },
  columns: [
    { id: 'todo', name: 'To do', color: '#e5e5e5', tagId: 'todo', wip: null },
    { id: 'progress', name: 'In progress', color: '#3d99f5', tagId: 'progress', wip: 3 },
    { id: 'r7k2m9q', name: 'Review', color: '#e09952', tagId: null, wip: null },
    { id: 'done', name: 'Done', color: '#62d926', tagId: 'done', wip: null },
  ],
  doneColumn: 'done', units: [{ id: 'p4t8x2q', name: 'pt', daysPer: 0.5 }], estimateUnit: 'd', autoSchedule: false,
  labels: [{ id: 'a1b2c3d', name: 'Art', color: '#e09952' }, { id: 'c4d5e6f', name: 'Code', color: '#3d99f5' }], views: [],
  order: [id(1), id(2), id(3), id(4)],
  tickets: [
    ticket(1, 'Blockout level 1', 'progress', { priority: 2, labels: ['a1b2c3d'], estimate: 3, unit: 'p4t8x2q', start: '2026-10-05', end: '2026-10-07',
      checklist: [{ id: 'k1q8z3v', text: '', done: true }, { id: 'k2q8z3v', text: '', done: false }] }),
    ticket(2, 'Lighting pass', 'todo', { labels: ['a1b2c3d'], deps: [{ on: id(1), type: 'FS', lag: 0 }], estimate: 2 }),
    ticket(3, 'Playtest notes', 'r7k2m9q', { priority: 1, labels: ['c4d5e6f'] }),
    ticket(4, 'Greybox lobby', 'done', { completedAt: 1759600000000 }),
  ],
  baselineAt: null,
};

// The §3.7 reference fixture (test/fixtures/plan-sample.json): A → B, C; B, C → D → M; C → F (SS, lag 1). Baselines: as
// planned a week earlier, two days shorter for C.
const gid = (n) => `00000000-0000-4000-8000-c0000000000${n}`;
const fs = (n) => [{ on: gid(n), type: 'FS', lag: 0 }];
const gantt = {
  ...plan, id: gid(0), seq: 6, units: [], labels: [{ id: 'a1b2c3d', name: 'Art', color: '#e09952' }],
  order: [1, 2, 3, 4, 5, 6].map(gid),
  tickets: [
    ticket(1, 'Design', 'done', { id: gid(1), labels: ['a1b2c3d'], start: '2026-10-05', end: '2026-10-07', progress: 100, completedAt: 1759600000000, baseline: { start: '2026-10-05', end: '2026-10-07' } }),
    ticket(2, 'Blockout', 'progress', { id: gid(2), start: '2026-10-08', end: '2026-10-09', progress: 40, deps: fs(1), baseline: { start: '2026-10-08', end: '2026-10-09' } }),
    ticket(3, 'Art pass', 'progress', { id: gid(3), labels: ['a1b2c3d'], start: '2026-10-08', end: '2026-10-13', progress: 20, deps: fs(1), baseline: { start: '2026-10-08', end: '2026-10-09' } }),
    ticket(4, 'Playtest', 'todo', { id: gid(4), start: '2026-10-14', end: '2026-10-15', deps: [...fs(2), ...fs(3)], baseline: { start: '2026-10-12', end: '2026-10-13' } }),
    ticket(5, 'Submission', 'todo', { id: gid(5), priority: 1, start: '2026-10-16', end: '2026-10-16', milestone: true, deps: fs(4), baseline: { start: '2026-10-14', end: '2026-10-14' } }),
    ticket(6, 'Write-up', 'todo', { id: gid(6), start: '2026-10-09', end: '2026-10-09', deps: [{ on: gid(3), type: 'SS', lag: 1 }] }),
  ],
};

export const planSample = () => [{
  type: 'planChart',
  attrs: {
    id: 'smokepc', planId: plan.id, view: 'kanban', dw: 900,
    options: { fields: ['num', 'labels', 'due', 'checklist', 'priority', 'blocked', 'draft', 'pushed', 'estimate'] },
    frozen: {
      at: 1759744800000,
      ctx: {
        plan,
        tags: [{ id: 'todo', name: 'To do', color: '#e5e5e5' }, { id: 'progress', name: 'In progress', color: '#3d99f5' }, { id: 'done', name: 'Done', color: '#62d926' }],
        drafts: [{ id: DRAFT, title: 'Week 3 post', pushedAt: null }],
        draftTags: { [DRAFT]: 'todo' },
        today: '2026-10-06',
      },
    },
  },
}, {
  type: 'planChart',
  attrs: {
    id: 'smokegt', planId: gantt.id, view: 'gantt', dw: 960, options: { showCritical: true, showBaseline: true },
    frozen: {
      at: 1759744800000,
      ctx: { plan: gantt, tags: [{ id: 'todo', name: 'To do', color: '#e5e5e5' }, { id: 'progress', name: 'In progress', color: '#3d99f5' }, { id: 'done', name: 'Done', color: '#62d926' }], drafts: [], draftTags: {}, today: '2026-10-06' },
    },
  },
}];

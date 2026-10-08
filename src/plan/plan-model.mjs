// The plan model (Gantt plan §3, §5): parsePlan, the reducers and the selectors of one plan file. Pure.
// Every reducer takes the plan context `ctx` = {plan, tags, drafts, draftTags, today} (§3.3; one that needs only the plan
// reads ctx.plan), never mutates it, and returns {plan, result?, draftTags?, tags?} or {error: {code, message, data?}}.
// `result` is the command's result (new ids, counts); `draftTags` / `tags` are whole settings values to save before the
// plan. Every list of records changes one entry per call (precise edits, agent-automation.md §4.3 #11). Arguments that name
// a ticket take its id or `#num`; a column, unit, label or view takes its id or name (the *Ref resolvers below).

import { DEFAULT_TAGS } from '../app/drafts-meta.js';
import { addWorkDays, fmt, fromDay, normRange, toDay } from './dates.mjs';
import { columnForTag, doneColumnOf, hasCycle, schedule, statusOf } from './schedule.mjs';

export { columnForTag, doneColumnOf, statusOf };

export const MAX_COLUMNS = 10;
/** Colours for new columns and labels, used in order of the first one not taken. */
export const COLORS = ['#e5e5e5', '#3d99f5', '#62d926', '#e09952', '#e05252', '#a36ee0', '#52c7e0', '#e0d052', '#e052a8', '#7a7f99'];
export const FIELDS = ['num', 'labels', 'due', 'checklist', 'priority', 'estimate', 'progress', 'draft', 'pushed', 'blocked', 'deps'];
export const ZOOMS = ['day', 'week', 'month', 'quarter', 'fit'];
/** Chart and saved-view options (§3.5); a missing key means its default. */
export const OPTION_DEFAULTS = {
  title: null, columns: null, labels: null, priority: null, hideDone: false, doneWithinDays: null, search: '', swimlane: null,
  showDrafts: true, unpushedOnly: false, fields: ['num', 'labels', 'due', 'checklist', 'priority', 'blocked', 'draft', 'pushed'],
  range: null, zoom: 'fit', weekLabels: 'date', showDeps: true, showCritical: false, showBaseline: false, showToday: true,
  showTaskList: true, showWeekends: true, legend: true, footer: true,
};
/** Preconditions of the column commands, shared by the controls, the reducers and dispatch (§8.2; agent-automation.md
 * §3.7 shape). plan-commands.mjs re-exports them. */
export const PLAN_GATES = {
  'plan.columnRoom': { subject: 'plan', test: (p) => p.columns.length < MAX_COLUMNS, message: 'A plan has at most 10 columns', fix: 'Remove a column first' },
  'plan.otherColumn': { subject: 'plan', test: (p) => p.columns.length > 1, message: 'A plan keeps at least one column', fix: 'Add another column first' },
};

const UUID = /^[a-f0-9-]{36}$/;
const SID = /^[a-z0-9]{7}$/;
const CID = /^[a-z0-9]{1,16}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const WEB = /^https?:\/\//;
const DEP_TYPES = ['FS', 'SS', 'FF', 'SF'];
const VIEWS = ['kanban', 'backlog', 'gantt'];
const D_UNIT = { id: 'd', name: 'd', daysPer: 1 };
const TICKET_FIELDS = ['title', 'description', 'priority', 'estimate', 'unit', 'start', 'end', 'milestone', 'progress', 'parent', 'draftId'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isWip = (v) => v === null || (Number.isInteger(v) && v >= 1);
const isPriority = (v) => Number.isInteger(v) && v >= 0 && v <= 4;
const nullOr = (ok) => (v) => v === null || ok(v);
const listOf = (ok) => (v) => Array.isArray(v) && v.every(ok);
const bool = (v) => typeof v === 'boolean';
const isDate = (v) => toDay(v) !== null;
const nextColor = (list) => COLORS.find((c) => !list.some((x) => x.color === c)) ?? COLORS[list.length % COLORS.length];

/** A 7-char base36 id (the `newId()` pattern of whiteboard.js, always 7 characters). */
export const newId = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');
const freshId = (list) => {
  let id;
  do id = newId(); while (list.some((x) => x.id === id));
  return id;
};

const fail = (code, message, data) => ({ error: { code, message, ...(data && { data }) } });
const missing = (what, ref) => fail('not_found', `No ${what} '${ref}' in this plan`);
const gate = (plan, id) => (PLAN_GATES[id].test(plan) ? null : fail('precondition_failed', PLAN_GATES[id].message));
const touch = (t) => ({ ...t, updated: Date.now() });
const setTickets = (plan, fn) => ({ ...plan, tickets: plan.tickets.map(fn) });
const ticketOf = (plan, id) => plan.tickets.find((t) => t.id === id);
const hasKids = (plan, id) => plan.tickets.some((t) => t.parent === id);
const hasDeps = (plan, id) => !!ticketOf(plan, id)?.deps.length || plan.tickets.some((t) => t.deps.some((d) => d.on === id));

// --- refs ---

/** `#12` or a ticket id → the ticket id, else null. */
export function ticketRef(plan, ref) {
  if (typeof ref !== 'string') return null;
  const t = /^#\d+$/.test(ref) ? plan.tickets.find((x) => x.num === +ref.slice(1)) : ticketOf(plan, ref);
  return t?.id ?? null;
}
const byIdOrName = (list, ref) => (typeof ref !== 'string' ? null
  : (list.find((x) => x.id === ref) ?? list.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase()))?.id ?? null);
/** A column id or name → its id; null stays null ("No status"); unknown → undefined. */
export const columnRef = (plan, ref) => (ref === null ? null : byIdOrName(plan.columns, ref) ?? undefined);
/** 'd' or a unit id or name → the unit id, else null. */
export const unitRef = (plan, ref) => (ref === 'd' ? 'd' : byIdOrName(plan.units, ref));
export const labelRef = (plan, ref) => byIdOrName(plan.labels, ref);
export const viewRef = (plan, ref) => byIdOrName(plan.views, ref);

function ticketIds(plan, refs) {
  const ids = [];
  for (const ref of arr(refs)) {
    const id = ticketRef(plan, ref);
    if (!id) return missing('ticket', ref);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length ? { ids } : fail('invalid_args', 'Name at least one ticket');
}

// `order` with the ids `moving` (kept in their relative order) placed just before `beforeId`, or just after `afterId`, or at
// the end when neither is given. The anchor must be in `order`.
function placeIds(order, moving, beforeId = null, afterId = null) {
  const set = new Set(moving);
  const anchor = beforeId ?? afterId;
  if (set.has(anchor)) return order;
  const kept = order.filter((id) => !set.has(id));
  const at = anchor === null ? kept.length : kept.indexOf(anchor) + (beforeId === null ? 1 : 0);
  return [...kept.slice(0, at), ...order.filter((id) => set.has(id)), ...kept.slice(at)];
}

// The entry list with entry `id` moved before / after an anchor of the same list (null: the anchor is unknown).
function placeEntry(list, id, beforeId, afterId) {
  const anchor = beforeId ?? afterId;
  if (anchor != null && !list.some((x) => x.id === anchor)) return null;
  const ids = placeIds(list.map((x) => x.id), [id], beforeId ?? null, beforeId == null ? (afterId ?? null) : null);
  return ids.map((x) => list.find((y) => y.id === x));
}

// Runs reducers in turn on what the previous one returned (plan and settings values); the first error wins.
function pipe(ctx, steps) {
  let out = { plan: ctx.plan };
  for (const step of steps) {
    const r = step({ ...ctx, plan: out.plan, ...(out.draftTags && { draftTags: out.draftTags }), ...(out.tags && { tags: out.tags }) });
    if (r.error) return r;
    out = { ...out, ...r, ...((out.result || r.result) && { result: { ...out.result, ...r.result } }) };
  }
  return out;
}

// --- parse ---

const OPTION_CHECKS = {
  title: nullOr((v) => typeof v === 'string'),
  columns: nullOr(listOf((v) => v === null || typeof v === 'string')),
  labels: nullOr(listOf((v) => typeof v === 'string' && SID.test(v))),
  priority: nullOr(listOf(isPriority)),
  hideDone: bool,
  doneWithinDays: nullOr((v) => Number.isInteger(v) && v >= 1),
  search: (v) => typeof v === 'string' && v.length <= 100,
  swimlane: (v) => [null, 'label', 'parent', 'priority'].includes(v),
  showDrafts: bool,
  unpushedOnly: bool,
  fields: listOf((v) => FIELDS.includes(v)),
  range: nullOr((v) => isObj(v) && nullOr(isDate)(v.start ?? null) && nullOr(isDate)(v.end ?? null)),
  zoom: (v) => ZOOMS.includes(v),
  weekLabels: (v) => v === 'date' || v === 'number',
  showDeps: bool, showCritical: bool, showBaseline: bool, showToday: bool, showTaskList: bool, showWeekends: bool, legend: bool, footer: bool,
};
/** The valid keys of a chart or saved-view options object (invalid keys dropped, missing keys mean their defaults). */
export const parseOptions = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([k, v]) => OPTION_CHECKS[k]?.(v)));

/** Files of older versions → the current shape (version 1 is the only one so far). */
export const migratePlan = (file) => file;

const seedColumns = (tags) => DEFAULT_TAGS.map((t) => ({ ...t, tagId: arr(tags).some((x) => x.id === t.id) ? t.id : null, wip: null }));
const workdaysOf = (w) => (Array.isArray(w) && w.length && w.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  ? [...new Set(w)].sort((a, b) => a - b) : null);
const unitName = (name, units, id) => {
  const n = String(name ?? '').trim();
  return n && n.length <= 12 && n.toLowerCase() !== 'd' && !units.some((u) => u.id !== id && u.name.toLowerCase() === n.toLowerCase()) ? n : null;
};
const stamps = (x) => ({ ...(Number.isInteger(x.created) && { created: x.created }), ...(Number.isInteger(x.updated) && { updated: x.updated }) });
// Unique, valid `id`s (a missing or duplicate one gets a new id when `renew`, else the entry is dropped).
function entries(list, idRe, renew = false) {
  const out = [];
  for (const x of arr(list)) {
    if (!isObj(x)) continue;
    const ok = typeof x.id === 'string' && idRe.test(x.id) && !out.some((y) => y.id === x.id);
    if (ok || renew) out.push(ok ? x : { ...x, id: freshId(out) });
  }
  return out;
}

/** The plan in `json` (a record or its JSON text) with defaults filled and invalid parts dropped (§3.2); never throws.
 * `ctx.tags` (the global tags) decide which seeded columns follow a tag when the file has no valid column. */
export function parsePlan(json, ctx = {}) {
  let raw = json;
  if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch { raw = null; }
  const f = migratePlan(isObj(raw) ? raw : {});
  const c = isObj(f.calendar) ? f.calendar : {};
  const calendar = {
    workdays: workdaysOf(c.workdays) ?? [1, 2, 3, 4, 5],
    holidays: [...new Set(arr(c.holidays).filter(isDate))].sort(),
    weekOne: isDate(c.weekOne) ? c.weekOne : null,
  };
  const columns = [];
  for (const x of entries(f.columns, CID).slice(0, MAX_COLUMNS)) {
    const tagId = typeof x.tagId === 'string' && x.tagId.length <= 64 && !columns.some((y) => y.tagId === x.tagId) ? x.tagId : null;
    columns.push({ id: x.id, name: str(x.name, 40).trim() || `Column ${columns.length + 1}`, color: HEX.test(x.color) ? x.color : nextColor(columns),
      tagId, wip: isWip(x.wip) ? x.wip : null });
  }
  if (!columns.length) columns.push(...seedColumns(ctx.tags ?? DEFAULT_TAGS));
  const units = [];
  for (const x of entries(f.units, SID)) {
    const name = unitName(x.name, units, x.id);
    if (name && Number.isFinite(x.daysPer) && x.daysPer > 0) units.push({ id: x.id, name, daysPer: x.daysPer });
  }
  const labels = [];
  for (const x of entries(f.labels, SID)) labels.push({ id: x.id, name: str(x.name, 40).trim(), color: HEX.test(x.color) ? x.color : nextColor(labels) });
  const views = entries(f.views, SID).filter((x) => VIEWS.includes(x.view))
    .map((x) => ({ id: x.id, name: str(x.name, 40).trim(), view: x.view, options: parseOptions(x.options) }));
  const estimateUnit = units.some((u) => u.id === f.estimateUnit) ? f.estimateUnit : 'd';
  const plan = {
    version: 1,
    id: typeof f.id === 'string' && UUID.test(f.id) ? f.id : crypto.randomUUID(),
    threadUrl: typeof f.threadUrl === 'string' ? f.threadUrl.replace(/[?#].*$/, '') : '',
    title: str(f.title, 120),
    seq: Number.isInteger(f.seq) && f.seq >= 0 ? f.seq : 0,
    calendar,
    columns,
    doneColumn: columns.some((x) => x.id === f.doneColumn) ? f.doneColumn : columns.at(-1).id,
    units,
    estimateUnit,
    autoSchedule: f.autoSchedule === true,
    labels,
    views,
    order: [],
    tickets: [],
    baselineAt: Number.isInteger(f.baselineAt) ? f.baselineAt : null,
    ...stamps(f),
  };
  plan.tickets = parseTickets(f.tickets, plan);
  const ids = new Set(plan.tickets.map((t) => t.id));
  const listed = [...new Set(arr(f.order).filter((id) => ids.has(id)))];
  const inOrder = new Set(listed);
  plan.order = [...plan.tickets.map((t) => t.id).filter((id) => !inOrder.has(id)), ...listed];
  plan.seq = Math.max(plan.seq, ...plan.tickets.map((t) => t.num));
  return plan;
}

function parseTickets(list, plan) {
  const raw = arr(list).filter((t) => isObj(t) && typeof t.id === 'string' && UUID.test(t.id))
    .filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i);
  const ids = new Set(raw.map((t) => t.id));
  const nums = new Set();
  const date = (v) => (isDate(v) ? v : null);
  const tickets = raw.map((t) => {
    const milestone = t.milestone === true;
    let [start, end] = [date(t.start), date(t.end)];
    if (!start || !end) start = end = null;
    else if (milestone || end < start) end = start;
    const num = Number.isInteger(t.num) && t.num >= 1 && !nums.has(t.num) ? t.num : 0;
    nums.add(num);
    return {
      id: t.id,
      num,
      title: str(t.title, 200),
      description: str(t.description, 20000),
      status: !('status' in t) ? plan.columns[0].id : plan.columns.some((c) => c.id === t.status) ? t.status : null,
      priority: isPriority(t.priority) ? t.priority : 0,
      labels: [...new Set(arr(t.labels).filter((l) => plan.labels.some((x) => x.id === l)))],
      estimate: Number.isFinite(t.estimate) && t.estimate >= 0 ? t.estimate : null,
      unit: t.unit === undefined ? plan.estimateUnit : plan.units.some((u) => u.id === t.unit) ? t.unit : 'd',
      start,
      end,
      milestone,
      progress: Number.isFinite(t.progress) ? Math.min(100, Math.max(0, Math.round(t.progress))) : 0,
      parent: ids.has(t.parent) && t.parent !== t.id ? t.parent : null,
      deps: arr(t.deps).filter((d) => isObj(d) && ids.has(d.on) && d.on !== t.id)
        .map((d) => ({ on: d.on, type: DEP_TYPES.includes(d.type) ? d.type : 'FS', lag: Number.isInteger(d.lag) ? d.lag : 0 }))
        .filter((d, i, all) => all.findIndex((x) => x.on === d.on) === i),
      checklist: entries(t.checklist, SID, true).filter((x) => typeof x.text === 'string').map((x) => ({ id: x.id, text: x.text.slice(0, 200), done: x.done === true })),
      draftId: typeof t.draftId === 'string' && UUID.test(t.draftId) ? t.draftId : null,
      urls: entries(t.urls, SID, true).filter((x) => typeof x.url === 'string' && WEB.test(x.url))
        .map((x) => ({ id: x.id, url: x.url, ...(typeof x.title === 'string' && { title: x.title.slice(0, 80) }) })),
      baseline: isObj(t.baseline) && isDate(t.baseline.start) && isDate(t.baseline.end) ? { start: t.baseline.start, end: t.baseline.end } : null,
      completedAt: Number.isInteger(t.completedAt) ? t.completedAt : null,
      ...stamps(t),
    };
  });
  let seq = Math.max(Number.isInteger(plan.seq) ? plan.seq : 0, ...tickets.map((t) => t.num));
  for (const t of tickets) if (!t.num) t.num = ++seq;
  // Break parent cycles (hand edits), then drop dependencies on or from parents and those that close a cycle.
  const byId = new Map(tickets.map((t) => [t.id, t]));
  for (const t of tickets) {
    const up = new Set();
    for (let p = t.parent; p; p = byId.get(p).parent) {
      if (p === t.id) { t.parent = null; break; }
      if (up.has(p)) break;
      up.add(p);
    }
  }
  const parents = new Set(tickets.map((t) => t.parent).filter(Boolean));
  for (const t of tickets) t.deps = parents.has(t.id) ? [] : t.deps.filter((d) => !parents.has(d.on));
  if (hasCycle(tickets)) {
    const kept = tickets.map((t) => ({ ...t, deps: [] }));
    for (const [i, t] of tickets.entries()) {
      for (const d of t.deps) if (!hasCycle(kept, { from: d.on, to: t.id })) kept[i].deps.push(d);
    }
    for (const [i, t] of tickets.entries()) t.deps = kept[i].deps;
  }
  return tickets;
}

/** A new plan for the thread with the three seeded columns (`tagId` only for the tags present in `tags`). */
export const newPlan = (threadUrl, title = '', tags = DEFAULT_TAGS) =>
  parsePlan({ version: 1, id: crypto.randomUUID(), threadUrl, title, columns: [], tickets: [], order: [] }, { tags });

/** A new ticket record of the plan (not added): the next `num`, the first column, Medium priority, the default unit. */
export function newTicket(plan, patch = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), num: plan.seq + 1, title: '', description: '', status: plan.columns[0].id, priority: 3, labels: [],
    estimate: null, unit: plan.estimateUnit, start: null, end: null, milestone: false, progress: 0, parent: null, deps: [],
    checklist: [], draftId: null, urls: [], baseline: null, completedAt: null, created: now, updated: now, ...patch,
  };
}

// --- plan ---

/** plan.update: title, calendar {workdays, weekOne} (merged), autoSchedule, doneColumn, estimateUnit. */
export function updatePlan(ctx, patch = {}) {
  const { plan } = ctx;
  const next = { ...plan };
  if ('title' in patch) next.title = String(patch.title ?? '').trim().slice(0, 120);
  if ('autoSchedule' in patch) next.autoSchedule = !!patch.autoSchedule;
  if ('calendar' in patch) {
    const c = isObj(patch.calendar) ? patch.calendar : {};
    next.calendar = { ...plan.calendar };
    if ('workdays' in c) {
      next.calendar.workdays = workdaysOf(c.workdays);
      if (!next.calendar.workdays) return fail('invalid_args', 'Working days are 0 (Sunday) to 6 (Saturday), at least one');
    }
    if ('weekOne' in c) {
      if (c.weekOne !== null && !isDate(c.weekOne)) return fail('invalid_args', 'weekOne is a YYYY-MM-DD date or null');
      next.calendar.weekOne = c.weekOne;
    }
  }
  if ('doneColumn' in patch) {
    next.doneColumn = columnRef(plan, patch.doneColumn);
    if (!next.doneColumn) return missing('column', patch.doneColumn);
  }
  if ('estimateUnit' in patch) {
    next.estimateUnit = unitRef(plan, patch.estimateUnit);
    if (!next.estimateUnit) return missing('unit', patch.estimateUnit);
  }
  return { plan: next };
}

export const setDoneColumn = (ctx, id) => updatePlan(ctx, { doneColumn: id });

export function addHoliday(ctx, date) {
  const { plan } = ctx;
  if (!isDate(date)) return fail('invalid_args', 'A holiday is a YYYY-MM-DD date');
  if (plan.calendar.holidays.includes(date)) return fail('exists', `${date} is already a holiday`);
  return { plan: { ...plan, calendar: { ...plan.calendar, holidays: [...plan.calendar.holidays, date].sort() } } };
}

export function removeHoliday(ctx, date) {
  const { plan } = ctx;
  if (!plan.calendar.holidays.includes(date)) return missing('holiday', date);
  return { plan: { ...plan, calendar: { ...plan.calendar, holidays: plan.calendar.holidays.filter((d) => d !== date) } } };
}

// --- columns ---

// The checked fields of a column patch (name, color, tagId, wip) for the column `id` (null: a new one).
function columnFields(ctx, id, patch) {
  const fields = {};
  if ('name' in patch) fields.name = String(patch.name ?? '').trim().slice(0, 40);
  if ('color' in patch) {
    if (!HEX.test(patch.color)) return fail('invalid_args', 'A colour is #rrggbb');
    fields.color = patch.color;
  }
  if ('wip' in patch) {
    if (!isWip(patch.wip)) return fail('invalid_args', 'A WIP limit is a whole number of 1 or more, or null for none');
    fields.wip = patch.wip;
  }
  if ('tagId' in patch) {
    if (patch.tagId !== null) {
      if (!ctx.tags?.some((t) => t.id === patch.tagId)) return missing('status tag', patch.tagId);
      const owner = ctx.plan.columns.find((c) => c.tagId === patch.tagId && c.id !== id);
      if (owner) return fail('tag_taken', `The column '${owner.name}' already follows that tag`);
    }
    fields.tagId = patch.tagId;
  }
  return { fields };
}

/** plan.columns.add: a column {name, color?, tagId?, wip?} before `beforeId` (else at the end) → {columnId}. */
export function addColumn(ctx, column = {}, beforeId) {
  const { plan } = ctx;
  const r = gate(plan, 'plan.columnRoom') ?? columnFields(ctx, null, column);
  if (r.error) return r;
  const col = { id: freshId(plan.columns), name: '', color: nextColor(plan.columns), tagId: null, wip: null, ...r.fields };
  const at = beforeId == null ? plan.columns.length : plan.columns.findIndex((c) => c.id === columnRef(plan, beforeId));
  if (at < 0) return missing('column', beforeId);
  col.name ||= `Column ${at + 1}`;
  return { plan: { ...plan, columns: plan.columns.toSpliced(at, 0, col) }, result: { columnId: col.id } };
}

/** plan.columns.update: name, color, tagId (string | null), wip (integer | null). */
export function updateColumn(ctx, id, patch = {}) {
  const { plan } = ctx;
  const at = plan.columns.findIndex((c) => c.id === columnRef(plan, id));
  if (at < 0) return missing('column', id);
  const r = columnFields(ctx, plan.columns[at].id, patch);
  if (r.error) return r;
  const col = { ...plan.columns[at], ...r.fields };
  col.name ||= `Column ${at + 1}`;
  return { plan: { ...plan, columns: plan.columns.with(at, col) } };
}

/** plan.columns.move: before `beforeId` or after `afterId` (neither: to the end). */
export function moveColumn(ctx, id, beforeId, afterId) {
  const { plan } = ctx;
  const cid = columnRef(plan, id);
  if (!cid) return missing('column', id);
  const ref = beforeId ?? afterId;
  const anchor = ref == null ? null : columnRef(plan, ref);
  if (anchor === undefined) return missing('column', ref);
  return { plan: { ...plan, columns: placeEntry(plan.columns, cid, beforeId != null ? anchor : null, beforeId != null ? null : anchor) } };
}

/** plan.columns.remove (§3.2): unlinked tickets in it move to `moveTo` (default the left neighbour, else the right one;
 * null = "No status"); linked tickets keep their draft's tag; a removed done column falls back to the last column. → {moved}. */
export function removeColumn(ctx, id, moveTo) {
  const { plan } = ctx;
  const cid = columnRef(plan, id);
  const at = plan.columns.findIndex((c) => c.id === cid);
  if (at < 0) return missing('column', id);
  const g = gate(plan, 'plan.otherColumn');
  if (g) return g;
  const to = moveTo === undefined ? (plan.columns[at - 1] ?? plan.columns[at + 1]).id : columnRef(plan, moveTo);
  if (to === undefined) return missing('column', moveTo);
  if (to === cid) return fail('invalid_args', 'Move the tickets to another column than the one deleted');
  const columns = plan.columns.filter((c) => c.id !== cid);
  const moving = plan.tickets.filter((t) => !t.draftId && t.status === cid);
  // A linked ticket's stored status (ignored while linked) follows too, so the file names no deleted column.
  const move = (t) => (moving.includes(t) ? touch({ ...t, status: to }) : t.status === cid ? { ...t, status: to } : t);
  return {
    plan: { ...plan, columns, doneColumn: plan.doneColumn === cid ? columns.at(-1).id : plan.doneColumn, tickets: plan.tickets.map(move) },
    result: { moved: moving.length },
  };
}

/** Clears `tagId` on the column that maps the deleted global tag (the same plan object when none does). */
export function unmapTag(ctx, tagId) {
  const { plan } = ctx;
  if (!plan.columns.some((c) => c.tagId === tagId)) return { plan };
  return { plan: { ...plan, columns: plan.columns.map((c) => (c.tagId === tagId ? { ...c, tagId: null } : c)) } };
}

// --- units, labels, views ---

function unitFields(plan, id, patch) {
  const fields = {};
  if ('name' in patch) {
    fields.name = unitName(patch.name, plan.units, id);
    if (!fields.name) return fail('bad_unit', "A unit needs a name of 1 to 12 characters, not 'd' and not used by another unit");
  }
  if ('daysPer' in patch) {
    if (!(Number.isFinite(patch.daysPer) && patch.daysPer > 0)) return fail('bad_unit', 'One unit must be more than 0 days');
    fields.daysPer = patch.daysPer;
  }
  return { fields };
}

/** plan.units.add: {name, daysPer} → {unitId}. */
export function addUnit(ctx, unit = {}) {
  const { plan } = ctx;
  const r = unitFields(plan, null, { name: '', daysPer: undefined, ...unit });
  if (r.error) return r;
  const id = freshId(plan.units);
  return { plan: { ...plan, units: [...plan.units, { id, ...r.fields }] }, result: { unitId: id } };
}

export function updateUnit(ctx, id, patch = {}) {
  const { plan } = ctx;
  const uid = unitRef(plan, id);
  const at = plan.units.findIndex((u) => u.id === uid);
  if (at < 0) return missing('unit', id);
  const r = unitFields(plan, uid, patch);
  return r.error ? r : { plan: { ...plan, units: plan.units.with(at, { ...plan.units[at], ...r.fields }) } };
}

/** plan.units.remove: its estimates become days (estimate × daysPer) → {converted}. */
export function removeUnit(ctx, id) {
  const { plan } = ctx;
  const uid = unitRef(plan, id);
  const unit = plan.units.find((u) => u.id === uid);
  if (!unit) return missing('unit', id);
  const users = plan.tickets.filter((t) => t.unit === uid);
  return {
    plan: {
      ...plan, units: plan.units.filter((u) => u !== unit), estimateUnit: plan.estimateUnit === uid ? 'd' : plan.estimateUnit,
      tickets: plan.tickets.map((t) => (users.includes(t) ? touch({ ...t, unit: 'd', estimate: t.estimate == null ? null : t.estimate * unit.daysPer }) : t)),
    },
    result: { converted: users.filter((t) => t.estimate != null).length },
  };
}

function labelFields(patch) {
  const fields = {};
  if ('name' in patch) fields.name = String(patch.name ?? '').trim().slice(0, 40);
  if ('color' in patch) {
    if (!HEX.test(patch.color)) return fail('invalid_args', 'A colour is #rrggbb');
    fields.color = patch.color;
  }
  return { fields };
}

/** plan.labels.add: {name, color?} → {labelId}. */
export function addLabel(ctx, label = {}) {
  const { plan } = ctx;
  const r = labelFields(label);
  if (r.error) return r;
  const entry = { id: freshId(plan.labels), name: '', color: nextColor(plan.labels), ...r.fields };
  entry.name ||= `Label ${plan.labels.length + 1}`;
  return { plan: { ...plan, labels: [...plan.labels, entry] }, result: { labelId: entry.id } };
}

export function updateLabel(ctx, id, patch = {}) {
  const { plan } = ctx;
  const at = plan.labels.findIndex((l) => l.id === labelRef(plan, id));
  if (at < 0) return missing('label', id);
  const r = labelFields(patch);
  if (r.error) return r;
  const entry = { ...plan.labels[at], ...r.fields };
  entry.name ||= plan.labels[at].name;
  return { plan: { ...plan, labels: plan.labels.with(at, entry) } };
}

/** plan.labels.remove: the label also leaves every ticket → {tickets}. */
export function removeLabel(ctx, id) {
  const { plan } = ctx;
  const lid = labelRef(plan, id);
  if (!lid) return missing('label', id);
  const users = plan.tickets.filter((t) => t.labels.includes(lid));
  return {
    plan: { ...plan, labels: plan.labels.filter((l) => l.id !== lid), tickets: plan.tickets.map((t) => (users.includes(t) ? touch({ ...t, labels: t.labels.filter((l) => l !== lid) }) : t)) },
    result: { tickets: users.length },
  };
}

function viewFields(patch, old = {}) {
  const fields = {};
  if ('name' in patch) fields.name = String(patch.name ?? '').trim().slice(0, 40);
  if ('view' in patch) {
    if (!VIEWS.includes(patch.view)) return fail('invalid_args', 'A view is kanban, backlog or gantt');
    fields.view = patch.view;
  }
  if ('options' in patch) fields.options = { ...old.options, ...parseOptions(patch.options) }; // keys merge
  return { fields };
}

/** plan.views.add: {name, view, options?} → {viewId}. */
export function addView(ctx, view = {}) {
  const { plan } = ctx;
  const r = viewFields({ view: undefined, ...view });
  if (r.error) return r;
  const entry = { id: freshId(plan.views), name: '', options: {}, ...r.fields };
  entry.name ||= `View ${plan.views.length + 1}`;
  return { plan: { ...plan, views: [...plan.views, entry] }, result: { viewId: entry.id } };
}

export function updateView(ctx, id, patch = {}) {
  const { plan } = ctx;
  const at = plan.views.findIndex((v) => v.id === viewRef(plan, id));
  if (at < 0) return missing('view', id);
  const r = viewFields(patch, plan.views[at]);
  if (r.error) return r;
  const entry = { ...plan.views[at], ...r.fields };
  entry.name ||= plan.views[at].name;
  return { plan: { ...plan, views: plan.views.with(at, entry) } };
}

export function removeView(ctx, id) {
  const { plan } = ctx;
  const vid = viewRef(plan, id);
  return vid ? { plan: { ...plan, views: plan.views.filter((v) => v.id !== vid) } } : missing('view', id);
}

// --- tickets ---

// The checked field set of a ticket patch (title, description, priority, estimate, unit, start + end, milestone, progress)
// applied to ticket `t`; dates are normalised to working days whenever they or `milestone` are written (§3.2).
function ticketFields(ctx, t, patch) {
  const { plan } = ctx;
  const fields = {};
  if ('title' in patch) {
    fields.title = String(patch.title ?? '').trim().slice(0, 200);
    if (!fields.title) return fail('invalid_args', 'A ticket needs a title');
  }
  if ('description' in patch) fields.description = String(patch.description ?? '').slice(0, 20000);
  if ('priority' in patch) {
    if (!isPriority(patch.priority)) return fail('invalid_args', 'Priority is 0 (none) to 4 (low)');
    fields.priority = patch.priority;
  }
  if ('estimate' in patch) {
    if (!(patch.estimate === null || (Number.isFinite(patch.estimate) && patch.estimate >= 0))) return fail('invalid_args', 'An estimate is a number of 0 or more, or null');
    fields.estimate = patch.estimate;
  }
  if ('unit' in patch) {
    fields.unit = unitRef(plan, patch.unit);
    if (!fields.unit) return missing('unit', patch.unit);
  }
  if ('progress' in patch) {
    if (!(Number.isInteger(patch.progress) && patch.progress >= 0 && patch.progress <= 100)) return fail('invalid_args', 'Progress is a whole number from 0 to 100');
    fields.progress = patch.progress;
  }
  if ('milestone' in patch) fields.milestone = !!patch.milestone;
  if ('start' in patch || 'end' in patch) {
    const none = patch.start == null && patch.end == null;
    if (!none && (!isDate(patch.start) || !isDate(patch.end))) return fail('invalid_args', 'start and end are YYYY-MM-DD dates, both or neither');
    fields.start = patch.start ?? null;
    fields.end = patch.end ?? null;
  }
  const next = { ...t, ...fields };
  if (('start' in fields || 'milestone' in fields) && next.start) Object.assign(fields, normRange(next.start, next.end, plan.calendar, next.milestone));
  return { fields };
}

/** plan.tickets.create: {title, status?, priority?, labels?, estimate?, unit?, start?, end?, days?, milestone?, parent?,
 * deps?: [{on, type?, lag?}], checklist?: [text | {text, done}], draftId?, urls?: [{url, title?}], description?} before
 * `beforeId` (else at the end of the order) → {ticketId, num}. `end` wins over `days` (working days from start). */
export function addTicket(ctx, input = {}, beforeId) {
  const { plan } = ctx;
  const base = newTicket(plan);
  let status = base.status;
  if ('status' in input) {
    status = columnRef(plan, input.status);
    if (status === undefined) return missing('column', input.status);
  }
  const scalar = Object.fromEntries(TICKET_FIELDS.filter((k) => k in input && k !== 'parent' && k !== 'draftId').map((k) => [k, input[k]]));
  if (input.end == null && Number.isInteger(input.days) && input.days >= 1 && isDate(input.start)) {
    scalar.end = fromDay(addWorkDays(toDay(input.start), input.days - 1, plan.calendar));
  }
  const r = ticketFields(ctx, base, { title: '', ...scalar });
  if (r.error) return r;
  const labels = [];
  for (const ref of arr(input.labels)) {
    const id = labelRef(plan, ref);
    if (!id) return missing('label', ref);
    if (!labels.includes(id)) labels.push(id);
  }
  const checklist = [];
  for (const item of arr(input.checklist)) {
    const c = typeof item === 'string' ? { text: item } : item;
    if (!isObj(c) || typeof c.text !== 'string') return fail('invalid_args', 'A checklist item is a text or {text, done}');
    checklist.push({ id: freshId(checklist), text: c.text.slice(0, 200), done: c.done === true });
  }
  const urls = [];
  for (const u of arr(input.urls)) {
    const f = urlFields({ title: undefined, ...u });
    if (f.error || !f.fields.url) return f.error ? f : fail('invalid_args', 'A link needs an http(s) url');
    urls.push({ id: freshId(urls), ...f.fields });
  }
  const ticket = { ...base, ...r.fields, status, labels, checklist, urls };
  const anchor = beforeId == null ? null : ticketRef(plan, beforeId);
  if (beforeId != null && !anchor) return missing('ticket', beforeId);
  const added = { ...plan, seq: ticket.num, tickets: [...plan.tickets, ticket], order: placeIds([...plan.order, ticket.id], [ticket.id], anchor) };
  const out = pipe({ ...ctx, plan: added }, [
    ...(input.parent != null ? [(c) => setParent(c, [ticket.id], input.parent)] : []),
    ...arr(input.deps).map((d) => (c) => addDep(c, d?.on, ticket.id, d?.type, d?.lag)),
    ...(input.draftId ? [(c) => linkDraft(c, ticket.id, input.draftId)] : []),
  ]);
  return out.error ? out : { ...out, result: { ...out.result, ticketId: ticket.id, num: ticket.num } };
}

/** plan.tickets.update: one field set applied to every named ticket (title, description, priority, estimate + unit,
 * start + end (send both), milestone, progress, parent, draftId (link / unlink)). Status changes through moveTicket and the
 * sub-lists (deps, labels, checklist, urls) through their per-entry reducers: a patch carrying them is refused. */
export function updateTicket(ctx, refs, patch = {}) {
  const extra = Object.keys(patch).filter((k) => !TICKET_FIELDS.includes(k));
  if (extra.length) return fail('invalid_args', `A ticket update cannot change ${extra.join(', ')}: use the per-entry commands (status: move)`);
  if (('start' in patch) !== ('end' in patch)) return fail('invalid_args', 'start and end are one field set: send both');
  const r = ticketIds(ctx.plan, refs);
  if (r.error) return r;
  if (patch.draftId && r.ids.length > 1) return fail('invalid_args', 'A draft links one ticket');
  const { parent, draftId, ...scalar } = patch;
  return pipe(ctx, [
    ...(Object.keys(scalar).length ? r.ids : []).map((id) => (c) => {
      const f = ticketFields(c, ticketOf(c.plan, id), scalar);
      return f.error ? f : { plan: setTickets(c.plan, (t) => (t.id === id ? touch({ ...t, ...f.fields }) : t)) };
    }),
    ...('parent' in patch ? [(c) => setParent(c, r.ids, parent)] : []),
    ...('draftId' in patch ? r.ids.map((id) => (c) => (draftId ? linkDraft(c, id, draftId) : unlinkDraft(c, id))) : []),
  ]);
}

/** plan.tickets.delete: children move up to the nearest kept ancestor; dependencies on the removed tickets go → {removed}. */
export function removeTickets(ctx, refs) {
  const { plan } = ctx;
  const r = ticketIds(plan, refs);
  if (r.error) return r;
  const gone = new Set(r.ids);
  const keptParent = (p) => {
    while (p && gone.has(p)) p = ticketOf(plan, p).parent;
    return p ?? null;
  };
  const tickets = plan.tickets.filter((t) => !gone.has(t.id)).map((t) => {
    const parent = keptParent(t.parent);
    const deps = t.deps.filter((d) => !gone.has(d.on));
    return parent === t.parent && deps.length === t.deps.length ? t : touch({ ...t, parent, deps });
  });
  return { plan: { ...plan, tickets, order: plan.order.filter((id) => !gone.has(id)) }, result: { removed: gone.size } };
}

/** Whether a card may drop on the column without a new tag (§3.1 write rule, shared by the reducer, the drag hint and the
 * create-tag popup): true, or 'unmapped_column' for a linked ticket or draft card over a column that follows no existing tag. */
export function canDrop(ctx, card, columnId) {
  if (columnId === null || (card.kind !== 'draft' && !(card.ticket ?? card).draftId)) return true;
  const tagId = ctx.plan.columns.find((c) => c.id === columnId)?.tagId;
  return tagId && ctx.tags?.some((t) => t.id === tagId) ? true : 'unmapped_column';
}

/** The id of a global tag named like the column (trimmed, case-insensitive) that no column of the plan maps, else null. */
export function matchingTag(ctx, columnId) {
  const name = ctx.plan.columns.find((c) => c.id === columnId)?.name.trim().toLowerCase();
  return ctx.tags?.find((t) => t.name.trim().toLowerCase() === name && !ctx.plan.columns.some((c) => c.tagId === t.id))?.id ?? null;
}

/** plan.tickets.move: tickets (and draft cards, by draft id) to the column `status` (null = "No status"), placed before
 * `beforeId` / after `afterId` when given. Unlinked tickets change `status`; linked tickets and draft cards change only
 * their draft's tag (`draftTags`). Onto a column that follows no tag that is refused (`unmapped_column`) unless `createTag`:
 * then the column maps `matchingTag` or a new tag named and coloured like it (`tags`) → {tagId, created}. */
export function moveTicket(ctx, refs, status, beforeId, afterId, { createTag = false } = {}) {
  let { plan } = ctx;
  const to = columnRef(plan, status);
  if (to === undefined) return missing('column', status);
  const ids = [];
  const drafts = [];
  for (const ref of arr(refs)) {
    const id = ticketRef(plan, ref);
    if (id) ids.push(id);
    else if (ctx.drafts?.some((d) => d.id === ref)) drafts.push(ref);
    else return missing('ticket', ref);
  }
  if (!ids.length && !drafts.length) return fail('invalid_args', 'Name at least one ticket');
  const ref = beforeId ?? afterId; // a ticket, or a draft card (a Board drop above one; it has no place in `order`)
  if (ref != null && !ticketRef(plan, ref) && !ctx.drafts?.some((d) => d.id === ref)) return missing('ticket', ref);
  const tagged = [...drafts, ...ids.map((id) => ticketOf(plan, id).draftId).filter(Boolean)];
  const out = {};
  let tagId = null;
  if (to !== null && tagged.length) {
    const col = plan.columns.find((c) => c.id === to);
    tagId = canDrop(ctx, { kind: 'draft' }, to) === true ? col.tagId : null;
    if (!tagId) {
      const match = matchingTag(ctx, to);
      if (!createTag) {
        return fail('unmapped_column', `The column '${col.name}' follows no status tag`, { columnId: to, name: col.name, color: col.color, tagId: match });
      }
      tagId = match ?? crypto.randomUUID();
      if (!match) out.tags = [...(ctx.tags ?? []), { id: tagId, name: col.name, color: col.color }];
      plan = { ...plan, columns: plan.columns.map((c) => (c.id === to ? { ...c, tagId } : c)) };
      out.result = { tagId, created: !match };
    }
  }
  if (tagged.length) {
    out.draftTags = { ...ctx.draftTags };
    for (const id of tagged) {
      if (tagId) out.draftTags[id] = tagId;
      else delete out.draftTags[id];
    }
  }
  plan = setTickets(plan, (t) => (ids.includes(t.id) && !t.draftId && t.status !== to ? touch({ ...t, status: to }) : t));
  const anchor = ticketRef(plan, ref);
  if (anchor && ids.length) plan = { ...plan, order: placeIds(plan.order, ids, beforeId != null ? anchor : null, beforeId != null ? null : anchor) };
  return { plan, ...out };
}

/** Order only (Backlog row drag, Shift+↑/↓): before `beforeId` or after `afterId` (neither: to the end). */
export function reorder(ctx, refs, beforeId, afterId) {
  const { plan } = ctx;
  const r = ticketIds(plan, refs);
  if (r.error) return r;
  const ref = beforeId ?? afterId;
  const anchor = ref == null ? null : ticketRef(plan, ref);
  if (ref != null && !anchor) return missing('ticket', ref);
  return { plan: { ...plan, order: placeIds(plan.order, r.ids, beforeId != null ? anchor : null, beforeId != null ? null : anchor) } };
}

/** The parent of the tickets (null: top level); refused `cycle` when it is one of them or below them, and `parent_dep` when
 * the new parent has dependencies (a parent with children has none, §3.1). */
export function setParent(ctx, refs, parentRef) {
  const { plan } = ctx;
  const r = ticketIds(plan, refs);
  if (r.error) return r;
  const parent = parentRef == null ? null : ticketRef(plan, parentRef);
  if (parentRef != null && !parent) return missing('ticket', parentRef);
  for (let p = parent; p; p = ticketOf(plan, p).parent) if (r.ids.includes(p)) return fail('cycle', 'A ticket cannot be placed under itself or its sub-tickets');
  if (parent && hasDeps(plan, parent)) return fail('parent_dep', 'The new parent has dependencies: remove them first (a parent ticket has none)');
  return { plan: setTickets(plan, (t) => (r.ids.includes(t.id) && t.parent !== parent ? touch({ ...t, parent }) : t)) };
}

/** Links the ticket to a draft of the thread (§3.1): when its column follows a tag, the draft gets that tag; otherwise the
 * draft keeps its tag and the ticket shows in that tag's column (`result.status`, for the toast). */
export function linkDraft(ctx, ref, draftId) {
  const { plan } = ctx;
  const id = ticketRef(plan, ref);
  if (!id) return missing('ticket', ref);
  if (!ctx.drafts?.some((d) => d.id === draftId)) return missing('draft', draftId);
  const other = plan.tickets.find((t) => t.draftId === draftId && t.id !== id);
  if (other) return fail('exists', `#${other.num} already links that draft`);
  const col = statusOf(ticketOf(plan, id), ctx);
  const next = { plan: setTickets(plan, (t) => (t.id === id ? touch({ ...t, draftId }) : t)) };
  if (col !== null && canDrop(ctx, { kind: 'draft' }, col) === true) {
    return { ...next, draftTags: { ...ctx.draftTags, [draftId]: plan.columns.find((c) => c.id === col).tagId } };
  }
  return { ...next, result: { status: columnForTag(ctx, ctx.draftTags?.[draftId]) } };
}

/** Unlinks the ticket; it keeps the column its draft's tag gave it. */
export function unlinkDraft(ctx, ref) {
  const id = ticketRef(ctx.plan, ref);
  if (!id) return missing('ticket', ref);
  return { plan: setTickets(ctx.plan, (t) => (t.id === id && t.draftId ? touch({ ...t, status: statusOf(t, ctx), draftId: null }) : t)) };
}

/** Unlinks tickets whose draft is not in ctx.drafts any more (the same plan object when none). */
export function pruneDrafts(ctx) {
  const gone = ctx.plan.tickets.filter((t) => t.draftId && !ctx.drafts?.some((d) => d.id === t.draftId));
  return gone.length ? pipe(ctx, gone.map((t) => (c) => unlinkDraft(c, t.id))) : { plan: ctx.plan };
}

/** Sets `completedAt` on tickets that became done and clears it on those that left done (the same plan object when none). */
export function syncCompleted(ctx) {
  const done = doneColumnOf(ctx.plan);
  let changed = false;
  const tickets = ctx.plan.tickets.map((t) => {
    const isDone = statusOf(t, ctx) === done;
    if (isDone === (t.completedAt != null)) return t;
    changed = true;
    return { ...t, completedAt: isDone ? Date.now() : null };
  });
  return { plan: changed ? { ...ctx.plan, tickets } : ctx.plan };
}

export const setBaseline = (ctx) => ({
  plan: { ...ctx.plan, baselineAt: Date.now(), tickets: ctx.plan.tickets.map((t) => ({ ...t, baseline: t.start ? { start: t.start, end: t.end } : null })) },
});
export const clearBaseline = (ctx) => ({
  plan: { ...ctx.plan, baselineAt: null, tickets: ctx.plan.tickets.map((t) => (t.baseline ? { ...t, baseline: null } : t)) },
});

/** plan.import (§8.3): creates every task, then resolves `parent` and `deps[].on` (a task's tempId, `#num` or ticket id);
 * all or nothing → {created: [{tempId, ticketId, num}]}. */
export function importTasks(ctx, tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return fail('invalid_args', 'Give at least one task');
  const temps = tasks.map((t) => t?.tempId).filter((id) => id != null).map(String);
  if (new Set(temps).size < temps.length) return fail('invalid_args', 'Every tempId must be unique');
  const created = [];
  const ref = (x) => created[tasks.findIndex((t) => t?.tempId != null && String(t.tempId) === String(x))]?.ticketId ?? x;
  const out = pipe(ctx, [
    ...tasks.map((task) => (c) => {
      const { tempId, parent, deps, ...rest } = isObj(task) ? task : {};
      const r = addTicket(c, rest);
      if (!r.error) created.push({ tempId, ticketId: r.result.ticketId, num: r.result.num });
      return r;
    }),
    ...tasks.flatMap((task, i) => [
      ...(task?.parent != null ? [(c) => setParent(c, [created[i].ticketId], ref(task.parent))] : []),
      ...arr(task?.deps).map((d) => (c) => addDep(c, ref(d?.on), created[i].ticketId, d?.type, d?.lag)),
    ]),
  ]);
  return out.error ? out : { ...out, result: { created } };
}

// --- a ticket's sub-lists ---

// Applies `fn(ticket)` → {ticket, result?} | {error} to the ticket `ref`.
function withTicket(ctx, ref, fn) {
  const id = ticketRef(ctx.plan, ref);
  if (!id) return missing('ticket', ref);
  const r = fn(ticketOf(ctx.plan, id));
  if (r.error) return r;
  return { plan: setTickets(ctx.plan, (t) => (t.id === id ? touch(r.ticket) : t)), ...(r.result && { result: r.result }) };
}

// Applies `fn(entry, index)` to entry `itemId` of the ticket's list `key`.
const withEntry = (ctx, ref, key, itemId, fn) => withTicket(ctx, ref, (t) => {
  const at = t[key].findIndex((x) => x.id === itemId);
  return at < 0 ? missing(key === 'urls' ? 'link' : 'checklist item', itemId) : fn(t, at);
});

function depOf(ctx, fromRef, toRef) {
  const from = ticketRef(ctx.plan, fromRef);
  const to = ticketRef(ctx.plan, toRef);
  if (!from) return missing('ticket', fromRef);
  if (!to) return missing('ticket', toRef);
  return { from, to, at: ticketOf(ctx.plan, to).deps.findIndex((d) => d.on === from) };
}

/** plan.deps.add: `to` depends on `from` (type FS | SS | FF | SF, lag in working days). Refused `cycle` (incl. a self
 * dependency), `parent_dep` (either end has children) or `exists`. */
export function addDep(ctx, fromRef, toRef, type = 'FS', lag = 0) {
  const d = depOf(ctx, fromRef, toRef);
  if (d.error) return d;
  if (!DEP_TYPES.includes(type) || !Number.isInteger(lag)) return fail('invalid_args', 'type is FS, SS, FF or SF; lag is whole working days');
  if (d.from === d.to) return fail('cycle', 'A ticket cannot depend on itself');
  if (hasKids(ctx.plan, d.from) || hasKids(ctx.plan, d.to)) return fail('parent_dep', 'A parent ticket has no dependencies: link its sub-tickets');
  if (d.at >= 0) return fail('exists', 'That dependency exists');
  if (hasCycle(ctx.plan.tickets, d)) return fail('cycle', 'That dependency would close a cycle');
  return withTicket(ctx, d.to, (t) => ({ ticket: { ...t, deps: [...t.deps, { on: d.from, type, lag }] } }));
}

export function updateDep(ctx, fromRef, toRef, patch = {}) {
  const d = depOf(ctx, fromRef, toRef);
  if (d.error) return d;
  if (d.at < 0) return missing('dependency', `${fromRef} to ${toRef}`);
  if (('type' in patch && !DEP_TYPES.includes(patch.type)) || ('lag' in patch && !Number.isInteger(patch.lag))) {
    return fail('invalid_args', 'type is FS, SS, FF or SF; lag is whole working days');
  }
  const { type, lag } = patch;
  return withTicket(ctx, d.to, (t) => ({ ticket: { ...t, deps: t.deps.with(d.at, { ...t.deps[d.at], ...(type && { type }), ...('lag' in patch && { lag }) }) } }));
}

export function removeDep(ctx, fromRef, toRef) {
  const d = depOf(ctx, fromRef, toRef);
  if (d.error) return d;
  if (d.at < 0) return missing('dependency', `${fromRef} to ${toRef}`);
  return withTicket(ctx, d.to, (t) => ({ ticket: { ...t, deps: t.deps.toSpliced(d.at, 1) } }));
}

/** plan.tickets.labels.add: the label on every named ticket; `replace` swaps that label for it in place (swimlane drop). */
export function addTicketLabel(ctx, refs, labelId, replace) {
  const { plan } = ctx;
  const r = ticketIds(plan, refs);
  if (r.error) return r;
  const id = labelRef(plan, labelId);
  if (!id) return missing('label', labelId);
  const old = replace == null ? null : labelRef(plan, replace);
  if (replace != null && !old) return missing('label', replace);
  return {
    plan: setTickets(plan, (t) => {
      if (!r.ids.includes(t.id)) return t;
      let labels = t.labels;
      if (old && old !== id && labels.includes(old)) labels = labels.includes(id) ? labels.filter((l) => l !== old) : labels.map((l) => (l === old ? id : l));
      else if (!labels.includes(id)) labels = [...labels, id];
      return labels === t.labels ? t : touch({ ...t, labels });
    }),
  };
}

export function removeTicketLabel(ctx, refs, labelId) {
  const { plan } = ctx;
  const r = ticketIds(plan, refs);
  if (r.error) return r;
  const id = labelRef(plan, labelId);
  if (!id) return missing('label', labelId);
  return { plan: setTickets(plan, (t) => (r.ids.includes(t.id) && t.labels.includes(id) ? touch({ ...t, labels: t.labels.filter((l) => l !== id) }) : t)) };
}

function checkFields(patch) {
  const fields = {};
  if ('text' in patch) {
    if (typeof patch.text !== 'string') return fail('invalid_args', 'A checklist item needs a text');
    fields.text = patch.text.slice(0, 200);
  }
  if ('done' in patch) fields.done = !!patch.done;
  return { fields };
}

/** plan.checklist.add: {text, done?} before `beforeId` (else last) → {itemId}. */
export const addCheck = (ctx, ref, item = {}, beforeId) => withTicket(ctx, ref, (t) => {
  const f = checkFields({ text: undefined, ...item });
  if (f.error) return f;
  const entry = { id: freshId(t.checklist), done: false, ...f.fields };
  const checklist = placeEntry([...t.checklist, entry], entry.id, beforeId ?? null, null);
  return checklist ? { ticket: { ...t, checklist }, result: { itemId: entry.id } } : missing('checklist item', beforeId);
});

export const updateCheck = (ctx, ref, itemId, patch = {}) => withEntry(ctx, ref, 'checklist', itemId, (t, at) => {
  const f = checkFields(patch);
  return f.error ? f : { ticket: { ...t, checklist: t.checklist.with(at, { ...t.checklist[at], ...f.fields }) } };
});

export const moveCheck = (ctx, ref, itemId, beforeId, afterId) => withEntry(ctx, ref, 'checklist', itemId, (t) => {
  const checklist = placeEntry(t.checklist, itemId, beforeId, afterId);
  return checklist ? { ticket: { ...t, checklist } } : missing('checklist item', beforeId ?? afterId);
});

export const removeCheck = (ctx, ref, itemId) => withEntry(ctx, ref, 'checklist', itemId, (t, at) => ({ ticket: { ...t, checklist: t.checklist.toSpliced(at, 1) } }));

function urlFields(patch) {
  const fields = {};
  if ('url' in patch) {
    if (typeof patch.url !== 'string' || !WEB.test(patch.url)) return fail('invalid_args', 'A link is an http(s) url');
    fields.url = patch.url;
  }
  if ('title' in patch && patch.title !== undefined) fields.title = String(patch.title ?? '').slice(0, 80);
  return { fields };
}

/** plan.urls.add: {url, title?} → {urlId}. */
export const addUrl = (ctx, ref, link = {}) => withTicket(ctx, ref, (t) => {
  const f = urlFields({ url: undefined, ...link });
  if (f.error) return f;
  const entry = { id: freshId(t.urls), ...f.fields };
  return { ticket: { ...t, urls: [...t.urls, entry] }, result: { urlId: entry.id } };
});

export const updateUrl = (ctx, ref, urlId, patch = {}) => withEntry(ctx, ref, 'urls', urlId, (t, at) => {
  const f = urlFields(patch);
  return f.error ? f : { ticket: { ...t, urls: t.urls.with(at, { ...t.urls[at], ...f.fields }) } };
});

export const removeUrl = (ctx, ref, urlId) => withEntry(ctx, ref, 'urls', urlId, (t, at) => ({ ticket: { ...t, urls: t.urls.toSpliced(at, 1) } }));

// --- selectors (§3.6) ---

/** The unit `id` ('d' and unknown ids → the working day). */
export const unitOf = (plan, id) => plan.units.find((u) => u.id === id) ?? D_UNIT;
/** The ticket's estimate in working days, or null. */
export const estimateDays = (plan, t) => (t.estimate == null ? null : t.estimate * unitOf(plan, t.unit).daysPer);

// The options with their defaults; a label filter ignores labels the plan no longer has (§8.3 plan.labels.remove).
const optionsOf = (plan, options) => {
  const o = { ...OPTION_DEFAULTS, ...options };
  return o.labels ? { ...o, labels: o.labels.filter((l) => plan.labels.some((x) => x.id === l)) } : o;
};

/** The tickets that pass the options' filters (columns, labels, priority, hideDone, doneWithinDays, search), in `order`. */
export function filterTickets(ctx, options = {}) {
  const { plan } = ctx;
  const o = optionsOf(plan, options);
  const done = doneColumnOf(plan);
  const q = o.search.trim().toLowerCase();
  const today = toDay(ctx.today) ?? Math.floor(Date.now() / 86400000);
  const rank = new Map(plan.order.map((id, i) => [id, i]));
  return plan.tickets.filter((t) => {
    const status = statusOf(t, ctx);
    if (o.columns && !o.columns.includes(status)) return false;
    if (o.labels?.length && !t.labels.some((l) => o.labels.includes(l))) return false;
    if (o.priority?.length && !o.priority.includes(t.priority)) return false;
    if (status === done && (o.hideDone || (o.doneWithinDays && !(t.completedAt != null && today - Math.floor(t.completedAt / 86400000) < o.doneWithinDays)))) return false;
    return !q || `#${t.num} ${t.title} ${t.description}`.toLowerCase().includes(q);
  }).sort((a, b) => rank.get(a.id) - rank.get(b.id));
}

/** Board cards: the filtered tickets, then (showDrafts, and no label or priority filter) the thread's drafts that no ticket
 * links; `unpushedOnly` drops cards whose draft is pushed. [{kind, id, status, title, pushedAt, ticket?, draft?}] */
export function cards(ctx, options = {}) {
  const o = optionsOf(ctx.plan, options);
  const draftOf = (id) => ctx.drafts?.find((d) => d.id === id);
  const out = filterTickets(ctx, o).map((t) => ({ kind: 'ticket', id: t.id, status: statusOf(t, ctx), title: t.title, pushedAt: draftOf(t.draftId)?.pushedAt ?? null, ticket: t }));
  if (o.showDrafts && !o.labels?.length && !o.priority?.length) {
    const linked = new Set(ctx.plan.tickets.map((t) => t.draftId));
    const done = doneColumnOf(ctx.plan);
    const q = o.search.trim().toLowerCase();
    for (const draft of ctx.drafts ?? []) {
      const status = columnForTag(ctx, ctx.draftTags?.[draft.id]);
      if (linked.has(draft.id) || (o.columns && !o.columns.includes(status)) || (o.hideDone && status === done)) continue;
      if (q && !(draft.title ?? '').toLowerCase().includes(q)) continue;
      out.push({ kind: 'draft', id: draft.id, status, title: draft.title ?? '', pushedAt: draft.pushedAt ?? null, draft });
    }
  }
  return o.unpushedOnly ? out.filter((c) => c.pushedAt == null) : out;
}

/** Board columns: "No status" (id null) first when it has cards or options.columns names it, then the plan's columns
 * (filtered by options.columns) with `done` marking the done column. */
export function columnsOf(ctx, options = {}) {
  const o = { ...OPTION_DEFAULTS, ...options };
  const done = doneColumnOf(ctx.plan);
  const cols = ctx.plan.columns.filter((c) => !o.columns || o.columns.includes(c.id)).map((c) => ({ ...c, done: c.id === done }));
  const none = o.columns?.includes(null) || cards(ctx, o).some((c) => c.status === null);
  return none ? [{ id: null, name: 'No status', color: null, tagId: null, wip: null, done: false }, ...cols] : cols;
}

/** The tickets as a tree in `order`: [{ticket, depth, children}]. */
export function tree(plan) {
  const rank = new Map(plan.order.map((id, i) => [id, i]));
  const ids = new Set(plan.tickets.map((t) => t.id));
  const kids = new Map();
  for (const t of [...plan.tickets].sort((a, b) => rank.get(a.id) - rank.get(b.id))) {
    const p = ids.has(t.parent) ? t.parent : null;
    kids.set(p, [...(kids.get(p) ?? []), t]);
  }
  const build = (p, depth) => (kids.get(p) ?? []).map((ticket) => ({ ticket, depth, children: build(ticket.id, depth + 1) }));
  return build(null, 0);
}

/** A parent's derived values over its leaf descendants: {start, end, progress (weighted by estimateDays, by count when no
 * leaf has an estimate), estimateDays (sum)}; null without children. */
export function summary(plan, ticketId) {
  const leaves = [];
  const walk = (id) => plan.tickets.filter((t) => t.parent === id).forEach((t) => (hasKids(plan, t.id) ? walk(t.id) : leaves.push(t)));
  walk(ticketId);
  if (!leaves.length) return null;
  const dated = leaves.filter((t) => t.start);
  const days = leaves.map((t) => estimateDays(plan, t));
  const weighted = days.some((d) => d > 0);
  const weight = (i) => (weighted ? days[i] ?? 0 : 1);
  const total = leaves.reduce((s, _, i) => s + weight(i), 0);
  return {
    start: dated.length ? dated.map((t) => t.start).sort()[0] : null,
    end: dated.length ? dated.map((t) => t.end).sort().at(-1) : null,
    progress: total ? Math.round(leaves.reduce((s, t, i) => s + t.progress * weight(i), 0) / total) : 0,
    estimateDays: days.some((d) => d != null) ? days.reduce((s, d) => s + (d ?? 0), 0) : null,
  };
}

/** The ticket's predecessors that are not done. */
export function blockers(ctx, ref) {
  const t = ticketOf(ctx.plan, ticketRef(ctx.plan, ref));
  const done = doneColumnOf(ctx.plan);
  return (t?.deps ?? []).map((d) => ticketOf(ctx.plan, d.on)).filter((p) => p && statusOf(p, ctx) !== done);
}

/** Tickets that are not done and have no open blockers, in `order`. */
export function ready(ctx) {
  const done = doneColumnOf(ctx.plan);
  return filterTickets(ctx).filter((t) => statusOf(t, ctx) !== done && !blockers(ctx, t.id).length);
}

/** {[columnId]: {count, limit, over}} over every ticket and draft card (advisory: it never blocks a move). */
export function wipState(ctx) {
  const all = cards(ctx);
  return Object.fromEntries(ctx.plan.columns.map((c) => {
    const count = all.filter((x) => x.status === c.id).length;
    return [c.id, { count, limit: c.wip, over: c.wip != null && count > c.wip }];
  }));
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// '8–13 Oct', '30 Sep–2 Oct', '16 Oct'.
function dateRange(start, end) {
  const [s, e] = [toDay(start), toDay(end)];
  if (s === e) return fmt(s, 'd MMM');
  return start.slice(0, 7) === end.slice(0, 7) ? `${fmt(s, 'd')}-${fmt(e, 'd MMM')}` : `${fmt(s, 'd MMM')} to ${fmt(e, 'd MMM')}`;
}

/** The plan as text: 'markdown' (one line per ticket in tree order: `#12 Title — Column · 3 pt · 8–13 Oct · deps #3`),
 * 'mermaid' (a gantt chart: one section per top-level parent, `crit`, `milestone`, `after` for FS dependencies without lag)
 * or 'json'. */
export function describe(ctx, format = 'markdown') {
  const { plan } = ctx;
  if (format === 'json') return JSON.stringify(plan, null, 2);
  const num = (id) => `#${ticketOf(plan, id).num}`;
  if (format === 'markdown') {
    const lines = [`# ${plan.title || plan.threadUrl}`, ''];
    const walk = (nodes) => nodes.forEach(({ ticket: t, depth, children }) => {
      const parts = [plan.columns.find((c) => c.id === statusOf(t, ctx))?.name ?? 'No status'];
      if (t.estimate != null) parts.push(`${t.estimate} ${unitOf(plan, t.unit).name}`);
      if (t.start) parts.push(dateRange(t.start, t.end));
      if (t.deps.length) parts.push(`deps ${t.deps.map((d) => `${num(d.on)}${d.type === 'FS' ? '' : ` ${d.type}`}${d.lag ? ` ${d.lag > 0 ? '+' : ''}${d.lag}` : ''}`).join(', ')}`);
      lines.push(`${'  '.repeat(depth)}- #${t.num} ${t.title} (${parts.join('; ')})`);
      walk(children);
    });
    walk(tree(plan));
    return lines.join('\n');
  }
  const { byId } = schedule(ctx);
  const clean = (s) => String(s).replace(/[:;#\n]/g, ' ').trim() || 'Untitled';
  const off = DAY_NAMES.filter((_, d) => !plan.calendar.workdays.includes(d));
  const excludes = [...(off.join() === 'sunday,saturday' ? ['weekends'] : off), ...plan.calendar.holidays];
  const lines = ['gantt', `  title ${clean(plan.title || 'Plan')}`, '  dateFormat YYYY-MM-DD', ...(excludes.length ? [`  excludes ${excludes.join(', ')}`] : [])];
  const leaves = (node) => (node.children.length ? node.children.flatMap(leaves) : [node.ticket]);
  const roots = tree(plan);
  const sections = [['Tasks', roots.filter((n) => !n.children.length).map((n) => n.ticket)], ...roots.filter((n) => n.children.length).map((n) => [n.ticket.title, leaves(n)])];
  for (const [title, tickets] of sections) {
    const rows = tickets.filter((t) => byId[t.id].scheduled);
    if (!rows.length) continue;
    lines.push(`  section ${clean(title)}`);
    for (const t of rows) {
      const n = byId[t.id];
      const after = t.deps.length && t.deps.every((d) => d.type === 'FS' && !d.lag && byId[d.on]?.scheduled) ? `after ${t.deps.map((d) => `t${ticketOf(plan, d.on).num}`).join(' ')}` : t.start;
      lines.push(`    ${clean(t.title)} :${n.critical ? 'crit, ' : ''}${t.milestone ? 'milestone, ' : ''}t${t.num}, ${after}, ${n.d}d`);
    }
  }
  return lines.join('\n');
}

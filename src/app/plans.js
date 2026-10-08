import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { chartRefs } from '../doc-utils.mjs';
import { addWorkDays, fromDay, nextWorkday, toDay, todayStr } from '../plan/dates.mjs';
import { PLAN_COMMANDS, PLAN_GATES } from '../plan/plan-commands.mjs';
import { describe, doneColumnOf, estimateDays, parseOptions, parsePlan, pruneDrafts, statusOf, syncCompleted, unmapTag } from '../plan/plan-model.mjs';
import { autoScheduled } from '../plan/schedule.mjs';
import { planSource, tabOf } from '../plan-chart.js';
import { afterNodeSel, confirmDialog, saveSettings, threadLabel } from './actions.js';
import { ChartView } from './components/plan/ChartView.jsx';
import { tagList } from './drafts-meta.js';
import { can, GATES } from './gates.mjs';
import { getState, setState, subscribe as onStore } from './store.js';
import { closeWorkspace, openWorkspace } from './views.js';

// The plan workspace's store (Gantt plan §4, §6, §8.2; roadmap A2): every plan file (api.plans) parsed in memory, written
// coalesced (300 ms per plan) one after another, settings first. dispatch(commandId, args) is the only writer: reducer
// (src/plan/plan-model.mjs through the descriptors of plan-commands.mjs) → undo entry → store → persist. Undo stacks are per
// plan, in memory; an entry holds the plan before / after and the draft tags the command changed.

const api = window.api;
const state = getState();
const LIMIT = 50; // undo entries per plan
const ENVELOPE = ['not_found', 'already_exists', 'invalid_args', 'precondition_failed']; // other reducer codes → 'refused'
const COMMANDS = new Map(PLAN_COMMANDS.map((c) => [c.id, c]));
export const EMPTY_UI = { selection: [], focusId: null, filter: '', options: {} };

const plans = new Map(); // id → parsed plan (never mutated: every change stores a new object)
const created = new Map(); // id → the file's `created` stamp (main stamps it on the first write)
const stacks = new Map(); // id → {past, future}: [{plan: [before, after], draftTags?: {draftId: [before, after]}}]
const timers = new Map(); // id → its pending write
const revs = new Map(); // id → changes applied this session
const listeners = new Set();
let writes = Promise.resolve();
let pending = 0; // writes sent, not yet answered
let settingsWrites = 0;
let settingsPending = 0; // settings writes of commands not yet answered
let version = 0; // what usePlans() re-renders on

const openDialog = (type, props = {}) => new Promise((resolve) => setState({ dialog: { type, props, resolve } }));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function notify(planId) {
  version++;
  revs.set(planId, (revs.get(planId) ?? 0) + 1);
  for (const fn of listeners) fn({ type: 'plan.changed', planId, rev: revs.get(planId) });
}

/** Plan events ({type: 'plan.changed', planId, rev}); → unsubscribe. */
export const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
/** Re-renders the calling component on every plan change. */
export const usePlans = () => useSyncExternalStore(subscribe, () => version);

export const planById = (id) => plans.get(id) ?? null;
export const planList = () => [...plans.values()];
/** The thread's plan (the newest when a hand copy made two). */
export const planFor = (threadUrl) => planList().filter((p) => p.threadUrl === threadUrl).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0] ?? null;

/** What the selectors and reducers read (§3.3): the plan, the global tags, the thread's drafts, their tags, today. */
export function planContext(id, plan = plans.get(id)) {
  if (!plan) return null;
  const s = state.settings;
  return { plan, tags: tagList(s), drafts: state.drafts.filter((d) => d.threadUrl === plan.threadUrl), draftTags: s.draftTags ?? {}, today: todayStr() };
}

// The plan charts in drafts (src/plan-chart.js) read the plans through planSource: live charts redraw after any plan,
// draft or settings change.
Object.assign(planSource, {
  context: (id) => planContext(id),
  subscribe(fn) {
    let seen = [state.settings, state.drafts];
    const offStore = onStore(() => {
      if (state.settings === seen[0] && state.drafts === seen[1]) return;
      seen = [state.settings, state.drafts];
      fn();
    });
    const offPlans = subscribe(() => fn());
    return () => {
      offStore();
      offPlans();
    };
  },
  Chart: ChartView,
  open: (id, view) => openPlan(id, tabOf(view)),
});

/** Tickets of the plan that are not in its done column (the sidebar's thread row count). */
export function openCount(id) {
  const ctx = planContext(id);
  if (!ctx) return 0;
  const done = doneColumnOf(ctx.plan);
  return ctx.plan.tickets.filter((t) => statusOf(t, ctx) !== done).length;
}

/** How many plan columns follow the global tag (Settings: deleting it unmaps them). */
export const columnsFollowing = (tagId) => planList().reduce((n, p) => n + p.columns.filter((c) => c.tagId === tagId).length, 0);

// --- persistence ---

function persist(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const plan = plans.get(id);
  if (!plan) return writes;
  pending++;
  writes = writes.then(() => api.plans.save({ ...plan, created: created.get(id) ?? plan.created })).then(
    (r) => created.set(id, r.created),
    (e) => toast.error(`Could not save the plan: ${e.message || e}`), // the next change writes it again
  ).finally(() => pending--);
  return writes;
}

function schedule(id) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => persist(id), 300));
}

/** Settings values a command changed (tags, draftTags): shown at once, sent at once, the plan written after them. */
function saveSettingsFirst(patch) {
  setState({ settings: { ...state.settings, ...patch } });
  const n = ++settingsWrites;
  settingsPending++;
  const sent = api.settings.set(patch).then(
    (settings) => n === settingsWrites && setState({ settings }), // an older answer would undo a newer shown change
    (e) => toast.error(`Could not save the settings: ${e.message || e}`),
  ).finally(() => settingsPending--);
  writes = writes.then(() => sent);
}

/** Writes the pending plan changes at once. */
export function flushPlans() {
  for (const id of [...timers.keys()]) persist(id);
  return writes;
}

/** Startup: every plan file, parsed and with links to deleted drafts dropped (saved back once); then the store follows
 * settings and drafts: a deleted global tag unmaps its column, done stamps follow the draft tags. */
export async function initPlans() {
  let list = [];
  try {
    list = await api.plans.list();
  } catch (e) {
    toast.error(`Could not read the plans: ${e.message || e}`);
  }
  for (const json of list) {
    const raw = parsePlan(json, { tags: tagList(state.settings) });
    if (raw.id !== json.id || !raw.threadUrl) continue;
    const plan = pruneDrafts(planContext(raw.id, raw)).plan;
    plans.set(plan.id, plan);
    created.set(plan.id, json.created);
    if (plan !== raw) schedule(plan.id);
  }
  version++;
  let seen = { settings: state.settings, drafts: state.drafts };
  onStore(() => {
    const { settings, drafts } = state;
    if (settings === seen.settings && drafts === seen.drafts) return;
    // Tags deleted in Settings; not while a command's own settings write is out (another, older answer may lack its new tag).
    const removed = settingsPending ? [] : tagList(seen.settings).filter((t) => !tagList(settings).some((x) => x.id === t.id)).map((t) => t.id);
    const draftsChanged = drafts !== seen.drafts;
    seen = { settings, drafts };
    for (const [id, plan] of plans) {
      let ctx = planContext(id);
      for (const tagId of removed) ctx = { ...ctx, plan: unmapTag(ctx, tagId).plan };
      if (draftsChanged) ctx = { ...ctx, plan: pruneDrafts(ctx).plan };
      const next = syncCompleted(ctx).plan;
      if (next === plan) continue;
      plans.set(id, next);
      notify(id);
      schedule(id);
    }
  });
  // Closing the window waits for the plan writes (as for the draft's own save, actions.js onBeforeUnload).
  window.addEventListener('beforeunload', (e) => {
    if (state.smoke || state.syncReload || !(timers.size || pending)) return; // syncReload: GitHub backup (actions.js startGitHub)
    e.preventDefault();
    e.returnValue = false;
    flushPlans().then(() => (state.forceClose || !(state.dirty || state.saving)) && window.close()); // else the draft's save closes it
  });
}

// --- dispatch and undo ---

const failure = (code, message, data) => ({ ok: false, error: { code, message, ...(data && { data }) } });

// The draft tags a command changed: {draftId: [before, after]} (null: untagged), or null when none.
function tagChanges(before, after) {
  const out = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[id] !== after[id]) out[id] = [before[id] ?? null, after[id] ?? null];
  return Object.keys(out).length ? out : null;
}

// Stores a reducer result `out` computed on `ctx`: settings first, done stamps synced, an undo entry unless `undoable` is
// false. → the plan's rev.
function apply(ctx, out, undoable) {
  const id = out.plan.id;
  const before = plans.get(id);
  const patch = { ...(out.tags && { tags: out.tags }), ...(out.draftTags && { draftTags: out.draftTags }) };
  if (Object.keys(patch).length) saveSettingsFirst(patch);
  const plan = syncCompleted({ ...ctx, ...patch, plan: out.plan }).plan;
  if (undoable && before) {
    const st = stacks.get(id) ?? stacks.set(id, { past: [], future: [] }).get(id);
    const draftTags = out.draftTags && tagChanges(ctx.draftTags, out.draftTags);
    st.past.push({ plan: [before, plan], ...(draftTags && { draftTags }) });
    if (st.past.length > LIMIT) st.past.shift();
    st.future = [];
  }
  plans.set(id, plan);
  notify(id);
  if (before) schedule(id);
  else persist(id); // a new plan: on disk at once
  return revs.get(id);
}

/** Runs the plan command `id` (plan-commands.mjs) with `args` (§8.2): gates, reducer, undo entry, store, persist.
 * → {ok: true, result, rev} | {ok: false, error: {code, message, data?}}. A failed UI command toasts its message unless
 * `quiet`. Imperative commands (open, close, insertChart, render, delete, undo, redo) are the functions below, not here. */
export function dispatch(id, args = {}, { source = 'ui', quiet = false } = {}) {
  const r = run(id, args);
  if (!r.ok && source === 'ui' && !quiet) toast.error(r.error.message);
  return r;
}

function run(id, args) {
  const cmd = COMMANDS.get(id);
  if (!cmd?.plan && !cmd?.read) return failure('unknown_command', `Unknown plan command ${id}`);
  const all = id === 'plan.create' || id === 'plan.list';
  const ctx = all ? { plans: planList(), tags: tagList(state.settings), drafts: state.drafts, draftTags: state.settings.draftTags ?? {} }
    : planContext(args.planId ?? planFor(args.threadUrl)?.id);
  if (!ctx) return failure('not_found', 'No such plan');
  const failed = cmd.needs.map((g) => [g, PLAN_GATES[g] ?? GATES[g]]).filter(([g, gate]) => !(PLAN_GATES[g] ? gate.test(ctx.plan) : can(g, state)))
    .map(([gate, { message, fix }]) => ({ gate, message, fix }));
  if (failed.length) return failure('precondition_failed', failed[0].message, { failed });
  if (cmd.read) return { ok: true, result: cmd.read(ctx, args) };
  const out = cmd.plan(ctx, args);
  if (out.error) return refused(out.error);
  return { ok: true, result: out.result ?? {}, rev: apply(ctx, rescheduled(ctx, out, [id]), cmd.undo === 'own') };
}

const refused = ({ code, message, data }) => (ENVELOPE.includes(code) ? failure(code, message, data) : failure('refused', message, { code, ...data }));

/** Builder commands of one plan as one change and one undo entry (a Gantt drag that moves several tickets): `steps` =
 * [[commandId, args]] (planId added), each run on the result of the one before; the first refusal toasts and applies
 * nothing. For commands without gates (`needs`). → {ok: true, rev} | {ok: false, error}. */
export function dispatchAll(planId, steps) {
  const ctx = planContext(planId);
  if (!ctx) return failure('not_found', 'No such plan');
  let out = { plan: ctx.plan };
  for (const [id, args] of steps) {
    const r = COMMANDS.get(id).plan({ ...ctx, plan: out.plan, ...(out.draftTags && { draftTags: out.draftTags }) }, { planId, ...args });
    if (r.error) {
      const f = refused(r.error);
      toast.error(f.error.message);
      return f;
    }
    out = { ...out, ...r };
  }
  return { ok: true, rev: apply(ctx, rescheduled(ctx, out, steps.map((s) => s[0])), true) };
}

// With plan.autoSchedule on, a change of dates, dependencies or the calendar also moves every ticket that starts before its
// predecessors allow to its earliest start (Gantt plan §6.5), in the same undo entry; the first time a session, a toast.
const RESCHEDULE = new Set(['plan.update', 'plan.holidays.add', 'plan.holidays.remove', 'plan.tickets.create', 'plan.tickets.update', 'plan.deps.add', 'plan.deps.update', 'plan.import']);
let autoToasted = false;
function rescheduled(ctx, out, ids) {
  if (!out.plan.autoSchedule || !ids.some((id) => RESCHEDULE.has(id))) return out;
  const plan = autoScheduled(out.plan, { ...ctx, ...(out.draftTags && { draftTags: out.draftTags }) });
  if (plan === out.plan) return out;
  if (!autoToasted) {
    autoToasted = true;
    toast(`Auto-schedule moved ${plural(plan.tickets.filter((t, i) => t !== out.plan.tickets[i]).length, 'ticket')}.`);
  }
  return { ...out, plan };
}

// Undo applies an entry's plan[0] and draft tags [0] over the current tags (tags changed elsewhere since survive); redo [1].
function step(id, from, to) {
  const st = stacks.get(id);
  const entry = st?.[from].pop();
  if (!entry) return false;
  st[to].push(entry);
  const i = from === 'past' ? 0 : 1;
  let ctx = planContext(id, entry.plan[i]);
  if (entry.draftTags) {
    const draftTags = { ...ctx.draftTags };
    for (const [draft, pair] of Object.entries(entry.draftTags)) {
      if (pair[i] == null) delete draftTags[draft];
      else draftTags[draft] = pair[i];
    }
    saveSettingsFirst({ draftTags });
    ctx = { ...ctx, draftTags };
  }
  plans.set(id, syncCompleted(ctx).plan);
  notify(id);
  schedule(id);
  return true;
}

export const undoPlan = (id) => step(id, 'past', 'future');
export const redoPlan = (id) => step(id, 'future', 'past');
export const canUndoPlan = (id) => !!stacks.get(id)?.past.length;
export const canRedoPlan = (id) => !!stacks.get(id)?.future.length;

// --- workspace ---

/** Shows the plan workspace: the plan `planId` (an id, or a thread URL), else the plan of the selected thread, else of the
 * open draft's thread (created after a confirm), else the plan picker. At startup a missing plan opens nothing. `tab`
 * defaults to the last one shown (`settings.planTab`). `opts` as for openWorkspace. */
export async function openPlan(planId = null, tab = state.settings.planTab ?? 'board', opts = {}) {
  const ref = typeof planId === 'string' ? planId : null; // not a click event
  const url = ref?.startsWith('https://') ? ref : null;
  let plan = ref && !url ? plans.get(ref) : null;
  if (ref && !url && !plan) {
    if (!opts.startup) toast.error('That plan no longer exists.');
    return false;
  }
  if (!plan) {
    if (opts.startup) return false;
    const thread = url ?? state.settings.selectedThread ?? state.draft?.threadUrl;
    plan = thread ? planFor(thread) ?? (await createPlan(thread)) : plans.get(await openDialog('planPick'));
    if (!plan) return false;
  }
  setState({ planUi: EMPTY_UI });
  const shown = await openWorkspace({ type: 'plan', planId: plan.id, tab }, opts);
  if (shown && opts.remember !== false && tab !== state.settings.planTab) await saveSettings({ planTab: tab });
  return shown;
}

async function createPlan(threadUrl) {
  const t = state.settings.threads.find((x) => x.url === threadUrl);
  const label = t ? threadLabel(t) : threadUrl;
  if (!(await confirmDialog({ title: `Create a plan board for "${label}"?`, confirmText: 'Create' }))) return null;
  const r = dispatch('plan.create', { threadUrl, title: label.slice(0, 120) });
  return r.ok ? plans.get(r.result.planId) : null;
}

/** Board / Backlog / Gantt (remembered as the last view, and as the tab the Plans page opens on). */
export function setPlanTab(tab) {
  const view = { ...state.view, tab };
  setState({ view });
  saveSettings({ lastView: view, planTab: tab });
}

// How many drafts hold a plan chart of the plan (the open one as edited; every other one loaded once).
async function draftsCharting(id) {
  let n = 0;
  for (const d of state.drafts) {
    const doc = d.id === state.draft?.id ? state.editor?.getJSON() : (await api.drafts.load(d.id).catch(() => null))?.doc;
    if (doc && chartRefs(doc).some((r) => r.planId === id)) n++;
  }
  return n;
}

/** Delete plan (header, picker): a confirm (naming the drafts that chart it), then the file goes to the plans trash. */
export async function deletePlan(id) {
  const plan = plans.get(id);
  if (!plan) return;
  const charted = await draftsCharting(id);
  if (!(await confirmDialog({
    title: `Delete the plan "${plan.title || plan.threadUrl}"?`,
    description: `${plural(plan.tickets.length, 'ticket')}. The file is moved to the plans trash folder; drafts and their tags stay.`
      + (charted ? ` ${plural(charted, 'draft')} ${charted === 1 ? 'shows' : 'show'} it in a plan chart: live charts show "Plan not found" (frozen ones keep their picture).` : ''),
    confirmText: 'Delete', destructive: true,
  }))) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  try {
    await writes; // a write in flight must not recreate the file after the removal
    await api.plans.remove(id);
  } catch (e) {
    toast.error(`Could not delete the plan: ${e.message || e}`);
    return;
  }
  plans.delete(id);
  stacks.delete(id);
  notify(id);
  if (state.view.type === 'plan' && state.view.planId === id) closeWorkspace();
}

// --- UI flows over dispatch ---

/** New ticket dialog (+ Ticket, N, Convert to ticket, Add subtask; `init` prefills title, status, draftId, parent): OK
 * creates it with every field and row in one command. Left without dates, it starts on the working day `from` (default:
 * today in the Gantt tab, else unscheduled) and lasts its estimate in working days (rounded up, at least 1; a milestone 0). */
export async function newTicket(planId, init = {}, { from = state.view.tab === 'gantt' ? todayStr() : null } = {}) {
  const ticket = await openDialog('ticket', { planId, init });
  if (!ticket) return null;
  const plan = plans.get(planId);
  if (from && plan && !ticket.start) {
    const s = nextWorkday(toDay(from), plan.calendar);
    const n = ticket.milestone ? 0 : Math.max(1, Math.ceil(estimateDays(plan, ticket) ?? 1)) - 1;
    Object.assign(ticket, { start: fromDay(s), end: fromDay(addWorkDays(s, n, plan.calendar)) });
  }
  return dispatch('plan.tickets.create', { planId, ticket });
}

export const editTicket = (planId, ticketId) => openDialog('ticket', { planId, ticketId });

/** Delete (Del, card menu, ticket dialog): a confirm naming the count. */
export async function deleteTickets(planId, ticketIds) {
  const plan = plans.get(planId);
  const ids = ticketIds.filter((id) => plan?.tickets.some((t) => t.id === id));
  if (!ids.length) return false;
  const one = ids.length === 1 && plan.tickets.find((t) => t.id === ids[0]);
  if (!(await confirmDialog({
    title: one ? `Delete #${one.num} "${one.title}"?` : `Delete ${ids.length} tickets?`,
    description: 'Sub-tickets move up a level; dependencies on them are removed. Ctrl+Z restores them.',
    confirmText: 'Delete', destructive: true,
  }))) return false;
  return dispatch('plan.tickets.delete', { planId, ticketIds: ids }).ok;
}

/** Moves cards (ticket ids, draft ids) to the column `status` (one command, one undo entry). Onto a column that follows no
 * status tag, linked tickets and draft cards first ask to create a matching tag (or to use a same-name tag no column maps);
 * Cancel leaves everything as it was. → whether they moved. */
export async function moveCards(planId, ids, status, { beforeId, afterId } = {}) {
  const args = { planId, ticketIds: ids, status, ...(beforeId ? { beforeId } : afterId ? { afterId } : {}) };
  const r = dispatch('plan.tickets.move', args, { quiet: true });
  if (r.ok) return true;
  if (r.error.data?.code !== 'unmapped_column') {
    toast.error(r.error.message);
    return false;
  }
  const { name, tagId } = r.error.data;
  const tag = tagId && tagList(state.settings).find((t) => t.id === tagId);
  const ok = await confirmDialog(tag ? {
    title: `Use the tag "${tag.name}" for this column?`,
    description: `"${name}" follows no status tag. Linked drafts get the tag "${tag.name}", and the column follows it from now on.`,
    confirmText: 'Use tag',
  } : {
    title: `Create a matching tag "${name}"?`,
    description: `"${name}" follows no status tag. A new tag "${name}" is added to Settings > Tags, the column follows it, and linked drafts get it.`,
    confirmText: 'Create',
  });
  return ok && dispatch('plan.tickets.move', { ...args, createTag: true }).ok;
}

/** Columns… (dialog rows run their own commands; its Delete asks for the target column, then the dialog comes back). */
export async function editColumns(planId) {
  for (;;) {
    const r = await openDialog('planColumns', { planId });
    if (!r?.remove) return;
    await deleteColumn(planId, r.remove);
  }
}

/** Delete column…: the target column of its unlinked tickets (default the left neighbour). */
export async function deleteColumn(planId, columnId) {
  const moveTo = await openDialog('planDeleteColumn', { planId, columnId });
  if (moveTo !== null) dispatch('plan.columns.remove', { planId, columnId, moveTo: moveTo === '' ? null : moveTo });
}

/** A name: Rename plan, Save current as… → the trimmed text, or null. */
export const askName = (title, value = '', okText = 'OK') => openDialog('planName', { title, value, okText });

export async function renamePlan(planId) {
  const title = await askName('Rename plan', plans.get(planId)?.title ?? '', 'Rename');
  if (title != null) dispatch('plan.update', { planId, patch: { title } });
}

/** Copy as Markdown / Mermaid (plan.describe). */
export function copyPlan(planId, format) {
  const r = dispatch('plan.describe', { planId, format });
  if (r.ok) navigator.clipboard.writeText(r.result.text).then(() => toast(`Copied as ${format === 'mermaid' ? 'Mermaid' : 'Markdown'}.`), (e) => toast.error(String(e)));
}

/** Export plan…: the plan JSON as a download (Electron asks where to save it). */
export function exportPlan(planId) {
  const plan = plans.get(planId);
  if (!plan) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
  a.download = `plan-${(plan.title || 'untitled').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Import plan…: a plan JSON file replaces the plan of this thread (after a confirm): a new id, this thread; the replaced
 * plan goes to the trash. */
export function importPlan(planId) {
  const old = plans.get(planId);
  if (!old) return;
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const text = await input.files[0]?.text().catch(() => null);
    if (text == null) return;
    const plan = { ...parsePlan(text, { tags: tagList(state.settings) }), id: crypto.randomUUID(), threadUrl: old.threadUrl, title: old.title };
    if (!(await confirmDialog({
      title: `Replace the plan of "${old.title || old.threadUrl}" (${plural(plan.tickets.length, 'ticket')})?`,
      description: `The current plan (${plural(old.tickets.length, 'ticket')}) is moved to the plans trash folder.`,
      confirmText: 'Replace', destructive: true,
    }))) return;
    try {
      await flushPlans();
      await api.plans.remove(old.id);
    } catch (e) {
      toast.error(`Could not replace the plan: ${e.message || e}`);
      return;
    }
    plans.delete(old.id);
    stacks.delete(old.id);
    plans.set(plan.id, syncCompleted(planContext(plan.id, pruneDrafts(planContext(plan.id, plan)).plan)).plan);
    persist(plan.id);
    notify(plan.id);
    openWorkspace({ type: 'plan', planId: plan.id, tab: state.view.tab ?? 'board' });
  });
  input.click();
}

/** Insert plan chart (toolbar, quick tools, palette): the plan of the open draft's thread; without one the plan picker (with
 * "Create a plan for this thread" when the draft has a thread). */
export async function insertPlanChartDialog() {
  if (!can('doc.open', state)) return;
  const thread = state.draft?.threadUrl ?? null;
  let plan = thread && planFor(thread);
  if (!plan) {
    const r = await openDialog('planPick', { title: 'Insert plan chart', action: 'Insert', createFor: thread });
    plan = r === 'create' ? await createPlan(thread) : plans.get(r);
  }
  if (plan) await insertPlanChart({ planId: plan.id });
}

/** A live plan chart of the plan after the selection (one undo step), from the workspace back in the editor first. */
export async function insertPlanChart({ planId, view = 'kanban', options = {} }) {
  if (!can('view.editor', state)) await closeWorkspace();
  const ed = state.editor;
  if (!ed) return;
  afterNodeSel(ed.chain().focus()).insertPlanChart({ planId, view, options: parseOptions(options) }).run();
}

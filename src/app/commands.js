import { elementFromString, getHTMLFromFragment } from '@tiptap/core';
import { closeHistory, redoDepth, redoNoScroll, undoDepth, undoNoScroll } from '@tiptap/pm/history';
import { DOMParser, Fragment } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { version as appVersion } from '../../package.json';
import { canvasEditor } from '../canvas.js';
import { BOARD_TYPES, pathOfPos, posOfPath } from '../doc-path.mjs';
import { DEFAULT_NUMBERING } from '../document/defaults.mjs';
import { normaliseHtml } from '../document/paste.js';
import { kitOf } from '../editors.js';
import { formatOf, pageOf } from '../formats.mjs';
import { activeBoard, contentWidth, migrateBoards } from '../whiteboard.js';
import * as actions from './actions.js';
import { familyOf } from './assistant/prompts.mjs';
import { IDLE as SESSION_IDLE, noteWrite, sessionFor, sessionIds } from './assistant/sessions.js';
import { invokeControl, snapshot as uiSnapshot } from './assistant/ui-control.js';
import { $defs, byId, CATALOGUE, MODEL_DEFS } from './commands/catalogue.mjs';
import { argsMessage, fail } from './commands/define.mjs';
import { assistantMode, PERMISSIONS, refusal } from './commands/tool-sets.mjs';
import { commandIdOf, toolsFor } from './commands/tools-schema.mjs';
import { argsDigest, cyrb53 } from './digest.mjs';
import * as flows from './flows.js';
import { can, GATES } from './gates.mjs';
import { enabled, listed, offArg } from '../integrations/index.mjs';
import { integrationsCtx } from '../integrations/ui.js';
import * as plans from './plans.js';
import * as references from './references.js';
import { mapPath } from './rev.js';
import { newId as suggestId, pendingCount, strip as stripRecords } from '../suggest/core.mjs';
import { noteGroup, withCall } from '../suggest/extension.js';
import { tagList } from './drafts-meta.js';
import { deref, validate, withDefaults } from './schema.mjs';
import { getState, setState, subscribe } from './store.js';

// The command executor (SPEC §8; agent-automation plan §3.3): invoke(req) is the one way a program acts on the app — the
// palette, the smoke script and agents (the in-app assistant: source 'agent:assistant'). Steps: queue → lookup → args →
// revision → preconditions (gates.mjs) → policy (the AgentAsk card) → busy → run (one transaction for a doc write) →
// stamp, audit. window.__agent = {invoke, script, on, catalogue} once the app has started (installAgent).

const state = getState();
const api = window.api;

const CODES = new Set(['unknown_command', 'invalid_args', 'precondition_failed', 'denied', 'cancelled', 'stale', 'busy', 'not_found',
  'already_exists', 'refused', 'failed', 'timeout', 'unauthorized', 'too_large']);
const SOURCE_RE = /^(ui|palette|smoke|agent:[a-z0-9][a-z0-9_-]{0,31})$/;
const ASK_MS = 60000;
const TIMEOUT = { normal: 60000, slow: 300000, max: 600000 };

const error = (code, message, data) => ({ ok: false, error: { code, message, ...(data !== undefined && { data }) } });
const isAgent = (source) => source.startsWith('agent:');
const ASSISTANT = 'agent:assistant';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Queue and entry point

let chain = Promise.resolve();

/** Runs one command request {id, args?, source, dryRun?, ifRev?, timeoutMs?} (an in-process caller may add `signal`, an
 * AbortSignal: aborting it answers `cancelled`). Every source but ui / palette waits its turn in one queue. Resolves
 * {ok: true, result, draftId, rev, undoSteps, ms, dryRun, diff?} or {ok: false, error: {code, message, data?}}; never rejects. */
export function invoke(req) {
  if (req?.source === 'ui' || req?.source === 'palette') return execute(req);
  const run = chain.then(() => execute(req));
  chain = run.catch(() => {});
  return run;
}

async function execute(req) {
  const t0 = performance.now();
  let res;
  try {
    res = await executeInner(req);
  } catch (e) {
    res = errorOf(e);
  }
  const ms = Math.round(performance.now() - t0);
  // A background session's command (draftId) carries that draft's id and rev.
  if (res.ok) Object.assign(res, { draftId: res.draftId ?? state.draft?.id ?? null, rev: res.rev ?? state.rev, ms, dryRun: !!req?.dryRun });
  if (req?.source && req.source !== 'ui') audit(req, res, ms);
  return res;
}

const errorOf = (e) => (CODES.has(e?.code) ? error(e.code, e.message, e.data) : error('failed', String(e?.message ?? e)));

/** `args` with a bare string where `schema` (an args object schema) wants an array at the top level wrapped in one, as
 * `ids: "k3j9x0a"` for ["k3j9x0a"]; the rest as it is. */
function wrapStrings(schema, args) {
  if (!isObject(args)) return args;
  const wrap = Object.entries(args).filter(([k, v]) => typeof v === 'string' && schema.properties?.[k]?.type === 'array');
  return wrap.length ? { ...args, ...Object.fromEntries(wrap.map(([k, v]) => [k, [v]])) } : args;
}

async function executeInner(req) {
  if (!isObject(req)) return error('invalid_args', 'The request must be an object {id, args, source}');
  const { id, source, dryRun = false, ifRev, timeoutMs } = req;
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return error('invalid_args', `source must match ${SOURCE_RE}`);
  const def = typeof id === 'string' ? byId(id) : null;
  if (!def) return error('unknown_command', `No command has the id ${JSON.stringify(id)} (app.capabilities lists them)`);
  if (ifRev !== undefined && !Number.isInteger(ifRev)) return error('invalid_args', 'ifRev must be an integer (a rev a read returned)');
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0)) return error('invalid_args', 'timeoutMs must be a positive integer');
  const raw = wrapStrings(def.args, req.args ?? {});
  const errs = validate(def.args, raw, $defs);
  if (errs.length) return error('invalid_args', argsMessage(def, errs[0], $defs), errs[0]);
  const args = withDefaults(def.args, raw, $defs);
  const opts = { source, dryRun: !!dryRun, ifRev, timeoutMs, signal: req.signal };
  return def.batch ? runBatch(args, opts) : def.calls ? runCalls(args, opts) : runOne(def, args, opts);
}

// ---------------------------------------------------------------------------------------------
// One command

/** Steps 4–12 for one command. `opts`: {source, dryRun, ifRev, timeoutMs, signal, approved (asked already: a batch),
 * group (a batch's history group)}. */
async function runOne(def, rawArgs, opts) {
  const ctrl = new AbortController();
  // A draftId naming another draft than the open one: the command works on that draft's background session (§7i Background drafts).
  // A batch's step gets the batch's session (runBatch).
  let sess = opts.group ? opts.sess ?? null : null;
  if (!opts.group && routes(def) && typeof rawArgs.draftId === 'string' && rawArgs.draftId !== state.draft?.id) {
    if (!draftById(rawArgs.draftId)) return error('not_found', `No draft has the id ${rawArgs.draftId}`);
    try {
      sess = await sessionFor(rawArgs.draftId);
    } catch (e) {
      return errorOf(e);
    }
    if (!sess && rawArgs.draftId !== state.draft?.id) return error('busy', 'The user is opening that draft; retry in a moment');
  }
  const ctx = makeCtx(opts.source, ctrl.signal, sess);
  // 4. Revision: every PATH argument read at ifRev, mapped onto the current doc (a session's: onto its doc, from its revs).
  let args = rawArgs;
  if (opts.ifRev !== undefined) {
    args = mapArgPaths(def.args, rawArgs, opts.ifRev, sess);
    if (args === STALE) return error('stale', `A block addressed at rev ${opts.ifRev} was deleted or merged since; read again`, { rev: ctx.state.rev });
  }
  // 5. Preconditions, before any ask: the user never approves a call that cannot run.
  if (typeof args.draftId === 'string' && !draftById(args.draftId)) return error('not_found', `No draft has the id ${args.draftId}`);
  const failed = failedGates(def, args, opts.source, sess);
  if (failed.length) return error('precondition_failed', failed.map((f) => f.message).join('; '), { failed });
  // An agent's change to draft content waits as a suggestion (docs/plans/suggestions.md Which calls suggest): ctx.suggest is its
  // call, which the Suggestions extension records the change under. An agent's undo would change the draft without a record.
  if (suggests(def, args, opts)) {
    if (def.group === 'history') return error('refused', 'Undo by an agent would change the draft directly. Withdraw your own suggestions with suggestions_resolve.');
    ctx.suggest = callOf(opts.source, targetDraft(def, args, sess));
  }
  // 6. Policy.
  const denied = await policy(def, args, opts, ctx);
  if (denied) return denied;
  if (opts.signal?.aborted) return error('cancelled', 'The call was cancelled'); // e.g. Stop while it waited in the queue
  // 7. Busy: the user's gesture or text edit on the target wins (checked after the ask, which may have taken a while).
  if (!opts.dryRun && def.busy?.(ctx, args)) return error('busy', 'The user is editing that board; retry in a moment');
  // 11. Timeout / cancel around the work.
  const ms = Math.min(opts.timeoutMs ?? (def.slow ? TIMEOUT.slow : TIMEOUT.normal), TIMEOUT.max);
  const timer = setTimeout(() => ctrl.abort('timeout'), ms);
  const onCancel = () => ctrl.abort('cancelled');
  opts.signal?.addEventListener('abort', onCancel, { once: true });
  const stopped = new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error(ctrl.signal.reason === 'timeout'
    ? `${def.id} did not finish within ${ms} ms` : 'The call was cancelled'), { code: ctrl.signal.reason === 'timeout' ? 'timeout' : 'cancelled' }))));
  try {
    // The user opened the session's draft meanwhile: the main editor holds it now. A handover waits for the work below (a batch
    // step's: for the whole batch, runBatch).
    if (sess?.ending && !opts.group) fail('stale', 'The user opened that draft meanwhile; read it again', { rev: state.rev });
    const job = Promise.race([work(def, ctx, args, opts), stopped]);
    if (sess && !opts.group) sess.pending = job.catch(() => {});
    const out = await job;
    if (sess && out.undoSteps > 0 && opts.source === ASSISTANT) noteWrite(sess.draftId);
    if (!opts.dryRun) noteMeta(def, args, opts.source, out.result);
    const suggested = ctx.suggest?.ids.length ? { suggested: { group: ctx.suggest.g, changes: [...ctx.suggest.ids] } } : {};
    return { ok: true, ...out, ...suggested, ...(sess && { draftId: sess.draftId, rev: sess.rev }) };
  } catch (e) {
    return errorOf(e);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCancel);
  }
}

/** Steps 9–10: a builder's transaction dispatched (or applied for a dry run), else the imperative run. */
async function work(def, ctx, args, opts) {
  if (def.plan) {
    const { tr, result } = await def.plan(ctx, args);
    const ed = ctx.editor;
    if (!tr.before.eq(ed.state.doc)) fail('stale', 'The document changed while the command was prepared; read it again', { rev: ctx.state.rev });
    if (opts.dryRun) return { result, undoSteps: 0, diff: diffOf(ed.state.doc, ed.state.apply(tr).doc) };
    const view = ed.view;
    const before = undoDepth(view.state);
    // Joins the batch's undo step. A suggesting step names a fresh transaction there, not the batch's first: the Suggestions
    // extension takes appendedTransaction as the root of the dispatch and converts each root once.
    if (opts.group?.first) tr.setMeta('appendedTransaction', ctx.suggest ? view.state.tr : opts.group.first);
    else closeHistory(tr); // never merges into the user's typing
    withCall(ed, ctx.suggest, 'exact', () => view.dispatch(tr)); // no focus, no scrollIntoView; the selection is mapped, not moved
    if (opts.group && !opts.group.first) opts.group.first = tr;
    if (!opts.group) view.dispatch(closeHistory(view.state.tr)); // the user's next typing starts its own step
    return { result, undoSteps: undoDepth(view.state) - before };
  }
  if (opts.dryRun && def.risk !== 'read') return { result: { simulated: false, title: def.title, args }, undoSteps: 0 };
  const ed = ctx.editor;
  const before = def.undo === 'doc' && ed ? undoDepth(ed.state) : 0;
  // Presses (ui.invoke, tool.run) run in their call's 'ui' scope. computer.mjs scopes the main window's input itself, after its
  // card (ctx.inScope); board writes and canvas.close scope their own dispatch ('exact').
  const result = await (PRESSES.includes(def.id) ? inScope(ctx.suggest, 'ui', () => def.run(ctx, args)) : def.run(ctx, args));
  const undoSteps = def.undo === 'doc' && ed && ctx.editor === ed ? undoDepth(ed.state) - before : 0;
  return { result, undoSteps };
}

/** Runs `fn` under withCall(null, `call`, `kind`) (One converter). Board text typed in the scope is the call's: the user's open
 * text edit is committed as theirs before it, and the same edit, its text changed in the scope, is committed inside it. Both
 * stay open with the caret in place, so the next typing (the user's or the agent's) continues. An edit the call opened holds
 * no typing yet and stays open. Pending plan and library flowchart writes go out inside the scope. */
async function inScope(call, kind, fn) {
  if (!call) return fn();
  // A text just placed (addText) and not typed into would be removed by a commit; it is left as it is.
  let e = openEdit();
  if (e && e.b.newText?.id !== e.id) e = recommit(e);
  return withCall(null, call, kind, async () => {
    try {
      return await fn();
    } finally {
      const now = openEdit();
      if (e && now && now.b === e.b && now.id === e.id && now.slot === e.slot && now.html !== e.html) recommit(now);
      plans.flushPlans();
      flows.flushFlows();
    }
  });
}

/** The open board text edit {b, id, slot, text, html}, or null. At most one is open: on the board with the focus, or the
 * board its chrome serves (whiteboard.js activeBoard). */
function openEdit() {
  const b = activeBoard.get();
  const text = b?.editingId ? b.editText() : null;
  return text ? { b, id: b.editingId, slot: b.editingSlot, text, html: text.innerHTML } : null;
}

/** Commits open edit `e` and opens it again with its selection (character offsets) → the reopened edit, or null when the
 * commit removed the item. */
function recommit(e) {
  const sel = document.getSelection();
  const at = (node, off) => {
    const r = document.createRange();
    r.selectNodeContents(e.text);
    r.setEnd(node, off);
    return r.toString().length;
  };
  const range = sel.rangeCount && e.text.contains(sel.anchorNode) && e.text.contains(sel.focusNode)
    ? [at(sel.anchorNode, sel.anchorOffset), at(sel.focusNode, sel.focusOffset)] : null;
  e.b.finishEdit();
  e.b.startEdit(e.id, e.slot);
  const now = openEdit();
  if (now && range) {
    const point = (n) => {
      const w = document.createTreeWalker(now.text, NodeFilter.SHOW_TEXT);
      for (let t; (t = w.nextNode());) {
        if (n <= t.length) return [t, n];
        n -= t.length;
      }
      return [now.text, now.text.childNodes.length];
    };
    sel.setBaseAndExtent(...point(range[0]), ...point(range[1]));
  }
  return now;
}

/** Dry-run diff: {from, to} = the changed range in the new doc, before / after = outline entries of the top-level blocks
 * that range touches in the old / new doc. */
function diffOf(a, b) {
  const from = a.content.findDiffStart(b.content);
  if (from == null) return { from: null, to: null, before: [], after: [] };
  let { a: endA, b: endB } = a.content.findDiffEnd(b.content);
  const overlap = from - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  const touched = (doc, to) => { // the blocks overlapping [from, to); a pure insertion or deletion point: the block after it
    const out = [];
    doc.forEach((node, offset, i) => {
      if (offset < Math.max(to, from + 1) && from < offset + node.nodeSize) out.push(entryOf(node, [i]));
    });
    return out;
  };
  return { from, to: endB, before: touched(a, endA), after: touched(b, endB) };
}

/** A doc-path.mjs outline entry of ProseMirror node `node` at `path`. */
function entryOf(node, path) {
  const name = node.type.name;
  if (BOARD_TYPES.includes(name)) {
    const a = node.attrs;
    return { path, type: name, text: '', attrs: { kind: name, items: a.items?.length ?? 0, w: a.w ?? null, h: a.h ?? a.height ?? null } };
  }
  return { path, type: name, text: node.textBetween(0, node.content.size, ' ', '\n').slice(0, 120), ...(name === 'heading' && { attrs: { level: node.attrs.level } }) };
}

// ---------------------------------------------------------------------------------------------
// Revision mapping (rev.js holds the log)

const STALE = Symbol('stale');

/** `args` with every value its schema types as #/$defs/PATH mapped from rev `ifRev` onto the current doc (background session
 * `sess`: its doc and revs), or STALE. */
function mapArgPaths(schema, args, ifRev, sess = null) {
  try {
    return mapPaths(schema, args, (path) => {
      const out = sess ? sess.revs.map(path, ifRev, sess.editor.state.doc) : state.editor ? mapPath(path, ifRev, state.editor.state.doc) : 'stale';
      if (out === 'stale') throw STALE;
      return out;
    });
  } catch (e) {
    if (e === STALE) return STALE;
    throw e;
  }
}

function mapPaths(schema, value, fn) {
  if (schema?.$ref === '#/$defs/PATH') return fn(value);
  const s = deref(schema, $defs);
  if (!s) return value;
  const branches = s.oneOf ?? s.anyOf;
  if (branches) {
    const b = branches.find((x) => !validate(x, value, $defs).length);
    if (b) value = mapPaths(b, value, fn);
  }
  if (Array.isArray(value) && s.items) return value.map((v) => mapPaths(s.items, v, fn));
  if (isObject(value) && s.properties) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, s.properties[k] ? mapPaths(s.properties[k], v, fn) : v]));
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Preconditions (gates.mjs, shared with the UI)

const draftById = (id) => (state.draft?.id === id ? state.draft : state.drafts.find((d) => d.id === id) ?? null);

// Commands that work on another draft by draftId, in its background session (§8 Background drafts): those with a draftId argument
// that need doc.open or view.editor. A session stands in for both gates; board.active and Canvas Mode stay the open draft's.
const routes = (def) => !!def.args.properties?.draftId && def.needs.some((n) => ['doc.open', 'view.editor'].includes(needOf(n).gate));

/** The PM node at `path` of the open doc (of editor `ed`) as a gate subject {type, attrs}, or null. */
function nodeSubject(path, ed = state.editor) {
  const doc = ed?.state.doc;
  const pos = doc && posOfPath(doc, path);
  if (pos == null) return null;
  const node = doc.nodeAt(pos);
  return { type: node.type.name, attrs: node.attrs };
}

const liveBoard = () => canvasEditor.get()?.board ?? activeBoard.get();

/** The subject a gate reads (§3.7): from the arguments when the command addresses its target, else the live UI. Background
 * session `sess`: its editor in place of the open draft's, shown (doc.open and view.editor hold). */
function subjectOf(kind, args = {}, sess = null) {
  const ed = sess?.editor ?? state.editor;
  switch (kind) {
    case 'ui': return sess ? { editor: sess.editor, view: { type: 'editor' } } : state;
    case 'draft': {
      const d = args.draftId ? draftById(args.draftId) : state.draft;
      // Waiting suggestions: the live count of the open draft or the session, else the summary's (draft.settled).
      const live = d && (d.id === state.draft?.id ? state.editor : sess?.draftId === d.id ? sess.editor : null);
      const suggestions = live ? pendingCount(live.state.doc) : d?.suggestions ?? 0;
      return d && { id: d.id, threadUrl: d.threadUrl ?? null, pushedAt: d.pushedAt ?? null, format: d.format ?? null, threads: state.settings?.threads, suggestions };
    }
    case 'doc': return ed && { inTable: ed.isActive('table') };
    case 'history': return ed && { canUndo: undoDepth(ed.state) > 0, canRedo: redoDepth(ed.state) > 0 };
    case 'node': {
      if (args.path) return nodeSubject(args.path, ed);
      const sel = ed?.state.selection;
      return sel instanceof NodeSelection ? { type: sel.node.type.name, attrs: sel.node.attrs } : null;
    }
    case 'board': return liveBoard()?.getSnapshot() ?? null;
    case 'window': return { visible: document.visibilityState === 'visible' };
    case 'settings': return state.settings;
    case 'flow': return state.view.type === 'flows' && state.view.flowId ? flows.getFlow(state.view.flowId) : null; // the library editor's record
    default: return null;
  }
}

const needOf = (n) => (typeof n === 'string' ? { gate: n } : n);

/** [{gate, message, fix}] of every applicable gate of `def.needs` (plus window.visible for a headless: false command from an
 * agent, with `def.hidden` as its fix when set) that does not hold; `sess`: the background session the command works in.
 * An off integration's command, or an argument it owns (integrationArgs), fails its integration.<id> gate alone: the other
 * gates would only name parts of the integration (an outside client's tool list may be from before it was turned off). */
function failedGates(def, args, source, sess = null) {
  const off = def.integration && !enabled(state.settings, def.integration) ? def.integration : offArg(def, args, state.settings);
  if (off) {
    const g = GATES[`integration.${off}`];
    return [{ gate: `integration.${off}`, message: g.message, fix: g.fix }];
  }
  const failed = [];
  for (const n of !def.headless && isAgent(source) ? [...def.needs, { gate: 'window.visible', fix: def.hidden }] : def.needs) {
    const { gate, if: when, with: param, fix } = needOf(n);
    if (when && !when(args)) continue;
    const g = GATES[gate];
    if (!can(gate, subjectOf(g.subject, args, sess), args, param)) failed.push({ gate, message: g.message, fix: fix ?? g.fix });
  }
  // def.check (define.mjs): gates that depend on the arguments and the addressed draft, here so they also come before any ask.
  const draft = sess?.draft ?? (args.draftId ? draftById(args.draftId) : state.draft);
  for (const gate of def.check?.(args, draft, state.settings) ?? []) failed.push({ gate, message: GATES[gate].message, fix: GATES[gate].fix });
  return failed;
}

// ---------------------------------------------------------------------------------------------
// Policy and the agent ask (AgentAsk.jsx shows state.agentAsk)

const POLICIES = {
  user: { write: true, destructive: 'allow', approval: 'allow' }, // ui / palette: the UI's own confirm, where it has one
  smoke: { write: true, destructive: 'allow', approval: 'deny' },
  agent: { write: true, destructive: 'ask', approval: 'ask' }, // asked on every call, never remembered
};
// The in-app assistant: its permission mode (settings.assistant.permission, tool-sets.mjs PERMISSIONS), read at every call.
const modeOf = () => assistantMode(state.settings?.assistant);
const policyOf = (source) => (source === ASSISTANT ? PERMISSIONS[modeOf().permission]
  : isAgent(source) ? POLICIES.agent : source === 'smoke' ? POLICIES.smoke : POLICIES.user);
// Their run asks with the pressed control's or the palette entry's own risk (ui-control.js, tool.mjs): the executor only denies.
// suggestions.resolve asks in its run unless the agent withdraws its own suggestions (suggestions.mjs).
const PRESSES = ['ui.invoke', 'tool.run'];
const SELF_ASK = [...PRESSES, 'suggestions.resolve'];

/** The phrase after "wants to" and the card's description for `def` with `args`. */
function askText(def, ctx, args) {
  const t = def.ask?.(ctx, args) ?? def.title.charAt(0).toLowerCase() + def.title.slice(1);
  return typeof t === 'string' ? { title: t, description: '' } : t;
}

/** Step 6: null when the call may run, else the `denied` answer. `risk` and the ask text may come from a batch. */
async function policy(def, args, opts, ctx, risk = def.risk, text = null) {
  const why = opts.source === ASSISTANT && refusal({ id: def.id, risk }, modeOf()); // Read only, or on-screen controls off
  if (why) return error('denied', why, { reason: 'policy' });
  let rule = policyOf(opts.source)[risk];
  if (rule === 'deny') return error('denied', `${def.id} is not allowed for ${opts.source}`, { reason: 'policy' });
  // A suggestion is the request (Policy precedence 2); a write that reaches a flowchart other drafts show asks in every mode (3).
  if (ctx.suggest && (risk === 'write' || risk === 'destructive') && rule === 'ask') rule = true;
  const linked = text ? (text.force ? text : null) : !opts.dryRun && !opts.approved ? await linkedAsk(def, args, ctx) : null;
  if (linked) text = linked;
  else if (rule !== 'ask' || opts.dryRun || opts.approved || SELF_ASK.includes(def.id)) return null;
  const { title, description } = text ?? askText(def, ctx, args);
  const answer = await askRaw(opts.source, title, description, risk, text?.steps, opts.signal);
  if (answer === 'allow') return null;
  if (answer === 'cancelled') return error('cancelled', 'The call was cancelled');
  return answer === 'timeout'
    ? error('denied', 'Nobody answered the request within 60 s', { reason: 'timeout' })
    : error('denied', 'The user denied the request', { reason: 'user' });
}

// ---------------------------------------------------------------------------------------------
// Suggestions (docs/plans/suggestions.md Which calls suggest, Grouping, Policy precedence)

const autoApprove = () => state.settings?.assistant?.autoApproveEdits === true; // undefined (an older profile): suggestions on
const INPUT_ACTIONS = ['click', 'double_click', 'move', 'drag', 'type', 'key', 'scroll'];
const NEVER_SUGGEST = ['drafts.create', 'drafts.duplicate']; // a new draft arrives as a normal draft (the user, 2026-10-26)

/** Whether `def` with `args` from opts.source changes draft content as a suggestion: an agent's call, not a dry run, while
 * auto-approve is off. history.undo and redo count, so the executor refuses them. */
function suggests(def, args, opts) {
  if (!isAgent(opts.source) || opts.dryRun || autoApprove()) return false;
  if (def.group === 'suggestions' || NEVER_SUGGEST.includes(def.id)) return false;
  if (def.id === 'computer.act') return INPUT_ACTIONS.includes(args.action);
  return def.undo === 'doc' || def.id === 'canvas.close';
}

/** The draft a call works on: its draftId, the background window's for computer.act there, else the session's or the open one. */
const targetDraft = (def, args, sess) => args.draftId
  ?? (def.id === 'computer.act' && args.target === 'background' ? state.worker?.draftId : sess?.draftId ?? state.draft?.id) ?? null;

const groupsOf = new Map(); // `${source} ${epoch} ${draftId}` → {g, last}
const epochs = new Map(); // source → {n, note, turn}: the group suggestions.group started

/** The group of a call of `source` on draft `draftId` → {g, note}: the assistant's chat turn (the user's message as the note);
 * else the source's suggestions.group note with one group per draft until IDLE (5 minutes) passes without a call. */
function groupFor(source, draftId) {
  const turn = source === ASSISTANT ? state.assistant?.turn : null;
  const e = epochs.get(source);
  if (turn?.id && e?.turn !== turn.id) return { g: turn.id, note: String(turn.request ?? '').slice(0, 140) || null };
  const key = `${source} ${e?.n ?? 0} ${draftId}`;
  const now = Date.now();
  let k = groupsOf.get(key);
  if (!k || now - k.last > SESSION_IDLE.ms) {
    for (const [x, v] of groupsOf) if (now - v.last > SESSION_IDLE.ms) groupsOf.delete(x);
    groupsOf.set(key, (k = { g: suggestId('g'), last: now }));
  }
  k.last = now;
  return { g: k.g, note: e?.note ?? null };
}

/** suggestions.group: a new group for `source` with `note` → its group on the open draft. The assistant's lasts its turn. */
function startGroup(source, note) {
  const e = epochs.get(source);
  epochs.set(source, { n: (e?.n ?? 0) + 1, note: note.slice(0, 140), turn: source === ASSISTANT ? state.assistant?.turn?.id ?? null : null });
  return groupFor(source, state.draft?.id ?? null).g;
}

/** A suggesting call of `source` on draft `draftId`: {g, by, at, note, ids} (ids: the changes the converter records). */
const callOf = (source, draftId) => ({ ...groupFor(source, draftId), by: source, at: Date.now(), ids: [] });

// Draft metadata an agent changes applies at once and shows as a plain row on its group's card (Grouping).
const META_ROWS = {
  'drafts.rename': (a, r) => `Rename to “${r?.title ?? a.title}”`,
  'drafts.setTag': (a) => (a.tagId ? `Tag as “${tagList(state.settings).find((t) => t.id === a.tagId)?.name ?? a.tagId}”` : 'Clear the tag'),
  'drafts.move': (a) => (a.folderId ? `Move to “${(state.settings.folders ?? []).find((f) => f.id === a.folderId)?.name ?? a.folderId}”` : 'Move to the top level'),
  // The draft's sources (references.*, docs/plans/references.md)
  'references.add': (a, r) => `Add the source ${r?.source?.citeNarrative ?? ''}`,
  'references.update': (a, r) => `Change the source ${r?.source?.citeNarrative ?? ''}`,
  'references.remove': (a, r) => `Remove the source ${r?.source?.citeNarrative ?? ''}`,
};

function noteMeta(def, args, source, result) {
  const row = META_ROWS[def.id];
  if (!row || !isAgent(source) || autoApprove()) return;
  noteGroup(groupFor(source, args.draftId).g, row(args, result));
  setState({ suggestions: { ...getState().suggestions } }); // the cards (Review.jsx) render again with the row
}

/** The drafts that show library flowchart `flowId`: the open draft and the background sessions as they are now, the others by
 * their summary's `flows`. */
async function linkedDrafts(flowId) {
  const shows = (doc) => {
    let hit = false;
    doc.descendants((n) => {
      if (n.type.name === 'canvas' && n.attrs.flow?.id === flowId) hit = true;
      return !hit;
    });
    return hit;
  };
  const live = new Map();
  if (state.editor && state.draft?.id) live.set(state.draft.id, shows(state.editor.state.doc));
  for (const id of sessionIds()) {
    const s = live.has(id) ? null : await sessionFor(id).catch(() => null);
    if (s) live.set(id, shows(s.editor.state.doc));
  }
  const out = [...live].filter(([, hit]) => hit).map(([id]) => id);
  for (const d of state.drafts) if (!live.has(d.id) && d.flows?.includes(flowId)) out.push(d.id);
  return out;
}

// The flowchart library writes that reach every draft showing that flowchart (Policy precedence 3).
const FLOW_WRITE = /^flow\.(items\.|layout$|library\.(rename|delete)$)/;

/** The approval card's text {title, description, force} when an agent's write reaches a library flowchart that drafts show
 * without a record there, else null: a flow.* write to a flowchart any draft shows, and a suggesting board write on a linked
 * canvas whose flowchart another draft shows too. Only while auto-approve is off. */
async function linkedAsk(def, args, ctx, suggesting = !!ctx.suggest) {
  if (!isAgent(ctx.source) || autoApprove() || def.risk === 'read') return null;
  let flowId;
  let drafts;
  if (FLOW_WRITE.test(def.id) && args.flowId) {
    flowId = args.flowId;
    drafts = await linkedDrafts(flowId);
    if (!drafts.length) return null;
  } else if (suggesting && def.group === 'board' && args.path && ctx.editor) {
    const n = nodeSubject(args.path, ctx.editor);
    flowId = n?.type === 'canvas' ? n.attrs.flow?.id : null;
    drafts = flowId ? await linkedDrafts(flowId) : [];
    if (!drafts.some((id) => id !== ctx.state.draft?.id)) return null;
  } else return null;
  const title = flows.getFlow(flowId)?.title ?? flows.flowList().find((f) => f.id === flowId)?.title ?? 'Flowchart';
  const n = drafts.length;
  return {
    title: `change the flowchart “${title}”, shown in ${n} draft${n === 1 ? '' : 's'}`,
    description: 'The drafts that show it change at once, without a suggestion to review.',
    force: true,
  };
}

let asks = 0;

/** Queues an agent request card: resolves 'allow' | 'deny' | 'timeout' (60 s) | 'cancelled' (`signal` aborted). */
function askRaw(source, title, description, risk, steps, signal) {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (answer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      setState({ agentAsk: state.agentAsk.filter((e) => e !== entry) });
      resolve(answer);
    };
    const onAbort = () => done('cancelled');
    const entry = {
      rid: ++asks, source, title, description, risk, steps, expires: Date.now() + ASK_MS,
      resolve: (allow) => done(allow ? 'allow' : 'deny'),
    };
    if (signal?.aborted) return resolve('cancelled');
    timer = setTimeout(() => done('timeout'), ASK_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    setState({ agentAsk: [...state.agentAsk, entry] });
  });
}

// ---------------------------------------------------------------------------------------------
// batch

/** A batch (SPEC §8 Batch): every step validated and its gates checked first; one ask for the steps the policy asks for
 * (destructive and approval; for the assistant in Ask first, writes too); then the steps in order, the doc steps in one undo
 * step. Every PATH refers to the doc at the batch's start (or `ifRev`). Atomic (the default): a failing step undoes the
 * batch's doc steps and stops it. */
async function runBatch(args, opts) {
  const steps = [];
  for (const [i, s] of args.steps.entries()) {
    const def = byId(s.id) ?? byId(commandIdOf(s.id)); // a command id or a tool name
    if (!def) return error('unknown_command', `steps[${i}]: no command has the id ${JSON.stringify(s.id)}`, { step: i });
    if (def.batch || def.calls) return error('invalid_args', `steps[${i}]: a batch cannot hold ${def.id}`, { path: `/steps/${i}/id`, message: 'is a batch', expected: {} });
    if (def.id === 'ui.invoke') return error('invalid_args', `steps[${i}]: ui.invoke runs alone, not in a batch`, { path: `/steps/${i}/id`, message: 'runs alone', expected: {} });
    const stepArgs = wrapStrings(def.args, s.args ?? {});
    const errs = validate(def.args, stepArgs, $defs);
    if (errs.length) return error('invalid_args', argsMessage(def, errs[0], $defs, `steps[${i}].args`), { ...errs[0], path: `/steps/${i}/args${errs[0].path}` });
    steps.push({ def, args: withDefaults(def.args, stepArgs, $defs) });
  }
  // One draft per batch: the steps that work on a draft name the same draftId, or none (the open draft).
  const drafts = new Set(steps.filter((s) => routes(s.def)).map((s) => (s.args.draftId && s.args.draftId !== state.draft?.id ? s.args.draftId : null)));
  if (drafts.size > 1) return error('invalid_args', 'A batch works on one draft: give every step the same draftId, or none', { path: '/steps', message: 'names more than one draft', expected: {} });
  const target = [...drafts][0] ?? null;
  let sess = null;
  if (target) {
    if (!draftById(target)) return error('not_found', `No draft has the id ${target}`);
    // Opening, pushing or deleting that draft ends its session, which waits for the batch: such a step runs after the batch.
    const k = steps.findIndex((s) => !routes(s.def) && s.args.draftId === target);
    if (k >= 0) return error('invalid_args', `steps[${k}]: ${steps[k].def.id} on the draft the batch works on runs after the batch`, { path: `/steps/${k}/id`, message: 'ends the batch\'s session', expected: {} });
    try {
      sess = await sessionFor(target);
    } catch (e) {
      return errorOf(e);
    }
    if (!sess && target !== state.draft?.id) return error('busy', 'The user is opening that draft; retry in a moment');
  }
  const ifRev = opts.ifRev ?? sess?.rev ?? state.rev;
  const ctx = makeCtx(opts.source, new AbortController().signal, sess);
  // Preconditions of every step on the state now, before the ask.
  for (const [i, { def, args: raw }] of steps.entries()) {
    const a = mapArgPaths(def.args, raw, ifRev, routes(def) ? sess : null);
    if (a === STALE) return error('stale', `steps[${i}]: a block addressed at rev ${ifRev} was deleted or merged since`, { rev: ctx.state.rev, step: i });
    if (typeof a.draftId === 'string' && !draftById(a.draftId)) return error('not_found', `steps[${i}]: no draft has the id ${a.draftId}`, { step: i });
    const failed = failedGates(def, a, opts.source, routes(def) ? sess : null);
    if (failed.length) return error('precondition_failed', `steps[${i}] (${def.id}): ${failed.map((f) => f.message).join('; ')}`, { failed, step: i });
    steps[i].text = askText(def, ctx, a);
    // A suggesting step leaves the card and its risk (the suggestion is the request); one reaching a flowchart other drafts show
    // joins the card in every mode.
    steps[i].suggest = suggests(def, a, opts);
    steps[i].linked = opts.dryRun ? null : await linkedAsk(def, a, ctx, steps[i].suggest);
    if (steps[i].linked) steps[i].text = steps[i].linked;
  }
  const RANK = ['read', 'write', 'destructive', 'approval'];
  // tool.run asks in its own run: never on the batch's card too
  const own = steps.filter((s) => !SELF_ASK.includes(s.def.id) && !(s.suggest && ['write', 'destructive'].includes(s.def.risk)));
  const risk = own.reduce((r, s) => (RANK.indexOf(s.def.risk) > RANK.indexOf(r) ? s.def.risk : r), 'read');
  const rules = policyOf(opts.source);
  const asked = steps.filter((s) => s.linked || (own.includes(s) && rules[s.def.risk] === 'ask'));
  const text = {
    title: asked.length === 1 ? asked[0].text.title : `make ${asked.length} changes in one step`,
    description: asked.length === 1 ? asked[0].text.description : '',
    steps: asked.map((s) => s.text.title),
    force: steps.some((s) => s.linked),
  };
  const denied = await policy(byId('batch'), args, opts, ctx, risk, text);
  if (denied) return denied;
  if (sess?.ending) return error('stale', 'The user opened that draft meanwhile; read it again', { rev: state.rev });
  // ponytail: a dry-run batch dry-runs each step on the current doc, not composed; compose when an agent needs it.
  const ed = ctx.editor;
  const live = () => ctx.editor === ed; // the editor the batch began on (not remounted; a session's lives until the batch ends)
  const before = ed ? undoDepth(ed.state) : 0;
  const group = { first: null };
  const results = [];
  const run = async () => {
    for (const [i, { def, args: a }] of steps.entries()) {
      const t0 = performance.now();
      const res = await runOne(def, a, { ...opts, ifRev, approved: true, group, sess: routes(def) ? sess : null, timeoutMs: undefined });
      audit({ id: def.id, args: a, source: opts.source, dryRun: opts.dryRun }, res, Math.round(performance.now() - t0));
      results.push(res);
      if (!res.ok && args.atomic) {
        if (group.first && live() && undoDepth(ed.state) > before) undoNoScroll(ed.state, ed.view.dispatch);
        return error(res.error.code, `steps[${i}] (${def.id}): ${res.error.message}${group.first ? ' (the batch\'s document changes were undone)' : ''}`,
          { ...(res.error.data !== undefined && { cause: res.error.data }), step: i });
      }
    }
    if (group.first && live()) ed.view.dispatch(closeHistory(ed.state.tr));
    const suggested = results.filter((r) => r.suggested).map((r) => r.suggested);
    return {
      ok: true,
      result: { results: results.map((r) => (r.ok ? r.result : { error: r.error })) },
      undoSteps: ed && live() ? undoDepth(ed.state) - before : 0,
      ...(suggested.length && { suggested: { group: suggested[0].group, changes: suggested.flatMap((x) => x.changes) } }),
      ...(sess && { draftId: sess.draftId, rev: sess.rev }),
    };
  };
  const job = run();
  if (sess) sess.pending = job.catch(() => {}); // a handover waits for the whole batch
  return job;
}

// ---------------------------------------------------------------------------------------------
// calls

/** Several tool calls in one (SPEC §8 Calls): the steps run in order in the same queue turn, each as if called alone (its args,
 * gates, ask, undo step and draft session); a failing step does not stop the rest. A step on the open draft reads its PATHs at
 * `ifRev`; a step on another draft at that draft's current rev (ifRev is the open draft's). */
async function runCalls(args, opts) {
  const results = [];
  for (const [i, s] of args.steps.entries()) {
    const def = byId(s.id) ?? byId(commandIdOf(s.id));
    const other = typeof s.args?.draftId === 'string' && s.args.draftId !== state.draft?.id;
    const req = { ...opts, id: def?.id ?? s.id, args: s.args ?? {}, ...(other && { ifRev: undefined }) };
    const t0 = performance.now();
    let res = def?.calls ? error('invalid_args', `steps[${i}]: calls cannot hold calls`) : await executeInner(req).catch(errorOf);
    if (res.ok) res = { ...res, draftId: res.draftId ?? state.draft?.id ?? null, rev: res.rev ?? state.rev };
    audit(req, res, Math.round(performance.now() - t0));
    results.push(res);
    if (res.error?.code === 'cancelled') break;
  }
  return { ok: true, result: { results }, undoSteps: 0 };
}

// ---------------------------------------------------------------------------------------------
// ctx and the renderer helpers commands reach through it (ctx.lib)

/** A command's ctx; `sess`: the background session it works in (§7i Background drafts), whose draft, rev and editor stand in for
 * the open draft's (ctx.state reads the rest from the store), with no live board. */
function makeCtx(source, signal, sess = null) {
  return {
    state: sess ? Object.create(state, { draft: { get: () => sess.draft }, rev: { get: () => sess.rev }, editor: { get: () => sess.editor } }) : state,
    get editor() {
      return sess ? sess.editor : state.editor; // the editor now: a command that awaits may outlive a remount
    },
    session: sess,
    api,
    actions,
    references, // the open draft's sources (app/references.js), for references.*
    integrations: integrationsCtx(), // each integration's actions (integrations/ui.js), for its commands
    board: sess ? null : liveBoard(),
    plans,
    flows,
    source,
    policy: policyOf(source),
    signal,
    ask: (title, description = '', { risk = 'destructive', steps } = {}) => askRaw(source, title, description, risk, steps, signal).then((a) => a === 'allow'),
    suggest: null, // the call a suggesting command's change is recorded under (runOne)
    inScope(kind, fn) { // `fn` in this call's window-level scope (computer.act on the main window: 'computer')
      return inScope(this.suggest, kind, fn);
    },
    autoApprove,
    linkedDrafts,
    startGroup: (note) => startGroup(source, note),
    emit,
    lib: sess ? sessionLib(sess) : lib,
  };
}

// The helpers that read the editor, on a session's (its schema: nodes of another editor's schema do not insert); a hidden board is
// never busy.
const sessionLib = ({ editor: ed, draft }) => ({
  ...lib,
  toNodes: (c, e = ed, d = draft) => toNodes(c, e, d),
  toMarkdown: (n, p) => toMarkdown(n, p, draft, ed),
  toHtml: (p, i) => toHtml(p, i, ed),
  selection: () => selection(ed),
  boardBusy: () => false,
});

// The Markdown manager of `draft`'s format (editors.js kitOf: one per format, on JSON, so it needs no particular editor).
const markdown = (draft = state.draft) => kitOf(formatOf(draft, state.settings).id).markdown;

const IMG_MD = /!\[[^\]]*\]\([^)]*\)/g;
const DATA_URL = /data:(image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/** A copy of JSON `v` with every data URL replaced by {$img: {len, hash}}. */
function stripImages(v) {
  if (typeof v === 'string') return v.startsWith('data:') ? { $img: { len: v.length, hash: cyrb53(v) } } : v;
  if (Array.isArray(v)) return v.map(stripImages);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripImages(x)]));
  return v;
}

const newId = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');

/** A canvas node holding the picture `dataUrl` at its natural size (≤ 8000 px a side), displayed `w` wide (default: the
 * natural width), never wider than `width`, the target's text width (the addImages pattern, whiteboard.js). In a Document
 * (`inline`) a paragraph holding the picture as an image node instead (docs/plans/document.md Pictures). */
async function imageNode({ dataUrl, w: want, alt }, i, width, inline) {
  const img = new Image();
  img.src = dataUrl;
  try {
    await img.decode();
  } catch {
    fail('invalid_args', `content.images[${i}] is not a picture the app can read`, { path: `/content/images/${i}/dataUrl`, message: 'cannot be decoded', expected: {} });
  }
  if (inline) {
    const w = Math.max(1, Math.round(Math.min(want ?? img.naturalWidth, width))); // `w` may enlarge it, as a canvas's dw does
    const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
    return { type: 'paragraph', content: [{ type: 'image', attrs: { src: dataUrl, alt: alt?.trim() || null, width: w, height: h } }] };
  }
  const k = Math.min(1, 8000 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const id = newId();
  return {
    type: 'canvas',
    attrs: { w, h, dw: Math.min(want ?? w, width), frame: { x: 0, y: 0, w, h, item: id }, bg: 'post', items: [{ id, type: 'image', src: dataUrl, x: 0, y: 0, w, h }] },
  };
}

/** SPEC §8 Content: {json | html | markdown | images} → {nodes: ProseMirror block nodes of editor `ed`, dropped: [construct]}.
 * html and markdown parse with the kit of `draft`'s format; a Document's html first goes through the paste pre-pass
 * (document/paste.js: lists to list paragraphs, quotes to the Quote style). `ed` null: nodes of that kit's schema, for a draft
 * not made yet (drafts.create passes {format}), so invalid content creates nothing. */
async function toNodes(content, ed = state.editor, draft = state.draft) {
  const format = formatOf(draft, state.settings).id;
  const kit = kitOf(format);
  const schema = ed?.schema ?? kit.schema;
  const dropped = new Set();
  const [key] = Object.keys(content);
  let json;
  if (key === 'json') {
    const j = migrateBoards(content.json, pageOf(draft, state.settings).width); // an old whiteboard becomes a canvas (§6b Converted whiteboards)
    json = Array.isArray(j) ? j : j?.type === 'doc' ? j.content ?? [] : [j];
  } else if (key === 'html') {
    // No image node, or a Document's, which parses only data URLs: other pictures go in as `images`.
    if ((format === 'document' ? /<img\b(?![^>]*\ssrc=["']?data:)/i : /<img\b/i).test(content.html)) dropped.add('img');
    const html = format === 'document' ? normaliseHtml(content.html, ed?.state.doc.attrs.numbering ?? DEFAULT_NUMBERING) : content.html;
    json = DOMParser.fromSchema(kit.schema).parse(elementFromString(html)).toJSON().content ?? [];
  } else if (key === 'markdown') {
    const md = content.markdown.replace(IMG_MD, () => {
      dropped.add('img');
      return '';
    });
    json = kit.markdown.parse(md).content ?? [];
  } else {
    // `ed` null (a draft not made yet): its format's page width, not the open draft's editor, which may be another format.
    const width = ed ? contentWidth(ed.view) : pageOf(draft, state.settings).width;
    json = await Promise.all(content.images.map((img, i) => imageNode(img, i, width, format === 'document')));
  }
  json = stripRecords(json); // no agent writes or forges a suggestion record
  let nodes;
  try {
    nodes = json.map((j) => {
      const node = schema.nodeFromJSON(j);
      node.check();
      if (!node.isBlock) throw new Error(`${node.type.name} is not a block`);
      return node;
    });
  } catch (e) {
    fail('invalid_args', `content.${key}: ${e.message}`, { path: `/content/${key}`, message: String(e.message), expected: {} });
  }
  if (!nodes.length) fail('invalid_args', `content.${key} holds no block`, { path: `/content/${key}`, message: 'holds no block', expected: {} });
  return { nodes, dropped: [...dropped] };
}

/** Markdown of TipTap JSON `node` of `draft` (the doc, or the block at `path`) open in editor `ed`: a board as
 * `![canvas: 3 items](block:[4])`. A Document's consecutive list paragraphs stay one Markdown list (one line apart). */
function toMarkdown(node, path = null, draft = state.draft, ed = state.editor) {
  const board = (n, p) => (n.type === 'media' ? `![media: ${n.attrs?.name}](block:[${p}])` : `![${n.type}: ${n.attrs?.items?.length ?? 0} items](block:[${p}])`);
  const stub = (t) => BOARD_TYPES.includes(t) || t === 'media';
  // The doc attrs tell a list paragraph's kind (bullet or number) to the Document's Markdown (document/lists.js docMarkdown).
  const attrs = (path ? ed?.state.doc.attrs : node.attrs) ?? {};
  const md = (content) => markdown(draft).serialize({ type: 'doc', attrs, content });
  if (path) return stub(node.type) ? board(node, path) : md([node]);
  // Consecutive list paragraphs go together, so each item indents under its parent item's text.
  const runs = [];
  (node.content ?? []).forEach((n, i) => {
    if (n.attrs?.numbering && runs.at(-1)?.list) runs.at(-1).list.push(n);
    else runs.push(stub(n.type) ? { s: board(n, [i]) } : n.attrs?.numbering ? { list: [n] } : { n });
  });
  return runs.map((r) => r.s ?? md(r.list ?? [r.n])).filter((s) => s.trim()).join('\n\n');
}

/** HTML of the open doc (of editor `ed`) or of its block at `path`; pictures shortened unless `images`. */
function toHtml(path, images, ed = state.editor) {
  let html;
  if (!path) html = ed.getHTML();
  else {
    const pos = posOfPath(ed.state.doc, path);
    if (pos === null) fail('not_found', `No block at [${path}]`, { path });
    html = getHTMLFromFragment(Fragment.from(ed.state.doc.nodeAt(pos)), ed.schema);
  }
  return images ? html : html.replace(DATA_URL, (s, kind) => `data:${kind};len=${s.length};hash=${cyrb53(s)}`);
}

const CONTEXT = 40;

/** doc.selection: {kind: 'text', path, from, to, text, context, toPath?} (block-local offsets; `toPath` when the selection
 * ends in another block, `to` then counts in that block), {kind: 'node', path, type}, or {kind: 'none'}; of editor `ed`. */
export function selection(ed = state.editor) {
  const { doc, selection: sel } = ed.state;
  if (sel instanceof NodeSelection) return { kind: 'node', path: pathOfPos(doc, sel.from), type: sel.node.type.name };
  const { $from, $to } = sel;
  if (!$from.parent.inlineContent) return { kind: 'none' };
  const block = $from.parent;
  const blockText = block.textBetween(0, block.content.size, '\n', '\n');
  const same = $from.sameParent($to);
  const from = $from.parentOffset;
  const to = same ? $to.parentOffset : blockText.length;
  return {
    kind: 'text',
    path: pathOfPos(doc, $from.pos),
    from,
    to: same ? to : $to.parentOffset,
    text: doc.textBetween(sel.from, sel.to, '\n', '\n').slice(0, 4000),
    context: blockText.slice(Math.max(0, from - CONTEXT), to + CONTEXT),
    ...(!same && { toPath: pathOfPos(doc, $to.pos) }),
  };
}

/** Whether the user is mid-gesture or editing text on the canvas at `path` while it is open in Canvas Mode (busy, §3.3 step 7).
 * An idle open canvas takes agent writes: CanvasView.update syncs the session. */
function boardBusy(path) {
  const ed = state.editor;
  const pos = ed && posOfPath(ed.state.doc, path);
  if (pos == null) return false;
  const s = canvasEditor.get();
  return s?.target.owner?.getPos?.() === pos && !!(s.board.gesture || s.board.editingId);
}

/** Whether any live board is mid-gesture or editing text (undo / redo would fight it). */
function anyBoardBusy() {
  const b = liveBoard();
  return !!(b && (b.gesture || b.editingId));
}

function busyNow() {
  const board = liveBoard();
  const busy = [];
  if (state.dialog) busy.push('dialog');
  if (state.confirm) busy.push('confirm');
  if (board?.gesture) busy.push('gesture');
  if (board?.editingId) busy.push('editing');
  if (state.saving) busy.push('saving');
  return busy;
}

const modeNow = () => (canvasEditor.get() ? 'canvas-edit' : activeBoard.get() ? 'board' : 'text');

/** ui.state (§7). */
function uiState() {
  return {
    view: state.view.type,
    mode: modeNow(),
    tool: liveBoard()?.mode ?? null,
    selection: selectionBrief(),
    busy: busyNow(),
    visible: document.visibilityState === 'visible',
    zoom: state.zoomPct,
    gates: gatesNow(),
  };
}

function selectionBrief() {
  const board = liveBoard();
  if (board?.sel?.size) return { kind: 'board', ids: [...board.sel] };
  const ed = state.editor;
  if (!ed) return { kind: 'none' };
  const sel = ed.state.selection;
  return { kind: sel instanceof NodeSelection ? 'node' : 'text', path: pathOfPos(ed.state.doc, sel.from) };
}

/** Every gate on the current subjects (a gate that needs a parameter, board.itemIs, reads false), less those of off
 * integrations and the wake.<id> gates (integrations/index.mjs integrationGates), which only the palette reads. */
function gatesNow() {
  return Object.fromEntries(Object.entries(GATES).filter(([, g]) => !g.wake && (!g.integration || enabled(state.settings, g.integration))).map(([id, g]) => {
    try {
      return [id, !!can(id, subjectOf(g.subject), {})];
    } catch {
      return [id, false];
    }
  }));
}

/** app.capabilities: every command listed with the settings (integrations/index.mjs listed: none of an off integration's
 * commands or arguments) with its gates; `available` keeps those whose UI-read gates hold now (a gate read from the arguments
 * is marked byArgs and checked when called). commands.index, commands.describe and the assistant's tools read it too. */
function capabilities(available) {
  const fromArgs = (def, subject) => (subject === 'draft' && !!def.args.properties?.draftId) || (subject === 'node' && !!def.args.properties?.path);
  return CATALOGUE.map((def) => listed(def, state.settings)).filter(Boolean).map((def) => ({
    id: def.id, title: def.title, group: def.group, risk: def.risk, undo: def.undo, headless: def.headless, slow: def.slow,
    args: def.args, result: def.result ?? {},
    needs: def.needs.map(needOf).map(({ gate, fix }) => ({ gate, message: GATES[gate].message, fix: fix ?? GATES[gate].fix, byArgs: fromArgs(def, GATES[gate].subject) })),
  })).filter((c) => !available || c.needs.every((n) => n.byArgs || can(n.gate, subjectOf(GATES[n.gate].subject))));
}

// ---------------------------------------------------------------------------------------------
// Audit ring (the audit.jsonl file arrives with the agent transport, automation Phase 3)

const AUDIT_MAX = 500;
const auditLog = [];

function audit(req, res, ms) {
  // ui.invoke: the control pressed is logged, the typed text only by its length.
  const ui = req.id === 'ui.invoke';
  const args = ui && typeof req.args?.text === 'string' ? { ...req.args, text: { $len: req.args.text.length } } : req.args ?? {};
  auditLog.push({
    t: Date.now(), source: req.source, id: req.id, argsDigest: argsDigest(args), ok: res.ok,
    ...(!res.ok && { code: res.error.code }), ms,
    ...(res.ok && { draftId: res.draftId, rev: res.rev }), ...(req.dryRun && { dryRun: true }),
    ...(ui && res.ok && { control: { name: res.result.name, role: res.result.role, area: res.result.area } }),
  });
  if (auditLog.length > AUDIT_MAX) auditLog.shift();
}

const auditTail = ({ n, source, draftId }) => auditLog.filter((l) => (!source || l.source === source) && (!draftId || l.draftId === draftId)).slice(-n);

const lib = {
  appVersion, undoDepth, redoDepth, undoNoScroll, redoNoScroll, toNodes, toMarkdown, toHtml, stripImages, selection, boardBusy,
  anyBoardBusy, uiState, capabilities, auditTail, uiSnapshot, uiInvoke: invokeControl, batch: () => fail('failed', 'batch runs in the executor'),
  // view.render: the window's content as main captures it (webContents.capturePage), PNG bytes.
  capturePage: () => api.window.capture(),
  // commands.describe: the model form of the tools `ids`, as the assistant's loop offers them (SPEC §8 Tool schemas), for the
  // chosen model's family.
  tools: (ids) => toolsFor(capabilities(false), { ids, $defs: MODEL_DEFS, form: 'model', family: familyOf(getState().settings?.assistant?.model, getState().settings?.assistant?.provider) }),
};

// ---------------------------------------------------------------------------------------------
// Events (coalesced per type: one call per 150 ms window with the latest payload; settings keys are merged)

const handlers = new Map();
const pending = new Map();

/** Calls `fn(payload)` on events of `type` (draft.changed, draft.opened, drafts.changed, settings.changed,
 * selection.changed, ui.changed, agent.connected, agent.disconnected, …). Returns the unsubscribe function. */
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}

/** Emits an event; `payload` may be a function, evaluated when the window closes. */
export function emit(type, payload = {}) {
  const prev = pending.get(type);
  if (prev) {
    if (type === 'settings.changed') prev.payload = { keys: [...new Set([...prev.payload.keys, ...payload.keys])] };
    else prev.payload = payload;
    return;
  }
  const entry = { payload };
  pending.set(type, entry);
  setTimeout(() => {
    pending.delete(type);
    const p = typeof entry.payload === 'function' ? entry.payload() : entry.payload;
    for (const fn of handlers.get(type) ?? []) {
      try {
        fn(p);
      } catch (e) {
        console.error(e);
      }
    }
  }, 150);
}

function watch() {
  let prev = { ...state };
  const onTransaction = ({ transaction }) => {
    if (transaction.docChanged) emit('draft.changed', () => ({ draftId: state.draft?.id ?? null, rev: state.rev }));
    if (transaction.docChanged || transaction.selectionSet) emit('selection.changed', selectionBrief);
  };
  let editor = state.editor; // mounted before installAgent: listen from now, not from the next store change
  editor?.on('transaction', onTransaction);
  const uiBrief = () => ({ view: state.view.type, mode: modeNow(), busy: busyNow() });
  subscribe(() => {
    if (state.settings !== prev.settings && prev.settings && state.settings) {
      const keys = [...new Set([...Object.keys(prev.settings), ...Object.keys(state.settings)])].filter((k) => prev.settings[k] !== state.settings[k]);
      if (keys.length) emit('settings.changed', { keys });
    }
    if (state.drafts !== prev.drafts) emit('drafts.changed', {});
    if (state.view !== prev.view || state.dialog !== prev.dialog || state.confirm !== prev.confirm) emit('ui.changed', uiBrief);
    if (state.editor !== editor) {
      editor?.off('transaction', onTransaction);
      editor = state.editor;
      editor?.on('transaction', onTransaction);
      if (editor) emit('draft.opened', () => ({ draftId: state.draft?.id ?? null }));
    }
    prev = { ...state };
  });
  activeBoard.subscribe(() => {
    emit('ui.changed', uiBrief);
    emit('selection.changed', selectionBrief);
  });
  canvasEditor.subscribe(() => emit('ui.changed', uiBrief));
}

// ---------------------------------------------------------------------------------------------
// The smoke script (§9 Phase 0 format) and window.__agent

/** The value at dotted `path` ('result.0.path') of `obj`. */
const pick = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);

/** `v` with every string "$prev.<path>" / "$steps[i].<path>" replaced by that field of an earlier response. */
function substitute(v, prev, all) {
  if (typeof v === 'string') {
    let m = /^\$prev\.(.+)$/.exec(v);
    if (m) return pick(prev, m[1]);
    m = /^\$steps\[(\d+)\]\.(.+)$/.exec(v);
    if (m) return pick(all[Number(m[1])], m[2]);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, prev, all));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, prev, all)]));
  return v;
}

// Smoke `expect` operators: {"$gt": n}, {"$contains": "text"} (a string), {"$length": n} (a string or array).
const OPS = { $gt: (a, n) => a > n, $contains: (a, s) => typeof a === 'string' && a.includes(s), $length: (a, n) => a?.length === n };

/** Whether `actual` holds `expected`: objects key by key, arrays index by index (longer actual arrays allowed), operator
 * objects (OPS) by their test. */
function partial(expected, actual) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e, i) => partial(e, actual[i]));
  const ops = isObject(expected) && Object.keys(expected);
  if (ops?.length && ops.every((k) => Object.hasOwn(OPS, k))) return ops.every((k) => OPS[k](actual, expected[k]));
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, e]) => partial(e, actual[k]));
  return expected === actual;
}

function passes(step, res) {
  const x = step.expect ?? { ok: true };
  const def = byId(step.id);
  if (res.ok && def?.undo === 'doc' && res.undoSteps > 1) return false; // a doc command makes at most one undo step
  return (x.ok === undefined || res.ok === x.ok)
    && (x.code === undefined || res.error?.code === x.code)
    && (x.undoSteps === undefined || res.undoSteps === x.undoSteps)
    && (x.result === undefined || partial(x.result, res.result))
    && (x.error === undefined || partial(x.error, res.error));
}

/** Runs script steps [{id, args?, dryRun?, ifRev?, expect?: {ok?, code?, undoSteps?, result?, error?}}] in order as
 * source 'smoke' → [{req, res, pass}]. */
export async function script(steps) {
  const out = [];
  for (const step of steps) {
    const all = out.map((o) => o.res);
    const req = { id: step.id, args: substitute(step.args ?? {}, all.at(-1), all), source: 'smoke' };
    if (step.dryRun) req.dryRun = true;
    if (step.ifRev !== undefined) req.ifRev = substitute(step.ifRev, all.at(-1), all);
    const res = await invoke(req);
    out.push({ req, res, pass: passes(step, res) });
  }
  return out;
}

/** The local agent gateway (main's src/agent-server.js, SPEC §8 Agents): runs its calls as source agent:<name>, cancels them,
 * and keeps state.agent.connections (the status bar's slot, with Disconnect) in step with its connections. */
function listenGateway() {
  const calls = new Map(); // rid → AbortController
  const setConnections = (fn) => setState({ agent: { ...getState().agent, connections: fn(getState().agent.connections) } });
  api.agent.onEvent((ev) => {
    if (ev.type === 'call') {
      const ctrl = new AbortController();
      calls.set(ev.rid, ctrl);
      // Main names the source; an outside agent's comes this way, and the in-app assistant's only from a Claude Code or Codex run
      // whose bridge sent this start's key (ev.assistant, agent-server.js), so no outside client borrows its policy.
      const ok = typeof ev.req?.source === 'string' && SOURCE_RE.test(ev.req.source) && isAgent(ev.req.source) && (ev.req.source !== ASSISTANT || ev.assistant === true);
      const run = ok ? invoke({ ...ev.req, signal: ctrl.signal }) : Promise.resolve(error('denied', 'Not an agent source', { reason: 'policy' }));
      run.then((res) => {
        calls.delete(ev.rid);
        let wire;
        try {
          wire = JSON.parse(JSON.stringify(res)); // what the pipe carries: JSON only
        } catch (e) {
          wire = error('failed', `The result is not JSON: ${e.message}`);
        }
        api.agent.reply(ev.rid, wire);
      });
    } else if (ev.type === 'cancel') {
      calls.get(ev.rid)?.abort();
    } else if (ev.type === 'connected') {
      if (getState().agent.connections.some((c) => c.id === ev.id)) return; // sent again when the renderer became ready
      setConnections((list) => [...list, { id: ev.id, name: ev.name, since: ev.since, disconnect: () => api.agent.disconnect(ev.id) }]);
      emit('agent.connected', { name: ev.name });
    } else if (ev.type === 'disconnected') {
      setConnections((list) => list.filter((c) => c.id !== ev.id));
      emit('agent.disconnected', { name: ev.name });
    }
  });
  api.agent.ready();
}

let installed = false;

/** Exposes window.__agent, starts the events and listens to the agent gateway; actions.js calls it once the app has started. */
export function installAgent() {
  if (installed) return;
  installed = true;
  watch();
  if (api.agent) listenGateway();
  // sessions: the drafts with a background session now, and its idle time ({ms}; a harness shortens it).
  window.__agent = { invoke, script, on, catalogue: () => capabilities(false), sessions: { ids: sessionIds, idle: SESSION_IDLE } };
}

// The command registry and its context (docs/plans/word plan.md §1.3): every ribbon, key, menu and tool search action, keyed by
// the feature id it serves, with the galleries, menu panels, backstage and options pages the work packages add. Merge rules
// (§1.2): a work package may replace a base entry; two work packages on one key is an error, logged once and counted for the
// harness, and the first stays. Galleries: a work package's provider replaces base's, several work packages' concatenate.
// Everything the tools offer filters through the active surface's profile (§1.19) and the surface kinds a command serves.
// Product-neutral: the format's base module binds the app's services (bindServices), its contexts and its typing test included,
// so this file names no Word feature, imports nothing from src/document and node tests load it. Commands with `meta` become tool
// search entries (toolEntries, docs/plans/cleanup/tool-pool-surfaces.md F2). On a canvas draft (the surface has an engine
// `session`) commands go through the content kind's engine table instead (docs/plans/engine/viewport-design.md section 4.7).
import { useSyncExternalStore } from 'react';
import { afterTyping, getState, setState, storeVersion, subscribe } from '../app/store.js';
import { grantOptions, grants, NO_PROFILE } from './profile.mjs';
import { REASONS } from './reasons.mjs';
import { activeSurface, setEngineStory, setSurfaceStory } from './surface.js';

// The app's services, bound by the format's base module (src/document/word/base.js).
const svc = {
  toast: () => {},
  dialog: async () => null,
  pane: () => {},
  tools: () => ({}),
  canvas: () => null, // the canvas being edited in place: {editor, target: {getPos}} or null
  onCanvas: () => () => {},
  settings: (s) => s,
  sect: () => null,
  contextOf: () => ({ in: {}, obj: null }), // the contextual flags and object of a ctx (§1.4 Contexts), see ctxOf
  typing: () => false, // whether a transaction only typed text, so the ctx readers wait for a typing pause
  board: () => null, // the active board (whiteboard.js activeBoard)
  chart: () => null, // the plan chart the plan chart bar serves (plan-chart.js activeChart: {view, attrs, w, h, missing, error})
  agentInput: () => null, // {author, tag} while an agent's press arrives (commands.js), whose engine commands are its tracked changes
};
/** Binds the app's services: {toast, dialog, pane, tools(editor) → T, canvas, onCanvas, settings(s), sect(state, settings),
 * contextOf(ctx, session) → {in, obj}, typing(transaction), board(), chart(), agentInput()}. */
export const bindServices = (services) => Object.assign(svc, services);

const asAgent = new WeakMap(); // SessionClient → its agentEngine

/** Engine session `engine` as the commands see it (ctx.engine): while an agent's press arrives (ui.invoke, tool.run on a canvas
 * draft: svc.agentInput), exec, execMany and insertText run as one execAs call, so the change is the agent's tracked change with
 * its suggestion group, never an untracked edit under the user's name (docs/plans/engine/stage2b.md decision 4). The check is at
 * the call, so a dialog opened by one and confirmed by the other is the confirmer's. */
function agentEngine(engine) {
  let p = asAgent.get(engine);
  if (p) return p;
  const as = (steps, one) => {
    const who = svc.agentInput();
    if (!who) return null;
    return Promise.resolve(engine.execAs(who.author, who.tag, steps)).then((r) => (one && r ? { ...r, value: r.value?.[0] } : r));
  };
  p = new Proxy(engine, {
    get(t, k) {
      if (k === 'exec') return (id, args = {}) => as([[id, args]], true) ?? t.exec(id, args);
      if (k === 'execMany') return (steps) => as(steps, false) ?? t.execMany(steps);
      if (k === 'insertText') return (text) => as([['text.insert', { text }]], true) ?? t.insertText(text);
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v; // its private fields need the client itself as `this`
    },
  });
  asAgent.set(engine, p);
  return p;
}

const commands = new Map(); // id → {owner, value: CommandSpec, surfaces: kinds | null}
const panels = new Map();
const backstage = new Map();
const optionsMap = new Map();
const galleries = new Map(); // id → {base: provider | null, wps: provider[]}
const implementedBy = {};
const duplicates = []; // [{kind, key, owners: [kept, ignored]}]
const engineTables = new Map(); // surface kind → Map(tooling id → {owner, value: a row, src/document/canvas/rows/forms.mjs})
const engineWild = new Map(); // surface kind → [[prefix, row]] of the rows keyed 'prefix.*'

/** Records that `second` registered `kind` `key` which `first` already holds: logged once, counted for the harness. */
export function noteDuplicate(kind, key, first, second) {
  duplicates.push({ kind, key, owners: [first, second] });
  console.error(`Word: ${kind} '${key}' is registered by both ${first} and ${second}; ${second}'s is ignored.`);
}

/** Puts `owner`'s `entries` into the keyed `map` under the merge rules: base may be replaced, a second work package is an error.
 * `extra` joins each stored record ({owner, value, ...extra}). */
export function putKeyed(map, kind, owner, entries, extra) {
  for (const [key, value] of Object.entries(entries ?? {})) {
    const had = map.get(key);
    if (had && had.owner !== 'base' && had.owner !== owner) noteDuplicate(kind, key, had.owner, owner);
    else map.set(key, { owner, value, ...extra });
  }
}

/** Registers `owner`'s commands (CommandSpec by id). `surfaces`: the surface kinds (activeSurface().kind) they serve, e.g.
 * ['document'] for Word's; absent, any surface whose profile grants them. The Word hub calls it per module, base.js first with
 * owner 'base'. */
export const register = (owner, cmds, surfaces = null) => putKeyed(commands, 'command', owner, cmds, { surfaces });

/** Registers a module's keyed parts (§1.2): commands (serving `surfaces`, see register), galleries, panels, backstage and options
 * pages, `implements`, and `engine`: its table {toolingId: row} for a canvas draft of those surfaces' kinds, in the row forms of
 * src/document/canvas/rows/forms.mjs (an engine id; true for a command that acts on the app and runs as registered; exec; off; a
 * CommandSpec run on the draft's session). A key 'prefix.*' covers every id under the prefix. A gallery provider or a panel
 * flagged `engine: true` (engine-provider.mjs both) reads ctx.read or ctx.engineState, so it serves a canvas draft too. */
export function registerModule(mod, surfaces = null) {
  const owner = mod.id;
  register(owner, mod.commands, surfaces);
  for (const kind of mod.engine ? surfaces ?? [] : []) {
    if (!engineTables.has(kind)) engineTables.set(kind, new Map());
    putKeyed(engineTables.get(kind), 'engine command', owner, mod.engine);
    engineWild.set(kind, [...engineTables.get(kind)].filter(([k]) => k.endsWith('.*')).map(([k, r]) => [k.slice(0, -1), r.value]));
  }
  putKeyed(panels, 'panel', owner, mod.panels);
  putKeyed(backstage, 'backstage page', owner, mod.backstage);
  putKeyed(optionsMap, 'options page', owner, mod.options);
  for (const [id, provider] of Object.entries(mod.galleries ?? {})) {
    const g = galleries.get(id) ?? { base: null, wps: [] };
    if (owner === 'base') g.base = provider;
    else g.wps.push(provider);
    galleries.set(id, g);
  }
  for (const id of mod.implements ?? []) implementedBy[id] = owner;
}

/** The command `id` → its CommandSpec, or null when unregistered, when it does not serve the active surface's kind or when the
 * surface's profile does not grant it (always null with no surface). On a canvas draft: what its table row makes of it (the
 * registered one for a row `true`), else, for a command that serves the surface, a disabled one with the `engine` reason. */
export function commandOf(id) {
  const surf = activeSurface();
  const e = commands.get(id);
  const serves = !!e && (!e.surfaces || e.surfaces.includes(surf?.kind));
  // A Document or post without an editor is a canvas draft (surface.js): without its session (the page area opens it or could
  // not), only the rows that act on the app run, and the rest show disabled, so nothing reaches the hidden DOM editor.
  const hosted = !surf?.editor && (surf?.kind === 'document' || surf?.kind === 'text');
  if (!surf?.session && !hosted) return serves && grants(surf?.profile ?? NO_PROFILE, id) ? e.value : null;
  if (!grants(surf.profile, id)) return null;
  const row = rowOf(surf.kind, id);
  if (row === true) return serves ? e.value : null;
  if (!surf.session) return serves || row != null ? NOT_OPEN : null;
  if (row != null) return specOfRow(row);
  return serves ? NOT_ON_ENGINE : null;
}

/** The table row of tooling id `id` for surface kind `kind`: its own, else the first 'prefix.*' row it falls under. */
function rowOf(kind, id) {
  const own = engineTables.get(kind)?.get(id);
  if (own) return own.value;
  for (const [prefix, row] of engineWild.get(kind) ?? []) if (id.startsWith(prefix)) return row;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Canvas drafts (docs/plans/engine/viewport-design.md section 4.7)

/** A granted command the focused canvas draft's table does not name yet: drawn disabled with its reason, as placeholders are. */
const NOT_ON_ENGINE = Object.freeze({ run: () => false, enabled: () => false, reason: () => REASONS.engine, fixed: true });
/** A command on a canvas draft whose page area has no session: it is opening the draft, or could not. */
const NOT_OPEN = Object.freeze({ run: () => false, enabled: () => false, reason: () => 'The canvas engine has not opened this draft.' });

// The focused session's command state at its selection, {engineId: {enabled, reason, checked, value}}: one state(ids) call per
// selection, layout or command event, so the ribbon reads active and enabled synchronously. It holds 'document.context' (what
// the selection is in, which contextOf and the surface's story read) and the ids the drawn controls have read so far.
let snap = {};
let watched = null; // {session, kind, ids, seed: the first read's extra ids, reads, version, off, busy: the reading promise | null, again, queued, listedAt}

// A tool search listing reads every entry's state (toolEntries), so its ids join the state call. Once no listing has read for
// LISTING_GONE ms, the next read sweeps: the ids start again from 'document.context' and the drawn controls, re-rendered, read
// theirs back (a mark and sweep), so a closed listing stops costing each keystroke the whole table's state (stage2/gaps.md,
// tooling: 14 ms a state call on the Word fixture with every id, the notes, contents and ink states scanning the document).
let listing = 0;
const LISTING_GONE = 1500;
/** `fn()` as a tool search listing's read (registry's toolEntries, the Word ribbon's entries in document/ribbon/search.js). */
export const listed = (fn) => {
  listing++;
  try {
    return fn();
  } finally {
    listing--;
  }
};

/** The snapshot entry of engine id `id`. An id no control read before joins the ids the state call asks for, and one more read
 * follows. */
function entry(id) {
  const w = watched;
  if (w && listing) w.listedAt = performance.now();
  if (w && !w.ids.has(id)) {
    w.ids.add(id);
    if (!w.queued) {
      w.queued = true;
      queueMicrotask(() => {
        w.queued = false;
        refreshEngine();
      });
    }
  }
  return snap[id];
}

// The snapshot as ctx.engineState: reading an id joins it to the state call, as ctx.stateOf does, so a row that reads the
// snapshot directly never keeps the first read's value (the seeded ids are asked for once only).
const snapView = new Proxy({}, {
  get: (_t, id) => (typeof id === 'string' ? entry(id) : undefined),
  has: (_t, id) => id in snap,
  ownKeys: () => Reflect.ownKeys(snap),
  getOwnPropertyDescriptor: (_t, id) => (id in snap ? { value: snap[id], enumerable: true, configurable: true, writable: false } : undefined),
});

const rowSpecs = new Map(); // a row (an engine id or a row object) → its CommandSpec, one object each so controls see a stable spec

/** The CommandSpec of table row `row` (rows/forms.mjs): an engine id or exec runs that engine command and reads its snapshot
 * entry; off is disabled with its reason; a CommandSpec is itself (run reads the snapshot again after it). */
function specOfRow(row) {
  if (typeof row === 'object' && typeof row.run === 'function') return row;
  let spec = rowSpecs.get(row);
  if (spec) return spec;
  if (typeof row === 'string') spec = execSpec({ exec: row });
  else if (typeof row.off === 'string') spec = { run: () => false, enabled: () => false, reason: () => row.off, fixed: true };
  else spec = execSpec(row);
  rowSpecs.set(row, spec);
  return spec;
}

/** An exec row's CommandSpec ({exec: engine id, args?, state?, when?, hide?, active?, value?}, rows/forms.mjs exec). */
function execSpec(row) {
  const key = row.state ?? row.exec;
  return {
    // run (the registry's) reads the state back before the result. A `ui` request in the result (a dialog the engine would open)
    // is left alone: the app opens its own.
    // Params of null run nothing (a gallery parent given no pick); a promise of params (a toggle that reads its state first)
    // runs once it settles.
    run: (ctx, arg) => {
      const go = (params) => (params === null ? false : Promise.resolve(ctx.engine.exec(row.exec, params ?? {})).catch((err) => {
        console.error(`Engine command '${row.exec}' failed:`, err);
        return false;
      }));
      const params = typeof row.args === 'function' ? row.args(arg, ctx) : row.args ?? arg ?? {};
      return typeof params?.then === 'function' ? params.then(go) : go(params);
    },
    enabled: (ctx) => !row.hide?.(ctx) && !row.when?.(ctx) && (entry(key)?.enabled ?? true),
    reason: (ctx) => (row.hide?.(ctx) ? null : row.when?.(ctx) ?? entry(key)?.reason ?? null),
    active: (ctx) => (row.active ? !!row.active(entry(key), ctx) : !!entry(key)?.checked),
    value: (ctx) => (row.value ? row.value(entry(key), ctx) ?? null : entry(key)?.value ?? null),
  };
}

/** Reads the snapshot again → a promise that settles once it is current: one state call in flight per session, and a call
 * while it runs (a command just ran) reads once more after it. The ctx readers re-render only when the snapshot differs, so
 * typing that keeps the format redraws nothing. */
function refreshEngine() {
  const w = watched;
  if (!w) return Promise.resolve();
  w.again = true;
  // ponytail: ids a drawn control stopped reading (a ribbon tab left) stay until the next listing sweep; sweep on a tab change too
  // if that shows in the keystroke budget.
  w.busy ??= (async () => {
    while (w.again && watched === w) {
      w.again = false;
      if (w.listedAt && performance.now() - w.listedAt > LISTING_GONE && !listing) {
        w.listedAt = 0;
        w.ids = new Set(['document.context']);
        bumpStory(); // the drawn controls read their ids again: each joins the state call (entry) and one more read follows
      }
      // The first read also takes every id the table's rows read (w.seed), so the first tool search listing is right; later
      // reads ask only for the ids read since, and the seeded entries stay until a read refreshes them.
      const ask = w.seed ? [...new Set([...w.ids, ...w.seed])] : [...w.ids];
      const got = await Promise.resolve(w.session.state(ask)).catch(() => null);
      if (watched !== w || !got) continue;
      w.seed = null;
      const next = { ...snap, ...got };
      if (JSON.stringify(next) === JSON.stringify(snap)) continue;
      snap = next;
      const c = snap['document.context']?.value;
      setEngineStory(c ? (c.equation ? 'equation' : c.story?.kind ?? 'body') : null);
      bumpStory();
    }
    w.busy = null;
  })();
  return w.busy;
}

/** A pure engine command's value for the ctx readers (galleries, panes, dialogs: `ctx.read(id, args)`). Null until the engine
 * answers, then the readers re-render; read again after a layout (a change to the document lays it out), the last value standing
 * meanwhile. The session's `query` refuses a command that changes the document. */
function readEngine(id, args = {}) {
  const w = watched;
  if (!w) return null;
  const key = `${id} ${JSON.stringify(args)}`;
  let r = w.reads.get(key);
  if (!r) w.reads.set(key, (r = { id, args, v: -1, value: null, busy: false }));
  if (r.v !== w.version) fetchRead(w, r);
  return r.value;
}

function fetchRead(w, r) {
  if (r.busy) return;
  r.busy = true;
  const v = w.version;
  const done = (value) => {
    r.busy = false;
    if (watched !== w) return;
    r.v = v;
    if (JSON.stringify(value) === JSON.stringify(r.value)) return;
    r.value = value;
    bumpStory();
  };
  Promise.resolve(w.session.query?.(r.id, r.args)).then((res) => done(res?.ok ? res.value ?? null : null), () => done(null));
}

/** The engine ids kind `kind`'s table rows read (an engine id row's, an exec row's state or exec id, a CommandSpec row's
 * `reads`), so the first state call holds them and the first tool search listing on a canvas draft is right; any other id a row
 * reads joins on its first read (entry). */
function tableIds(kind) {
  const ids = new Set();
  for (const { value: r } of engineTables.get(kind)?.values() ?? []) {
    if (typeof r === 'string') ids.add(r);
    else if (typeof r?.exec === 'string') ids.add(r.state ?? r.exec);
    for (const id of r?.reads ?? []) ids.add(id);
  }
  return ids;
}

/** Follows the focused session: listens to its selection, layout and command events (a command from its keys or another
 * view) and reads its state at once. Runs on store changes. An event that arrives while a read is in flight needs no other: the
 * worker answers in order, so the event was sent before that read ran and the read sees its change (one read per typed key,
 * not one per event). A layout event makes the ctx.read values stale: they are read again once typing pauses. */
function followEngine() {
  const surf = activeSurface();
  const session = surf?.session ?? null;
  if (session === (watched?.session ?? null)) return;
  watched?.off();
  watched = null;
  snap = {};
  setEngineStory(null);
  if (!session) return;
  const w = { session, kind: surf.kind, ids: new Set(['document.context']), seed: tableIds(surf.kind), reads: new Map(), version: 0, busy: null,
    again: false, queued: false };
  const revalidate = () => {
    if (watched === w) for (const r of w.reads.values()) fetchRead(w, r);
  };
  const offs = ['selection', 'layout', 'command'].map((event) => session.on?.(event, () => {
    if (event === 'layout') {
      w.version++;
      if (w.reads.size) afterTyping(revalidate);
    }
    return w.busy ?? refreshEngine();
  }));
  w.off = () => offs.forEach((off) => off?.());
  watched = w;
  refreshEngine();
}
subscribe(followEngine);

// ---------------------------------------------------------------------------------------------
// Context

let storyVersion = 0; // +1 per story switch, story transaction and engine state change, so active, value and enabled follow them
const storyListeners = new Set();
const bumpStory = () => {
  storyVersion++;
  for (const fn of storyListeners) fn();
};

let memo = null;

/** The context commands run in (WordCtx, §1.3), built once per transaction of the target and per store and story change. Beside
 * the Word fields it has `surface` (the active surface's kind or null), `engine` (the focused canvas draft's SessionClient, whose
 * exec and state the engine commands use, or null), and `board` and `chart` (read live, see bindServices). */
export function ctxOf(editor) {
  const surf = activeSurface();
  const ed = editor === undefined ? surf?.editor ?? null : editor;
  const story = surf && ed === surf.editor ? surf.story : null;
  const target = story?.editor ?? ed;
  const session = svc.canvas();
  const engine = surf?.session ?? null;
  const key = [ed, ed?.state, target, target?.state, storeVersion(), storyVersion, session, surf?.profile, engine];
  if (memo && key.every((v, i) => v === memo.key[i])) return memo.ctx;
  const s = getState();
  let T;
  let sect;
  const ctx = {
    ed,
    target,
    state: target?.state ?? null,
    profile: surf?.profile ?? NO_PROFILE,
    surface: surf?.kind ?? null,
    engine: engine && agentEngine(engine),
    // The focused canvas draft's command state at its selection and its pure reads; {} and null on the DOM path.
    engineState: engine ? snapView : {},
    read: (id, args) => (engine ? readEngine(id, args) : null),
    // One engine id's snapshot entry (a CommandSpec row's enabled, reason, pressed state or value); an id no row names joins the
    // state call from then on.
    stateOf: (id) => (engine ? entry(id) : undefined),
    // Stops asking the state call for `id` (a pane that read it closed); a later stateOf asks again.
    unwatch: (id) => void watched?.ids.delete(id),
    story: story?.kind ?? 'body',
    view: s.word?.view ?? 'print',
    settings: svc.settings(s.settings),
    run: (id, arg) => run(id, arg),
    dialog: (id, props) => svc.dialog(id, props),
    pane: (id, open, props) => svc.pane(id, open, props),
    chain: (fn) => !!target && fn(target.chain().focus()).run(),
    toast: (text) => svc.toast(text),
  };
  Object.defineProperties(ctx, {
    // documentTools(target) and the section are built only when a command reads them.
    T: { enumerable: true, get: () => (T ??= svc.tools(target)) },
    sect: { enumerable: true, get: () => (sect ??= svc.sect(ed?.state ?? null, s.settings)) },
    // Live: the active board and plan chart change without a store update.
    board: { enumerable: true, get: () => svc.board() },
    chart: { enumerable: true, get: () => svc.chart() },
  });
  // The format's contexts (Word's: base.js); `session` is a canvas of the main editor open in place.
  Object.assign(ctx, svc.contextOf(ctx, session));
  memo = { key, ctx };
  return ctx;
}

function subscribeCtx(fn) {
  let bound = null; // the target editor whose transactions re-render
  // Typing re-renders the ctx readers once it pauses (store.js afterTyping); anything else at once.
  const onTr = ({ transaction }) => (svc.typing(transaction) ? afterTyping(fn) : fn());
  const bind = () => {
    const t = ctxOf().target;
    if (t === bound) return;
    bound?.off('transaction', onTr);
    bound = t;
    bound?.on('transaction', onTr);
  };
  const changed = () => {
    bind();
    fn();
  };
  bind();
  storyListeners.add(changed);
  const offs = [subscribe(changed), svc.onCanvas(changed), () => storyListeners.delete(changed)];
  return () => {
    for (const off of offs) off();
    bound?.off('transaction', onTr);
  };
}

/** React hook: the ctx, re-rendered on target transactions, store changes and story switches. */
export const useWordCtx = () => useSyncExternalStore(subscribeCtx, ctxOf);

/** React hook: `read(ctx)`, a primitive, re-rendered only when it changes (a control drawn per page that reads one state). */
export const useWordValue = (read) => useSyncExternalStore(subscribeCtx, () => read(ctxOf()));

// ---------------------------------------------------------------------------------------------
// Running

let last = null;

// A spec control or item with `needs` stays a placeholder even when a command exists (§1.4); the spec reaches the registry
// through window.__word.spec, which its owner sets.
const needsOf = (id) => {
  const spec = globalThis.__word?.spec;
  return spec?.CONTROLS?.[id]?.needs ?? spec?.ITEMS?.[id]?.needs ?? null;
};

/** Runs command `id` with `arg` → its result; unregistered or a placeholder toasts its reason and returns false, as does a
 * command the profile does not grant (silently) or one disabled now. Records lastCommand when repeatable. */
export function run(id, arg) {
  const needs = needsOf(id);
  const spec = needs ? null : commandOf(id);
  if (needs || (!spec && !commands.has(id))) {
    svc.toast(REASONS[needs] ?? REASONS.pending);
    return false;
  }
  if (!spec) return false;
  const ctx = ctxOf();
  if (spec.enabled && !spec.enabled(ctx)) {
    // On a canvas draft the snapshot can trail the selection (a command run right after a selection change, an id read for the
    // first time): read it again and decide then. A gap row (`fixed`) stays off.
    if (!ctx.engine || spec.fixed) return false;
    return refreshEngine().then(() => {
      const now = ctxOf();
      return commandOf(id) === spec && spec.enabled(now) ? start(id, spec, now, arg) : false;
    });
  }
  return start(id, spec, ctx, arg);
}

/** Runs enabled command `id`'s `spec` in `ctx` (run). */
function start(id, spec, ctx, arg) {
  const result = spec.run(ctx, arg);
  if (spec.repeatable && result !== false) last = { id, arg };
  // On a canvas draft the result waits for the engine's state read back: a caret format change moves no selection and lays
  // nothing out, and a caller such as tool.run reads the toggle's state right after.
  if (ctx.engine && typeof result?.then === 'function') return result.then(async (v) => (await refreshEngine(), v));
  return result;
}

/** The last repeatable command run → {id, arg} | null (F4, Repeat). */
export const lastCommand = () => last;

/** Word's key binding to command `cmd` with `arg` (keymap row `row`) on a canvas draft (src/engine/input/keys.mjs createKeymap
 * `tool`), as WordKeys runs it in the DOM editor (src/document/word/keys.js) → a function that runs it through the registry, or
 * null when the key goes on to the editor's own keys: a `fallthrough` row whose command cannot run now. The function starts the
 * command and returns: its engine calls leave in order after the keys before it, and a dialog it opens holds no key after it. */
export function keyCommand(cmd, arg, row) {
  const spec = commandOf(cmd);
  if (row?.fallthrough && (!spec || (spec.enabled && !spec.enabled(ctxOf())))) return null;
  return () => {
    Promise.resolve(run(cmd, arg)).catch((err) => console.error(`Key command '${cmd}' failed:`, err));
  };
}

/** Whether keymap context `when` holds on the focused surface (createKeymap `holds`): none and 'window' always, the others by
 * the ctx's `in` flag of that name (table, header, outline, tabContext). */
export const keyHolds = (when) => !when || when === 'window' || !!ctxOf().in?.[when];

// ---------------------------------------------------------------------------------------------
// Stories

let storyOff = null; // detaches the listeners of the current story

/** Story sub-editor `editor` of `kind` takes the focus: it is the target until its onExit, its destroy or a focus inside the main
 * editor. The blur a ribbon menu, combo, spinner or dialog causes does not clear it. */
export function setStory(kind, editor) {
  const surf = activeSurface();
  if (surf?.format !== 'document' || !surf.editor || !editor || (surf.story?.editor === editor && surf.story.kind === kind)) return;
  storyOff?.();
  const main = surf.editor;
  const clear = () => clearStory(editor);
  editor.on('transaction', bumpStory);
  editor.on('destroy', clear);
  main.on('focus', clear);
  storyOff = () => {
    editor.off('transaction', bumpStory);
    editor.off('destroy', clear);
    main.off('focus', clear);
  };
  setSurfaceStory({ kind, editor });
  setState({ word: { ...getState().word, story: kind } });
  bumpStory();
}

/** The story `editor` stops being the target (its onExit or destroy); a call for another story editor does nothing. */
export function clearStory(editor) {
  const story = activeSurface()?.story;
  if (editor && story && story.editor !== editor) return;
  storyOff?.();
  storyOff = null;
  setSurfaceStory(null);
  if (getState().word?.story) setState({ word: { ...getState().word, story: null } });
  bumpStory();
}

/** The editor commands act on (ctxOf().target): focusMain and refocusEditor focus it, so a dialog returns to the story. */
export const targetEditor = () => ctxOf().target;

// ---------------------------------------------------------------------------------------------
// Lookups

/** The duplicate registrations so far → [{kind, key, owners: [kept, ignored]}] (the harness fails on any). */
export const duplicateList = () => duplicates.map((d) => ({ ...d, owners: [...d.owners] }));

/** Every registered command id (the benchmark, the harness). */
export const registered = () => [...commands.keys()];

/** The owner ('base' or a module id) of command `id`, or null (the benchmark's registered.json). */
export const ownerOf = (id) => commands.get(id)?.owner ?? null;

/** {featureId: owner} from the modules' `implements`. */
export const implemented = () => ({ ...implementedBy });

/** The items of gallery `id` for `ctx`: a work package's providers (concatenated in hub order) else base's, filtered by the profile. */
export function galleryOf(id, ctx = ctxOf()) {
  const g = galleries.get(id);
  let providers = !g ? [] : g.wps.length ? g.wps : g.base ? [g.base] : [];
  // Most providers read the DOM editor: a canvas draft gets those flagged `engine: true` (they read ctx.read or engineState).
  if (ctx.engine) providers = providers.filter((p) => p.engine);
  return grantOptions(ctx.profile, id, providers.flatMap((p) => p(ctx) ?? []));
}

/** The menu panel component registered as `id`, or null; on a canvas draft only a panel flagged `engine: true` (the others act on
 * the DOM editor). */
export function panelOf(id) {
  const panel = panels.get(id)?.value ?? null;
  return activeSurface()?.session && !panel?.engine ? null : panel;
}

/** Tool search entries generated from every registered command with `meta` (TL1, TL12, rule B6), in registration order:
 * {id (the command id), label, group, icon, keywords, key, category, toggle?, active?(), options?(), optionsFirst?, when(), notice(),
 * run(ctx, arg), arg: true (tool.run passes its arg), risk, headless, agent}. meta `optionsFirst`: Enter opens the options (a command that needs an argument the options
 * pick). meta `risk`, `headless` and `agent` are what tool.run applies (commands/tool.mjs; unset: write, headless, visible to agents).
 * An entry shows (when) while commandOf gives its command on the active surface and the command is enabled, or disabled with a
 * reason (notice gives that reason); it runs through run(id, arg). Its `icon` is the meta's as given (app/tools.js draws it). */
export function toolEntries() {
  const off = (spec, ctx) => !!spec.enabled && spec.enabled(ctx) === false;
  const out = [];
  for (const [id, e] of commands) {
    const meta = e.value.meta;
    if (!meta) continue;
    out.push({
      id, label: meta.label, group: meta.group ?? 'Tools', icon: meta.icon ?? null, keywords: meta.keywords ?? [], key: meta.key, category: meta.category,
      when: () => listed(() => {
        const spec = commandOf(id);
        if (!spec) return false;
        const ctx = ctxOf();
        return !off(spec, ctx) || !!spec.reason?.(ctx);
      }),
      notice: () => listed(() => {
        const spec = commandOf(id);
        const ctx = ctxOf();
        return spec && off(spec, ctx) ? spec.reason?.(ctx) ?? null : null;
      }),
      run: (_c, arg) => run(id, arg), arg: true,
      risk: meta.risk, headless: meta.headless, agent: meta.agent,
      ...(meta.toggle && { toggle: true, active: () => listed(() => !!commandOf(id)?.active?.(ctxOf())) }),
      ...(e.value.options && { options: () => commandOf(id)?.options?.(ctxOf()) ?? null }),
      ...(meta.optionsFirst && { optionsFirst: true }),
    });
  }
  return out;
}

/** The Options dialog's registered pages → [[pageId, Component]] in hub order. */
export const optionsPages = () => [...optionsMap].map(([id, e]) => [id, e.value]);

/** The backstage page Component of `id`, or null (the shell draws a placeholder page). */
export const backstagePage = (id) => backstage.get(id)?.value ?? null;

let menuView = null;
/** The ribbon renderer registers its MenuView at import; tool search draws option panels with it. */
export const setMenuView = (Component) => {
  menuView = Component;
};
export const menuViewOf = () => menuView;

// ---------------------------------------------------------------------------------------------
// Harness

/** A plain summary of ctxOf() for harness cases. */
function summary(ctx = ctxOf()) {
  return {
    surface: ctx.surface, engine: !!ctx.engine, ed: !!ctx.ed, target: !ctx.target ? null : ctx.target === ctx.ed ? 'main' : 'story', story: ctx.story, view: ctx.view, in: ctx.in,
    obj: ctx.obj && { kind: ctx.obj.kind, pos: ctx.obj.pos }, grantsAll: ctx.profile.grants === '*', board: !!ctx.board, chart: !!ctx.chart,
  };
}

/** A command's state as a control would draw it, for harness cases. */
function stateOf(id) {
  const spec = commandOf(id);
  if (!spec) return { registered: commands.has(id), granted: false };
  const ctx = ctxOf();
  const call = (fn) => (typeof fn === 'function' ? fn(ctx) : fn);
  return { registered: true, granted: true, enabled: spec.enabled ? !!spec.enabled(ctx) : true, active: call(spec.active) ?? null,
    value: call(spec.value) ?? null, label: call(spec.label) ?? null, reason: call(spec.reason) ?? null };
}

if (typeof window !== 'undefined') {
  // geometry, layer and spec join from their owners (the hub, the spec).
  window.__word = Object.assign(window.__word ?? {}, {
    commands: registered, ownerOf, implemented, run, ctx: () => summary(), state: stateOf, duplicates: duplicateList,
    surface: () => {
      const s = activeSurface();
      return s && { kind: s.kind, format: s.format, editor: !!s.editor, session: !!s.session, grantsAll: s.profile.grants === '*' };
    },
    // The canvas draft's tools: the snapshot the ribbon reads, and the session they act on (the page area's client).
    engine: () => (watched ? { kind: watched.kind, state: snap } : null),
    // The engine ids the next state call asks for (the keystroke cost a tool search listing adds, and its sweep).
    engineIds: () => (watched ? [...watched.ids] : []),
    session: () => activeSurface()?.session ?? null,
    focusSession: (session) => setState({ focusedSession: session ?? null }), // a case that needs the DOM path with the canvas open
    toolEntries: () => toolEntries().map((t) => ({ id: t.id, label: t.label, shown: t.when(), reason: t.notice() })),
  });
}

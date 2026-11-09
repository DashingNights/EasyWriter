import { loadable } from '../../editors.js';
import { engineHost } from '../../engine/client.js';
import { formOfDraft, isCanvas, openDraft, unreadable } from '../../engine/model/form.mjs';
import { pageOf } from '../../formats.mjs';
import { checkPost, isPost, postSource, postsOn } from '../../document/canvas/post.js';
import { editWatch } from '../../engine/model/autosave.mjs';
import { makeEditor, NEWER_FORMAT, saveCanvasOther, saveOther } from '../actions.js';
import { fail } from '../commands/define.mjs';
import * as history from '../history.js';
import { revs } from '../rev.js';
import { getState, setState, subscribe } from '../store.js';

// Background sessions (SPEC §7i Background drafts; docs/wiki/assistant-reliability.md §7 Tier B): the assistant works on a draft
// other than the open one in a hidden editor of its own, made as the open draft's (actions.js makeEditor: the same extensions and
// node views), in a host inside #sessions (App.jsx, in the main column): offscreen and visibility hidden, never display none, so
// node views measure and boards draw. A session loads its draft from the drafts store, saves through the open draft's save path
// (actions.js saveOther) SAVE_MS after a change, keeps revisions of its own (rev.js revs: ifRev with draftId) and ends IDLE.ms
// after its last command, or when the user opens its draft (handOver: the main editor takes its document and undo steps). The open
// draft never gets one and a session never writes the open draft's file. commands.js routes a command with draftId here.
// A canvas draft's session (docs/plans/engine/stage2b.md decision 5) is a quiet session in the window's engine worker instead: it
// lays nothing out until a view shows it, saves through the record's save path (actions.js saveCanvasOther), and at the hand-over
// the page area takes it as it is, its undo steps included (src/document/canvas/session.js useEngine).

const api = window.api;
export const IDLE = { ms: 5 * 60 * 1000 }; // a session's life after its last command (a harness shortens it)
const SAVE_MS = 800; // as the open draft's autosave
const HOST = 'position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none';
// draftId → {draftId, draft, editor, log, host, rev, revs, dirty, saveTimer, idleTimer, pending, ending, changed}; a canvas draft's
// has `client`, its SessionClient, in place of editor, log, host and revs
const live = new Map();
const loading = new Map(); // draftId → the promise of start()

/** Its own draft's format and width on a session's host, not the open draft's (the root's), as actions.js applyPage sets them on
 * the open page. `sect` is the session editor's live page setup (a Document's doc.attrs.sect, newer than the draft file's). */
function paint(host, draft, sect) {
  const { format, width, padding } = pageOf(draft, getState().settings, sect);
  host.dataset.format = format;
  host.style.setProperty('--page-width', `${width}px`);
  host.style.setProperty('--page-pad', `${padding}px`);
}

// A live host follows the settings (Settings > Page width), as the open page does through actions.js applySettings.
let painted = getState().settings;
subscribe(() => {
  if (getState().settings === painted) return;
  painted = getState().settings;
  for (const s of live.values()) if (s.host) paint(s.host, s.draft, s.editor.state.doc.attrs.sect ?? undefined);
});

/** The session of draft `draftId` (started on first use), or null when it is the open draft. Throws not_found when the draft
 * cannot be loaded, refused when it cannot load here (editors.js loadable, as openDraft). */
export async function sessionFor(draftId) {
  for (;;) {
    if (getState().draft?.id === draftId) return null;
    const s = live.get(draftId);
    if (s && !s.ending) {
      touch(s);
      return s;
    }
    if (s) await s.ending; // its end saves first, so a new session reads the saved file
    else {
      if (!loading.has(draftId)) loading.set(draftId, start(draftId).finally(() => loading.delete(draftId)));
      await loading.get(draftId);
    }
  }
}

async function start(draftId) {
  // The background window of computer use holds that draft (§7i Background window): never two editors on one draft.
  if (getState().worker?.draftId === draftId) fail('busy', 'The background window has that draft. Use computer_act with target background, or background_close first.');
  const [draft, file] = await Promise.all([api.drafts.load(draftId), api.drafts.loadHistory(draftId).catch(() => null)]);
  if (!draft) fail('not_found', `The draft ${draftId} could not be loaded`);
  if (!loadable(draft, getState().settings)) fail('refused', NEWER_FORMAT);
  // A whiteboard keeps its items in draft.board, not in a doc a session could edit: its commands do not reach it here.
  if (draft.format === 'board') fail('refused', 'A whiteboard cannot be edited in the background');
  if (getState().draft?.id === draftId) return; // the user opened it meanwhile
  // A forum post the engine hosts: a canvas session too, so a DOM post is converted through sourceOf (postSource) and checked
  // against the engine's save before its record changes (C5). One the engine would change keeps the DOM host, as the page area
  // leaves it on its DOM editor.
  if (isCanvas(draft) || (isPost(draft, getState().settings) && postsOn(getState()))) {
    try {
      return await startCanvas(draftId, draft, file);
    } catch (e) {
      if (isCanvas(draft) || !e?.data?.postRefused) throw e;
    }
  }
  const host = document.createElement('div');
  host.className = 'page'; // the page's width and typography
  host.style.cssText = HOST;
  paint(host, draft);
  (document.getElementById('sessions') ?? document.body).append(host);
  const s = { draftId, draft, host, rev: getState().rev, dirty: false, saveTimer: 0, idleTimer: 0, pending: null, ending: null };
  s.changed = () => changed(s);
  Object.assign(s, makeEditor(host, draft.doc, file, getState().settings.historyLimit, s.changed, draft));
  s.revs = revs(s);
  s.revs.clear(); // its first rev, above the open draft's revs so far
  s.editor.on('transaction', ({ transaction, appendedTransactions }) => {
    s.revs.record(transaction, appendedTransactions);
    // A doc.pageSetup with draftId: the host takes the new text width, as actions.js does for the open editor, so pictures and
    // canvases inserted after it are sized to the new column (contentWidth reads the host).
    const sect = s.editor.state.doc.attrs.sect;
    if (transaction.before.attrs.sect !== sect) paint(host, draft, sect ?? undefined);
  });
  live.set(draftId, s);
}

/** A canvas draft's session: the draft and the undo history saved beside it (engine-undo-file) in a quiet session of the window's
 * engine. A session the engine has already (a hand-over still under way) is taken as it is. */
async function startCanvas(draftId, draft, file) {
  const title = draft.title || 'Untitled';
  const settings = getState().settings;
  const post = isPost(draft, settings);
  const why = draft.engine && unreadable(draft.engine, formOfDraft(draft));
  if (why) fail('refused', `The draft "${title}" cannot open: ${why}.`);
  const had = engineHost().ids().includes(draftId);
  const client = engineHost().session(draftId);
  try {
    if (!had) {
      await client.quiet(true);
      // A post opens from its own JSON (post.js postSource); a DOM post's first save here makes it a canvas record (saveOnce's
      // adopt), and checkPost keeps a post the engine would change out of the engine.
      await openDraft(client, draft, post ? { source: (d) => postSource(d, settings) } : undefined);
      if (post && !isCanvas(draft)) await checkPost(client, draft, settings);
      const stamp = draft.engine?.stamp ?? '';
      const r = file && (await client.openHistory(file, stamp).catch(() => null));
      if (r?.kept) client.savedHistory(stamp, file);
    }
  } catch (e) {
    client.release();
    // checkPost refused it (convert.mjs refused): it keeps its DOM form, as the page area's open leaves it. A DOM post's
    // session then opens on the DOM host (start).
    if (e?.why) fail('refused', `The draft "${title}" stays in the DOM editor because ${e.why}`, { postRefused: true, why: e.why });
    fail('refused', `The draft "${title}" could not open in the canvas engine: ${e.message || e}`);
  }
  if (getState().draft?.id === draftId) return client.release(); // the user opened it meanwhile: the page area holds it now
  const s = { draftId, draft, client, editor: null, rev: 0, dirty: false, saveTimer: 0, idleTimer: 0, pending: null, ending: null };
  s.changed = () => changed(s);
  // An edit saves through changed, exactly as the page area's bind does (src/document/canvas/session.js): a board shows this
  // draft with no page area of its own, so its edits reach this session's save from here. The steps the session opens with (its
  // saved history included) are the filter's baseline, as the page area seeds it: a layout that only shows them again is no
  // edit, so opening a draft with history no longer rewrites its record 800 ms later.
  const edited = editWatch();
  s.savedSteps = await client.steps().catch(() => null);
  if (s.savedSteps) edited({ steps: s.savedSteps });
  s.offLayout = client.on('layout', (e) => {
    if (edited(e)) changed(s);
  });
  live.set(draftId, s);
}

/** The session's draft changed: it saves SAVE_MS after the last change. */
function changed(s) {
  s.dirty = true;
  clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => save(s), SAVE_MS);
}

function touch(s) {
  clearTimeout(s.idleTimer);
  if (s.pinned) return; // a board shows it: the idle timer waits for the last unpin
  s.idleTimer = setTimeout(() => end(s.draftId), IDLE.ms);
}

/** Pins the session of `draftId` while a board shows it (docs/plans/board/briefs/bd-instance.md): it starts the session through
 * sessionFor, lets it lay out (`quiet(false)`), and keeps its idle timer off until the last unpin. → unpin(), which lets the idle
 * timer count again. A draft the user has open (its page area holds it) is no session to pin: its no-op unpin comes back. */
export async function pinSession(draftId) {
  const s = await sessionFor(draftId);
  if (!s) return () => {};
  s.pins = (s.pins ?? 0) + 1;
  s.pinned = true;
  clearTimeout(s.idleTimer);
  s.client?.quiet(false).catch(() => {});
  let done = false;
  return () => {
    if (done) return;
    done = true;
    s.pins = Math.max(0, (s.pins ?? 1) - 1);
    if (s.pins) return;
    s.pinned = false;
    if (live.get(s.draftId) !== s) return; // the session already ended (its draft deleted): nothing is left to write
    // An edit still in flight when the board lets go is written before quiet stops every layout it would arrive in.
    flushEdit(s).catch(() => {}).finally(() => {
      if (!s.pinned && live.get(s.draftId) === s) s.client?.quiet(true).catch(() => {});
    });
    if (live.get(draftId) === s) touch(s);
  };
}

/** Saves the session's last change (never while its draft is the open one). → true when saved or nothing to save. */
async function save(s) {
  clearTimeout(s.saveTimer);
  if (!s.dirty || getState().draft?.id === s.draftId) return !s.dirty;
  s.dirty = false;
  const ok = await (s.client ? saveCanvasOther(s.draft, s.client) : saveOther(s.draft, s.editor, s.log));
  if (!ok) s.dirty = true;
  else if (s.client) s.savedSteps = await s.client.steps().catch(() => s.savedSteps); // the baseline the unpin flush compares with
  return ok;
}

/** Saves the last change of session `draftId` now, an edit whose layout event has not arrived included → true when it has none
 * left (saved, or nothing to save), false when the save failed. A caller letting the session go (a board's close, bd-instance)
 * asks this first. */
export async function saveSession(draftId) {
  const s = live.get(draftId);
  if (!s || getState().draft?.id === draftId) return true;
  return flushEdit(s);
}

/** Ends session `draftId` after a caller saved it (bd-instance's cap): its engine session closes once no view holds it, and its
 * undo history, written with its record, returns when it reopens. → whether it had a session. */
export async function closeSession(draftId) {
  const s = live.get(draftId);
  if (!s) return false;
  clearTimeout(s.saveTimer);
  await end(draftId);
  return true;
}

/** Writes a session's pending edit before it goes quiet. An edit whose layout event has not arrived yet is not `dirty`, so the
 * engine's top undo and redo steps are compared with the ones at its last save. Never throws. */
async function flushEdit(s) {
  if (!s.client) return save(s);
  const steps = await s.client.steps().catch(() => null);
  if (steps && s.savedSteps && (steps.undo !== s.savedSteps.undo || steps.redo !== s.savedSteps.redo)) s.dirty = true;
  if (!s.dirty) {
    clearTimeout(s.saveTimer);
    return true;
  }
  return save(s);
}

/** Ends the session of `draftId` after its in-flight command, its last change saved (not with `drop`); its editor and host go.
 * → {draft, doc, history (its undo steps as a history file, at least 50 kept)}, or null when it has none. A canvas draft's → {draft,
 * canvas: true}: with `hand` its engine session stays for the page area, which takes it with its undo steps (client.js handOff). */
function end(draftId, { drop = false, hand = false } = {}) {
  const s = live.get(draftId);
  if (!s) return Promise.resolve(null);
  s.ending ??= (async () => {
    clearTimeout(s.idleTimer);
    await s.pending;
    if (!drop) await save(s);
    clearTimeout(s.saveTimer);
    s.offLayout?.();
    if (s.client) {
      live.delete(draftId);
      if (!hand) s.client.release();
      else {
        await s.client.quiet(false).catch(() => {}); // a view shows it now: its layout goes out
        s.client.handOff();
      }
      return { draft: s.draft, doc: null, history: null, canvas: true };
    }
    const out = { draft: s.draft, doc: s.editor.getJSON(), history: history.encode(s.log, getState().settings.historyLimit || 50) };
    s.editor.destroy();
    s.host.remove();
    live.delete(draftId);
    return out;
  })();
  return s.ending;
}

/** The user opens `draftId` (actions.js openDraft): its session (also one still starting) ends as end() says, its badge goes. →
 * end()'s answer, for the main editor to load. */
export async function handOver(draftId) {
  await loading.get(draftId)?.catch(() => {});
  const out = await end(draftId, { hand: true });
  if (out) setState({ bgWrites: getState().bgWrites.filter((id) => id !== draftId) });
  return out;
}

/** The draft `draftId` is deleted: its session ends unsaved. → whether it had one. */
export async function dropSession(draftId) {
  await loading.get(draftId)?.catch(() => {});
  return !!(await end(draftId, { drop: true }));
}

/** The engine session of canvas draft `draftId`'s background session, or null (drafts.get reads its text there). */
export const backgroundClient = (draftId) => live.get(draftId)?.client ?? null;

/** The draft object of the session of `draftId` (its next save writes it), or null. */
export const backgroundDraft = (draftId) => live.get(draftId)?.draft ?? null;

/** Saves the last change of every session that has one (the window closes) → a promise, or null when none has one. */
export function flushSessions() {
  const dirty = [...live.values()].filter((s) => s.dirty);
  return dirty.length ? Promise.all(dirty.map(save)) : null;
}

/** The ids of the drafts that have a session now (the situation note, a harness). */
export const sessionIds = () => [...live.values()].filter((s) => !s.ending).map((s) => s.draftId);

/** The assistant wrote in the session of `draftId` this turn: its sidebar row shows the badge, the chat panel its status line. */
export function noteWrite(draftId) {
  const ids = getState().bgWrites;
  if (!ids.includes(draftId)) setState({ bgWrites: [...ids, draftId] });
}

/** The assistant's turn ended (loop.js): the badges go. */
export function endTurn() {
  if (getState().bgWrites.length) setState({ bgWrites: [] });
}

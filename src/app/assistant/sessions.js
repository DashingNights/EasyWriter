import { makeEditor, saveOther } from '../actions.js';
import { fail } from '../commands/define.mjs';
import * as history from '../history.js';
import { revs } from '../rev.js';
import { getState, setState } from '../store.js';

// Background sessions (SPEC §7i Background drafts; docs/plans/assistant-reliability.md §7 Tier B): the assistant works on a draft
// other than the open one in a hidden editor of its own, made as the open draft's (actions.js makeEditor: the same extensions and
// node views), in a host inside #sessions (App.jsx, in the main column): offscreen and visibility hidden, never display none, so
// node views measure and boards draw. A session loads its draft from the drafts store, saves through the open draft's save path
// (actions.js saveOther) SAVE_MS after a change, keeps revisions of its own (rev.js revs: ifRev with draftId) and ends IDLE.ms
// after its last command, or when the user opens its draft (handOver: the main editor takes its document and undo steps). The open
// draft never gets one and a session never writes the open draft's file. commands.js routes a command with draftId here.

const api = window.api;
export const IDLE = { ms: 5 * 60 * 1000 }; // a session's life after its last command (a harness shortens it)
const SAVE_MS = 800; // as the open draft's autosave
const HOST = 'position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none';
const live = new Map(); // draftId → {draftId, draft, editor, log, host, rev, revs, dirty, saveTimer, idleTimer, pending, ending}
const loading = new Map(); // draftId → the promise of start()

/** The session of draft `draftId` (started on first use), or null when it is the open draft. Throws not_found when the draft
 * cannot be loaded. */
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
  if (getState().draft?.id === draftId) return; // the user opened it meanwhile
  const host = document.createElement('div');
  host.className = 'page'; // the page's width and typography
  host.style.cssText = HOST;
  (document.getElementById('sessions') ?? document.body).append(host);
  const s = { draftId, draft, host, rev: getState().rev, dirty: false, saveTimer: 0, idleTimer: 0, pending: null, ending: null };
  Object.assign(s, makeEditor(host, draft.doc, file, getState().settings.historyLimit, () => {
    s.dirty = true;
    clearTimeout(s.saveTimer);
    s.saveTimer = setTimeout(() => save(s), SAVE_MS);
  }));
  s.revs = revs(s);
  s.revs.clear(); // its first rev, above the open draft's revs so far
  s.editor.on('transaction', ({ transaction, appendedTransactions }) => s.revs.record(transaction, appendedTransactions));
  live.set(draftId, s);
}

function touch(s) {
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => end(s.draftId), IDLE.ms);
}

/** Saves the session's last change (never while its draft is the open one). → true when saved or nothing to save. */
async function save(s) {
  clearTimeout(s.saveTimer);
  if (!s.dirty || getState().draft?.id === s.draftId) return !s.dirty;
  s.dirty = false;
  const ok = await saveOther(s.draft, s.editor, s.log);
  if (!ok) s.dirty = true;
  return ok;
}

/** Ends the session of `draftId` after its in-flight command, its last change saved (not with `drop`); its editor and host go.
 * → {draft, doc, history (its undo steps as a history file, at least 50 kept)}, or null when it has none. */
function end(draftId, { drop = false } = {}) {
  const s = live.get(draftId);
  if (!s) return Promise.resolve(null);
  s.ending ??= (async () => {
    clearTimeout(s.idleTimer);
    await s.pending;
    if (!drop) await save(s);
    clearTimeout(s.saveTimer);
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
  const out = await end(draftId);
  if (out) setState({ bgWrites: getState().bgWrites.filter((id) => id !== draftId) });
  return out;
}

/** The draft `draftId` is deleted: its session ends unsaved. → whether it had one. */
export async function dropSession(draftId) {
  await loading.get(draftId)?.catch(() => {});
  return !!(await end(draftId, { drop: true }));
}

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

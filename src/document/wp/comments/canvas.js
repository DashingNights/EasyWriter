// Comments on a canvas draft (docs/plans/engine/stage2.md Decisions): the engine keeps the threads (review.comments) and the
// cards are React overlays beside each page, placed from the engine's anchors (the host's caret at each anchor). This file holds
// the cards' UI state (the active card, the one being edited, the filter), each session's threads, and the Review rows' comment
// hooks (rows/review.mjs reviewApp). CanvasCards.jsx draws them.
import { useSyncExternalStore } from 'react';
import { afterTyping, getState } from '../../../app/store.js';
import { ctxOf } from '../../../tooling/registry.js';
import { activeSurface } from '../../../tooling/surface.js';
import { registerOverlay } from '../../canvas/overlay.jsx';
import { publish, sessionRecords } from '../../canvas/records.js';
import { bindReviewApp } from '../../canvas/rows/review.mjs';
import { wordSettings } from '../../word/settings.mjs';
import { PageCards } from './CanvasCards.jsx';

// ---------- the cards' UI state: {active, editing: {id, mode: 'edit' | 'reply', isNew} | null, filter, opened, found} ----------
// `found` {id, matches}: Find In's matches selected in comment `id` (src/document/wp/find/actions.js), marked on its card while
// the selection stays in that comment.

export const ui = { active: null, editing: null, filter: null, opened: null, found: null };
let uiVersion = 0;
const uiFns = new Set();
export function setUi(patch) {
  Object.assign(ui, patch);
  uiVersion++;
  for (const fn of uiFns) fn();
}
const subUi = (fn) => (uiFns.add(fn), () => uiFns.delete(fn));
export const useUi = () => useSyncExternalStore(subUi, () => uiVersion);

/** The threads the filter shows, from review.comments entries (replies follow their thread). */
export function shownOf(list, filter = ui.filter) {
  if (!filter) return list;
  const top = new Map(list.filter((c) => c.parent == null).map((c) => [c.id, c]));
  const root = (c) => {
    let at = c;
    for (let i = 0; at?.parent != null && i < 100; i++) at = list.find((x) => x.id === at.parent);
    return at ?? c;
  };
  return list.filter((c) => {
    const t = top.get(root(c).id);
    return !!t && (filter === 'resolved' ? t.resolved : !t.resolved);
  });
}

// ---------- each session's threads ----------

/** review.comments as threads: [{id, author, date, resolved, text, anchor, place: {page, y} | null, replies: [...]}]. */
function threadsOf(list, places) {
  const byId = new Map(list.map((c) => [c.id, { ...c, replies: [] }]));
  const threads = [];
  for (const c of byId.values()) {
    let top = c;
    for (let i = 0; top.parent != null && byId.has(top.parent) && i < 100; i++) top = byId.get(top.parent);
    if (top === c) threads.push(c);
    else top.replies.push(c);
  }
  for (const t of threads) t.place = places.get(t.id) ?? null;
  return threads;
}

/** Reads the threads, and the revision balloons when `withBalloons` (else keeps the last ones with their places). */
async function load(session, d, withBalloons) {
  const read = async (id) => (await Promise.resolve(session.query(id, {})).catch(() => null))?.value ?? [];
  const [list, balloons] = await Promise.all([read('review.comments'), withBalloons ? read('review.balloons') : null]);
  // ponytail: one caret call per thread and balloon on each change; batch them in the worker if a long list shows in the budget.
  const places = new Map();
  const place = async (key, pos) => {
    const at = await Promise.resolve(session.caret(pos)).catch(() => null);
    if (at) places.set(key, { page: at.page, y: at.y });
  };
  await Promise.all([...list.filter((c) => c.parent == null && c.anchor).map((c) => place(c.id, c.anchor)),
    ...(balloons ?? []).map((b, i) => place(`b${i}`, b.at))]);
  d.list = list;
  d.threads = threadsOf(list, places);
  // The revision balloons (stage2.md G43) share the cards' margin column: {id, kind, author, text, at, place}.
  if (balloons) d.balloons = balloons.map((b, i) => ({ ...b, id: `b${i}`, place: places.get(`b${i}`) ?? null }));
  // The active card is read when the cards draw (activeComment): a caret moved into a comment draws them again.
  publish(d, [d.list, d.threads, d.balloons, activeComment()]);
}

// Each session's threads {client, list, threads, balloons, version, fns, refresh}, held by the pages and the pane that draw them
// (canvas/records.js): its client is the record's own watcher, released with it.
const records = sessionRecords('comments', (session) => {
  const d = { client: session, list: [], threads: [], balloons: [], version: 0, fns: new Set(), busy: null, again: false, wantBalloons: false };
  const refresh = (withBalloons = true) => {
    d.again = true;
    d.wantBalloons ||= withBalloons;
    d.busy ??= (async () => {
      while (d.again && !d.gone) {
        const b = d.wantBalloons;
        d.again = false;
        d.wantBalloons = false;
        await load(session, d, b);
      }
      d.busy = null;
    })();
  };
  d.refresh = refresh;
  // The worker posts a layout and a selection after every key, so both read once typing pauses (stage2b.md rule 6: the threads
  // with a caret call each, and review.balloons walking every change, cost more than the 8 ms keystroke budget on the Word
  // fixture). A selection (a card action that moved the caret) reads the threads only. A command reads at once.
  const threads = () => refresh(false);
  session.on('layout', () => afterTyping(refresh));
  session.on('selection', (e) => {
    if (ui.found && JSON.stringify(e?.head?.story) !== JSON.stringify(ui.found.matches[0]?.start?.story)) setUi({ found: null });
    afterTyping(threads);
  });
  session.on('command', () => refresh());
  session.on('reopened', () => refresh());
  refresh();
  return d;
});

/** The threads of `session` (a SessionClient or a session id), re-rendering when they change → the doc record {client, threads,
 * list, version, refresh}. */
export function useThreads(session) {
  const d = records.use(session ? session.id ?? session : null);
  useSyncExternalStore((fn) => (d ? (d.fns.add(fn), () => d.fns.delete(fn)) : () => {}), () => d?.version ?? 0);
  return d;
}

/** The focused canvas draft's session, or null. */
const session = () => activeSurface()?.session ?? getState().focusedSession ?? null;

/** The thread an id belongs to (a reply's thread), in the focused session. */
function topOf(id) {
  const d = records.peek(session()?.id);
  return d?.threads.find((t) => t.id === id || t.replies.some((r) => r.id === id))?.id ?? id;
}

/** The comment at the selection (the innermost), from the registry's snapshot of document.context. */
export const commentAtSelection = () => ctxOf().engineState?.['document.context']?.value?.comments?.at(-1) ?? null;

/** The card the comment commands act on: the one being edited, else the one at the selection, else the one last clicked (a click
 * puts the caret at its anchor, so the selection's usually names it too). */
export const activeComment = () => ui.editing?.id ?? commentAtSelection() ?? ui.active;

/** The cards show beside the page (Show Comments on, contextual view) or as icons; the list view shows them in the pane. */
export const cardsMode = () => {
  const c = wordSettings(getState().settings).comments;
  return c.view === 'list' ? 'pane' : c.show === false ? 'icons' : 'cards';
};

/** Focuses the active card, else the first one: Alt+F12. */
function jumpToCard() {
  const id = activeComment();
  const el = (id != null && document.querySelector(`[data-canvas-comment="${id}"]`)) || document.querySelector('[data-canvas-comment]');
  if (!el) return false;
  el.focus();
  return true;
}

registerOverlay('comments', PageCards);

bindReviewApp({
  activeComment,
  editComment: (id, mode = 'edit', isNew = false) => {
    if (id == null) return false;
    const top = topOf(id);
    setUi({ active: top, opened: top, editing: { id: mode === 'reply' ? top : id, mode, isNew } });
    return true;
  },
  filter: () => ui.filter,
  setFilter: (filter) => setUi({ filter }),
  jumpToCard,
  shownComments: (list) => shownOf(list),
});

// The assistant's suggestions on a canvas draft (docs/plans/engine/stage2b.md decision 6, stage2b/assistant.md sections 5 and 6):
// the engine holds them as tracked changes by the assistant whose revisions carry the suggestion group (execAs's tag). This file
// reads them per session (review.changes, cards.mjs), places each card at its change (the host's caret at its start), keeps the
// active card, and accepts, rejects or shows cards through the engine. app/actions.js mirrors the open draft's cards into
// state.suggestions (the status bar slot, the keys, tool search, the drafts list), and comments/CanvasCards.jsx draws them in the
// margin column beside the comment cards and the revision balloons.
import { useSyncExternalStore } from 'react';
import { afterTyping, getState } from '../app/store.js';
import { areaViewports } from '../document/canvas/overlay.jsx';
import { sessionRecords } from '../document/canvas/records.js';
import { isCanvas } from '../engine/model/form.mjs';
import { kOf } from '../engine/view/camera.mjs';
import { worldOf } from '../engine/view/placements.mjs';
import { areaOpens } from '../tooling/surface.js';
import { cardAt, cardsOf } from './cards.mjs';

/** Whether `draft`'s suggestions are the engine's: a canvas draft, or the open draft while the canvas page area shows it. */
export function onEngine(draft) {
  const s = getState();
  return !!draft && (isCanvas(draft) || (draft.id === s.draft?.id && areaOpens(s)));
}

// Which cards the user edited since their first read (cards.mjs `seen`) outlives a record that is let go, so a card edited before
// the draft was left still asks before Reject. ponytail: one small map per draft with suggestions, for the window's life.
const seenOf = new Map(); // session id → its cards' first signatures

// Each session's cards {client, cards, seen, active, version, fns, refresh, busy, again}, held by the cards drawn in the margin and
// by actions.js while it mirrors the open draft's cards (canvas/records.js): its client is the record's own watcher, released
// with it, so a draft left behind keeps none (engine-fixes-2-edit).
const records = sessionRecords('suggestions', (client, id) => {
  if (!seenOf.has(id)) seenOf.set(id, new Map());
  const d = { client, cards: [], seen: seenOf.get(id), active: null, version: 0, fns: new Set(), busy: null, again: false };
  const refresh = () => {
    d.again = true;
    d.busy ??= (async () => {
      while (d.again && !d.gone) {
        d.again = false;
        await load(d);
      }
      d.busy = null;
    })();
    return d.busy;
  };
  d.refresh = refresh;
  // The worker posts a layout after every key: the list is read once typing pauses (review.changes walks every change, and each
  // card takes a caret call), and at once after a command or a reopen. A caret moved into a card makes it the active one.
  client.on('layout', () => afterTyping(refresh));
  client.on('command', refresh);
  client.on('reopened', refresh);
  client.on('selection', () => afterTyping(d.under ??= () => !d.gone && under(d)));
  refresh();
  return d;
});

/** `fn(d)` over session `id`'s record, held while it runs → what `fn` gives. */
async function held(id, fn) {
  const off = records.hold(id);
  try {
    return await fn(records.peek(id));
  } finally {
    off();
  }
}

const notify = (d) => {
  d.version++;
  for (const fn of d.fns) fn();
};

/** Reads the cards of `d`'s session and places them. A session no view holds keeps its last cards. */
async function load(d) {
  const list = (await Promise.resolve(d.client.query('review.changes', {})).catch(() => null))?.value;
  if (!Array.isArray(list)) return;
  const cards = cardsOf(list, d.seen);
  // Placed only while a page area shows the session: a caret call lays out, which a background session skips (quiet).
  // ponytail: one caret call per card on each change, as the comment cards; batch them in the worker if a long list shows.
  if (areaViewports(d.client.id).length) await Promise.all(cards.map(async (c) => {
    const at = await Promise.resolve(d.client.caret(c.start)).catch(() => null);
    c.place = at ? { page: at.page, y: at.y } : null;
  }));
  const active = d.active && !cards.some((c) => c.id === d.active) ? null : d.active;
  // The same cards read again after a key draw nothing again: the record keeps the ones it has (engine-main-thread-2).
  if (JSON.stringify([cards, active]) === JSON.stringify([d.cards, d.active])) return;
  d.cards = cards;
  d.active = active;
  notify(d);
}

/** The card under the caret becomes the active one when the caret moved into it. */
async function under(d) {
  const sel = await Promise.resolve(d.client.selection()).catch(() => null);
  const c = cardAt(d.cards, sel?.head);
  if (c && c.id !== d.active) {
    d.active = c.id;
    notify(d);
  }
}

/** Calls `fn` whenever session `id`'s cards or active card change, holding its record (and so its active card) meanwhile → a
 * function that stops it. */
export function watchCards(id, fn) {
  const off = records.hold(id);
  const d = records.peek(id);
  d.fns.add(fn);
  return () => {
    d.fns.delete(fn);
    off();
  };
}

/** Session `id`'s cards as last read, and its active card's id (none while nothing holds its record). */
export const cardsNow = (id) => records.peek(id)?.cards ?? [];
export const activeCard = (id) => records.peek(id)?.active ?? null;

/** Session `id`'s cards read now → the list (the last one when no view holds the session). */
export const freshCards = (id) => held(id, async (d) => (await d.refresh(), d.cards));

/** Makes card `cardId` (null: none) session `id`'s active one. The active card lives in the record, so it lasts only while
 * something holds that record: a draft nothing holds forgets it 2 s after the last hold (canvas/records.js). Every caller works
 * on the open draft, whose record actions.js's watchCards holds. */
export function setActiveCard(id, cardId) {
  const d = records.peek(id);
  if (!d || d.active === (cardId ?? null)) return;
  d.active = cardId ?? null;
  notify(d);
}

/** The cards of session `id` for a React component, re-rendering when they change → the record {client, cards, active}. */
export function useCards(id) {
  const d = records.use(id || null);
  useSyncExternalStore((fn) => (d ? (d.fns.add(fn), () => d.fns.delete(fn)) : () => {}), () => d?.version ?? 0);
  return d;
}

/** Accepts or rejects (`action`) cards `cards` of session `id` through the engine, the user's selection kept: review.resolve by
 * their revision ids, or with the document's Track Changes on an accept keeps them as tracked changes by their author out of
 * their group (review.resolve's `keep`), as the DOM editor's accept turns a suggestion into a revision. → whether the engine took it. */
export async function decideCards(id, cards, action) {
  const revs = cards.flatMap((c) => c.revs);
  if (!revs.length) return true;
  return held(id, (d) => decide(d, revs, action));
}

async function decide(d, revs, action) {
  const call = (cmd, args) => Promise.resolve(d.client.exec(cmd, args)).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  let r;
  if (action === 'accept') {
    const st = await Promise.resolve(d.client.state(['review.trackChanges'])).catch(() => null);
    r = await call('review.resolve', { accept: true, revs, ...(st?.['review.trackChanges']?.checked && { keep: true }) });
  } else r = await call('review.resolve', { accept: false, revs });
  if (!r?.ok) console.error('Suggestions: the engine refused the decision:', r?.error);
  await d.refresh();
  return !!r?.ok;
}

/** Selects card `c` of session `id` and centres it in the page area's view. */
export const showCard = (id, c) => held(id, (d) => show(d, id, c));

async function show(d, id, c) {
  setActiveCard(id, c.id);
  await Promise.resolve(d.client.select(c.start, c.end)).catch(() => null);
  const vp = areaViewports(id)[0];
  const at = vp && await Promise.resolve(d.client.caret(c.start)).catch(() => null);
  const w = at && worldOf(vp.placements, { session: id, surface: at.page, x: at.x, y: at.y });
  if (w) vp.setCamera({ y: Math.max(0, w.y + at.h / 2 - vp.size.h / kOf(vp.camera.zoom) / 2) });
  return true;
}

/** The caret of session `id` (its selection's head), or null. */
export const caretOf = (id) => held(id, async (d) => (await Promise.resolve(d.client.selection()).catch(() => null))?.head ?? null);

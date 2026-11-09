// The suggestion cards of a canvas draft (docs/plans/engine/stage2b.md decision 6, stage2b/assistant.md section 5): the
// assistant's edits are tracked changes in the engine whose revision carries a tag, the suggestion group (execAs). Each card is
// one change, a deletion that touches an insertion of the same group one 'replace' card, as the DOM editor's cards read. Pure, so
// node tests import it; canvas.js reads review.changes and places the cards.
import { q } from './core.mjs';

/** Two engine positions ({story, path, off}) in document order: by path, then offset (the engine's Pos order in one story). */
export function cmpPos(a, b) {
  const p = a?.path ?? [];
  const r = b?.path ?? [];
  for (let i = 0; i < Math.min(p.length, r.length); i++) if (p[i] !== r[i]) return p[i] - r[i];
  return p.length - r.length || (a?.off ?? 0) - (b?.off ?? 0);
}

const PAIR = new Set(['delete insert', 'insert delete']);

/** The row text of card `c`, in the DOM cards' words (core.mjs describe): Add “...”, Delete “...”, Replace “...” with “...”,
 * Format bold. */
export function rowText(c) {
  const has = (s) => !!String(s ?? '').trim();
  if (c.kind === 'insert') return has(c.words) ? `Add ${q(c.words)}` : 'Add empty line';
  if (c.kind === 'delete') return has(c.words) ? `Delete ${q(c.words)}` : 'Delete empty line';
  if (c.kind === 'replace') return `Replace ${q(c.old)} with ${q(c.words)}`;
  if (c.kind === 'format') {
    const d = String(c.description ?? '').replace(/^Formatted:?\s*/, '');
    return d ? `Format ${d[0].toLowerCase()}${d.slice(1)}` : 'Change formatting';
  }
  return `Move ${q(c.words)}`;
}

/** Card `c`'s words and how many runs hold them (`parts`): what a later read compares with its first. */
const sigOf = (c, parts) => JSON.stringify([c.old ?? '', c.words, parts.length]);

/** Whether the user changed card `c` since it was made: a change by someone else inside it (the user's tracked edit), or words or
 * runs other than at its first read (`seen`, key → signature, which this fills for a card it has not seen): text typed into it
 * untracked joins its words or splits its runs. */
// ponytail: `seen` lives as long as the window, so an edit made before a reload counts from the reload on; a signature kept in the
// revision would need a schema change.
function editedOf(c, parts, list, seen) {
  const sig = sigOf(c, parts);
  const was = seen?.get(c.key);
  if (seen && was == null) seen.set(c.key, sig);
  if (was != null && was !== sig) return true;
  return list.some((x) => x.author !== c.author && cmpPos(x.start, c.end) < 0 && cmpPos(x.end, c.start) > 0);
}

/**
 * review.changes entries `list` → the suggestion cards in document order: the changes whose revision has a `tag`, one per revision
 * (its runs in several paragraphs are one change), and a deletion that touches an insertion of the same group one 'replace' card.
 * `seen` (a Map kept between reads) lets each card say whether the user edited it since its first read.
 * → [{id ('r' and its first revision), key, revs, g, by, author, date, at (ms), kind, start, end, words, old?, description?, text,
 *    edited}]
 */
export function cardsOf(list, seen = null) {
  list = Array.isArray(list) ? list : [];
  const byRev = new Map();
  for (const c of list) {
    if (c?.tag == null || c.rev == null) continue;
    let x = byRev.get(c.rev);
    if (!x) {
      byRev.set(c.rev, (x = { rev: c.rev, g: c.tag, author: c.author ?? '', date: c.date ?? null, kind: c.kind, start: c.start, end: c.end,
        description: c.description, parts: [] }));
    }
    if (cmpPos(c.start, x.start) < 0) x.start = c.start;
    if (cmpPos(c.end, x.end) > 0) x.end = c.end;
    x.parts.push(c);
  }
  const changes = [...byRev.values()].sort((a, b) => cmpPos(a.start, b.start) || a.rev - b.rev);
  const cards = [];
  for (const x of changes) {
    x.parts.sort((a, b) => cmpPos(a.start, b.start));
    const words = x.parts.map((p) => p.text ?? '').join('');
    const kind = x.kind?.startsWith('move') ? 'move' : x.kind;
    const prev = cards.at(-1);
    if (prev && prev.revs.length === 1 && prev.g === x.g && PAIR.has(`${prev.kind} ${kind}`) && cmpPos(prev.end, x.start) === 0) {
      // Word writes a replaced word's deletion before its insertion, and the two make one decision.
      const del = prev.kind === 'delete';
      Object.assign(prev, { kind: 'replace', revs: [...prev.revs, x.rev], end: x.end, old: del ? prev.words : words, words: del ? words : prev.words,
        parts: [...prev.parts, ...x.parts], date: prev.date > x.date ? prev.date : x.date });
      continue;
    }
    cards.push({ id: `r${x.rev}`, revs: [x.rev], g: x.g, author: x.author, date: x.date, kind, start: x.start, end: x.end, words,
      description: x.description, parts: x.parts });
  }
  return cards.map(({ parts, ...c }) => {
    c.key = `${c.revs.join('+')}|${c.g}|${c.date}`;
    c.by = c.author === 'Assistant' ? 'agent:assistant' : `agent:${c.author || 'agent'}`;
    c.at = Date.parse(c.date ?? '') || 0;
    c.text = rowText(c);
    c.edited = editedOf(c, parts, list, seen);
    return c;
  });
}

/** The card of `cards` that holds engine position `pos` (its ends included), or undefined. */
export const cardAt = (cards, pos) => (pos ? cards.find((c) => cmpPos(c.start, pos) <= 0 && cmpPos(pos, c.end) <= 0) : undefined);

/** The cards `id` names: a card id, or a revision id ('r' and the number, or the number) of one of its revisions. */
export const cardOf = (cards, id) => cards.find((c) => c.id === id) ?? cards.find((c) => c.revs.some((r) => `r${r}` === String(id) || r === id));

/** The card Next (`dir` 1) or Previous (-1) goes to from the active card `active`, wrapping; from the caret `head` when none is. */
export function stepFrom(cards, active, head, dir) {
  if (!cards.length) return null;
  let i = cards.findIndex((c) => c.id === active);
  if (i < 0) {
    i = dir > 0 ? cards.findIndex((c) => cmpPos(c.start, head) >= 0) : cards.findLastIndex((c) => cmpPos(c.start, head) < 0);
    if (i < 0) i = dir > 0 ? 0 : cards.length - 1;
  } else i = (i + dir + cards.length) % cards.length;
  return cards[i];
}

/** Cards `cards` by group, in order of their first card: [{g, by, at, note, changes}] (core.mjs groups' shape). */
export function groupsOf(cards) {
  const m = new Map();
  for (const c of cards) {
    let g = m.get(c.g);
    if (!g) m.set(c.g, (g = { g: c.g, by: c.by, at: c.at, note: null, changes: [] }));
    g.at = Math.max(g.at, c.at);
    g.changes.push(c);
  }
  return [...m.values()];
}

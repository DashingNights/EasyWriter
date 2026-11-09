// bd-pagemove (docs/plans/board/briefs/bd-pagemove.md, design section 6): a page dropped where the reading order changes moves in
// the document. One `page.move` step in the draft's own session, then the board's slots for the pages as they are numbered now;
// the two are one entry of the board's undo. Only the dragged page moves: a page the user did not touch keeps its place in the
// document, however it reads on the board.
import { toast } from 'sonner';
import { boundsOf, keyedSlots, keysOf, readingOrder } from './sections.mjs';

/** The pages of a session's `pages()` answer (the array, or {pages}). */
const pagesOf = (r) => (Array.isArray(r) ? r : r?.pages ?? []);

/**
 * The `page.move` that a drop of page `page` asks of the document, or null for none: the page goes in front of the page that
 * now follows it in the reading order of `rects` (the dropped boxes, by current page index), or last when none does. Landing
 * where it already stands (in front of itself or of the page after it) is no move.
 */
export function moveOf(rects, page) {
  const order = readingOrder(rects);
  const before = order[order.indexOf(page) + 1] ?? rects.length;
  return before === page || before === page + 1 ? null : { from: page, before };
}

/** The page numbers after `move` of `n` pages: element k is the number the page now k-th had before. */
export function orderAfter(n, { from, before }) {
  const now = Array.from({ length: n }, (_, i) => i);
  now.splice(from, 1);
  now.splice(before > from ? before - 1 : before, 0, from);
  return now;
}

/**
 * Moves `item`'s page in its draft by `move` and stores the slots that keep every page where `rects` (the dropped boxes, by
 * page index before the move) put it. The draft refuses a move it cannot make (a table row, a section, a bookmark or a field
 * across a page): nothing changes, and the line it gives shows. → {ok: true}, or {ok: false, error}.
 */
export async function applyOrder(api, item, move, rects) {
  const refuse = (error) => {
    toast(error);
    return { ok: false, error };
  };
  const client = api.instances?.clientOf(item.draft);
  if (!client) return refuse('Open the document first, then move its pages.');
  let done;
  try {
    done = await client.execMany([['page.move', move]]);
  } catch (e) {
    return refuse(e?.message || 'The pages could not be moved.');
  }
  if (!done?.ok) return refuse(done?.error || 'The pages could not be moved.');
  // The keys after the move: a page cut at its edge gives the second half a new block, so the old keys do not name it.
  const [pages, steps] = await Promise.all([client.pages(), client.steps()]);
  const keys = keysOf(pagesOf(pages));
  // Every page keeps its own box, under its new number.
  const placed = orderAfter(rects.length, move).map((old) => rects[old]);
  const box = boundsOf(placed);
  const step = api.store.change('Move page', (tx) => {
    tx.patch(item.id, { x: box.x, y: box.y, w: box.w, h: box.h, slots: keyedSlots(placed, keys, box) });
  });
  if (step && steps?.undo != null) api.journal?.group([{ kind: 'doc', session: client.id, step: steps.undo }, { kind: 'board', step }]);
  return { ok: true };
}

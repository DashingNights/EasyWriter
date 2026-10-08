import { endSide } from '../assistant/attach.mjs';
import { rotatePoint, rotBox } from '../../flow/shapes.mjs';
import { defs as boardDefs, itemsOf, target } from './board.mjs';
import { define, fail } from './define.mjs';
import { DRAFT_ID, ITEM_ID, ref } from './schema-defs.mjs';

// Connector commands (SPEC §8 Catalogue): board.items.straighten, and the helpers flow.items.straighten shares (flow.mjs). The write
// goes through board.items.update's run, so it is that command's one undo step, routing and clamping.

const int = (v) => (typeof v === 'number' ? Math.round(v) : undefined);

/** The anchors that make boxes `A` and `B` ({x, y, w, h}; a free end is a box of size 0) face each other → [A's, B's]: when the
 * horizontal gap between them is larger than the vertical one, the left box's e and the right box's w; else the upper box's s
 * and the lower box's n (left, right, upper and lower by their centres). A gap is negative where the boxes overlap on that axis. */
export function facing(A, B) {
  const gx = Math.max(A.x, B.x) - Math.min(A.x + A.w, B.x + B.w);
  const gy = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
  if (gx > gy) return B.x + B.w / 2 >= A.x + A.w / 2 ? ['e', 'w'] : ['w', 'e'];
  return B.y + B.h / 2 >= A.y + A.h / 2 ? ['s', 'n'] : ['n', 's'];
}

/** The box an end of a connector sits on (`boxOf` of its item among `byId`), a free end's point as a box of size 0, or null (an
 * end on no item of the board, or on an item without a box). */
function endBox(e, byId, boxOf) {
  if (typeof e?.item !== 'string') return Number.isFinite(e?.x) && Number.isFinite(e?.y) ? { x: e.x, y: e.y, w: 0, h: 0 } : null;
  const it = byId.get(e.item);
  const b = it && boxOf(it);
  return b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : null;
}

/** The connector `id` of `items`, else not_found / invalid_args. */
export function connectorOf(items, id, where) {
  const c = items.find((i) => i.id === id) ?? fail('not_found', `No item has the id ${id} on that ${where}`, { ids: [id] });
  if (c.type !== 'connector') fail('invalid_args', `${id} is a ${c.type}, not an arrow`, { path: '/id', message: 'is not a connector', expected: {} });
  return c;
}

const NORMALS = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };

/** The anchor name of item `it` that sits on screen side `side`: a turned shape's anchors turn with it (rot, clockwise degrees). */
function unturned(side, it) {
  const n = rotatePoint(NORMALS[side], { x: 0, y: 0 }, -((it?.type === 'shape' && it.rot) || 0));
  return Math.abs(n.x) >= Math.abs(n.y) ? (n.x > 0 ? 'e' : 'w') : n.y > 0 ? 's' : 'n';
}

/** The patch that straightens connector `c` of `items`: route straight, no points, and each end on an item moved to the side
 * that faces the other end (facing; on a turned shape the anchor now on that side); a free end and an end on an item without a
 * box keep their anchors. Both ends on one item → invalid_args (a loop has no straight form). */
export function straightPatch(items, c, boxOf) {
  if (typeof c.from.item === 'string' && c.from.item === c.to.item) {
    fail('invalid_args', `Both ends of ${c.id} are on ${c.from.item}, so it has no straight form`, { path: '/id', message: 'joins an item to itself', expected: {} });
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const [A, B] = [endBox(c.from, byId, boxOf), endBox(c.to, byId, boxOf)];
  const patch = { route: 'straight', points: [] };
  if (!A || !B) return patch;
  const [a, b] = facing(A, B);
  if (typeof c.from.item === 'string') patch.from = { item: c.from.item, anchor: unturned(a, byId.get(c.from.item)) };
  if (typeof c.to.item === 'string') patch.to = { item: c.to.item, anchor: unturned(b, byId.get(c.to.item)) };
  return patch;
}

/** The ends of connector `c` (as stored, among `items`) for a result: an end on an item as that item's box and side, a free end
 * as its point. */
export function endBoxes(items, c, boxOf) {
  const end = (e) => {
    const it = typeof e?.item === 'string' && items.find((i) => i.id === e.item);
    if (!it) return { x: int(e?.x), y: int(e?.y) };
    const b = boxOf(it);
    return { id: it.id, x: int(b.x), y: int(b.y), w: int(b.w), h: int(b.h), side: endSide(e.anchor) };
  };
  return { from: end(c.from), to: end(c.to) };
}

const update = boardDefs.find((d) => d.id === 'board.items.update');

export const defs = [
  define({
    id: 'board.items.straighten',
    title: 'Straighten an arrow',
    // The orchestrator's brief, its colon a full stop after the title and two words shorter (MAX_SET); no itemPath for the same
    // reason (an arrow in a canvas item: board_items_update). ponytail: add itemPath when MAX_SET has room.
    brief: "Route straight, no bends, ends moved to the facing sides. Use it for 'straighten', 'tidy' or 'fix this arrow'. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.",
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open', 'node.board'],
    args: {
      type: 'object', required: ['path', 'id'], additionalProperties: false,
      properties: { path: ref('PATH', 'From board_list'), id: { ...ITEM_ID, description: 'Arrow id' }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['id', 'item', 'from', 'to'] },
    examples: [{ args: { path: [4], id: 'c81hd0q' } }],
    busy: (ctx, a) => ctx.lib.boardBusy(a.path),
    run: (ctx, a) => {
      const t = target(ctx, a.path);
      // As board.items.place: a whiteboard measures its text items; elsewhere a stored text height is used.
      const boxOf = t.kind === 'whiteboard' && t.wb ? (i) => t.wb.itemBox(i)
        : (i) => (i.type === 'shape' && i.rot ? rotBox(i) : { x: i.x, y: i.y, w: i.w, h: i.h ?? 0 });
      const patch = straightPatch(itemsOf(t), connectorOf(itemsOf(t), a.id, 'board'), boxOf);
      const out = update.run(ctx, { path: a.path, id: a.id, patch });
      return { ...out, ...endBoxes(itemsOf(target(ctx, a.path)), out.item, boxOf) };
    },
  }),
];

// Manual order of the Drafts list (SPEC §7): `order` is settings.draftOrder (draft ids), `map` is settings.draftFolders.
// No imports; inputs are never mutated.

/** The drafts in the saved order. Drafts not in `order` come first, in their given order; stale ids in `order` are ignored. */
export function sortDrafts(drafts, order = []) {
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (d) => rank.get(d.id) ?? -1;
  return [...drafts].sort((a, b) => at(a) - at(b));
}

/** `ids` with `id` moved to just before `target`, or just after it with `after`. */
export function moveBeside(ids, id, target, after = false) {
  const out = ids.filter((x) => x !== id);
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, id);
  return out;
}

/** A draft dropped just before / after the draft `target`: the ids of all drafts in the new order, and the folder map with
 * the draft in the folder of `target` (null: the top level). */
export function dropDraft(drafts, order, map, id, target, after) {
  return {
    order: moveBeside(sortDrafts(drafts, order).map((d) => d.id), id, target, after),
    map: { ...map, [id]: map[target] ?? null },
  };
}

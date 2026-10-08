// The shape list's layout (SPEC §6g, flowchart plan §3.10): Favourites, the registry groups and Prefabs, in the user's order.
// settings.shapeFavourites = [ref] (the Favourites section in order); settings.shapeOrder = {basic?, flow?, container?,
// prefabs?: [ref]} (written only once that section is reordered). ref = 'kind:<kind>' | 'prefab:<uuid>'. Pure; inputs are
// never mutated.
import { moveBeside, sortDrafts } from './draft-order.mjs';

export const SECTIONS = ['basic', 'flow', 'container', 'prefabs'];
export const kindRef = (kind) => `kind:${kind}`;
export const prefabRef = (id) => `prefab:${id}`;

const byCreated = (prefabs) => [...prefabs].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)); // newest first
const unique = (refs) => [...new Set(refs)];
// Each section's refs in their default order: registry order; prefabs newest first.
function groups(kinds, prefabs) {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, []]));
  for (const k of kinds) out[k.group]?.push(kindRef(k.kind));
  out.prefabs = byCreated(prefabs).map((p) => prefabRef(p.id));
  return out;
}
const sorted = (refs, order) => sortDrafts(refs.map((id) => ({ id })), order).map((d) => d.id);

/** Every ref that names a registry kind or a listed prefab. */
export const liveRefs = (kinds, prefabs) => new Set(Object.values(groups(kinds, prefabs)).flat());

/** → [{id, refs, all}]: 'favourites' (refs = the live favourites in order), then each section of SECTIONS without its
 * starred entries. `all` is a section's whole order, starred entries included (a move or an unstar keeps their place);
 * refs missing from a section's saved order come first (a new prefab shows at the top); unknown refs are skipped. */
export function shapeSections(kinds, prefabs, favs = [], order = {}) {
  const g = groups(kinds, prefabs);
  const live = new Set(Object.values(g).flat());
  const starred = unique(favs.filter((r) => live.has(r)));
  const out = [{ id: 'favourites', refs: starred, all: starred }];
  for (const id of SECTIONS) {
    const all = sorted(g[id], order[id]);
    out.push({ id, refs: all.filter((r) => !starred.includes(r)), all });
  }
  return out;
}

/** `favs` with `ref` added at the end, or removed. */
export const toggleFavourite = (favs, ref) => (favs.includes(ref) ? favs.filter((r) => r !== ref) : [...favs, ref]);

/** `list` with `ref` moved (or inserted) just before `target`, or just after it with `after`. */
export const moveRef = (list, ref, target, after = false) => moveBeside(list, ref, target, after);

/** `order` without its `section` array (back to the default order). */
export function resetOrder(order, section) {
  const { [section]: _, ...rest } = order;
  return rest;
}

/** Favourites in their default order (Reset order): registry order, then prefabs by `created`. */
export function defaultFavourites(favs, kinds, prefabs) {
  const rank = new Map([...kinds.map((k) => kindRef(k.kind)), ...[...prefabs].sort((a, b) => (a.created ?? 0) - (b.created ?? 0)).map((p) => prefabRef(p.id))]
    .map((r, i) => [r, i]));
  return favs.filter((r) => rank.has(r)).sort((a, b) => rank.get(a) - rank.get(b));
}

/** {favs, order} without refs that are not in the Set `live` (deleted prefabs, unknown kinds) or are repeated. */
export function cleanRefs(favs = [], order = {}, live) {
  const keep = (refs) => unique(refs.filter((r) => live.has(r)));
  return {
    favs: keep(favs),
    order: Object.fromEntries(Object.entries(order).filter(([s, refs]) => SECTIONS.includes(s) && Array.isArray(refs)).map(([s, refs]) => [s, keep(refs)])),
  };
}

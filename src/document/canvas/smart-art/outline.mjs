// The outline edits of a diagram (Add Shape, Add Bullet, Move Before/After, Promote/Demote, the Text Pane's keys): pure, on the
// outline object.get gives, so node tests load it. Every function takes `items` and the picked index `i` (or null) and gives
// {items, at}, the new list and the item to pick, or null when the edit cannot be done.

export const MAX_ITEMS = 100; // ew_doc smart_art.rs
export const MAX_LEVEL = 7;

/** The index after item `i` and the items under it. */
export const blockEnd = (items, i) => {
  let e = i + 1;
  while (e < items.length && items[e].level > items[i].level) e += 1;
  return e;
};
const blank = (level) => ({ text: '', level });
const put = (items, at, it) => [...items.slice(0, at), it, ...items.slice(at)];
const room = (items) => items.length < MAX_ITEMS;

/** Add Shape After: after the item and everything under it, at its level. Nothing picked: the end. */
export function addAfter(items, i) {
  if (!room(items)) return null;
  if (i == null) return { items: [...items, blank(0)], at: items.length };
  const at = blockEnd(items, i);
  return { items: put(items, at, blank(items[i].level)), at };
}
/** Add Shape Before: just before the item, at its level. Nothing picked: the start. */
export function addBefore(items, i) {
  if (!room(items)) return null;
  if (i == null) return { items: [blank(0), ...items], at: 0 };
  return { items: put(items, i, blank(items[i].level)), at: i };
}
/** Add Shape Above: a new item in this one's place, with this one and everything under it one level below it. */
export function addAbove(items, i) {
  if (!room(items) || i == null) return null;
  const end = blockEnd(items, i);
  const block = items.slice(i, end);
  if (block.some((it) => it.level >= MAX_LEVEL)) return null;
  return { items: [...items.slice(0, i), blank(items[i].level), ...block.map((it) => ({ ...it, level: it.level + 1 })), ...items.slice(end)], at: i };
}
/** Add Shape Below and Add Bullet: a last child of the item. */
export function addBelow(items, i) {
  if (!room(items) || i == null || items[i].level >= MAX_LEVEL) return null;
  const at = blockEnd(items, i);
  return { items: put(items, at, blank(items[i].level + 1)), at };
}
/** Move Before: swaps the item's block with the sibling block before it. */
export function moveBefore(items, i) {
  if (i == null) return null;
  const l = items[i].level;
  let p = i - 1;
  while (p >= 0 && items[p].level > l) p -= 1;
  if (p < 0 || items[p].level < l) return null;
  const end = blockEnd(items, i);
  return { items: [...items.slice(0, p), ...items.slice(i, end), ...items.slice(p, i), ...items.slice(end)], at: p };
}
/** Move After: swaps the item's block with the sibling block after it. */
export function moveAfter(items, i) {
  if (i == null) return null;
  const end = blockEnd(items, i);
  if (end >= items.length || items[end].level !== items[i].level) return null;
  const next = blockEnd(items, end);
  return { items: [...items.slice(0, i), ...items.slice(end, next), ...items.slice(i, end), ...items.slice(next)], at: i + next - end };
}
/** Removes one row. Its children stay. The last item stays. */
export function removeItem(items, i) {
  if (items.length < 2 || i == null) return null;
  return { items: items.filter((_, j) => j !== i), at: Math.max(0, i - 1) };
}
/**
 * The Text Pane's draft `{i, text}` written into `items` through `write(items)` (the engine's smartArt.items) → {items, failed}.
 * `items` is null when there is nothing to write (the text is the item's already); `failed` says the engine refused, and the
 * pane keeps the draft then, so what was typed is never lost.
 */
export async function commitText(items, draft, write) {
  const it = items[draft.i];
  if (!it || it.text === draft.text) return { items: null, failed: false };
  const next = items.map((x, k) => (k === draft.i ? { ...x, text: draft.text } : x));
  const ok = await write(next).then((r) => !!r?.ok, () => false);
  return ok ? { items: next, failed: false } : { items: null, failed: true };
}
/** Promote is possible: the item is below the top level. */
export const canPromote = (items, i) => i != null && items[i].level > 0;
/** Demote is possible: the item before it is at its level or deeper, and nothing goes past the deepest level. */
export const canDemote = (items, i) => i != null && i > 0 && items[i - 1].level >= items[i].level
  && !items.slice(i, blockEnd(items, i)).some((it) => it.level >= MAX_LEVEL);

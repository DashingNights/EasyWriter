// View > Split: where the page area is split, as the top pane's share of its height, or null. It lasts while the page area does.
let at = null;
const fns = new Set();
export const splitAt = () => at;
export function setSplit(v) {
  at = v == null ? null : Math.min(0.9, Math.max(0.1, v));
  for (const fn of fns) fn();
}
export const onSplit = (fn) => (fns.add(fn), () => fns.delete(fn));
/** Whether store view `view` and page movement `move` can split: Print Layout, Web Layout, Outline and Draft, moving vertically. */
export const canSplit = (view, move) => ['print', 'web', 'outline', 'draft'].includes(view ?? 'print') && (!move?.kind || move.kind === 'vertical');

// The setup's page order (docs/plans/onboarding.md Pages), pure for the node tests. `list` is the pages shown now, in order:
// [{id, step, branch}]. `step` groups a page with the ones it belongs to (the GitHub sub-pages count as one step); a `branch`
// page is reached only by name (next(id)), never by going on or back in order.

/** `id` when it is in `list`, else the first page (a saved page whose integration is off now, or an unknown one). */
export const resumeAt = (list, id) => (list.some((p) => p.id === id) ? id : list[0].id);

const indexOf = (list, id) => list.findIndex((p) => p.id === id);

/** The page after `id` in order, skipping branch pages; null after the last. */
export const after = (list, id) => list.slice(indexOf(list, id) + 1).find((p) => !p.branch)?.id ?? null;

/** The page before `id` in order, skipping branch pages; null before the first. */
export const before = (list, id) => list.slice(0, Math.max(0, indexOf(list, id))).findLast((p) => !p.branch)?.id ?? null;

/** The first page after the step `id` belongs to (Skip backup leaves the GitHub sub-pages); null after the last. */
export function leave(list, id) {
  const step = list[indexOf(list, id)]?.step;
  return list.slice(indexOf(list, id) + 1).find((p) => p.step !== step && !p.branch)?.id ?? null;
}

/** "Step n of m" for page `id`: its step's place among the steps of `list`. */
export function stepLabel(list, id) {
  const steps = [...new Set(list.map((p) => p.step))];
  return `Step ${steps.indexOf(list[indexOf(list, id)]?.step) + 1} of ${steps.length}`;
}

/** The setup's own zoom label: Chromium's level `level` (main.js zoomLevel, -3 to 5) in percent of the computer's scale. */
export const scalePercent = (level) => Math.round(1.2 ** level * 100);

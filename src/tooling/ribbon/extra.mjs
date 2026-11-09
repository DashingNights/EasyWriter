// Controls a spec lacks that the Quick Access Toolbar may show (New, Open, Quick Print...), added by their owner at import.
// Its own module with no imports, so an owner can add to it while the renderer's imports are still loading.

/** Control by id (plan.md §1.4 Control). */
export const EXTRA = {};

/** Adds controls the Quick Access Toolbar can show beside the spec's. */
export function addControls(map) {
  Object.assign(EXTRA, map);
}

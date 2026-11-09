// Which tabs the ribbon shows and which one is active (docs/plans/word/plan.md §1.4 Contexts): a spec's CONTEXTS evaluated
// from the command context's `in` flags (the registry computes them), with layout.mjs's visibleTabs and nextTab rules. The
// active tab lives in the store (word.tab), so showRibbonTab, the tutorial and harness cases can set it.
import { useEffect, useRef } from 'react';
import { getState, setState, useStore } from '../../app/store.js';
import { nextTab, visibleTabs } from './layout.mjs';

/** Merges `patch` into the store's word object (§1.12 store fields). */
export const setWord = (patch) => setState((s) => ({ word: { ...s.word, ...patch } }));

// The last main tab picked: a contextual tab that goes away gives way to it (Word returns there, not to Home).
let lastMain = 'home';

/** Shows tab `id` (the renderer, showRibbonTab); a main tab becomes the one a contextual tab returns to. */
export function pickTab(spec, id) {
  if (spec.TABS.some((t) => t.id === id && !t.context)) lastMain = id;
  if (getState().word?.tab !== id) setWord({ tab: id });
}

/** The held contexts of `spec` for command context `ctx`: {key: true} for each CONTEXTS key whose flag ctx.in sets. */
export const heldOf = (spec, ctx) => Object.fromEntries(Object.keys(spec.CONTEXTS ?? {}).filter((k) => ctx?.in?.[k]).map((k) => [k, true]));

/** The ribbon's tabs and the active one for `ctx`: {tabs, tab}. `show`: hidden tab ids to show (Developer). A context that
 * starts holding with `activate` brings its tab forward once; a tab that goes away returns the ribbon to the last main tab. */
export function useRibbonTabs(spec, ctx, show) {
  const stored = useStore((s) => s.word?.tab ?? 'home');
  const held = heldOf(spec, ctx);
  const before = useRef({});
  const tabs = visibleTabs(spec, held, show);
  const tab = nextTab(spec, { current: stored, tabs, before: before.current, held, lastMain });
  const key = Object.keys(held).join(' ');
  useEffect(() => {
    before.current = held;
    if (tab && tab !== stored) setWord({ tab });
  }, [key, tab, stored]); // eslint-disable-line react-hooks/exhaustive-deps
  return { tabs, tab };
}

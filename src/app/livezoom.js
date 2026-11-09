// The zoom shown while a zoom is previewed (a Ctrl+wheel burst or the zoom slider dragged, panzoom.js): the readouts follow it
// without a store update per step, which would re-render every Word control (registry ctxOf); null once the real zoom lands.
import { useSyncExternalStore } from 'react';

let pct = null;
const subs = new Set();

export function setLiveZoom(p) {
  pct = p;
  for (const fn of subs) fn();
}

/** The previewed zoom in percent, or null when none is previewed. */
export const useLiveZoom = () => useSyncExternalStore((fn) => (subs.add(fn), () => subs.delete(fn)), () => pct);

// Word's zoom slider scale (index-layout.md Status bar): the left half covers 10 to 100 percent and the right half 100 to 500, so
// 100 sits on the centre mark. Pure: the status bar and its node test read it.

export const MIN = 10;
export const MAX = 500;
export const STEP = 10; // the minus and plus buttons

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Slider position `p` (0 to 1) → zoom percent, rounded to a whole percent. */
export function posToPct(p) {
  const x = clamp(Number(p) || 0, 0, 1);
  return Math.round(x <= 0.5 ? MIN + (x / 0.5) * (100 - MIN) : 100 + ((x - 0.5) / 0.5) * (MAX - 100));
}

/** Zoom percent `pct` → slider position (0 to 1). */
export function pctToPos(pct) {
  const v = clamp(Number(pct) || 100, MIN, MAX);
  return v <= 100 ? ((v - MIN) / (100 - MIN)) * 0.5 : 0.5 + ((v - 100) / (MAX - 100)) * 0.5;
}

/** The zoom after a minus (`dir` -1) or plus (+1) press at `pct`: the next step of 10 from the rounded zoom, within 10 to 500. */
export const stepZoom = (pct, dir) => clamp(Math.round(pct / STEP) * STEP + dir * STEP, MIN, MAX);

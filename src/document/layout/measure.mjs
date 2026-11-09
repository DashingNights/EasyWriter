// The layout predictor's text measurer: canvas measureText (an OffscreenCanvas in the worker), cached per font and string for the
// worker's life, so a relayout after an edit measures only the words it has not seen. stats.ms sums the time in uncached
// measureText calls, so a run can tell the browser's shaping from the engine's own work.
// ponytail: the cache never evicts; an LRU per font if a long session's memory shows it.

/** `text` with a zero-width non-joiner between letters, so canvas shaping forms no ligature: the editor turns ligatures off
 * (TipTap's stylesheet: font-variant-ligatures none) and canvas has no such switch. */
export const noLigatures = (text) => (text.length > 1 && /[A-Za-z]{2}/.test(text) ? text.replace(/(?<=[A-Za-z])(?=[A-Za-z])/g, '‌') : text);

/** A measurer over 2D context `g` → {width(font, text, kern) px, metrics(font) → {asc, desc, ascU, descU} px, stats}. `ligatures`:
 * false measures as the editor draws (noLigatures), true as canvas shapes. */
export function makeMeasurer(g, { ligatures = false } = {}) {
  const fonts = new Map(); // canvas font → {w: Map(text → px), m: metrics}
  const stats = { calls: 0, hits: 0, ms: 0, fonts: 0 };
  // Word kerns only runs with w:kern at or above its size, and the editor's text follows (font/style.css), but canvas kerns by default.
  g.fontKerning = 'none';
  let cur = null;
  // A worker's canvas keeps the face it first found for a font string even after self.fonts gains a better one (Chromium 152:
  // "Carlito" measured before its face loaded stays the fallback), so after clear() each font string ends in a family no computer
  // has, which changes no glyph but makes the string new.
  let gen = 0;
  const entry = (font) => {
    let f = fonts.get(font);
    if (!f) {
      fonts.set(font, (f = { w: new Map(), m: null }));
      stats.fonts++;
    }
    return f;
  };
  const use = (font) => {
    if (cur !== font) g.font = gen ? `${(cur = font)}, "fv${gen}"` : (cur = font);
  };
  return {
    stats,
    /** Forgets every width and metric: a font finished loading, so the same font string may draw another face now. */
    clear() {
      fonts.clear();
      cur = null;
      gen++;
    },
    width(font, text, kern = false) {
      const f = entry(kern ? `${font}|kern` : font);
      const hit = f.w.get(text);
      if (hit !== undefined) {
        stats.hits++;
        return hit;
      }
      const t0 = performance.now();
      use(font);
      if (kern) g.fontKerning = 'normal';
      const w = g.measureText(ligatures ? text : noLigatures(text)).width;
      if (kern) g.fontKerning = 'none';
      stats.ms += performance.now() - t0;
      stats.calls++;
      f.w.set(text, w);
      return w;
    },
    // asc and desc as the browser lays text out (canvas gives whole pixels at text sizes, as Chrome's layout rounds a font's
    // ascent and descent); ascU and descU from the font at 1000 px, scaled: its own metrics, as Word's line rule takes them.
    metrics(font) {
      const f = entry(font);
      if (!f.m) {
        use(font);
        const r = g.measureText(' ');
        const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 0);
        let ascU = r.fontBoundingBoxAscent;
        let descU = r.fontBoundingBoxDescent;
        if (size > 0) {
          use(font.replace(/[\d.]+px/, '1000px'));
          const big = g.measureText(' ');
          ascU = (big.fontBoundingBoxAscent * size) / 1000;
          descU = (big.fontBoundingBoxDescent * size) / 1000;
        }
        f.m = { asc: r.fontBoundingBoxAscent, desc: r.fontBoundingBoxDescent, ascU, descU };
      }
      return f.m;
    },
  };
}

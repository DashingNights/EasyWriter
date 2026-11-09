// Pure helpers for input-method compositions in the canvas editor (briefs/engine-input.md): the composition's characters, their
// boxes and the underlines drawn from EditContext's format ranges. Boxes are in page points ({page, x, y, w, h}), as the engine's
// rects() gives them. No DOM here, so the Node tests load it.

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `text` split into what a reader calls characters (grapheme clusters: 𠮷 or 👍🏽 is one). */
export const graphemes = (text) => Array.from(segmenter.segment(text), (s) => s.segment);

/** Whether engine positions `a` and `b` are the same. Positions are opaque JSON values, so this compares their JSON. */
export const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One box per UTF-16 unit of `text` (EditContext counts in those) from `boxes`, one per grapheme: every unit of a grapheme
 * gets its grapheme's box. */
export function unitBoxes(text, boxes) {
  const out = [];
  graphemes(text).forEach((g, i) => {
    for (let k = 0; k < g.length; k++) out.push(boxes[i] ?? null);
  });
  return out;
}

const STYLES = new Set(['solid', 'dotted', 'dashed', 'wavy']);

/** The underlines of a composition of `length` UTF-16 units: per format range (EditContext's TextFormat: rangeStart, rangeEnd,
 * underlineStyle, underlineThickness) one underline per line it covers, from `boxes` (one per unit) → [{page, x, y, w, thick,
 * style}] with y at the boxes' bottom. No formats (the textarea fallback, or an input method that sends none) underline the
 * whole composition thin and solid, as Windows does. */
export function underlines(boxes, formats, length) {
  const list = formats?.length ? formats : [{ rangeStart: 0, rangeEnd: length, underlineStyle: 'solid', underlineThickness: 'thin' }];
  const out = [];
  for (const f of list) {
    const style = String(f.underlineStyle ?? 'solid').toLowerCase();
    if (!STYLES.has(style)) continue; // 'none'
    let line = null;
    for (let i = Math.max(0, f.rangeStart); i < Math.min(f.rangeEnd, boxes.length); i++) {
      const b = boxes[i];
      if (!b) continue;
      if (line && line.page === b.page && Math.abs(line.top - b.y) < 0.5) {
        const right = Math.max(line.x + line.w, b.x + b.w);
        line.x = Math.min(line.x, b.x);
        line.w = right - line.x;
        line.y = Math.max(line.y, b.y + b.h);
        continue;
      }
      line = { page: b.page, x: b.x, y: b.y + b.h, w: b.w, top: b.y, thick: String(f.underlineThickness).toLowerCase() === 'thick', style };
      out.push(line);
    }
  }
  return out.map(({ top, ...u }) => u);
}

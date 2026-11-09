// Style resolution, the pure part of stylesheet.js (which re-exports these): a style with its basedOn chain merged, and the run
// properties a character style draws. Pure, so the layout predictor's worker (src/document/layout) and node tests share it with
// the editor's stylesheet instead of keeping copies.
import { linkedParaOf, v2 } from '../wp/styles/model.mjs';

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] ? merge(out[k], v) : v;
  return out;
};

/** Style `id` of `list` with its basedOn chain merged in (the nearest wins). Each style's v1 key names read as v2 before the
 * merge (plan.md §1.6: align is textAlign, border is borders, charSpacing is spacing), so a Modify Style that wrote textAlign on
 * Normal still loses to Quote's v1 align. para.align mirrors the result for readers written before v2 (schema.js effectiveProps). */
export function resolved(list, id, seen = new Set()) {
  const s = list[id];
  if (!s || seen.has(id)) return {};
  seen.add(id);
  const out = merge(s.basedOn ? resolved(list, s.basedOn, seen) : {}, v2(s));
  if (out.para?.textAlign != null) out.para = { ...out.para, align: out.para.textAlign }; // a copy: out.para may be the stored object
  return out;
}

const all = new WeakMap(); // styles attribute → {[id]: resolved style}

/** Every style of a `styles` attribute resolved (resolved above), memoised per attribute identity, so the gallery's previews
 * cost one pass per style change. */
export function resolvedAll(styles) {
  if (!styles) return {};
  if (!all.has(styles)) {
    const list = styles.list ?? {};
    all.set(styles, Object.fromEntries(Object.keys(list).map((id) => [id, resolved(list, id)])));
  }
  return all.get(styles);
}

/** The run properties character style `id` of `list` draws: a linked style's character half takes its paragraph style's
 * (Word keeps one definition for both halves; older documents pair Heading1Char with Heading1 by id), any other its own chain's. */
export function charRun(list, id) {
  const pid = linkedParaOf(list, id);
  return pid ? { ...resolved(list, pid).run } : resolved(list, id).run;
}

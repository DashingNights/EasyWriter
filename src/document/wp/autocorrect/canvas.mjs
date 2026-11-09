// AutoFormat Now on a canvas draft (docs/plans/engine/stage2/gaps.md autocorrect): the same plan as the DOM editor's (rules.mjs
// autoFormatPlan) from the engine's paragraphs (text.paragraphs), turned into text.applyEdits' edits. The engine counts offsets in
// UTF-8 bytes, the plan in UTF-16 units. Pure: node tests load it.
import { autoFormatPlan } from './rules.mjs';

/** The UTF-8 byte offset of every UTF-16 index of `text`, and of its end. */
export function byteOffsets(text) {
  const out = new Array(text.length + 1);
  let b = 0;
  for (let i = 0; i < text.length; i++) {
    out[i] = b;
    const c = text.charCodeAt(i);
    // A surrogate pair is 4 bytes, counted at its first half.
    b += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3;
  }
  out[text.length] = b;
  return out;
}

/** An edit's mark → text.applyEdits' form, or undefined. */
const markOf = (m) => (!m ? undefined : m.type === 'link' ? { link: m.attrs?.href } : m.type);

/** AutoFormat Now's edits for the engine's paragraphs `paras` ([{path, text, styled, list, inTable}]) with AutoFormat options
 * `now` → {edits: [{path, from, to, insert?, mark?}], headings: [{path, level}]}. */
// ponytail: the engine's paragraphs do not say which text is a link already, so an address that is one is linked again (to the
// same address); text.paragraphs could list link ranges if that ever matters.
export function canvasPlan(paras, now) {
  const blocks = paras.map((p) => ({ text: p.text, linked: () => false, styled: p.styled, list: p.list, inTable: p.inTable }));
  const plan = autoFormatPlan(blocks, now);
  const edits = [];
  const headings = [];
  plan.forEach((p, i) => {
    const { path, text } = paras[i];
    const at = p.edits.length ? byteOffsets(text) : null;
    for (const e of p.edits) {
      edits.push({ path, from: at[e.from], to: at[e.to], ...(e.insert != null ? { insert: e.insert } : {}), ...(e.mark ? { mark: markOf(e.mark) } : {}) });
    }
    if (p.heading) headings.push({ path, level: p.heading });
  });
  return { edits, headings };
}

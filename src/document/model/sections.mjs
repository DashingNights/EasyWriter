// A Document's sections (docs/plans/word/plan.md §1.8 sect v2). Word stores a section's properties at its end: each sectionBreak
// node holds the sect of the section it ends, and doc.attrs.sect holds the last section's. Pure: pagination, geometry, the
// registry's ctx and node tests read it.
import { defaultSect } from '../defaults.mjs';

/** The sect v2 keys and their defaults; the v1 keys (w, h, orient, margin, pageNumber) come from the sect itself or defaultSect. */
export const SECT_DEFAULTS = Object.freeze({
  type: 'nextPage',
  pgNum: Object.freeze({ fmt: 'decimal', start: null, chapStyle: null, chapSep: 'hyphen' }),
  titlePg: false,
  hdr: null,
  ftr: null,
  vAlign: 'top',
  lnNum: null,
  pgBorders: null,
  textDir: 'lrTb',
  footnotePr: null,
  endnotePr: null,
  noEndnote: false,
  docGrid: null,
  paperSrc: null,
  bidi: false,
  watermark: null,
  formProt: false,
});

/** `sect` with every missing key filled from SECT_DEFAULTS and defaultSect (pgNum key by key); unknown keys are kept. */
export const withDefaults = (sect) => {
  const s = sect ?? defaultSect();
  return { ...defaultSect(), ...SECT_DEFAULTS, ...s, pgNum: { ...SECT_DEFAULTS.pgNum, ...s.pgNum } };
};

const memo = new WeakMap();

/** The sections of `doc` in order → [{index, from, to, sect (defaults filled), holder (pos of its sectionBreak, null for the last)}].
 * A section runs from the end of the previous break to the end of its own break, so the break belongs to the section it ends.
 * A break whose sect is null (in transit, §1.8) takes the following section's. Memoised per doc. */
export function sectionsOf(doc) {
  let out = memo.get(doc);
  if (out) return out;
  const breaks = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'sectionBreak') breaks.push({ pos, end: pos + node.nodeSize, sect: node.attrs.sect ?? null });
    return !node.isTextblock && !node.isAtom; // breaks sit between blocks, never inside text
  });
  const raw = [...breaks.map((b) => b.sect), doc.attrs.sect ?? null];
  for (let i = raw.length - 2; i >= 0; i--) raw[i] ??= raw[i + 1];
  out = raw.map((sect, i) => ({
    index: i,
    from: i ? breaks[i - 1].end : 0,
    to: i < breaks.length ? breaks[i].end : doc.content.size,
    sect: withDefaults(sect),
    holder: i < breaks.length ? breaks[i].pos : null,
  }));
  memo.set(doc, out);
  return out;
}

/** The section in `sections` (sectionsOf, or a geometry's SectionBox list) holding `pos`: the last one for the end of the document. */
export const sectionAt = (sections, pos) => sections.find((s) => pos < s.to) ?? sections.at(-1);

/** The section of `doc` holding `pos` (the last one for the end of the document). */
export const sectionOf = (doc, pos) => sectionAt(sectionsOf(doc), pos);

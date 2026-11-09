// Formatting marks, the pure part (docs/plans/word/briefs/marks.md): which kinds show for the Word settings, Word's glyphs and
// break labels, the characters to mark inside a range, and the crop mark and text boundary geometry of a page. No DOM here, so
// test/word-marks.test.mjs loads it.

/** The kinds Options > Display can always show, in data-marks order (plan.md §1.12). */
export const KINDS = ['tabs', 'spaces', 'paragraphs', 'hidden', 'optionalHyphens', 'anchors'];

/** The kinds shown for `word` (wordSettings): every kind plus 'all' while Show All is on, else the always-show boxes ticked. */
export function kindsOf(word) {
  const m = word?.marks ?? {};
  return m.all ? [...KINDS, 'all'] : KINDS.filter((k) => m[k]);
}

/** The data-marks value for `word`: the kinds space-separated, or null when none shows (the attribute is then absent). */
export const marksAttr = (word) => kindsOf(word).join(' ') || null;

/** Word's mark glyphs (index-editing.md "Formatting marks"). */
export const GLYPH = {
  space: '·', // raised centre dot
  nbsp: '°', // small raised circle
  tab: '→',
  tabRtl: '←',
  para: '¶',
  paraRtl: '⁋', // reversed pilcrow: the mark of a right-to-left paragraph
  lineBreak: '↵',
  optionalHyphen: '¬',
  cell: '¤', // end of cell and end of row
};

/** The ¶ of a paragraph: mirrored when it runs right to left, the end-of-cell mark when it is a cell's last paragraph. */
export const paraGlyph = ({ rtl = false, cellEnd = false } = {}) => (cellEnd ? GLYPH.cell : rtl ? GLYPH.paraRtl : GLYPH.para);

/** The tab arrow, pointing the way the text runs. */
export const tabGlyph = (rtl = false) => (rtl ? GLYPH.tabRtl : GLYPH.tab);

/** Word's functional names for the break marks, kept as Word writes them. */
export const SECTION_LABEL = {
  nextPage: 'Section Break (Next Page)',
  continuous: 'Section Break (Continuous)',
  evenPage: 'Section Break (Even Page)',
  oddPage: 'Section Break (Odd Page)',
  nextColumn: 'Section Break (New Column)',
};

/** The label of a break node by its type name and attributes, or null for anything else. */
export function breakLabel(type, attrs = {}) {
  if (type === 'pageBreak') return 'Page Break';
  if (type === 'columnBreak') return 'Column Break';
  if (type === 'sectionBreak') return SECTION_LABEL[attrs.kind] ?? SECTION_LABEL.nextPage;
  return null;
}

/** The inline characters marks draw over, by the kind that shows them. */
const CHARS = { ' ': ['space', 'spaces'], ' ': ['nbsp', 'spaces'], '­': ['optionalHyphen', 'optionalHyphens'] };

/** The marked characters of `text` (starting at document position `at`) that fall inside [from, to) and whose kind is in
 * `shown` (a Set) → [{pos, glyph}] where glyph is a GLYPH key. */
export function charsIn(text, at, from, to, shown) {
  const out = [];
  const start = Math.max(0, from - at);
  const end = Math.min(text.length, to - at);
  for (let i = start; i < end; i++) {
    const c = CHARS[text[i]];
    if (c && shown.has(c[1])) out.push({ pos: at + i, glyph: c[0] });
  }
  return out;
}

/** Crop marks of a page from its PageBox `box` (px): at each corner of the text area, one horizontal and one vertical line of
 * `len` px reaching out into the margins, Word's "corner" marks → [{x1, y1, x2, y2}] in paper px. */
export function cropLines(box, len = 24) {
  const l = box.left;
  const t = box.top;
  const r = box.w - box.right;
  const b = box.h - box.bottom;
  return [[l, t, -1, -1], [r, t, 1, -1], [l, b, -1, 1], [r, b, 1, 1]].flatMap(([x, y, dx, dy]) => [
    { x1: x, y1: y, x2: x + dx * len, y2: y },
    { x1: x, y1: y, x2: x, y2: y + dy * len },
  ]);
}

/** The text boundary of a page: the text area's rectangle in paper px → {left, top, width, height}. */
export const boundaryRect = (box) => ({ left: box.left, top: box.top, width: box.w - box.left - box.right, height: box.h - box.top - box.bottom });

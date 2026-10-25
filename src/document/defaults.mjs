// What a new Document starts with (docs/plans/document.md Document-level data, Fonts and paper): docDefaults, the built-in
// styles, the theme and the list definitions, transcribed from a blank document saved by Word 16.0.20527 (its styles.xml,
// theme1.xml and sectPr). Each new Document gets its own copy in doc.attrs, as Word copies styles.xml into every file, so a later
// change here never changes how an existing document looks. Pure: formats.mjs and Node tests read it.
import { PAPER_SIZES } from '../office.mjs';

/** docDefaults: the theme's body font at 12 pt, 8 pt after, line 278/240 (Word's "1.15"). */
export const DOC_DEFAULTS = {
  run: { font: '+minor', size: 12 },
  para: { spacing: { after: 8, line: { rule: 'auto', value: 1.1583 } } },
};

/** The default theme (theme1.xml "Office", named 'Default' here). */
export const THEME = {
  name: 'Default',
  fonts: { major: 'Aptos Display', minor: 'Aptos' },
  colors: {
    dk1: '#000000', lt1: '#FFFFFF', dk2: '#0E2841', lt2: '#E8E8E8', accent1: '#156082', accent2: '#E97132', accent3: '#196B24',
    accent4: '#0F9ED5', accent5: '#A02B93', accent6: '#4EA72E', hlink: '#467886', folHlink: '#96607D',
  },
};

// Colours of the probe's styles, with their theme links (themeShade BF is lum -0.25; themeTint A6, BF and D8 are 0.35, 0.25, 0.15).
const ACCENT1_DARK = { color: '#0F4761', themeColor: { slot: 'accent1', lum: -0.25 } };
const TEXT1_35 = { color: '#595959', themeColor: { slot: 'dk1', lum: 0.35 } };
const TEXT1_25 = { color: '#404040', themeColor: { slot: 'dk1', lum: 0.25 } };
const TEXT1_15 = { color: '#272727', themeColor: { slot: 'dk1', lum: 0.15 } };

const heading = (n, para, run) => ({
  type: 'paragraph', name: `heading ${n}`, basedOn: 'Normal', next: 'Normal',
  para: { keepNext: true, keepLines: true, outline: n - 1, ...para },
  run: { font: n <= 2 ? '+major' : undefined, ...run },
});
const border = { style: 'single', width: 0.5, space: 10, ...ACCENT1_DARK };

/** styles.xml: {[styleId]: {type, name, basedOn?, next?, run?, para?}}. Lengths in points. Heading 1-6 belong to heading nodes
 * (an implied styleId HeadingN); the rest to a paragraph's styleId. */
export const BUILTIN_STYLES = JSON.parse(JSON.stringify({ // drops the undefined fonts of Heading 3-9
  Normal: { type: 'paragraph', name: 'Normal' },
  Heading1: heading(1, { spacing: { before: 18, after: 4 } }, { size: 20, ...ACCENT1_DARK }),
  Heading2: heading(2, { spacing: { before: 8, after: 4 } }, { size: 16, ...ACCENT1_DARK }),
  Heading3: heading(3, { spacing: { before: 8, after: 4 } }, { size: 14, ...ACCENT1_DARK }),
  Heading4: heading(4, { spacing: { before: 4, after: 2 } }, { italic: true, ...ACCENT1_DARK }),
  Heading5: heading(5, { spacing: { before: 4, after: 2 } }, { ...ACCENT1_DARK }),
  Heading6: heading(6, { spacing: { before: 2, after: 0 } }, { italic: true, ...TEXT1_35 }),
  Heading7: heading(7, { spacing: { before: 2, after: 0 } }, { ...TEXT1_35 }),
  Heading8: heading(8, { spacing: { after: 0 } }, { italic: true, ...TEXT1_15 }),
  Heading9: heading(9, { spacing: { after: 0 } }, { ...TEXT1_15 }),
  Title: {
    type: 'paragraph', name: 'Title', basedOn: 'Normal', next: 'Normal',
    para: { spacing: { after: 4, line: { rule: 'auto', value: 1 } }, contextual: true },
    run: { font: '+major', size: 28, charSpacing: -0.5, kern: 14 },
  },
  // Word also writes numPr ilvl 1 with no numId on Subtitle, which numbers nothing; left out.
  Subtitle: { type: 'paragraph', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', run: { size: 14, charSpacing: 0.75, ...TEXT1_35 } },
  Quote: {
    type: 'paragraph', name: 'Quote', basedOn: 'Normal', next: 'Normal',
    para: { spacing: { before: 8 }, align: 'center' }, run: { italic: true, ...TEXT1_25 },
  },
  IntenseQuote: {
    type: 'paragraph', name: 'Intense Quote', basedOn: 'Normal', next: 'Normal',
    para: { spacing: { before: 18, after: 18 }, indent: { left: 43.2, right: 43.2 }, align: 'center', border: { top: border, bottom: border } },
    run: { italic: true, ...ACCENT1_DARK },
  },
  // Not in the probe's styles.xml; observed through COM in Word 16.0.20527 (2026-10-25): no base style, single line spacing,
  // nothing before or after, and Enter keeps No Spacing (no next).
  NoSpacing: { type: 'paragraph', name: 'No Spacing', para: { spacing: { after: 0, line: { rule: 'auto', value: 1 } } } },
  ListParagraph: { type: 'paragraph', name: 'List Paragraph', basedOn: 'Normal', para: { indent: { left: 36 }, contextual: true } },
  Hyperlink: { type: 'character', name: 'Hyperlink', run: { color: THEME.colors.hlink, themeColor: { slot: 'hlink', lum: 0 }, underline: 'single' } },
  TableNormal: { type: 'table', name: 'Normal Table', table: { cellMargin: { top: 0, right: 5.4, bottom: 0, left: 5.4 } } },
  TableGrid: {
    type: 'table', name: 'Table Grid', basedOn: 'TableNormal',
    para: { spacing: { after: 0, line: { rule: 'auto', value: 1 } } },
    table: { borders: { style: 'single', width: 0.5, color: null } }, // all six edges; null is Automatic
  },
}));

/** numbering.xml: abstract list definitions ('bullet' and 'decimal', nine levels each) and the nums that use them. */
const GLYPHS = ['•', 'o', '▪']; // •, o, ▪ repeat down the levels
const DECIMAL_FMTS = ['decimal', 'lowerLetter', 'lowerRoman'];
export const DEFAULT_NUMBERING = {
  abstract: {
    bullet: { levels: Array.from({ length: 9 }, (_, i) => ({ fmt: 'bullet', text: GLYPHS[i % 3], glyph: GLYPHS[i % 3], start: 1, left: 36 * (i + 1), hanging: 18 })) },
    decimal: { levels: Array.from({ length: 9 }, (_, i) => ({ fmt: DECIMAL_FMTS[i % 3], text: `%${i + 1}.`, start: 1, left: 36 * (i + 1), hanging: 18 })) },
  },
  nums: { 1: { abstract: 'bullet' }, 2: { abstract: 'decimal' } },
};

// A numbered definition whose first level is `fmt` with label `text`, the deeper levels as 'decimal'.
const firstLevel = (fmt, text) => ({ levels: DEFAULT_NUMBERING.abstract.decimal.levels.map((l, i) => (i ? l : { ...l, fmt, text })) });

/** Every list definition a list command can add to a Document (lists.js): the defaults, 'lowerLetterParen', which Word's
 * AutoFormat makes from 'a) ', and the Numbering library's a. A. i. I. (each that format at the first level, then as
 * 'decimal'). Copied into doc.attrs.numbering on first use. */
export const LIST_ABSTRACTS = {
  ...DEFAULT_NUMBERING.abstract,
  lowerLetterParen: firstLevel('lowerLetter', '%1)'),
  lowerLetter: firstLevel('lowerLetter', '%1.'),
  upperLetter: firstLevel('upperLetter', '%1.'),
  lowerRoman: firstLevel('lowerRoman', '%1.'),
  upperRoman: firstLevel('upperRoman', '%1.'),
};

/** The body section: `paper` 'a4' or 'letter' (settings.paper) with Word's margins for that locale (header and footer 708 twips
 * on A4, 720 on Letter). */
export function defaultSect(paper) {
  const letter = paper === 'letter';
  const { w, h } = PAPER_SIZES[letter ? 'letter' : 'a4'];
  const hf = letter ? 36 : 35.4;
  return { w, h, orient: 'portrait', margin: { top: 72, right: 72, bottom: 72, left: 72, header: hf, footer: hf, gutter: 0 }, pageNumber: null };
}

/** The TipTap JSON of a new, empty Document for `settings` (its paper). */
export function newDocumentJson(settings) {
  return {
    type: 'doc',
    attrs: {
      sect: defaultSect(settings?.paper),
      styles: { defaults: structuredClone(DOC_DEFAULTS), list: structuredClone(BUILTIN_STYLES) },
      numbering: structuredClone(DEFAULT_NUMBERING),
      theme: structuredClone(THEME),
    },
    content: [{ type: 'paragraph' }],
  };
}

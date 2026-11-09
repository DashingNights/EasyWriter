// Symbol data and the pure parts of Insert > Symbol, the Symbol and Number dialogs and Alt+X (docs/plans/word briefs/symbols.md).
// No DOM and no editor here, so node tests load it. The data stays compact on purpose: the Unicode block table and a short name
// table, not Unicode's whole character database.
import { WORD_KEYS } from '../../word/keymap.mjs';

const cp = (c) => c.codePointAt(0);
const hex = (n, width = 4) => n.toString(16).toUpperCase().padStart(width, '0');

// ---------------------------------------------------------------------------------------------
// Alt+X (probe/behaviour-tests.tsv altx and altx-sel rows)

const HEX_RUN = /(?:[Uu]\+)?([0-9A-Fa-f]+)$/;
const SELECTED_CODE = /^(?:[Uu]\+)?([0-9A-Fa-f]{1,6})$/;
const WORDISH = /[\p{L}\p{N}]/u;

/** Code point `n` as a character Alt+X may produce: in range, not a surrogate half and not a C0 or C1 control (Word turns 'A' into
 * '0041', not into U+000A). */
const typable = (n) => n >= 0x20 && n <= 0x10ffff && !(n >= 0x7f && n <= 0x9f) && !(n >= 0xd800 && n <= 0xdfff);

/** The code Alt+X shows for character `c`: upper-case hex with at least four digits. */
export const codeText = (c) => hex(cp(c));

/** What Alt+X does with `before` (the textblock's text before the caret) and `selected` (the selected text, '' for a caret) →
 * {count, text}: replace the last `count` UTF-16 units of `before` (or the whole selection) with `text`; null leaves the text as it
 * is. A hex run (optionally after U+) up to 10FFFF becomes its character; a run too long, too large or absent turns the character
 * before the caret into its code. A run that follows a letter or digit ('x2014') is left alone, as Word does. */
export function altX(before, selected = '') {
  if (selected) {
    const m = SELECTED_CODE.exec(selected);
    const n = m && parseInt(m[1], 16);
    if (m && typable(n)) return { count: selected.length, text: String.fromCodePoint(n) };
    // One selected character shows its code; several letters stay as they are.
    return [...selected].length === 1 ? { count: selected.length, text: codeText(selected) } : null;
  }
  const m = HEX_RUN.exec(before);
  if (m) {
    const lead = before[before.length - m[0].length - 1];
    if (m[0].length === m[1].length && lead && WORDISH.test(lead)) return null;
    const n = m[1].length <= 6 ? parseInt(m[1], 16) : -1;
    if (typable(n)) return { count: m[0].length, text: String.fromCodePoint(n) };
  }
  const last = [...before].at(-1);
  return last ? { count: last.length, text: codeText(last) } : null;
}

// ---------------------------------------------------------------------------------------------
// Unicode blocks: [first, last, name], sorted, not overlapping. Word's names where they differ from Unicode's (Bangla, Odia).
// Surrogates and the private use area are left out: they hold no characters to pick.

export const BLOCKS = [
  [0x0000, 0x007f, 'Basic Latin'], [0x0080, 0x00ff, 'Latin-1 Supplement'], [0x0100, 0x017f, 'Latin Extended-A'],
  [0x0180, 0x024f, 'Latin Extended-B'], [0x0250, 0x02af, 'IPA Extensions'], [0x02b0, 0x02ff, 'Spacing Modifier Letters'],
  [0x0300, 0x036f, 'Combining Diacritical Marks'], [0x0370, 0x03ff, 'Greek and Coptic'], [0x0400, 0x04ff, 'Cyrillic'],
  [0x0500, 0x052f, 'Cyrillic Supplement'], [0x0530, 0x058f, 'Armenian'], [0x0590, 0x05ff, 'Hebrew'], [0x0600, 0x06ff, 'Arabic'],
  [0x0700, 0x074f, 'Syriac'], [0x0750, 0x077f, 'Arabic Supplement'], [0x0780, 0x07bf, 'Thaana'], [0x07c0, 0x07ff, 'NKo'],
  [0x0800, 0x083f, 'Samaritan'], [0x0840, 0x085f, 'Mandaic'], [0x0860, 0x086f, 'Syriac Supplement'], [0x0870, 0x089f, 'Arabic Extended-B'],
  [0x08a0, 0x08ff, 'Arabic Extended-A'], [0x0900, 0x097f, 'Devanagari'], [0x0980, 0x09ff, 'Bangla'], [0x0a00, 0x0a7f, 'Gurmukhi'],
  [0x0a80, 0x0aff, 'Gujarati'], [0x0b00, 0x0b7f, 'Odia'], [0x0b80, 0x0bff, 'Tamil'], [0x0c00, 0x0c7f, 'Telugu'], [0x0c80, 0x0cff, 'Kannada'],
  [0x0d00, 0x0d7f, 'Malayalam'], [0x0d80, 0x0dff, 'Sinhala'], [0x0e00, 0x0e7f, 'Thai'], [0x0e80, 0x0eff, 'Lao'], [0x0f00, 0x0fff, 'Tibetan'],
  [0x1000, 0x109f, 'Myanmar'], [0x10a0, 0x10ff, 'Georgian'], [0x1100, 0x11ff, 'Hangul Jamo'], [0x1200, 0x137f, 'Ethiopic'],
  [0x1380, 0x139f, 'Ethiopic Supplement'], [0x13a0, 0x13ff, 'Cherokee'], [0x1400, 0x167f, 'Unified Canadian Aboriginal Syllabics'],
  [0x1680, 0x169f, 'Ogham'], [0x16a0, 0x16ff, 'Runic'], [0x1700, 0x171f, 'Tagalog'], [0x1720, 0x173f, 'Hanunoo'], [0x1740, 0x175f, 'Buhid'],
  [0x1760, 0x177f, 'Tagbanwa'], [0x1780, 0x17ff, 'Khmer'], [0x1800, 0x18af, 'Mongolian'],
  [0x18b0, 0x18ff, 'Unified Canadian Aboriginal Syllabics Extended'], [0x1900, 0x194f, 'Limbu'], [0x1950, 0x197f, 'Tai Le'],
  [0x1980, 0x19df, 'New Tai Lue'], [0x19e0, 0x19ff, 'Khmer Symbols'], [0x1a00, 0x1a1f, 'Buginese'], [0x1a20, 0x1aaf, 'Tai Tham'],
  [0x1ab0, 0x1aff, 'Combining Diacritical Marks Extended'], [0x1b00, 0x1b7f, 'Balinese'], [0x1b80, 0x1bbf, 'Sundanese'],
  [0x1bc0, 0x1bff, 'Batak'], [0x1c00, 0x1c4f, 'Lepcha'], [0x1c50, 0x1c7f, 'Ol Chiki'], [0x1c80, 0x1c8f, 'Cyrillic Extended-C'],
  [0x1c90, 0x1cbf, 'Georgian Extended'], [0x1cc0, 0x1ccf, 'Sundanese Supplement'], [0x1cd0, 0x1cff, 'Vedic Extensions'],
  [0x1d00, 0x1d7f, 'Phonetic Extensions'], [0x1d80, 0x1dbf, 'Phonetic Extensions Supplement'],
  [0x1dc0, 0x1dff, 'Combining Diacritical Marks Supplement'], [0x1e00, 0x1eff, 'Latin Extended Additional'], [0x1f00, 0x1fff, 'Greek Extended'],
  [0x2000, 0x206f, 'General Punctuation'], [0x2070, 0x209f, 'Superscripts and Subscripts'], [0x20a0, 0x20cf, 'Currency Symbols'],
  [0x20d0, 0x20ff, 'Combining Diacritical Marks for Symbols'], [0x2100, 0x214f, 'Letterlike Symbols'], [0x2150, 0x218f, 'Number Forms'],
  [0x2190, 0x21ff, 'Arrows'], [0x2200, 0x22ff, 'Mathematical Operators'], [0x2300, 0x23ff, 'Miscellaneous Technical'],
  [0x2400, 0x243f, 'Control Pictures'], [0x2440, 0x245f, 'Optical Character Recognition'], [0x2460, 0x24ff, 'Enclosed Alphanumerics'],
  [0x2500, 0x257f, 'Box Drawing'], [0x2580, 0x259f, 'Block Elements'], [0x25a0, 0x25ff, 'Geometric Shapes'],
  [0x2600, 0x26ff, 'Miscellaneous Symbols'], [0x2700, 0x27bf, 'Dingbats'], [0x27c0, 0x27ef, 'Miscellaneous Mathematical Symbols-A'],
  [0x27f0, 0x27ff, 'Supplemental Arrows-A'], [0x2800, 0x28ff, 'Braille Patterns'], [0x2900, 0x297f, 'Supplemental Arrows-B'],
  [0x2980, 0x29ff, 'Miscellaneous Mathematical Symbols-B'], [0x2a00, 0x2aff, 'Supplemental Mathematical Operators'],
  [0x2b00, 0x2bff, 'Miscellaneous Symbols and Arrows'], [0x2c00, 0x2c5f, 'Glagolitic'], [0x2c60, 0x2c7f, 'Latin Extended-C'],
  [0x2c80, 0x2cff, 'Coptic'], [0x2d00, 0x2d2f, 'Georgian Supplement'], [0x2d30, 0x2d7f, 'Tifinagh'], [0x2d80, 0x2ddf, 'Ethiopic Extended'],
  [0x2de0, 0x2dff, 'Cyrillic Extended-A'], [0x2e00, 0x2e7f, 'Supplemental Punctuation'], [0x2e80, 0x2eff, 'CJK Radicals Supplement'],
  [0x2f00, 0x2fdf, 'Kangxi Radicals'], [0x2ff0, 0x2fff, 'Ideographic Description Characters'], [0x3000, 0x303f, 'CJK Symbols and Punctuation'],
  [0x3040, 0x309f, 'Hiragana'], [0x30a0, 0x30ff, 'Katakana'], [0x3100, 0x312f, 'Bopomofo'], [0x3130, 0x318f, 'Hangul Compatibility Jamo'],
  [0x3190, 0x319f, 'Kanbun'], [0x31a0, 0x31bf, 'Bopomofo Extended'], [0x31c0, 0x31ef, 'CJK Strokes'],
  [0x31f0, 0x31ff, 'Katakana Phonetic Extensions'], [0x3200, 0x32ff, 'Enclosed CJK Letters and Months'], [0x3300, 0x33ff, 'CJK Compatibility'],
  [0x3400, 0x4dbf, 'CJK Unified Ideographs Extension A'], [0x4dc0, 0x4dff, 'Yijing Hexagram Symbols'], [0x4e00, 0x9fff, 'CJK Unified Ideographs'],
  [0xa000, 0xa48f, 'Yi Syllables'], [0xa490, 0xa4cf, 'Yi Radicals'], [0xa4d0, 0xa4ff, 'Lisu'], [0xa500, 0xa63f, 'Vai'],
  [0xa640, 0xa69f, 'Cyrillic Extended-B'], [0xa6a0, 0xa6ff, 'Bamum'], [0xa700, 0xa71f, 'Modifier Tone Letters'], [0xa720, 0xa7ff, 'Latin Extended-D'],
  [0xa800, 0xa82f, 'Syloti Nagri'], [0xa830, 0xa83f, 'Common Indic Number Forms'], [0xa840, 0xa87f, 'Phags-pa'], [0xa880, 0xa8df, 'Saurashtra'],
  [0xa8e0, 0xa8ff, 'Devanagari Extended'], [0xa900, 0xa92f, 'Kayah Li'], [0xa930, 0xa95f, 'Rejang'], [0xa960, 0xa97f, 'Hangul Jamo Extended-A'],
  [0xa980, 0xa9df, 'Javanese'], [0xa9e0, 0xa9ff, 'Myanmar Extended-B'], [0xaa00, 0xaa5f, 'Cham'], [0xaa60, 0xaa7f, 'Myanmar Extended-A'],
  [0xaa80, 0xaadf, 'Tai Viet'], [0xaae0, 0xaaff, 'Meetei Mayek Extensions'], [0xab00, 0xab2f, 'Ethiopic Extended-A'],
  [0xab30, 0xab6f, 'Latin Extended-E'], [0xab70, 0xabbf, 'Cherokee Supplement'], [0xabc0, 0xabff, 'Meetei Mayek'],
  [0xac00, 0xd7af, 'Hangul Syllables'], [0xd7b0, 0xd7ff, 'Hangul Jamo Extended-B'], [0xf900, 0xfaff, 'CJK Compatibility Ideographs'],
  [0xfb00, 0xfb4f, 'Alphabetic Presentation Forms'], [0xfb50, 0xfdff, 'Arabic Presentation Forms-A'], [0xfe00, 0xfe0f, 'Variation Selectors'],
  [0xfe10, 0xfe1f, 'Vertical Forms'], [0xfe20, 0xfe2f, 'Combining Half Marks'], [0xfe30, 0xfe4f, 'CJK Compatibility Forms'],
  [0xfe50, 0xfe6f, 'Small Form Variants'], [0xfe70, 0xfeff, 'Arabic Presentation Forms-B'], [0xff00, 0xffef, 'Halfwidth and Fullwidth Forms'],
  [0xfff0, 0xffff, 'Specials'], [0x1f000, 0x1f02f, 'Mahjong Tiles'], [0x1f030, 0x1f09f, 'Domino Tiles'], [0x1f0a0, 0x1f0ff, 'Playing Cards'],
  [0x1f100, 0x1f1ff, 'Enclosed Alphanumeric Supplement'], [0x1f200, 0x1f2ff, 'Enclosed Ideographic Supplement'],
  [0x1f300, 0x1f5ff, 'Miscellaneous Symbols and Pictographs'], [0x1f600, 0x1f64f, 'Emoticons'], [0x1f650, 0x1f67f, 'Ornamental Dingbats'],
  [0x1f680, 0x1f6ff, 'Transport and Map Symbols'], [0x1f700, 0x1f77f, 'Alchemical Symbols'], [0x1f780, 0x1f7ff, 'Geometric Shapes Extended'],
  [0x1f800, 0x1f8ff, 'Supplemental Arrows-C'], [0x1f900, 0x1f9ff, 'Supplemental Symbols and Pictographs'],
  [0x1fa70, 0x1faff, 'Symbols and Pictographs Extended-A'],
];

/** The block holding code point `n` → its BLOCKS row or null. */
export function blockOf(n) {
  let lo = 0;
  let hi = BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = BLOCKS[mid];
    if (n < a) hi = mid - 1;
    else if (n > b) lo = mid + 1;
    else return BLOCKS[mid];
  }
  return null;
}

let cells = null;
/** The code points the Symbols grid walks for a text font, in block order: every BLOCKS code point but the C0 and C1 controls and
 * the noncharacters FFFE and FFFF. Built once (about 59,000 entries). */
export function textCells() {
  if (cells) return cells;
  const out = [];
  for (const [a, b] of BLOCKS) for (let n = a; n <= b; n++) if (typable(n) && n !== 0xfffe && n !== 0xffff) out.push(n);
  return (cells = Uint32Array.from(out));
}

// ---------------------------------------------------------------------------------------------
// Character codes: Unicode (hex), ASCII (decimal) and ASCII (hex). ASCII means Windows-1252 there, so 0128 is the euro.

const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013,
  0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 };
const FROM_1252 = Object.fromEntries(Object.entries(CP1252).map(([b, u]) => [u, Number(b)]));
const byteOf = (n) => (FROM_1252[n] ?? (n <= 0xff && !(n >= 0x80 && n <= 0x9f) ? n : null));
const unicodeOfByte = (b) => (b >= 0x80 && b <= 0x9f ? CP1252[b] ?? null : b);

/** The Character code "from" list: [value, label]. */
export const CODE_FROM = [['unicode', 'Unicode (hex)'], ['asciiDec', 'ASCII (decimal)'], ['asciiHex', 'ASCII (hex)']];

/** Character `c`'s code in `from` ('unicode' | 'asciiDec' | 'asciiHex') → text, or '' when Windows-1252 has no such character. */
export function codeOf(c, from = 'unicode') {
  const n = cp(c);
  if (from === 'unicode') return hex(n);
  const b = byteOf(n);
  if (b == null) return '';
  return from === 'asciiDec' ? String(b).padStart(4, '0') : hex(b, 2);
}

/** The character typed code `code` names in `from` → the character, or null for no valid code. */
export function charOf(code, from = 'unicode') {
  const t = String(code ?? '').trim();
  if (from === 'asciiDec') {
    if (!/^\d{1,4}$/.test(t)) return null;
    const u = Number(t) <= 0xff ? unicodeOfByte(Number(t)) : null;
    return u != null && typable(u) ? String.fromCodePoint(u) : null;
  }
  if (!/^[0-9A-Fa-f]{1,6}$/.test(t)) return null;
  const n = parseInt(t, 16);
  const u = from === 'asciiHex' ? (n <= 0xff ? unicodeOfByte(n) : null) : n;
  return u != null && typable(u) ? String.fromCodePoint(u) : null;
}

// ---------------------------------------------------------------------------------------------
// Symbol fonts. Their codes 32 to 255 map to Unicode where an equivalent exists; we bundle no symbol font, so the Unicode character
// goes in in the current font (Wingdings 74 is ☺). Webdings has no table here and is not offered.

const run = (from, chars) => Object.fromEntries([...chars].map((c, i) => [from + i, c]).filter(([, c]) => c !== '\u0000'));
const SYMBOL = {
  ...run(0x20, ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼'),
  ...run(0xa0, '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪'),
  ...run(0xf1, '〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭'),
};
const WINGDINGS = {
  ...run(0x20, ' 🖉✂✁👓🕭🕮🕯🕿✆🖂🖃📪📫📬📭📁📂📄🗏🗐🗄⌛🖮🖰🖲🖳🖴🖫🖬✇✍🖎✌👌👍👎☜☞☝☟🖐☺😐☹💣☠🏳🏱✈☼💧❄🕆✞🕈✠✡☪☯ॐ☸♈♉♊♋♌♍♎♏♐♑♒♓🙰🙵●🔾■□🞐❑❒⬧⧫◆❖⬥⌧⮹⌘🏵🏶🙶🙷'),
  ...run(0x80, '⓪①②③④⑤⑥⑦⑧⑨⑩⓿❶❷❸❹❺❻❼❽❾❿'),
  0xfd: '☒', 0xfe: '☑',
};
/** Symbol font name → {code (32..255): Unicode character}. */
export const SYMBOL_FONTS = { Symbol: SYMBOL, Wingdings: WINGDINGS };
/** Whether `font` is one of the symbol fonts. */
export const isSymbolFont = (font) => !!font && Object.hasOwn(SYMBOL_FONTS, font);

// ---------------------------------------------------------------------------------------------
// Unicode names: a short table for the symbol blocks and the letters around them; anything else shows its U+ code.

const NAMES = new Map();
const put = (n, name) => NAMES.set(n, name);
const DIGITS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
[...'0123456789'].forEach((d, i) => put(0x30 + i, `Digit ${DIGITS[i]}`));
for (let i = 0; i < 26; i++) {
  put(0x41 + i, `Latin Capital Letter ${String.fromCharCode(0x41 + i)}`);
  put(0x61 + i, `Latin Small Letter ${String.fromCharCode(0x41 + i)}`);
}
const table = (rows) => {
  for (const [n, name] of rows) put(n, name);
};
table([[0x20, 'Space'], [0x21, 'Exclamation Mark'], [0x22, 'Quotation Mark'], [0x23, 'Number Sign'], [0x24, 'Dollar Sign'], [0x25, 'Percent Sign'],
  [0x26, 'Ampersand'], [0x27, 'Apostrophe'], [0x28, 'Left Parenthesis'], [0x29, 'Right Parenthesis'], [0x2a, 'Asterisk'], [0x2b, 'Plus Sign'],
  [0x2c, 'Comma'], [0x2d, 'Hyphen-Minus'], [0x2e, 'Full Stop'], [0x2f, 'Solidus'], [0x3a, 'Colon'], [0x3b, 'Semicolon'], [0x3c, 'Less-Than Sign'],
  [0x3d, 'Equals Sign'], [0x3e, 'Greater-Than Sign'], [0x3f, 'Question Mark'], [0x40, 'Commercial At'], [0x5b, 'Left Square Bracket'],
  [0x5c, 'Reverse Solidus'], [0x5d, 'Right Square Bracket'], [0x5e, 'Circumflex Accent'], [0x5f, 'Low Line'], [0x60, 'Grave Accent'],
  [0x7b, 'Left Curly Bracket'], [0x7c, 'Vertical Line'], [0x7d, 'Right Curly Bracket'], [0x7e, 'Tilde']]);
table([[0xa0, 'No-Break Space'], [0xa1, 'Inverted Exclamation Mark'], [0xa2, 'Cent Sign'], [0xa3, 'Pound Sign'], [0xa4, 'Currency Sign'],
  [0xa5, 'Yen Sign'], [0xa6, 'Broken Bar'], [0xa7, 'Section Sign'], [0xa8, 'Diaeresis'], [0xa9, 'Copyright Sign'], [0xaa, 'Feminine Ordinal Indicator'],
  [0xab, 'Left-Pointing Double Angle Quotation Mark'], [0xac, 'Not Sign'], [0xad, 'Soft Hyphen'], [0xae, 'Registered Sign'], [0xaf, 'Macron'],
  [0xb0, 'Degree Sign'], [0xb1, 'Plus-Minus Sign'], [0xb2, 'Superscript Two'], [0xb3, 'Superscript Three'], [0xb4, 'Acute Accent'],
  [0xb5, 'Micro Sign'], [0xb6, 'Pilcrow Sign'], [0xb7, 'Middle Dot'], [0xb8, 'Cedilla'], [0xb9, 'Superscript One'],
  [0xba, 'Masculine Ordinal Indicator'], [0xbb, 'Right-Pointing Double Angle Quotation Mark'], [0xbc, 'Vulgar Fraction One Quarter'],
  [0xbd, 'Vulgar Fraction One Half'], [0xbe, 'Vulgar Fraction Three Quarters'], [0xbf, 'Inverted Question Mark'], [0xd7, 'Multiplication Sign'],
  [0xdf, 'Latin Small Letter Sharp S'], [0xf7, 'Division Sign'], [0xff, 'Latin Small Letter Y With Diaeresis']]);
// Latin-1 letters C0 to DE and their small forms 32 places on.
const LATIN1 = ['A With Grave', 'A With Acute', 'A With Circumflex', 'A With Tilde', 'A With Diaeresis', 'A With Ring Above', 'Ae',
  'C With Cedilla', 'E With Grave', 'E With Acute', 'E With Circumflex', 'E With Diaeresis', 'I With Grave', 'I With Acute', 'I With Circumflex',
  'I With Diaeresis', 'Eth', 'N With Tilde', 'O With Grave', 'O With Acute', 'O With Circumflex', 'O With Tilde', 'O With Diaeresis', null,
  'O With Stroke', 'U With Grave', 'U With Acute', 'U With Circumflex', 'U With Diaeresis', 'Y With Acute', 'Thorn'];
LATIN1.forEach((s, i) => {
  if (!s) return;
  put(0xc0 + i, `Latin Capital Letter ${s}`);
  put(0xe0 + i, `Latin Small Letter ${s}`);
});
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lamda', 'Mu', 'Nu', 'Xi', 'Omicron', 'Pi',
  'Rho', null, 'Sigma', 'Tau', 'Upsilon', 'Phi', 'Chi', 'Psi', 'Omega'];
GREEK.forEach((s, i) => {
  if (s) put(0x391 + i, `Greek Capital Letter ${s}`);
  put(0x3b1 + i, `Greek Small Letter ${s ?? 'Final Sigma'}`);
});
table([[0x3d1, 'Greek Theta Symbol'], [0x3d2, 'Greek Upsilon With Hook Symbol'], [0x3d5, 'Greek Phi Symbol'], [0x3d6, 'Greek Pi Symbol'],
  [0x192, 'Latin Small Letter F With Hook'], [0x152, 'Latin Capital Ligature Oe'], [0x153, 'Latin Small Ligature Oe'],
  [0x160, 'Latin Capital Letter S With Caron'], [0x161, 'Latin Small Letter S With Caron'], [0x178, 'Latin Capital Letter Y With Diaeresis'],
  [0x17d, 'Latin Capital Letter Z With Caron'], [0x17e, 'Latin Small Letter Z With Caron'], [0x2c6, 'Modifier Letter Circumflex Accent'],
  [0x2dc, 'Small Tilde']]);
table([[0x2002, 'En Space'], [0x2003, 'Em Space'], [0x2005, 'Four-Per-Em Space'], [0x2009, 'Thin Space'], [0x200b, 'Zero Width Space'],
  [0x200c, 'Zero Width Non-Joiner'], [0x200d, 'Zero Width Joiner'], [0x200e, 'Left-To-Right Mark'], [0x200f, 'Right-To-Left Mark'],
  [0x2010, 'Hyphen'], [0x2011, 'Non-Breaking Hyphen'], [0x2012, 'Figure Dash'], [0x2013, 'En Dash'], [0x2014, 'Em Dash'], [0x2015, 'Horizontal Bar'],
  [0x2016, 'Double Vertical Line'], [0x2018, 'Left Single Quotation Mark'], [0x2019, 'Right Single Quotation Mark'],
  [0x201a, 'Single Low-9 Quotation Mark'], [0x201c, 'Left Double Quotation Mark'], [0x201d, 'Right Double Quotation Mark'],
  [0x201e, 'Double Low-9 Quotation Mark'], [0x2020, 'Dagger'], [0x2021, 'Double Dagger'], [0x2022, 'Bullet'], [0x2026, 'Horizontal Ellipsis'],
  [0x202a, 'Left-To-Right Embedding'], [0x202b, 'Right-To-Left Embedding'], [0x202c, 'Pop Directional Formatting'],
  [0x202d, 'Left-To-Right Override'], [0x202e, 'Right-To-Left Override'], [0x2030, 'Per Mille Sign'], [0x2032, 'Prime'], [0x2033, 'Double Prime'],
  [0x2039, 'Single Left-Pointing Angle Quotation Mark'], [0x203a, 'Single Right-Pointing Angle Quotation Mark'], [0x203c, 'Double Exclamation Mark'],
  [0x203e, 'Overline'], [0x2044, 'Fraction Slash']]);
const CURRENCY = ['Euro-Currency', 'Colon', 'Cruzeiro', 'French Franc', 'Lira', 'Mill', 'Naira', 'Peseta', 'Rupee', 'Won', 'New Sheqel', 'Dong',
  'Euro', 'Kip', 'Tugrik', 'Drachma', 'German Penny', 'Peso', 'Guarani', 'Austral', 'Hryvnia', 'Cedi', 'Livre Tournois', 'Spesmilo', 'Tenge',
  'Indian Rupee', 'Turkish Lira', 'Nordic Mark', 'Manat', 'Ruble', 'Lari', 'Bitcoin', 'Som'];
CURRENCY.forEach((s, i) => put(0x20a0 + i, `${s} Sign`));
table([[0x2103, 'Degree Celsius'], [0x2109, 'Degree Fahrenheit'], [0x2111, 'Black-Letter Capital I'], [0x2113, 'Script Small L'],
  [0x2116, 'Numero Sign'], [0x2117, 'Sound Recording Copyright'], [0x2118, 'Script Capital P'], [0x211c, 'Black-Letter Capital R'],
  [0x211e, 'Prescription Take'], [0x2120, 'Service Mark'], [0x2122, 'Trade Mark Sign'], [0x2126, 'Ohm Sign'], [0x212e, 'Estimated Symbol'],
  [0x2135, 'Alef Symbol'], [0x2153, 'Vulgar Fraction One Third'], [0x2154, 'Vulgar Fraction Two Thirds'], [0x215b, 'Vulgar Fraction One Eighth'],
  [0x215c, 'Vulgar Fraction Three Eighths'], [0x215d, 'Vulgar Fraction Five Eighths'], [0x215e, 'Vulgar Fraction Seven Eighths']]);
table([[0x2190, 'Leftwards Arrow'], [0x2191, 'Upwards Arrow'], [0x2192, 'Rightwards Arrow'], [0x2193, 'Downwards Arrow'], [0x2194, 'Left Right Arrow'],
  [0x2195, 'Up Down Arrow'], [0x2196, 'North West Arrow'], [0x2197, 'North East Arrow'], [0x2198, 'South East Arrow'], [0x2199, 'South West Arrow'],
  [0x21b5, 'Downwards Arrow With Corner Leftwards'], [0x21d0, 'Leftwards Double Arrow'], [0x21d1, 'Upwards Double Arrow'],
  [0x21d2, 'Rightwards Double Arrow'], [0x21d3, 'Downwards Double Arrow'], [0x21d4, 'Left Right Double Arrow']]);
table([[0x2200, 'For All'], [0x2202, 'Partial Differential'], [0x2203, 'There Exists'], [0x2205, 'Empty Set'], [0x2206, 'Increment'], [0x2207, 'Nabla'],
  [0x2208, 'Element Of'], [0x2209, 'Not An Element Of'], [0x220b, 'Contains As Member'], [0x220f, 'N-Ary Product'], [0x2211, 'N-Ary Summation'],
  [0x2212, 'Minus Sign'], [0x2215, 'Division Slash'], [0x2217, 'Asterisk Operator'], [0x2219, 'Bullet Operator'], [0x221a, 'Square Root'],
  [0x221d, 'Proportional To'], [0x221e, 'Infinity'], [0x221f, 'Right Angle'], [0x2220, 'Angle'], [0x2227, 'Logical And'], [0x2228, 'Logical Or'],
  [0x2229, 'Intersection'], [0x222a, 'Union'], [0x222b, 'Integral'], [0x2234, 'Therefore'], [0x223c, 'Tilde Operator'],
  [0x2245, 'Approximately Equal To'], [0x2248, 'Almost Equal To'], [0x2260, 'Not Equal To'], [0x2261, 'Identical To'],
  [0x2264, 'Less-Than Or Equal To'], [0x2265, 'Greater-Than Or Equal To'], [0x2282, 'Subset Of'], [0x2283, 'Superset Of'], [0x2284, 'Not A Subset Of'],
  [0x2286, 'Subset Of Or Equal To'], [0x2287, 'Superset Of Or Equal To'], [0x2295, 'Circled Plus'], [0x2297, 'Circled Times'], [0x22a5, 'Up Tack'],
  [0x22c5, 'Dot Operator'], [0x2302, 'House'], [0x2318, 'Place Of Interest Sign'], [0x2320, 'Top Half Integral'], [0x2321, 'Bottom Half Integral'],
  [0x231b, 'Hourglass'], [0x2329, 'Left-Pointing Angle Bracket'], [0x232a, 'Right-Pointing Angle Bracket']]);
table([[0x25a0, 'Black Square'], [0x25a1, 'White Square'], [0x25b2, 'Black Up-Pointing Triangle'], [0x25ba, 'Black Right-Pointing Pointer'],
  [0x25bc, 'Black Down-Pointing Triangle'], [0x25c4, 'Black Left-Pointing Pointer'], [0x25c6, 'Black Diamond'], [0x25ca, 'Lozenge'],
  [0x25cb, 'White Circle'], [0x25cf, 'Black Circle'], [0x2605, 'Black Star'], [0x2606, 'White Star'], [0x260e, 'Black Telephone'],
  [0x2610, 'Ballot Box'], [0x2611, 'Ballot Box With Check'], [0x2612, 'Ballot Box With X'], [0x261c, 'White Left Pointing Index'],
  [0x261d, 'White Up Pointing Index'], [0x261e, 'White Right Pointing Index'], [0x261f, 'White Down Pointing Index'], [0x2620, 'Skull And Crossbones'],
  [0x2639, 'White Frowning Face'], [0x263a, 'White Smiling Face'], [0x263b, 'Black Smiling Face'], [0x263c, 'White Sun With Rays'],
  [0x2640, 'Female Sign'], [0x2642, 'Male Sign'], [0x2660, 'Black Spade Suit'], [0x2663, 'Black Club Suit'], [0x2665, 'Black Heart Suit'],
  [0x2666, 'Black Diamond Suit'], [0x266a, 'Eighth Note'], [0x266b, 'Beamed Eighth Notes'], [0x2702, 'Black Scissors'], [0x2708, 'Airplane'],
  [0x2713, 'Check Mark'], [0x2714, 'Heavy Check Mark'], [0x2717, 'Ballot X'], [0x2718, 'Heavy Ballot X'], [0x2744, 'Snowflake']]);
for (let i = 0; i < 9; i++) put(0x2460 + i, `Circled Digit ${DIGITS[i + 1]}`);
for (let i = 9; i < 20; i++) put(0x2460 + i, `Circled Number ${['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen', 'Twenty'][i - 9]}`);

/** Character `c`'s Unicode name from the short table, else its code ('U+1F600'). */
export const nameOf = (c) => NAMES.get(cp(c)) ?? `U+${hex(cp(c))}`;

// ---------------------------------------------------------------------------------------------
// Recently used symbols: {char, font} most recent first, at most 20. font is null for the text's own font, or the symbol font the
// pick came from (the character itself is always Unicode).

export const RECENT_MAX = 20;
/** Word's list on a fresh profile (probe/menus/insert.symbol.json): its last entry is Wingdings 74, which is ☺. */
export const RECENT_DEFAULT = [...'€£¥©®™±≠≤≥÷×∞µαβπΩ∑'].map((char) => ({ char, font: null })).concat({ char: '☺', font: 'Wingdings' });

/** The stored list (settings.word.recentSymbols), else Word's default list. */
export const recentOf = (stored) => (Array.isArray(stored) && stored.length ? stored.slice(0, RECENT_MAX) : RECENT_DEFAULT);

/** `list` with `entry` moved (or added) to the front, at most 20 entries. */
export function pushRecent(list, entry) {
  const e = { char: entry.char, font: entry.font ?? null };
  return [e, ...(list ?? []).filter((x) => x.char !== e.char || (x.font ?? null) !== e.font)].slice(0, RECENT_MAX);
}

/** A recent entry's label: its Unicode name, or the symbol font and code ('Wingdings: 74') for a symbol font pick. */
export function recentLabel({ char, font }) {
  if (isSymbolFont(font)) {
    const code = Object.entries(SYMBOL_FONTS[font]).find(([, c]) => c === char)?.[0];
    if (code) return `${font}: ${code}`;
  }
  return nameOf(char);
}

// ---------------------------------------------------------------------------------------------
// Special Characters (27 rows in the probe's order). Shortcut keys come from our keymap where it binds the character; the quotes'
// keys are accent prefix sequences, written out as Word lists them.

export const SPECIAL = [
  { name: 'Em Dash', char: '—', cmd: 'chars.emDash' },
  { name: 'En Dash', char: '–', cmd: 'chars.enDash' },
  { name: 'Nonbreaking Hyphen', char: '‑', cmd: 'chars.nbHyphen' },
  { name: 'Optional Hyphen', char: '­', cmd: 'chars.optionalHyphen' },
  { name: 'Em Space', char: ' ' },
  { name: 'En Space', char: ' ' },
  { name: '1/4 Em Space', char: ' ' },
  { name: 'Nonbreaking Space', char: ' ', cmd: 'chars.nbsp' },
  { name: 'Copyright', char: '©' },
  { name: 'Registered', char: '®' },
  { name: 'Trademark', char: '™' },
  { name: 'Section', char: '§' },
  { name: 'Paragraph', char: '¶' },
  { name: 'Ellipsis', char: '…' },
  { name: 'Single Opening Quote', char: '‘', keys: 'Ctrl+`,`' },
  { name: 'Single Closing Quote', char: '’', keys: "Ctrl+','" },
  { name: 'Double Opening Quote', char: '“', keys: 'Ctrl+`,"' },
  { name: 'Double Closing Quote', char: '”', keys: "Ctrl+',\"" },
  { name: 'No-Width Optional Break', char: '‌' },
  { name: 'No-Width Non Break', char: '‍' },
  { name: 'Left-to-Right Mark', char: '‎' },
  { name: 'Right-to-Left Mark', char: '‏' },
  { name: 'Left-to-Right Embedding', char: '‪' },
  { name: 'Right-to-Left Embedding', char: '‫' },
  { name: 'Left-to-Right Override', char: '‭' },
  { name: 'Right-to-Left Override', char: '‮' },
  { name: 'Pop Directional Formatting', char: '‬' },
];

// What the Special Characters list shows in its first column for characters that draw nothing (Word draws similar marks).
const SHOWN = { '‑': '-', '­': '¬', ' ': '°', ' ': '', ' ': '', ' ': '' };
/** The glyph the Special Characters list shows for `c`. */
export const shownOf = (c) => SHOWN[c] ?? (/[‌-‏‪-‮]/.test(c) ? '' : c);

/** The chord that types character `c` in Document text (our keymap's chars.symbols rows and the Special Characters keys), or ''. */
export function shortcutOf(c, keys = WORD_KEYS) {
  const row = keys.find((r) => r.kind === 'bind' && r.cmd === 'chars.symbols' && r.arg === c);
  if (row) return row.chord;
  const sp = SPECIAL.find((s) => s.char === c);
  if (sp?.keys) return sp.keys;
  return (sp?.cmd && keys.find((r) => r.kind === 'bind' && r.cmd === sp.cmd && !r.arg)?.chord) || '';
}

// ---------------------------------------------------------------------------------------------
// Number dialog: Word's 18 number types, each with the ST_NumberFormat it inserts (decimal for Use Default Numbering).

export const NUMBER_TYPES = [
  ['1, 2, 3, …', 'decimal'], ['A, B, C, …', 'upperLetter'], ['a, b, c, …', 'lowerLetter'], ['I, II, III, …', 'upperRoman'],
  ['i, ii, iii, …', 'lowerRoman'], ['甲, 乙, 丙 …', 'ideographTraditional'], ['子, 丑, 寅 …', 'ideographZodiac'],
  ['壹, 贰, 叁 …', 'chineseLegalSimplified'], ['一, 二, 三 (简)…', 'chineseCountingThousand'], ['⒈, ⒉, ⒊ …', 'decimalEnclosedFullstop'],
  ['⑴, ⑵, ⑶ …', 'decimalEnclosedParen'], ['①, ②, ③ …', 'decimalEnclosedCircleChinese'], ['㈠, ㈡, ㈢ …', 'ideographEnclosedCircle'],
  ['壹, 貳, 參 …', 'ideographLegalTraditional'], ['一, 二, 三 (繁)…', 'taiwaneseCountingThousand'], ['甲子, 乙丑, 丙寅 …', 'ideographZodiacTraditional'],
  ['Double byte …', 'decimalFullWidth'], ['Use Default Numbering', 'decimal'],
];

/** Number `n` in format `fmt` through the shared formatter `format` (fields/numfmt.mjs numberText) → the text, or null when the
 * formatter cannot show it: an empty result, or the plain digits back for a format that is not decimal. */
export function numberIn(n, fmt, format) {
  const t = format(n, fmt);
  if (!t) return null;
  return fmt !== 'decimal' && t === String(n) ? null : t;
}

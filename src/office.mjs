// The shared Office set (docs/plans/document.md dataModel): units, font sizes, fonts, theme colours, highlights, underlines,
// spacing, paper and numbering that Document, Presentation and Spreadsheet share. Pure, no imports: Node tests and every
// format's code read it. Lengths are points; each file format's unit is converted at its edge (twips, half-points, eighths,
// EMU). Colours are '#RRGGBB' uppercase; a theme colour is {slot, lum} next to it (lum < 0 darkens, > 0 lightens).

// ---------- Units ----------
export const ptToTwips = (pt) => Math.round(pt * 20);
export const ptToHalfPoints = (pt) => Math.round(pt * 2);
export const ptToEighths = (pt) => Math.round(pt * 8);
export const ptToEmu = (pt) => Math.round(pt * 12700);
export const ptToPx = (pt) => (pt * 4) / 3;
export const pxToPt = (px) => px * 0.75;

// ---------- Font sizes ----------
// Word's size list; a typed size is 1-1638 in 0.5 steps.
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
export const MIN_SIZE = 1;
export const MAX_SIZE = 1638;
const clampSize = (pt) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(pt * 2) / 2));

/** Grow font (Ctrl+Shift+.): the next listed size, past 72 the next multiple of 10, as Word does. */
export function growSize(pt) {
  const next = FONT_SIZES.find((s) => s > pt);
  return clampSize(next ?? Math.floor(pt / 10) * 10 + 10);
}

/** Shrink font (Ctrl+Shift+,): the previous listed size, past 72 the previous multiple of 10, below 8 one point less. */
export function shrinkSize(pt) {
  if (pt > 80) return clampSize(Math.ceil(pt / 10) * 10 - 10);
  const prev = FONT_SIZES.findLast((s) => s < pt);
  return clampSize(prev ?? pt - 1);
}

/** Ctrl+] and Ctrl+[: one point up or down (`d` is 1 or -1). */
export const size1 = (pt, d) => clampSize(pt + d);

// ---------- Fonts ----------
/** The curated font list (the Windows 11 base fonts plus Office's theme fonts), shown before the installed families. */
export const FONTS = ['Aptos', 'Aptos Display', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Calibri Light', 'Cambria', 'Candara',
  'Cascadia Code', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact', 'Lucida Console',
  'Segoe Print', 'Segoe Script', 'Segoe UI', 'Sitka Text', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

/** Metric-compatible fallbacks, so a machine without the font keeps the line breaks (no Microsoft font is bundled). */
export const FALLBACKS = {
  Aptos: ['Calibri', 'Carlito'],
  'Aptos Display': ['Calibri Light', 'Calibri', 'Carlito'],
  Calibri: ['Carlito'],
  'Calibri Light': ['Calibri', 'Carlito'],
  Cambria: ['Caladea'],
  Arial: ['Liberation Sans'],
  'Times New Roman': ['Liberation Serif'],
  'Courier New': ['Liberation Mono'],
};
const SERIF = new Set(['Cambria', 'Caladea', 'Times New Roman', 'Liberation Serif', 'Georgia', 'Constantia', 'Sitka Text']);
const MONO = new Set(['Courier New', 'Liberation Mono', 'Consolas', 'Cascadia Code', 'Lucida Console']);

/** The CSS font-family of `name` ('+major' and '+minor' are the theme's heading and body fonts), with its fallbacks and a
 * generic family. */
export function fontStack(name, theme) {
  const family = name === '+major' ? theme?.fonts?.major ?? 'Aptos Display' : name === '+minor' ? theme?.fonts?.minor ?? 'Aptos' : name;
  const generic = SERIF.has(family) ? 'serif' : MONO.has(family) ? 'monospace' : 'sans-serif';
  return [family, ...(FALLBACKS[family] ?? [])].map((f) => `"${f.replace(/["\\]/g, '')}"`).concat(generic).join(', ');
}

// ---------- Colours ----------
/** The theme's colour slots in theme1.xml order. */
export const THEME_SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
// Word's w:themeColor names for the slots.
const WORD_SLOT = { dk1: 'text1', lt1: 'background1', dk2: 'text2', lt2: 'background2', hlink: 'hyperlink', folHlink: 'followedHyperlink' };

/** The 10 x 6 theme colour grid (the font colour menu): per column its slot and the five lum steps under the base colour.
 * The accent and Text 1 steps are Word's (checked against the probe's styles: shade BF, tint A6, BF, D8); the Background 1,
 * Background 2 and Text 2 steps are unverified. */
const ACCENT = [0.8, 0.6, 0.4, -0.25, -0.5];
export const THEME_GRID = [
  { slot: 'lt1', lums: [-0.05, -0.15, -0.25, -0.35, -0.5] },
  { slot: 'dk1', lums: [0.5, 0.35, 0.25, 0.15, 0.05] },
  { slot: 'lt2', lums: [-0.1, -0.25, -0.5, -0.75, -0.9] },
  { slot: 'dk2', lums: [0.9, 0.75, 0.5, 0.25, -0.5] },
  ...['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((slot) => ({ slot, lums: ACCENT })),
];

/** Word's Standard Colors row. */
export const STANDARD_COLORS = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];

const hexOf = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function toHsl([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)].map((v) => v * 255);
}

/** The '#RRGGBB' of theme colour {slot, lum} in `theme` ({colors: {slot: hex}}): the slot's HSL luminance scaled by 1 + lum
 * (darker) or moved lum of the way to white (lighter), as Office's themeShade / themeTint and lumMod / lumOff do. */
export function resolveColor(theme, { slot, lum = 0 }) {
  const base = theme.colors[slot];
  if (!lum) return base.toUpperCase();
  const [h, s, l] = toHsl(rgbOf(base));
  return hexOf(fromHsl([h, s, lum < 0 ? l * (1 + lum) : l * (1 - lum) + lum]));
}

/** Word's w:color attributes for `color` and its theme link: {val, themeColor?, themeTint? | themeShade?} (the byte as 2 hex digits). */
export function toWordColor(color, themeColor) {
  if (!themeColor) return { val: color ? color.slice(1).toUpperCase() : 'auto' };
  const out = { val: color.slice(1).toUpperCase(), themeColor: WORD_SLOT[themeColor.slot] ?? themeColor.slot };
  const lum = themeColor.lum ?? 0;
  if (lum) out[lum < 0 ? 'themeShade' : 'themeTint'] = Math.round((1 - Math.abs(lum)) * 255).toString(16).toUpperCase().padStart(2, '0');
  return out;
}

/** DrawingML's scheme colour (PowerPoint): {scheme, lumMod?, lumOff?} in 100000ths. */
export function toDrawingColor({ slot, lum = 0 }) {
  if (!lum) return { scheme: slot };
  if (lum < 0) return { scheme: slot, lumMod: Math.round((1 + lum) * 100000) };
  return { scheme: slot, lumMod: Math.round((1 - lum) * 100000), lumOff: Math.round(lum * 100000) };
}

/** Excel's theme colour: {theme: index in THEME_SLOTS order with dk1/lt1 and dk2/lt2 swapped (Excel's order), tint -1..1}. */
export function toExcelTint({ slot, lum = 0 }) {
  const order = ['lt1', 'dk1', 'lt2', 'dk2', ...THEME_SLOTS.slice(4)];
  return { theme: order.indexOf(slot), tint: lum };
}

/** Word's 16 highlight colours (ST_HighlightColor) by name. */
export const HIGHLIGHTS = {
  yellow: '#FFFF00', green: '#00FF00', cyan: '#00FFFF', magenta: '#FF00FF', blue: '#0000FF', red: '#FF0000', darkBlue: '#000080',
  darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080',
  lightGray: '#C0C0C0', black: '#000000', white: '#FFFFFF',
};
/** The highlight menu: every highlight but white, in Word's order. */
export const HIGHLIGHT_MENU = Object.keys(HIGHLIGHTS).filter((n) => n !== 'white');

/** The 17 ST_Underline styles ('none' is no underline). */
export const UNDERLINES = ['single', 'words', 'double', 'thick', 'dotted', 'dottedHeavy', 'dash', 'dashedHeavy', 'dashLong', 'dashLongHeavy',
  'dotDash', 'dashDotHeavy', 'dotDotDash', 'dashDotDotHeavy', 'wave', 'wavyHeavy', 'wavyDouble'];

// ---------- Paragraphs ----------
/** Line spacing multiples in the spacing menu. */
export const LINE_SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3];
/** Increase and Decrease indent move the left indent this many points (0.5 in). */
export const INDENT_STEP = 36;

// ---------- Page ----------
/** Layout > Margins presets, in points. */
export const MARGIN_PRESETS = {
  normal: { label: 'Normal', top: 72, right: 72, bottom: 72, left: 72 },
  narrow: { label: 'Narrow', top: 36, right: 36, bottom: 36, left: 36 },
  moderate: { label: 'Moderate', top: 72, right: 54, bottom: 72, left: 54 },
  wide: { label: 'Wide', top: 72, right: 144, bottom: 72, left: 144 },
  office2003: { label: 'Office 2003', top: 72, right: 90, bottom: 72, left: 90 },
};
/** Layout > Size, in points from Word's twips (A4 11906 x 16838). */
export const PAPER_SIZES = {
  letter: { label: 'Letter', w: 612, h: 792 },
  legal: { label: 'Legal', w: 612, h: 1008 },
  a4: { label: 'A4', w: 595.3, h: 841.9 },
  a5: { label: 'A5', w: 419.55, h: 595.3 },
  executive: { label: 'Executive', w: 522, h: 756 },
};

// ---------- Numbering ----------
export const NUMBER_FORMATS = ['decimal', 'lowerLetter', 'upperLetter', 'lowerRoman', 'upperRoman'];

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = (n) => ROMAN.reduce((s, [v, r]) => {
  for (; n >= v; n -= v) s += r;
  return s;
}, '');
// Word's letters repeat after z: 27 is aa, 53 is aaa.
const letter = (n) => String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.ceil(n / 26));

/** The label of item `n` (from 1) in number format `fmt`. */
export function numberLabel(n, fmt) {
  switch (fmt) {
    case 'lowerLetter': return letter(n);
    case 'upperLetter': return letter(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    default: return String(n);
  }
}

// ---------- Agent arguments ----------
// doc.format's run and paragraph objects (docs/plans/document.md agentsAndTools), as JSON Schema in the command layer's subset
// (app/schema.mjs validates them; commands-contract checks the examples). Points and '#RRGGBB'. Long value lists are patterns,
// which the models' form of a tool leaves out (MAX_TOOL), with the common values in the description. A typed size goes to the
// nearest half point when applied (the subset has no multipleOf). Theme lum spans what THEME_GRID uses.
const PT = (min, max) => ({ type: 'number', minimum: min, maximum: max });
const oneOf = (names) => `^(${names.join('|')})$`;
export const RUN_ARGS = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: {
    font: { type: 'string', minLength: 1, maxLength: 64, description: 'Family, or +major / +minor (theme)' },
    sizePt: PT(MIN_SIZE, MAX_SIZE),
    color: {
      description: '#RRGGBB, {"theme":"accent1","lum":-0.25}, or null (Automatic)',
      anyOf: [
        { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        { type: 'object', required: ['theme'], additionalProperties: false, properties: { theme: { type: 'string', pattern: oneOf(THEME_SLOTS) }, lum: PT(-0.95, 0.95) } },
        { type: 'null' },
      ],
    },
    highlight: { enum: [...Object.keys(HIGHLIGHTS), null] },
    underline: { type: 'string', pattern: oneOf([...UNDERLINES, 'none']), description: 'single, double, dotted, wave, none...' },
  },
};
export const PARA_ARGS = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: {
    style: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]{0,63}$', description: 'Normal, Title, Heading1, Quote...' },
    spaceBeforePt: PT(0, 1584),
    spaceAfterPt: PT(0, 1584),
    lineSpacing: {
      type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1, description: 'One of multiple, exactPt, atLeastPt',
      properties: { multiple: PT(0.06, 132), exactPt: PT(0.7, 1584), atLeastPt: PT(0.7, 1584) },
    },
    indent: {
      type: 'object', additionalProperties: false, minProperties: 1, description: 'firstLinePt < 0: hanging',
      properties: { leftPt: PT(-1584, 1584), rightPt: PT(-1584, 1584), firstLinePt: PT(-1584, 1584) },
    },
    list: {
      type: 'object', required: ['kind'], additionalProperties: false,
      properties: { kind: { enum: ['bullet', 'number', null], description: 'null: no list' }, level: { type: 'integer', minimum: 0, maximum: 8 } },
    },
  },
};

// Formatting change describer (docs/plans/word plan.md §3 markup): the text of a formatting balloon and a Reviewing pane row,
// in Word's words ("Formatted: Font: Bold, Not Italic", "Formatted: Font color: Red"). Pure: node tests load it.

// Marks that carry no run formatting: review and link marks never show in a formatting description.
const SKIP = new Set(['insertion', 'deletion', 'formatChange', 'comment', 'permission', 'link']);
// Word's names for the standard colours of the font colour menu; any other colour reads as Custom Color(RGB(r,g,b)).
const COLOR_NAMES = {
  '#FF0000': 'Red', '#C00000': 'Dark Red', '#FFC000': 'Orange', '#FFFF00': 'Yellow', '#92D050': 'Light Green', '#00B050': 'Green',
  '#00B0F0': 'Light Blue', '#0070C0': 'Blue', '#002060': 'Dark Blue', '#7030A0': 'Purple', '#000000': 'Black', '#FFFFFF': 'White',
};
const FONT_NAMES = { '+major': '+Headings', '+minor': '+Body' };

const nameOf = (m) => m?.type?.name ?? m?.type;
const attrsOf = (m) => m?.attrs ?? {};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const words = (camel) => camel.replace(/([A-Z])/g, ' $1').toLowerCase();

/** The run formatting `marks` (ProseMirror marks or mark JSON) set → {bold, italic, strike, subscript, superscript, underline, font,
 * size, color, highlight}, each false or null when unset. */
export function runProps(marks = []) {
  const p = { bold: false, italic: false, strike: false, subscript: false, superscript: false, underline: null, font: null, size: null, color: null, highlight: null };
  for (const m of marks ?? []) {
    const name = nameOf(m);
    if (SKIP.has(name)) continue;
    const a = attrsOf(m);
    if (name in p && typeof p[name] === 'boolean') p[name] = true;
    else if (name === 'underline') p.underline = a.val ?? 'single';
    else if (name === 'textStyle') {
      p.font = a.font ?? null;
      p.size = a.size ?? null;
      p.color = a.themeColor ? `theme:${a.themeColor.slot ?? a.themeColor}` : a.color ?? null;
      p.highlight = a.highlight ?? null;
    }
  }
  return p;
}

/** Colour value `c` ('#RRGGBB', 'theme:accent1' or null) as Word names it in a balloon. */
export function colorName(c) {
  if (!c) return 'Auto';
  if (c.startsWith('theme:')) {
    const slot = c.slice(6);
    const m = /^accent(\d)$/.exec(slot);
    return m ? `Accent ${m[1]}` : cap(words(slot));
  }
  const hex = c.toUpperCase();
  if (COLOR_NAMES[hex]) return COLOR_NAMES[hex];
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return rgb.some(Number.isNaN) ? c : `Custom Color(RGB(${rgb.join(',')}))`;
}

const underlineName = (val) => (!val || val === 'none' ? 'No underline' : val === 'single' ? 'Underline' : `${cap(words(val))} underline`);
const flag = (on, yes, no) => (on ? yes : no);

/** What changed from `old` marks to `now` marks, in Word's balloon words: 'Formatted: Font: Bold, Not Italic', or 'Formatted' when
 * nothing that we describe differs. */
export function describe(old, now) {
  const a = runProps(old);
  const b = runProps(now);
  const font = [];
  if (a.font !== b.font) font.push(b.font ? FONT_NAMES[b.font] ?? b.font : '(Default)');
  if (a.size !== b.size) font.push(b.size ? `${b.size} pt` : `Not ${a.size} pt`);
  if (a.bold !== b.bold) font.push(flag(b.bold, 'Bold', 'Not Bold'));
  if (a.italic !== b.italic) font.push(flag(b.italic, 'Italic', 'Not Italic'));
  if (a.underline !== b.underline) font.push(underlineName(b.underline));
  if (a.strike !== b.strike) font.push(flag(b.strike, 'Strikethrough', 'Not Strikethrough'));
  if (a.superscript !== b.superscript) font.push(flag(b.superscript, 'Superscript', 'Not Superscript'));
  if (a.subscript !== b.subscript) font.push(flag(b.subscript, 'Subscript', 'Not Subscript'));
  const parts = font.length ? [`Font: ${font.join(', ')}`] : [];
  if (a.color !== b.color) parts.push(`Font color: ${colorName(b.color)}`);
  if (a.highlight !== b.highlight) parts.push(b.highlight ? 'Highlight' : 'Not Highlight');
  return parts.length ? `Formatted: ${parts.join(', ')}` : 'Formatted';
}

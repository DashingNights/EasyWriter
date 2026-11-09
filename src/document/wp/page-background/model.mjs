// Page background data and geometry (docs/plans/word briefs/page-background.md): the watermark gallery, Auto watermark sizes, the
// sections a watermark reaches, page border boxes, the CSS of gradients, patterns, textures and rule lines. Pure, so node tests
// read it; the layers and dialogs draw through it.
import { ptToPx } from '../../../office.mjs';
import { hexOf, rgbOf } from '../../../tooling/kit/color.mjs';

// ---------------------------------------------------------------------------------------------
// Watermarks

/** Word's gallery: [heading, [id, text, layout]]; 1 is diagonal and 2 horizontal. The words are generic, the drawing is ours. */
export const WATERMARK_GALLERY = [
  ['Confidential', [['confidential1', 'CONFIDENTIAL', 'diagonal'], ['confidential2', 'CONFIDENTIAL', 'horizontal'],
    ['doNotCopy1', 'DO NOT COPY', 'diagonal'], ['doNotCopy2', 'DO NOT COPY', 'horizontal']]],
  ['Disclaimers', [['draft1', 'DRAFT', 'diagonal'], ['draft2', 'DRAFT', 'horizontal'], ['sample1', 'SAMPLE', 'diagonal'],
    ['sample2', 'SAMPLE', 'horizontal']]],
  ['Urgent', [['asap1', 'ASAP', 'diagonal'], ['asap2', 'ASAP', 'horizontal'], ['urgent1', 'URGENT', 'diagonal'],
    ['urgent2', 'URGENT', 'horizontal']]],
];

/** The Text list of the Printed Watermark dialog (probe/dialogs/printed-watermark.json). */
export const WATERMARK_TEXTS = ['ASAP', 'CONFIDENTIAL', 'COPY', 'DO NOT COPY', 'DRAFT', 'ORIGINAL', 'PERSONAL', 'SAMPLE', 'TOP SECRET', 'URGENT'];
/** Its Size list; null is Auto. */
export const WATERMARK_SIZES = [null, 36, 40, 44, 48, 54, 60, 66, 72, 80, 90, 96, 105, 120, 144];
/** Its picture Scale list in percent; null is Auto. */
export const WATERMARK_SCALES = [null, 500, 200, 150, 100, 50];
/** The gallery's text colour: Word's gallery watermarks are light grey and semitransparent (v). */
export const GALLERY_COLOR = '#C0C0C0';

/** The text watermark of gallery item `id` in `font` → a sect.watermark, or null for an unknown id. */
export function galleryWatermark(id, font) {
  for (const [, items] of WATERMARK_GALLERY) {
    const hit = items.find(([i]) => i === id);
    if (hit) return { kind: 'text', text: hit[1], font, size: null, color: GALLERY_COLOR, semi: true, layout: hit[2] };
  }
  return null;
}

/** The gallery item id that `wm` matches (text and layout, Auto size, gallery colour), or null. */
export function galleryIdOf(wm) {
  if (wm?.kind !== 'text' || wm.size != null || (wm.color ?? GALLERY_COLOR).toUpperCase() !== GALLERY_COLOR || wm.semi === false) return null;
  for (const [, items] of WATERMARK_GALLERY) {
    const hit = items.find(([, text, layout]) => text === wm.text && layout === (wm.layout ?? 'diagonal'));
    if (hit) return hit[0];
  }
  return null;
}

/** The patch that turns any stored watermark into `wm`: keys of the other kind are removed (null), so a picture's data URL does
 * not stay behind a text watermark, while keys this build does not know survive (plan.md §1.8). */
export function watermarkPatch(wm) {
  const text = { text: null, font: null, size: null, color: null, semi: null, layout: null };
  const picture = { src: null, scale: null, washout: null };
  return { watermark: { ...(wm.kind === 'picture' ? text : picture), ...wm } };
}

/** Line height of the watermark's text as a share of its size. */
const LINE = 1.2;

/** The Auto font size (pt) of a text watermark: `perPt` is the text's width at 1 pt, `w` and `h` the margins box (pt). Horizontal
 * text fills the box's width; diagonal text, turned 45 degrees, fits its run and its line height inside the box (the run crosses
 * the box along its diagonal). Clamped to Word's 1 to 1638 pt. */
export function autoWatermarkSize(perPt, w, h, layout = 'diagonal') {
  if (!(perPt > 0) || !(w > 0) || !(h > 0)) return 36;
  const size = layout === 'horizontal' ? Math.min(w / perPt, h / LINE) : (Math.min(w, h) * Math.SQRT2) / (perPt + LINE);
  return Math.max(1, Math.min(1638, Math.floor(size * 10) / 10));
}

/** The sections a watermark written in section `i` reaches: `i` and every following section whose header is linked to the one
 * before it (sect.hdr null), as Word anchors a watermark in each section's header. `sections`: sectionsOf(doc). */
export function watermarkSections(sections, i) {
  const out = [i];
  for (let j = i + 1; j < sections.length && sections[j].sect.hdr == null; j++) out.push(j);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Page borders

/** Whether sect.pgBorders `b` draws on the page that is `inSection` (0-based) in its section. */
export function bordersShowOn(b, inSection) {
  if (!b) return false;
  const display = b.display ?? 'allPages';
  return display === 'firstPage' ? inSection === 0 : display === 'notFirstPage' ? inSection > 0 : true;
}

const SIDES = ['top', 'right', 'bottom', 'left'];
const isSide = (s) => !!s && s.style && s.style !== 'none' && s.style !== 'nil';

/** The outer edge of each drawn border side, in pt from the paper's edges → {top, right, bottom, left} (null for an undrawn side),
 * or null when nothing draws. Measured from the page: `space` (Word's default 24 pt) from the paper edge to the line's outer edge.
 * From the text: `space` from the margins box to the line's inner edge, the top and bottom moved out to take the header and
 * footer in unless `settings` says bordersDoNotSurroundHeader or bordersDoNotSurroundFooter. `margin`: sect.margin (pt). */
export function borderBox(b, margin, settings = {}) {
  if (!b || !SIDES.some((s) => isSide(b[s]))) return null;
  const out = {};
  for (const side of SIDES) {
    const e = b[side];
    if (!isSide(e)) {
      out[side] = null;
      continue;
    }
    if (b.offsetFrom === 'text') {
      let edge = margin?.[side] ?? 72;
      if (side === 'top' && !settings.bordersDoNotSurroundHeader) edge = Math.min(edge, margin?.header ?? edge);
      if (side === 'bottom' && !settings.bordersDoNotSurroundFooter) edge = Math.min(edge, margin?.footer ?? edge);
      out[side] = Math.max(0, edge - (e.space ?? (side === 'top' || side === 'bottom' ? 1 : 4)) - (e.width ?? 0.5));
    } else out[side] = e.space ?? 24;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Colours

/** A colour's [r, g, b], white when it is not '#RRGGBB'. */
const rgb = (hex) => rgbOf(hex) ?? [255, 255, 255];
/** `a` mixed toward `b` by `t` (0: a, 1: b) → '#RRGGBB'. */
export const mixHex = (a, b, t) => hexOf(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
/** `hex` with alpha (0 to 1) as CSS rgba(). */
const rgba = (hex, a = 1) => (a >= 1 ? hex : `rgba(${rgb(hex).join(', ')}, ${Math.round(a * 1000) / 1000})`);

/** Whether text in the automatic colour turns white on page colour `hex`: Word draws automatic text white on a dark page (v; the
 * threshold is ours, the WCAG relative luminance under 0.18). */
export function isDark(hex) {
  if (!hex) return false;
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18;
}

// ---------------------------------------------------------------------------------------------
// Fill effects (background.fill = {kind: 'gradient' | 'texture' | 'pattern' | 'picture', ...}; plan.md §1.6 names the key kind)

/** Gradient shading styles in the dialog's order. */
export const SHADING_STYLES = [['horizontal', 'Hori&zontal'], ['vertical', '&Vertical'], ['diagonalUp', 'Diagonal &up'],
  ['diagonalDown', 'Diagonal &down'], ['fromCorner', '&From corner'], ['fromCenter', 'Fro&m center']];

/** Preset gradients: our own colour stops under generic names. */
export const GRADIENT_PRESETS = [
  ['earlySunset', 'Early Sunset', ['#1B1F5E', '#7A2E8C', '#F07F3C']],
  ['lateSunset', 'Late Sunset', ['#2B1055', '#D53A6B', '#FFB347']],
  ['nightfall', 'Nightfall', ['#000000', '#1F2A6B', '#3C3C9E']],
  ['daybreak', 'Daybreak', ['#5E9CE6', '#FFF4C2']],
  ['horizon', 'Horizon', ['#DCEBFA', '#7DB3E8', '#DCC48E', '#A2742C']],
  ['desert', 'Desert', ['#FBE7C6', '#E8A15C', '#A25B2A']],
  ['ocean', 'Ocean', ['#0B4F7C', '#13A3C9', '#9BE3F2']],
  ['calmWater', 'Calm Water', ['#C9E7F2', '#7FB8D6', '#C9E7F2']],
  ['fire', 'Fire', ['#FFF000', '#FF8A00', '#C80000']],
  ['fog', 'Fog', ['#E9EDF0', '#B5C0C8']],
  ['moss', 'Moss', ['#D7E8B0', '#5E8C31']],
  ['peacock', 'Peacock', ['#1E7A6B', '#2E5DA8', '#6C3D9E']],
  ['wheat', 'Wheat', ['#FBF0D0', '#DDBD73']],
  ['parchment', 'Parchment', ['#FFF6DE', '#E3CDA0']],
  ['mahogany', 'Mahogany', ['#E3B48F', '#6B2A17']],
  ['rainbow', 'Rainbow', ['#E40303', '#FF8C00', '#FFED00', '#008026', '#004DFF', '#750787']],
  ['rainbow2', 'Rainbow II', ['#FF4F9A', '#FFD23F', '#3BCEAC', '#4F7BFF']],
  ['gold', 'Gold', ['#F7E7A1', '#C79A2E', '#F7E7A1']],
  ['gold2', 'Gold II', ['#FFF3C4', '#E0B848']],
  ['brass', 'Brass', ['#8A6A1F', '#E2C46B', '#8A6A1F']],
  ['chrome', 'Chrome', ['#FFFFFF', '#8C8C8C', '#FFFFFF', '#5A5A5A']],
  ['chrome2', 'Chrome II', ['#D9D9D9', '#FFFFFF', '#7F7F7F']],
  ['silver', 'Silver', ['#F2F2F2', '#B3B3B3']],
  ['sapphire', 'Sapphire', ['#0A1B5C', '#3A6BD6', '#0A1B5C']],
];

/** A gradient fill's colour stops (CSS colours, first to last before the variant applies). One colour shades `color1` toward
 * black (shade 0) or white (shade 1); 0.5 keeps it. Transparency `from` and `to` are percents (0 opaque). */
export function gradientStops(f) {
  if (f.colors === 'preset') {
    const p = GRADIENT_PRESETS.find(([id]) => id === f.preset) ?? GRADIENT_PRESETS[0];
    const n = p[2].length;
    return p[2].map((c, i) => rgba(c, 1 - ((f.from ?? 0) + (((f.to ?? 0) - (f.from ?? 0)) * i) / (n - 1)) / 100));
  }
  const c1 = f.color1 ?? '#4472C4';
  const shade = f.shade ?? 0.5;
  const c2 = f.colors === 'two' ? f.color2 ?? '#FFFFFF' : shade < 0.5 ? mixHex(c1, '#000000', (0.5 - shade) * 2) : mixHex(c1, '#FFFFFF', (shade - 0.5) * 2);
  return [rgba(c1, 1 - (f.from ?? 0) / 100), rgba(c2, 1 - (f.to ?? 0) / 100)];
}

// Word's Diagonal up runs its first stop from the top left, Diagonal down from the bottom left (measured on Word's own PDF).
const ANGLES = { horizontal: 180, vertical: 90, diagonalUp: 135, diagonalDown: 45 };
const CORNERS = ['top left', 'top right', 'bottom left', 'bottom right'];

/** The CSS background-image of gradient fill `f`: {style, variant 0 to 3}. Linear styles: variant 0 runs the stops forward, 1
 * backward, 2 forward and back (the last stop in the middle), 3 backward and forward. From corner: variant picks the corner. From
 * center: variant 0 the first stop in the middle, 1 the last. */
export function gradientCss(f) {
  const stops = gradientStops(f);
  const v = f.variant ?? 0;
  if (f.style === 'fromCorner') return `radial-gradient(circle farthest-corner at ${CORNERS[v] ?? CORNERS[0]}, ${stops.join(', ')})`;
  if (f.style === 'fromCenter') return `radial-gradient(ellipse farthest-corner at center, ${(v % 2 ? [...stops].reverse() : stops).join(', ')})`;
  const back = [...stops].reverse();
  const list = v === 1 ? back : v === 2 ? [...stops, ...back.slice(1)] : v === 3 ? [...back, ...stops.slice(1)] : stops;
  return `linear-gradient(${ANGLES[f.style] ?? 180}deg, ${list.join(', ')})`;
}

// Patterns: 48 8 x 8 tiles in the dialog's grid order (column by column, as Word's grid reads), each a predicate of the bit at
// (x, y), drawn by us. The ids are the OOXML preset pattern names (a:prstDash's sibling ST_PresetPatternVal).
const BAYER = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
const pct = (n) => (x, y) => BAYER[y][x] < (n * 64) / 100;
const m = (v, n) => ((v % n) + n) % n;
const pts = (list) => (x, y) => list.some(([a, b]) => a === x && b === y);
const WAVE = [0, 0, 1, 2, 2, 2, 1, 0];
/** [id, label, bit(x, y)] */
export const PATTERNS = [
  ['pct5', '5%', pct(5)], ['pct10', '10%', pct(10)], ['pct20', '20%', pct(20)], ['pct25', '25%', pct(25)], ['pct30', '30%', pct(30)],
  ['pct40', '40%', pct(40)],
  ['pct50', '50%', pct(50)], ['pct60', '60%', pct(60)], ['pct70', '70%', pct(70)], ['pct75', '75%', pct(75)], ['pct80', '80%', pct(80)],
  ['pct90', '90%', pct(90)],
  ['ltDnDiag', 'Light downward diagonal', (x, y) => m(x - y, 4) === 0], ['ltUpDiag', 'Light upward diagonal', (x, y) => m(x + y, 4) === 0],
  ['dkDnDiag', 'Dark downward diagonal', (x, y) => m(x - y, 4) < 2], ['dkUpDiag', 'Dark upward diagonal', (x, y) => m(x + y, 4) < 2],
  ['wdDnDiag', 'Wide downward diagonal', (x, y) => m(x - y, 8) < 3], ['wdUpDiag', 'Wide upward diagonal', (x, y) => m(x + y, 8) < 3],
  ['ltVert', 'Light vertical', (x) => x % 4 === 0], ['ltHorz', 'Light horizontal', (x, y) => y % 4 === 0],
  ['narVert', 'Narrow vertical', (x) => x % 2 === 0], ['narHorz', 'Narrow horizontal', (x, y) => y % 2 === 0],
  ['dkVert', 'Dark vertical', (x) => x % 4 < 2], ['dkHorz', 'Dark horizontal', (x, y) => y % 4 < 2],
  ['dashDnDiag', 'Dashed downward diagonal', (x, y) => m(x - y, 4) === 0 && y % 8 < 4],
  ['dashUpDiag', 'Dashed upward diagonal', (x, y) => m(x + y, 4) === 0 && y % 8 < 4],
  ['dashHorz', 'Dashed horizontal', (x, y) => y % 4 === 0 && m(x + (y % 8 === 4 ? 4 : 0), 8) < 4],
  ['dashVert', 'Dashed vertical', (x, y) => x % 4 === 0 && m(y + (x % 8 === 4 ? 4 : 0), 8) < 4],
  ['smConfetti', 'Small confetti', pts([[0, 0], [4, 1], [2, 3], [7, 3], [5, 5], [1, 6], [3, 7], [6, 7]])],
  ['lgConfetti', 'Large confetti', (x, y) => [[0, 0], [5, 1], [2, 4], [6, 5]].some(([a, b]) => m(x - a, 8) < 2 && m(y - b, 8) < 2)],
  ['zigZag', 'Zigzag', (x, y) => m(y - [0, 1, 2, 1][x % 4], 4) === 0], ['wave', 'Wave', (x, y) => m(y - WAVE[x], 4) === 0],
  ['diagBrick', 'Diagonal brick', (x, y) => m(x + y, 8) === 0 || (m(x - y, 8) === 0 && m(x + y, 8) < 4)],
  ['horzBrick', 'Horizontal brick', (x, y) => y % 4 === 0 || x % 8 === (y % 8 < 4 ? 0 : 4)],
  ['weave', 'Weave', (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0 ? m(x + y, 4) === 0 : m(x - y, 4) === 0],
  ['plaid', 'Plaid', (x, y) => (y % 8 < 2 && x % 2 === 0) || (x % 8 < 2 && y % 2 === 0) || (y % 8 < 2 && x % 8 < 2)],
  ['divot', 'Divot', pts([[1, 1], [2, 2], [3, 1], [5, 5], [6, 6], [7, 5]])],
  ['dotGrid', 'Dotted grid', (x, y) => (y % 8 === 0 && x % 2 === 0) || (x % 8 === 0 && y % 2 === 0)],
  ['dotDmnd', 'Dotted diamond', (x, y) => x % 2 === 0 && (m(x + y, 8) === 0 || m(x - y, 8) === 0)],
  ['shingle', 'Shingle', (x, y) => (y % 4 === 0 && x % 8 < 6) || (x % 8 === 6 && y % 4 === 1)],
  ['trellis', 'Trellis', (x, y) => m(x + y, 4) === 0 || m(x - y, 4) === 0],
  ['sphere', 'Sphere', (x, y) => {
    const d = (x - 3.5) ** 2 + (y - 3.5) ** 2;
    return d > 5 && d < 13;
  }],
  ['smGrid', 'Small grid', (x, y) => x % 4 === 0 || y % 4 === 0], ['lgGrid', 'Large grid', (x, y) => x % 8 === 0 || y % 8 === 0],
  ['smCheck', 'Small checker board', (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0],
  ['lgCheck', 'Large checker board', (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0],
  ['openDmnd', 'Outlined diamond', (x, y) => m(x + y, 8) === 0 || m(x - y, 8) === 0],
  ['solidDmnd', 'Solid diamond', (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) <= 3.5],
];

const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/** The 8 x 8 bits of pattern `id` as rows of '0' and '1' (tests, the dialog's grid). */
export function patternBits(id) {
  const p = PATTERNS.find(([i]) => i === id) ?? PATTERNS[0];
  return Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => (p[2](x, y) ? '1' : '0')).join(''));
}

/** The CSS background of pattern fill {pattern, fg, bg}: an 8 px SVG tile of the foreground's bits over the background colour. */
export function patternCss({ pattern, fg = '#000000', bg = '#FFFFFF' } = {}) {
  const rects = [];
  patternBits(pattern).forEach((row, y) => [...row].forEach((b, x) => b === '1' && rects.push(`M${x} ${y}h1v1h-1z`)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" shape-rendering="crispEdges"><rect width="8" height="8" fill="${bg}"/>`
    + `<path d="${rects.join('')}" fill="${fg}"/></svg>`;
  return { image: svgUrl(svg), size: '8px 8px', repeat: 'repeat' };
}

// Textures: our own tiles, SVG noise tinted per texture, never Word's images. [id, label, base, ink, kind, frequency, octaves]
export const TEXTURES = [
  ['papyrus', 'Papyrus', '#E9D9A6', '#8A7240', 'fractalNoise', '0.02 0.4', 3], ['canvas', 'Canvas', '#D9CFB8', '#6B604A', 'fractalNoise', '0.6 0.6', 2],
  ['denim', 'Denim', '#3B5C8C', '#14243D', 'fractalNoise', '0.9 0.12', 2], ['wovenMat', 'Woven mat', '#D8C089', '#6E5521', 'turbulence', '0.25 0.25', 2],
  ['waterDroplets', 'Water droplets', '#A9C7D9', '#3E6680', 'turbulence', '0.08', 2], ['paperBag', 'Paper bag', '#C7A47A', '#6E4F2B', 'fractalNoise', '0.5', 4],
  ['fishFossil', 'Fish fossil', '#D3C6B0', '#6C5E48', 'turbulence', '0.04', 4], ['sand', 'Sand', '#E6D3A8', '#9C8352', 'fractalNoise', '0.9', 3],
  ['greenMarble', 'Green marble', '#2F6B4F', '#0E2A1D', 'turbulence', '0.02 0.05', 5], ['whiteMarble', 'White marble', '#F2F0EC', '#9B9890', 'turbulence', '0.015 0.04', 5],
  ['brownMarble', 'Brown marble', '#8E6A4B', '#3A2716', 'turbulence', '0.02 0.05', 5], ['granite', 'Granite', '#9A9A9A', '#3A3A3A', 'fractalNoise', '0.7', 4],
  ['newsprint', 'Newsprint', '#E8E6DF', '#7A776E', 'fractalNoise', '0.8', 2], ['recycledPaper', 'Recycled paper', '#DED8C8', '#857C66', 'fractalNoise', '0.35', 4],
  ['parchment', 'Parchment', '#F1E2BC', '#A88B4E', 'fractalNoise', '0.03', 4], ['stationery', 'Stationery', '#EFEAD9', '#ADA48A', 'fractalNoise', '0.2', 3],
  ['blueTissue', 'Blue tissue paper', '#C9DBF2', '#6C8DBA', 'fractalNoise', '0.05', 3], ['pinkTissue', 'Pink tissue paper', '#F5D2DE', '#B97A8F', 'fractalNoise', '0.05', 3],
  ['purpleMesh', 'Purple mesh', '#7B5C9E', '#2E1D45', 'turbulence', '0.3 0.3', 1], ['bouquet', 'Bouquet', '#E8D5C9', '#A0526B', 'turbulence', '0.06', 3],
  ['cork', 'Cork', '#B98A57', '#5A3B1C', 'fractalNoise', '0.25', 4], ['walnut', 'Walnut', '#6B4A2F', '#2A1A0E', 'fractalNoise', '0.01 0.25', 4],
  ['oak', 'Oak', '#C69C6D', '#6E4A26', 'fractalNoise', '0.01 0.2', 4], ['mediumWood', 'Medium wood', '#A8744A', '#4D2E15', 'fractalNoise', '0.015 0.3', 3],
];

/** The CSS background of texture fill {texture, src}: a picture (Other Texture...) tiled at its size, else our 96 px noise tile. */
export function textureCss({ texture, src } = {}) {
  if (src) return { image: `url("${src}")`, size: 'auto', repeat: 'repeat' };
  const t = TEXTURES.find(([id]) => id === texture) ?? TEXTURES[0];
  const [r, g, b] = rgb(t[3]).map((v) => Math.round((v / 255) * 1000) / 1000);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><filter id="n" x="0" y="0" width="100%" height="100%">`
    + `<feTurbulence type="${t[4]}" baseFrequency="${t[5]}" numOctaves="${t[6]}" seed="7" stitchTiles="stitch"/>`
    + `<feColorMatrix values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0.9 0 0 0 -0.1"/></filter>`
    + `<rect width="96" height="96" fill="${t[2]}"/><rect width="96" height="96" filter="url(#n)"/></svg>`;
  return { image: svgUrl(svg), size: '96px 96px', repeat: 'repeat' };
}

/** The CSS background of any fill → {image, size, repeat, position?} or null. `type` is read too, for the brief's name of the key.
 * `page`: a page background, whose picture tiles at its own size across the page as Word's does; a shape's stretches to fit. */
export function fillCss(fill, { page = false } = {}) {
  const kind = fill?.kind ?? fill?.type;
  if (kind === 'gradient') return { image: gradientCss(fill), size: '100% 100%', repeat: 'no-repeat' };
  if (kind === 'pattern') return patternCss(fill);
  if (kind === 'texture') return textureCss(fill);
  if (kind === 'picture' && fill.src) {
    if (page) return { image: `url("${fill.src}")`, size: 'auto', repeat: 'repeat' };
    return { image: `url("${fill.src}")`, size: fill.lockAspect ? 'cover' : '100% 100%', repeat: 'no-repeat', position: 'center' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rule and grid lines (Draw > Format Background; background.rule = {kind, full})

/** Spacing in mm per kind. Word's spacings are unverified; these are recorded choices (brief). */
export const RULES = {
  narrowRuled: 6.35, collegeRuled: 7.1, standardRuled: 8, wideRuled: 8.7,
  smallGrid: 3.2, mediumGrid: 6.4, largeGrid: 12.7, veryLargeGrid: 25.4,
};
export const RULE_KINDS = Object.keys(RULES);
/** The line colour: a light blue like ruled paper (ours). */
export const RULE_COLOR = '#A9C4E2';

/** The spacing in layout px (96 per inch) of rule kind `kind`, or null for none. */
export const ruleSpacingPx = (kind) => (RULES[kind] ? (RULES[kind] * 96) / 25.4 : null);

/** The CSS background of rule kind `kind`: one 1 px line per spacing, both ways for a grid → {image, size, repeat} or null. */
export function ruleCss(kind, color = RULE_COLOR) {
  const s = ruleSpacingPx(kind);
  if (!s) return null;
  const px = Math.round(s * 1000) / 1000;
  const h = `linear-gradient(to bottom, transparent ${px - 1}px, ${color} ${px - 1}px)`;
  const v = `linear-gradient(to right, transparent ${px - 1}px, ${color} ${px - 1}px)`;
  return { image: /Grid$/.test(kind) ? `${h}, ${v}` : h, size: `${px}px ${px}px`, repeat: 'repeat' };
}

/** pt → layout px, for the layers. */
export const px = ptToPx;

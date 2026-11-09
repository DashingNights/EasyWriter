// VML, Word's older drawing format (ECMA-376 Part 4 §14), translated into the DrawingML that means the same, as the element tree
// import.mjs's XML reader makes ({name, attrs, kids}). drawingOf then reads both formats on one path: a VML picture becomes
// pic:pic, a text box wps:wsp with wps:txbx, a shape wps:wsp with prstGeom or custGeom, a group wpg:wgp, each in wp:inline or,
// with position:absolute, in wp:anchor with the style's position, size and wrap. Effects go along: gradient fills as a:gradFill,
// v:shadow as a:outerShdw, v:stroke's dashes (custom ones as a:custDash), arrows and opacity on a:ln, and WordArt's shapetype as
// the text warp (a:prstTxWarp) that bends its text the same way. Pure: its gradients go through dml.mjs, the one writer of a:gradFill.
import { gradFillEl, gradientMid } from './dml.mjs';

const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const kid = (n, name) => kids(n, name)[0] ?? null;
const at = (n, a) => n?.attrs?.[a] ?? null;
const deep = (n, name, out = []) => {
  for (const k of kids(n)) (k.name === name ? out.push(k) : deep(k, name, out));
  return out;
};
const E = (name, attrs = {}, ...ks) => ({ name, attrs: Object.fromEntries(Object.entries(attrs).filter(([, x]) => x != null).map(([k, x]) => [k, String(x)])),
  kids: ks.flat().filter((k) => k != null && k !== false) });
const R = Math.round;

// ---------- values ----------
const UNIT = { pt: 12700, px: 9525, in: 914400, cm: 360000, mm: 36000, pc: 152400, emu: 1 };
/** A VML length → EMU. A bare number counts `bare` EMU: a pixel at the top level, the group's coordinate unit inside a group. */
export function emu(s, bare = UNIT.px) {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?)\s*([a-z]*)\s*$/i.exec(s ?? '');
  if (!m) return null;
  const u = m[2].toLowerCase();
  return u ? (UNIT[u] == null ? null : +m[1] * UNIT[u]) : +m[1] * bare;
}
/** A VML fraction ('0.5', '32768f' in 65536ths, '50%') → a number. */
const frac = (s) => {
  const m = /^\s*(-?[\d.]+)\s*(f|%)?\s*$/i.exec(s ?? '');
  return m ? +m[1] / (m[2] === 'f' ? 65536 : m[2] === '%' ? 100 : 1) : null;
};
/** A VML angle ('45', '2949120fd' in 65536ths of a degree) → degrees. */
const deg = (s) => (s == null ? null : /fd\s*$/i.test(s) ? parseFloat(s) / 65536 : parseFloat(s));
const on = (s) => (s == null ? null : /^\s*(t|true|1|on)\s*$/i.test(s));
/** The CSS-like style attribute → {property: value}, properties in lower case. */
export const styleOf = (s) => Object.fromEntries((s ?? '').split(';').map((d) => d.split(':')).filter((d) => d.length > 1)
  .map(([k, ...x]) => [k.trim().toLowerCase(), x.join(':').trim()]));
const NAMED = { black: '000000', silver: 'C0C0C0', gray: '808080', grey: '808080', white: 'FFFFFF', maroon: '800000', red: 'FF0000', purple: '800080',
  fuchsia: 'FF00FF', green: '008000', lime: '00FF00', olive: '808000', yellow: 'FFFF00', navy: '000080', blue: '0000FF', teal: '008080', aqua: '00FFFF',
  window: 'FFFFFF', windowtext: '000000' };
/** A VML colour ('#RGB', '#RRGGBB', a named colour; Word's trailing '[index]' is ignored) → 'RRGGBB', or null. */
export function color(s) {
  const c = (s ?? '').trim().split(/\s+/)[0].toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(c)) return [...c.slice(1)].map((x) => x + x).join('').toUpperCase();
  return NAMED[c] ?? null;
}
const pair = (s, d) => (s ?? d).split(',').map((x, i) => (x.trim() === '' ? +d.split(',')[i] : +x));

// ---------- tables ----------
// MSO_SPT (the o:spt of a shapetype, also the digits of Word's '_x0000_tNNN' ids) → DrawingML preset; 202 is a text box, 75 a picture.
const PRST = {
  1: 'rect', 2: 'roundRect', 3: 'ellipse', 4: 'diamond', 5: 'triangle', 6: 'rtTriangle', 7: 'parallelogram', 8: 'trapezoid', 9: 'hexagon', 10: 'octagon',
  11: 'plus', 12: 'star5', 13: 'rightArrow', 15: 'homePlate', 16: 'cube', 19: 'arc', 20: 'line', 21: 'plaque', 22: 'can', 23: 'donut',
  32: 'straightConnector1', 33: 'bentConnector2', 34: 'bentConnector3', 35: 'bentConnector4', 36: 'bentConnector5', 37: 'curvedConnector2',
  38: 'curvedConnector3', 39: 'curvedConnector4', 40: 'curvedConnector5', 41: 'callout1', 42: 'callout2', 43: 'callout3', 44: 'accentCallout1',
  45: 'accentCallout2', 46: 'accentCallout3', 47: 'borderCallout1', 48: 'borderCallout2', 49: 'borderCallout3', 50: 'accentBorderCallout1',
  51: 'accentBorderCallout2', 52: 'accentBorderCallout3', 53: 'ribbon', 54: 'ribbon2', 55: 'chevron', 56: 'pentagon', 57: 'noSmoking', 58: 'star8',
  59: 'star16', 60: 'star32', 61: 'wedgeRectCallout', 62: 'wedgeRoundRectCallout', 63: 'wedgeEllipseCallout', 64: 'wave', 65: 'foldedCorner',
  66: 'leftArrow', 67: 'downArrow', 68: 'upArrow', 69: 'leftRightArrow', 70: 'upDownArrow', 71: 'irregularSeal1', 72: 'irregularSeal2',
  73: 'lightningBolt', 74: 'heart', 75: 'rect', 76: 'quadArrow', 77: 'leftArrowCallout', 78: 'rightArrowCallout', 79: 'upArrowCallout',
  80: 'downArrowCallout', 81: 'leftRightArrowCallout', 82: 'upDownArrowCallout', 83: 'quadArrowCallout', 84: 'bevel', 85: 'leftBracket',
  86: 'rightBracket', 87: 'leftBrace', 88: 'rightBrace', 89: 'leftUpArrow', 90: 'bentUpArrow', 91: 'bentArrow', 92: 'star24', 93: 'stripedRightArrow',
  94: 'notchedRightArrow', 95: 'blockArc', 96: 'smileyFace', 97: 'verticalScroll', 98: 'horizontalScroll', 99: 'circularArrow', 101: 'uturnArrow',
  102: 'curvedRightArrow', 103: 'curvedLeftArrow', 104: 'curvedUpArrow', 105: 'curvedDownArrow', 106: 'cloudCallout', 107: 'ellipseRibbon',
  108: 'ellipseRibbon2', 109: 'flowChartProcess', 110: 'flowChartDecision', 111: 'flowChartInputOutput', 112: 'flowChartPredefinedProcess',
  113: 'flowChartInternalStorage', 114: 'flowChartDocument', 115: 'flowChartMultidocument', 116: 'flowChartTerminator', 117: 'flowChartPreparation',
  118: 'flowChartManualInput', 119: 'flowChartManualOperation', 120: 'flowChartConnector', 121: 'flowChartPunchedCard', 122: 'flowChartPunchedTape',
  123: 'flowChartSummingJunction', 124: 'flowChartOr', 125: 'flowChartCollate', 126: 'flowChartSort', 127: 'flowChartExtract', 128: 'flowChartMerge',
  129: 'flowChartOfflineStorage', 130: 'flowChartOnlineStorage', 131: 'flowChartMagneticTape', 132: 'flowChartMagneticDisk', 133: 'flowChartMagneticDrum',
  134: 'flowChartDisplay', 135: 'flowChartDelay', 176: 'flowChartAlternateProcess', 177: 'flowChartOffpageConnector', 183: 'sun', 184: 'moon',
  185: 'bracketPair', 186: 'bracePair', 187: 'star4', 188: 'doubleWave', 202: 'rect',
};
// WordArt's shapetypes (MSO_SPT 136 to 175) → the DrawingML text warp that bends the text the same way.
const WARP = Object.fromEntries(['textPlain', 'textStop', 'textTriangle', 'textTriangleInverted', 'textChevron', 'textChevronInverted', 'textRingInside',
  'textRingOutside', 'textArchUp', 'textArchDown', 'textCircle', 'textButton', 'textArchUpPour', 'textArchDownPour', 'textCirclePour', 'textButtonPour',
  'textCurveUp', 'textCurveDown', 'textCascadeUp', 'textCascadeDown', 'textWave1', 'textWave2', 'textDoubleWave1', 'textWave4', 'textInflate', 'textDeflate',
  'textInflateBottom', 'textDeflateBottom', 'textInflateTop', 'textDeflateTop', 'textDeflateInflate', 'textDeflateInflateDeflate', 'textFadeRight',
  'textFadeLeft', 'textFadeUp', 'textFadeDown', 'textSlantUp', 'textSlantDown', 'textCanUp', 'textCanDown'].map((p, i) => [136 + i, p]));
// What Word's built-in shapetypes set when the file uses one without defining it in this part.
const TYPE_ATTRS = { 75: { filled: 'f', stroked: 'f' } };
const DASH = { solid: 'solid', shortdash: 'sysDash', shortdot: 'sysDot', shortdashdot: 'sysDashDot', shortdashdotdot: 'sysDashDotDot', dot: 'dot', dash: 'dash',
  longdash: 'lgDash', dashdot: 'dashDot', longdashdot: 'lgDashDot', longdashdotdot: 'lgDashDotDot' };
const ARROW = { none: 'none', block: 'triangle', classic: 'stealth', oval: 'oval', diamond: 'diamond', open: 'arrow' };
const SIZE = { narrow: 'sm', short: 'sm', medium: 'med', wide: 'lg', long: 'lg' };
const CMPD = { single: 'sng', thinthin: 'dbl', thinthick: 'thinThick', thickthin: 'thickThin', thickbetweenthin: 'tri' };
const CAP = { flat: 'flat', square: 'sq', round: 'rnd' };
const AREA = { 'left-margin-area': 'leftMargin', 'right-margin-area': 'rightMargin', 'top-margin-area': 'topMargin', 'bottom-margin-area': 'bottomMargin',
  'inner-margin-area': 'insideMargin', 'outer-margin-area': 'outsideMargin', margin: 'margin', page: 'page' };
const REL = { H: { ...AREA, text: 'column', char: 'character' }, V: { ...AREA, text: 'paragraph', line: 'line' } };
const WRAP_SIDE = { both: 'bothSides', left: 'left', right: 'right', largest: 'largest' };
const VERT = { vertical: 'vert', 'vertical-ideographic': 'eaVert' };
const URI = { 'pic:pic': 'http://schemas.openxmlformats.org/drawingml/2006/picture', 'wps:wsp': 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'wpg:wgp': 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup' };
const DRAWABLE = new Set(['v:shape', 'v:rect', 'v:roundrect', 'v:oval', 'v:arc', 'v:line', 'v:polyline', 'v:curve', 'v:image', 'v:group']);
/** What Word draws: a drawable VML element that is not visibility:hidden (Word leaves hidden ones out of the page). */
const shown = (k) => DRAWABLE.has(k.name) && styleOf(at(k, 'style')).visibility !== 'hidden';

// ---------- geometry ----------
const pt = (x, y) => E('a:pt', { x: R(x), y: R(y) });
/** A preset geometry with its adjust values: one number is 'adj', an object names each. */
const prst = (name, adj) => E('a:prstGeom', { prst: name }, E('a:avLst', {}, Object.entries(typeof adj === 'number' ? { adj } : adj ?? {})
  .map(([k, x]) => E('a:gd', { name: k, fmla: `val ${R(x)}` }))));
/** A VML arc angle (degrees clockwise from 12 o'clock) → a DrawingML one (60000ths of a degree clockwise from 3 o'clock). */
const arcAngle = (d) => R(((((d - 90) % 360) + 360) % 360) * 60000);
const cust = (paths) => E('a:custGeom', {}, E('a:avLst'), E('a:gdLst'), E('a:ahLst'), E('a:cxnLst'), E('a:rect', { l: 'l', t: 't', r: 'r', b: 'b' }), E('a:pathLst', {}, paths));
/** Points [[x, y], ...] in EMU relative to their box → one a:path (`curve`: from, control1, control2, to). */
const pointPath = (ps, w, h, curve) => E('a:path', { w: Math.max(1, R(w)), h: Math.max(1, R(h)) }, E('a:moveTo', {}, pt(...ps[0])),
  curve ? E('a:cubicBezTo', {}, ps.slice(1).map((p) => pt(...p))) : ps.slice(1).map((p) => E('a:lnTo', {}, pt(...p))));

/** A VML path (m, l, c, r, v, t, x, e, nf, ns) in a coordsize box → a:path elements, or null when it holds formulas (@n), arcs or
 * the other commands, which need the shapetype's formulas. */
export function vmlPath(path, size = [21600, 21600], origin = [0, 0]) {
  const paths = [];
  let cur = null;
  let pos = [0, 0];
  const open = () => (cur ??= { kids: [], attrs: {} });
  const P = (x, y) => pt(x - origin[0], y - origin[1]);
  for (const [, cmd, args] of (path ?? '').matchAll(/(nf|ns|ae|al|at|ar|wa|wr|qx|qy|qb|[a-z])([^a-z]*)/gi)) {
    if (args.includes('@')) return null;
    const n = args.trim() === '' ? [] : args.trim().replace(/\s+/g, ',').split(',').map((x) => (x.trim() === '' ? 0 : +x));
    if (n.some(Number.isNaN)) return null;
    switch (cmd.toLowerCase()) {
      case 'm': case 't': {
        const [x = 0, y = 0] = n;
        pos = cmd.toLowerCase() === 't' ? [pos[0] + x, pos[1] + y] : [x, y];
        open().kids.push(E('a:moveTo', {}, P(...pos)));
        break;
      }
      case 'l': case 'r':
        for (let i = 0; i + 1 < n.length; i += 2) {
          pos = cmd.toLowerCase() === 'r' ? [pos[0] + n[i], pos[1] + n[i + 1]] : [n[i], n[i + 1]];
          open().kids.push(E('a:lnTo', {}, P(...pos)));
        }
        break;
      case 'c': case 'v':
        for (let i = 0; i + 5 < n.length; i += 6) {
          const b = cmd.toLowerCase() === 'v' ? pos : [0, 0];
          const ps = [0, 2, 4].map((j) => [b[0] + n[i + j], b[1] + n[i + j + 1]]);
          open().kids.push(E('a:cubicBezTo', {}, ps.map((p) => P(...p))));
          pos = ps[2];
        }
        break;
      case 'x': open().kids.push(E('a:close')); break;
      case 'e': if (cur) paths.push(cur); cur = null; break;
      case 'nf': open().attrs.fill = 'none'; break;
      case 'ns': open().attrs.stroke = '0'; break;
      default: return null;
    }
  }
  if (cur) paths.push(cur);
  return paths.length ? paths.map((p) => E('a:path', { w: size[0], h: size[1], ...p.attrs }, p.kids)) : null;
}

// ---------- effects ----------
const srgb = (hex, a) => E('a:srgbClr', { val: hex }, a != null && a < 1 && E('a:alpha', { val: R(a * 100000) }));
/** A VML color2 against fill colour `c1` ('RRGGBB'): 'fill', 'fill darken(n)' (n of 255 of the colour) or 'fill lighten(n)' (n of
 * 255 of the way back from white), or a colour of its own → 'RRGGBB', or null. */
export function color2(s, c1) {
  const m = /^\s*fill\b(?:\s*(darken|lighten)\(\s*(\d+)\s*\))?/i.exec(s ?? '');
  if (!m) return color(s);
  const n = m[1] ? +m[2] / 255 : 1;
  const dark = /darken/i.test(m[1] ?? '');
  return c1.match(/../g).map((h) => { const v = parseInt(h, 16); return R(dark ? v * n : 255 - (255 - v) * n).toString(16).padStart(2, '0'); }).join('').toUpperCase();
}
/** A VML percentage ('50%', '-100%', or a bare fraction '0.5') → percent. */
const pctOf = (s) => (s == null ? 0 : /%/.test(s) ? parseFloat(s) || 0 : (parseFloat(s) || 0) * (Math.abs(parseFloat(s)) <= 1 ? 100 : 1));
const rev = (stops) => stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse();
// There and back: the stops in the first half, mirrored in the second.
const mirror = (stops) => [...stops.map((s) => ({ ...s, pos: s.pos / 2 })), ...rev(stops).slice(1).map((s) => ({ ...s, pos: 0.5 + s.pos / 2 }))];

/**
 * A v:fill of type gradient or gradientRadial (fill colour `c1`, its opacity `op1`) → {el: a:gradFill, mid: the colour halfway}.
 * Stops: fillcolor to color2 (o:opacity2 its opacity), or the colors list ('0 red;.5 #fff;1 blue', positions as fractions or
 * 65536ths). Linear: angle counts counterclockwise from the bottom where DrawingML's a:lin counts clockwise from the left; focus
 * 100% or -100% runs the colours back, 50% runs them there and back, -50% back and forth; Word swaps the two colours at an angle
 * of 180 or more (LibreOffice's oox/vml found the same). Radial: the colours spread from focusposition (focussize its size), the
 * fill colour at the centre at a focus of 100%.
 */
function gradient(f, c1, op1) {
  const op2 = frac(at(f, 'o:opacity2')) ?? 1;
  const list = (at(f, 'colors') ?? '').split(';').map((x) => x.trim().split(/\s+/)).filter((x) => x.length > 1)
    .map(([p, c]) => ({ pos: Math.min(1, Math.max(0, frac(p) ?? 0)), hex: color(c) })).filter((x) => x.hex);
  let stops = (list.length > 1 ? list : [{ pos: 0, hex: c1 }, { pos: 1, hex: color2(at(f, 'color2'), c1) ?? 'FFFFFF' }])
    .map((s) => ({ ...s, a: op1 + (op2 - op1) * s.pos }));
  const focus = pctOf(at(f, 'focus'));
  const radial = at(f, 'type') === 'gradientRadial';
  let shade;
  if (radial) {
    if (Math.abs(focus) <= 50) stops = rev(stops);
    const [x, y] = pair(at(f, 'focusposition') || '0,0', '0,0');
    const [w, h] = pair(at(f, 'focussize') || '0,0', '0,0');
    shade = { kind: 'radial', path: 'rect', focus: { l: x, t: y, r: 1 - x - w, b: 1 - y - h } };
  } else {
    const a = (((deg(at(f, 'angle')) ?? 0) % 360) + 360) % 360;
    const back = a >= 180;
    const axial = Math.abs(focus) >= 25 && Math.abs(focus) <= 75;
    if (axial) stops = mirror(focus > 0 !== back ? stops : rev(stops));
    // Running two colours back is the same gradient turned half way round.
    const turn = !axial && Math.abs(focus) > 50 !== back;
    shade = { kind: 'linear', angle: (630 - a + (turn ? 180 : 0)) % 360, scaled: true };
  }
  const alpha = (a) => (a != null && a < 1 ? R(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0').toUpperCase() : '');
  const gradient = { ...shade, stops: stops.map((s) => ({ pos: s.pos, color: `#${s.hex}${alpha(s.a)}` })) };
  return { el: gradFillEl({ gradient }), mid: gradientMid(gradient.stops).slice(1, 7) };
}

/** A v:shadow that is on → a:effectLst with one a:outerShdw at its offset (default 2pt,2pt), colour (default gray) and opacity,
 * unblurred as VML draws it; or null. ponytail: a double shadow keeps its first, an emboss or perspective one its offset only. */
function shadow(sh) {
  if (!sh || !on(at(sh, 'on'))) return null;
  const [dx, dy] = (at(sh, 'offset') ?? '2pt,2pt').split(',').map((v) => emu(v.trim() || '2pt') ?? 0);
  return E('a:effectLst', {}, E('a:outerShdw', { blurRad: 0, dist: R(Math.hypot(dx, dy)), dir: R(((((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360) * 60000),
    algn: 'ctr', rotWithShape: 0 }, srgb(color(at(sh, 'color')) ?? '808080', frac(at(sh, 'opacity')))));
}

/** A VML dashstyle → a:prstDash, or a:custDash for a list of dash and space lengths in line widths ('4 2 1 2'). */
function dash(s) {
  const v = (s ?? 'solid').trim().toLowerCase();
  if (!/^[\d.]+(\s+[\d.]+)*$/.test(v)) return E('a:prstDash', { val: DASH[v] ?? 'dash' });
  const n = v.split(/\s+/).map(Number);
  const ds = [];
  for (let i = 0; i < n.length; i += 2) ds.push(E('a:ds', { d: R(n[i] * 100000), sp: R((n[i + 1] ?? n[i]) * 100000) }));
  return E('a:custDash', {}, ds);
}

// ---------- one element ----------
/**
 * One VML element → {el, x, y, w, h}: el the DrawingML element (pic:pic, wps:wsp, wpg:wgp at the top or wpg:grpSp in a group),
 * x, y, w, h its box in EMU (inside a group, in the group's child space). `sx`, `sy` are the EMU of a bare number on each axis.
 */
function element(e, ctx, sx, sy, top) {
  const ref = (at(e, 'type') ?? '').replace(/^#/, '');
  const type = ctx.types.get(ref) ?? null;
  const spt = +(at(e, 'o:spt') ?? at(type, 'o:spt') ?? /_x0000_t(\d+)$/.exec(ref)?.[1] ?? NaN);
  const A = (k) => at(e, k) ?? at(type, k) ?? TYPE_ATTRS[spt]?.[k] ?? null;
  const C = (n) => kid(e, n) ?? kid(type, n);
  const s = styleOf(at(e, 'style'));
  const L = (v, b) => emu(v, b) ?? 0;
  const hr = on(at(e, 'o:hr'));

  // The box, and for lines, polylines and curves their points inside it.
  let x = L(s['margin-left'], sx) + L(s.left, sx);
  let y = L(s['margin-top'], sy) + L(s.top, sy);
  let w = emu(s.width, sx);
  let h = emu(s.height, sy);
  let pts = null;
  const point = (v) => { const [px, py] = (v ?? '0,0').split(','); return [L(px, sx), L(py, sy)]; };
  if (e.name === 'v:line') pts = [point(at(e, 'from')), point(at(e, 'to'))];
  else if (e.name === 'v:curve') pts = ['from', 'control1', 'control2', 'to'].map((k) => point(at(e, k)));
  else if (e.name === 'v:polyline') {
    const n = (at(e, 'points') ?? '').trim().split(/[\s,]+/).filter(Boolean);
    pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([L(n[i], sx), L(n[i + 1], sy)]);
    if (pts.length < 2) return null;
  }
  let flipH = /\bx\b/.test(s.flip ?? '');
  let flipV = /\by\b/.test(s.flip ?? '');
  if (pts) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
    x += x0; y += y0; w = Math.max(...xs) - x0; h = Math.max(...ys) - y0;
    if (e.name === 'v:line') { flipH = pts[1][0] < pts[0][0]; flipV = pts[1][1] < pts[0][1]; } else pts = pts.map(([px, py]) => [px - x0, py - y0]);
  }
  [x, y, w, h] = [R(x), R(y), w == null ? null : R(w), h == null ? null : R(h)];
  const rot = deg(s.rotation);
  const xfrm = (extra = {}, ...more) => E('a:xfrm', { rot: rot ? R((((rot % 360) + 360) % 360) * 60000) : null, flipH: flipH ? 1 : null, flipV: flipV ? 1 : null, ...extra },
    E('a:off', { x: top ? 0 : x, y: top ? 0 : y }), E('a:ext', { cx: w ?? 0, cy: h ?? 0 }), more);
  const id = /(\d+)$/.exec(at(e, 'o:spid') ?? '')?.[1] ?? null;
  const name = at(e, 'id');

  // A group: its children in its coordinate space (coordorigin, coordsize), scaled to EMU.
  if (e.name === 'v:group') {
    const [cw, ch] = pair(at(e, 'coordsize'), '1000,1000');
    const [ox, oy] = pair(at(e, 'coordorigin'), '0,0');
    const [gx, gy] = [(w ?? 0) / (cw || 1), (h ?? 0) / (ch || 1)];
    const members = kids(e).filter(shown).map((k) => element(k, ctx, gx, gy, false)).filter(Boolean).map((m) => m.el);
    const sp = E('wpg:grpSpPr', {}, xfrm({}, E('a:chOff', { x: R(ox * gx), y: R(oy * gy) }), E('a:chExt', { cx: w ?? 0, cy: h ?? 0 })));
    return { el: E(top ? 'wpg:wgp' : 'wpg:grpSp', {}, top ? null : E('wpg:cNvPr', { id: id ?? 0, name }), E('wpg:cNvGrpSpPr'), sp, members),
      x, y, w, h, id, name, s };
  }

  // Line: stroked (default on) → a:ln with v:stroke's colour, weight, dash, compound, cap, join and arrows.
  const stroke = C('v:stroke');
  const lineOn = on(at(stroke, 'on')) ?? on(A('stroked')) ?? !hr;
  const sa = (k) => at(stroke, k);
  const end = (tag, k) => (ARROW[sa(`${k}arrow`)] && ARROW[sa(`${k}arrow`)] !== 'none'
    ? E(tag, { type: ARROW[sa(`${k}arrow`)], w: SIZE[sa(`${k}arrowwidth`)] ?? null, len: SIZE[sa(`${k}arrowlength`)] ?? null }) : null);
  const join = sa('joinstyle');
  const ln = !lineOn ? E('a:ln', {}, E('a:noFill')) : E('a:ln', { w: R(emu(sa('weight') ?? A('strokeweight') ?? '0.75pt', UNIT.pt) ?? 9525),
    cmpd: CMPD[(sa('linestyle') ?? '').toLowerCase()] ?? null, cap: CAP[sa('endcap')] ?? null },
  E('a:solidFill', {}, srgb(color(sa('color') ?? A('strokecolor')) ?? '000000', frac(sa('opacity')))), dash(sa('dashstyle')),
  join === 'round' ? E('a:round') : join === 'bevel' ? E('a:bevel') : join === 'miter' ? E('a:miter', { lim: 800000 }) : null, end('a:headEnd', 'start'), end('a:tailEnd', 'end'));

  const fx = shadow(C('v:shadow'));

  // A picture: v:imagedata (or v:image) → pic:pic at the shape's box, with its crop.
  const img = e.name === 'v:image' ? e : kid(e, 'v:imagedata');
  const rid = img && (at(img, 'r:id') ?? at(img, 'o:relid') ?? at(img, 'r:pict'));
  if (rid) {
    const crop = Object.fromEntries([['l', 'cropleft'], ['t', 'croptop'], ['r', 'cropright'], ['b', 'cropbottom']].map(([k, a]) => [k, frac(at(img, a)) ? R(frac(at(img, a)) * 100000) : null]));
    return { el: E('pic:pic', {}, E('pic:nvPicPr', {}, E('pic:cNvPr', { id: id ?? 0, name }), E('pic:cNvPicPr')),
      E('pic:blipFill', {}, E('a:blip', { 'r:embed': rid }), Object.values(crop).some((c) => c != null) && E('a:srcRect', crop), E('a:stretch', {}, E('a:fillRect'))),
      E('pic:spPr', {}, xfrm(), prst('rect'), lineOn && on(A('stroked')) ? ln : null, fx)), x, y, w, h, id, name, s, title: at(img, 'o:title') };
  }

  // A shape: geometry, fill, line, text.
  let geom;
  if (e.name === 'v:rect' || e.name === 'v:image') geom = prst('rect');
  else if (e.name === 'v:roundrect') geom = prst('roundRect', (frac(at(e, 'arcsize')) ?? 0.2) * 100000);
  else if (e.name === 'v:oval') geom = prst('ellipse');
  // An arc of the ellipse in its box, from startangle to endangle clockwise (VML's defaults 0 and 90: top to right).
  else if (e.name === 'v:arc') geom = prst('arc', { adj1: arcAngle(deg(at(e, 'startangle')) ?? 0), adj2: arcAngle(deg(at(e, 'endangle')) ?? 90) });
  else if (e.name === 'v:line') geom = prst('line');
  else if (pts) geom = cust([pointPath(pts, w, h, e.name === 'v:curve')]);
  else if (PRST[spt]) geom = prst(PRST[spt]);
  else {
    const paths = vmlPath(A('path'), pair(A('coordsize'), '1000,1000'), pair(A('coordorigin'), '0,0'));
    geom = paths ? cust(paths) : prst('rect'); // ponytail: a path drawn from formulas (@n) draws as its box; evaluate v:formulas if it matters
  }
  const fillEl = C('v:fill');
  const fillOn = on(at(fillEl, 'on')) ?? on(A('filled')) ?? !['v:line', 'v:polyline', 'v:curve'].includes(e.name);
  const opacity = frac(at(fillEl, 'opacity'));
  const fc = color(at(fillEl, 'color') ?? A('fillcolor')) ?? (hr ? 'A0A0A0' : 'FFFFFF');
  const grad = fillOn && /^gradient/.test(at(fillEl, 'type') ?? '') ? gradient(fillEl, fc, opacity ?? 1) : null;
  const fill = !fillOn ? E('a:noFill') : grad?.el ?? E('a:solidFill', {}, srgb(fc, opacity));
  // WordArt (v:textpath, shown unless it or its shapetype's says on="f"): its string is the shape's text, drawn in the fill (the
  // line when there is no fill) with the line as its outline and the shadow on the letters; the shape itself draws nothing.
  const tp = kid(e, 'v:textpath');
  const art = at(tp, 'string') != null && on(at(tp, 'on') ?? at(kid(type, 'v:textpath'), 'on')) !== false
    && wordArt(tp, kid(type, 'v:textpath'), w, h, fillOn ? grad?.mid ?? fc : color(sa('color') ?? A('strokecolor')) ?? '000000', fillOn ? opacity : null, fillOn && lineOn ? ln : null, fx);

  const box = kid(e, 'v:textbox');
  const content = kid(box, 'w:txbxContent');
  const bs = styleOf(at(box, 'style'));
  const ins = (at(box, 'inset') ?? '').split(',');
  const inset = (i, d) => R(emu(ins[i]?.trim() || d) ?? 0);
  const anchor = (s['v-text-anchor'] ?? 'top').split('-');
  const vert = bs['layout-flow'] === 'vertical' && bs['mso-layout-flow-alt'] === 'bottom-to-top' ? 'vert270' : VERT[bs['layout-flow']] ?? null;
  // ponytail: the warp takes its preset's adjust values; the shape's adj (the arch's angle, the wave's height) is left out.
  const body = art ? E('wps:bodyPr', { rot: 0, wrap: 'none', lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: 'ctr' },
    WARP[spt] && E('a:prstTxWarp', { prst: WARP[spt] }, E('a:avLst')), E('a:noAutofit'))
    : E('wps:bodyPr', { rot: 0, vert, wrap: s['mso-wrap-style'] === 'none' ? 'none' : 'square', lIns: inset(0, '0.1in'), tIns: inset(1, '0.05in'),
      rIns: inset(2, '0.1in'), bIns: inset(3, '0.05in'), anchor: { top: 't', middle: 'ctr', bottom: 'b' }[anchor[0]] ?? 't', anchorCtr: anchor[1] === 'center' ? 1 : 0 },
    on(bs['mso-fit-shape-to-text']) ? E('a:spAutoFit') : E('a:noAutofit'));
  return { el: E('wps:wsp', {}, top ? null : E('wps:cNvPr', { id: id ?? 0, name }), E('wps:cNvSpPr', { txBox: content ? 1 : null }),
    E('wps:spPr', {}, xfrm(), geom, art ? [E('a:noFill'), E('a:ln', {}, E('a:noFill'))] : [fill, ln, fx]), art, content && E('wps:txbx', {}, content), body), x, y, w, h, id, name, s, hr };
}

/**
 * WordArt's v:textpath `tp` (its shapetype's `typeTp`) on a shape of w × h EMU, in colour `hex` at opacity `alpha`, outlined by
 * a:ln `ln` and shadowed by a:effectLst `fx` (either may be null) → DrawingML text (wps:txBody, a:p per line): its string in the
 * style's font-family, font-size, bold and italic, aligned by v-text-align. Text fitted to the shape (fitshape, as Word's WordArt
 * shapetypes set) takes the largest size that fits the box instead. A gradient fill gives the letters its middle colour, the
 * one fill the importer reads for text.
 */
function wordArt(tp, typeTp, w, h, hex, alpha, ln, fx) {
  const ts = styleOf(at(tp, 'style'));
  const lines = at(tp, 'string').split(/\r?\n/);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  // ponytail: Word stretches fitted text to fill the box; a label cannot stretch, so it takes the size whose lines (1.2 em apart)
  // and longest line (glyphs 0.6 em wide on average) fit. Measure the font if a long string comes out too narrow or too wide.
  const size = on(at(tp, 'fitshape') ?? at(typeTp, 'fitshape')) && w && h ? Math.min(h / 12700 / lines.length / 1.2, w / 12700 / (longest * 0.6))
    : (emu(ts['font-size'], UNIT.pt) ?? 36 * 12700) / 12700;
  const face = (ts['font-family'] ?? '').replace(/^["']|["']$/g, '').trim();
  const rPr = E('a:rPr', { sz: R(Math.max(1, size) * 100), b: /bold|[6-9]00/.test(ts['font-weight'] ?? '') ? 1 : null, i: /italic|oblique/.test(ts['font-style'] ?? '') ? 1 : null },
    ln, E('a:solidFill', {}, srgb(hex, alpha)), fx, face && E('a:latin', { typeface: face }));
  const algn = { left: 'l', right: 'r' }[ts['v-text-align']] ?? 'ctr';
  return E('wps:txBody', {}, lines.map((l) => E('a:p', {}, E('a:pPr', { algn }), E('a:r', {}, rPr, E('a:t', {}, l)))));
}

// ---------- the drawing around it ----------
/** Relative size (mso-width-percent and mso-height-percent in tenths of a percent; o:hrpct for a horizontal line, full width when
 * it has no width) → wp14:sizeRelH and wp14:sizeRelV. */
function relSize(e, s, w, hr) {
  const pctW = hr ? (num(at(e, 'o:hrpct')) || (!w ? 1000 : 0)) : num(s['mso-width-percent']);
  const pctH = num(s['mso-height-percent']);
  return [pctW > 0 && E('wp14:sizeRelH', { relativeFrom: AREA[s['mso-width-relative']] ?? 'margin' }, E('wp14:pctWidth', {}, String(R(pctW * 100)))),
    pctH > 0 && E('wp14:sizeRelV', { relativeFrom: AREA[s['mso-height-relative']] ?? 'margin' }, E('wp14:pctHeight', {}, String(R(pctH * 100))))];
}
const num = (s) => (s == null || s === '' || Number.isNaN(+s) ? null : +s);

/** One top-level VML element → a w:drawing element (wp:inline, or wp:anchor with position:absolute), or null without a translation. */
function drawing(e, ctx) {
  const m = element(e, ctx, UNIT.px, UNIT.px, true);
  if (!m) return null;
  const { el, x, y, w, h, s } = m;
  const docPr = E('wp:docPr', { id: m.id, name: m.name, descr: at(e, 'alt'), title: m.title ?? at(e, 'title') });
  const graphic = E('a:graphic', {}, E('a:graphicData', { uri: URI[el.name] }, el));
  const extent = (w != null || h != null) && E('wp:extent', { cx: w ?? 0, cy: h ?? 0 });
  const rel = relSize(e, s, w, m.hr);
  // A horizontal line keeps o:hr on its wp:inline: Word sizes it from its relative width though it is inline (import.mjs relSizeOf).
  if (s.position !== 'absolute') return E('w:drawing', {}, E('wp:inline', { distT: 0, distB: 0, distL: 0, distR: 0, 'o:hr': m.hr ? 't' : null }, extent, E('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }), docPr, rel, graphic));

  const w10 = kid(e, 'w10:wrap');
  const pos = (axis, offset) => {
    const key = axis === 'H' ? 'horizontal' : 'vertical';
    const rel = REL[axis][s[`mso-position-${key}-relative`] ?? at(w10, axis === 'H' ? 'anchorx' : 'anchory') ?? 'text'] ?? (axis === 'H' ? 'column' : 'paragraph');
    const align = s[`mso-position-${key}`];
    return E(`wp:position${axis}`, { relativeFrom: rel }, align && align !== 'absolute' ? E('wp:align', {}, align) : E('wp:posOffset', {}, String(offset)));
  };
  const type = at(w10, 'type');
  const side = WRAP_SIDE[at(w10, 'side')] ?? 'bothSides';
  const wrap = type === 'square' ? E('wp:wrapSquare', { wrapText: side }) : type === 'tight' ? E('wp:wrapTight', { wrapText: side })
    : type === 'through' ? E('wp:wrapThrough', { wrapText: side }) : type === 'topAndBottom' ? E('wp:wrapTopAndBottom') : E('wp:wrapNone');
  const z = num(s['z-index']) ?? 0; // Word's own z-indexes are relativeHeights; older files count from 0
  const dist = (k) => R(emu(s[`mso-wrap-distance-${k}`] ?? '0') ?? 0);
  return E('w:drawing', {}, E('wp:anchor', {
    distT: dist('top'), distB: dist('bottom'), distL: dist('left'), distR: dist('right'), simplePos: 0,
    relativeHeight: Math.abs(z) < 0x1000000 ? 251658240 + Math.abs(z) : Math.abs(z), behindDoc: z < 0 ? 1 : 0, locked: kid(e, 'w10:anchorlock') ? 1 : 0,
    layoutInCell: on(at(e, 'o:allowincell')) === false ? 0 : 1, allowOverlap: on(at(e, 'o:allowoverlap')) === false ? 0 : 1,
  }, E('wp:simplePos', { x: 0, y: 0 }), pos('H', x), pos('V', y), extent || E('wp:extent', { cx: 0, cy: 0 }), E('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }), wrap, docPr,
  E('wp:cNvGraphicFramePr'), graphic, rel));
}

/**
 * A w:pict or w:object → one entry per drawing in it: a w:drawing element, or null for a VML element with no translation (a v:shape
 * with nothing to draw from). A hidden drawing has no entry, as Word does not draw it. `types` collects v:shapetype by id across a
 * part, since Word defines each once per part. A w:drawing inside (a newer w:object) passes through; o:OLEObject and w:control are
 * left out (their preview picture shows).
 */
export function vmlDrawings(el, types = new Map()) {
  for (const t of deep(el, 'v:shapetype')) if (at(t, 'id')) types.set(at(t, 'id'), t);
  const ctx = { types };
  const out = [];
  for (const k of kids(el)) {
    if (k.name === 'w:drawing') out.push(k);
    else if (shown(k)) out.push(drawing(k, ctx));
    else if (DRAWABLE.has(k.name)) continue;
    else if (k.name.startsWith('v:') && k.name !== 'v:shapetype') out.push(null);
  }
  return out;
}

// ---------- watermarks ----------
/** A picture's size in pixels ({w, h}) from its PNG, GIF, JPEG or BMP header (`b` its bytes or a base64 data URL), or null. */
export function imageSize(b) {
  if (typeof b === 'string') b = Uint8Array.from(atob(b.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
  const be = (i) => (b[i] << 8) | b[i + 1];
  const le = (i) => b[i] | (b[i + 1] << 8);
  if (b?.[0] === 0x89 && b[1] === 0x50) return { w: (be(16) << 16) | be(18), h: (be(20) << 16) | be(22) };
  if (b?.[0] === 0x47 && b[1] === 0x49) return { w: le(6), h: le(8) };
  if (b?.[0] === 0x42 && b[1] === 0x4d) return { w: le(18), h: Math.abs((le(24) << 16 | le(22)) << 0) };
  for (let i = 2; b?.[0] === 0xff && b[1] === 0xd8 && i + 9 < b.length; i += 2 + be(i + 2)) {
    if (b[i] !== 0xff) return null;
    if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(b[i + 1])) return { w: be(i + 7), h: be(i + 5) };
  }
  return null;
}

/** Whether VML element `e` is one of Word's watermarks: a v:shape its id names PowerPlusWaterMarkObject (text) or WordPictureWatermark. */
export const isWatermark = (e) => e?.name === 'v:shape' && /^(PowerPlusWaterMarkObject|WordPictureWatermark)/.test(at(e, 'id') ?? '');

/**
 * Word's watermark shape `e` → a sect.watermark (page-background/model.mjs), or null. A text path: its string and font, the box's
 * height as the size (Word fits the text to a box as high as the size), fillcolor (VML's default white), v:fill opacity under 1 as
 * semitransparent, any rotation as diagonal. A picture (`picture(rid)` → data URL): washed out when it has Word's gain or
 * blacklevel, its scale against its own size at 96 dpi, or Auto (null) when it fills margins box `box` ({w, h} pt) on one axis.
 */
export function watermarkOf(e, picture, box) {
  const s = styleOf(at(e, 'style'));
  const [w, h] = [emu(s.width) ?? 0, emu(s.height) ?? 0].map((x) => x / UNIT.pt);
  const tp = kid(e, 'v:textpath');
  if (at(tp, 'string') != null) {
    const opacity = frac(at(kid(e, 'v:fill'), 'opacity'));
    return { kind: 'text', text: at(tp, 'string'), font: (styleOf(at(tp, 'style'))['font-family'] ?? '').replace(/^["']|["']$/g, '').trim() || null,
      size: R(h * 100) / 100, color: `#${color(at(e, 'fillcolor')) ?? 'FFFFFF'}`, semi: opacity != null && opacity < 1, layout: deg(s.rotation) % 360 ? 'diagonal' : 'horizontal' };
  }
  const img = kid(e, 'v:imagedata');
  const src = img && picture(at(img, 'r:id') ?? at(img, 'o:relid'));
  if (!src) return null;
  const px = imageSize(src);
  const auto = !px?.w || Math.abs(w - box.w) < 1 || Math.abs(h - box.h) < 1;
  return { kind: 'picture', src, scale: auto ? null : R((w / (px.w * 0.75)) * 100), washout: at(img, 'gain') != null || at(img, 'blacklevel') != null };
}

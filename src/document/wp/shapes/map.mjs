// Word's shapes as canvas board items (docs/plans/word/plan.md §3 shapes, briefs/shapes.md, briefs/shape-pool.md). Pure: no DOM or
// app import, so test/word-shapes.test.mjs loads it. Insert > Shapes lists the shared shape gallery (src/flow/gallery.mjs: every
// shape a DrawingML preset drawn by its own geometry, the same list the canvases and the flowchart editor show) after Word's
// Lines, whose entries are connectors and the board's curve, freeform and pen tools, and its two text box tools.
import { DASHES, HEADS } from '../../../flow/model.mjs';
import { GALLERY } from '../../../flow/gallery.mjs';
import { drawnBox, kindOf, presetKind, stylePresets } from '../../../flow/shapes.mjs';
import { LINE_SHAPES as LINES } from '../../../tooling/shape-picker.mjs';
import { heldLink, linkColor, PLAIN_FMT, rethemeItems } from '../../docx/dml.mjs';
import { THEME } from '../../defaults.mjs';

export const PX = 96 / 72; // CSS px per point

// --- the map ---

const tool = (name) => ({ tool: name });
const TEXT_BOXES = { 'Text Box': tool('textBox'), 'Vertical Text Box': tool('verticalTextBox') };

/** Word's shape name → {kind, prst} (a board shape: the kind that draws the preset), {conn: {route, heads}} (a connector item) or
 * {tool: 'textBox'|'verticalTextBox'|'pen'|'curve'|'freeform'} (another command: a text box, or a drawing canvas with that board tool). */
export const SHAPE_MAP = {
  ...LINES, ...TEXT_BOXES,
  ...Object.fromEntries(GALLERY.flatMap((s) => s.shapes.map(([prst, name]) => [name, { kind: presetKind(prst), prst }]))),
};

/** Word's gallery headings in order, each with its shape names. */
export const SHAPE_GROUPS = [['Lines', Object.keys(LINES)],
  ...GALLERY.map((s) => [s.title, [...(s.id === 'basic' ? Object.keys(TEXT_BOXES) : []), ...s.shapes.map(([, name]) => name)]])];

// --- the document's default looks ---
// Word draws a new shape, line and text box in the look of its theme's a:objectDefaults (a:spDef, a:lnDef, a:txDef), which Set as
// Default Shape, Line and Text Box write, and without one in its own look through the theme (below). The model keeps them as
// theme.objectDefaults {spDef, lnDef, txDef} (design/model.mjs): spDef and lnDef as board item fields at scale 1 (widths in CSS px),
// txDef as textBox attributes (widths in pt), each with the theme links of its colours (themeColors) and its style references
// (styleRefs, docx/dml.mjs refsOf), so Design > Colors recolours what is drawn with them and export writes them back.

const scheme = (val, mods = []) => ({ el: 'schemeClr', attrs: { val }, mods });
const refs = (ln, fill, font) => ({ lnRef: ln, fillRef: fill, effectRef: { idx: '0', clr: scheme('accent1') }, fontRef: { idx: 'minor', clr: font } });
// Word's own style references, as it writes them for a new shape and a new line (.smoke-data/word/fixture/all-features.docx): a shape
// fills with Accent 1 and draws its theme's second line style in Accent 1's 15 % shade, with its text in Light 1; a line draws the
// first line style in Accent 1.
const SP_REFS = refs({ idx: '2', clr: scheme('accent1', [['shade', '15000']]) }, { idx: '1', clr: scheme('accent1') }, scheme('lt1'));
const LN_REFS = refs({ idx: '1', clr: scheme('accent1') }, { idx: '0', clr: scheme('accent1') }, scheme('tx1'));
// A text box Word draws has its own fill and line and no style: Background 1 and a black 1/2 pt line (the fixture's parts/4-drawing.ps1).
const TX_FILL = scheme('bg1');
const TX_LINE = { el: 'prstClr', attrs: { val: 'black' }, mods: [] };
const TX_WIDTH = 6350; // EMU
const EMU_PT = 12700;

/** The widths of the theme's three line styles in EMU: a .docx theme's own a:lnStyleLst, else the plain one export writes. */
function lineWidths(theme) {
  const list = /<a:lnStyleLst>([^]*?)<\/a:lnStyleLst>/.exec(theme?.kept?.xml ?? '')?.[1] ?? '';
  const own = [...list.matchAll(/<a:ln\b[^>]*?\sw="(\d+)"/g)].map((m) => +m[1]);
  return own.length >= 2 ? own : PLAIN_FMT.line.map((l) => +l.attrs.w);
}

const held = (link, colors) => ({ ...link, color: linkColor(link, colors) });
const r4 = (n) => Math.round(n * 10000) / 10000;

/** Word's own looks over `theme` (a theme without objectDefaults) → {spDef, lnDef, txDef}. */
function wordLooks(theme) {
  const c = theme?.colors ?? THEME.colors;
  const [thin, mid] = lineWidths(theme);
  const [fill, line, text, ln, box, edge] = [SP_REFS.fillRef.clr, SP_REFS.lnRef.clr, SP_REFS.fontRef.clr, LN_REFS.lnRef.clr, TX_FILL, TX_LINE].map((l) => held(l, c));
  return {
    spDef: { fill: 'solid', fillColor: fill.color, color: line.color, width: r4((mid / EMU_PT) * PX), opacity: 1, textColor: text.color,
      themeColors: { fillColor: fill, color: line, textColor: text }, styleRefs: SP_REFS },
    lnDef: { color: ln.color, width: r4((thin / EMU_PT) * PX), opacity: 1, dash: 'solid', themeColors: { color: ln }, styleRefs: LN_REFS },
    txDef: { fill: box.color, line: { color: edge.color, width: TX_WIDTH / EMU_PT, dash: 'solid' }, themeColors: { fill: box, 'line.color': edge } },
  };
}

export const DEFAULT_KEYS = ['spDef', 'lnDef', 'txDef'];

/** The default looks of a Document with theme `theme` (doc.attrs.theme): its objectDefaults where set, else Word's own, with their
 * theme colours resolved against its colours → {spDef, lnDef, txDef}, fresh copies. */
export function defaultLooks(theme = THEME) {
  const key = theme ?? THEME; // a Document's theme is replaced whole on every change, so it keys its looks
  let looks = memo.get(key);
  if (!looks) {
    const word = wordLooks(theme);
    looks = rethemeItems(DEFAULT_KEYS.map((k) => theme?.objectDefaults?.[k] ?? word[k]), theme?.colors ?? THEME.colors);
    memo.set(key, looks);
  }
  return Object.fromEntries(DEFAULT_KEYS.map((k, i) => [k, structuredClone(looks[i])]));
}
const memo = new WeakMap();

// The fields of each default an object gives (Set as Default): spDef and lnDef from a board item, txDef from a text box's attrs.
const LOOK_KEYS = {
  spDef: ['fill', 'fillColor', 'color', 'width', 'opacity', 'dash', 'textColor', 'gradient', 'pattern', 'shadow', 'styleRefs'],
  lnDef: ['color', 'width', 'opacity', 'dash', 'styleRefs'],
  txDef: ['fill', 'gradient', 'line', 'effects', 'styleRefs'],
};

/** Default `key` (DEFAULT_KEYS) taken from object `o`: a board item at display scale `k` (its widths come out in CSS px at scale
 * 1), or a text box's attrs → the look, with the links of the colours it keeps. */
export function defaultOf(key, o, k = 1) {
  const keys = LOOK_KEYS[key];
  const out = Object.fromEntries(keys.filter((x) => o?.[x] != null).map((x) => [x, structuredClone(o[x])]));
  if (key !== 'txDef' && Number.isFinite(out.width)) out.width = r4(out.width * k);
  // Only the links that still hold: a colour the user picked goes into the default as itself.
  const links = Object.entries(o?.themeColors ?? {}).filter(([path]) => keys.includes(path.split('.')[0]) && heldLink(o, path));
  if (links.length) out.themeColors = structuredClone(Object.fromEntries(links));
  // A default shape's text colour rides in its font reference, the one place a:spDef keeps it.
  if (key === 'spDef' && out.textColor) {
    const { color, ...link } = heldLink(out, 'textColor') ?? { el: 'srgbClr', attrs: { val: out.textColor.slice(1, 7).toUpperCase() }, mods: [] };
    out.styleRefs = { ...(out.styleRefs ?? SP_REFS), fontRef: { idx: out.styleRefs?.fontRef?.idx ?? 'minor', clr: link } };
  }
  return out;
}

/** The look board tool `tool` draws with in a Document whose default looks are `looks` (defaultLooks): 'shape' for shape kind
 * `kind` (Word draws an arc, a bracket or a brace in the line look, unfilled), 'conn' for the Lines entries' connectors, 'path' for
 * Curve and Freeform: Shape → {open (the line look, unfilled, with the shape fill a closing click gives), closed (the shape look)},
 * 'textbox' for a text box drawn in a canvas (boxLook). */
export function toolLook(looks, tool, kind = null) {
  const { spDef: sp, lnDef: ln } = looks;
  const outline = () => ({ ...sp, ...ln, fill: 'none', themeColors: { ...sp.themeColors, ...ln.themeColors } });
  if (tool === 'conn') return ln;
  if (tool === 'textbox') return boxLook(looks.txDef);
  if (tool === 'path') return { open: { ...outline(), fillColor: sp.fillColor }, closed: sp };
  return OUTLINED.has(kindOf(kind)?.prst) ? outline() : sp;
}

// --- items ---

/** A new shape's internal margins in board px (Word's bodyPr defaults, 0.1 in at the sides and 0.05 in above and below): its text
 * goes in the preset's text rectangle less these (src/flow/shapes.mjs labelBox). */
export const SHAPE_INSET = { t: 4.8, r: 9.6, b: 4.8, l: 9.6 };
export const CLICK_SIZE = 72 * PX; // a click without a drag: 1 x 1 in

const newId = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');

const plainLook = (tool, kind) => toolLook(defaultLooks(), tool, kind);

/** Board item for Word shape `name` in box {x, y, w, h} (board px; null: a click, 1 in square at 0,0), or null for a name that runs
 * another tool. `look(tool, kind)` gives its look (toolLook's for the Document; by default the default theme's). Connector ends sit
 * at the box's corners (`flipX`, `flipY`: the drag went left or up). */
export function shapeItem(name, box = null, { flipX = false, flipY = false } = {}, look = plainLook) {
  const m = SHAPE_MAP[name];
  if (!m || m.tool) return null;
  const b = box ?? { x: 0, y: 0, w: CLICK_SIZE, h: CLICK_SIZE };
  if (m.conn) {
    const [x1, x2] = flipX ? [b.x + b.w, b.x] : [b.x, b.x + b.w];
    const [y1, y2] = flipY ? [b.y + b.h, b.y] : [b.y, b.y + b.h];
    return {
      id: newId(), type: 'connector', from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, points: [], labels: {},
      route: m.conn.route, corner: 8, heads: { ...m.conn.heads }, dash: 'solid', jump: 'none', ...structuredClone(look('conn')),
    };
  }
  // Word's new shape has Resize shape to fit text off (Format Shape > Text Box): it keeps its size and its text runs past it.
  return { id: newId(), type: 'shape', shape: m.kind, x: b.x, y: b.y, w: b.w, h: b.h, ...structuredClone(look('shape', m.kind)), inset: { ...SHAPE_INSET }, autoFit: false };
}
/** The look of a text box drawn in a canvas ('textbox' in toolLook): a rectangle with text, as Word keeps a text box in a drawing canvas
 * (a wps:wsp with wps:txbx, which docx/shapes-in.mjs reads as a shape item), in the text box default `tx` (txDef: textBox attrs,
 * widths in pt) as item fields at scale 1, with an empty text at the top in Word's margins and Resize shape to fit text off. */
function boxLook(tx) {
  const tc = tx.themeColors ?? {};
  const fill = typeof tx.fill === 'string' ? tx.fill : null;
  const line = tx.line?.color && tx.line.width > 0 ? tx.line : null;
  // ponytail: a gradient or effects in the default text box are left out; carry them when board items take textBox's forms of them.
  return {
    shape: 'rect', fill: fill ? 'solid' : 'none', ...(fill && { fillColor: fill }), color: line?.color ?? 'transparent',
    width: line ? r4(line.width * PX) : 0, dash: line?.dash ?? 'solid', opacity: 1, html: '', valign: 'top', inset: { ...SHAPE_INSET }, autoFit: false,
    themeColors: { ...(fill && tc.fill && { fillColor: tc.fill }), ...(line && tc['line.color'] && { color: tc['line.color'] }) },
    ...(tx.styleRefs && { styleRefs: tx.styleRefs }),
  };
}

// The shapes Word draws as an outline only, in the line look: the arc, the brackets and the braces.
const OUTLINED = new Set(['arc', 'leftBracket', 'rightBracket', 'bracketPair', 'leftBrace', 'rightBrace', 'bracePair']);

/** Item `it` with its shape swapped for Word shape `name` (Change Shape): box, turn, flips, fill, outline and label kept, the new
 * shape's own adjust values (Word's defaults). null when `name` is not a board shape or `it` is not a shape. */
export function changedShape(it, name) {
  const m = SHAPE_MAP[name];
  if (it?.type !== 'shape' || !m?.kind) return null;
  const { av, prst, path, ...rest } = it;
  return { ...rest, shape: m.kind };
}

/** The box a crosshair drag from p0 to p1 draws ({x, y, w, h, flipX, flipY}): `square` (Shift) keeps it square, or a line at
 * 45 degree steps; `centre` (Ctrl) draws out from p0. */
export function dragBox(p0, p1, { square = false, centre = false, line = false } = {}) {
  let [dx, dy] = [p1.x - p0.x, p1.y - p0.y];
  if (square && line) {
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    [dx, dy] = [Math.round(Math.cos(a) * len * 100) / 100, Math.round(Math.sin(a) * len * 100) / 100];
  } else if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    [dx, dy] = [Math.sign(dx || 1) * s, Math.sign(dy || 1) * s];
  }
  const [ox, oy] = centre ? [p0.x - dx, p0.y - dy] : [p0.x, p0.y];
  const [ex, ey] = [p0.x + dx, p0.y + dy];
  return { x: Math.min(ox, ex), y: Math.min(oy, ey), w: Math.abs(ex - ox), h: Math.abs(ey - oy), flipX: dx < 0, flipY: dy < 0 };
}

// --- canvas fitting ---

const HEAD_PAD = 12; // room for an arrowhead past a connector's end

/** Item `it`'s box on the board ({x, y, w, h}): a shape's turned box with what it draws past it (a callout's tail), a connector's
 * ends and waypoints with room for its heads. */
export function boxOf(it) {
  if (it.type !== 'connector') return drawnBox(it);
  const pts = [it.from, it.to, ...(it.points ?? [])].filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  if (!pts.length) return { x: it.x ?? 0, y: it.y ?? 0, w: it.w ?? 0, h: it.h ?? 0 };
  const pad = HEAD_PAD + (it.width ?? 1);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
}

const shift = (it, dx, dy) => {
  const out = { ...it };
  if (Number.isFinite(it.x)) out.x = it.x + dx;
  if (Number.isFinite(it.y)) out.y = it.y + dy;
  if (it.type !== 'connector') return out;
  const end = (e) => (typeof e?.item === 'string' ? e : { ...e, x: e.x + dx, y: e.y + dy });
  return { ...out, from: end(it.from), to: end(it.to), points: (it.points ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy })) };
};

const MIN_SIDE = 40; // canvas.js MIN_SIZE

/** Canvas attrs fitted to `items` (the one-shape canvas Insert > Shapes makes): items moved so their box starts at 0,0, the
 * artboard and frame that box (at least 40 px a side), the frame bound to the item when there is one. */
export function fitItems(items) {
  const boxes = items.map(boxOf);
  const l = Math.min(...boxes.map((b) => b.x));
  const t = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(MIN_SIDE, Math.ceil(Math.max(...boxes.map((b) => b.x + b.w)) - l));
  const h = Math.max(MIN_SIDE, Math.ceil(Math.max(...boxes.map((b) => b.y + b.h)) - t));
  const moved = items.map((it) => shift(it, -l, -t));
  const frame = { x: 0, y: 0, w, h, ...(moved.length === 1 && { item: moved[0].id }) };
  return { items: moved, w, h, frame };
}

// --- outline and style lists ---

/** Shape Outline > Weight in points (Word's nine). */
export const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6];
/** Weight item label: '2 1/4 pt'. */
export function weightLabel(pt) {
  const whole = Math.floor(pt);
  const frac = { 0.25: '1/4', 0.5: '1/2', 0.75: '3/4' }[pt - whole];
  return `${[whole || '', frac].filter(Boolean).join(' ')} pt`;
}

/** Shape Outline > Dashes: Word's eight dash names by item id → [label, the board's dash (flow/model.mjs DASHES)]. */
export const DASH_MAP = {
  solid: ['Solid', 'solid'], roundDot: ['Round Dot', 'dotted'], squareDot: ['Square Dot', 'dotted'], dash: ['Dash', 'dashed'],
  dashDot: ['Dash Dot', 'dashed'], longDash: ['Long Dash', 'dashed'], longDashDot: ['Long Dash Dot', 'dashed'], longDashDotDot: ['Long Dash Dot Dot', 'dashed'],
};
/** The Dashes item id that board dash `dash` came from (the first that maps to it). */
export const dashId = (dash) => Object.keys(DASH_MAP).find((id) => DASH_MAP[id][1] === (dash ?? 'solid')) ?? 'solid';

/** Shape Outline > Arrows: Word's eleven arrow styles → the board's heads (flow/model.mjs HEADS). */
export const HEAD_MAP = {
  style1: { start: 'none', end: 'none' }, style2: { start: 'none', end: 'arrow' }, style3: { start: 'arrow', end: 'none' },
  style4: { start: 'arrow', end: 'arrow' }, style5: { start: 'none', end: 'triangle' }, style6: { start: 'triangle', end: 'none' },
  style7: { start: 'triangle', end: 'triangle' }, style8: { start: 'circle', end: 'circle' }, style9: { start: 'diamond', end: 'diamond' },
  style10: { start: 'circle', end: 'arrow' }, style11: { start: 'bar', end: 'triangle' },
};

// The variants of each Shape Styles row: [label, (fill, stroke, ink) → item patch].
const VARIANTS = [
  ['Colored Outline', (f, s) => ({ fill: 'none', fillColor: f, color: s, width: 2, dash: 'solid' })],
  ['Colored Fill', (f, s) => ({ fill: 'solid', fillColor: s, color: s, width: 2, dash: 'solid', textColor: '#FFFFFF' })],
  ['Light Fill', (f, s) => ({ fill: 'solid', fillColor: f, color: s, width: 2, dash: 'solid', textColor: '#111111' })],
  ['Colored Fill, White Outline', (f, s) => ({ fill: 'solid', fillColor: s, color: '#FFFFFF', width: 2, dash: 'solid', textColor: '#FFFFFF' })],
  ['Hatched Fill', (f, s) => ({ fill: 'hatch', fillColor: s, color: s, width: 2, dash: 'solid' })],
  ['Dashed Outline', (f, s) => ({ fill: 'solid', fillColor: f, color: s, width: 2, dash: 'dashed', textColor: '#111111' })],
  ['Intense Outline', (f, s) => ({ fill: 'solid', fillColor: f, color: s, width: 4, dash: 'solid', textColor: '#111111' })],
];

/** Shape Styles: one row per accent (stylePresets' six colour pairs), seven variants each → [{id, label, group, patch}]. */
export function styleGallery(theme) {
  const presets = stylePresets(theme).slice(2, 8);
  return presets.flatMap(({ fill, stroke }, a) => VARIANTS.map(([label, make], v) => ({
    id: `a${a + 1}v${v + 1}`, label: `${label} - Accent ${a + 1}`, group: `Accent ${a + 1}`, patch: make(fill, stroke),
  })));
}

// Word's legacy Shadow Effects (compatibility modes 11 and 12). Offsets in points, x right, y down, from Word's Shape.Shadow and the
// VML it writes. Word's gallery also has 8 perspective and 7 additional styles: the engine draws plain offset shadows only.
const round2 = (n) => Math.round(n * 100) / 100;
/** The engine's distance and angle for offset (dx, dy). */
const polar = (dx, dy) => ({ distance: Math.hypot(dx, dy), angle: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 });
const legacyShadow = (dx, dy, transparency) => ({ color: '808080', transparency, blur: 0, ...polar(dx, dy) });
/** What Shadow On/Off turns on first. */
export const SHADOW_ON = legacyShadow(2, 2, 0);
/** The gallery's Drop Shadow styles by item id. */
export const SHADOW_STYLES = {
  shadowStyle1: legacyShadow(-6, -6, 50), shadowStyle2: legacyShadow(6, -6, 50), shadowStyle3: legacyShadow(-6, 6, 50),
  shadowStyle4: legacyShadow(6, 6, 50), shadowStyle5: legacyShadow(2, 2, 0),
};
const hex2 = (n) => n.toString(16).padStart(2, '0');
/** Shadow `s` as shape.effects takes it: object.get gives its colour as [r, g, b], the command takes 'RRGGBB'. */
export const shadowParams = (s) => ({ color: Array.isArray(s.color) ? s.color.map(hex2).join('').toUpperCase() : s.color, transparency: s.transparency,
  blur: s.blur, distance: s.distance, angle: s.angle });
/** The offset [dx, dy] of shadow `s`, to 0.01 pt, so repeated nudges do not drift. */
export function shadowOffset(s) {
  const a = (s.angle * Math.PI) / 180;
  return [round2(s.distance * Math.cos(a)), round2(s.distance * Math.sin(a))];
}
/** Shadow `s` moved by (dx, dy) points. */
export function nudgedShadow(s, dx, dy) {
  const [x, y] = shadowOffset(s);
  return { ...shadowParams(s), ...polar(x + dx, y + dy) };
}
/** Shadow Effects' gallery items, the one that matches shadow `now` (object.get's, or null) active. */
export function shadowGallery(now) {
  const same = (s) => !!now && now.blur === 0 && now.transparency === s.transparency && shadowOffset(now).join() === shadowOffset(s).join();
  return [{ id: 'noShadow', label: 'No Shadow', group: 'No Shadow Effect', active: !now },
    ...Object.entries(SHADOW_STYLES).map(([id, s], i) => ({ id, label: `Shadow Style ${i + 1}`, group: 'Drop Shadow', active: same(s) }))];
}

export { DASHES, HEADS };

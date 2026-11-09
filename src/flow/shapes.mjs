// The shape library: the board's shape registry and outline geometry (docs/wiki/flowchart.md §3.5, SPEC §6d), with every DrawingML
// preset as a kind drawn by its own guide maths (src/flow/presets.mjs) and listed in Word's groups (src/flow/gallery.mjs), so the
// canvases, boards, the flowchart editor and Word's Insert Shapes offer the same shapes (docs/plans/word/briefs/shape-pool.md).
// Pure: no DOM, so whiteboard.js, route.mjs, model.mjs, the .docx import and export and the Node tests share it.
import { GALLERY, PRESET_GROUP, PRESET_LABELS } from './gallery.mjs';
import { hasPreset, itemPath, PRESET_NAMES, presetAdjusted, presetHandles, presetShape, presetSites, presetTextRect } from './presets.mjs';

// A kind's path(w, h, inset, item) → {d, poly, parts?} is in item px (viewBox 0 0 w h, inset = stroke / 2): `d` the SVG outline (null
// for line, arrow and the speech and thought bubbles, which whiteboard.js shapeGeometry draws), `poly` the outline as [[x, y]…] (curves
// sampled; null for line and arrow, which attach on their box), `parts` a preset's paths with their fill modes. `rot` (degrees
// clockwise) turns a shape about its box centre; x y w h stay the unrotated box.

const r1 = (n) => Math.round(n * 10) / 10;
const pt = (x, y) => `${r1(x)} ${r1(y)}`;
const polyD = (poly) => `M${poly.map(([x, y]) => pt(x, y)).join('L')}Z`;
const rectPoly = (l, t, r, b) => [[l, t], [r, t], [r, b], [l, b]];
// n + 1 points on an ellipse arc from angle a0 to a1 (radians).
const arc = (cx, cy, rx, ry, a0, a1, n) => Array.from({ length: n + 1 }, (_, k) => {
  const a = a0 + ((a1 - a0) * k) / n;
  return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
});
const Q = Math.PI / 2;
const old = (poly) => ({ d: null, poly });
const closed = (poly, more = '') => ({ d: polyD(poly) + more, poly });
// A kind drawn in its inset box: f(left, top, right, bottom, width, height) → {d, poly}.
const inBox = (f) => (w, h, i) => f(i, i, w - i, h - i, w - 2 * i, h - 2 * i);

// 4 sides + 4 corners, as fractions of the box.
export const PORTS = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0, 0], [1, 0], [1, 1], [0, 1]];
export const LANE_BAND = 28; // a swimlane's title band, px

// The board's own kinds in registry order. group ∈ basic | flow | container (the quick tools take the basic ones); keywords: what
// the shape list and the tool search match besides the label. prst: the DrawingML preset the kind draws as (its path, adjust values
// and handles, and the gallery group it is listed in; its label, label box, ports and box stay the board's); a kind without one
// has its own `path`. Optional: section (the shape list's group when it is not the preset's or `group`), ports (default PORTS),
// labelInset (fractions of w / h, default 0.08), dash (dashed outline), band (title band px: the label sits in it), align / valign
// (label defaults), box ([w, h] post px of a click-placed shape, default 160 × 110), open (an open outline: never filled; it
// attaches and hit-tests on its box).
export const KINDS = [
  { kind: 'rect', prst: 'rect', label: 'Box', group: 'basic', keywords: ['rectangle', 'square', 'rect', 'border', 'outline', 'process', 'rectange', 'sqaure'] },
  { kind: 'round', prst: 'roundRect', label: 'Rounded box', group: 'basic', keywords: ['rounded rectangle', 'rounded square', 'round rect', 'rounded corners', 'pill', 'button'] },
  { kind: 'ellipse', prst: 'ellipse', label: 'Circle', group: 'basic', keywords: ['ellipse', 'oval', 'round', 'ring', 'elipse', 'cirlce', 'circel'] },
  { kind: 'triangle', prst: 'triangle', label: 'Triangle', group: 'basic', keywords: ['tri', 'pyramid', 'delta', 'wedge', 'trinagle', 'traingle'] },
  { kind: 'star', prst: 'star5', label: 'Star', group: 'basic', keywords: ['favourite', 'favorite', 'rating', 'sparkle', 'asterisk'] },
  { kind: 'arrow', section: 'lines', label: 'Arrow', group: 'basic', keywords: ['pointer', 'direction', 'connector', 'pointing', 'arow', 'arrrow'], path: () => old(null) },
  { kind: 'line', section: 'lines', label: 'Line', group: 'basic', keywords: ['straight line', 'rule', 'connector', 'segment', 'stroke'], path: () => old(null) },
  {
    // The cloud's ellipse body, widened to its bumps (the puffs are left out).
    kind: 'thought', section: 'callouts', label: 'Thought bubble', group: 'basic', keywords: ['thought', 'think', 'thinking', 'cloud', 'bubble', 'idea'],
    path: (w, h, i) => old(arc(w / 2, i + (h - 2 * i) * 0.4, (w / 2 - i) * 0.84 * 1.1, (h - 2 * i) * 0.32 * 1.1, 0, 4 * Q, 32).slice(0, 32)),
  },
  {
    kind: 'speech', section: 'callouts', label: 'Speech bubble', group: 'basic',
    keywords: ['speech', 'speech balloon', 'callout', 'comic', 'talk', 'say', 'dialogue', 'dialog', 'chat', 'bubble', 'balloon'],
    path: (w, h, i) => {
      const [l, t, r, b] = [i, i, w - i, h - i];
      const bb = b - (h - 2 * i) * 0.22;
      return old([[l, t], [r, t], [r, bb], [l + (r - l) * 0.42, bb], [l + (r - l) * 0.16, b], [l + (r - l) * 0.28, bb], [l, bb]]);
    },
  },
  { kind: 'pentagon', prst: 'pentagon', label: 'Pentagon', group: 'basic', keywords: ['five sides', 'polygon', 'house'] },
  { kind: 'octagon', prst: 'octagon', label: 'Octagon', group: 'basic', keywords: ['stop sign', 'eight sides', 'polygon'] },
  // Labelled with Word's names for their presets (the old board names stay keywords), so one shape has one name in every list.
  { kind: 'plus', prst: 'plus', label: 'Cross', group: 'basic', keywords: ['plus', 'add', 'greek cross', 'positive'] },
  { kind: 'cross', prst: 'mathMultiply', label: 'Multiplication Sign', group: 'basic', keywords: ['cross', 'x', 'times', 'multiply', 'saltire', 'close', 'wrong'] },
  { kind: 'cloud', prst: 'cloud', label: 'Cloud', group: 'basic', keywords: ['internet', 'network', 'sky', 'weather', 'online'] },
  { kind: 'stadium', prst: 'flowChartTerminator', label: 'Terminator', group: 'flow', keywords: ['start', 'end', 'stop', 'begin', 'finish', 'pill', 'stadium', 'terminal'] },
  { kind: 'diam', prst: 'flowChartDecision', label: 'Decision', group: 'flow', labelInset: { x: 0.2, y: 0.2 }, keywords: ['if', 'branch', 'condition', 'question', 'yes no', 'rhombus', 'diamond'] },
  { kind: 'lean-r', prst: 'flowChartInputOutput', label: 'Data', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['input', 'output', 'io', 'i/o', 'parallelogram', 'lean right'] },
  { kind: 'lean-l', label: 'Data (reversed)', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['input', 'output', 'io', 'parallelogram', 'lean left', 'reversed'],
    path: inBox((l, t, r, b, W) => closed([[l, t], [r - W * 0.2, t], [r, b], [l + W * 0.2, b]])) },
  { kind: 'doc', prst: 'flowChartDocument', label: 'Document', group: 'flow', labelInset: { x: 0.08, y: 0.12 }, keywords: ['doc', 'paper', 'report', 'file', 'page', 'printout'] },
  { kind: 'docs', prst: 'flowChartMultidocument', label: 'Multi-document', group: 'flow', labelInset: { x: 0.1, y: 0.14 }, keywords: ['documents', 'multiple documents', 'docs', 'files', 'pages', 'stack', 'reports'] },
  { kind: 'fr-rect', prst: 'flowChartPredefinedProcess', label: 'Subroutine', group: 'flow', labelInset: { x: 0.14, y: 0.08 }, keywords: ['predefined process', 'function', 'procedure', 'call', 'subprocess', 'module'] },
  { kind: 'hex', prst: 'flowChartPreparation', label: 'Preparation', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['prepare', 'setup', 'initialise', 'initialize', 'hexagon', 'loop'] },
  { kind: 'sl-rect', prst: 'flowChartManualInput', label: 'Manual input', group: 'flow', keywords: ['keyboard', 'enter', 'type in', 'user input', 'sloped'] },
  { kind: 'trap-t', prst: 'flowChartManualOperation', label: 'Manual operation', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['manual', 'by hand', 'trapezoid', 'inverted trapezoid'] },
  { kind: 'trap-b', label: 'Priority', group: 'flow', labelInset: { x: 0.2, y: 0.08 }, keywords: ['priority action', 'trapezoid', 'important'],
    path: inBox((l, t, r, b, W) => closed([[l + W * 0.2, t], [r - W * 0.2, t], [r, b], [l, b]])) },
  { kind: 'curv-trap', prst: 'flowChartDisplay', label: 'Display', group: 'flow', labelInset: { x: 0.16, y: 0.08 }, keywords: ['screen', 'monitor', 'show', 'output', 'curved trapezoid'] },
  { kind: 'bow-rect', prst: 'flowChartOnlineStorage', label: 'Stored data', group: 'flow', labelInset: { x: 0.14, y: 0.08 }, keywords: ['storage', 'data store', 'saved data', 'bow'] },
  { kind: 'cyl', prst: 'flowChartMagneticDisk', label: 'Database', group: 'flow', labelInset: { x: 0.08, y: 0.2 }, keywords: ['db', 'cylinder', 'sql', 'table', 'disk', 'storage', 'data store'] },
  { kind: 'h-cyl', prst: 'flowChartMagneticDrum', label: 'Direct access', group: 'flow', labelInset: { x: 0.18, y: 0.08 }, keywords: ['direct access storage', 'drum', 'hard disk', 'horizontal cylinder', 'storage'] },
  { kind: 'win-pane', prst: 'flowChartInternalStorage', label: 'Internal storage', group: 'flow', labelInset: { x: 0.14, y: 0.14 }, keywords: ['memory', 'ram', 'window pane', 'storage'] },
  { kind: 'delay', prst: 'flowChartDelay', label: 'Delay', group: 'flow', keywords: ['wait', 'pause', 'hold', 'half rounded', 'd shape'] },
  { kind: 'sm-circ', prst: 'flowChartConnector', label: 'On-page connector', group: 'flow', box: [60, 60], labelInset: { x: 0.15, y: 0.15 }, keywords: ['connector', 'reference', 'jump', 'small circle', 'circle'] },
  { kind: 'off-page', prst: 'flowChartOffpageConnector', label: 'Off-page connector', group: 'flow', box: [80, 80], labelInset: { x: 0.08, y: 0.12 }, keywords: ['off page', 'continue', 'next page', 'home plate', 'pentagon'] },
  {
    kind: 'notch-pent', label: 'Loop limit', group: 'flow', keywords: ['loop', 'repeat', 'while', 'for', 'iteration', 'notched pentagon'],
    path: inBox((l, t, r, b, W, H) => {
      const c = Math.min(W, H) * 0.2;
      return closed([[l + c, t], [r - c, t], [r, t + c], [r, b], [l, b], [l, t + c]]);
    }),
  },
  { kind: 'cross-circ', prst: 'flowChartSummingJunction', label: 'Summing junction', group: 'flow', box: [60, 60], keywords: ['sum', 'and', 'junction', 'crossed circle', 'x circle'] },
  { kind: 'or-circ', prst: 'flowChartOr', label: 'Or', group: 'flow', box: [60, 60], keywords: ['junction', 'merge', 'plus circle'] },
  { kind: 'hourglass', prst: 'flowChartCollate', label: 'Collate', group: 'flow', box: [80, 100], keywords: ['hourglass', 'bowtie', 'order', 'organise', 'organize'] },
  { kind: 'sort', prst: 'flowChartSort', label: 'Sort', group: 'flow', labelInset: { x: 0.2, y: 0.2 }, keywords: ['order', 'arrange', 'split diamond'] },
  { kind: 'notch-rect', prst: 'flowChartPunchedCard', label: 'Card', group: 'flow', keywords: ['punch card', 'punched card', 'notched rectangle'] },
  { kind: 'flag', prst: 'flowChartPunchedTape', label: 'Tape', group: 'flow', labelInset: { x: 0.08, y: 0.16 }, keywords: ['paper tape', 'punched tape', 'flag', 'wave'] },
  {
    // A curly brace down the left side; the text sits right of it.
    kind: 'brace', label: 'Annotation', group: 'flow', open: true, align: 'left', labelInset: { x: 0.12, y: 0.04 },
    keywords: ['comment', 'note', 'remark', 'brace', 'bracket', 'curly'],
    path: inBox((l, t, r, b, W, H) => {
      const e = Math.min(H / 4, W / 2, 16);
      const [m, cy] = [l + e / 2, t + H / 2];
      return {
        d: `M${pt(l + e, t)}Q${pt(m, t)} ${pt(m, t + e)}V${r1(cy - e)}Q${pt(m, cy)} ${pt(l, cy)}Q${pt(m, cy)} ${pt(m, cy + e)}V${r1(b - e)}Q${pt(m, b)} ${pt(l + e, b)}`,
        poly: rectPoly(l, t, r, b),
      };
    }),
  },
  { kind: 'fork', label: 'Fork/join bar', group: 'flow', box: [160, 14], keywords: ['join', 'bar', 'parallel', 'synchronisation', 'synchronization', 'split', 'merge'],
    path: inBox((l, t, r, b) => closed(rectPoly(l, t, r, b))) },
  {
    kind: 'lane', label: 'Swimlane', group: 'container', band: LANE_BAND, box: [900, 180], keywords: ['swim lane', 'lane', 'pool', 'container', 'group', 'actor', 'role'],
    path: (w, h, i) => {
      const poly = rectPoly(i, i, w - i, h - i);
      return { d: `${polyD(poly)}M${pt(i, Math.min(LANE_BAND, h - i))}H${r1(w - i)}`, poly };
    },
  },
  {
    kind: 'frame', label: 'Frame', group: 'container', dash: true, labelInset: { x: 0.01, y: 0.01 }, align: 'left', valign: 'top',
    keywords: ['group', 'container', 'border', 'section', 'dashed box', 'area'],
    path: (w, h, i) => {
      const poly = rectPoly(i, i, w - i, h - i);
      return { d: polyD(poly), poly };
    },
  },
];
/** A shape drawn from its own geometry: custom geometry (it.path, a Word freeform) or, in files from before every preset had a kind,
 * a preset by name (it.prst, it.av; src/flow/presets.mjs). Not in KINDS, so no shape list, tool or agent schema offers it. `parts`:
 * the geometry's paths, each with its fill mode and stroke. */
export const PATH_KIND = {
  kind: 'path', label: 'Freeform', group: 'basic', keywords: ['freeform', 'custom shape'],
  path: (w, h, i, it) => {
    const parts = itemPath(it, w, h, i);
    return { d: parts.filter((p) => p.fill !== 'none' || p.stroke).map((p) => p.d).join('') || null, poly: rectPoly(i, i, w - i, h - i), parts };
  },
};

// --- the presets as kinds ---

/** A kind's path drawn by preset `prst` in the inset box, with the item's adjust values: its parts (each with its fill mode and
 * stroke), `d` the stroked parts (the outline the hit path and icons draw), and the outline poly (its largest filled subpath; a
 * shape with none, a line, attaches on its box). */
const fromPreset = (prst) => (w, h, i, it) => {
  const s = presetShape(prst, it?.av, Math.max(1, w - 2 * i), Math.max(1, h - 2 * i), i, i);
  const stroked = s.parts.filter((p) => p.stroke);
  return { d: (stroked.length ? stroked : s.parts).map((p) => p.d).join('') || null, poly: s.poly ?? rectPoly(i, i, w - i, h - i), parts: s.parts };
};
for (const k of KINDS) {
  if (!k.prst) continue;
  k.path = fromPreset(k.prst);
  k.section ??= PRESET_GROUP[k.prst];
  k.keywords = [...new Set([...k.keywords, ...(PRESET_LABELS[k.prst] ? [PRESET_LABELS[k.prst].toLowerCase()] : [])])];
}
const OWN_PRESET = new Map(KINDS.filter((k) => k.prst).map((k) => [k.prst, k.kind]));
const words = (s) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Every other preset as a kind of its own, its id the preset's name (frameShape and lineShape where the board has a frame and a
 * line kind of its own), labelled with Word's name; those Word's gallery does not list (action buttons, tabs, gears) are drawn
 * when a file has them but are in no list. */
export const PRESET_KINDS = PRESET_NAMES.filter((p) => !OWN_PRESET.has(p)).map((prst) => {
  const kind = KINDS.some((k) => k.kind === prst) ? `${prst}Shape` : prst;
  const label = PRESET_LABELS[prst] ?? words(prst).join(' ').replace(/^./, (c) => c.toUpperCase());
  return { kind, prst, label, group: PRESET_GROUP[prst] ?? 'more', section: PRESET_GROUP[prst] ?? null, path: fromPreset(prst),
    keywords: [...new Set([...words(label), ...words(prst)])] };
});
const BY_PRESET = new Map([...OWN_PRESET, ...PRESET_KINDS.map((k) => [k.prst, k.kind])]);
const IS_PRESET = new Set(PRESET_KINDS);
/** The kind that draws preset `prst` (a board kind where one does, else the preset's own), or null for an unknown name. */
export const presetKind = (prst) => (hasPreset(prst) ? BY_PRESET.get(prst) : null) ?? null;

const BY_KIND = new Map([...KINDS, ...PRESET_KINDS, PATH_KIND].map((k) => [k.kind, k]));
export const kindOf = (kind) => BY_KIND.get(kind) ?? null;

// Before every preset had a kind (2026-10-30) the .docx import kept a preset's name on the item: a rectangle for one the board
// could not draw ({shape: 'rect', prst}), or the board kind that drew it (OLD_KIND, rightBrace and flowChartMerge flipped), whose
// preset may now be another one. The old export wrote that name back in those two cases only. So a rectangle naming a preset the
// old import gave another kind (OLD_KIND's other keys, OLD_LISTED) or drew as a 'path' item (OLD_DRAWN) was changed to a rectangle
// by hand (Change Shape kept the name), and stays one.
const OLD_KIND = { diamond: 'diam', parallelogram: 'lean-r', trapezoid: 'trap-b', hexagon: 'hex', can: 'cyl', leftBrace: 'brace', rightBrace: 'brace',
  wave: 'flag', mathPlus: 'plus', wedgeRectCallout: 'speech', cloudCallout: 'thought', flowChartProcess: 'rect', flowChartAlternateProcess: 'round',
  flowChartExtract: 'triangle', flowChartMerge: 'triangle' };
const OLD_FLIP = { rightBrace: 'mirrorX', flowChartMerge: 'mirrorY' };
const OLD_DRAWN = new Set(('arc bevel bracketPair chevron chord corner cube diagStripe donut downArrow foldedCorner frame heart hexagon homePlate leftArrow '
  + 'leftBracket leftRightArrow mathEqual mathMinus notchedRightArrow octagon parallelogram pie plaque plus rightArrow rightBracket round1Rect '
  + 'round2SameRect roundRect rtTriangle snip1Rect snip2SameRect star4 stripedRightArrow trapezoid triangle upDownArrow upArrow').split(' '));
// The rest of the old import's PRESET_KIND keys: presets a board kind drew as itself, then as now.
const OLD_LISTED = new Set(('rect roundRect ellipse triangle octagon plus pentagon star5 mathMultiply cloud flowChartDecision '
  + 'flowChartInputOutput flowChartPredefinedProcess flowChartInternalStorage flowChartDocument flowChartMultidocument flowChartTerminator '
  + 'flowChartPreparation flowChartManualInput flowChartManualOperation flowChartConnector flowChartOffpageConnector flowChartPunchedCard '
  + 'flowChartPunchedTape flowChartSummingJunction flowChartOr flowChartCollate flowChartSort flowChartOnlineStorage flowChartDelay '
  + 'flowChartMagneticDisk flowChartMagneticDrum flowChartDisplay').split(' '));
/** Item `it` from such a file as the kind that draws its preset (its adjust values kept, the old kind's flip undone); any other
 * item as it is. Run where items load (whiteboard.js) and before export (shapes-out.mjs), which may see items never loaded. */
export function upgradedShape(it) {
  const prst = it?.type === 'shape' && it.shape !== 'path' && hasPreset(it.prst) ? it.prst : null;
  const unlisted = (p) => !OLD_DRAWN.has(p) && !OLD_LISTED.has(p) && !Object.hasOwn(OLD_KIND, p);
  const old = prst && (OLD_KIND[prst] === it.shape || (it.shape === 'rect' && unlisted(prst)));
  if (!old) return it;
  const { prst: _, ...out } = it;
  out.shape = presetKind(prst);
  const flip = OLD_KIND[prst] === it.shape && OLD_FLIP[prst];
  if (flip && out[flip]) delete out[flip];
  else if (flip) out[flip] = true;
  return out;
}

/** The shape list's groups in order (shape-list.mjs; titles for the lists): the board's lines, Word's gallery groups, containers. */
export const SHAPE_SECTIONS = [{ id: 'lines', title: 'Lines' }, ...GALLERY.map(({ id, title }) => ({ id, title })), { id: 'container', title: 'Containers' }];
const sectionOf = (k) => k.section ?? k.group;
/** Every listed kind in the lists' order: each gallery group's shapes in Word's order (a board kind where one draws the preset),
 * then the board's own kinds of that group that are no preset; the lines first and the containers last. */
export const SHAPE_KINDS = SHAPE_SECTIONS.flatMap(({ id }) => [
  ...(GALLERY.find((s) => s.id === id)?.shapes ?? []).map(([p]) => kindOf(presetKind(p))),
  ...KINDS.filter((k) => !k.prst && sectionOf(k) === id),
]);

// --- per item: the preset it draws, its handles, text box and connection sites ---

/** The preset item `it` draws as (its kind's, or a 'path' item's own), or null. */
export const prstOf = (it) => kindOf(it?.shape)?.prst ?? (it?.shape === 'path' && hasPreset(it.prst) ? it.prst : null);
// Item `it`'s inset box (the stroke inside its box): [inset, w, h].
const insetBox = (it) => {
  const i = (it.width || 0) / 2;
  return [i, Math.max(1, it.w - 2 * i), Math.max(1, it.h - 2 * i)];
};
// A point of item `it`'s unmirrored box where its mirrored drawing shows it (and back).
const mirroredXY = (it, x, y) => [it.mirrorX ? it.w - x : x, it.mirrorY ? it.h - y : y];

/** Shape item `it`'s adjust handles in item px (its unturned box, mirrored with it): [{x, y}]; none for a kind without a preset. */
export function handlesOf(it) {
  const prst = it?.type === 'shape' && prstOf(it);
  if (!prst) return [];
  const [i, w, h] = insetBox(it);
  return presetHandles(prst, it.av, w, h).map((p) => {
    const [x, y] = mirroredXY(it, i + p.x, i + p.y);
    return { x, y };
  });
}
/** Item `it`'s adjust values with handle `k` dragged to `p` (item px, its unturned box), or null when it has no such handle. */
export function adjustedAv(it, k, p) {
  const prst = prstOf(it);
  if (!prst || !handlesOf(it)[k]) return null;
  const [i, w, h] = insetBox(it);
  const [x, y] = mirroredXY(it, p.x, p.y);
  return presetAdjusted(prst, it.av, w, h, k, { x: x - i, y: y - i });
}

/** Where shape item `it`'s text goes, as px in from its box's edges {l, t, r, b}, or null for the board's own label box (labelInset):
 * the preset's text rectangle, less the item's internal margins (`inset`, Word's), for a preset kind and for any item from Word. */
export function labelBox(it) {
  const k = kindOf(it?.shape);
  const prst = prstOf(it);
  if (!prst || (k?.kind !== 'path' && !IS_PRESET.has(k) && !it.inset)) return null;
  const [i, w, h] = insetBox(it);
  const r = presetTextRect(prst, it.av, w, h);
  const m = ['t', 'r', 'b', 'l'].every((s) => Number.isFinite(it.inset?.[s])) ? it.inset : { t: 0, r: 0, b: 0, l: 0 };
  const box = { l: i + r.l + m.l, t: i + r.t + m.t, r: it.w - i - r.r + m.r, b: it.h - i - r.b + m.b };
  return { l: it.mirrorX ? box.r : box.l, r: it.mirrorX ? box.l : box.r, t: it.mirrorY ? box.b : box.t, b: it.mirrorY ? box.t : box.b };
}

const SITES = new Map(); // ponytail: cleared whole at 2000 entries
/** A preset kind's connection sites as anchors of its box ([[rx, ry]], those inside it) with their directions (degrees). */
function sitesOf(it) {
  const prst = it?.type === 'shape' && IS_PRESET.has(kindOf(it.shape)) && prstOf(it);
  if (!prst) return null;
  const key = `${prst}|${it.w}|${it.h}|${it.width}|${!!it.mirrorX}|${!!it.mirrorY}|${it.av ? JSON.stringify(it.av) : ''}`;
  if (!SITES.has(key)) {
    const [i, w, h] = insetBox(it);
    const f = (v) => Math.round(v * 1e6) / 1e6;
    const out = presetSites(prst, it.av, w, h).map((s) => ({ a: mirroredXY(it, i + s.x, i + s.y).map((v, k) => f(v / (k ? it.h : it.w))), ang: s.ang }))
      .filter(({ a }) => a.every((v) => v >= 0 && v <= 1));
    if (SITES.size > 2000) SITES.clear();
    SITES.set(key, out.length ? out : null);
  }
  return SITES.get(key);
}
const siteAt = (it, anchor) => sitesOf(it)?.find(({ a }) => Math.abs(a[0] - anchor[0]) < 1e-5 && Math.abs(a[1] - anchor[1]) < 1e-5) ?? null;

/** Item `it`'s box on the board with everything it draws ({x, y, w, h}): its turned box, grown to a preset's parts that reach
 * past it (a callout's tail). */
export function drawnBox(it) {
  const prst = it?.type === 'shape' && prstOf(it);
  if (!prst) return rotBox(it);
  const [i, w, h] = insetBox(it);
  const b = presetShape(prst, it.av, w, h, i, i).bounds;
  const [l, t, r, bt] = [Math.min(0, b.x), Math.min(0, b.y), Math.max(it.w, b.x + b.w), Math.max(it.h, b.y + b.h)];
  const pts = rotatePoly(it, [[l, t], [r, t], [r, bt], [l, bt]].map(([x, y]) => mirroredXY(it, x, y)));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Kind `kind`'s icon path in a w × h box: the stroked outline, scaled down and moved so a part past the box (a callout's tail)
 * fits too; null for a kind whose outline whiteboard.js draws (line, arrow, the speech and thought bubbles). */
export function iconOf(kind, w, h, i = 1) {
  const k = kindOf(kind);
  const g = k?.path(w, h, i, null);
  if (!g?.d) return null;
  const prst = k.prst;
  if (!prst) return { d: g.d };
  const b = presetShape(prst, null, w - 2 * i, h - 2 * i, i, i).bounds;
  if (b.x >= 0 && b.y >= 0 && b.x + b.w <= w && b.y + b.h <= h) return { d: g.d };
  const s = Math.min((w - 2 * i) / b.w, (h - 2 * i) / b.h);
  const [iw, ih] = [(w - 2 * i) * s, (h - 2 * i) * s];
  const inner = presetShape(prst, null, iw, ih, 0, 0);
  const [ox, oy] = [(w - inner.bounds.w) / 2 - inner.bounds.x, (h - inner.bounds.h) / 2 - inner.bounds.y];
  const parts = presetShape(prst, null, iw, ih, ox, oy).parts;
  const stroked = parts.filter((p) => p.stroke);
  return { d: (stroked.length ? stroked : parts).map((p) => p.d).join('') };
}
/** Whether shape kind `s` can be filled: not a line or arrow, not an open outline (the annotation brace). */
export const fillable = (s) => s !== 'line' && s !== 'arrow' && !kindOf(s)?.open;

// --- rotation ---

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** Whether item `it` can turn: every item but a connector (its line follows its ends). */
export const turns = (it) => ['shape', 'image', 'text', 'stroke', 'canvas'].includes(it?.type);
/** Item `it`'s angle in degrees (0 for an item that cannot turn). */
export const rotOf = (it) => (turns(it) && Number.isFinite(it.rot) ? it.rot : 0);

/** Point `p` turned `deg` degrees clockwise (screen axes, y down) about `c`; the inverse is -deg. */
export function rotatePoint(p, c, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const a = (deg * Math.PI) / 180;
  const [cos, sin, dx, dy] = [Math.cos(a), Math.sin(a), p.x - c.x, p.y - c.y];
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** `poly` ([[x, y]…] in item px) placed at box `b` ({x, y, w, h, rot?}) and turned about its centre → [{x, y}] board px. */
export function rotatePoly(b, poly) {
  const c = centre(b);
  return poly.map(([x, y]) => rotatePoint({ x: b.x + x, y: b.y + y }, c, b.rot));
}

/** The axis-aligned bounds of box `b` turned by `b.rot` about its centre. */
export function rotBox(b) {
  if (!b.rot) return { x: b.x, y: b.y, w: b.w, h: b.h };
  const a = (b.rot * Math.PI) / 180;
  const [cos, sin] = [Math.abs(Math.cos(a)), Math.abs(Math.sin(a))];
  const [w, h] = [b.w * cos + b.h * sin, b.w * sin + b.h * cos];
  const c = centre(b);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

// --- lines and arrows (whiteboard.js draws them; model.mjs resizeWithGroup maps their ends) ---

export const isLineish = (s) => s === 'line' || s === 'arrow';
export const arrowHead = (width) => Math.max(12, width * 3.5);
/** Line/arrow boxes are padded so the stroke and arrowhead fit; endpoints sit at opposite padded corners. */
export const linePad = (item) => (item.shape === 'arrow' ? arrowHead(item.width) * 0.6 : item.width / 2) + 1;

/** A line's or arrow's two ends in board px ([start, end], turned with it): where its tip handles sit. */
export function lineEnds(it) {
  const p = linePad(it);
  const [x1, x2] = it.flipX ? [it.w - p, p] : [p, it.w - p];
  const [y1, y2] = it.flipY ? [it.h - p, p] : [p, it.h - p];
  const c = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  return [[x1, y1], [x2, y2]].map(([x, y]) => rotatePoint({ x: it.x + x, y: it.y + y }, c, rotOf(it)));
}

// --- outline, perimeter, ports ---

/** Item `it`'s outline in board px ([{x, y}]): its kind's poly, else its box, turned by its rot (rotOf). `b`: its unrotated box
 * (text: the rendered height; default the item itself). */
export function outlineOf(it, b = it) {
  const poly = (it.type === 'shape' && kindOf(it.shape)?.path(b.w, b.h, (it.width || 0) / 2, it).poly) || rectPoly(0, 0, b.w, b.h);
  return rotatePoly({ x: b.x, y: b.y, w: b.w, h: b.h, rot: rotOf(it) }, poly);
}

/** Where the ray from `from` through `toward` leaves polygon `poly` ([{x, y}]): its farthest crossing (the outer edge of a
 * concave outline); `from` itself when the ray is degenerate or misses. */
export function perimeter(poly, from, toward) {
  const [dx, dy] = [toward.x - from.x, toward.y - from.y];
  if (!dx && !dy) return { x: from.x, y: from.y };
  let best = -1;
  for (let k = 0; k < poly.length; k++) {
    const [a, b] = [poly[k], poly[(k + 1) % poly.length]];
    const [ex, ey, ax, ay] = [b.x - a.x, b.y - a.y, a.x - from.x, a.y - from.y];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den; // along the ray
    const u = (ax * dy - ay * dx) / den; // along the edge
    if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && t > best) best = t;
  }
  return best < 0 ? { x: from.x, y: from.y } : { x: from.x + dx * best, y: from.y + dy * best };
}

/** A fixed anchor ([rx, ry] of the unrotated box) turned with the item and moved from the centre onto its outline, so a
 * box port lands on a diamond's edge and a bound end turns with its shape. */
export function anchorPoint(it, anchor, b = it) {
  const c = centre(b);
  const p = rotatePoint({ x: b.x + anchor[0] * b.w, y: b.y + anchor[1] * b.h }, c, rotOf(it));
  if (siteAt(it, anchor)) return p; // a preset's connection site: the line ends there
  return perimeter(outlineOf(it, b), c, p);
}

/** A pinned end's point (§6d): anchor [rx, ry] of the unrotated box turned with the item, left where it is (inside the item). */
export const pinPoint = (it, anchor, b = it) => rotatePoint({ x: b.x + anchor[0] * b.w, y: b.y + anchor[1] * b.h }, centre(b), rotOf(it));

/** Item `it`'s ports: a preset kind's connection sites, else its kind's ports or the box's sides and corners. */
export const portsOf = (it) => sitesOf(it)?.map((x) => x.a) ?? ((it.type === 'shape' && kindOf(it.shape)?.ports) || PORTS);

/** The item's port points in board px (on its turned outline). */
export const portPoints = (it, b = it) => portsOf(it).map((a) => anchorPoint(it, a, b));

/** The outward unit normal of the box side an anchor is on, turned by a shape's rot. */
export function portNormal(it, anchor) {
  const site = siteAt(it, anchor);
  if (site) {
    const a = (site.ang * Math.PI) / 180;
    const [mx, my] = [it.mirrorX ? -1 : 1, it.mirrorY ? -1 : 1];
    return rotatePoint({ x: Math.round(Math.cos(a) * mx * 1e6) / 1e6 || 0, y: Math.round(Math.sin(a) * my * 1e6) / 1e6 || 0 }, { x: 0, y: 0 }, rotOf(it));
  }
  const [dx, dy] = [anchor[0] - 0.5, anchor[1] - 0.5];
  const n = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) };
  return rotatePoint(n, { x: 0, y: 0 }, rotOf(it));
}

// --- styles ---

/** draw.io's default fill / stroke pairs (text #111111) plus two theme pairs: card / ink and transparent / ink (dark theme
 * values; stylePresets picks per theme). Raw hex: agents may pass `preset: n` in place of colours. */
export const STYLE_PRESETS = [
  ['#ffffff', '#000000'], ['#f5f5f5', '#666666'], ['#dae8fc', '#6c8ebf'], ['#d5e8d4', '#82b366'], ['#ffe6cc', '#d79b00'],
  ['#fff2cc', '#d6b656'], ['#f8cecc', '#b85450'], ['#e1d5e7', '#9673a6'],
].map(([fill, stroke]) => ({ fill, stroke, text: '#111111' })).concat([
  { fill: '#3a3b46', stroke: '#ffffff', text: '#ffffff' },
  { fill: 'transparent', stroke: '#ffffff', text: '#ffffff' },
]);

/** The fill a new shape and flowchart node draws: flat, with no outline (the user, 2026-11-02: "the default styles should all be
 * flat colors. no outlines"). The board palette's blue, which reads on the light and the dark board, under either theme's ink. */
export const FLAT_FILL = '#4a7fe0';
const inkCard = (theme) => (theme === 'light' ? ['#111111', '#f0f0f4'] : ['#ffffff', '#3a3b46']);

/** The shape tool preset of Insert flowchart and the library editor: the flat fill with no outline (width 0), the page theme's ink
 * for the label and for a line set later. */
export function flowPreset(theme) {
  const [ink] = inkCard(theme);
  return { shape: 'rect', color: ink, width: 0, opacity: 1, fill: 'solid', fillColor: FLAT_FILL, size: 16, textColor: ink };
}

/** STYLE_PRESETS with the two theme pairs in `theme`'s card and ink (the preset row's swatches). */
export function stylePresets(theme) {
  const [ink, card] = inkCard(theme);
  return STYLE_PRESETS.map((p, k) => (k < 8 ? p : { fill: k === 8 ? card : p.fill, stroke: ink, text: ink }));
}

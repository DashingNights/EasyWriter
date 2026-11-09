// Arrange's pure logic (docs/plans/word plan.md §3 arrange, briefs/arrange.md): z order among a page's floating objects, the
// layout patch Align writes, object navigation, Word's default object names, rotation steps and the drawing grid's lines. No DOM
// or app import, so node tests load it.

// Distribute is the canvases' own (equal gaps, the outermost boxes stay), so the Board and this package space boxes the same way.
export { distribute } from '../../../flow/model.mjs';

/** Whether `node` (a ProseMirror node or its JSON) is one of the objects Arrange serves: a picture, text box, canvas or plan chart. */
export const isObject = (node) => ['image', 'textBox', 'canvas', 'planChart'].includes(node?.type?.name ?? node?.type);

/** Whether object `node` floats: a layout whose wrap is not inline (a picture or canvas without layout is inline). */
export const isFloating = (node) => {
  const w = node?.attrs?.layout?.wrap;
  return !!w && w !== 'inline';
};

/** The objects of ProseMirror `doc` in document order → [{pos, node, float, z}]. */
export function objectsOf(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!isObject(node)) return true;
    out.push({ pos, node, float: isFloating(node), z: node.attrs.layout?.z ?? 0 });
    return node.type.name === 'textBox'; // a text box's own content may hold pictures
  });
  return out;
}

/** The new z of each object that changes when `op` ('forward' | 'backward' | 'front' | 'back') moves object `id` among `objs`
 * ([{id, z}] in document order, the floating objects of one page) → {id: z}. Equal z values stack in document order (a later
 * one is in front), and are first spread to 1..n so a step swaps two distinct layers. */
export function zOps(objs, id, op) {
  const order = objs.map((o, i) => ({ ...o, z: o.z ?? 0, i })).sort((a, b) => a.z - b.z || a.i - b.i);
  const k = order.findIndex((o) => o.id === id);
  if (k < 0) return {};
  const out = {};
  if (new Set(order.map((o) => o.z)).size < order.length) order.forEach((o, n) => { if (o.z !== n + 1) out[o.id] = o.z = n + 1; });
  const me = order[k];
  const swap = (j) => {
    const other = order[j];
    if (!other) return;
    [out[me.id], out[other.id]] = [other.z, me.z];
  };
  if (op === 'forward') swap(k + 1);
  else if (op === 'backward') swap(k - 1);
  else if (op === 'front' && k < order.length - 1) out[id] = order.at(-1).z + 1;
  else if (op === 'back' && k > 0) {
    // z stays 0 or more (DOCX relativeHeight is unsigned): at the floor the layers are renumbered 1..n with this one at 1.
    if (order[0].z > 0) out[id] = order[0].z - 1;
    else [me, ...order.filter((o) => o !== me)].forEach((o, n) => { if (o.z !== n + 1) out[o.id] = n + 1; });
  }
  return out;
}

const WHERE = { left: ['h', 'left'], center: ['h', 'center'], right: ['h', 'right'], top: ['v', 'top'], middle: ['v', 'center'], bottom: ['v', 'bottom'] };

/** The layout patch that aligns one floating object `where` ('left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') to `rel`
 * ('page' | 'margin') over its `layout` → {h} or {v}: Word's relative alignment, which replaces an absolute offset. */
export function alignTo(layout, where, rel) {
  const [axis, align] = WHERE[where];
  const { offset, pct, ...keep } = layout?.[axis] ?? {}; // eslint-disable-line no-unused-vars
  return { [axis]: { ...keep, rel, align } };
}

/** The order of `ids` (front-most first) after row `drag` is dropped on row `to` in the Selection pane → a new array, or null
 * when nothing moves (dropped on itself or off the floats). Moving down lands after the target, moving up before it, so every
 * place is reachable, the back-most included. */
export function dropOrder(ids, drag, to) {
  const from = ids.indexOf(drag);
  const at = ids.indexOf(to);
  if (from < 0 || at < 0 || from === at) return null;
  const out = ids.filter((id) => id !== drag);
  out.splice(at, 0, drag); // with `drag` taken out, index `at` is after the target going down and before it going up
  return out;
}

/** The position of the next (`dir` 1) or previous (-1) object of `positions` (document order) from `at`, wrapping at the ends;
 * `strict`: `at` is an object itself, so it is skipped. → null when there is none. */
export function nextObject(positions, at, dir, strict = false) {
  if (!positions.length) return null;
  if (dir > 0) return positions.find((p) => (strict ? p > at : p >= at)) ?? positions[0];
  return positions.findLast((p) => p < at) ?? positions.at(-1);
}

// Word's names for the shapes a one-shape canvas can hold (the board's shape kinds).
const SHAPE_NAMES = { rect: 'Rectangle', ellipse: 'Oval', triangle: 'Isosceles Triangle', diamond: 'Diamond', line: 'Straight Connector',
  arrow: 'Straight Arrow Connector' };

/** Word's base name of object `node`: Picture, Text Box, a one-shape canvas's shape name (Rectangle), Canvas or Chart. */
export function baseName(node) {
  const t = node.type?.name ?? node.type;
  if (t === 'image') return 'Picture';
  if (t === 'textBox') return 'Text Box';
  if (t === 'planChart') return 'Chart';
  const items = node.attrs?.items ?? [];
  return items.length === 1 && items[0].type === 'shape' ? SHAPE_NAMES[items[0].shape] ?? 'Shape' : 'Canvas';
}

/** The stored name of object `node`: image and textBox name, a canvas's or plan chart's docPr.name; null when it has none. */
export const ownName = (node) => node.attrs?.name ?? node.attrs?.docPr?.name ?? null;

/** The names of `nodes` (document order): each its own name, else Word's default "<base> N". */
// ponytail: Word numbers default names in insertion order; this numbers by document position, so a default name changes when
// an object is inserted before it or moved. Number by a stable per-object id once objects carry one.
export const objectNames = (nodes) => nodes.map((n, i) => ownName(n) || `${baseName(n)} ${i + 1}`);

/** `angle` turned by `by` degrees → 0..359. */
export const rotateStep = (angle, by) => ((((angle ?? 0) + by) % 360) + 360) % 360;

/** The drawing grid's lines on a page `box` ({w, h, top, right, bottom, left}) for doc settings `grid` ({h, v, useMargins, x, y,
 * everyH, everyV}; null = Word's defaults), both in one unit → {xs, ys}: vertical lines every h × everyV and horizontal lines
 * every v × everyH across the text area, counted from the margins or the origin (everyV or everyH 0: none that way). */
export function gridLines(box, grid) {
  const g = { ...GRID_DEFAULTS, ...grid };
  const run = (lo, hi, origin, step) => {
    if (!(step > 0)) return [];
    const out = [];
    for (let p = origin - Math.floor((origin - lo) / step + 1e-9) * step; p <= hi + 1e-6; p += step) out.push(Math.round(p * 100) / 100);
    return out;
  };
  const x0 = g.useMargins ? box.left : g.x;
  const y0 = g.useMargins ? box.top : g.y;
  return { xs: run(box.left, box.w - box.right, x0, g.h * g.everyV), ys: run(box.top, box.h - box.bottom, y0, g.v * g.everyH) };
}

/** Word's drawing grid (plan.md §1.8 settings.grid; null means these): 9 pt both ways from the margins, every line shown. */
export const GRID_DEFAULTS = { h: 9, v: 9, useMargins: true, x: 72, y: 72, everyH: 1, everyV: 1 };

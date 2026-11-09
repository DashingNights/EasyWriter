// Borders and shading, the pure part (docs/plans/word/plan.md §3 borders, briefs/borders.md): the Borders gallery's items as
// patches for paragraphs, runs and cells, Word's grouping of bordered paragraphs, the dialog's Setting presets and its Style,
// Width and Pattern lists mapped to office.mjs values. No DOM or app import, so node tests load it.

/** The 12 edge items of the Borders menu, as the derived item ids' last segment (plan.md §1.4 Derived items), in menu order. */
export const EDGE_ITEMS = ['bottomBorder', 'topBorder', 'leftBorder', 'rightBorder', 'noBorder', 'allBorders', 'outsideBorders', 'insideBorders',
  'insideHorizontalBorder', 'insideVerticalBorder', 'diagonalDownBorder', 'diagonalUpBorder'];

// The edges each item sets. Paragraphs know top, bottom, left, right and between; cells the same plus insideH, insideV and the
// diagonals tl2br and tr2bl.
const ITEM_EDGES = {
  bottomBorder: ['bottom'], topBorder: ['top'], leftBorder: ['left'], rightBorder: ['right'], noBorder: [],
  allBorders: ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'], outsideBorders: ['top', 'bottom', 'left', 'right'],
  insideBorders: ['insideH', 'insideV'], insideHorizontalBorder: ['insideH'], insideVerticalBorder: ['insideV'],
  diagonalDownBorder: ['tl2br'], diagonalUpBorder: ['tr2bl'],
};
const PARA_EDGES = ['top', 'bottom', 'left', 'right', 'between'];
const CELL_EDGES = ['top', 'bottom', 'left', 'right', 'tl2br', 'tr2bl'];

/** The edges `item` sets on paragraphs: inside horizontal is the between border, and paragraphs have no vertical inside. */
export const paraEdgesOf = (item) => [...new Set((ITEM_EDGES[item] ?? []).map((e) => (e === 'insideH' ? 'between' : e)).filter((e) => PARA_EDGES.includes(e)))];

/** Word's default distance from text in pt by edge (the Options dialog: Top 1, Bottom 1, Left 4, Right 4). */
export const SPACE = { top: 1, bottom: 1, left: 4, right: 4, between: 1, bar: 4 };

/** Whether border edge `e` draws a line (nil and none switch an inherited one off). */
export const isLine = (e) => !!e?.style && e.style !== 'nil' && e.style !== 'none';

/** The room in pt line `e` takes across its edge, as Word lays out a paragraph border (`width` is w:sz / 8, Word's width of one
 * line). Measured in Word over w:sz 1 to 100 (.smoke-data/word/fixture/out/probe/border-widths, probe_docx.py and probe2_docx.py):
 * the gaps of the thin-thick families are fixed, the waves and the stroked dash ignore the width, and two measured steps are
 * Word's own (a 1.5 pt wave takes 3.75, the 3-D lines take 1.5 pt more from 3 pt up). */
export function lineWidth(e) {
  if (!isLine(e)) return 0;
  const w = e.width || 0.5;
  switch (e.style) {
    case 'double': case 'thinThickThinMediumGap': return 3 * w;
    case 'triple': return 5 * w;
    case 'thinThickMediumGap': case 'thickThinMediumGap': return 2 * w;
    case 'thinThickSmallGap': case 'thickThinSmallGap': return w + 1.5;
    case 'thinThickThinSmallGap': return w + 3;
    case 'thinThickLargeGap': case 'thickThinLargeGap': return w + 2.25;
    case 'thinThickThinLargeGap': return 2 * w + 3;
    case 'threeDEmboss': case 'threeDEngrave': return w + (w < 3 ? 1.5 : 3);
    case 'wave': return w === 1.5 ? 3.75 : 3;
    case 'doubleWave': return 5.25;
    case 'dashDotStroked': return 3;
    default: return w; // single, the dots and dashes, thick, inset and outset
  }
}

/** A border edge in the pen {style, width, color (null: Automatic)}, `space` pt from the text. */
export const edgeOf = (pen, space = 0) => ({ style: pen?.style ?? 'single', width: pen?.width ?? 0.5, space, color: pen?.color ?? 'auto', shadow: false, frame: false });

/** Whether line `e` has the pen's style, weight and colour (its distance from text aside). */
const inPen = (e, pen) => e.style === (pen.style ?? 'single') && (e.width ?? 0.5) === (pen.width ?? 0.5) && (e.color ?? 'auto') === (pen.color ?? 'auto');

const sameLine = (a, b) => isLine(a) === isLine(b) && (!isLine(a) || (a.style === b.style && (a.width ?? 0.5) === (b.width ?? 0.5)
  && (a.color ?? 'auto') === (b.color ?? 'auto') && (a.space ?? 0) === (b.space ?? 0) && !!a.shadow === !!b.shadow && !!a.frame === !!b.frame));

/** Whether borders object `b` has every edge `item` sets on paragraphs (the item's pressed state); No Border: has none. */
export function paraHas(item, b) {
  if (item === 'noBorder') return !PARA_EDGES.some((e) => isLine(b?.[e]));
  const edges = paraEdgesOf(item);
  return edges.length > 0 && edges.every((e) => isLine(b?.[e]));
}

/** The setParaProps patch of `item` on paragraphs whose effective borders are `list` (style and own merged): the item's edges in
 * the pen, or removed when every paragraph has them all already (Word's toggle). A removed edge is null, or nil where `inherited`
 * (the style's borders, one per paragraph) draws it, so the style's line goes too. → {borders} or null when nothing applies. */
export function paraPatch(item, list, pen, inherited = []) {
  const off = (e, i) => (isLine(inherited[i]?.[e]) ? { style: 'nil' } : null);
  if (item === 'noBorder') return list.map((_, i) => ({ borders: Object.fromEntries(PARA_EDGES.map((e) => [e, off(e, i)])) }));
  const edges = paraEdgesOf(item);
  if (!edges.length) return null;
  const remove = list.length > 0 && list.every((b) => paraHas(item, b));
  return list.map((_, i) => ({ borders: Object.fromEntries(edges.map((e) => [e, remove ? off(e, i) : edgeOf(pen, SPACE[e])])) }));
}

/** The run border of `item` over text whose border is `current`: a box in the pen, or null (none) when the text has one already
 * or the item is No Border. Word's character border is one box (w:bdr), so every edge item gives the whole box. */
export const runPatch = (item, current, pen) => (item === 'noBorder' || isLine(current) || !ITEM_EDGES[item] ? null : edgeOf(pen, 0));

/** The cell border patches of `item` over the selected cells: `rect` {left, top, right, bottom} the selection's grid rectangle,
 * `cells` [{id, rect, borders}] each cell's own grid rectangle and borders. Outside edges go on the cells along the rectangle,
 * inside horizontal on the top and bottom of inner rows and inside vertical on the left and right of inner columns, so each
 * inner line is drawn by both cells beside it, as Word writes tcBorders. Removing writes nil, so a table style's line goes too.
 * → [{id, borders}] (patches for setNodeAttribute through deepPatch). */
export function cellPatch(item, rect, cells, pen) {
  const want = (c) => {
    const r = c.rect;
    const at = { top: r.top === rect.top, bottom: r.bottom === rect.bottom, left: r.left === rect.left, right: r.right === rect.right };
    const out = [];
    for (const e of ITEM_EDGES[item] ?? []) {
      if (e === 'insideH') out.push(...(!at.top ? ['top'] : []), ...(!at.bottom ? ['bottom'] : []));
      else if (e === 'insideV') out.push(...(!at.left ? ['left'] : []), ...(!at.right ? ['right'] : []));
      else if (e === 'tl2br' || e === 'tr2bl' || at[e]) out.push(e);
    }
    return out;
  };
  const nil = { style: 'nil' };
  if (item === 'noBorder') return cells.map((c) => ({ id: c.id, borders: Object.fromEntries(CELL_EDGES.map((e) => [e, nil])) }));
  const targets = cells.map((c) => ({ c, edges: want(c) }));
  const all = targets.flatMap((t) => t.edges.map((e) => t.c.borders?.[e]));
  if (!all.length) return [];
  // Word's toggle: the item removes its edges only when they are drawn in the pen already; a pen of another style, weight or
  // colour redraws them (Pen Weight 3 pt then All Borders on a Table Grid table thickens it). No pen: any line counts.
  const remove = all.every((e) => isLine(e) && (!pen || inPen(e, pen)));
  return targets.filter((t) => t.edges.length).map(({ c, edges }) => ({ id: c.id, borders: Object.fromEntries(edges.map((e) => [e, remove ? nil : edgeOf(pen, 0)])) }));
}

/** Whether the selected cells already have every edge `item` would set (its pressed state); with `pen`, drawn in that pen. */
export function cellHas(item, rect, cells, pen = null) {
  if (item === 'noBorder') return cells.every((c) => !CELL_EDGES.some((e) => isLine(c.borders?.[e])));
  const p = cellPatch(item, rect, cells, pen);
  return p.length > 0 && p.every((x) => Object.values(x.borders).every((e) => e.style === 'nil'));
}

const TABLE_EDGES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];

/** The table borders patch of `item` on a whole table (table.borders {top, left, bottom, right, insideH, insideV}): the item's
 * edges in the pen, or nil when `remove` (the table draws them all already); diagonals have no table edge (null). */
export function tablePatch(item, remove, pen) {
  const edges = (ITEM_EDGES[item] ?? []).filter((e) => TABLE_EDGES.includes(e));
  if (item === 'noBorder') return Object.fromEntries(TABLE_EDGES.map((e) => [e, { style: 'nil' }]));
  if (!edges.length) return null;
  return Object.fromEntries(edges.map((e) => [e, remove ? { style: 'nil' } : edgeOf(pen, 0)]));
}

/** Table edges from a style's or a table's borders: one edge object stands for all six (v1's Table Grid), else as given. */
export const sixOf = (b) => (!b ? {} : b.style ? Object.fromEntries(TABLE_EDGES.map((e) => [e, b])) : b);

/** The edges a cell draws: its own `own`, else table edge `te` (sixOf) outer or inside by its rect `r` in a `width` x `height`
 * grid, as Word resolves tcBorders over tblBorders. */
export function cellEdges(own, r, width, height, te) {
  const o = own ?? {};
  return { ...o, top: o.top ?? (r.top === 0 ? te.top : te.insideH), bottom: o.bottom ?? (r.bottom === height ? te.bottom : te.insideH),
    left: o.left ?? (r.left === 0 ? te.left : te.insideV), right: o.right ?? (r.right === width ? te.right : te.insideV) };
}

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const span = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

/** Cell patches [{id, borders}] with each side edge also written, as the opposite side, on the cells across it: a line between
 * two cells is both cells' (Word changes both), and the row grids draw both. `map` a TableMap, `start` the table content's pos.
 * A cell the patches set already keeps its own edge. */
export function mirrored(patches, map, start) {
  const out = new Map(patches.map((p) => [p.id, { ...p.borders }]));
  for (const p of patches) {
    const r = map.findCell(p.id - start);
    for (const [e, v] of Object.entries(p.borders)) {
      if (!OPPOSITE[e]) continue;
      const rows = e === 'top' ? [r.top - 1] : e === 'bottom' ? [r.bottom] : span(r.top, r.bottom);
      const cols = e === 'left' ? [r.left - 1] : e === 'right' ? [r.right] : span(r.left, r.right);
      for (const y of rows) for (const x of cols) {
        if (y < 0 || x < 0 || y >= map.height || x >= map.width) continue;
        const id = start + map.map[y * map.width + x];
        const b = out.get(id) ?? {};
        if (!(OPPOSITE[e] in b)) b[OPPOSITE[e]] = v;
        out.set(id, b);
      }
    }
  }
  return [...out].map(([id, borders]) => ({ id, borders }));
}

/** The pen before Borders and Shading sets one (Word's ½ pt single line in Automatic). */
export const DEFAULT_PEN = { style: 'single', width: 0.5, color: null };

/** Plain shading in fill `hex` (Home > Shading), or null for No Color; runs and paragraphs take the same object. */
export const shadingOf = (hex) => (hex ? { val: 'clear', color: 'auto', fill: hex } : null);

/** Word's grouping of consecutive paragraphs: `paras` [{borders, shading, left, right} | null (not bordered)] in order → a role
 * per paragraph: 'single', 'first', 'middle', 'last' or null. Neighbours with equal borders, shading and left and right indents
 * draw as one box; anything different starts a new one. */
export function groupRoles(paras) {
  const same = (a, b) => !!a && !!b && (a.left ?? 0) === (b.left ?? 0) && (a.right ?? 0) === (b.right ?? 0)
    && PARA_EDGES.every((e) => sameLine(a.borders?.[e], b.borders?.[e])) && sameShading(a.shading, b.shading);
  return paras.map((p, i) => {
    if (!p) return null;
    const up = same(paras[i - 1], p);
    const down = same(p, paras[i + 1]);
    return up ? (down ? 'middle' : 'last') : down ? 'first' : 'single';
  });
}
const sameShading = (a, b) => (a?.val ?? 'clear') === (b?.val ?? 'clear') && (a?.fill ?? null) === (b?.fill ?? null) && (a?.color ?? null) === (b?.color ?? null);

/** Borders of the dialog's Setting `setting` ('none' | 'box' | 'shadow' | 'threeD') in the edge `edge` {style, width, color}:
 * four equal edges at Word's default distances, Shadow with edge.shadow and 3-D with edge.frame on each (plan.md §1.8). */
export function presetBorders(setting, edge, space = SPACE) {
  if (setting === 'none') return {};
  const extra = { shadow: setting === 'shadow', frame: setting === 'threeD' };
  return Object.fromEntries(['top', 'left', 'bottom', 'right'].map((e) => [e, { ...edgeOf(edge, space[e] ?? SPACE[e]), ...extra }]));
}

/** The Setting radio that borders `b` show: none, box, shadow, threeD or custom. */
export function settingOf(b) {
  const four = ['top', 'left', 'bottom', 'right'].map((e) => b?.[e]);
  if (!Object.values(b ?? {}).some(isLine)) return 'none';
  if (!four.every(isLine) || !four.every((e) => sameLine({ ...e, space: 0 }, { ...four[0], space: 0 }))) return 'custom';
  if (Object.entries(b).some(([k, e]) => !['top', 'left', 'bottom', 'right'].includes(k) && isLine(e))) return 'custom';
  return four[0].shadow ? 'shadow' : four[0].frame ? 'threeD' : 'box';
}

/** The dialog's Style list: Word's name → ST_Border (office.mjs BORDER_STYLES), in the list's order. */
export const STYLE_NAMES = [
  ['Single solid line', 'single'], ['Dotted', 'dotted'], ['Dashed (small gap)', 'dashSmallGap'], ['Dashed (large gap)', 'dashed'],
  ['Dash dot', 'dotDash'], ['Dash dot dot', 'dotDotDash'], ['Double solid lines', 'double'], ['Triple solid lines', 'triple'],
  ['Thick-thin small gap', 'thickThinSmallGap'], ['Thin-thick small gap', 'thinThickSmallGap'], ['Thin-thick-thin small gap', 'thinThickThinSmallGap'],
  ['Thick-thin medium gap', 'thickThinMediumGap'], ['Thin-thick medium gap', 'thinThickMediumGap'], ['Thin-thick-thin medium gap', 'thinThickThinMediumGap'],
  ['Thick-thin large gap', 'thickThinLargeGap'], ['Thin-thick large gap', 'thinThickLargeGap'], ['Thin-thick-thin large gap', 'thinThickThinLargeGap'],
  ['Single wavy', 'wave'], ['Double wavy', 'doubleWave'], ['Dash dot (stroked)', 'dashDotStroked'], ['Emboss 3D', 'threeDEmboss'],
  ['Engrave 3D', 'threeDEngrave'], ['Outset', 'outset'], ['Inset', 'inset'],
];

/** The dialog's Width list: Word's label → pt, ½ pt Word's default. */
export const WIDTHS = [['¼ pt', 0.25], ['½ pt', 0.5], ['¾ pt', 0.75], ['1 pt', 1], ['1 ½ pt', 1.5], ['2 ¼ pt', 2.25], ['3 pt', 3], ['4 ½ pt', 4.5], ['6 pt', 6]];

/** The Shading tab's Patterns Style list: Word's name → ST_Shd (office.mjs SHADING_PATTERNS), in the list's order. */
export const PATTERN_NAMES = [
  ['Clear', 'clear'], ['Solid (100%)', 'solid'],
  ...['5', '10', '12.5', '15', '20', '25', '30', '35', '37.5', '40', '45', '50', '55', '60', '62.5', '65', '70', '75', '80', '85', '87.5', '90', '95']
    .map((n) => [`${n}%`, `pct${Math.floor(Number(n))}`]),
  ['Dk Horizontal', 'horzStripe'], ['Dk Vertical', 'vertStripe'], ['Dk Dwn Diagonal', 'reverseDiagStripe'], ['Dk Up Diagonal', 'diagStripe'],
  ['Dk Grid', 'horzCross'], ['Dk Trellis', 'diagCross'],
  ['Lt Horizontal', 'thinHorzStripe'], ['Lt Vertical', 'thinVertStripe'], ['Lt Dwn Diagonal', 'thinReverseDiagStripe'], ['Lt Up Diagonal', 'thinDiagStripe'],
  ['Lt Grid', 'thinHorzCross'], ['Lt Trellis', 'thinDiagCross'],
];

const by = (list, i, o) => (v) => list.find((x) => x[i] === v)?.[o] ?? null;
/** ST_Border of a Style list name, and back. */
export const styleOf = by(STYLE_NAMES, 0, 1);
export const styleName = by(STYLE_NAMES, 1, 0);
/** ST_Shd of a Patterns name, and back. */
export const patternOf = by(PATTERN_NAMES, 0, 1);
export const patternName = by(PATTERN_NAMES, 1, 0);
/** pt of a Width label, and back. */
export const widthOf = by(WIDTHS, 0, 1);
export const widthName = by(WIDTHS, 1, 0);

// Table Design's data (docs/plans/word/plan.md §3 table-design, §1.8 table styles): Word's 105 gallery table styles generated
// from one rule table (family x colour), the order Word applies a table style's conditional formats in, the border pen's
// styles and weights, and the 21 Theme Borders presets. Our own look under Word's names and ids
// (probe/menus/table.table-design.*.json). Pure: Node tests load it.
import { BUILTIN_STYLES } from '../../defaults.mjs';
import { resolveColor } from '../../../office.mjs';
import { engineHex as hex6, themeFont } from '../font/run.mjs';

const ACCENTS = [1, 2, 3, 4, 5, 6];
const FAMILIES = {
  grid: ['1 Light', '2', '3', '4', '5 Dark', '6 Colorful', '7 Colorful'],
  list: ['1 Light', '2', '3', '4', '5 Dark', '6 Colorful', '7 Colorful'],
};

/** Word's gallery in its order: [{id, name, group}], 7 plain tables then the Grid and List families, each plain then Accent 1 to 6. */
export const TABLE_STYLES = [
  ...['Table Grid', 'Table Grid Light', 'Plain Table 1', 'Plain Table 2', 'Plain Table 3', 'Plain Table 4', 'Plain Table 5']
    .map((name) => ({ id: name.replace(/ /g, ''), name, group: 'Plain Tables' })),
  ...Object.entries(FAMILIES).flatMap(([kind, fams]) => fams.flatMap((f) => {
    const name = `${kind === 'grid' ? 'Grid' : 'List'} Table ${f}`;
    const id = name.replace(/ /g, '');
    const group = kind === 'grid' ? 'Grid Tables' : 'List Tables';
    return [{ id, name, group }, ...ACCENTS.map((n) => ({ id: `${id}-Accent${n}`, name: `${name} - Accent ${n}`, group }))];
  })),
];
const BY_ID = new Map(TABLE_STYLES.map((s) => [s.id, s]));

// ---------- colours and shapes ----------

/** A palette on theme slot `slot`: e(lum, width, style) a border edge, f(lum) a cell fill, t(lum) a run colour; each keeps its
 * theme link, so the hex can be worked out again after a theme change. */
function palette(theme, slot) {
  const col = (lum) => ({ color: resolveColor(theme, { slot, lum }), themeColor: { slot, lum } });
  return {
    e: (lum = 0, width = 0.5, style = 'single') => ({ style, width, space: 0, ...col(lum) }),
    f: (lum = 0) => ({ val: 'clear', color: 'auto', fill: resolveColor(theme, { slot, lum }), themeFill: { slot, lum } }),
    t: (lum = 0) => col(lum),
  };
}
const NONE = { style: 'nil' };
const B = { bold: true };
const I = { italic: true };
const all = (e) => ({ top: e, left: e, bottom: e, right: e, insideH: e, insideV: e });
const bands = (fill) => ({ band1Vert: { cell: { shading: fill } }, band1Horz: { cell: { shading: fill } } });
const ends = (run) => ({ firstCol: { run }, lastCol: { run } });

// Each family → {run?, table: {borders?, shading?, cond}} from c (the family's colour palette) and w (white, Background 1).
// Looks follow Word's families loosely (header bars, banding tints, double lines over a total row); they are ours.
const RULES = {
  GridTable1Light: (c) => ({ table: { borders: all(c.e(0.6)), cond: {
    firstRow: { run: B, cell: { borders: { bottom: c.e(0.4, 1.5) } } }, lastRow: { run: B, cell: { borders: { top: c.e(0.4, 0.5, 'double') } } }, ...ends(B) } } }),
  GridTable2: (c) => ({ table: { borders: { top: c.e(0.4), bottom: c.e(0.4), insideH: c.e(0.4), insideV: c.e(0.4) }, cond: {
    firstRow: { run: B, cell: { borders: { top: NONE, bottom: c.e(0.4, 1.5) } } }, lastRow: { run: B, cell: { borders: { top: c.e(0.4, 0.5, 'double') } } },
    ...ends(B), ...bands(c.f(0.8)) } } }),
  GridTable3: (c) => ({ table: { borders: all(c.e(0.4)), cond: {
    firstRow: { run: B }, lastRow: { run: B, cell: { borders: { top: c.e(0.4) } } },
    firstCol: { run: I, para: { align: 'right' } }, lastCol: { run: I }, ...bands(c.f(0.8)) } } }),
  GridTable4: (c, w) => ({ table: { borders: all(c.e(0.4)), cond: {
    firstRow: { run: { ...B, ...w.t() }, cell: { shading: c.f(), borders: { top: c.e(), left: c.e(), right: c.e(), bottom: c.e(), insideV: c.e() } } },
    lastRow: { run: B, cell: { borders: { top: c.e(0, 0.5, 'double') } } }, ...ends(B), ...bands(c.f(0.8)) } } }),
  GridTable5Dark: (c, w) => ({ table: { borders: all(w.e()), shading: c.f(0.8), cond: {
    ...Object.fromEntries(['firstRow', 'lastRow', 'firstCol', 'lastCol'].map((k) => [k, { run: { ...B, ...w.t() }, cell: { shading: c.f() } }])),
    ...bands(c.f(0.6)) } } }),
  GridTable6Colorful: (c) => ({ run: c.t(-0.25), table: { borders: all(c.e(0.4)), cond: {
    firstRow: { run: B, cell: { borders: { bottom: c.e(0.4, 1.5) } } }, lastRow: { run: B, cell: { borders: { top: c.e(0.4, 0.5, 'double') } } },
    ...ends(B), ...bands(c.f(0.8)) } } }),
  GridTable7Colorful: (c) => ({ run: c.t(-0.25), table: { borders: all(c.e(0.4)), cond: {
    firstRow: { run: B, cell: { borders: { bottom: c.e(0.4) } } }, lastRow: { run: B, cell: { borders: { top: c.e(0.4) } } },
    firstCol: { run: I, para: { align: 'right' } }, lastCol: { run: I }, ...bands(c.f(0.8)) } } }),
  ListTable1Light: (c) => ({ table: { cond: {
    firstRow: { run: B, cell: { borders: { bottom: c.e(0.4) } } }, lastRow: { run: B, cell: { borders: { top: c.e(0.4) } } }, ...ends(B), ...bands(c.f(0.8)) } } }),
  ListTable2: (c) => ({ table: { borders: { top: c.e(0.4), bottom: c.e(0.4), insideH: c.e(0.4) }, cond: {
    firstRow: { run: B }, lastRow: { run: B }, ...ends(B), ...bands(c.f(0.8)) } } }),
  ListTable3: (c, w) => ({ table: { borders: { top: c.e(), bottom: c.e(), left: c.e(), right: c.e() }, cond: {
    firstRow: { run: { ...B, ...w.t() }, cell: { shading: c.f() } }, lastRow: { run: B, cell: { borders: { top: c.e(0, 0.5, 'double') } } }, ...ends(B),
    band1Vert: { cell: { borders: { left: c.e(), right: c.e() } } }, band1Horz: { cell: { borders: { top: c.e(), bottom: c.e() } } } } } }),
  ListTable4: (c, w) => ({ table: { borders: { top: c.e(0.4), bottom: c.e(0.4), left: c.e(0.4), right: c.e(0.4), insideH: c.e(0.4) }, cond: {
    firstRow: { run: { ...B, ...w.t() }, cell: { shading: c.f(), borders: { top: c.e(), left: c.e(), right: c.e(), bottom: c.e() } } },
    lastRow: { run: B, cell: { borders: { top: c.e(0.4, 0.5, 'double') } } }, ...ends(B), ...bands(c.f(0.8)) } } }),
  ListTable5Dark: (c, w) => ({ run: w.t(), table: { borders: all(c.e()), shading: c.f(), cond: {
    firstRow: { run: B, cell: { borders: { bottom: w.e(0, 1.5) } } }, lastRow: { run: B, cell: { borders: { top: w.e(0, 0.5, 'double') } } },
    firstCol: { run: B, cell: { borders: { right: w.e() } } }, lastCol: { run: B, cell: { borders: { left: w.e() } } },
    band1Vert: { cell: { borders: { left: w.e(), right: w.e() } } }, band1Horz: { cell: { borders: { top: w.e(), bottom: w.e() } } } } } }),
  ListTable6Colorful: (c) => ({ run: c.t(-0.25), table: { borders: { top: c.e(), bottom: c.e() }, cond: {
    firstRow: { run: B, cell: { borders: { bottom: c.e() } } }, lastRow: { run: B, cell: { borders: { top: c.e(0, 0.5, 'double') } } },
    ...ends(B), ...bands(c.f(0.8)) } } }),
  ListTable7Colorful: (c) => ({ run: c.t(-0.25), table: { cond: {
    firstRow: { run: I, cell: { borders: { bottom: c.e() } } }, lastRow: { run: I, cell: { borders: { top: c.e() } } },
    firstCol: { run: I, para: { align: 'right' }, cell: { borders: { right: c.e() } } }, lastCol: { run: I, cell: { borders: { left: c.e() } } },
    ...bands(c.f(0.8)) } } }),
};

// The plain tables use greys of Background 1 and Text 1.
const PLAIN = {
  TableGridLight: (g) => ({ table: { borders: all(g.e(-0.25)) } }),
  PlainTable1: (g) => ({ table: { borders: all(g.e(-0.25)), cond: {
    firstRow: { run: B }, lastRow: { run: B, cell: { borders: { top: g.e(-0.25, 0.5, 'double') } } }, ...ends(B), ...bands(g.f(-0.05)) } } }),
  PlainTable2: (_g, k) => ({ table: { borders: { top: k.e(0.5), bottom: k.e(0.5) }, cond: {
    firstRow: { run: B, cell: { borders: { bottom: k.e(0.5) } } }, lastRow: { run: B, cell: { borders: { top: k.e(0.5) } } }, ...ends(B),
    band1Vert: { cell: { borders: { left: k.e(0.5), right: k.e(0.5) } } }, band1Horz: { cell: { borders: { top: k.e(0.5), bottom: k.e(0.5) } } } } } }),
  PlainTable3: (g, k) => ({ table: { cond: {
    firstRow: { run: { ...B, caps: true }, cell: { borders: { bottom: k.e(0.5) } } }, lastRow: { run: { ...B, caps: true } },
    firstCol: { run: { ...B, caps: true }, cell: { borders: { right: k.e(0.5) } } }, lastCol: { run: { ...B, caps: true } }, ...bands(g.f(-0.05)) } } }),
  PlainTable4: (g) => ({ table: { cond: { firstRow: { run: B }, lastRow: { run: B }, ...ends(B), ...bands(g.f(-0.05)) } } }),
  PlainTable5: (g, k) => ({ table: { cond: {
    firstRow: { run: I, cell: { borders: { bottom: k.e(0.5) } } }, lastRow: { run: I, cell: { borders: { top: k.e(0.5) } } },
    firstCol: { run: I, para: { align: 'right' }, cell: { borders: { right: k.e(0.5) } } }, lastCol: { run: I, cell: { borders: { left: k.e(0.5) } } },
    ...bands(g.f(-0.05)) } } }),
};

// Every gallery style sits on Normal Table and, like Table Grid, sets single spacing with nothing after (Word's table styles do).
const PARA = { spacing: { after: 0, line: { rule: 'auto', value: 1 } } };

/** The definition of gallery style `id` ('GridTable4-Accent1') in `theme` (doc.attrs.theme): {type: 'table', name, basedOn,
 * para, run?, table: {borders, shading, cond}} with theme-linked colours, or null for an id outside the gallery. Table Grid is
 * the built-in definition every Document already holds. */
export function tableStyleDef(id, theme) {
  const s = BY_ID.get(id);
  if (!s) return null;
  if (id === 'TableGrid') return structuredClone(BUILTIN_STYLES.TableGrid);
  const [fam, accent] = id.split('-');
  const w = palette(theme, 'lt1');
  const body = PLAIN[fam]
    ? PLAIN[fam](w, palette(theme, 'dk1'))
    : RULES[fam](palette(theme, accent ? accent.toLowerCase() : 'dk1'), w);
  return { type: 'table', name: s.name, basedOn: 'TableNormal', para: PARA, ...body };
}

// ---------- conditional formats ----------

/** Word's order for a table style's conditional formats (w:tblStylePr), later ones winning property by property. */
export const COND_ORDER = ['wholeTable', 'band1Vert', 'band2Vert', 'band1Horz', 'band2Horz', 'firstCol', 'lastCol', 'firstRow', 'lastRow',
  'nwCell', 'neCell', 'swCell', 'seCell'];

/** The conditional formats that cover the cell at row `r`, column `c` of a `rows` x `cols` table with look `look`, in the order
 * Word applies them. Row banding counts from the first row after a header row, column banding from the column after a first
 * column; the header row and the first column take no band of their own direction. */
export function condsOf(r, c, { rows, cols }, look = {}) {
  const fr = look.firstRow ? 1 : 0;
  const fc = look.firstColumn ? 1 : 0;
  const lastR = r === rows - 1;
  const lastC = c === cols - 1;
  const on = {
    wholeTable: true,
    band1Vert: !look.noVBand && c >= fc && (c - fc) % 2 === 0,
    band2Vert: !look.noVBand && c >= fc && (c - fc) % 2 === 1,
    band1Horz: !look.noHBand && r >= fr && (r - fr) % 2 === 0,
    band2Horz: !look.noHBand && r >= fr && (r - fr) % 2 === 1,
    firstCol: !!look.firstColumn && c === 0,
    lastCol: !!look.lastColumn && lastC,
    firstRow: !!look.firstRow && r === 0,
    lastRow: !!look.lastRow && lastR,
    nwCell: !!(look.firstRow && look.firstColumn) && r === 0 && c === 0,
    neCell: !!(look.firstRow && look.lastColumn) && r === 0 && lastC,
    swCell: !!(look.lastRow && look.firstColumn) && lastR && c === 0,
    seCell: !!(look.lastRow && look.lastColumn) && lastR && lastC,
  };
  return COND_ORDER.filter((k) => on[k]);
}

const regionOf = (key) => (key === 'wholeTable' ? 'table' : /Row|Horz/.test(key) ? 'row' : /Col|Vert/.test(key) ? 'col' : 'cell');

const SIX = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
/** Border set `b` as its six named sides: a single edge object (v1's Table Grid) stands for all six. */
export const sidesOf = (b) => (b?.style ? Object.fromEntries(SIX.map((s) => [s, b])) : b ?? {});

/** The part `key` of style `def` as a conditional format shape {run, para, cell: {shading, borders, vAlign}}. */
export function partOf(def, key) {
  if (key !== 'wholeTable') return def.table?.cond?.[key] ?? {};
  return { run: def.run, para: def.para, cell: { shading: def.table?.shading, borders: def.table?.borders, vAlign: def.table?.vAlign } };
}

/** `def` with part `key` patched by `patch` ({run?, para?, cell?}, each merged one level deep; null removes a key, so the
 * value comes from the base style again). */
export function withPart(def, key, patch) {
  const merge = (a, b) => (b === undefined ? a : Object.fromEntries(Object.entries({ ...a, ...b }).filter(([, v]) => v != null)));
  const old = partOf(def, key);
  const next = { run: merge(old.run ?? {}, patch.run), para: merge(old.para ?? {}, patch.para), cell: merge(old.cell ?? {}, patch.cell) };
  const table = { ...def.table };
  if (key === 'wholeTable') {
    // An unset key stays out: a null would hide the base style's value (stylesheet.js resolved lets null win).
    for (const k of ['shading', 'borders', 'vAlign']) if (next.cell[k] == null) delete table[k]; else table[k] = next.cell[k];
    return { ...def, run: next.run, para: next.para, table };
  }
  table.cond = { ...table.cond, [key]: next };
  return { ...def, table };
}

/** A border set's edges on one cell: the outer edge where the cell is at the region's end, the inside edge elsewhere. */
function edgesOn(b, region, r, c, rows, cols) {
  if (!b) return {};
  const a = sidesOf(b);
  const across = region === 'table' || region === 'row'; // the region spans columns
  const down = region === 'table' || region === 'col'; // the region spans rows
  const pick = (outer, inside, atEnd, spans) => (spans && !atEnd ? inside : outer);
  const out = {
    top: pick(a.top, a.insideH, r === 0, down), bottom: pick(a.bottom, a.insideH, r === rows - 1, down),
    left: pick(a.left, a.insideV, c === 0, across), right: pick(a.right, a.insideV, c === cols - 1, across),
  };
  return Object.fromEntries(Object.entries(out).filter(([, e]) => e));
}

/** How a style `def` (resolved, with table.cond) draws the cell at `r`, `c` of a `dims` table under `look`: {fill, color, bold,
 * italic, align, borders: {top, right, bottom, left}} after every conditional format in Word's order. For previews and tests;
 * the document itself draws through stylesheet.js. */
export function cellLook(def, r, c, dims, look) {
  const out = { fill: null, color: def?.run?.color ?? null, bold: !!def?.run?.bold, italic: !!def?.run?.italic, align: def?.para?.align ?? null, borders: {} };
  const t = def?.table ?? {};
  for (const key of condsOf(r, c, dims, look)) {
    const part = key === 'wholeTable' ? { run: null, cell: { shading: t.shading, borders: t.borders } } : t.cond?.[key];
    if (!part) continue;
    if (part.run?.color !== undefined) out.color = part.run.color;
    if (part.run?.bold != null) out.bold = part.run.bold;
    if (part.run?.italic != null) out.italic = part.run.italic;
    if (part.para?.align) out.align = part.para.align;
    const shd = part.cell?.shading;
    if (shd) out.fill = shd.val === 'solid' ? shd.color : shd.fill && shd.fill !== 'auto' ? shd.fill : out.fill;
    Object.assign(out.borders, edgesOn(part.cell?.borders, regionOf(key), r, c, dims.rows, dims.cols));
  }
  return out;
}

// ---------- the border pen ----------

/** Pen Style's 25 line styles in Word's menu order: [office.mjs BORDER_STYLES name, Word's label]. */
export const PEN_STYLES = [
  ['none', 'No Border'], ['single', 'Single solid line'], ['dotted', 'Dotted'], ['dashSmallGap', 'Dashed (small gap)'], ['dashed', 'Dashed (large gap)'],
  ['dotDash', 'Dash dot'], ['dotDotDash', 'Dash dot dot'], ['double', 'Double solid lines'], ['triple', 'Triple solid lines'],
  ['thinThickSmallGap', 'Thick-thin small gap'], ['thickThinSmallGap', 'Thin-thick small gap'], ['thinThickThinSmallGap', 'Thin-thick-thin small gap'],
  ['thinThickMediumGap', 'Thick-thin medium gap'], ['thickThinMediumGap', 'Thin-thick medium gap'], ['thinThickThinMediumGap', 'Thin-thick-thin medium gap'],
  ['thinThickLargeGap', 'Thick-thin large gap'], ['thickThinLargeGap', 'Thin-thick large gap'], ['thinThickThinLargeGap', 'Thin-thick-thin large gap'],
  ['wave', 'Single wavy'], ['doubleWave', 'Double wavy'], ['dashDotStroked', 'Dash dot (stroked)'], ['threeDEmboss', 'Emboss 3D'],
  ['threeDEngrave', 'Engrave 3D'], ['outset', 'Outset'], ['inset', 'Inset'],
];

/** Pen Weight's nine widths in points with Word's labels. */
export const PEN_WEIGHTS = [[0.25, '¼ pt'], [0.5, '½ pt'], [0.75, '¾ pt'], [1, '1 pt'], [1.5, '1 ½ pt'], [2.25, '2 ¼ pt'], [3, '3 pt'], [4.5, '4 ½ pt'], [6, '6 pt']];

/** Border Styles' 21 Theme Borders: single ½ pt, single 1 ½ pt and double ½ pt, each in Text 1 and Accent 1 to 6.
 * [{id, label, style, width, slot}]; the colour comes from the document's theme when one is picked. */
export const BORDER_PRESETS = [['single', 0.5, 'Single solid line, 1/2 pt'], ['single', 1.5, 'Single solid line, 1 1/2 pt'], ['double', 0.5, 'Double solid lines, 1/2 pt']]
  .flatMap(([style, width, label]) => ['dk1', ...ACCENTS.map((n) => `accent${n}`)].map((slot) => ({
    id: `${style}-${width}-${slot}`, label: slot === 'dk1' ? label : `${label}, Accent ${slot.slice(6)}`, style, width, slot,
  })));

/** The pen of preset `p` in `theme`: {style, width, color}. */
export const presetPen = (p, theme) => ({ style: p.style, width: p.width, color: resolveColor(theme, { slot: p.slot, lum: 0 }) });

/** The pen of a drawn border, from computed CSS `style`, `width` (px) and `color` (rgb()): {style, width (pt, the nearest Pen
 * Weight), color ('#RRGGBB')}, or null when no border is drawn there. Border Sampler reads a cell edge with it. */
export function penOfCss(style, width, color, device = 1) {
  if (!style || style === 'none' || style === 'hidden' || !(parseFloat(width) > 0)) return null;
  const name = { solid: 'single', double: 'double', dotted: 'dotted', dashed: 'dashed', groove: 'threeDEngrave', ridge: 'threeDEmboss', inset: 'inset', outset: 'outset' }[style] ?? 'single';
  // borderCss draws a double line three times its width, so read it back that way. Chromium snaps a border to whole device
  // pixels (at least one), so ¼, ½ and ¾ pt all read back as one device pixel: `device` CSS px at the element, which depends on
  // the screen's scale and the page zoom. ponytail: one device pixel reads as Word's default ½ pt; read the cell's border
  // attributes through its table style if the thin weights must come back exactly.
  const px = parseFloat(width) / (name === 'double' ? 3 : 1);
  const pt = px < 1.5 * device ? 0.5 : px * 0.75;
  const w = PEN_WEIGHTS.reduce((best, [v]) => (Math.abs(v - pt) < Math.abs(best - pt) ? v : best), 0.5);
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(color ?? '');
  const hex = m ? `#${m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null;
  return { style: name, width: w, color: hex };
}

/** The next free "StyleN" name in style list `list` (Word proposes Style1, then Style2...). */
export function nextStyleName(list = {}) {
  const used = new Set(Object.entries(list).flatMap(([id, s]) => [id, s?.name]));
  let n = 1;
  while (used.has(`Style${n}`)) n++;
  return `Style${n}`;
}

// ---------- canvas drafts ----------

const ENGINE_LINES = new Set(['single', 'double', 'dotted', 'dashed', 'dotDash', 'thick', 'triple', 'wave']);

/** Table style definition `def` (Modify Table Style's result) → the `parts` of the engine's table.newStyle and
 * table.modifyStyle (cmd/table_style.rs Part): each part's font, size, bold, italic, underline, colour, alignment, shading and
 * borders. A key the part does not set is left out, so the engine keeps the base style's. */
export function engineParts(def) {
  return [...new Set(['wholeTable', ...Object.keys(def?.table?.cond ?? {})])].map((key) => {
    const { run = {}, para = {}, cell = {} } = partOf(def, key);
    const out = { part: key };
    if (run.font !== undefined) out.font = run.font ? themeFont(run.font) : null;
    if (run.size != null) out.size = run.size;
    for (const k of ['bold', 'italic']) if (run[k] != null) out[k] = !!run[k];
    if (run.underline !== undefined) out.underline = (typeof run.underline === 'object' ? run.underline?.val : run.underline) || 'none';
    if (run.color !== undefined) out.color = hex6(run.color);
    if (para.align !== undefined) out.align = para.align === 'both' ? 'justify' : para.align ?? null;
    if (cell.vAlign !== undefined) out.vAlign = cell.vAlign ?? null;
    if (cell.shading !== undefined) out.fill = hex6(cell.shading?.fill);
    const sides = Object.entries(sidesOf(cell.borders));
    if (sides.length) {
      out.borders = sides.map(([edges, b]) => ({ edges, style: ENGINE_LINES.has(b?.style) ? b.style : 'none', ...(b?.width && { width: b.width }),
        ...(hex6(b?.color) && { color: hex6(b.color) }) }));
    }
    return out;
  });
}

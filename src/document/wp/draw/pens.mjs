// Draw tab pens, ruler snapping and ink replay order (docs/plans/word plan.md §3 draw, briefs/draw.md). Pure: node tests load it.
// Widths are in millimetres as Word shows them; a board takes post px (mmToPx) and scales them by its own unit.

/** Word's pen thicknesses in mm: pens and pencils, and highlighters. */
export const THICKNESS = {
  pen: [0.25, 0.35, 0.5, 0.7, 1, 2, 3.5],
  highlighter: [2, 4, 6, 8, 10],
};

/** The defaults a pen of each kind starts with (Add). Fountain and brush pens draw as pens with a wider tip (recorded deviation). */
export const KINDS = {
  pen: { label: 'Pen', color: '#000000', width: 0.5 },
  highlighter: { label: 'Highlighter', color: '#ffff00', width: 6 },
  fountainPen: { label: 'Fountain Pen', color: '#000000', width: 1 },
  brushPen: { label: 'Brush Pen', color: '#000000', width: 2 },
  pencil: { label: 'Pencil', color: '#404040', width: 1 },
};

/** The gallery's pens while settings.word.pens is null: black and red pens, a dark grey pencil and a yellow highlighter. */
export const DEFAULT_PENS = [
  { kind: 'pen', color: '#000000', width: 0.5 },
  { kind: 'pen', color: '#e71224', width: 0.5 },
  { kind: 'pencil', color: '#404040', width: 1 },
  { kind: 'highlighter', color: '#ffff00', width: 6 },
];

/** The 16 pen colours of a pen's options, [hex, name]. */
export const COLORS = [
  ['#000000', 'Black'], ['#ffffff', 'White'], ['#7f7f7f', 'Grey'], ['#404040', 'Dark grey'],
  ['#e71224', 'Red'], ['#f7630c', 'Orange'], ['#ffff00', 'Yellow'], ['#ffc114', 'Gold'],
  ['#16c60c', 'Green'], ['#008080', 'Teal'], ['#00b7c3', 'Turquoise'], ['#0078d4', 'Blue'],
  ['#004e8c', 'Dark blue'], ['#886ce4', 'Lavender'], ['#8e1e8e', 'Purple'], ['#e3008c', 'Pink'],
];

const OPACITY = { highlighter: 0.35, pencil: 0.7 }; // the board's PEN_STYLES opacities; every other kind is 1

/** Millimetres → CSS px (96 per inch). */
export const mmToPx = (mm) => (mm * 96) / 25.4;

/** The thickness list of a pen kind. */
export const thicknessOf = (kind) => (kind === 'highlighter' ? THICKNESS.highlighter : THICKNESS.pen);

/** A pen's colour name, else its hex. */
export const colorName = (hex) => COLORS.find(([c]) => c === hex?.toLowerCase())?.[1] ?? hex;

/** What Board.setPen takes for `pen`: colour, width in post px and the opacity of its kind. */
export const penToBoard = (pen) => ({ color: pen.color, width: Math.round(mmToPx(pen.width) * 100) / 100, opacity: OPACITY[pen.kind] ?? 1 });

/** `pens` with a new pen of `kind` and its default appended. */
export const addPen = (pens, kind) => [...pens, { kind, color: KINDS[kind].color, width: KINDS[kind].width }];

/** The pen list from settings.word.pens, falling back to the default set when it is missing or broken. */
export function pensOf(saved) {
  const ok = Array.isArray(saved) && saved.every((p) => KINDS[p?.kind] && /^#[0-9a-f]{6}$/i.test(p.color) && p.width > 0);
  return ok ? saved : DEFAULT_PENS;
}

/** The points of a stroke item's path in board px (its d is item-local, scaled from vw × vh to w × h). */
export function strokePoints(item) {
  const n = (item.d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: item.x + (n[i] * item.w) / item.vw, y: item.y + (n[i + 1] * item.h) / item.vh });
  return pts;
}

const project = (p, { a, b }) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  return { x: a.x + t * dx, y: a.y + t * dy };
};

/** Stroke `item` straightened onto the first of `edges` ([{a, b}] lines in board px) that both of its ends lie within `tol` px of,
 * else null. ponytail: snaps after the stroke ends, not live while drawing. */
export function snapToRuler(item, edges, tol = 8) {
  const pts = strokePoints(item);
  if (pts.length < 2) return null;
  const ends = [pts[0], pts.at(-1)];
  for (const edge of edges) {
    const on = ends.map((p) => project(p, edge));
    if (!ends.every((p, i) => Math.hypot(p.x - on[i].x, p.y - on[i].y) <= tol)) continue;
    const pad = item.width / 2 + 1;
    const x = Math.floor(Math.min(on[0].x, on[1].x) - pad);
    const y = Math.floor(Math.min(on[0].y, on[1].y) - pad);
    const w = Math.ceil(Math.max(on[0].x, on[1].x) + pad) - x;
    const h = Math.ceil(Math.max(on[0].y, on[1].y) + pad) - y;
    const r = (v) => Math.round(v * 10) / 10;
    const d = `M${r(on[0].x - x)} ${r(on[0].y - y)}L${r(on[1].x - x)} ${r(on[1].y - y)}`;
    return { ...item, x, y, w, h, vw: w, vh: h, d };
  }
  return null;
}

/** The stroke items of a board in replay order: item order (ceiling: a stroke moved in the layer order replays out of drawing order). */
export const replayOrder = (items) => items.filter((i) => i.type === 'stroke');

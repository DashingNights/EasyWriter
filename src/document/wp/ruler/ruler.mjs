// The rulers' pure parts (docs/plans/word/plan.md §3 ruler, index-layout.md "Horizontal ruler" and "Vertical ruler"): tick
// lists, snapping, the px per point, what each marker drag writes, the tab selector, default stop ticks, stop edits and column
// drags. Lengths are points unless a name says px. Pure: Node tests load it.
import { LIMITS, UNITS } from '../../../tooling/kit/units.mjs';

/** Layout px per point (96 dpi). */
export const PX_PER_PT = 4 / 3;

// Tick spacing per unit in points: minor, the longer middle tick and the numbered one, and the snap step. Inches and centimetres
// are Word's (v); mm draws like cm, pt numbers every 72 and pi every 6 with eighth-inch ticks and the inch snap (v, ours: the
// index does not describe them).
const CM = UNITS.cm;
const GRID = {
  in: { minor: 9, mid: 36, major: 72, snap: 4.5, per: 1 },
  cm: { minor: CM / 4, mid: CM / 2, major: CM, snap: CM / 4, per: 1 },
  mm: { minor: CM / 4, mid: CM / 2, major: CM, snap: CM / 4, per: 10 },
  pt: { minor: 9, mid: 36, major: 72, snap: 4.5, per: 72 },
  pi: { minor: 9, mid: 36, major: 72, snap: 4.5, per: 6 },
};
const gridOf = (unit) => GRID[unit] ?? GRID.cm;

/** The snap step of `unit` in points: 1/16 in, or 0.25 cm (Word, v). */
export const snapStep = (unit) => gridOf(unit).snap;

const STEPS = [1, 2, 5, 10, 20, 50, 100]; // units between two numbers as the zoom shrinks the ruler
const GAP = 6; // px: smaller ticks closer than this are left out

/** The ticks between `from` and `to` points from the ruler's 0 → [{pos, kind: 'minor'|'mid'|'major', label}], numbers counting
 * outward from 0 both ways (no number at 0). `px`, the screen px per point, fits them to the zoom: a number every 1, 2, 5, 10, 20,
 * 50 or 100 units, the first step that leaves room to read the widest one, a mid tick halfway between two numbers, and only the
 * smaller ticks that stay GAP px apart. */
export function ticks(unit, from, to, px = Infinity) {
  const g = gridOf(unit);
  const per = Math.round(g.major / g.minor); // minor ticks per unit
  const widest = String(Math.round((Math.max(Math.abs(from), Math.abs(to)) / g.major) * g.per)).length;
  const step = per * (STEPS.find((s) => s * g.major * px >= 6 + 5 * widest) ?? STEPS.at(-1)); // minor ticks per number
  const unitTicks = g.major * px >= GAP;
  const halfUnits = (g.major / 2) * px >= GAP;
  const minors = g.minor * px >= GAP;
  const out = [];
  for (let k = Math.ceil(from / g.minor - 1e-9); k * g.minor <= to + 1e-9; k++) {
    const major = k % step === 0;
    const mid = !major && (k * 2) % step === 0;
    const kind = major ? 'major' : mid ? 'mid' : 'minor';
    if (kind === 'minor' && !(k % per === 0 ? unitTicks : (k * 2) % per === 0 ? halfUnits : minors)) continue;
    out.push({ pos: k * g.minor, kind, label: major && k ? String(Math.abs(k / per) * g.per) : null });
  }
  return out;
}

/** `pt` from the ruler's 0 snapped to `unit`'s step, or as it is with `off` (Alt held). */
export const snap = (pt, unit, off = false) => (off ? pt : Math.round(pt / snapStep(unit)) * snapStep(unit));

const twips = (pt) => Math.round(pt * 20) / 20;
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const ind = (v) => twips(clamp(v, LIMITS.indent));

/** The x of each indent marker from 0 for effective `indent` {left, right, firstLine} and text width `width`. */
export function indentMarkers({ left = 0, right = 0, firstLine = 0 } = {}, width) {
  return { firstLine: left + firstLine, hanging: left, left, right: width - right };
}

/** The indent patch a drag of marker `kind` ('firstLine' | 'hanging' | 'left' | 'right') to `x` from 0 writes, for effective
 * `indent` and text width `width`. First Line moves only line 1 (left of the left indent it becomes a hanging indent); Hanging
 * moves lines 2 on and keeps line 1 where it is; Left moves both and keeps their offset; Right past the margin goes negative. */
export function indentPatch(kind, indent, x, width) {
  const { left = 0, firstLine = 0 } = indent ?? {};
  if (kind === 'firstLine') return { firstLine: ind(x - left) };
  if (kind === 'hanging') return { left: ind(x), firstLine: ind(left + firstLine - x) };
  if (kind === 'left') return { left: ind(x) };
  if (kind === 'right') return { right: ind(width - x) };
  return null;
}

/** What the tab selector holds, in Word's click order. */
export const SELECTOR = ['left', 'center', 'right', 'decimal', 'bar', 'firstLine', 'hanging'];
/** The tab selector's next choice after `kind`. */
export const nextSelector = (kind) => SELECTOR[(SELECTOR.indexOf(kind) + 1) % SELECTOR.length];

/** Marker names as Word's tooltips give them. */
export const TIPS = {
  left: 'Left Tab', center: 'Center Tab', right: 'Right Tab', decimal: 'Decimal Tab', bar: 'Bar Tab', firstLine: 'First Line Indent',
  hanging: 'Hanging Indent', leftIndent: 'Left Indent', rightIndent: 'Right Indent', marginLeft: 'Left Margin', marginRight: 'Right Margin',
  marginTop: 'Top Margin', marginBottom: 'Bottom Margin', tableCol: 'Move Table Column', column: 'Move Column', tableRow: 'Adjust Table Row',
};

/** The default stops drawn: each multiple of `step` past the last custom stop of `stops` and up to `width` (points from 0). */
export function defaultTicks(stops, step, width) {
  if (!(step > 0)) return [];
  const last = Math.max(0, ...stops.map((s) => s.pos));
  const out = [];
  for (let p = (Math.floor(last / step + 1e-9) + 1) * step; p <= width + 1e-9; p += step) out.push(p);
  return out;
}

const same = (a, b) => Math.round(a * 20) === Math.round(b * 20);

/** A paragraph's own `tabs` with the stop at `from` gone: its own entry removed, and a 'clear' entry added when `inherited`
 * (its style's stops) holds one there. → the new own tabs, null when none is left. */
export function removeStop(own, inherited, from) {
  const out = (own ?? []).filter((t) => !same(t.pos, from));
  if (inherited.some((t) => same(t.pos, from) && t.align !== 'clear')) out.push({ pos: from, align: 'clear', leader: 'none' });
  return out.length ? out.sort((a, b) => a.pos - b.pos) : null;
}

/** A paragraph's own `tabs` with `stop` ({pos, align, leader}) added, replacing an entry at its position. */
export function addStop(own, stop) {
  const pos = twips(clamp(stop.pos, LIMITS.tab));
  return [...(own ?? []).filter((t) => !same(t.pos, pos)), { pos, align: stop.align, leader: stop.leader ?? 'none' }].sort((a, b) => a.pos - b.pos);
}

/** A paragraph's own `tabs` with the stop at `from` moved to `to`, keeping its type and leader (`stop`). */
export const moveStop = (own, inherited, from, to, stop) => addStop(removeStop(own, inherited, from), { ...stop, pos: to });

/** Table column `widths` (px) after the border right of column `i` moves `dx` px: plain and Shift change column i only and the
 * table width with it; Ctrl resizes the columns to the right in proportion so the table keeps its width; Ctrl+Shift makes them
 * equal (Word, v). No column goes under `min` px. */
export function columnDrag(widths, i, dx, { shift = false, ctrl = false } = {}, min = 12) {
  const out = [...widths];
  const right = out.slice(i + 1);
  const room = right.reduce((a, b) => a + b, 0);
  let d = Math.max(min - out[i], dx);
  if (ctrl && right.length) d = Math.min(d, room - min * right.length);
  out[i] += d;
  if (ctrl && right.length) {
    const left = room - d;
    for (let k = i + 1; k < out.length; k++) out[k] = shift ? left / right.length : (out[k] * left) / room;
  }
  // Plain and Shift alone both leave the other columns as they are: the brief words them alike (v, unprobed).
  return out.map((w) => Math.round(w));
}

/** Section columns `cols` ([{w, space}] in points, the last space ignored) after a drag of `dx` on gap `i`: part 'start' (the
 * edge of column i), 'end' (the edge of column i + 1) or 'move' (the middle: shifts the gap). With `equal`, an edge drag changes
 * every gap alike and the columns share the rest. */
export function sectionColumnsDrag(cols, i, part, dx, equal) {
  const out = cols.map((c) => ({ ...c }));
  const total = out.reduce((a, c, k) => a + c.w + (k < out.length - 1 ? c.space : 0), 0);
  if (part === 'move') {
    out[i].w += dx;
    out[i + 1].w -= dx;
  } else if (equal) {
    const space = Math.max(0, out[i].space + (part === 'start' ? -dx : dx));
    const w = (total - space * (out.length - 1)) / out.length;
    for (const c of out) Object.assign(c, { w, space });
  } else if (part === 'start') {
    out[i].w += dx;
    out[i].space -= dx;
  } else {
    out[i].space += dx;
    out[i + 1].w -= dx;
  }
  return out.map((c) => ({ w: twips(Math.max(0, c.w)), space: twips(Math.max(0, c.space)) }));
}

/** The keyboard ruler step: one snap step of `unit`, a tenth of it with Alt. */
export const keyStep = (unit, alt) => snapStep(unit) / (alt ? 10 : 1);

/** A canvas draft's section columns (engine-tools-2) from layout.columns' state `cols` ({count, space, widths: [[w, space after]]})
 * across text area `body` ({x, w}) → [{x, w, space}] in page points, or null for one column. */
export function sectionColumns(cols, body) {
  const n = cols?.count ?? 1;
  if (!(n > 1) || !body) return null;
  const list = cols.widths?.length === n ? cols.widths.map(([w, space]) => ({ w, space }))
    : Array.from({ length: n }, () => ({ w: (body.w - (cols.space ?? 36) * (n - 1)) / n, space: cols.space ?? 36 }));
  let x = body.x;
  return list.map((c) => {
    const out = { x, w: c.w, space: c.space };
    x += c.w + c.space;
    return out;
  });
}

/** The table cell of `cells` (layout.cells: [{x, y, w, h, row, cell, table}]) around caret box `caret` ({x, y, h}), the innermost
 * table's, with the other cells of its row left to right → {cell, row} or null outside a table. */
export function cellAround(cells, caret) {
  if (!caret) return null;
  const y = caret.y + caret.h / 2;
  const at = cells.filter((q) => caret.x >= q.x - 0.5 && caret.x <= q.x + q.w + 0.5 && y >= q.y && y <= q.y + q.h)
    .sort((a, b) => b.table.length - a.table.length)[0];
  if (!at) return null;
  const t = JSON.stringify(at.table);
  const row = cells.filter((q) => JSON.stringify(q.table) === t && q.row === at.row && Math.abs(q.y - at.y) < 1).sort((a, b) => a.x - b.x);
  return { cell: at, row };
}

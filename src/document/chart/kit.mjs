// SVG pieces shared by the chart drawings (svg.mjs, plots.mjs) and the models' legends: escaped elements and text, colours,
// Excel's number formats and auto scale, markers and dashes. Pure and import-free. Lengths are pt.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const r2 = (n) => Math.round(n * 100) / 100;
/** An element: `attrs` ({name: value}, null and undefined left out) and inner markup `inner` (already SVG). */
export const el = (name, attrs = {}, inner = '') => {
  const a = Object.entries(attrs).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? r2(v) : v)}"`).join('');
  return inner ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
};
const HEX = /^#[0-9A-Fa-f]{6}$/;
export const col = (c, def) => (HEX.test(c ?? '') ? c : def);
export const TEXT = '#595959';
export const GRID = '#D9D9D9';
export const textW = (s, size) => String(s).length * size * 0.52; // ponytail: an estimate, as nothing here measures text
/** Text that reads on fill `c`: white on a dark fill, dark grey on a light one. */
export const onFill = (c) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(col(c, '#FFFFFF').slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 150 ? '#FFFFFF' : '#404040';
};
export const label = (x, y, s, size, attrs = {}) => el('text', { x, y, 'font-size': size, fill: TEXT, ...attrs }, esc(s));
/** Text of `parts` ([[text, superscript?]]), as a trendline's equation and R² show their powers. */
export const rich = (x, y, parts, size, attrs = {}) => el('text', { x, y, 'font-size': size, fill: TEXT, ...attrs },
  parts.map(([s, sup]) => (sup ? el('tspan', { 'baseline-shift': 'super', 'font-size': r2(size * 0.7) }, esc(s)) : esc(s))).join(''));

// ---------- numbers ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** `v` as Excel's number format `code` would show it (General, decimals, thousands, percent, a literal prefix or suffix, and simple
 * dates of d, m, y) → text. `step` gives General its decimals on an axis. */
export function fmtNum(v, code, step) {
  if (v == null || !Number.isFinite(v)) return '';
  const sec = String(code ?? 'General').split(';')[v < 0 && String(code).includes(';') ? 1 : 0].replace(/\[[^\]]*\]/g, '');
  const bare = sec.replace(/"[^"]*"|\\./g, '');
  if (/[dmy]/i.test(bare) && !/general/i.test(bare)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
    return sec.replace(/"([^"]*)"|\\(.)|yyyy|yy|mmmm|mmm|mm|m|dd|d/gi, (t, q, e) => q ?? e ?? ({ yyyy: y, yy: String(y).slice(2), mmmm: MONTHS[m], mmm: MONTHS[m].slice(0, 3),
      mm: String(m + 1).padStart(2, '0'), m: m + 1, dd: String(day).padStart(2, '0'), d: day }[t.toLowerCase()]));
  }
  const sign = v < 0 && !String(code).includes(';') ? '-' : '';
  if (/general/i.test(bare) || !/[0#?]/.test(bare)) {
    const dec = step ? Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) : null;
    return sign + (dec != null && dec < 10 ? Math.abs(v).toFixed(dec) : String(+Math.abs(v).toPrecision(10)));
  }
  const pct = bare.includes('%');
  let s = (Math.abs(v) * (pct ? 100 : 1)).toFixed((/\.([0#?]+)/.exec(bare)?.[1] ?? '').length);
  if (/[0#],[0#]/.test(bare)) s = s.replace(/^\d+/, (int) => int.replace(/\B(?=(\d{3})+$)/g, ','));
  // The literal text around the digits: quoted strings, escaped characters and symbols such as a currency sign.
  const lit = (part) => part.replace(/"([^"]*)"|\\(.)|[_*]./g, (t, q, e) => q ?? e ?? '').replace(/[#0?,.%]/g, '');
  const [pre, post] = [sec.slice(0, sec.search(/[#0?]/)), sec.slice(sec.search(/[#0?][^#0?]*$/) + 1)];
  return `${sign}${lit(pre)}${s}${pct ? '%' : ''}${lit(post)}`;
}

/** Axis bounds for data from `lo` to `hi` (the axis's own min, max and unit win) → {min, max, unit}: Excel's auto scale, zero kept
 * in view, a unit of 1, 2 or 5 times a power of ten giving about five to ten steps. */
export function niceScale(lo, hi, ax = {}) {
  let min = ax.min ?? (lo >= 0 ? 0 : lo);
  let max = ax.max ?? (hi <= 0 && ax.min == null ? 0 : hi);
  if (max <= min) max = min + 1;
  const pad = ax.max == null && max > 0 ? (max - min) * 0.05 : 0;
  const padLo = ax.min == null && min < 0 ? (max - min) * 0.05 : 0;
  let unit = ax.unit;
  if (!unit) {
    const raw = (max + pad - (min - padLo)) / 8;
    const mag = 10 ** Math.floor(Math.log10(raw));
    unit = [1, 2, 5, 10].map((k) => k * mag).find((u) => u >= raw * 0.999);
  }
  if (ax.max == null) max = Math.ceil((max + pad) / unit - 1e-9) * unit;
  if (ax.min == null) min = Math.floor((min - padLo) / unit + 1e-9) * unit;
  return { min, max, unit };
}
/** The tick values of scale `s` (niceScale's), zero exact. */
export function ticksOf(s) {
  const out = [];
  for (let i = 0, v = s.min; v <= s.max + s.unit * 1e-6 && i < 1000; v = s.min + ++i * s.unit) out.push(Math.abs(v) < s.unit * 1e-9 ? 0 : v);
  return out;
}

// ---------- marks ----------
/** A marker of `mk` ({symbol, size, fill, line}) at x, y. */
export function marker(mk, x, y, extra = {}) {
  const r = (mk.size ?? 5) / 2;
  const look = { fill: col(mk.fill, '#4472C4'), stroke: col(mk.line, mk.fill ?? '#4472C4'), 'stroke-width': 0.75, ...extra };
  const path = (d) => el('path', { d, ...look });
  const [a, b, c, d] = [r2(x - r), r2(x + r), r2(y - r), r2(y + r)];
  if (mk.symbol === 'square') return el('rect', { x: x - r, y: y - r, width: 2 * r, height: 2 * r, ...look });
  if (mk.symbol === 'diamond') return path(`M${r2(x)} ${c}L${b} ${r2(y)}L${r2(x)} ${d}L${a} ${r2(y)}Z`);
  if (mk.symbol === 'triangle') return path(`M${r2(x)} ${c}L${b} ${d}L${a} ${d}Z`);
  if (mk.symbol === 'dash') return el('rect', { x: x - r, y: y - r / 4, width: 2 * r, height: r / 2, ...look });
  if (mk.symbol === 'dot') return el('circle', { cx: x, cy: y, r: r / 2, ...look });
  // The line symbols draw in their line colour, unfilled.
  const lines = { x: `M${a} ${c}L${b} ${d}M${b} ${c}L${a} ${d}`, plus: `M${r2(x)} ${c}L${r2(x)} ${d}M${a} ${r2(y)}L${b} ${r2(y)}` };
  lines.star = lines.x + lines.plus;
  if (lines[mk.symbol]) return path(lines[mk.symbol]).replace(/ fill="[^"]*"/, ' fill="none"');
  return el('circle', { cx: x, cy: y, r, ...look }); // circle, and picture markers drawn as one
}

// a:prstDash patterns in line widths.
const DASH = { sysDot: [1, 1], sysDash: [3, 1], dash: [4, 3], dot: [1, 3], dashDot: [4, 3, 1, 3], lgDash: [8, 3], lgDashDot: [8, 3, 1, 3], lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDashDot: [3, 1, 1, 1], sysDashDotDot: [3, 1, 1, 1, 1, 1] };
/** The stroke-dasharray of a:prstDash `dash` at line width `w`, or null for a solid line. */
export const dashOf = (dash, w) => (DASH[dash] ? DASH[dash].map((k) => r2(k * Math.max(w ?? 1, 0.5))).join(' ') : null);

/** A ring slice (a pie slice when r0 is 0) centred at cx, cy from angle `a` over `t` radians, clockwise from the top → path data. */
export function slicePath(cx, cy, r0, r1, a, t) {
  const pt = (r, u) => `${r2(cx + r * Math.sin(u))} ${r2(cy - r * Math.cos(u))}`;
  if (t >= Math.PI * 2 - 1e-9) { // the whole ring: two half arcs each way
    const ring = (r, sweep) => `M${pt(r, 0)}A${r2(r)} ${r2(r)} 0 1 ${sweep} ${pt(r, Math.PI)}A${r2(r)} ${r2(r)} 0 1 ${sweep} ${pt(r, 0)}Z`;
    return ring(r1, 1) + (r0 ? ring(r0, 0) : '');
  }
  const big = t > Math.PI ? 1 : 0;
  if (!r0) return `M${r2(cx)} ${r2(cy)}L${pt(r1, a)}A${r2(r1)} ${r2(r1)} 0 ${big} 1 ${pt(r1, a + t)}Z`;
  return `M${pt(r1, a)}A${r2(r1)} ${r2(r1)} 0 ${big} 1 ${pt(r1, a + t)}L${pt(r0, a + t)}A${r2(r0)} ${r2(r0)} 0 ${big} 0 ${pt(r0, a)}Z`;
}

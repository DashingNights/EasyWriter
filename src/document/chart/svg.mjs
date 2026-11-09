// Charts in Word files (docs/plans/word/left-out.md package 4): the chart model (model.mjs, cx.mjs) drawn as SVG markup. Pure, so
// node tests count what it draws. Lengths are pt: the SVG's viewBox is the chart's extent, and text sizes are the chart's own
// (Word 2013 and later: title 14 pt, the rest 9 pt, grey #595959). Every text and attribute is escaped, as the model comes from a
// file. Elements carry data attributes for the harness: data-bar, data-point, data-slice, data-legend, data-series, data-trend,
// data-box, data-bubble, data-hilow, data-updown, data-band, data-leaf. This file draws the frame, the title, the legend and the
// plots on two axes (bar, line, area, scatter, bubble, stock and box and whisker, on a primary and a secondary value axis, with
// their trendlines); plots.mjs draws the round and filled types.
// ponytail: 3-D charts draw flat (their tooltip says so), crowded category labels thin out instead of turning, a secondary X axis
// shares the primary one, and text widths are estimated (half an em a character), as nothing here measures text.
import { GRID, col, dashOf, el, esc, fmtNum, label, marker, niceScale, onFill, r2, rich, textW, ticksOf } from './kit.mjs';
import { eqNum, equation, fitTrend, movingAvg, rSquared } from './stats.mjs';
import { PLOTS, ROUND } from './plots.mjs';

export { fmtNum, niceScale } from './kit.mjs';

const font = (m) => `${m.font ? `'${String(m.font).replace(/['\\]/g, '')}', ` : ''}Calibri, Arial, sans-serif`;
const lined = (q) => q.type === 'line' || q.type === 'scatter' || q.type === 'stock' || (q.type === 'radar' && q.style !== 'filled');
const TREND_NAME = { linear: 'Linear', exp: 'Expon.', log: 'Log.', poly: 'Poly.', power: 'Power' };
/** A trendline's legend entry, as Excel names it: "Linear (Sales)", "2 per. Mov. Avg. (Sales)". */
export const trendName = (t, s) => t.name ?? `${t.type === 'movingAvg' ? `${t.period ?? 2} per. Mov. Avg.` : TREND_NAME[t.type] ?? 'Linear'} (${s.name})`;

/** The legend entries of `m`: its own list (bands, waterfall kinds, branches), the categories of a pie, doughnut or one varied
 * series, else the series and then their trendlines → [{text, color, line, marker}]. */
function entries(m) {
  const p = m.plots[0];
  const one = m.plots.length === 1 && (ROUND.has(p.type) || (p.vary && p.series.length === 1));
  const list = m.legendItems ? [...m.legendItems]
    : one ? m.cats.map((c, k) => ({ text: c, color: p.series[0]?.colors?.[k] ?? p.series[0]?.color }))
      : m.plots.flatMap((q) => q.series.map((s) => ({ text: s.name, color: s.color, line: lined(q) ? s.line : null, marker: s.marker })));
  if (!m.legendItems) list.push(...m.plots.flatMap((q) => q.series.flatMap((s) => (s.trends ?? []).filter((t) => t.line).map((t) => ({ text: trendName(t, s), color: t.line.color, line: t.line })))));
  const hide = new Set(m.legend?.hide ?? []);
  return list.filter((_, i) => !hide.has(i));
}

/** The legend of `m` in box {x, y, w, h} → {svg, box: the box left for the chart}. */
function legend(m, box) {
  const lg = m.legend;
  const list = lg ? entries(m) : [];
  if (!list.length) return { svg: '', box };
  const size = lg.size ?? 9;
  const lh = size * 1.45;
  const sw = 14; // swatch and gap before the text
  const widths = list.map((e) => sw + textW(e.text, size) + size);
  const item = (e, x, y, i) => {
    const w = Math.min(e.line?.width ?? 2, 3);
    const swatch = e.line
      ? el('line', { x1: x, y1: y, x2: x + 11, y2: y, stroke: col(e.line.color, e.color), 'stroke-width': w, 'stroke-dasharray': dashOf(e.line.dash, w) }) + (e.marker ? marker(e.marker, x + 5.5, y) : '')
      : e.marker ? marker(e.marker, x + 5.5, y) : el('rect', { x: x + 2, y: y - 3.5, width: 7, height: 7, fill: col(e.color, '#4472C4') });
    return el('g', { 'data-legend': i }, swatch + label(x + sw, y + size * 0.35, e.text, size));
  };
  let svg = '';
  const pos = lg.pos ?? 'r';
  if (pos === 't' || pos === 'b') {
    const rows = [[]];
    let used = 0;
    widths.forEach((wd, i) => {
      if (used + wd > box.w && rows.at(-1).length) { rows.push([]); used = 0; }
      rows.at(-1).push(i);
      used += wd;
    });
    const top = pos === 't' ? box.y : box.y + box.h - rows.length * lh;
    rows.forEach((row, r) => {
      let x = box.x + (box.w - row.reduce((s, i) => s + widths[i], 0)) / 2;
      for (const i of row) { svg += item(list[i], x, top + r * lh + lh / 2, i); x += widths[i]; }
    });
    const h = rows.length * lh + 4;
    return { svg, box: { ...box, y: pos === 't' ? box.y + h : box.y, h: box.h - h } };
  }
  const w = Math.min(Math.max(...widths), box.w / 2);
  const x = pos === 'l' ? box.x : box.x + box.w - w;
  const top = pos === 'tr' ? box.y : box.y + (box.h - list.length * lh) / 2;
  list.forEach((e, i) => { svg += item(e, x, top + i * lh + lh / 2, i); });
  return { svg, box: { ...box, x: pos === 'l' ? box.x + w + 6 : box.x, w: box.w - w - 6 } };
}

/** The value range of `plots`: stacked plots by their sums, percent stacked as 0 to 1, floating bars by their ends, boxes by their
 * whiskers and outliers → [lo, hi]. */
function range(plots) {
  let lo = Infinity;
  let hi = -Infinity;
  const see = (v) => { if (v != null && Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  for (const p of plots) {
    if (p.type === 'box') {
      for (const s of p.series) for (const b of s.boxes ?? []) if (b) [b.lo, b.hi, ...b.out, ...(s.inner ? b.pts : [])].forEach(see);
      continue;
    }
    if (p.series.some((s) => s.spans)) {
      for (const s of p.series) for (const q of s.spans ?? []) if (q) { see(q.from); see(q.to); }
      continue;
    }
    if (p.grouping === 'percentStacked') { lo = Math.min(lo, p.series.some((s) => s.vals.some((v) => v < 0)) ? -1 : 0); hi = Math.max(hi, 1); continue; }
    if (p.grouping === 'stacked') {
      const n = Math.max(0, ...p.series.map((s) => s.vals.length));
      for (let k = 0; k < n; k++) {
        const vs = p.series.map((s) => s.vals[k] ?? 0);
        see(vs.filter((v) => v > 0).reduce((a, b) => a + b, 0));
        see(vs.filter((v) => v < 0).reduce((a, b) => a + b, 0));
      }
      continue;
    }
    for (const s of p.series) s.vals.forEach(see);
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

/** Each series' drawn values of plot `p` (stacked: cumulative from `base`, percent: of the category's total, floating: its span)
 * → [[{from, to} | null]]. */
function stacks(p) {
  const n = Math.max(0, ...p.series.map((s) => s.vals.length));
  const pos = Array(n).fill(0);
  const neg = Array(n).fill(0);
  const tot = Array.from({ length: n }, (_, k) => p.series.reduce((a, s) => a + Math.abs(s.vals[k] ?? 0), 0) || 1);
  return p.series.map((s) => Array.from({ length: n }, (_, k) => {
    if (s.spans) return s.spans[k] ?? null;
    const raw = s.vals[k];
    if (raw == null) return null;
    if (p.grouping !== 'stacked' && p.grouping !== 'percentStacked') return { from: 0, to: raw };
    const v = p.grouping === 'percentStacked' ? raw / tot[k] : raw;
    const acc = v >= 0 ? pos : neg;
    const from = acc[k];
    acc[k] += v;
    return { from, to: acc[k] };
  }));
}

/** A path through `pts` ([x, y] or null for a gap), broken at gaps; `smooth` draws Catmull-Rom curves. */
export function linePath(pts, smooth) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      d += `M${r2(run[0][0])} ${r2(run[0][1])}`;
      for (let i = 1; i < run.length; i++) {
        const [p0, p1, p2, p3] = [run[i - 2] ?? run[i - 1], run[i - 1], run[i], run[i + 1] ?? run[i]];
        d += smooth ? `C${r2(p1[0] + (p2[0] - p0[0]) / 6)} ${r2(p1[1] + (p2[1] - p0[1]) / 6)} ${r2(p2[0] - (p3[0] - p1[0]) / 6)} ${r2(p2[1] - (p3[1] - p1[1]) / 6)} ${r2(p2[0])} ${r2(p2[1])}`
          : `L${r2(p2[0])} ${r2(p2[1])}`;
      }
    }
    run = [];
  };
  for (const p of pts) (p ? run.push(p) : flush());
  flush();
  return d;
}

const ORDER = { area: 0, bar: 1, box: 1, stock: 2, line: 2, scatter: 3, bubble: 3 };
const TRENDED = new Set(['bar', 'line', 'area', 'scatter', 'bubble', 'stock']);
const BIG = 1e6; // a trendline far off the plot is clipped there; this keeps its path numbers plain

/** Bar, line, area, scatter, bubble, stock and box plots of `m` in box {x, y, w, h} → SVG. */
function cartesian(m, box) {
  const plots = m.plots;
  const horizontal = plots.some((p) => p.type === 'bar' && p.dir === 'bar');
  const xy = plots.every((p) => p.type === 'scatter' || p.type === 'bubble');
  const xAx = m.x ?? {};
  // The value axes in use: the primary, and the secondary with its own scale and its labels on the far side.
  const groups = [0, 1].map((g) => plots.filter((p) => (p.ax ?? 0) === g)).filter((ps) => ps.length);
  if (!groups.length) groups.push([]);
  const V = groups.map((ps, i) => {
    const ax = ((ps[0]?.ax ?? 0) ? m.y2 : m.y) ?? {};
    const s = niceScale(...range(ps), ax);
    const ticks = ticksOf(s);
    const fmt = ax.fmt ?? (ps.some((p) => p.grouping === 'percentStacked') ? '0%' : ps[0]?.series[0]?.fmt ?? 'General');
    return { far: i > 0, ax, s, ticks, text: ticks.map((v) => fmtNum(v, fmt, s.unit)), size: ax.size ?? 9, show: ax.show !== false && ax.labels !== false };
  });
  const [prim, sec = null] = V;
  const vOf = (p) => (sec && (p.ax ?? 0) === 1 ? sec : prim);

  // Scatter and bubble: the X axis is a value axis too.
  let xs = null;
  if (xy) {
    const all = plots.flatMap((p) => p.series.flatMap((s) => s.vals.map((_, k) => s.xs?.[k] ?? k + 1))).filter(Number.isFinite);
    xs = niceScale(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 1, xAx);
  }
  const nCat = xy ? 0 : Math.max(m.cats.length, ...plots.flatMap((p) => p.series.map((s) => (s.boxes ?? s.vals).length)));
  const catText = Array.from({ length: nCat }, (_, k) => {
    const c = m.cats[k] ?? String(k + 1);
    return m.catFmt && c !== '' && Number.isFinite(+c) ? fmtNum(+c, m.catFmt) : c;
  });
  const xTicks = xs ? ticksOf(xs) : [];
  const xText = xs ? xTicks.map((v) => fmtNum(v, xAx.fmt ?? 'General', xs.unit)) : catText;

  // Room for the labels and axis titles: the primary value labels beside the plot (below it when horizontal), the secondary's on
  // the far side (above it when horizontal), the categories below (beside it when horizontal).
  const xSize = xAx.size ?? 9;
  const xShown = xAx.show !== false && xAx.labels !== false;
  const wide = (list, size) => Math.max(0, ...list.map((s) => textW(s, size))) + 5;
  const tH = (ax) => (ax?.title ? (ax.titleSize ?? 10) * 1.5 : 0);
  const room = horizontal
    ? { l: tH(xAx) + (xShown ? wide(xText, xSize) : 0), r: 0, t: 6 + (sec ? tH(sec.ax) + (sec.show ? sec.size * 1.5 : 0) : 0), b: tH(prim.ax) + (prim.show ? prim.size * 1.5 : 0) }
    : { l: tH(prim.ax) + (prim.show ? wide(prim.text, prim.size) : 0), r: sec ? tH(sec.ax) + (sec.show ? wide(sec.text, sec.size) : 0) : 0, t: 6, b: tH(xAx) + (xShown ? xSize * 1.5 : 0) };
  const plot = { x: box.x + room.l, y: box.y + room.t, w: 0, h: 0 };
  plot.w = Math.max(1, box.x + box.w - (room.r ? room.r + 4 : 8) - plot.x);
  plot.h = Math.max(1, box.y + box.h - room.b - plot.y);

  // Value to position along each value axis (raw: unclamped, for a trendline the plot clips), and the category band.
  for (const v of V) {
    v.raw = (x) => {
      const f = (x - v.s.min) / (v.s.max - v.s.min);
      return Math.max(-BIG, Math.min(BIG, horizontal ? plot.x + (v.ax.reverse ? 1 - f : f) * plot.w : plot.y + (v.ax.reverse ? f : 1 - f) * plot.h));
    };
    v.pos = (x) => v.raw(Math.min(v.s.max, Math.max(v.s.min, x)));
  }
  const xRaw = (v) => Math.max(-BIG, Math.min(BIG, plot.x + ((v - xs.min) / (xs.max - xs.min)) * plot.w));
  const cLen = horizontal ? plot.h : plot.w;
  const band = nCat ? cLen / nCat : cLen;
  // A horizontal bar chart lists its first category at the bottom, as Word does unless the axis is reversed.
  const cStart = (k) => (horizontal ? (xAx.reverse ? plot.y + k * band : plot.y + plot.h - (k + 1) * band) : xAx.reverse ? plot.x + plot.w - (k + 1) * band : plot.x + k * band);

  let svg = '';
  // Gridlines and the value labels.
  for (const v of V) {
    if (v.ax.grid) for (const t of v.ticks) {
      const at = v.pos(t);
      const look = { stroke: col(v.ax.gridColor, GRID), 'stroke-width': 0.75 };
      svg += el('line', horizontal ? { x1: at, y1: plot.y, x2: at, y2: plot.y + plot.h, ...look } : { x1: plot.x, y1: at, x2: plot.x + plot.w, y2: at, ...look });
    }
    if (v.show) v.ticks.forEach((t, i) => {
      svg += horizontal ? label(v.pos(t), v.far ? plot.y - v.size * 0.5 : plot.y + plot.h + v.size * 1.2, v.text[i], v.size, { 'text-anchor': 'middle' })
        : label(v.far ? plot.x + plot.w + 4 : plot.x - 4, v.pos(t) + v.size * 0.35, v.text[i], v.size, { 'text-anchor': v.far ? 'start' : 'end' });
    });
  }
  if (xs && xAx.grid) for (const v of xTicks) svg += el('line', { x1: xRaw(v), y1: plot.y, x2: xRaw(v), y2: plot.y + plot.h, stroke: col(xAx.gridColor, GRID), 'stroke-width': 0.75 });
  // The category (or X) axis labels: every k-th when they would overlap.
  if (xShown) {
    if (xs) xTicks.forEach((v, i) => { svg += label(xRaw(v), plot.y + plot.h + xSize * 1.2, xText[i], xSize, { 'text-anchor': 'middle' }); });
    else {
      const need = horizontal ? xSize * 1.2 : Math.max(0, ...catText.map((s) => textW(s, xSize))) + 4;
      const every = Math.max(1, Math.ceil(need / Math.max(band, 1)));
      catText.forEach((s, k) => {
        if (k % every) return;
        const mid = cStart(k) + band / 2;
        svg += horizontal ? label(plot.x - 4, mid + xSize * 0.35, s, xSize, { 'text-anchor': 'end' })
          : label(mid, plot.y + plot.h + xSize * 1.2, s, xSize, { 'text-anchor': 'middle' });
      });
    }
  }
  // Axis titles: the low one centred under the plot, the side ones turned beside it (the secondary's on the right, or above the
  // plot when the bars are horizontal).
  const [lowAx, sideAx] = horizontal ? [prim.ax, xAx] : [xAx, prim.ax];
  if (lowAx.title) svg += label(plot.x + plot.w / 2, box.y + box.h - 2, lowAx.title, lowAx.titleSize ?? 10, { 'text-anchor': 'middle' });
  const turned = (ax, x) => label(x, plot.y + plot.h / 2, ax.title, ax.titleSize ?? 10, { 'text-anchor': 'middle', transform: `rotate(-90 ${r2(x)} ${r2(plot.y + plot.h / 2)})` });
  if (sideAx.title) svg += turned(sideAx, box.x + (sideAx.titleSize ?? 10));
  if (sec?.ax.title) svg += horizontal ? label(plot.x + plot.w / 2, box.y + (sec.ax.titleSize ?? 10), sec.ax.title, sec.ax.titleSize ?? 10, { 'text-anchor': 'middle' })
    : turned(sec.ax, box.x + box.w - (sec.ax.titleSize ?? 10) * 0.5);

  // The plots: areas first, then bars and boxes, then lines and points, as Word stacks a combination chart. Trendlines go on top,
  // clipped to the plot, with their equations over them.
  let trends = '';
  let trendText = '';
  const trend = (s, at) => {
    const pts = s.vals.map((y, k) => (y == null ? null : [xy ? s.xs?.[k] ?? k + 1 : k + 1, y])).filter((q) => q && Number.isFinite(q[0]));
    for (const t of s.trends ?? []) {
      if (!t.line || pts.length < 2) continue;
      let line;
      const lines = [];
      if (t.type === 'movingAvg') line = movingAvg(pts, t.period);
      else {
        const fit = fitTrend(t, pts);
        if (!fit) continue;
        const xsAll = pts.map((q) => q[0]);
        const b = Math.max(...xsAll) + (t.forward ?? 0);
        let a = Math.min(...xsAll) - (t.backward ?? 0);
        if (fit.lx) a = Math.max(a, Math.min(...xsAll) / 10); // ln x needs x above zero
        const steps = t.type === 'linear' ? 1 : 60;
        line = Array.from({ length: steps + 1 }, (_, i) => { const x = a + ((b - a) * i) / steps; return [x, fit.f(x)]; });
        const fmt = t.fmt && !/^general$/i.test(t.fmt) ? (n) => fmtNum(n, t.fmt) : eqNum; // General here is Excel's short General
        if (t.eq) lines.push(equation(t.type, fit, fmt));
        if (t.r2) lines.push(rSquared(fit.r2, fmt));
      }
      const drawn = line.filter(([, y]) => Number.isFinite(y)).map(([x, y]) => at(x, y));
      if (drawn.length < 2) continue;
      const w = t.line.width ?? 1.5;
      trends += el('path', { d: linePath(drawn), fill: 'none', stroke: col(t.line.color, s.color), 'stroke-width': w, 'stroke-dasharray': dashOf(t.line.dash, w), 'stroke-linecap': 'round', 'data-trend': t.type });
      if (!lines.length) continue;
      // Its equation and R² sit above the line's right end, inside the plot.
      const size = t.size ?? 9;
      const lh = size * 1.3;
      const inside = drawn.filter(([x, y]) => x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h);
      const [ex, ey] = inside.at(-1) ?? drawn.at(-1);
      const tw = Math.max(...lines.map((parts) => textW(parts.map((q) => q[0]).join(''), size)));
      const x = Math.min(plot.x + plot.w - 2, Math.max(plot.x + tw + 2, ex));
      const y = Math.min(plot.y + plot.h - 2 - (lines.length - 1) * lh, Math.max(plot.y + size, ey - 6 - (lines.length - 1) * lh));
      lines.forEach((parts, i) => { trendText += rich(x, y + i * lh, parts, size, { 'text-anchor': 'end', 'data-trend-label': '' }); });
    }
  };

  for (const p of [...plots].sort((a, b) => (ORDER[a.type] ?? 2) - (ORDER[b.type] ?? 2))) {
    const v = vOf(p);
    const vPos = v.pos;
    const st = stacks(p);
    const n = p.series.length;
    const flat = p.grouping !== 'stacked' && p.grouping !== 'percentStacked'; // a stacked plot has no trendlines in Word
    if (p.type === 'bar') {
      const gap = (p.gap ?? 150) / 100;
      const ov = p.grouping === 'clustered' || p.grouping === 'standard' ? (p.overlap ?? 0) / 100 : 1;
      const lanes = ov >= 1 ? 1 : n - (n - 1) * ov;
      const bw = band / (lanes + gap);
      const offOf = (j, k) => cStart(k) + (band - bw * lanes) / 2 + (ov >= 1 ? 0 : j * bw * (1 - ov));
      let labels = ''; // over every bar: a stacked chart's labels sit in the middle of their part, as Word puts them
      p.series.forEach((s, j) => st[j].forEach((q, k) => {
        if (!q) return;
        const off = offOf(j, k);
        const [a, b] = [vPos(q.from), vPos(q.to)];
        const geo = horizontal ? { x: Math.min(a, b), y: off, width: Math.abs(b - a), height: bw } : { x: off, y: Math.min(a, b), width: bw, height: Math.abs(b - a) };
        svg += el('rect', { ...geo, fill: col(s.colors?.[k], s.color), 'data-bar': `${j}:${k}` });
        // A waterfall's connector: from this bar's end across to the next bar.
        if (p.connect && !horizontal && st[j][k + 1]) {
          const next = offOf(j, k + 1);
          const [l, r] = next > off ? [off + bw, next] : [next + bw, off];
          svg += el('line', { x1: l, y1: b, x2: r, y2: b, stroke: '#A6A6A6', 'stroke-width': 0.75, 'data-connector': k });
        }
        if (!s.labels?.val) return;
        const text = fmtNum(s.vals[k], s.fmt);
        const mid = !flat || s.labels.pos === 'ctr';
        const down = q.to < q.from; // a bar that runs down (or left) has its label past that end
        const inside = { 'text-anchor': 'middle', ...(s.labels.pos === 'ctr' && { fill: onFill(col(s.colors?.[k], s.color)) }) };
        if (horizontal) labels += mid ? label((a + b) / 2, off + bw / 2 + 3, text, 9, inside)
          : label(down ? Math.min(a, b) - 3 : Math.max(a, b) + 3, off + bw / 2 + 3, text, 9, down ? { 'text-anchor': 'end' } : {});
        else labels += label(off + bw / 2, mid ? (a + b) / 2 + 3 : down ? Math.max(a, b) + 9 : Math.min(a, b) - 3, text, 9, mid ? inside : { 'text-anchor': 'middle' });
      }));
      svg += labels;
      if (flat) p.series.forEach((s) => trend(s, (x, y) => {
        const c = cStart(0) + band / 2 + (x - 1) * (cStart(1) - cStart(0));
        return horizontal ? [v.raw(y), c] : [c, v.raw(y)];
      }));
      continue;
    }
    if (p.type === 'box') {
      // Excel's box and whisker: a box from the first to the third quartile with the median across it, whiskers to the farthest
      // values within 1.5 times the box, the mean as a cross, and the outliers as rings.
      const bw = band / (n + (p.gap ?? 100) / 100);
      p.series.forEach((s, j) => {
        const c0 = col(s.color, '#4472C4');
        const means = [];
        (s.boxes ?? []).forEach((b, k) => {
          if (!b) return;
          const off = cStart(k) + (band - bw * n) / 2 + j * bw;
          const c = off + bw / 2;
          const [hi, q3, q1, lo] = [b.hi, b.q3, b.q1, b.lo].map(vPos);
          let g = el('path', { d: `M${r2(c)} ${r2(hi)}V${r2(q3)}M${r2(c)} ${r2(q1)}V${r2(lo)}M${r2(c - bw / 4)} ${r2(hi)}H${r2(c + bw / 4)}M${r2(c - bw / 4)} ${r2(lo)}H${r2(c + bw / 4)}`,
            fill: 'none', stroke: c0, 'stroke-width': 0.75 });
          g += el('rect', { x: off, y: Math.min(q1, q3), width: bw, height: Math.max(0.5, Math.abs(q1 - q3)), fill: c0 });
          g += el('line', { x1: off, y1: vPos(b.med), x2: off + bw, y2: vPos(b.med), stroke: '#FFFFFF', 'stroke-width': 1.25 });
          if (s.mean) g += marker({ symbol: 'x', size: Math.max(3, Math.min(7, bw * 0.5)), line: '#FFFFFF' }, c, vPos(b.mean));
          const rings = [...(s.outliers ? b.out : []), ...(s.inner ? b.pts.filter((x) => !b.out.includes(x)) : [])];
          for (const o of rings) g += marker({ symbol: 'circle', size: 4, fill: '#FFFFFF', line: c0 }, c, vPos(o), { 'data-point': '' });
          svg += el('g', { 'data-box': `${j}:${k}` }, g);
          means.push([c, vPos(b.mean)]);
        });
        if (s.meanLine && means.length > 1) svg += el('path', { d: linePath(means), fill: 'none', stroke: c0, 'stroke-width': 1 });
      });
      continue;
    }
    // Line and area points sit mid band (crossBetween between) or on the band edges (midCat).
    const mid = (v.ax.between ?? (p.type === 'area' ? 'midCat' : 'between')) === 'between';
    const along = (k) => (mid || nCat < 2 ? cStart(k) + band / 2 : xAx.reverse ? plot.x + plot.w - (k * plot.w) / (nCat - 1) : plot.x + (k * plot.w) / (nCat - 1));
    const cx = (k, s) => (xs ? xRaw(s.xs?.[k] ?? k + 1) : along(k));
    const at = (k, val, s) => (horizontal ? [vPos(val), cStart(k) + band / 2] : [cx(k, s), vPos(val)]);
    const trendAt = (x, y) => (xs ? [xRaw(x), v.raw(y)] : [along(0) + (x - 1) * (along(1) - along(0)), v.raw(y)]);
    if (p.type === 'area') {
      p.series.forEach((s, j) => {
        const top = st[j].map((q, k) => at(k, q ? q.to : 0, s));
        const base = st[j].map((q, k) => at(k, q ? q.from : 0, s)).reverse();
        if (top.length) svg += el('path', { d: `M${[...top, ...base].map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}Z`, fill: col(s.color, '#4472C4'), 'data-series': j, 'data-points': top.length });
      });
      if (flat) p.series.forEach((s) => trend(s, trendAt));
      continue;
    }
    if (p.type === 'bubble') {
      // Bubble area (or width) stands for its size; the largest is a quarter of the plot's shorter side at a scale of 100%.
      const top = Math.max(0, ...p.series.flatMap((s) => (s.sizes ?? []).map((z) => Math.abs(z ?? 0)))) || 1;
      const maxR = (Math.min(plot.w, plot.h) / 8) * ((p.scale ?? 100) / 100);
      const list = [];
      p.series.forEach((s, j) => s.vals.forEach((y, k) => {
        const z = s.sizes?.[k];
        if (y == null || !z || (z < 0 && !p.neg)) return;
        const f = Math.abs(z) / top;
        list.push({ s, j, k, x: cx(k, s), y: vPos(y), r: maxR * (p.sizeBy === 'w' ? f : Math.sqrt(f)), hollow: z < 0 });
      }));
      list.sort((a, b) => b.r - a.r); // the largest behind, so none hides a smaller one
      for (const b of list) {
        const c = col(b.s.colors?.[b.k], b.s.color);
        svg += el('circle', { cx: b.x, cy: b.y, r: Math.max(0.5, b.r), fill: b.hollow ? '#FFFFFF' : c, stroke: b.hollow ? c : '#FFFFFF', 'stroke-width': 0.75, 'data-bubble': `${b.j}:${b.k}` });
        if (b.s.labels?.val) svg += label(b.x, b.y + 3, fmtNum(b.s.vals[b.k], b.s.fmt), 9, { 'text-anchor': 'middle' });
      }
      p.series.forEach((s) => trend(s, trendAt));
      continue;
    }
    if (p.type === 'stock') {
      // High-low lines join each category's highest and lowest value; up-down bars run from the first series (open) to the last
      // (close), light when it closes higher.
      for (let k = 0; k < nCat; k++) {
        const vs = p.series.map((s) => s.vals[k]).filter((x) => x != null);
        const c = cStart(k) + band / 2;
        if (p.hiLow && vs.length > 1) svg += el('line', { x1: c, y1: vPos(Math.max(...vs)), x2: c, y2: vPos(Math.min(...vs)), stroke: col(p.hiLow.color, '#404040'), 'stroke-width': p.hiLow.width ?? 0.75, 'data-hilow': k });
        const [o, cl] = [p.series[0]?.vals[k], p.series.at(-1)?.vals[k]];
        if (!p.upDown || n < 2 || o == null || cl == null) continue;
        const w = band / (1 + (p.upDown.gap ?? 150) / 100);
        svg += el('rect', { x: c - w / 2, y: Math.min(vPos(o), vPos(cl)), width: w, height: Math.max(0.5, Math.abs(vPos(o) - vPos(cl))), fill: col(cl >= o ? p.upDown.up : p.upDown.down, '#FFFFFF'),
          stroke: col(p.upDown.line, '#595959'), 'stroke-width': 0.75, 'data-updown': cl >= o ? 'up' : 'down' });
      }
    }
    p.series.forEach((s, j) => {
      const pts = st[j].map((q, k) => (q ? at(k, q.to, s) : null));
      const shown = pts.filter(Boolean);
      let g = '';
      if (s.line) g += el('path', { d: linePath(pts, s.smooth), fill: 'none', stroke: col(s.line.color, s.color), 'stroke-width': s.line.width ?? 2.25, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      if (s.marker) shown.forEach(([x, y]) => { g += marker(s.marker, x, y, { 'data-point': '' }); });
      if (s.labels?.val) pts.forEach((q, k) => { if (q) g += label(q[0], q[1] - 6, fmtNum(s.vals[k], s.fmt), 9, { 'text-anchor': 'middle' }); });
      svg += el('g', { 'data-series': j, 'data-points': shown.length }, g);
      if (flat && !horizontal) trend(s, trendAt);
    });
  }
  if (trends) svg += el('svg', { x: plot.x, y: plot.y, width: plot.w, height: plot.h, viewBox: `${r2(plot.x)} ${r2(plot.y)} ${r2(plot.w)} ${r2(plot.h)}`, overflow: 'hidden' }, trends);
  svg += trendText;
  // The category axis line at zero (or at the plot's edge), and the value axes' lines where the file gives them.
  const zero = prim.pos(Math.min(prim.s.max, Math.max(prim.s.min, 0)));
  if (xAx.lineColor !== 'none' && xAx.show !== false) {
    const look = { stroke: col(xAx.lineColor, GRID), 'stroke-width': 0.75 };
    const y = xs ? plot.y + plot.h : zero;
    svg += el('line', horizontal ? { x1: zero, y1: plot.y, x2: zero, y2: plot.y + plot.h, ...look } : { x1: plot.x, y1: y, x2: plot.x + plot.w, y2: y, ...look });
  }
  for (const v of V) {
    if (!v.ax.lineColor || v.ax.lineColor === 'none' || v.ax.show === false) continue;
    const look = { stroke: col(v.ax.lineColor, GRID), 'stroke-width': 0.75 };
    const at = v.far ? (horizontal ? plot.y : plot.x + plot.w) : horizontal ? plot.y + plot.h : plot.x;
    svg += el('line', horizontal ? { x1: plot.x, y1: at, x2: plot.x + plot.w, y2: at, ...look } : { x1: at, y1: plot.y, x2: at, y2: plot.y + plot.h, ...look });
  }
  return svg;
}

/**
 * Chart model `m` (model.mjs) drawn at `w` by `h` pt → SVG markup (an svg element filling its box). A chart of a type that is not
 * drawn (m.other) is a framed box with its title and its type.
 */
export function chartSvg(m, w, h) {
  w = Math.max(1, +w || 1);
  h = Math.max(1, +h || 1);
  const area = m?.area ?? {};
  const frame = el('rect', { x: 0.5, y: 0.5, width: w - 1, height: h - 1, fill: area.fill === 'none' ? 'none' : col(area.fill, '#FFFFFF'),
    stroke: area.line === 'none' ? null : col(area.line, GRID), 'stroke-width': area.line === 'none' ? null : 0.75 });
  // Word users would miss a 3-D chart's depth, so its tooltip says it is drawn flat.
  const tip = m?.d3 ? el('title', {}, esc('This 3-D chart is shown flat.')) : '';
  const wrap = (inner) => el('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${r2(w)} ${r2(h)}`, width: '100%', height: '100%', style: 'display: block', 'font-family': font(m ?? {}),
    preserveAspectRatio: 'none', role: 'img', 'aria-label': m?.title?.text ?? 'Chart' }, tip + frame + inner);
  if (!m || m.other || !m.plots?.length) {
    const t = m?.title?.text;
    return wrap((t ? label(w / 2, h / 2 - 6, t, Math.min(14, h / 4), { 'text-anchor': 'middle' }) : '')
      + label(w / 2, h / 2 + (t ? 12 : 3), `${m?.other ?? 'Unknown'} chart`, 9, { 'text-anchor': 'middle', 'data-other': '' }));
  }
  let svg = '';
  let box = { x: 7, y: 7, w: w - 14, h: h - 14 };
  if (m.title) {
    const size = m.title.size ?? 14;
    const lines = String(m.title.text).split('\n');
    lines.forEach((s, i) => { svg += label(w / 2, box.y + size * (i + 0.9), s, size, { 'text-anchor': 'middle', 'data-title': '' }); });
    const th = lines.length * size * 1.2 + 4;
    box = { ...box, y: box.y + th, h: box.h - th };
  }
  const lg = legend(m, box);
  svg += lg.svg;
  box = lg.box;
  const own = PLOTS[m.plots[0].type];
  const round = m.plots.every((p) => ROUND.has(p.type));
  svg += own && (round || !ROUND.has(m.plots[0].type)) ? own(m, box) : cartesian({ ...m, plots: m.plots.filter((p) => !ROUND.has(p.type)) }, box);
  return wrap(svg);
}

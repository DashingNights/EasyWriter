// The chart types not drawn on two straight axes (svg.mjs draws those): pie, doughnut, pie of pie and bar of pie, radar, surface
// (a contour map, the top view Word gives a 2-D surface chart; a 3-D one draws the same, flat), treemap and sunburst. Each takes
// the model (model.mjs, cx.mjs) and the box left after the title and legend, and returns SVG. Pure; imports only its siblings.
import { GRID, col, el, fmtNum, label, marker, niceScale, onFill, r2, slicePath, textW, ticksOf } from './kit.mjs';
import { partsOf, squarify, treeOf } from './stats.mjs';

const TAU = Math.PI * 2;

/** A slice's data label (series name, category, value, percent), placed at angle `u` from the centre → SVG. */
function sliceLabel(lb, s, cat, v, total, cx, cy, r, u, out) {
  if (!lb) return '';
  const text = [lb.ser && s.name, lb.cat && cat, lb.val && fmtNum(v, s.fmt), lb.pct && `${Math.round((v / total) * 100)}%`].filter(Boolean).join(', ');
  return label(cx + r * Math.sin(u), cy - r * Math.cos(u) + 3, text, 9, { 'text-anchor': 'middle', fill: out ? '#595959' : '#404040' });
}

/** Pie and doughnut plot `p` in box {x, y, w, h} → SVG. */
function pie(p, box, m) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const R = Math.max(1, Math.min(box.w, box.h) / 2 - 4);
  const rings = p.type === 'doughnut' ? p.series : p.series.slice(0, 1);
  const inner = p.type === 'doughnut' ? (R * (p.hole ?? 50)) / 100 : 0;
  const ringW = (R - inner) / Math.max(1, rings.length);
  let svg = '';
  rings.forEach((s, j) => {
    const r1 = inner + ringW * (j + 1);
    const r0 = inner + ringW * j;
    const vals = s.vals.map((v) => (v != null && v > 0 ? v : 0));
    const total = vals.reduce((a, b) => a + b, 0);
    if (!total) return;
    let a = ((p.first ?? 0) * Math.PI) / 180;
    vals.forEach((v, k) => {
      if (!v) return;
      const t = (v / total) * TAU;
      svg += el('path', { d: slicePath(cx, cy, r0, r1, a, t), fill: col(s.colors?.[k], s.color), stroke: '#FFFFFF', 'stroke-width': 1, 'fill-rule': 'evenodd', 'data-slice': k, 'data-series': j });
      const out = s.labels?.pos === 'outEnd';
      svg += sliceLabel(s.labels, s, m.cats[k], s.vals[k], total, cx, cy, out ? r1 + 10 : r0 ? (r0 + r1) / 2 : r1 * 0.65, a + t / 2, out);
      a += t;
    });
  });
  return svg;
}

/**
 * Pie of pie and bar of pie `p`: the main pie with the points the split leaves it and one "Other" slice for the rest, which the
 * second plot (a smaller pie, or a stacked bar) shows, joined to it by series lines. The Other slice faces the second plot.
 * ponytail: an automatic split takes the last two points (the position split's own default), where Excel may choose otherwise.
 */
function ofPie(p, box, m) {
  const s = p.series[0];
  const vals = (s?.vals ?? []).map((v) => (v != null && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return '';
  const n = vals.length;
  const sp = p.split ?? {};
  const second = new Set(sp.type === 'cust' ? sp.cust
    : sp.type === 'val' ? vals.flatMap((v, k) => (v < (sp.pos ?? 0) ? [k] : []))
      : sp.type === 'percent' ? vals.flatMap((v, k) => ((v / total) * 100 < (sp.pos ?? 0) ? [k] : []))
        : Array.from({ length: Math.min(n, Math.max(0, Math.round(sp.pos ?? 2))) }, (_, i) => n - 1 - i));
  const rest = [...second].filter((k) => vals[k]).sort((a, b) => a - b);
  const other = rest.reduce((a, k) => a + vals[k], 0);
  if (!other) return pie({ ...p, type: 'pie' }, box, m);
  // Sizes: the second plot is second% of the main pie's height, the gap between them gap% of half the second plot.
  const bar = p.of === 'bar';
  const s2 = Math.max(0.05, (p.second ?? 75) / 100);
  const gapF = ((p.gap ?? 150) / 100) * 0.5;
  const wF = bar ? 0.35 : 1; // the second plot's width over its height
  const D = Math.max(2, Math.min(box.h - 8, (box.w - 8) / (1 + s2 * (gapF + wF))));
  const d = D * s2;
  const R = D / 2;
  const cx = box.x + (box.w - (D + d * (gapF + wF))) / 2 + R;
  const cy = box.y + box.h / 2;
  const x2 = cx + R + d * gapF; // the second plot's left edge
  let svg = '';
  const tOther = (other / total) * TAU;
  let a = Math.PI / 2 + tOther / 2;
  vals.forEach((v, k) => {
    if (!v || second.has(k)) return;
    const t = (v / total) * TAU;
    svg += el('path', { d: slicePath(cx, cy, 0, R, a, t), fill: col(s.colors?.[k], s.color), stroke: '#FFFFFF', 'stroke-width': 1, 'data-slice': k });
    svg += sliceLabel(s.labels, s, m.cats[k], v, total, cx, cy, R * 0.65, a + t / 2);
    a += t;
  });
  svg += el('path', { d: slicePath(cx, cy, 0, R, a, tOther), fill: col(s.colors?.[n], '#7F7F7F'), stroke: '#FFFFFF', 'stroke-width': 1, 'data-slice': 'other' });
  svg += sliceLabel(s.labels, s, 'Other', other, total, cx, cy, R * 0.65, a + tOther / 2);
  const edge = (u) => [cx + R * Math.sin(u), cy - R * Math.cos(u)];
  const [top, low] = [edge(Math.PI / 2 - tOther / 2), edge(Math.PI / 2 + tOther / 2)];
  const join = (from, to) => (p.serLines ? el('line', { x1: from[0], y1: from[1], x2: to[0], y2: to[1], stroke: col(p.serLines, '#595959'), 'stroke-width': 0.75 }) : '');
  if (bar) {
    const bw = d * wF;
    let y = cy - d / 2;
    for (const k of rest) {
      const h = (vals[k] / other) * d;
      svg += el('rect', { x: x2, y, width: bw, height: h, fill: col(s.colors?.[k], s.color), stroke: '#FFFFFF', 'stroke-width': 1, 'data-slice': k });
      if (s.labels) svg += sliceLabel(s.labels, s, m.cats[k], vals[k], total, x2 + bw / 2, y + h / 2, 0, 0);
      y += h;
    }
    return svg + join(top, [x2, cy - d / 2]) + join(low, [x2, cy + d / 2]);
  }
  const r = d / 2;
  const cx2 = x2 + r;
  let b = 0;
  for (const k of rest) {
    const t = (vals[k] / other) * TAU;
    svg += el('path', { d: slicePath(cx2, cy, 0, r, b, t), fill: col(s.colors?.[k], s.color), stroke: '#FFFFFF', 'stroke-width': 1, 'data-slice': k });
    svg += sliceLabel(s.labels, s, m.cats[k], vals[k], total, cx2, cy, r * 0.62, b + t / 2);
    b += t;
  }
  return svg + join(top, [cx2, cy - r]) + join(low, [cx2, cy + r]);
}

const round = (m, box) => m.plots.map((p) => (p.type === 'ofPie' ? ofPie(p, box, m) : pie(p, box, m))).join('');

/** A radar chart: categories round the circle clockwise from the top, values out from the centre; lines, markers or filled. */
function radar(m, box) {
  const p = m.plots[0];
  const n = Math.max(m.cats.length, ...p.series.map((s) => s.vals.length));
  if (!n) return '';
  const [xAx, yAx] = [m.x ?? {}, m.y ?? {}];
  const all = p.series.flatMap((s) => s.vals).filter((v) => v != null);
  const ys = niceScale(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 1, yAx);
  const ticks = ticksOf(ys);
  const size = xAx.size ?? 9;
  const cats = Array.from({ length: n }, (_, k) => m.cats[k] ?? String(k + 1));
  const catW = xAx.show !== false && xAx.labels !== false ? Math.max(0, ...cats.map((c) => textW(c, size))) + 6 : 0;
  const R = Math.max(1, Math.min(box.w / 2 - catW, box.h / 2 - size * 1.6));
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
  const ang = (k) => (TAU * k) / n;
  const pt = (k, v) => {
    const r = (R * (Math.min(ys.max, Math.max(ys.min, v)) - ys.min)) / (ys.max - ys.min);
    return [cx + r * Math.sin(ang(k)), cy - r * Math.cos(ang(k))];
  };
  const poly = (list) => (list.length ? `M${list.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}Z` : '');
  let svg = '';
  // The value gridlines are polygons, the category gridlines spokes; the value labels run up the top spoke.
  if (yAx.grid) for (const t of ticks.slice(1)) svg += el('path', { d: poly(cats.map((_, k) => pt(k, t))), fill: 'none', stroke: col(yAx.gridColor, GRID), 'stroke-width': 0.75 });
  if (xAx.grid) cats.forEach((_, k) => { const [x, y] = pt(k, ys.max); svg += el('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: col(xAx.gridColor, GRID), 'stroke-width': 0.75 }); });
  if (yAx.show !== false && yAx.labels !== false) {
    const fmt = yAx.fmt ?? p.series[0]?.fmt ?? 'General';
    for (const t of ticks) { const [x, y] = pt(0, t); svg += label(x - 3, y + 3, fmtNum(t, fmt, ys.unit), yAx.size ?? 9, { 'text-anchor': 'end' }); }
  }
  if (catW) cats.forEach((c, k) => {
    const [sn, cs] = [Math.sin(ang(k)), Math.cos(ang(k))];
    svg += label(cx + (R + 4) * sn, cy - (R + 4) * cs + size * 0.35 - cs * size * 0.4, c, size, { 'text-anchor': sn > 0.1 ? 'start' : sn < -0.1 ? 'end' : 'middle' });
  });
  p.series.forEach((s, j) => {
    const pts = cats.map((_, k) => (s.vals[k] == null ? null : pt(k, s.vals[k]))).filter(Boolean);
    let g = '';
    if (p.style === 'filled') g += el('path', { d: poly(pts), fill: col(s.color, '#4472C4') });
    else if (s.line) g += el('path', { d: poly(pts), fill: 'none', stroke: col(s.line.color, s.color), 'stroke-width': s.line.width ?? 2.25, 'stroke-linejoin': 'round' });
    if (s.marker) for (const [x, y] of pts) g += marker(s.marker, x, y, { 'data-point': '' });
    if (s.labels?.val) cats.forEach((_, k) => { if (s.vals[k] != null) { const [x, y] = pt(k, s.vals[k]); g += label(x, y - 6, fmtNum(s.vals[k], s.fmt), 9, { 'text-anchor': 'middle' }); } });
    svg += el('g', { 'data-series': j, 'data-points': pts.length }, g);
  });
  return svg;
}

/**
 * A surface chart as Word's contour (top view): categories across, series up, each value band (one per major unit, plot.bands)
 * in its colour; a wireframe draws only the lines between the bands.
 * ponytail: the filled bands are drawn on an 8 by 8 grid of each cell, so their edges step where Excel's are smooth.
 */
function surface(m, box) {
  const p = m.plots[0];
  const rows = p.series;
  const nx = Math.max(m.cats.length, ...rows.map((s) => s.vals.length));
  const ny = rows.length;
  const bands = p.bands ?? [];
  if (!nx || !ny || !bands.length) return '';
  const bandAt = (v) => { const i = bands.findIndex((b) => v <= b.to); return i < 0 ? bands.length - 1 : i; };
  const size = m.x?.size ?? 9;
  const sw = Math.max(0, ...rows.map((s) => textW(s.name, size))) + 5;
  const plot = { x: box.x + sw, y: box.y + 6, w: Math.max(1, box.w - sw - 8), h: Math.max(1, box.h - 6 - size * 1.5) };
  const X = (k) => plot.x + (nx < 2 ? plot.w / 2 : (k * plot.w) / (nx - 1));
  const Y = (j) => plot.y + plot.h - (ny < 2 ? plot.h / 2 : (j * plot.h) / (ny - 1));
  const z = (j, k) => rows[Math.min(j, ny - 1)]?.vals[Math.min(k, nx - 1)] ?? null;
  let svg = '';
  const S = 8;
  const cells = [];
  for (let j = 0; j < Math.max(1, ny - 1); j++) for (let k = 0; k < Math.max(1, nx - 1); k++) {
    const c = [z(j, k), z(j, k + 1), z(j + 1, k), z(j + 1, k + 1)];
    if (!c.some((v) => v == null)) cells.push({ j, k, c });
  }
  if (!p.wire) {
    for (const { j, k, c: [a, b, c, d] } of cells) {
      const [x0, x1, y0, y1] = [X(k), nx < 2 ? plot.x + plot.w : X(k + 1), Y(j), ny < 2 ? plot.y : Y(j + 1)];
      const [cw, ch] = [(x1 - x0) / S, (y0 - y1) / S];
      for (let r = 0; r < S; r++) {
        const v = (r + 0.5) / S;
        let run = null;
        const flush = () => { if (run) svg += el('rect', { x: x0 + run.q * cw, y: y0 - (r + 1) * ch, width: run.n * cw + 0.3, height: ch + 0.3, fill: bands[run.i].color, 'data-band': run.i }); };
        for (let q = 0; q < S; q++) {
          const u = (q + 0.5) / S;
          const i = bandAt(a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v);
          if (run?.i === i) run.n++;
          else { flush(); run = { i, q, n: 1 }; }
        }
        flush();
      }
    }
  } else {
    // Marching squares: where a cell's edge crosses a band's top, the line between the bands crosses it too.
    bands.slice(0, -1).forEach((band, i) => {
      const t = band.to;
      let d = '';
      for (const { j, k, c: [a, b, c, e] } of cells) {
        const corners = [[X(k), Y(j), a], [X(k + 1), Y(j), b], [X(k + 1), Y(j + 1), e], [X(k), Y(j + 1), c]];
        const hits = [];
        corners.forEach((p0, q) => {
          const p1 = corners[(q + 1) % 4];
          // Half open, so a corner exactly on the level counts once.
          if ((p0[2] >= t) !== (p1[2] >= t)) { const f = (t - p0[2]) / (p1[2] - p0[2]); hits.push([p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])]); }
        });
        for (let h = 0; h + 1 < hits.length; h += 2) d += `M${r2(hits[h][0])} ${r2(hits[h][1])}L${r2(hits[h + 1][0])} ${r2(hits[h + 1][1])}`;
      }
      if (d) svg += el('path', { d, fill: 'none', stroke: bands[i + 1].color, 'stroke-width': 1.25, 'data-band': i });
    });
  }
  const look = { stroke: GRID, 'stroke-width': 0.75 };
  svg += el('line', { x1: plot.x, y1: plot.y + plot.h, x2: plot.x + plot.w, y2: plot.y + plot.h, ...look }) + el('line', { x1: plot.x, y1: plot.y, x2: plot.x, y2: plot.y + plot.h, ...look });
  for (let k = 0; k < nx; k++) svg += label(X(k), plot.y + plot.h + size * 1.2, m.cats[k] ?? String(k + 1), size, { 'text-anchor': 'middle' });
  rows.forEach((s, j) => { svg += label(plot.x - 4, Y(j) + size * 0.35, s.name, size, { 'text-anchor': 'end' }); });
  return svg;
}

/** The roots of a treemap or sunburst series with each root's colour index. */
const rootsOf = (s) => treeOf(s.levels ?? [s.cats], s.vals).map((r, i) => [r, i]);

/** A treemap: each top-level branch a rectangle in its colour (largest first, squarified), its parts inside it; the parent's
 * name in a banner above them or over them (parentLabel), and each leaf's name in its corner where it fits. */
function treemap(m, box) {
  const p = m.plots[0];
  const s = p.series[0];
  if (!s) return '';
  const lab = s.labels ?? { cat: true };
  const size = 9;
  let svg = '';
  let leaves = 0;
  const fits = (t, rc, sz) => textW(t, sz) <= rc.w - 6 && sz * 1.3 <= rc.h;
  const draw = (node, rc, color, top) => {
    const parts = partsOf(node);
    if (!parts.length) {
      svg += el('rect', { x: rc.x, y: rc.y, width: Math.max(0, rc.w), height: Math.max(0, rc.h), fill: color, stroke: '#FFFFFF', 'stroke-width': 1, 'data-leaf': leaves++ });
      const lines = [lab.cat !== false && node.name, lab.val && fmtNum(node.value, s.fmt)].filter(Boolean);
      lines.forEach((t, i) => { if (fits(t, { ...rc, h: rc.h - i * size * 1.2 }, size)) svg += label(rc.x + 3, rc.y + size * (1.1 + i * 1.2), t, size, { fill: onFill(color) }); });
      return;
    }
    let inner = rc;
    const banner = top && p.parentLabel === 'banner';
    if (banner) {
      const bh = Math.min(rc.h / 3, size * 1.6);
      svg += el('rect', { x: rc.x, y: rc.y, width: rc.w, height: bh, fill: color, stroke: '#FFFFFF', 'stroke-width': 1 });
      if (fits(node.name, { ...rc, h: bh }, size)) svg += label(rc.x + 3, rc.y + bh / 2 + size * 0.35, node.name, size, { fill: onFill(color) });
      inner = { ...rc, y: rc.y + bh, h: rc.h - bh };
    }
    const sorted = [...parts].sort((a, b) => b.value - a.value);
    squarify(sorted.map((q) => q.value), inner).forEach((r, i) => draw(sorted[i], r, color, false));
    if (top && p.parentLabel === 'overlapping' && fits(node.name, rc, size * 1.2)) svg += label(rc.x + 3, rc.y + size * 1.3, node.name, size * 1.2, { fill: onFill(color), 'font-weight': 'bold' });
  };
  const roots = rootsOf(s).sort((a, b) => b[0].value - a[0].value);
  squarify(roots.map(([r]) => r.value), box).forEach((rc, i) => draw(roots[i][0], rc, col(s.colors?.[roots[i][1]], '#4472C4'), true));
  return svg;
}

/** A sunburst: the top level in the inner ring, clockwise from the top in data order, each level out in the next ring, every
 * segment in its top-level branch's colour. */
function sunburst(m, box) {
  const s = m.plots[0].series[0];
  if (!s) return '';
  const roots = rootsOf(s);
  const total = roots.reduce((a, [r]) => a + r.value, 0);
  if (!total) return '';
  const depthOf = (n) => (n.kids.length ? 1 + Math.max(...n.kids.map(depthOf)) : 1);
  const depth = Math.max(1, ...roots.map(([r]) => depthOf(r)));
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
  const R = Math.max(1, Math.min(box.w, box.h) / 2 - 2);
  const hole = R * 0.15;
  const ringW = (R - hole) / depth;
  const lab = s.labels ?? { cat: true };
  let svg = '';
  let n = 0;
  const draw = (list, sum, a0, span, d) => {
    let a = a0;
    for (const [node, color] of list) {
      const t = (span * node.value) / sum;
      const [r0, r1] = [hole + d * ringW, hole + (d + 1) * ringW];
      svg += el('path', { d: slicePath(cx, cy, r0, r1, a, t), fill: color, stroke: '#FFFFFF', 'stroke-width': 1, 'data-slice': n++, 'data-ring': d });
      const rm = (r0 + r1) / 2;
      if (lab.cat !== false && textW(node.name, 9) < Math.min(t * rm, ringW * 2.2) && ringW > 11) svg += label(cx + rm * Math.sin(a + t / 2), cy - rm * Math.cos(a + t / 2) + 3, node.name, 9, { 'text-anchor': 'middle', fill: onFill(color) });
      const parts = partsOf(node);
      if (parts.length) draw(parts.map((q) => [q, color]), node.value, a, t, d + 1);
      a += t;
    }
  };
  draw(roots.map(([r, i]) => [r, col(s.colors?.[i], '#4472C4')]), total, 0, TAU, 0);
  return svg;
}

/** The types that are round (drawn alone, or left out of a combination with bars or lines). */
export const ROUND = new Set(['pie', 'doughnut', 'ofPie']);
/** The drawing of each type this file draws: (model, box) → SVG. */
export const PLOTS = { pie: round, doughnut: round, ofPie: round, radar, surface, treemap, sunburst };

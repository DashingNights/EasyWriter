// Chartex charts (cx:chartSpace: Office 2016's waterfall, funnel, histogram, Pareto, box and whisker, treemap, sunburst and map)
// read into the chart model of model.mjs, from the cached data in cx:chartData (cx:strDim and cx:numDim levels, the points as
// text). The bar-like types become the plots svg.mjs already draws on two axes: a waterfall a column plot whose bars float
// (`spans`), a funnel a bar plot centred on zero, a histogram a column plot of its bins, a Pareto that plus a cumulative percent
// line on a secondary axis, a box and whisker a 'box' plot of each category's statistics. A treemap and a sunburst keep their
// category levels for plots.mjs. A map needs the region shapes Office caches in its own binary form, so it stays a framed box
// (`other`). Pure: imports only its siblings.
import { at, autoColor, deep, fillOf, kid, kids, lineOf, num, sizeOf, textOf } from './read.mjs';
import { bins, boxStats, treeOf, waterfall } from './stats.mjs';

const TYPES = { waterfall: 'waterfall', funnel: 'funnel', clusteredColumn: 'histogram', paretoLine: 'histogram', boxWhisker: 'box', sunburst: 'sunburst',
  treemap: 'treemap' };
const NAMES = { regionMap: 'Map' };

const flag = (n, a) => (at(n, a) == null ? null : at(n, a) === '1' || at(n, a) === 'true');
const numAt = (n, a) => (at(n, a) === 'auto' ? null : num(at(n, a)));
/** The points of a cx:lvl → [string | null]. */
const ptsOf = (lvl) => {
  const out = Array.from({ length: num(at(lvl, 'ptCount')) ?? 0 }, () => null);
  for (const p of kids(lvl, 'cx:pt')) {
    const i = num(at(p, 'idx'));
    if (i != null && i < out.length) out[i] = textOf(p);
  }
  return out;
};
const txt = (n) => {
  const tx = kid(n, 'cx:tx');
  return deep(tx, 'cx:v').map(textOf).join(' ') || deep(tx, 'a:t').map(textOf).join('') || null;
};

/** A cx:series with its data → the series. */
function seriesOf(s, i, data, colors) {
  const d = data.get(at(kid(s, 'cx:dataId'), 'val'));
  const cat = kids(d, 'cx:strDim').find((x) => at(x, 'type') === 'cat') ?? kids(d, 'cx:numDim').find((x) => at(x, 'type') === 'cat');
  const valDim = kids(d, 'cx:numDim').find((x) => /^(val|size)$/.test(at(x, 'type') ?? 'val'));
  const lvl = kid(valDim, 'cx:lvl');
  // The levels of a category run from the innermost (beside the values) out, as c:multiLvlStrCache does.
  const levels = kids(cat, 'cx:lvl').map(ptsOf).reverse();
  const idx = num(at(s, 'formatIdx')) ?? i;
  const auto = autoColor(idx, colors);
  const fill = fillOf(kid(s, 'cx:spPr'), colors, auto);
  const colorsAt = [];
  for (const p of kids(s, 'cx:dataPt')) {
    const k = num(at(p, 'idx'));
    const c = fillOf(kid(p, 'cx:spPr'), colors, auto);
    if (k != null && c && c !== 'none') colorsAt[k] = c;
  }
  const dl = kid(s, 'cx:dataLabels');
  const vis = kid(dl, 'cx:visibility');
  const nf = kid(dl, 'cx:numFmt');
  return {
    name: txt(s) ?? `Series ${idx + 1}`, layout: at(s, 'layoutId'), owner: num(at(s, 'ownerIdx')), color: fill && fill !== 'none' ? fill : auto,
    line: lineOf(kid(s, 'cx:spPr'), colors, auto), colors: colorsAt, levels, cats: (levels.at(-1) ?? []).map((c) => c ?? ''),
    vals: ptsOf(lvl).map(num), fmt: (nf && at(nf, 'sourceLinked') !== '1' ? at(nf, 'formatCode') : null) ?? at(lvl, 'formatCode'),
    labels: dl ? { val: flag(vis, 'value'), cat: flag(vis, 'categoryName'), ser: flag(vis, 'seriesName'), pos: at(dl, 'pos') } : null, lp: kid(s, 'cx:layoutPr'),
  };
}

/** A cx:axis → the axis (catScaling makes it the category axis). */
function axisOf(a, colors) {
  const vs = kid(a, 'cx:valScaling');
  const cs = kid(a, 'cx:catScaling');
  const nf = kid(a, 'cx:numFmt');
  const t = kid(a, 'cx:title');
  return {
    cat: !!cs, show: at(a, 'hidden') !== '1', title: t ? txt(t) ?? 'Axis Title' : null, titleSize: sizeOf(t, 10), grid: !!kid(a, 'cx:majorGridlines'),
    gridColor: lineOf(kid(kid(a, 'cx:majorGridlines'), 'cx:spPr'), colors)?.color ?? null, lineColor: lineOf(kid(a, 'cx:spPr'), colors)?.color ?? null,
    labels: !!kid(a, 'cx:tickLabels'), min: numAt(vs, 'min'), max: numAt(vs, 'max'), unit: numAt(vs, 'majorUnit'), gap: numAt(cs, 'gapWidth'),
    fmt: nf && at(nf, 'sourceLinked') !== '1' ? at(nf, 'formatCode') : null, size: sizeOf(kid(a, 'cx:txPr'), 9),
  };
}

// Labels a series shows: what its cx:visibility says, else the type's own default.
const labelsOf = (s, def) => (s.labels ? { val: s.labels.val ?? def.val ?? false, cat: s.labels.cat ?? def.cat ?? false, ser: s.labels.ser ?? false, pos: s.labels.pos ?? def.pos ?? null } : null);
const bar = (s, extra) => ({ ...s, line: null, marker: null, smooth: false, xs: null, lp: undefined, levels: undefined, ...extra });

/** The plots, axes and legend entries of a chart of `type` from its `series`. */
function plotsOf(type, series, axes, colors) {
  const x = axes.find((a) => a.cat) ?? { show: false };
  const [y, y2] = axes.filter((a) => !a.cat);
  const gap = (def) => (x.gap ?? def) * 100;
  const s = series[0];
  if (!s) return { plots: [{ type: type === 'histogram' || type === 'waterfall' || type === 'funnel' ? 'bar' : type, ax: 0, series: [] }], x, y: y ?? { show: false } };
  const lp = s.lp;
  if (type === 'waterfall') {
    const spans = waterfall(s.vals, kids(kid(lp, 'cx:subtotals'), 'cx:idx').map((e) => num(at(e, 'val'))));
    // Increase, Decrease and Total take the first three automatic colours, unless a point names its own.
    const kind = { up: autoColor(0, colors), down: autoColor(1, colors), total: autoColor(2, colors) };
    return {
      plots: [{ type: 'bar', ax: 0, dir: 'col', grouping: 'clustered', gap: gap(0.5), overlap: 0, connect: at(kid(lp, 'cx:visibility'), 'connectorLines') !== '0',
        series: [bar(s, { spans, colors: spans.map((sp, k) => s.colors[k] ?? (sp ? kind[sp.kind] : null)), labels: labelsOf(s, { val: true }) })] }],
      x, y: y ?? { show: false }, legendItems: [['Increase', kind.up], ['Decrease', kind.down], ['Total', kind.total]].map(([text, color]) => ({ text, color })),
    };
  }
  if (type === 'funnel') {
    // A funnel lists its first category at the top, each bar centred, with no value axis.
    return {
      plots: [{ type: 'bar', ax: 0, dir: 'bar', grouping: 'clustered', gap: gap(0.06), overlap: 0,
        series: [bar(s, { spans: s.vals.map((v) => (v == null ? null : { from: -Math.abs(v) / 2, to: Math.abs(v) / 2 })), labels: labelsOf(s, { val: true, pos: 'ctr' }) })] }],
      x: { ...x, reverse: true, lineColor: 'none' }, y: { show: false, grid: false },
    };
  }
  if (type === 'histogram') {
    const main = series.find((q) => q.layout === 'clusteredColumn') ?? s;
    const pareto = series.find((q) => q.layout === 'paretoLine');
    const b = kid(main.lp, 'cx:binning');
    let cats;
    let counts;
    if (kid(main.lp, 'cx:aggregation')) { // a column per category, the sum of its values
      const sums = new Map();
      main.cats.forEach((c, k) => sums.set(c, (sums.get(c) ?? 0) + (main.vals[k] ?? 0)));
      [cats, counts] = [[...sums.keys()], [...sums.values()]];
    } else {
      const list = bins(main.vals, { closed: at(b, 'intervalClosed') ?? 'r', under: numAt(b, 'underflow'), over: numAt(b, 'overflow'),
        size: num(at(kid(b, 'cx:binSize'), 'val')), count: num(at(kid(b, 'cx:binCount'), 'val')) });
      [cats, counts] = [list.map((e) => e.label), list.map((e) => e.n)];
    }
    const plots = [{ type: 'bar', ax: 0, dir: 'col', grouping: 'clustered', gap: gap(pareto ? 0.5 : 0), overlap: 0,
      series: [bar(main, { vals: counts, cats, fmt: 'General', colors: [], labels: labelsOf(main, { val: true }) })] }];
    if (!pareto) return { plots, x, y: y ?? { show: false }, cats };
    // Pareto: the columns from the largest down, and the running share of the total on the secondary axis.
    const order = counts.map((_, k) => k).sort((a, c) => counts[c] - counts[a]);
    const total = counts.reduce((a, c) => a + c, 0) || 1;
    let run = 0;
    plots[0].series[0] = { ...plots[0].series[0], vals: order.map((k) => counts[k]) };
    plots.push({ type: 'line', ax: 1, grouping: 'standard', series: [{ ...bar(pareto), vals: order.map((k) => (run += counts[k]) / total), fmt: '0%', cats: [],
      line: { color: pareto.line?.color && pareto.line.color !== 'none' ? pareto.line.color : pareto.color, width: pareto.line?.width ?? 2.25 }, labels: null }] });
    return { plots, x, y: y ?? { show: false }, y2: { ...(y2 ?? { show: true, labels: true }), min: 0, max: 1, fmt: '0%' }, x2: { show: false }, cats: order.map((k) => cats[k]) };
  }
  if (type === 'box') {
    // One box per category and series; each category's values are the points that name it.
    const cats = [...new Set(series.flatMap((q) => (q.cats.length ? q.cats : [''])))];
    const plot = { type: 'box', ax: 0, gap: gap(1), series: series.map((q) => {
      const v = kid(q.lp, 'cx:visibility');
      const show = (a, def) => flag(v, a) ?? def;
      const method = at(kid(q.lp, 'cx:statistics'), 'quartileMethod') ?? 'exclusive';
      return bar(q, { boxes: cats.map((c) => boxStats(q.vals.filter((_, k) => (q.cats[k] ?? '') === c || !q.cats.length), method)),
        mean: show('meanMarker', true), meanLine: show('meanLine', false), inner: show('nonoutliers', false), outliers: show('outliers', true), labels: labelsOf(q, {}) });
    }) };
    return { plots: [plot], x, y: y ?? { show: true, grid: true }, cats };
  }
  // Treemap and sunburst: each top-level branch takes the next automatic colour, and the legend lists the branches.
  const roots = treeOf(s.levels, s.vals);
  const branch = roots.map((_, i) => autoColor(i, colors));
  return {
    plots: [{ type, ax: 0, parentLabel: at(kid(lp, 'cx:parentLabelLayout'), 'val') ?? 'overlapping',
      series: [{ ...bar(s, { colors: branch, labels: labelsOf(s, { cat: true }) }), levels: s.levels }] }],
    x: { show: false }, y: { show: false }, legendItems: roots.map((r, i) => ({ text: r.name, color: branch[i] })),
  };
}

/** The chartex chart in `root` (cx:chartSpace) under `theme` → the chart model, or a framed box for a map or an unknown layout. */
export function cxModel(root, theme = {}) {
  const colors = theme.colors ?? {};
  const chart = kid(root, 'cx:chart');
  const pa = kid(chart, 'cx:plotArea');
  const data = new Map(kids(kid(root, 'cx:chartData'), 'cx:data').map((d) => [at(d, 'id'), d]));
  const els = kids(kid(pa, 'cx:plotAreaRegion'), 'cx:series');
  const layout = at(els[0], 'layoutId');
  const type = TYPES[layout];
  const series = type ? els.filter((e) => at(e, 'hidden') !== '1').map((e, i) => seriesOf(e, i, data, colors)) : [];
  const t = kid(chart, 'cx:title');
  // A cx:title without text is the automatic title, as in a c: chart.
  const text = t ? txt(t) ?? (series.length === 1 ? series[0].name : 'Chart Title') : null;
  const lg = kid(chart, 'cx:legend');
  const sp = kid(root, 'cx:spPr');
  const base = { font: theme.fonts?.minor ?? null, size: sizeOf(kid(root, 'cx:txPr'), 10), title: text ? { text, size: sizeOf(t, 14) } : null,
    legend: lg && at(lg, 'hidden') !== '1' ? { pos: at(lg, 'pos') ?? 'r', size: sizeOf(kid(lg, 'cx:txPr'), 9), hide: [] } : null, legendItems: null,
    area: { fill: fillOf(sp, colors) ?? '#FFFFFF', line: lineOf(sp, colors)?.color ?? (sp ? 'none' : '#D9D9D9') }, x2: null, y2: null };
  if (!type) return { ...base, other: NAMES[layout] ?? 'Office', plots: [], cats: [], x: { show: false }, y: { show: false } };
  const out = plotsOf(type, series, kids(pa, 'cx:axis').map((a) => axisOf(a, colors)), colors);
  return { ...base, other: null, cats: out.cats ?? series[0]?.cats ?? [], catFmt: null, ...out };
}

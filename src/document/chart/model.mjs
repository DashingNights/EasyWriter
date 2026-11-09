// Charts in Word files (docs/plans/word/left-out.md, package 4): a chart part (c:chartSpace) or a chartex part (cx:chartSpace, read
// by cx.mjs) read into a plain model that chart/svg.mjs draws. Pure: it takes the element tree of import.mjs's parseXml
// ({name, attrs, kids}) and the Document's theme, and reads only the cached data (c:strCache, c:numCache, c:numLit), as Word
// shows a chart without opening its workbook. Imports only its sibling modules.
//
// Model: {title: {text, size} | null, legend: {pos: 'r'|'l'|'t'|'b'|'tr', size, hide: [entry index]} | null, legendItems: null |
// [{text, color}] (entries the plots do not give: a contour chart's bands, a waterfall's kinds, a treemap's branches), font, size,
// area: {fill, line}, d3 (a 3-D chart, drawn flat), plots, x and y axes (the primary pair: {title, show, grid, gridColor,
// lineColor, min, max, unit, fmt, reverse, labels, size, pos, between}), x2 and y2 (the secondary pair, or null), cats: [string],
// other: null | type label (a type it does not draw: a framed box with the title)}.
// Plot: {type: 'bar'|'line'|'area'|'pie'|'doughnut'|'ofPie'|'scatter'|'bubble'|'radar'|'stock'|'surface' (chartex adds
// 'box', 'treemap', 'sunburst'), ax: 0 | 1 (the axis pair it is drawn on), dir: 'col'|'bar', grouping: 'clustered'|'stacked'|
// 'percentStacked'|'standard', gap, overlap, hole, first, vary, series, and per type: style (radar), scale and sizeBy (bubble),
// hiLow and upDown (stock), wire and bands (surface), of, split, second and serLines (ofPie)}. Series: {name, color, line: {color,
// width} | null, marker: {symbol, size, fill, line} | null, smooth, labels: {val, pct, cat, ser, pos} | false | null,
// vals: [number | null], xs: [number] | null, sizes (bubble), fmt, colors: [string | null], trends (when it has trendlines):
// [{type, order, period, forward, backward, intercept, eq, r2, name, line: {color, width, dash} | null, fmt, size}]}.
import { at, autoColor, cached, fillOf, kid, kids, labelsOf, lineOf, num, on, richText, sizeOf, textOf, val } from './read.mjs';
import { cxModel } from './cx.mjs';
import { fmtNum, niceScale, ticksOf } from './kit.mjs';

export { autoColor, modColor } from './read.mjs';

const TYPES = { 'c:barChart': 'bar', 'c:bar3DChart': 'bar', 'c:lineChart': 'line', 'c:line3DChart': 'line', 'c:areaChart': 'area', 'c:area3DChart': 'area',
  'c:pieChart': 'pie', 'c:pie3DChart': 'pie', 'c:doughnutChart': 'doughnut', 'c:ofPieChart': 'ofPie', 'c:scatterChart': 'scatter', 'c:bubbleChart': 'bubble',
  'c:radarChart': 'radar', 'c:stockChart': 'stock', 'c:surfaceChart': 'surface', 'c:surface3DChart': 'surface' };
const AXES = ['c:catAx', 'c:valAx', 'c:dateAx', 'c:serAx'];

/** A c:trendline of a series drawn in `color` → the trendline. */
function trendOf(t, colors, color) {
  const lbl = kid(t, 'c:trendlineLbl');
  const nf = kid(lbl, 'c:numFmt');
  const ln = lineOf(kid(t, 'c:spPr'), colors, color);
  return {
    type: val(t, 'c:trendlineType') ?? 'linear', order: num(val(t, 'c:order')) ?? 2, period: num(val(t, 'c:period')) ?? 2,
    forward: num(val(t, 'c:forward')) ?? 0, backward: num(val(t, 'c:backward')) ?? 0, intercept: num(val(t, 'c:intercept')),
    eq: on(t, 'c:dispEq'), r2: on(t, 'c:dispRSqr'), name: kid(t, 'c:name') ? textOf(kid(t, 'c:name')) : null,
    // No line given is Office's automatic trendline, a dotted line in the series colour.
    line: ln?.color === 'none' ? null : { color: ln?.color ?? color, width: ln?.width ?? 1.5, dash: ln ? ln.dash : 'sysDot' },
    fmt: nf && at(nf, 'sourceLinked') !== '1' ? at(nf, 'formatCode') : null, size: sizeOf(kid(lbl, 'c:txPr'), 9),
  };
}

/** One c:ser of a plot of `type` → a series; `i` its place among every series of the chart (the automatic colour). */
function seriesOf(s, type, plot, i, colors) {
  const idx = num(val(s, 'c:idx')) ?? i;
  const auto = autoColor(idx, colors);
  const sp = kid(s, 'c:spPr');
  const lined = type === 'line' || type === 'scatter' || type === 'stock' || (type === 'radar' && plot.style !== 'filled');
  const ln = lineOf(sp, colors, auto);
  const fill = fillOf(sp, colors, auto);
  const vals = cached(kid(s, 'c:val') ?? kid(s, 'c:yVal'));
  const xs = type === 'scatter' || type === 'bubble' ? cached(kid(s, 'c:xVal')) : null;
  const m = kid(s, 'c:marker');
  const symbol = val(m, 'c:symbol');
  // A line chart shows markers when the plot says so (c:marker) and the series names no 'none'; a scatter chart unless 'none';
  // a radar chart in its marker style.
  const marked = lined && symbol !== 'none' && (type === 'scatter' || !!m || plot.markers || (type === 'radar' && plot.style === 'marker'));
  const color = (lined ? (ln?.color && ln.color !== 'none' ? ln.color : null) : (fill && fill !== 'none' ? fill : null)) ?? auto;
  const mFill = fillOf(kid(m, 'c:spPr'), colors, auto);
  const colorsAt = [];
  for (const p of kids(s, 'c:dPt')) {
    const k = num(val(p, 'c:idx'));
    const c = fillOf(kid(p, 'c:spPr'), colors, autoColor(k ?? 0, colors));
    if (k != null && c) colorsAt[k] = c;
  }
  // Vary colors by point (a pie's slices): each point without its own colour takes the automatic colour of its place. A pie of
  // pie's Other slice is the point after the last (its c:dPt idx is the point count).
  if (plot.vary) for (let k = 0; k < vals.pts.length + (type === 'ofPie' ? 1 : 0); k++) colorsAt[k] ??= autoColor(k, colors);
  // A stock chart's series show no line unless they name one (Word writes a:noFill), as the high-low lines join them.
  const noLine = ln?.color === 'none' || plot.scatterStyle === 'marker' || plot.scatterStyle === 'none' || (type === 'stock' && !ln?.color);
  const trends = kids(s, 'c:trendline').map((t) => trendOf(t, colors, color));
  return {
    name: richText(kid(s, 'c:tx') ? s : null) ?? `Series ${idx + 1}`, color,
    line: lined && !noLine ? { color, width: ln?.width ?? 2.25 } : null,
    marker: marked ? { symbol: !symbol || symbol === 'auto' ? 'circle' : symbol, size: num(val(m, 'c:size')) ?? 5, fill: mFill && mFill !== 'none' ? mFill : color,
      line: lineOf(kid(m, 'c:spPr'), colors, auto)?.color ?? color } : null,
    smooth: on(s, 'c:smooth'), labels: labelsOf(kid(s, 'c:dLbls')) ?? plot.labels, fill,
    vals: vals.pts.map(num), fmt: vals.fmt, xs: xs?.numeric ? xs.pts.map(num) : null, cats: (xs && !xs.numeric ? xs : cached(kid(s, 'c:cat'))).pts.map((c) => c ?? ''),
    catFmt: cached(kid(s, 'c:cat')).fmt, colors: colorsAt,
    ...(type === 'bubble' && { sizes: cached(kid(s, 'c:bubbleSize')).pts.map(num) }), ...(trends.length && { trends }),
  };
}

/** A c:valAx or c:catAx → the axis. */
function axisOf(ax, colors) {
  if (!ax) return { show: false };
  const sc = kid(ax, 'c:scaling');
  const nf = kid(ax, 'c:numFmt');
  return {
    show: !on(ax, 'c:delete'), title: kid(ax, 'c:title') ? richText(kid(ax, 'c:title')) : null, titleSize: sizeOf(kid(ax, 'c:title'), 10),
    grid: !!kid(ax, 'c:majorGridlines'), gridColor: lineOf(kid(kid(ax, 'c:majorGridlines'), 'c:spPr'), colors)?.color ?? null,
    lineColor: lineOf(kid(ax, 'c:spPr'), colors)?.color ?? null, min: num(val(sc, 'c:min')), max: num(val(sc, 'c:max')), unit: num(val(ax, 'c:majorUnit')),
    fmt: nf && at(nf, 'sourceLinked') !== '1' ? at(nf, 'formatCode') : null, reverse: val(sc, 'c:orientation') === 'maxMin',
    labels: val(ax, 'c:tickLblPos') !== 'none', size: sizeOf(kid(ax, 'c:txPr'), 9), pos: val(ax, 'c:axPos'), between: val(ax, 'c:crossBetween'),
  };
}

/** The type's own settings of plot element `p`. */
function extrasOf(p, type, colors) {
  if (type === 'bubble') return { scale: num(val(p, 'c:bubbleScale')) ?? 100, sizeBy: val(p, 'c:sizeRepresents') ?? 'area', neg: on(p, 'c:showNegBubbles') };
  if (type === 'stock') {
    const hl = kid(p, 'c:hiLowLines');
    const ud = kid(p, 'c:upDownBars');
    const bar = (tag, def) => fillOf(kid(kid(ud, tag), 'c:spPr'), colors) ?? def;
    return {
      hiLow: hl ? { color: lineOf(kid(hl, 'c:spPr'), colors)?.color ?? '#404040', width: lineOf(kid(hl, 'c:spPr'), colors)?.width ?? 0.75 } : null,
      upDown: ud ? { gap: num(val(ud, 'c:gapWidth')) ?? 150, up: bar('c:upBars', '#FFFFFF'), down: bar('c:downBars', '#595959'),
        line: lineOf(kid(kid(ud, 'c:upBars'), 'c:spPr'), colors)?.color ?? '#595959' } : null,
    };
  }
  if (type === 'surface') {
    const fmts = kids(kid(p, 'c:bandFmts'), 'c:bandFmt').map((b) => [num(val(b, 'c:idx')), fillOf(kid(b, 'c:spPr'), colors)]);
    return { wire: on(p, 'c:wireframe'), bandFmts: Object.fromEntries(fmts.filter(([k, c]) => k != null && c && c !== 'none')) };
  }
  if (type === 'ofPie') {
    return { of: val(p, 'c:ofPieType') ?? 'pie', split: { type: val(p, 'c:splitType') ?? 'auto', pos: num(val(p, 'c:splitPos')),
      cust: kids(kid(p, 'c:custSplit'), 'c:secondPiePt').map((e) => num(at(e, 'val'))).filter((k) => k != null) },
    second: num(val(p, 'c:secondPieSize')) ?? 75, serLines: kid(p, 'c:serLines') ? lineOf(kid(kid(p, 'c:serLines'), 'c:spPr'), colors)?.color ?? '#595959' : null };
  }
  if (type === 'radar') return { style: val(p, 'c:radarStyle') ?? 'marker' };
  return {};
}

/** The bands of contour plot `p` on value axis `y`: one per major unit, its colour the c:bandFmt of its place or the automatic
 * colour → [{from, to, color, text}]. */
function bandsOf(p, y, colors) {
  const all = p.series.flatMap((s) => s.vals).filter((v) => v != null);
  const ticks = ticksOf(niceScale(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 1, y));
  const fmt = y.fmt ?? p.series[0]?.fmt ?? 'General';
  return ticks.slice(1).map((to, i) => ({ from: ticks[i], to, color: p.bandFmts[i] ?? autoColor(i, colors), text: `${fmtNum(ticks[i], fmt)}-${fmtNum(to, fmt)}` }));
}

/**
 * The chart in part `root` (the c:chartSpace or cx:chartSpace element) under `theme` ({colors, fonts}) → the model. A chart of a
 * type this does not draw keeps its title and its type's name in `other`.
 */
export function chartModel(root, theme = {}) {
  if (root?.name === 'cx:chartSpace') return cxModel(root, theme);
  const colors = theme.colors ?? {};
  const font = theme.fonts?.minor ?? null;
  const chart = kid(root, 'c:chart');
  const pa = kid(chart, 'c:plotArea');
  const base = sizeOf(kid(root, 'c:txPr'), 10);
  const plotEls = kids(pa).filter((k) => TYPES[k.name]);
  const other = plotEls.length ? null : 'Unknown';
  let count = 0;
  const plots = plotEls.map((p) => {
    const type = TYPES[p.name];
    const plot = { type, dir: val(p, 'c:barDir') ?? 'col', grouping: val(p, 'c:grouping') ?? (type === 'bar' ? 'clustered' : 'standard'),
      gap: num(val(p, 'c:gapWidth')) ?? 150, overlap: num(val(p, 'c:overlap')), hole: num(val(p, 'c:holeSize')) ?? 50, first: num(val(p, 'c:firstSliceAng')) ?? 0,
      vary: on(p, 'c:varyColors', type === 'pie' || type === 'doughnut' || type === 'ofPie'), markers: on(p, 'c:marker'), scatterStyle: val(p, 'c:scatterStyle'),
      labels: labelsOf(kid(p, 'c:dLbls')) || null, axIds: kids(p, 'c:axId').map((a) => at(a, 'val')), ...extrasOf(p, type, colors),
      ...((/3D/.test(p.name) || on(p, 'c:bubble3D')) && { d3: true }) };
    plot.series = kids(p, 'c:ser').map((s) => seriesOf(s, type, plot, count++, colors));
    plot.overlap ??= plot.grouping === 'clustered' || plot.grouping === 'standard' ? 0 : 100;
    return plot;
  });
  // The axis pairs in plot order: the first plot's pair is the primary one, any other the secondary (a combination chart's line
  // on its own scale). A 3-D chart's third axis is its series axis.
  const axEls = new Map(kids(pa).filter((k) => AXES.includes(k.name)).map((a) => [val(a, 'c:axId'), a]));
  const pairs = [];
  for (const p of plots) {
    let ids = p.axIds.slice(0, 2);
    if (ids.length < 2) { p.ax = 0; continue; }
    // The category (or X) axis first: Word writes it so, but a file may not.
    if (axEls.get(ids[0])?.name === 'c:valAx' && /^c:(catAx|dateAx)$/.test(axEls.get(ids[1])?.name ?? '')) ids = [ids[1], ids[0]];
    const key = ids.join();
    let k = pairs.findIndex((q) => q.join() === key);
    if (k < 0) k = pairs.push(ids) - 1;
    p.ax = Math.min(k, 1);
  }
  const [x, y] = (pairs[0] ?? []).map((id) => axisOf(axEls.get(id), colors));
  const [x2, y2] = pairs[1] ? pairs[1].map((id) => axisOf(axEls.get(id), colors)) : [null, null];
  const surf = plots.find((p) => p.type === 'surface');
  if (surf) surf.bands = bandsOf(surf, (surf.ax ? y2 : y) ?? {}, colors);
  const all = plots.flatMap((p) => p.series);
  const tEl = kid(chart, 'c:title');
  // A c:title without text is the automatic title: the series name of a one-series chart, else "Chart Title". Without c:title, a
  // one-series chart still shows its series name unless the automatic title was deleted.
  const titleText = tEl ? richText(tEl) ?? (all.length === 1 ? all[0].name : 'Chart Title')
    : all.length === 1 && !on(chart, 'c:autoTitleDeleted') && !other ? all[0].name : null;
  const lg = kid(chart, 'c:legend');
  const sp = kid(root, 'c:spPr');
  return {
    other, font, size: base, title: titleText ? { text: titleText, size: sizeOf(tEl, 14) } : null,
    legend: lg ? { pos: val(lg, 'c:legendPos') ?? 'r', size: sizeOf(kid(lg, 'c:txPr'), 9),
      hide: kids(lg, 'c:legendEntry').filter((e) => on(e, 'c:delete')).map((e) => num(val(e, 'c:idx'))) } : null,
    legendItems: surf ? surf.bands.map((b) => ({ text: b.text, color: b.color })) : null,
    area: { fill: fillOf(sp, colors) ?? '#FFFFFF', line: lineOf(sp, colors)?.color ?? (sp ? 'none' : '#D9D9D9') },
    ...(plots.some((p) => p.d3) && { d3: true }),
    plots, x: x ?? { show: false }, y: y ?? { show: false }, x2, y2, cats: all.find((s) => s.cats.length)?.cats ?? [], catFmt: all.find((s) => s.catFmt)?.catFmt ?? null,
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/document/docx/import.mjs';
import { autoColor, chartModel } from '../src/document/chart/model.mjs';
import { chartSvg } from '../src/document/chart/svg.mjs';
import { bins, boxStats, eqNum, equation, fitTrend, movingAvg, quartile, squarify, treeOf, waterfall } from '../src/document/chart/stats.mjs';
import { DATA, EXPECT, PARTS, samplesDoc } from './chart-types-samples.mjs';

// Work package charts (docs/plans/word/briefs/charts.md): secondary axes, trendlines with their equation and R², and the chart
// types beyond the common ones, each read from a small chart part in Word's form and drawn from its cached data.
const THEME = { colors: { accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47' } };
const model = (name) => chartModel(parseXml(PARTS[name]), THEME);
const count = (svg, attr) => (svg.match(new RegExp(`\\s${attr}="`, 'g')) ?? []).length;
const legendOf = (svg) => [...svg.matchAll(/data-legend="\d+">.*?<text[^>]*>([^<]*)<\/text><\/g>/g)].map((x) => x[1]);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test('every sample type draws its marks and legend, and only a map stays a framed box', () => {
  for (const [name, e] of Object.entries(EXPECT)) {
    const m = model(name);
    assert.equal(m.other, name === 'map' ? 'Map' : null, name);
    const svg = chartSvg(m, 360, 216);
    const n = count(svg, e.attr);
    if (e.n == null) assert.ok(n > 0, `${name} draws ${e.attr}`);
    else assert.equal(n, e.n, `${name}: ${e.attr}`);
    if (e.legend) assert.deepEqual(legendOf(svg), e.legend, `${name} legend`);
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/, name);
  }
});

test('radar, bubble and stock charts read their own settings', () => {
  const radar = model('radar');
  assert.deepEqual([radar.plots[0].type, radar.plots[0].style, radar.cats], ['radar', 'marker', DATA.skills.cats]);
  assert.ok(radar.plots[0].series.every((s) => s.marker && s.line), 'Radar with Markers: lines and markers');
  assert.equal(model('filledRadar').plots[0].series[0].line, null, 'a filled radar has no line');
  assert.match(chartSvg(radar, 360, 216), />Stamina</);

  const [bubble] = model('bubble').plots;
  assert.deepEqual([bubble.scale, bubble.sizeBy, bubble.series[0].xs, bubble.series[0].sizes], [100, 'area', DATA.bubble.series[0].xs, DATA.bubble.series[0].sizes]);
  // Area stands for size: the 40 bubble is twice the width of the 10 bubble.
  const radii = [...chartSvg(model('bubble'), 360, 216).matchAll(/<circle [^>]*r="([\d.]+)"[^>]*data-bubble="0:(\d)"/g)].map((x) => [+x[2], +x[1]]).sort((a, b) => a[0] - b[0]);
  near(radii[3][1] / radii[2][1], 2, 0.05);

  const stock = model('stock');
  const [p] = stock.plots;
  assert.deepEqual([p.type, !!p.hiLow, p.upDown.gap, p.upDown.up], ['stock', true, 150, '#FFFFFF']);
  assert.ok(p.series.every((s) => !s.line && !s.marker), 'stock series show neither line nor marker unless they name one');
  const svg = chartSvg(stock, 360, 216);
  assert.equal(count(svg, 'data-hilow'), 5);
  assert.deepEqual([...svg.matchAll(/data-updown="(\w+)"/g)].map((x) => x[1]), DATA.stock.series[0].vals.map((o, k) => (DATA.stock.series[3].vals[k] >= o ? 'up' : 'down')));
  assert.match(svg, />1\/1\/2024</, 'date categories in their format');
});

test('secondary axes: a plot on the second axis pair gets its own scale and labels on the right', () => {
  const m = model('combo');
  assert.deepEqual(m.plots.map((q) => [q.type, q.ax]), [['bar', 0], ['line', 1]]);
  assert.deepEqual([m.y2.fmt, m.y2.pos, m.x2.show, m.y.fmt], ['0%', 'r', false, null]);
  const svg = chartSvg(m, 360, 216);
  assert.match(svg, /text-anchor="start"[^>]*>25%</, 'the secondary labels sit right of the plot');
  assert.match(svg, /text-anchor="end"[^>]*>200</, 'the primary keeps its own scale');
  // The margin line reaches the plot's top for 21% (its axis tops at 25%), where it would hug the floor on the sales scale.
  const pts = [...svg.matchAll(/data-series="0" data-points="4"><path d="M([\d.]+) ([\d.]+)L[\d.]+ [\d.]+L[\d.]+ ([\d.]+)/g)][0];
  assert.ok(pts && +pts[3] < 80, `the line rides high: ${pts?.[3]}`);
  const vol = model('volumeStock');
  assert.deepEqual(vol.plots.map((q) => [q.type, q.ax]), [['bar', 0], ['stock', 1]]);
  assert.match(chartSvg(vol, 360, 216), /text-anchor="start"[^>]*>70</, 'the price axis on the right');
});

test('surface charts draw as contour bands, 3-D charts flat with a tooltip saying so', () => {
  const m = model('contour');
  const [p] = m.plots;
  assert.deepEqual(p.bands.map((b) => b.text), ['0-10', '10-20', '20-30', '30-40', '40-50', '50-60', '60-70']);
  assert.deepEqual(m.legendItems.map((e) => e.color), [0, 1, 2, 3, 4, 5, 6].map((i) => autoColor(i, THEME.colors)), 'automatic colours, as no c:bandFmt names one');
  assert.equal(model('wireContour').plots[0].wire, true);
  assert.ok(count(chartSvg(model('wireContour'), 360, 216), 'data-band') >= 5, 'a line between each pair of bands the data crosses');
  assert.equal(m.d3, undefined);
  assert.equal(model('surface3D').d3, true);
  assert.match(chartSvg(model('column3D'), 360, 216), /<title>This 3-D chart is shown flat.<\/title>/);
  assert.doesNotMatch(chartSvg(model('combo'), 360, 216), /<title>/);
});

test('pie of pie and bar of pie: the split, the Other slice and the second plot', () => {
  const pp = model('pieOfPie');
  assert.deepEqual([pp.plots[0].of, pp.plots[0].split.type, pp.plots[0].second], ['pie', 'auto', 75]);
  assert.equal(pp.plots[0].series[0].colors.length, 7, 'the Other slice has a colour of its own');
  const svg = chartSvg(pp, 360, 216);
  assert.equal(count(svg, 'data-slice'), 7);
  assert.match(svg, /data-slice="other"/);
  const bp = model('barOfPie');
  assert.deepEqual([bp.plots[0].of, bp.plots[0].split], ['bar', { type: 'val', pos: 10, cust: [] }]);
  // Values under 10 (8, 7, 5) go to the bar: three rects there.
  assert.equal(count(chartSvg(bp, 360, 216).replace(/<path[^>]*>/g, ''), 'data-slice'), 3);
});

test('trendlines: the fit, its equation and R² in Excel\'s form, and a legend entry each', () => {
  const m = model('trendScatter');
  const [lin, exp] = m.plots[0].series.map((s) => s.trends[0]);
  assert.deepEqual([lin.type, lin.eq, lin.r2, lin.line.dash, exp.type], ['linear', true, true, 'sysDot', 'exp']);
  const svg = chartSvg(m, 360, 216);
  assert.match(svg, /data-trend-label="">y = 2.02x - 0.02</);
  assert.match(svg, /data-trend-label="">y = 0.5382e<tspan baseline-shift="super" font-size="6.3">0.6795x<\/tspan>/);
  assert.match(svg, /data-trend-label="">R<tspan[^>]*>2<\/tspan> = 0.9982</);
  assert.match(svg, /stroke-dasharray="1.5 1.5"[^>]*data-trend="linear"/);
  assert.match(svg, /<svg x="[\d.]+" y="[\d.]+" width="[\d.]+" height="[\d.]+" viewBox="[\d. ]+" overflow="hidden"><path/, 'trendlines are clipped to the plot');
  const line = chartSvg(model('trendLine'), 360, 216);
  assert.deepEqual([...line.matchAll(/data-trend="(\w+)"/g)].map((x) => x[1]), ['movingAvg', 'poly']);
  assert.match(line, />y = 1.5179x<tspan[^>]*>2<\/tspan> \+ 6.6607x \+ 114.5</);
});

test('trendline maths: each type recovers an exact curve, R² and Excel\'s number form', () => {
  const xs = [1, 2, 3, 4, 5];
  const fit = (type, f, o = {}) => fitTrend({ type, ...o }, xs.map((x) => [x, f(x)]));
  const e = fit('exp', (x) => 2 * Math.exp(0.5 * x));
  near(Math.exp(e.coef[0]), 2);
  near(e.coef[1], 0.5);
  near(e.r2, 1);
  const pw = fit('power', (x) => 3 * x ** 2);
  near(Math.exp(pw.coef[0]), 3);
  near(pw.coef[1], 2);
  const lg = fit('log', (x) => 2 * Math.log(x) + 1);
  near(lg.coef[1], 2);
  near(lg.coef[0], 1);
  const poly = fit('poly', (x) => x * x - 2 * x + 3, { order: 2 });
  poly.coef.forEach((c, i) => near(c, [3, -2, 1][i]));
  assert.deepEqual(equation('poly', poly), [['y = 1x'], ['2', true], [' - 2x + 3']]);
  assert.deepEqual(equation('log', lg), [['y = 2ln(x) + 1']]);
  assert.deepEqual(equation('power', pw), [['y = 3x'], ['2', true]]);
  // A held intercept: zero shows no constant, and R² is taken about it.
  const held = fitTrend({ type: 'linear', intercept: 0 }, [[1, 2.2], [2, 3.9], [3, 6.1]]);
  assert.equal(held.coef[0], 0);
  assert.deepEqual(equation('linear', held), [['y = 2.0214x']]);
  assert.equal(fitTrend({ type: 'log' }, [[0, 1], [1, 2]]), null, 'a log fit needs x above zero, as in Excel');
  assert.deepEqual([0.025397, 1.666666, 12345.678, 0.00002, 3000000, -0.5].map(eqNum), ['0.0254', '1.6667', '12346', '2E-05', '3E+06', '-0.5']);
  assert.deepEqual(movingAvg([[1, 2], [2, 4], [3, 6]], 2), [[2, 3], [3, 5]]);
});

test('chartex: waterfall, funnel, histogram, Pareto and box and whisker become plots on two axes', () => {
  const wf = model('waterfall');
  const [s] = wf.plots[0].series;
  assert.deepEqual(s.spans.map((q) => q.kind), ['total', 'up', 'down', 'up', 'down', 'total']);
  assert.deepEqual(s.spans.map((q) => [q.from, q.to]), [[0, 100], [100, 120], [120, 105], [105, 135], [135, 125], [0, 125]]);
  assert.deepEqual(s.colors, ['#A5A5A5', '#4472C4', '#ED7D31', '#4472C4', '#ED7D31', '#A5A5A5']);
  assert.equal(count(chartSvg(wf, 360, 216), 'data-connector'), 5);
  assert.deepEqual(waterfall([100, 20, -15, 125], [0, 3]).map((q) => q.to), [100, 120, 105, 125]);

  const fn = model('funnel');
  assert.deepEqual([fn.plots[0].dir, fn.x.reverse, fn.y.show, fn.plots[0].series[0].spans[0]], ['bar', true, false, { from: -500, to: 500 }]);

  const hist = model('histogram');
  assert.deepEqual(hist.cats, ['[12, 36.19]', '(36.19, 60.38]', '(60.38, 84.57]', '(84.57, 108.76]']);
  assert.deepEqual(hist.plots[0].series[0].vals, [13, 10, 5, 2]);

  const pa = model('pareto');
  assert.deepEqual(pa.cats, ['Late', 'Damaged', 'Wrong item', 'Rude', 'Other']);
  assert.deepEqual(pa.plots[0].series[0].vals, [60, 18, 8, 3, 2]);
  assert.deepEqual(pa.plots[1].series[0].vals.map((v) => Math.round(v * 1000) / 1000), [0.659, 0.857, 0.945, 0.978, 1]);
  assert.deepEqual([pa.plots[1].ax, pa.y2.max, pa.y2.fmt], [1, 1, '0%']);
  assert.match(chartSvg(pa, 360, 216), />100%</);

  const box = model('box');
  assert.deepEqual(box.cats, ['East', 'West']);
  const east = box.plots[0].series[0].boxes[0];
  assert.deepEqual([east.q1, east.med, east.q3, east.lo, east.hi, east.out], [13.25, 15.5, 19.5, 12, 20, [45]]);
  assert.equal(count(chartSvg(box, 360, 216), 'data-point'), 1, 'one outlier ring');
});

test('statistics: bins, quartiles by both methods, the treemap hierarchy and its layout', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual([quartile(v, 0.25), quartile(v, 0.25, 'inclusive'), quartile(v, 0.5), quartile(v, 0.75)], [2.25, 2.75, 4.5, 6.75]);
  assert.deepEqual(boxStats([1, 2, 3, 4, 5, 6, 7, 100]).out, [100]);
  assert.deepEqual(bins([1, 2, 3, 4, 5, 6], { count: 3 }).map((b) => [b.label, b.n]), [['[1, 2.67]', 2], ['(2.67, 4.33]', 2], ['(4.33, 6]', 2]]);
  assert.deepEqual(bins([1, 5, 10, 15, 20, 25], { size: 5, under: 5, over: 20 }).map((b) => [b.label, b.n]), [['≤5', 2], ['(5, 10]', 1], ['(10, 15]', 1], ['(15, 20]', 1], ['>20', 1]]);
  assert.deepEqual(bins([1, 2, 3, 4], { count: 2, closed: 'l' }).map((b) => b.label), ['[1, 2.5)', '[2.5, 4]']);

  const roots = treeOf(DATA.tree.levels, DATA.tree.vals);
  assert.deepEqual(roots.map((r) => [r.name, r.value, r.kids.map((k) => k.name)]), [['Fruit', 55, ['Citrus', 'Apple']], ['Veg', 23, ['Root', 'Leaf']], ['Grain', 27, ['Rice', 'Wheat']]]);
  assert.deepEqual(roots[0].kids[0].kids.map((k) => k.name), ['Orange', 'Lemon'], 'an empty cell continues the group above');
  const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 6, h: 4 });
  near(rects.reduce((a, r) => a + r.w * r.h, 0), 24);
  assert.ok(rects.every((r) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 6 + 1e-9 && r.y + r.h <= 4 + 1e-9));
  near(rects[0].w * rects[0].h, 6);
  const tm = model('treemap');
  assert.deepEqual([tm.plots[0].parentLabel, tm.legendItems.map((e) => e.text)], ['banner', ['Fruit', 'Veg', 'Grain']]);
});

test('docx: a file with every type imports each as a drawn chart, leaves out only map drawings, fits the schema and exports its parts unchanged', async () => {
  const { importDocx } = await import('../src/document/docx/import.mjs');
  const { exportDocx } = await import('../src/document/docx/export.mjs');
  const { readZip } = await import('../src/document/docx/zip.mjs');
  const { kitOf } = await import('../src/editors.js');
  const first = await exportDocx(samplesDoc());
  assert.deepEqual(first.dropped, []);
  const { doc, dropped } = await importDocx(first.bytes);
  assert.deepEqual(dropped, ['drawings of map charts']);
  kitOf('document').schema.nodeFromJSON(doc).check();
  const charts = [];
  const walk = (n) => { if (n.type === 'chart') charts.push(n.attrs); (n.content ?? []).forEach(walk); };
  walk(doc);
  assert.deepEqual(charts.map((a) => a.alt), Object.keys(PARTS));
  for (const a of charts) {
    const e = EXPECT[a.alt];
    const n = count(chartSvg(a.model, a.w, a.h), e.attr);
    assert.ok(e.n == null ? n > 0 : n === e.n, `${a.alt} draws from the imported model`);
  }
  const out = await exportDocx(doc);
  const [a, b] = await Promise.all([readZip(first.bytes), readZip(out.bytes)]);
  for (const name of [...a.keys()].filter((k) => k.startsWith('word/charts/'))) assert.deepEqual(Buffer.from(b.get(name)), Buffer.from(a.get(name)), name);
});

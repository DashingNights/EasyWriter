// The Charts package's rows of the Documents engine table (ph-charts-1 and 2): Insert > Chart, the Chart Design tab on a canvas
// draft, and the Add Chart Element, Quick Layout, Change Colors and Chart Styles rows. Only this package edits this file;
// ph-charts-3 adds its rows here too. Rows by tooling id in the forms of forms.mjs; a chart row is on only while the selected
// chart has a model (chart.get's enabled and reason), so a chart from another program shows the engine's reason. Pure: node
// tests load it.
import { REASONS } from '../../../tooling/reasons.mjs';
import { MAX_EDIT_CELLS, cellCount, transpose } from '../charts/data.mjs';
import { PALETTES, axisOf, elementLook, elementsOf, isBars, isRound, isStacked, layoutSteps, lookOf, styleBox, styleSteps } from '../charts/look.mjs';
import { off } from './forms.mjs';
import { wordArtOf } from './objects.mjs';

/** Word's Add Chart Element menu, the parent of the rows below. */
const A = 'chartDesign.chart.addChartElement';

/** The selected chart's model as the engine holds it now, or null. */
const chartNow = async (ctx) => (await ctx.engine.query('chart.get', {}))?.value?.chart ?? null;
const ok = (r) => !!r?.ok;
const run1 = (ctx, id, args) => Promise.resolve(ctx.engine.exec(id, args)).then(ok, () => false);
/** Whether the selection is a chart the engine has a model for. The selection comes from the app's own context: the chart.get
 * reading stays behind while the contextual tab is hidden, so it alone would keep a row on in the text. */
const usable = (ctx) => ctx.obj?.kind === 'chart' && ctx.stateOf?.('chart.get')?.enabled === true;
/** Several engine steps as one undo step. */
const many = (ctx, steps) => Promise.resolve(ctx.engine.execMany(steps)).then(ok, () => false);

/** The selected chart's look, `{}` when it has none. */
const look = (ctx) => lookOf(ctx.read('chart.get', {})?.chart);
const typeOf = (ctx) => ctx.read('chart.get', {})?.chart?.type;
/** The look key of the axis Word's Horizontal ('h') or Vertical ('v') names: `noCatAxis`/`noValAxis`, `catTitle`/`valTitle`,
 * or `catGrid`/`noValGrid`. */
const axisKey = (ctx, which, kind) => {
  const ax = axisOf(typeOf(ctx), which);
  if (kind === 'title') return ax === 'cat' ? 'catTitle' : 'valTitle';
  if (kind === 'grid') return ax === 'cat' ? 'catGrid' : 'noValGrid';
  return ax === 'cat' ? 'noCatAxis' : 'noValAxis';
};
/** Whether the axis Word's Horizontal ('h') or Vertical ('v') names shows its gridlines. */
const gridOn = (ctx, which) => (axisOf(typeOf(ctx), which) === 'cat' ? !!look(ctx).catGrid : !look(ctx).noValGrid);

/** A row on the selected chart: off with the engine's reason on no chart or another program's chart. `also(ctx)`: a further
 * reason, or null; `active(ctx)`: whether the row's state shows; `value(ctx)`: the row's value as the control draws it. */
export const chartRow = (run, also = () => null, active, value) => ({
  run,
  enabled: (ctx) => !!ctx.engine && usable(ctx) && !also(ctx),
  reason: (ctx) => (usable(ctx) ? also(ctx) : ctx.stateOf?.('chart.get')?.reason ?? 'Select a chart first.'),
  reads: ['chart.get'],
  ...(active && { active }),
  ...(value && { value }),
});

/** A look key toggled from the chart as it is now: set to `on`, or cleared when it is set. */
const toggleLook = (keyOf, on) => async (ctx) => {
  const c = await chartNow(ctx);
  if (!c) return false;
  const key = keyOf(ctx);
  return many(ctx, [['chart.set', { look: { [key]: look(ctx)[key] ? null : on } }]]);
};
const roundOnly = (ctx) => (isRound(typeOf(ctx)) ? 'Pie and doughnut charts have no axes.' : null);
const barsOnly = (ctx) => (isBars(typeOf(ctx)) ? null : 'Not for this chart type.');
const outEndOnly = (ctx) => (isBars(typeOf(ctx)) && !isStacked(typeOf(ctx)) ? null : 'Not for this chart type.');

/** The legend set to `pos`, with its overlay when `overlay`. */
const setLegend = (pos, overlay) => async (ctx) => {
  const c = await chartNow(ctx);
  if (!c) return false;
  return many(ctx, [['chart.legend', { pos }], ['chart.set', { look: { legendOverlay: overlay } }]]);
};
const legendOn = (pos, overlay) => (ctx) => {
  const c = ctx.read('chart.get', {})?.chart;
  return !!c && (pos === 'none' ? !c.legend : c.legend === pos && !!look(ctx).legendOverlay === overlay);
};

/** The chart title on (`overlay` over the plot) or off. */
const setTitle = (on, overlay) => async (ctx) => {
  const c = await chartNow(ctx);
  if (!c) return false;
  return many(ctx, [['chart.title', { text: on ? (c.title ?? 'Chart Title') : null }], ['chart.set', { look: { titleOverlay: overlay } }]]);
};

/** Data labels on at `pos`, or off for null. */
const setLabels = (pos) => async (ctx) => {
  const c = await chartNow(ctx);
  if (!c) return false;
  return many(ctx, [['chart.dataLabels', { on: !!pos }], ['chart.set', { look: { labelPos: pos } }]]);
};
const labelsAt = (pos) => (ctx) => {
  const c = ctx.read('chart.get', {})?.chart;
  if (!c) return false;
  return pos ? c.dataLabels === true && look(ctx).labelPos === pos : !c.dataLabels;
};

/** Whether the chart's data is too big for a data dialog: says so and refuses. */
const tooBig = (ctx, chart) => {
  if (cellCount(chart) <= MAX_EDIT_CELLS) return false;
  ctx.toast?.('This chart has too many values to edit here.');
  return true;
};

/** The chart's data sheet, then one chart.editData step; a chart too big for the sheet says so and stays as it is. */
export const openData = async (ctx, chart) => {
  if (!chart || tooBig(ctx, chart)) return false;
  const r = await ctx.dialog('chartData', { chart });
  return r ? run1(ctx, 'chart.editData', { data: r }) : false;
};

/** The picked element of Current Selection, by the chart it was picked on: a different chart starts on Chart Area, and an
 * element gone from the chart falls back to it. Not stored in the file. */
let picked = { at: null, el: 'area' };
const here = (ctx) => JSON.stringify(ctx.obj?.pos ?? null);
export const elementOf = (ctx) => {
  if (picked.at !== here(ctx)) return 'area';
  const c = ctx.read('chart.get', {})?.chart;
  return c && !elementsOf(c).some((e) => e.id === picked.el) ? 'area' : picked.el;
};

export const CHARTS = {
  'insert.illustrations.chart': {
    enabled: (ctx) => !!ctx.engine,
    run: async (ctx) => {
      const r = await ctx.dialog('insertChart', {});
      if (!r) return false;
      const res = await ctx.engine.exec('insert.chart', { type: r.type });
      if (!ok(res)) return false;
      // Word opens its data sheet on the new chart; cancelling it keeps the sample data.
      await openData(ctx, res.value.chart);
      return true;
    },
  },
  'chartDesign.chart.changeChartType': chartRow(async (ctx) => {
    const c = await chartNow(ctx);
    if (!c) return false;
    const r = await ctx.dialog('changeChartType', { type: c.type });
    if (!r || r.type === c.type) return false;
    return run1(ctx, 'chart.type', { type: r.type });
  }),
  'chartDesign.chart.switchRowColumn': chartRow(
    async (ctx) => {
      const c = await chartNow(ctx);
      return c ? run1(ctx, 'chart.editData', { data: transpose(c) }) : false;
    },
    (ctx) => (ctx.read('chart.get')?.chart?.type === 'scatter' ? 'Scatter charts keep their x values in the first column.' : null),
  ),
  'chartDesign.chart.editData': chartRow(async (ctx) => openData(ctx, await chartNow(ctx))),
  'chartDesign.chart.selectData': chartRow(async (ctx) => {
    const c = await chartNow(ctx);
    if (!c || tooBig(ctx, c)) return false;
    const r = await ctx.dialog('selectDataSource', { chart: c });
    return r ? run1(ctx, 'chart.editData', { data: r }) : false;
  }),

  // ---- Add Chart Element, Quick Layout, Change Colors and Chart Styles (ph-charts-2)
  [A]: chartRow(() => true),
  [`${A}.axes.primaryHorizontal`]: chartRow(toggleLook((ctx) => axisKey(ctx, 'h', 'axis'), true), roundOnly,
    (ctx) => !look(ctx)[axisKey(ctx, 'h', 'axis')]),
  [`${A}.axes.primaryVertical`]: chartRow(toggleLook((ctx) => axisKey(ctx, 'v', 'axis'), true), roundOnly,
    (ctx) => !look(ctx)[axisKey(ctx, 'v', 'axis')]),
  [`${A}.axisTitles.primaryHorizontal`]: chartRow(toggleLook((ctx) => axisKey(ctx, 'h', 'title'), 'Axis Title'), roundOnly,
    (ctx) => !!look(ctx)[axisKey(ctx, 'h', 'title')]),
  [`${A}.axisTitles.primaryVertical`]: chartRow(toggleLook((ctx) => axisKey(ctx, 'v', 'title'), 'Axis Title'), roundOnly,
    (ctx) => !!look(ctx)[axisKey(ctx, 'v', 'title')]),
  [`${A}.axisTitles.moreAxisTitleOptions`]: chartRow((ctx) => axisTitleText(ctx), (ctx) =>
    (roundOnly(ctx) ?? (look(ctx).catTitle || look(ctx).valTitle ? null : 'Turn on an axis title first.'))),
  [`${A}.chartTitle.none`]: chartRow(setTitle(false, null), undefined, (ctx) => !ctx.read('chart.get', {})?.chart?.title),
  [`${A}.chartTitle.aboveChart`]: chartRow(setTitle(true, null), undefined,
    (ctx) => !!ctx.read('chart.get', {})?.chart?.title && !look(ctx).titleOverlay),
  [`${A}.chartTitle.centeredOverlay`]: chartRow(setTitle(true, true), undefined,
    (ctx) => !!ctx.read('chart.get', {})?.chart?.title && !!look(ctx).titleOverlay),
  [`${A}.chartTitle.moreTitleOptions`]: chartRow((ctx) => chartTitleText(ctx),
    (ctx) => (ctx.read('chart.get', {})?.chart?.title ? null : 'Turn on the chart title first.')),
  [`${A}.dataLabels.none`]: chartRow(setLabels(null), undefined, labelsAt(null)),
  [`${A}.dataLabels.center`]: chartRow(setLabels('ctr'), undefined, labelsAt('ctr')),
  [`${A}.dataLabels.insideEnd`]: chartRow(setLabels('inEnd'), barsOnly, labelsAt('inEnd')),
  [`${A}.dataLabels.insideBase`]: chartRow(setLabels('inBase'), barsOnly, labelsAt('inBase')),
  [`${A}.dataLabels.outsideEnd`]: chartRow(setLabels('outEnd'), outEndOnly, labelsAt('outEnd')),
  [`${A}.gridlines.primaryMajorHorizontal`]: chartRow(toggleLook((ctx) => axisKey(ctx, 'v', 'grid'), true), roundOnly, (ctx) => gridOn(ctx, 'v')),
  [`${A}.gridlines.primaryMajorVertical`]: chartRow(toggleLook((ctx) => axisKey(ctx, 'h', 'grid'), true), roundOnly, (ctx) => gridOn(ctx, 'h')),
  [`${A}.legend.none`]: chartRow(setLegend('none', null), undefined, legendOn('none', null)),
  [`${A}.legend.right`]: chartRow(setLegend('right', null), undefined, legendOn('right', false)),
  [`${A}.legend.top`]: chartRow(setLegend('top', null), undefined, legendOn('top', false)),
  [`${A}.legend.left`]: chartRow(setLegend('left', null), undefined, legendOn('left', false)),
  [`${A}.legend.bottom`]: chartRow(setLegend('bottom', null), undefined, legendOn('bottom', false)),
  [`${A}.legend.rightOverlay`]: chartRow(setLegend('right', true), undefined, legendOn('right', true)),
  [`${A}.legend.leftOverlay`]: chartRow(setLegend('left', true), undefined, legendOn('left', true)),
  [`${A}.dataTable`]: off(REASONS.pending),
  [`${A}.errorBars`]: off(REASONS.pending),
  [`${A}.lines`]: off(REASONS.pending),
  [`${A}.trendline`]: off(REASONS.pending),
  [`${A}.upDownBars`]: off(REASONS.pending),
  'chartDesign.chart.quickLayout': chartRow(async (ctx, id) => {
    const c = await chartNow(ctx);
    const steps = c && id && layoutSteps(c, id);
    return !!steps && many(ctx, steps);
  }),
  'chartDesign.chart.chartStyles': chartRow(async (ctx, id) => {
    const c = await chartNow(ctx);
    const steps = c && id && styleSteps(id);
    return !!steps && many(ctx, steps);
  }),
  'chartDesign.chart.changeColors': chartRow(async (ctx, id) => {
    const p = PALETTES.find((x) => x.id === id);
    return !!p && many(ctx, [['chart.set', { look: { colors: p.colors } }]]);
  }),

  // ---- the Format tab (ph-charts-3)
  'chartFormat.chart.currentSelection': chartRow(async (ctx, arg) => {
    const e = elementsOf(await chartNow(ctx)).find((x) => x.id === arg || x.label === arg);
    if (!e) return false;
    picked = { at: here(ctx), el: e.id };
    return true;
  }, undefined, undefined, elementOf),
  'chartFormat.chart.shapeStyles': chartRow(async (ctx, id) => {
    const box = styleBox(id);
    if (!box) return false;
    const c = await chartNow(ctx);
    return !!c && run1(ctx, 'chart.set', elementLook(lookOf(c), elementOf(ctx), box));
  }),
  'chartFormat.chart.wordArtStyles': chartRow(async (ctx, id) => {
    const w = wordArtOf(id);
    return !!w && run1(ctx, 'chart.set', { look: { text: w.fill } });
  }),
};

/** Chart Title's text box: the title's text, an empty one as no title. */
async function chartTitleText(ctx) {
  const c = await chartNow(ctx);
  if (!c) return false;
  const r = await ctx.dialog('chartTitleText', { heading: 'Chart Title', fields: [{ id: 'title', label: 'Title text', value: c.title ?? '' }] });
  if (!r) return false;
  return many(ctx, [['chart.title', { text: r.title?.trim() ? r.title : null }]]);
}

/** Axis Title's text boxes: one per axis title that is on, each named by the axis Word's Horizontal and Vertical name. */
async function axisTitleText(ctx) {
  const c = await chartNow(ctx);
  if (!c) return false;
  const l = look(ctx);
  const h = axisOf(c.type, 'h');
  const fields = [];
  if (l.catTitle) fields.push({ id: 'catTitle', label: h === 'cat' ? 'Horizontal axis title' : 'Vertical axis title', value: l.catTitle });
  if (l.valTitle) fields.push({ id: 'valTitle', label: h === 'val' ? 'Horizontal axis title' : 'Vertical axis title', value: l.valTitle });
  const r = await ctx.dialog('chartTitleText', { heading: 'Axis Title', fields });
  if (!r) return false;
  return many(ctx, [['chart.set', { look: Object.fromEntries(fields.map((f) => [f.id, r[f.id]?.trim() ? r[f.id] : null])) }]]);
}

// ph-charts-1 and 2: the Chart tabs' galleries on a canvas draft. Word's Edit Data menu has a second row that opens Excel;
// EasyWriter has only the first. Quick Layout and Chart Styles preview the chart's own type with the layout's or style's look.
import { createElement as h } from 'react';
import { both } from '../../../tooling/engine-provider.mjs';
import { styleGallery } from '../../wp/shapes/map.mjs';
import { WORDART } from '../../wp/textbox/boxes.mjs';
import { wordArtOf } from '../rows/objects.mjs';
import { LAYOUTS, PALETTES, ROUND_LAYOUTS, STYLES, elementsOf, isRound, lookOf, tokenCss } from './look.mjs';
import { ChartThumb } from './thumb.jsx';

/** The selected chart, or null (the gallery draws nothing without one). */
const chartOf = (ctx) => ctx.read('chart.get', {})?.chart ?? null;

/** A palette as a row of 6 squares, the colours repeating as fewer than 6 take the series in turn. */
const swatches = (colors) => h('span', { className: 'flex gap-0.5' },
  Array.from({ length: 6 }, (_, i) => h('span', { key: i, style: { background: tokenCss(colors[i % colors.length]) }, className: 'size-2.5' })));

const layoutLook = (l) => ({ noValGrid: l.noValGrid, catGrid: l.catGrid });
const styleLook = (s) => ({ area: s.area, plot: s.plot, noValGrid: s.noValGrid });

export const CHART_GALLERIES = {
  'chartDesign.chart.editData': both(() => [{ id: 'editData', label: 'Edit Data' }]),
  'chartDesign.chart.quickLayout': both((ctx) => {
    const c = chartOf(ctx);
    if (!c) return [];
    return (isRound(c.type) ? ROUND_LAYOUTS : LAYOUTS).map((l) => ({
      id: l.id, label: l.label,
      preview: h(ChartThumb, { type: c.type, look: layoutLook(l), opts: { title: !!l.title, legend: l.legend ?? null } }),
    }));
  }),
  'chartDesign.chart.changeColors': both((ctx) => {
    const c = chartOf(ctx);
    if (!c) return [];
    const now = lookOf(c).colors ?? PALETTES[0].colors;
    return PALETTES.map((p) => ({
      id: p.id, label: p.label, group: p.group, preview: swatches(p.colors),
      active: JSON.stringify(now) === JSON.stringify(p.colors),
    }));
  }),
  'chartDesign.chart.chartStyles': both((ctx) => {
    const c = chartOf(ctx);
    if (!c) return [];
    return STYLES.map((s) => ({ id: s.id, label: s.label, preview: h(ChartThumb, { type: c.type, look: styleLook(s) }) }));
  }),

  // ---- the Format tab (ph-charts-3)
  'chartFormat.chart.currentSelection': both((ctx) => {
    const c = chartOf(ctx);
    if (!c) return [];
    return elementsOf(c);
  }),
  'chartFormat.chart.shapeStyles': both((ctx) => {
    const c = chartOf(ctx);
    if (!c) return [];
    // A hatched fill draws as the solid colour behind the hatch.
    return styleGallery('light').map((s) => ({
      id: s.id, label: s.label, group: s.group,
      preview: h('svg', { width: 28, height: 20 }, h('rect', {
        width: 28, height: 20, fill: s.patch.fill === 'none' ? 'none' : s.patch.fillColor, stroke: s.patch.color,
        strokeWidth: 2, ...(s.patch.dash === 'dashed' && { strokeDasharray: '4 2' }),
      })),
    }));
  }),
  'chartFormat.chart.wordArtStyles': both((ctx) => {
    const c = chartOf(ctx);
    if (!c) return [];
    return WORDART.map((p) => ({
      id: p.id, label: p.label,
      preview: h('span', { style: { fontWeight: 'bold', fontSize: 18, color: `#${wordArtOf(p.id).fill}` } }, 'A'),
      active: wordArtOf(p.id).fill === lookOf(c).text,
    }));
  }),
};

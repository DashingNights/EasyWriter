// ph-charts-2: a chart's look (docs/plans/word/briefs/ph-charts-2.md, "The look") as the canvas rows, galleries and previews
// read it. The engine stores it as one JSON object in `chart.look`; every key is optional and absent means today's chart. Pure:
// node tests load it.
import { THEME } from '../../defaults.mjs';
import { PX, styleGallery } from '../../wp/shapes/map.mjs';
import { hexOf } from '../rows/objects.mjs';

/** The chart's look as an object, `{}` when it has none or holds junk. */
export const lookOf = (chart) => {
  try {
    return JSON.parse(chart?.look || '{}') ?? {};
  } catch {
    return {};
  }
};

export const isRound = (t) => t === 'pie' || t === 'doughnut';
export const isBars = (t) => ['column', 'columnStacked', 'bar', 'barStacked'].includes(t);
export const isStacked = (t) => t === 'columnStacked' || t === 'barStacked';
const lying = (t) => t === 'bar' || t === 'barStacked';

/** Which stored axis Word's Horizontal ('h') or Vertical ('v') names: 'cat' or 'val'. */
export const axisOf = (t, which) => ((which === 'h') === lying(t) ? 'val' : 'cat');

/** A scheme name as the theme colour it names. */
const SLOT = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
const HEX = /^[0-9a-f]{6}$/i;

/** The CSS colour of a look token. `none` is transparent, 6 hex digits are the colour, and a scheme name takes the theme's
 * colour with its luminance change and offset (percent). A token the engine would not write is transparent.
 * ponytail: lumMod and lumOff as an RGB approximation, for previews only; the engine writes the exact DrawingML. */
export function tokenCss(token) {
  const t = String(token ?? '');
  if (t === 'none') return 'transparent';
  if (HEX.test(t)) return `#${t}`;
  const [name, m, o] = t.split(':');
  const base = THEME.colors[SLOT[name] ?? name];
  if (!base || (m !== undefined && !Number.isFinite(Number(m))) || (o !== undefined && !Number.isFinite(Number(o)))) return 'transparent';
  const mod = m === undefined ? 100 : Number(m);
  const off = o === undefined ? 0 : Number(o);
  const ch = [1, 3, 5].map((i) => Math.round((parseInt(base.slice(i, i + 2), 16) * mod) / 100 + (255 * off) / 100));
  return `rgb(${ch.join(' ')})`;
}

const palette = (id, label, group, colors) => ({ id, label, group, colors });
const mono = (n) => {
  const a = `accent${n}`;
  return [a, `${a}:75`, `${a}:50`, `${a}:60:40`, `${a}:40:60`, `${a}:20:80`];
};

/** Word's Change Colors sets, in its order. */
export const PALETTES = [
  palette('colorful1', 'Colorful Palette 1', 'Colorful', ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']),
  palette('colorful2', 'Colorful Palette 2', 'Colorful', ['accent1', 'accent3', 'accent5']),
  palette('colorful3', 'Colorful Palette 3', 'Colorful', ['accent2', 'accent4', 'accent6']),
  palette('colorful4', 'Colorful Palette 4', 'Colorful', ['accent6', 'accent5', 'accent4', 'accent3', 'accent2', 'accent1']),
  ...[1, 2, 3, 4, 5, 6].map((n) => palette(`mono${n}`, `Monochromatic Palette ${n}`, 'Monochromatic', mono(n))),
  ...[1, 2, 3, 4, 5, 6].map((n) => palette(`mono${n + 6}`, `Monochromatic Palette ${n + 6}`, 'Monochromatic', mono(n).reverse())),
  palette('mono13', 'Monochromatic Palette 13', 'Monochromatic', ['tx1:65:35', 'tx1:50:50', 'tx1:75:25', 'tx1:85:15', 'tx1:95:5', 'tx1:35:65']),
];

/** Word's Quick Layout presets for every type but pie and doughnut: `title` shows a title, `legend` its place (none when
 * absent), `labels` the data label place that comes with labels on, and the rest the look keys the layout sets. */
export const LAYOUTS = [
  { id: 'layout1', label: 'Layout 1', title: true, legend: 'right' },
  { id: 'layout2', label: 'Layout 2', title: true, legend: 'top', labels: 'outEnd', noValGrid: true, noValAxis: true },
  { id: 'layout3', label: 'Layout 3', title: true, legend: 'bottom' },
  { id: 'layout4', label: 'Layout 4', legend: 'bottom', labels: 'outEnd', noValGrid: true },
  { id: 'layout5', label: 'Layout 5', title: true, valTitle: true },
  { id: 'layout6', label: 'Layout 6', title: true, legend: 'right', valTitle: true },
  { id: 'layout7', label: 'Layout 7', legend: 'right', catGrid: true, catTitle: true, valTitle: true },
  { id: 'layout8', label: 'Layout 8', title: true, noValGrid: true, catTitle: true, valTitle: true },
  { id: 'layout9', label: 'Layout 9', title: true, legend: 'right', catTitle: true, valTitle: true },
  { id: 'layout10', label: 'Layout 10', title: true, legend: 'right', labels: 'outEnd' },
  { id: 'layout11', label: 'Layout 11', legend: 'right' },
];

/** Pie and doughnut charts' Quick Layouts. */
export const ROUND_LAYOUTS = [
  { id: 'layout1', label: 'Layout 1', title: true, labels: 'ctr' },
  { id: 'layout2', label: 'Layout 2', title: true, legend: 'top', labels: 'ctr' },
  { id: 'layout3', label: 'Layout 3', legend: 'bottom' },
  { id: 'layout4', label: 'Layout 4', labels: 'ctr' },
];

/** The engine steps for Quick Layout `id` on `chart`, or null for an unknown id. One undo step. */
export const layoutSteps = (chart, id) => {
  const l = (isRound(chart?.type) ? ROUND_LAYOUTS : LAYOUTS).find((x) => x.id === id);
  if (!l) return null;
  const look = lookOf(chart);
  return [
    ['chart.title', { text: l.title ? (chart.title ?? 'Chart Title') : null }],
    ['chart.legend', { pos: l.legend ?? 'none' }],
    ['chart.dataLabels', { on: !!l.labels }],
    ['chart.set', { look: {
      titleOverlay: null, legendOverlay: null, noCatAxis: null, noValAxis: l.noValAxis ? true : null,
      catGrid: l.catGrid ? true : null, noValGrid: l.noValGrid ? true : null, labelPos: l.labels ?? null,
      catTitle: l.catTitle ? (look.catTitle ?? 'Axis Title') : null, valTitle: l.valTitle ? (look.valTitle ?? 'Axis Title') : null,
    } }],
  ];
};

/** EasyWriter's own looks under Word's Chart Styles names: `area` and `plot` are `{fill, line}`, `text` the chart's text
 * colour, `labels` the data label place that comes with labels on. */
export const STYLES = [
  { id: 'style1', label: 'Style 1' },
  { id: 'style2', label: 'Style 2', noValGrid: true, noValAxis: true, labels: 'outEnd' },
  { id: 'style3', label: 'Style 3', plot: { fill: 'bg1:95' } },
  { id: 'style4', label: 'Style 4', area: { line: 'tx1:15:85' }, noValGrid: true },
  { id: 'style5', label: 'Style 5', plot: { fill: 'bg1:85' } },
  { id: 'style6', label: 'Style 6', area: { line: 'tx1:25:75' } },
  { id: 'style7', label: 'Style 7', area: { fill: 'tx1:65:35' }, text: 'bg1', noValGrid: true },
  { id: 'style8', label: 'Style 8', area: { fill: 'tx1:85:15' }, text: 'bg1' },
  { id: 'style9', label: 'Style 9', area: { fill: 'accent1' }, text: 'bg1', noValGrid: true },
  { id: 'style10', label: 'Style 10', plot: { fill: 'accent1:20:80' } },
  { id: 'style11', label: 'Style 11', area: { fill: 'tx2' }, text: 'bg1' },
  { id: 'style12', label: 'Style 12', noValGrid: true, noValAxis: true, labels: 'ctr' },
  { id: 'style13', label: 'Style 13', area: { fill: 'bg1:95' }, plot: { fill: 'bg1' } },
  { id: 'style14', label: 'Style 14', area: { fill: 'tx1' }, text: 'bg1', noValGrid: true, labels: 'outEnd' },
];

/** The chart elements Current Selection lists, Word's Format tab order: the chart area, the plot area, then a series each. */
export function elementsOf(chart) {
  const out = [{ id: 'area', label: 'Chart Area' }];
  if (!isRound(chart.type)) out.push({ id: 'plot', label: 'Plot Area' });
  const name = (s, i) => (String(s?.name ?? '').trim() ? s.name : `Series ${i + 1}`);
  if (isRound(chart.type)) {
    const first = name(chart.series?.[0], 0);
    chart.categories.forEach((cat, i) => out.push({ id: `s${i}`, label: `Series "${first}" Point "${String(cat ?? '').trim() ? cat : i + 1}"` }));
  } else {
    chart.series.forEach((s, i) => out.push({ id: `s${i}`, label: `Series "${name(s, i)}"` }));
  }
  return out;
}

/** The chart.set params that give element `el` the box `box` ({fill, line, w}), keeping the other elements of `look`. */
export function elementLook(look, el, box) {
  if (el === 'area') return { look: { area: box } };
  if (el === 'plot') return { look: { plot: box } };
  const i = /^s(\d+)$/.exec(el);
  if (i) return { look: { sers: { ...look?.sers, [i[1]]: box } } };
  return null;
}

/** Shape Styles item `id` (shapes/map.mjs styleGallery) as a box, or null. */
export function styleBox(id) {
  const p = styleGallery('light').find((x) => x.id === id)?.patch;
  if (!p) return null;
  return { fill: p.fill === 'none' ? 'none' : hexOf(p.fillColor), line: hexOf(p.color) ?? 'none', w: Math.round((p.width / PX) * 100) / 100 };
}

/** The engine steps for Chart Style `id`, or null for an unknown id. One undo step. A position the chart's type cannot take
 * writes no `c:dLblPos` (the engine's `label_pos`). */
export const styleSteps = (id) => {
  const s = STYLES.find((x) => x.id === id);
  if (!s) return null;
  return [
    ['chart.dataLabels', { on: !!s.labels }],
    ['chart.set', { look: {
      area: s.area ?? null, plot: s.plot ?? null, text: s.text ?? null,
      noValGrid: s.noValGrid ? true : null, noValAxis: s.noValAxis ? true : null, labelPos: s.labels ?? null, sers: null,
    } }],
  ];
};

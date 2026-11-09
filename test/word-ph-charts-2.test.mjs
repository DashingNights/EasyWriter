// ph-charts-2: the chart look's helpers, its Quick Layout, Change Colors and Chart Styles sets, and the rows and menu they land
// in. Expected values come from Word's Chart tabs (docs/plans/word/briefs/ph-charts-2.md) and the engine's look keys, never from
// a run of the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { THEME } from '../src/document/defaults.mjs';
import { LAYOUTS, PALETTES, ROUND_LAYOUTS, STYLES, axisOf, layoutSteps, styleSteps, tokenCss } from '../src/document/canvas/charts/look.mjs';
import { CHARTS } from '../src/document/canvas/rows/charts.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import * as S from '../src/document/ribbon/spec.mjs';

const A = 'chartDesign.chart.addChartElement';
const IDS = [A, 'chartDesign.chart.quickLayout', 'chartDesign.chart.changeColors', 'chartDesign.chart.chartStyles'];

const ACE_SUBS = {
  axes: ['primaryHorizontal', 'primaryVertical'],
  axisTitles: ['primaryHorizontal', 'primaryVertical', 'moreAxisTitleOptions'],
  chartTitle: ['none', 'aboveChart', 'centeredOverlay', 'moreTitleOptions'],
  dataLabels: ['none', 'center', 'insideEnd', 'insideBase', 'outsideEnd'],
  gridlines: ['primaryMajorHorizontal', 'primaryMajorVertical'],
  legend: ['none', 'right', 'top', 'left', 'bottom', 'rightOverlay', 'leftOverlay'],
};
const ACE_PLAIN = ['dataTable', 'errorBars', 'lines', 'trendline', 'upDownBars'];
const ACE_ORDER = ['axes', 'axisTitles', 'chartTitle', 'dataLabels', 'dataTable', 'errorBars', 'gridlines', 'legend', 'lines', 'trendline', 'upDownBars'];

test('axisOf names the stored axis Word calls Horizontal and Vertical', () => {
  // A column chart lies upright: its category axis is horizontal, its value axis vertical. A bar chart lies the other way.
  assert.deepEqual([axisOf('column', 'h'), axisOf('column', 'v')], ['cat', 'val']);
  assert.deepEqual([axisOf('bar', 'h'), axisOf('bar', 'v')], ['val', 'cat']);
  // A scatter chart's x axis is its category axis.
  assert.deepEqual([axisOf('scatter', 'h'), axisOf('scatter', 'v')], ['cat', 'val']);
});

test('layoutSteps gives Word\'s Quick Layouts as engine steps', () => {
  const chart = { type: 'column', title: 'Sales', look: '' };
  const two = layoutSteps(chart, 'layout2');
  assert.deepEqual(two.slice(0, 3), [
    ['chart.title', { text: 'Sales' }],
    ['chart.legend', { pos: 'top' }],
    ['chart.dataLabels', { on: true }],
  ]);
  assert.deepEqual(
    [two[3][1].look.labelPos, two[3][1].look.noValAxis],
    ['outEnd', true],
  );
  assert.deepEqual(layoutSteps(chart, 'layout4')[0], ['chart.title', { text: null }]);
  assert.equal(layoutSteps(chart, 'nope'), null);
  assert.equal(LAYOUTS.length, 11);
  assert.equal(ROUND_LAYOUTS.length, 4);
  // A pie chart has the round layouts, not the eleven: its layout 2 keeps the title and puts the labels in the middle.
  const pie = layoutSteps({ type: 'pie', title: 'Share', look: '' }, 'layout2');
  assert.deepEqual([pie[0][1].text, pie[1][1].pos, pie[3][1].look.labelPos], ['Share', 'top', 'ctr']);
});

test('PALETTES are Word\'s seventeen Change Colors sets, groups in order', () => {
  const names = PALETTES.map((p) => p.label);
  assert.deepEqual(names, [
    'Colorful Palette 1', 'Colorful Palette 2', 'Colorful Palette 3', 'Colorful Palette 4',
    ...Array.from({ length: 13 }, (_, i) => `Monochromatic Palette ${i + 1}`),
  ]);
  assert.equal(PALETTES.length, 17);
  assert.deepEqual([PALETTES[3].group, PALETTES[4].group], ['Colorful', 'Monochromatic']);
  assert.ok(PALETTES.find((p) => p.id === 'mono13').colors.every((t) => t.startsWith('tx1')));
  // Fewer colours than series repeat in turn; the first set is the theme's six accents.
  assert.deepEqual(PALETTES[0].colors, ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']);
  assert.equal(PALETTES.find((p) => p.id === 'colorful2').colors.length, 3);
});

test('STYLES are Word\'s fourteen Chart Styles, and Style 1 clears every look key', () => {
  assert.equal(STYLES.length, 14);
  const [labels, set] = styleSteps('style1');
  assert.deepEqual(labels, ['chart.dataLabels', { on: false }]);
  assert.ok(Object.values(set[1].look).every((v) => v === null), JSON.stringify(set));
  assert.equal(styleSteps('nope'), null);
  const seven = styleSteps('style7')[1][1].look;
  assert.deepEqual([seven.area.fill, seven.text, seven.noValGrid], ['tx1:65:35', 'bg1', true]);
});

test('tokenCss previews a token and never throws on a bad one', () => {
  const accent1 = THEME.colors.accent1; // #156082
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent1.slice(i, i + 2), 16));
  const at = (c) => Math.round((c * 60) / 100 + (255 * 40) / 100);
  assert.equal(tokenCss('accent1:60:40'), `rgb(${at(r)} ${at(g)} ${at(b)})`);
  assert.equal(tokenCss('none'), 'transparent');
  assert.equal(tokenCss('156082'), '#156082');
  // tx1 is dk1, bg1 is lt1.
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');
  assert.equal(tokenCss('tx1'), `rgb(${rgb(THEME.colors.dk1)})`);
  assert.equal(tokenCss('bg1'), `rgb(${rgb(THEME.colors.lt1)})`);
  for (const bad of ['accent7', 'nope:1:2', '', undefined, 'zzzzzz', 'accent1:x']) assert.doesNotThrow(() => tokenCss(bad));
});

test('the four ids are out of the placeholders and in the spec', () => {
  for (const id of IDS) {
    const control = S.CONTROLS[id] ?? S.ITEMS[id];
    assert.ok(control, `${id} is in the spec`);
    assert.equal(control.needs, undefined, `${id} has no needs`);
  }
});

test('Add Chart Element holds Word\'s eleven entries in order and every leaf resolves', () => {
  assert.equal(S.MENUS[A].length, 11);
  assert.deepEqual(S.MENUS[A].map((e) => e.item.split('.').pop()), ACE_ORDER);
  for (const [k, leaves] of Object.entries(ACE_SUBS)) {
    assert.deepEqual(S.MENUS[`${A}.${k}`].map((e) => e.item), leaves.map((leaf) => `${A}.${k}.${leaf}`), k);
    for (const leaf of leaves) assert.ok(S.ITEMS[`${A}.${k}.${leaf}`], `${A}.${k}.${leaf}`);
  }
  for (const k of ACE_PLAIN) assert.ok(S.ITEMS[`${A}.${k}`], `${A}.${k}`);
  // The two text box items open their dialog.
  assert.equal(S.ITEMS[`${A}.axisTitles.moreAxisTitleOptions`].dialog, 'chartTitleText');
  assert.equal(S.ITEMS[`${A}.chartTitle.moreTitleOptions`].dialog, 'chartTitleText');
});

test('every new row is a row form', () => {
  const keys = Object.keys(CHARTS).filter((id) => id.startsWith(`${A}.`) || IDS.includes(id));
  assert.equal(keys.length, 1 + 2 + 2 + 1 + 3 + 1 + 5 + 2 + 7 + 5 + 3);
  for (const id of keys) assert.ok(formOf(CHARTS[id]), `${id} is a row form`);
});

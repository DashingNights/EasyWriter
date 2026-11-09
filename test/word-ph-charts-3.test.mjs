// ph-charts-3: the chart Format tab's Current Selection elements, the Style box an element takes, and its three rows.
// Expected values come from Word's Format tab (docs/plans/word/briefs/ph-charts-3.md) and the engine's look keys, never from a
// run of the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { elementLook, elementsOf, styleBox } from '../src/document/canvas/charts/look.mjs';
import { CHARTS } from '../src/document/canvas/rows/charts.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { REASONS } from '../src/tooling/reasons.mjs';
import * as S from '../src/document/ribbon/spec.mjs';

const IDS = ['chartFormat.chart.currentSelection', 'chartFormat.chart.shapeStyles', 'chartFormat.chart.wordArtStyles'];

const column = {
  type: 'column',
  categories: ['North', 'South'],
  series: [{ name: 'Sales', values: [1, 2] }, { name: '', values: [3, 4] }],
};

test('elementsOf lists the chart area, the plot area and a series each, in Word\'s order', () => {
  const els = elementsOf(column);
  assert.deepEqual(els.map((e) => e.id), ['area', 'plot', 's0', 's1']);
  assert.deepEqual(els.map((e) => e.label), ['Chart Area', 'Plot Area', 'Series "Sales"', 'Series "Series 2"']);
  // A pie chart has no plot area; its elements are the slices, named by the series and the category.
  const pie = elementsOf({ type: 'pie', categories: ['North', 'South'], series: [{ name: 'Share', values: [1, 2] }] });
  assert.deepEqual(pie.map((e) => e.id), ['area', 's0', 's1']);
  assert.equal(pie[1].label, 'Series "Share" Point "North"');
  // An empty series name and an empty category take their numbers, as Word's do.
  const unnamed = elementsOf({ type: 'doughnut', categories: ['', 'South'], series: [{ name: '', values: [1, 2] }] });
  assert.equal(unnamed[1].label, 'Series "Series 1" Point "1"');
});

test('elementLook writes one element and keeps the others, and gives no params for an unknown one', () => {
  const look = { area: { fill: 'none' }, sers: { 0: { fill: 'bg1' } } };
  assert.deepEqual(elementLook(look, 'area', { fill: 'accent1' }), { look: { area: { fill: 'accent1' } } });
  assert.deepEqual(elementLook(look, 'plot', { fill: 'accent2' }), { look: { plot: { fill: 'accent2' } } });
  const one = elementLook(look, 's1', { fill: 'accent1' });
  assert.deepEqual(one, { look: { sers: { 0: { fill: 'bg1' }, 1: { fill: 'accent1' } } } });
  assert.equal(elementLook(look, 'nope', { fill: 'accent1' }), null);
});

test('styleBox turns a Shape Styles item into a chart element box', () => {
  // a1v2 is Colored Fill on Accent 1: the fill and the line take the same colour.
  const box = styleBox('a1v2');
  assert.equal(box.fill, box.line);
  assert.equal(box.fill, '6C8EBF');
  assert.ok(box.w > 1, `${box.w} pt is the 2 pt outline in points`);
  // A hatched fill becomes its solid colour.
  assert.equal(styleBox('a1v5').fill, '6C8EBF');
  assert.equal(styleBox('nope'), null);
});

test('the three Format rows are in the spec without a needs, and Refresh Data keeps the chart reason', () => {
  for (const id of IDS) {
    const control = S.CONTROLS[id] ?? S.ITEMS[id];
    assert.ok(control, `${id} is in the spec`);
    assert.equal(control.needs, undefined, `${id} has no needs`);
  }
  assert.equal(S.CONTROLS['chartDesign.chart.refreshData'].needs, 'chart');
  assert.match(REASONS.chart, /workbook/);
});

test('every new row is a row form', () => {
  for (const id of IDS) assert.ok(formOf(CHARTS[id]), `${id} is a row form`);
});

test('a chart row in the text is off with Select a chart first., whatever the last chart.get reading says', () => {
  const row = CHARTS['chartFormat.chart.shapeStyles'];
  // The chart.get reading stays behind while the Format tab is hidden; the selection is the app's own context.
  const stale = { obj: null, engine: {}, stateOf: () => ({ enabled: true, reason: null }), read: () => null };
  assert.equal(row.enabled(stale), false);
  assert.equal(row.reason(stale), 'Select a chart first.');
  const on = { ...stale, obj: { kind: 'chart' } };
  assert.equal(row.enabled(on), true);
});

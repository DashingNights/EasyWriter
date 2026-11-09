// ph-charts-1: the pure chart helpers, the Chart tabs' rows and the spec they land in. The helpers' expected values come from
// Word's behaviour (Enter moves down a cell, a paste grows the grid) and the engine's limits, never from a run of the code.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHART_GROUPS, MAX_ROWS, badCells, chartOfGrid, gridOf, pasteInto, transpose, valuesOf } from '../src/document/canvas/charts/data.mjs';
import { CHARTS } from '../src/document/canvas/rows/charts.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import * as S from '../src/document/ribbon/spec.mjs';

const IDS = [
  'insert.illustrations.chart',
  'chartDesign.chart.changeChartType',
  'chartDesign.chart.switchRowColumn',
  'chartDesign.chart.editData',
  'chartDesign.chart.selectData',
];

test('gridOf and chartOfGrid keep the chart and its gaps', () => {
  const chart = { type: 'column', categories: ['A', 'B'], series: [{ name: 'S1', values: [1, null] }, { name: 'S2', values: [2, 3] }] };
  const rows = gridOf(chart);
  assert.deepEqual(rows, [['', 'S1', 'S2'], ['A', '1', '2'], ['B', '', '3']]);
  assert.deepEqual(chartOfGrid(rows), {
    categories: ['A', 'B'],
    series: [{ name: 'S1', values: [1, null] }, { name: 'S2', values: [2, 3] }],
  });
  // An empty chart still gives a dialog of at least two rows and two columns to type in.
  assert.deepEqual(gridOf({ categories: [], series: [] }), [['', ''], ['', '']]);
});

test('badCells flags text in value cells and passes blanks and numbers', () => {
  assert.deepEqual(badCells([['', 'S'], ['A', 'abc'], ['B', '']]), [[1, 1]]);
  assert.deepEqual(badCells([['', 'S'], ['', ' 1.5 '], ['', '-3e2']]), []);
});

test('transpose swaps series and categories and twice gives the original', () => {
  const chart = { categories: ['A', 'B', 'C'], series: [{ name: 'S1', values: [1, 2, 3] }, { name: 'S2', values: [4, 5, 6] }] };
  const t = transpose(chart);
  assert.deepEqual(t, {
    categories: ['S1', 'S2'],
    series: [{ name: 'A', values: [1, 4] }, { name: 'B', values: [2, 5] }, { name: 'C', values: [3, 6] }],
  });
  assert.deepEqual(transpose(t), chart);
});

test('pasteInto grows the grid and drops what falls past the last row', () => {
  assert.deepEqual(pasteInto([['', 'S'], ['A', '1']], 2, 1, [['7', '8']]), [['', 'S'], ['A', '1'], ['', '7', '8']]);
  const tall = pasteInto([['']], 0, 0, Array.from({ length: MAX_ROWS + 10 }, (_, i) => [String(i)]));
  assert.equal(tall.length, MAX_ROWS);
  assert.equal(tall.at(-1)[0], String(MAX_ROWS - 1));
});

test('valuesOf reads numbers, gaps and bad text', () => {
  assert.deepEqual(valuesOf('1, ,x'), [1, null, NaN]);
});

test('CHART_GROUPS holds exactly the engine\'s nine chart types', () => {
  assert.deepEqual(
    CHART_GROUPS.flatMap((g) => g.types.map(([id]) => id)).sort(),
    ['area', 'bar', 'barStacked', 'column', 'columnStacked', 'doughnut', 'line', 'pie', 'scatter'],
  );
});

test('the five chart ids have rows in the chart row table', () => {
  for (const id of IDS) assert.ok(CHARTS[id], `${id} is a row`);
  for (const [id, row] of Object.entries(CHARTS)) assert.ok(formOf(row), `${id} is a row form`);
});

test('the five chart ids are out of the placeholders and Refresh Data still needs a chart', () => {
  for (const id of IDS) {
    const control = S.CONTROLS[id] ?? S.ITEMS[id];
    assert.ok(control, `${id} is in the spec`);
    assert.equal(control.needs, undefined, `${id} has no needs`);
  }
  assert.equal(S.CONTROLS['chartDesign.chart.refreshData']?.needs, 'chart');
});

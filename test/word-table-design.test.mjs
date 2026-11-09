// Table Design's pure data (src/document/wp/table-design/styles.mjs): the gallery's 105 styles in Word's order, the generated
// definitions, the conditional format order and the pen lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME } from '../src/document/defaults.mjs';
import { BORDER_STYLES } from '../src/office.mjs';
import { BORDER_PRESETS, cellLook, condsOf, engineParts, nextStyleName, PEN_STYLES, PEN_WEIGHTS, penOfCss, sidesOf, TABLE_STYLES, tableStyleDef, withPart } from '../src/document/wp/table-design/styles.mjs';

// probe/menus/table.table-design.table-styles.json, copied: the planning folder is not in the repo.
const FAMILIES = ['1 Light', '2', '3', '4', '5 Dark', '6 Colorful', '7 Colorful'];
const EXPECTED = [
  'Table Grid', 'Table Grid Light', 'Plain Table 1', 'Plain Table 2', 'Plain Table 3', 'Plain Table 4', 'Plain Table 5',
  ...['Grid', 'List'].flatMap((k) => FAMILIES.flatMap((f) => [`${k} Table ${f}`, ...[1, 2, 3, 4, 5, 6].map((n) => `${k} Table ${f} - Accent ${n}`)])),
];

test('the gallery holds Word\'s 105 table styles in the probe\'s order', () => {
  assert.equal(TABLE_STYLES.length, 105);
  assert.deepEqual(TABLE_STYLES.map((s) => s.name), EXPECTED);
  assert.deepEqual([0, 6, 7, 55, 56, 104].map((i) => [TABLE_STYLES[i].id, TABLE_STYLES[i].group]), [
    ['TableGrid', 'Plain Tables'], ['PlainTable5', 'Plain Tables'], ['GridTable1Light', 'Grid Tables'],
    ['GridTable7Colorful-Accent6', 'Grid Tables'], ['ListTable1Light', 'List Tables'], ['ListTable7Colorful-Accent6', 'List Tables'],
  ]);
  assert.equal(TABLE_STYLES.find((s) => s.name === 'Grid Table 4 - Accent 1').id, 'GridTable4-Accent1');
  for (const s of TABLE_STYLES) assert.ok(tableStyleDef(s.id, THEME)?.type === 'table', s.id);
  assert.equal(tableStyleDef('Nope', THEME), null);
});

test('Grid Table 4 - Accent 1 has an accent header with white bold text and a light band', () => {
  const d = tableStyleDef('GridTable4-Accent1', THEME);
  assert.equal(d.basedOn, 'TableNormal');
  assert.equal(d.table.cond.firstRow.cell.shading.fill, THEME.colors.accent1.toUpperCase());
  assert.deepEqual(d.table.cond.firstRow.cell.shading.themeFill, { slot: 'accent1', lum: 0 });
  assert.equal(d.table.cond.firstRow.run.bold, true);
  assert.equal(d.table.cond.firstRow.run.color, '#FFFFFF');
  assert.equal(d.table.cond.lastRow.run.bold, true);
  const band = d.table.cond.band1Horz.cell.shading;
  assert.deepEqual(band.themeFill, { slot: 'accent1', lum: 0.8 });
  assert.notEqual(band.fill, THEME.colors.accent1);
  assert.deepEqual(tableStyleDef('TableGrid', THEME).table.borders, { style: 'single', width: 0.5, color: null });
});

test('condsOf follows Word\'s order and starts banding after a header row', () => {
  const dims = { rows: 4, cols: 3 };
  const look = { firstRow: true, lastRow: true, firstColumn: true, lastColumn: true, noHBand: false, noVBand: false };
  assert.deepEqual(condsOf(0, 0, dims, look), ['wholeTable', 'firstCol', 'firstRow', 'nwCell']);
  assert.deepEqual(condsOf(1, 1, dims, look), ['wholeTable', 'band1Vert', 'band1Horz']);
  assert.deepEqual(condsOf(3, 2, dims, look), ['wholeTable', 'band2Vert', 'band1Horz', 'lastCol', 'lastRow', 'seCell']);
  const plain = { firstRow: false, firstColumn: false, noHBand: false, noVBand: true };
  assert.deepEqual([0, 1, 2, 3].map((r) => condsOf(r, 1, dims, plain).at(-1)), ['band1Horz', 'band2Horz', 'band1Horz', 'band2Horz']);
  const header = { firstRow: true, noVBand: true };
  assert.deepEqual([0, 1, 2, 3].map((r) => condsOf(r, 1, dims, header).at(-1)), ['firstRow', 'band1Horz', 'band2Horz', 'band1Horz']);
  assert.deepEqual(condsOf(2, 1, dims, { noHBand: true, noVBand: true }), ['wholeTable']);
});

test('cellLook applies the formats in order: the header beats the band', () => {
  const d = tableStyleDef('GridTable4-Accent1', THEME);
  const look = { firstRow: true, firstColumn: true, noVBand: true };
  const dims = { rows: 4, cols: 3 };
  assert.equal(cellLook(d, 0, 1, dims, look).fill, THEME.colors.accent1.toUpperCase());
  assert.equal(cellLook(d, 0, 1, dims, look).bold, true);
  assert.notEqual(cellLook(d, 1, 1, dims, look).fill, cellLook(d, 2, 1, dims, look).fill);
  assert.equal(cellLook(d, 2, 1, dims, { ...look, noHBand: true }).fill, null);
});

test('the pen lists map to BORDER_STYLES names', () => {
  assert.equal(PEN_STYLES.length, 25);
  for (const [name] of PEN_STYLES) assert.ok(BORDER_STYLES.includes(name), name);
  assert.equal(PEN_STYLES[1][0], 'single');
  assert.deepEqual(PEN_WEIGHTS.map(([w]) => w), [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6]);
  assert.equal(BORDER_PRESETS.length, 21);
  assert.equal(new Set(BORDER_PRESETS.map((p) => p.id)).size, 21);
  assert.equal(BORDER_PRESETS[8].label, 'Single solid line, 1 1/2 pt, Accent 1');
  assert.deepEqual(penOfCss('solid', '2px', 'rgb(255, 0, 0)'), { style: 'single', width: 1.5, color: '#FF0000' });
  assert.equal(penOfCss('none', '0px', 'rgb(0, 0, 0)'), null);
  assert.equal(penOfCss('solid', '1px', 'rgb(0, 0, 0)').width, 0.5);
  // One device pixel on a 100 % screen under a 75 % page zoom reads back as 1.33 CSS px: still the thinnest line, ½ pt.
  assert.equal(penOfCss('solid', '1.33333px', 'rgb(0, 0, 0)', 1 / 0.75).width, 0.5);
  assert.equal(nextStyleName({ Style1: { name: 'Style1' }, X: { name: 'Style2' } }), 'Style3');
});

test('Modify Table Style on Table Grid: No Border on the whole table clears its single edge, unset keys stay out', async () => {
  const { borderRules } = await import('../src/document/stylesheet.js');
  const grid = tableStyleDef('TableGrid', THEME);
  const none = { style: 'nil' };
  const sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
  const def = withPart(grid, 'wholeTable', { cell: { borders: { ...sidesOf(grid.table.borders), ...Object.fromEntries(sides.map((s) => [s, none])) } } });
  const top = borderRules(def.table.borders).find(([sel, css]) => 'border-top' in css)[1]['border-top'];
  assert.match(top, /none/);
  assert.equal(cellLook(def, 0, 0, { rows: 2, cols: 2 }, {}).borders.top.style, 'nil');
  // Bold on a new style keeps the base style's borders: no null shading, borders or vAlign written.
  const bold = withPart({ type: 'table', name: 'S', basedOn: 'TableGrid', table: {} }, 'wholeTable', { run: { bold: true } });
  assert.deepEqual(bold.table, {});
  assert.equal(bold.run.bold, true);
});

test('a table style definition becomes the engine table style command parts (a canvas draft)', () => {
  const def = withPart(withPart({ type: 'table', name: 'Mine', basedOn: 'TableNormal', table: {} }, 'wholeTable',
    { run: { font: '+minor', bold: true }, cell: { shading: { fill: '#FF0000' }, borders: { style: 'single', width: 0.5, color: '000000' } } }),
  'firstRow', { run: { underline: 'double', color: '#00FF00' }, para: { align: 'center' }, cell: { borders: { bottom: { style: 'nil' } } } });
  const [whole, first] = engineParts(def);
  assert.equal(whole.part, 'wholeTable');
  assert.equal(whole.font, THEME.fonts.minor, 'theme fonts go as the names they show');
  assert.equal(whole.bold, true);
  assert.equal(whole.fill, 'FF0000');
  assert.equal(whole.borders.length, 6, 'one edge object stands for all six sides');
  assert.deepEqual(whole.borders[0], { edges: 'top', style: 'single', width: 0.5, color: '000000' });
  assert.deepEqual(first, { part: 'firstRow', underline: 'double', color: '00FF00', align: 'center', borders: [{ edges: 'bottom', style: 'none' }] });
  assert.equal('size' in whole, false, 'a key the part does not set stays out, so the base style gives it');
});

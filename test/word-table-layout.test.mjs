// Table Layout's pure grid model (src/document/wp/table-layout/grid.mjs), the acceptance list of briefs/table-layout.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deleteCells, distribute, gridOf, insertCells, sortParagraphs, sortRows, splitCell, tableToText } from '../src/document/wp/table-layout/grid.mjs';

const cell = (text, attrs = {}) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs },
  content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] });
const table = (rows) => ({ type: 'table', attrs: {}, content: rows.map((r) => ({ type: 'tableRow', attrs: {}, content: r })) });
const grid3 = () => table([0, 1, 2].map((i) => [0, 1, 2].map((j) => cell(`r${i}c${j}`))));
const textOf = (c) => (c.content ?? []).map((p) => (p.content ?? []).map((t) => t.text).join('')).join('\n');
const texts = (t) => t.content.map((r) => r.content.map(textOf));

test('gridOf maps a 3x3 with a 2x2 merge to its spans', () => {
  const t = table([[cell('a', { colspan: 2, rowspan: 2 }), cell('b')], [cell('c')], [cell('d'), cell('e'), cell('f')]]);
  const g = gridOf(t);
  assert.equal(g.rows, 3);
  assert.equal(g.cols, 3);
  assert.deepEqual(g.map, [[0, 0, 1], [0, 0, 2], [3, 4, 5]]);
  assert.deepEqual(g.cells.map((c) => [c.y, c.x, c.cs, c.rs]), [[0, 0, 2, 2], [0, 2, 1, 1], [1, 2, 1, 1], [2, 0, 1, 1], [2, 1, 1, 1], [2, 2, 1, 1]]);
});

test('splitCell of a 1x1 into 3 columns by 2 rows spans the other rows and columns', () => {
  const t = splitCell(table([[cell('a'), cell('b')], [cell('c'), cell('d')]]), 0, 0, 3, 2);
  const g = gridOf(t);
  assert.equal(g.cols, 4);
  assert.equal(g.rows, 3);
  assert.deepEqual(t.content[0].content.map((c) => [c.attrs.colspan, c.attrs.rowspan]), [[1, 1], [1, 1], [1, 1], [1, 2]]);
  assert.deepEqual(t.content[1].content.length, 3);
  assert.deepEqual(t.content[2].content.map((c) => [c.attrs.colspan, c.attrs.rowspan]), [[3, 1], [1, 1]]);
  assert.equal(textOf(t.content[0].content[0]), 'a');
  assert.equal(textOf(t.content[2].content[0]), 'c');
});

test('splitCell within its own spans shares them', () => {
  const t = splitCell(table([[cell('a', { colspan: 2 })], [cell('b'), cell('c')]]), 0, 0, 2, 1);
  assert.deepEqual(t.content[0].content.map((c) => c.attrs.colspan), [1, 1]);
  assert.equal(gridOf(t).cols, 2);
});

test('insertCells shift down on (1,1) of a 3x3 moves the column and adds a row', () => {
  const t = insertCells(grid3(), { top: 1, left: 1, bottom: 2, right: 2 }, 'down');
  assert.deepEqual(texts(t), [['r0c0', 'r0c1', 'r0c2'], ['r1c0', '', 'r1c2'], ['r2c0', 'r1c1', 'r2c2'], ['', 'r2c1', '']]);
  // Delete Cells up on the same cell reverses it.
  assert.deepEqual(texts(deleteCells(t, { top: 1, left: 1, bottom: 2, right: 2 }, 'up')), texts(grid3()));
});

test('insertCells shift right pads the other rows at their end', () => {
  const t = insertCells(grid3(), { top: 1, left: 1, bottom: 2, right: 2 }, 'right');
  assert.deepEqual(texts(t), [['r0c0', 'r0c1', 'r0c2', ''], ['r1c0', '', 'r1c1', 'r1c2'], ['r2c0', 'r2c1', 'r2c2', '']]);
});

test('deleteCells shift left pads the row end', () => {
  const t = deleteCells(grid3(), { top: 1, left: 0, bottom: 2, right: 1 }, 'left');
  assert.deepEqual(texts(t)[1], ['r1c1', 'r1c2', '']);
  assert.deepEqual(texts(t)[0], ['r0c0', 'r0c1', 'r0c2']);
});

test('deleteCells whole row and column', () => {
  assert.deepEqual(texts(deleteCells(grid3(), { top: 1, left: 1, bottom: 2, right: 2 }, 'row')), [['r0c0', 'r0c1', 'r0c2'], ['r2c0', 'r2c1', 'r2c2']]);
  assert.deepEqual(texts(deleteCells(grid3(), { top: 1, left: 1, bottom: 2, right: 2 }, 'column'))[0], ['r0c0', 'r0c2']);
});

test('distribute [72, 144] gives [108, 108]', () => {
  assert.deepEqual(distribute([72, 144]), [108, 108]);
});

test('sortRows by column 2 Number descending with a header row', () => {
  const items = [['Name', 'Score'], ['a', '5'], ['b', '12'], ['c', '7']];
  const order = sortRows(items, [{ field: 1, type: 'number', desc: true }], { header: true });
  assert.deepEqual(order.map((i) => items[i][0]), ['Name', 'b', 'c', 'a']);
});

test("Number ascending ['10', '9', 'x'] gives ['x', '9', '10']", () => {
  const items = [['10'], ['9'], ['x']];
  assert.deepEqual(sortRows(items, [{ field: 0, type: 'number' }]).map((i) => items[i][0]), ['x', '9', '10']);
});

test("Text ascending ['b', 'A', 'a'] gives ['A', 'a', 'b'] (stable)", () => {
  const items = [['b'], ['A'], ['a']];
  assert.deepEqual(sortRows(items, [{ field: 0, type: 'text' }], { lang: 'en' }).map((i) => items[i][0]), ['A', 'a', 'b']);
});

test('Date sorts by the parsed date, a then-by key breaking ties', () => {
  const items = [['3 March 2024', 'b'], ['2024-01-05', 'z'], ['1/2/2023', 'q'], ['3 March 2024', 'a']];
  const order = sortRows(items, [{ field: 0, type: 'date' }, { field: 1, type: 'text' }]);
  assert.deepEqual(order.map((i) => items[i][1]), ['q', 'z', 'a', 'b']);
});

test('sortParagraphs by field 2 split at commas', () => {
  const t = ['x, 3', 'y, 1', 'z, 2'];
  assert.deepEqual(sortParagraphs(t, [{ field: 2, type: 'number' }]).map((i) => t[i]), ['y, 1', 'z, 2', 'x, 3']);
});

test('tableToText with tabs, commas and paragraph marks', () => {
  const run = (s, attrs) => ({ type: 'paragraph', ...(attrs && { attrs }), content: [{ type: 'text', text: s }] });
  const rows = [[[run('r0c0', { textAlign: 'center' })], [run('r0c1')]], [[run('r1c0'), run('more')], [run('r1c1')]]];
  const plain = (ps) => ps.map((p) => (p.content ?? []).map((i) => i.text).join(''));
  // A joined paragraph keeps its first source paragraph's attributes.
  assert.equal(tableToText(rows, ',')[0].attrs.textAlign, 'center');
  assert.deepEqual(plain(tableToText(rows, '\t')), ['r0c0\tr0c1', 'r1c0', 'more\tr1c1']);
  assert.deepEqual(plain(tableToText(rows, ',')), ['r0c0,r0c1', 'r1c0', 'more,r1c1']);
  assert.deepEqual(plain(tableToText(rows, 'para')), ['r0c0', 'r0c1', 'r1c0', 'more', 'r1c1']);
});

test('deleteCells shift up keeps a trailing row that was empty before', () => {
  const t = table([[cell('a'), cell('b')], [cell('c'), cell('d')], [cell(''), cell('')]]);
  assert.equal(deleteCells(t, { top: 0, left: 0, bottom: 1, right: 1 }, 'up').content.length, 3);
});

test('new rows drop the tracked change and header flag of the row they copy', () => {
  const t = grid3();
  t.content.forEach((r) => { r.attrs = { rev: { ins: { id: 1 } }, header: true, height: { value: 20, rule: 'atLeast' } }; });
  const down = insertCells(t, { top: 1, left: 1, bottom: 2, right: 2 }, 'down').content[3].attrs;
  const row = insertCells(t, { top: 1, left: 1, bottom: 2, right: 2 }, 'row').content[1].attrs;
  const split = splitCell(t, 2, 0, 1, 2).content[3].attrs;
  for (const a of [down, row, split]) assert.deepEqual([a.rev, a.header, a.height.value], [null, false, 20]);
});

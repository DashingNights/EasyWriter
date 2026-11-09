// Table tools' pure logic (src/document/wp/table-tools/tables.mjs; docs/plans/word/briefs/table-tools.md Acceptance).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  borderDrag, cellNav, colsFor, detectSep, drawOp, edgeAt, eraseOp, gridOf, moveRows, rowsFor, textToRows, validateInsert,
} from '../src/document/wp/table-tools/tables.mjs';

// A model of `rows` x `cols` cells, each 100 by 20 px.
const model = (rows, cols) => ({
  cols: Array(cols).fill(100),
  rows: Array(rows).fill(20),
  cells: Array.from({ length: rows * cols }, (_, i) => ({ r: Math.floor(i / cols), c: i % cols, rs: 1, cs: 1, src: [i] })),
});
const rowCells = (m, r) => m.cells.filter((c) => c.r === r);

test('textToRows: commas give a row per paragraph, a short row padded with an empty cell', () => {
  assert.deepEqual(textToRows(['a,b,c', 'd,e'], 'commas'), [['a', 'b', 'c'], ['d', 'e', '']]);
  assert.deepEqual(textToRows(['a-b', 'c'], 'other', { other: '-' }), [['a', 'b'], ['c', '']]);
});

test('detectSep: Tabs when a paragraph holds a tab, else Paragraphs', () => {
  assert.equal(detectSep(['a\tb', 'c']), 'tabs');
  assert.equal(detectSep(['a,b', 'c']), 'paragraphs');
  assert.equal(colsFor(['a\tb\tc', 'd'], 'tabs'), 3);
  assert.equal(colsFor(['a\tb\tc'], 'paragraphs'), 1);
});

test('Paragraphs with 2 columns: each paragraph is a cell, 5 paragraphs make 3 rows', () => {
  const texts = ['1', '2', '3', '4', '5'];
  assert.equal(rowsFor(texts, 'paragraphs', '-', 2), 3);
  assert.deepEqual(textToRows(texts, 'paragraphs', { cols: 2 }), [['1', '2'], ['3', '4'], ['5', '']]);
});

test('validateInsert: Word\'s limits of 1 to 63 columns and 1 to 32767 rows', () => {
  assert.ok(validateInsert({ cols: 0, rows: 2 }));
  assert.ok(validateInsert({ cols: 64, rows: 2 }));
  assert.ok(validateInsert({ cols: 5, rows: 32768 }));
  assert.equal(validateInsert({ cols: 63, rows: 32767 }), null);
});

test('cellNav: start and end of the row and column on a 3x3 grid with a merged cell', () => {
  // Cell a spans the top row's first two columns; e spans the middle column's lower two rows.
  const grid = [['a', 'a', 'b'], ['c', 'e', 'f'], ['g', 'e', 'h']];
  assert.deepEqual(cellNav(grid, 0, 2, 'rowStart'), { r: 0, c: 0 });
  assert.deepEqual(cellNav(grid, 1, 0, 'rowEnd'), { r: 1, c: 2 });
  assert.deepEqual(cellNav(grid, 2, 1, 'colStart'), { r: 0, c: 0 });
  assert.deepEqual(cellNav(grid, 0, 1, 'colEnd'), { r: 1, c: 1 });
  assert.deepEqual(cellNav(grid, 2, 2, 'colStart'), { r: 0, c: 2 });
});

test('moveRows: one place past the neighbour, nothing at the table\'s edges or across a spanning cell', () => {
  assert.deepEqual(moveRows(3, 0, 0, 'down'), [1, 0, 2]);
  assert.deepEqual(moveRows(4, 1, 2, 'up'), [1, 2, 0, 3]);
  assert.equal(moveRows(3, 0, 0, 'up'), null);
  assert.equal(moveRows(3, 2, 2, 'down'), null);
  assert.equal(moveRows(3, 0, 0, 'down', [['a', 'b'], ['a', 'c'], ['d', 'e']]), null);
});

test('edgeAt: the inner vertical edge of a 2x2 grid within 4 px, nothing at 6 px', () => {
  const rects = [
    { id: 0, left: 0, top: 0, right: 100, bottom: 20 }, { id: 1, left: 100, top: 0, right: 200, bottom: 20 },
    { id: 2, left: 0, top: 20, right: 100, bottom: 40 }, { id: 3, left: 100, top: 20, right: 200, bottom: 40 },
  ];
  const e = edgeAt(rects, 103, 10);
  assert.equal(e.dir, 'v');
  assert.deepEqual([e.a, e.b], [{ id: 0, side: 'right' }, { id: 1, side: 'left' }]);
  assert.equal(edgeAt(rects, 106, 10), null);
  assert.equal(edgeAt(rects, 50, 2).b, null); // the table's top edge has no cell beyond it
});

test('drawOp: a vertical line across cell (0,0) splits it into two columns and widens the other rows\' cells', () => {
  const m = model(2, 2);
  const { op, model: out } = drawOp(m, { x1: 48, y1: 1, x2: 52, y2: 19 });
  assert.equal(op.kind, 'split');
  assert.deepEqual(out.cols, [50, 50, 100]);
  assert.equal(rowCells(out, 0).length, 3);
  assert.deepEqual(rowCells(out, 1).map((c) => c.cs), [2, 1]);
  assert.deepEqual(gridOf(out)[1], [3, 3, 4]);
  // The eraser on the new edge merges the two halves back, and the extra column goes.
  const back = eraseOp(out, 51, 10);
  assert.equal(back.op.kind, 'merge');
  assert.deepEqual(back.model.cols, [100, 100]);
  assert.equal(rowCells(back.model, 0).length, 2);
  assert.deepEqual(back.model.cells[0].src, [0]);
});

test('drawOp: an edge line sets a border, a corner-to-corner line a diagonal, Border Painter any edge', () => {
  const m = model(2, 2);
  assert.equal(drawOp(m, { x1: 99, y1: 2, x2: 99, y2: 18 }).op.kind, 'border');
  assert.deepEqual(drawOp(m, { x1: 1, y1: 1, x2: 99, y2: 19 }).op, { kind: 'diagonal', cell: 0, which: 'tl2br' });
  const paint = drawOp(m, { x1: 90, y1: 20, x2: 10, y2: 21 }, { paint: true }).op;
  assert.deepEqual([paint.edge.a, paint.edge.b], [{ id: 0, side: 'bottom' }, { id: 2, side: 'top' }]);
  assert.equal(eraseOp(m, 0, 10).op.kind, 'clear');
});

test('borderDrag: Shift resizes one column, Ctrl shares the change to the right, Ctrl+Shift evens the right columns', () => {
  assert.deepEqual(borderDrag([100, 100, 100], 0, 20, 'shift'), [120, 100, 100]);
  assert.deepEqual(borderDrag([100, 100, 300], 0, 40, 'ctrl'), [140, 90, 270]);
  assert.deepEqual(borderDrag([100, 100, 300], 0, 40, 'ctrlShift'), [140, 180, 180]);
});

// Convert Text to Table replaces everything from the first paragraph to the last, so a table between them disables it.
test('convertSource refuses a selection with a table between the paragraphs', async () => {
  const { Schema } = await import('@tiptap/pm/model');
  const { EditorState, AllSelection, TextSelection } = await import('@tiptap/pm/state');
  const { tableNodes } = await import('@tiptap/pm/tables');
  const { convertSource } = await import('../src/document/wp/table-tools/ops.js');
  const schema = new Schema({
    nodes: { doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*' }, text: {},
      ...tableNodes({ tableGroup: 'block', cellContent: 'block+' }) },
  });
  const p = (s) => schema.nodes.paragraph.create(null, schema.text(s));
  const { table, table_row: row, table_cell: cell } = schema.nodes;
  const mixed = schema.nodes.doc.create(null, [p('a,b'), table.create(null, row.create(null, cell.create(null, p('KEEP ME')))), p('c,d')]);
  const all = (doc) => EditorState.create({ doc, selection: new AllSelection(doc) });
  assert.equal(convertSource(all(mixed)), null);
  const plain = schema.nodes.doc.create(null, [p('a,b'), p('c,d')]);
  assert.deepEqual(convertSource(all(plain)).texts, ['a,b', 'c,d']);
  // A selection inside the first and last paragraphs counts the same.
  const sel = EditorState.create({ doc: mixed, selection: TextSelection.create(mixed, 2, mixed.content.size - 2) });
  assert.equal(convertSource(sel), null);
});

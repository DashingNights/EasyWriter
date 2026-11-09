import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { styleSheetCss } from '../src/document/stylesheet.js';
import { mergeSegments, mergeSlots } from '../src/document/table-view.js';

// blocks-pages (docs/plans/word/briefs/blocks-pages.md): the quick tables of the Word fixture's pages 162 to 168.
const schema = getSchema(documentExtensions(50));
const cell = (text, attrs = {}) => ({ type: 'tableCell', attrs, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined }] });

test('a merged cell splits into one segment per page: a row more than 4 px below the one above starts a new one', () => {
  const rows = [{ top: 0, bottom: 20 }, { top: 19, bottom: 40 }, { top: 39, bottom: 60 }, { top: 160, bottom: 180 }, { top: 179, bottom: 200 }];
  assert.deepEqual(mergeSegments(rows, 0, 4), [{ from: 0, to: 2, h: 60 }, { from: 3, to: 4, h: 40 }]);
  assert.deepEqual(mergeSegments(rows, 1, 2), [{ from: 1, to: 2, h: 41 }]);
  assert.deepEqual(mergeSegments(rows, 3, 9), [{ from: 3, to: 4, h: 40 }], 'rows past the table are left out');
});

test('each row below a merged cell gets a slot where the cell covers it, before the next cell (Calendar 4)', () => {
  // A 3 x 3 grid: the first column merged down rows 1 to 2, the last column merged down rows 0 to 1.
  const table = { type: 'table', content: [
    { type: 'tableRow', content: [cell('a'), cell('b'), cell('c', { rowspan: 2 })] },
    { type: 'tableRow', content: [cell('May', { rowspan: 2 }), cell('1')] },
    { type: 'tableRow', content: [cell('2'), cell('3')] },
  ] };
  const doc = schema.nodeFromJSON({ type: 'doc', content: [table] });
  const state = EditorState.create({ doc, plugins: [mergeSlots] });
  const slots = mergeSlots.getState(state).find().map((d) => ({ pos: d.from, key: d.spec.key }));
  const rows = [];
  doc.firstChild.forEach((row, off) => rows.push(1 + off));
  // Row 1: column 2 covered by c (row 0, cell index 2), at the row's end. Row 2: column 0 covered by May (row 1, index 0),
  // before cell 2.
  const row1End = rows[1] + doc.firstChild.child(1).nodeSize - 1;
  assert.deepEqual(slots.sort((a, b) => a.pos - b.pos), [{ pos: row1End, key: 'vm-0-2-1-true' }, { pos: rows[2] + 1, key: 'vm-1-0-1-true' }]);
  // A table without merged cells has none, and an edit elsewhere keeps the table's slots.
  const plain = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell('x')] }] }] });
  assert.equal(mergeSlots.getState(EditorState.create({ doc: plain, plugins: [mergeSlots] })).find().length, 0);
  const typed = state.apply(state.tr.insertText('z', rows[0] + 2));
  assert.equal(mergeSlots.getState(typed).find().length, 2);
});

test('a paragraph style in a cell wins over the table style where it sets its own values; repeating header rows take the first row', () => {
  const styles = { defaults: { para: { spacing: { after: 8 } } }, list: {
    Normal: { type: 'paragraph', name: 'Normal', para: { spacing: { after: 8 } } },
    DecimalAligned: { type: 'paragraph', name: 'Decimal Aligned', basedOn: 'Normal', para: { spacing: { after: 10 } } },
    Plain: { type: 'paragraph', name: 'Plain', basedOn: 'Normal' },
    Grid: { type: 'table', name: 'Grid', para: { spacing: { after: 0 } }, table: { cond: { firstRow: { run: { bold: true } } } } },
  } };
  const css = styleSheetCss('.s', styles, null);
  assert.match(css, /\.s td \[data-style="DecimalAligned"\]\[data-style\],\.s th \[data-style="DecimalAligned"\]\[data-style\]\{margin-bottom:10pt\}/);
  assert.doesNotMatch(css, /\[data-style="Plain"\]\[data-style\]/, 'a style that sets nothing of its own leaves the table style in charge');
  assert.match(css, /tr\[data-header\]:not\(tr:not\(\[data-header\]\) ~ tr\)/);
});

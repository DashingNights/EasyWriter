// Newspaper columns' pure rules (src/document/wp/columns/model.mjs): presets and limits, the More Columns arithmetic, the balance
// rule, Apply to scopes and the wrap and unwrap transform, column breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { defaultSect } from '../src/document/defaults.mjs';
import { withDefaults } from '../src/document/model/sections.mjs';
import { documentExtensions } from '../src/document/schema.js';
import {
  MIN_COL as MIN, applyColumns, applyToOptions, attrsOf, colBoxes, columnWidthAt, countError, equalCols, fillOf, insertColumnBreak, maxColumns, preset, presetOf, scopeOf,
  setCount, setEqual, setSpace, setWidth, stateOf, unitsOf,
} from '../src/document/wp/columns/model.mjs';
import { paperOf } from '../src/document/wp/page-engine/layout.mjs';
import { pxToPt } from '../src/office.mjs';

const schema = getSchema(documentExtensions(50));
const A4 = withDefaults(defaultSect('a4'));
const LETTER = withDefaults(defaultSect('letter'));
const T = pxToPt(paperOf(A4).text);
const P = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const COLS = (attrs, content) => ({ type: 'columns', attrs, content });
const SB = (kind) => ({ type: 'sectionBreak', attrs: { kind, sect: A4 } });
const doc = (content) => schema.nodeFromJSON({ type: 'doc', content });
/** The layout of each top-level block: 'p' text, 'cN' a columns node of N blocks with its count. */
const shape = (d) => {
  const out = [];
  d.forEach((n) => out.push(n.type.name === 'columns' ? `c${n.attrs.count}:${n.childCount}` : n.type.name === 'paragraph' ? n.textContent : n.type.name));
  return out.join(' | ');
};
/** `d` with the caret at the start of the text `at` (to the end of `to` for a range). */
const stateAt = (d, at, to) => {
  let a = null;
  let b = null;
  d.descendants((n, pos) => {
    if (!n.isText) return;
    if (a == null && n.text.includes(at)) a = pos + n.text.indexOf(at);
    if (to && b == null && n.text.includes(to)) b = pos + n.text.indexOf(to) + to.length;
  });
  return EditorState.create({ doc: d, selection: TextSelection.create(d, a, b ?? a) });
};
const run = (state, scope, attrs, opts) => {
  const tr = state.tr;
  const r = scopeOf(state.doc, unitsOf(state.doc), state.selection, scope);
  assert.ok(r, `scope ${scope}`);
  applyColumns(tr, r[0], r[1], attrs, opts);
  return tr;
};

test('preset widths on A4 and Letter: 207.65 and 126.4 pt on A4', () => {
  assert.ok(Math.abs(T - 451.3) < 0.01);
  assert.deepEqual(equalCols(T, 2).map((c) => c.w), [207.65, 207.65]);
  assert.ok(equalCols(T, 3).every((c) => Math.abs(c.w - 126.4) < 0.05));
  assert.deepEqual(equalCols(T, 2).map((c) => c.space), [36, 0]);
  const L = pxToPt(paperOf(LETTER).text);
  assert.equal(L, 468);
  assert.deepEqual(equalCols(L, 2).map((c) => c.w), [216, 216]);
  assert.deepEqual(preset('two', T), { count: 2, space: 36, equal: true, widths: null });
  assert.equal(preset('one', T), null);
  assert.equal(presetOf(null), 'one');
  assert.equal(presetOf(preset('three', T)), 'three');
});

test('Left and Right: two unequal columns, the narrow one about 30 percent on its side', () => {
  const left = preset('left', T);
  const right = preset('right', T);
  assert.equal(left.equal, false);
  assert.ok(Math.abs(left.widths[0].w / (T - 36) - 0.3) < 0.01);
  assert.ok(Math.abs(left.widths[0].w + left.widths[1].w + 36 - T) < 0.02);
  assert.deepEqual(right.widths.map((c) => c.w), [left.widths[1].w, left.widths[0].w]);
  assert.equal(presetOf(left), 'left');
  assert.equal(presetOf(right), 'right');
});

test('the column limit and its message', () => {
  assert.equal(maxColumns(T), 12);
  assert.equal(maxColumns(5000), 45);
  assert.equal(countError(12, T), null);
  assert.equal(countError(13, T), 'Enter a number of columns from 1 to 12.');
  assert.match(countError(0, T), /from 1 to 12/);
  // 12 columns do not fit 36 pt apart: the spacing narrows so each column keeps 36 pt.
  const twelve = equalCols(T, 12);
  assert.ok(twelve[0].space < 36 && twelve[0].w >= 36 - 0.01);
  assert.ok(Math.abs(twelve.reduce((s, c) => s + c.w + c.space, 0) - T) < 0.1);
});

test('the dialog recomputes when the count, a spacing, a width or the equal flag changes', () => {
  let st = stateOf(null, T);
  assert.equal(st.count, 1);
  st = setCount(st, 3, T);
  assert.equal(st.cols.length, 3);
  assert.ok(Math.abs(st.cols[0].w - 126.43) < 0.01);
  st = setSpace(st, 0, 72, T);
  assert.ok(st.cols.every((c, i) => c.space === (i < 2 ? 72 : 0)));
  assert.ok(Math.abs(st.cols[0].w - (T - 144) / 3) < 0.01);
  st = setWidth(st, 0, 100, T);
  assert.ok(st.cols.every((c) => c.w === 100), 'equal columns all follow column 1');
  assert.ok(Math.abs(st.cols[0].space - (T - 300) / 2) < 0.01);
  st = setEqual(st, false, T);
  st = setWidth(st, 0, 150, T);
  assert.equal(st.cols[0].w, 150);
  assert.ok(Math.abs(st.cols.reduce((s, c) => s + c.w + c.space, 0) - T) < 0.05, 'the last column takes the difference');
  st = setWidth(st, 0, 400, T);
  assert.ok(st.cols[2].w >= 36 - 0.01, 'no column under 36 pt');
  assert.deepEqual(attrsOf(st).widths.length, 3);
  st = setEqual(st, true, T);
  assert.equal(attrsOf(st).widths, null);
  assert.equal(attrsOf(setCount(st, 1, T)), null);
  assert.equal(setCount(st, 99, T).count, 12);
});

test('the balance rule: followed by text, at the end, before a page-starting break', () => {
  const c = COLS({ count: 2 }, [P('a')]);
  assert.equal(fillOf(doc([c, P('after')]), 0), 'balance');
  assert.equal(fillOf(doc([P('before'), c]), 1), 'fill');
  assert.equal(fillOf(doc([c, SB('continuous'), P('x')]), 0), 'balance');
  assert.equal(fillOf(doc([c, SB('nextPage'), P('x')]), 0), 'fill');
  assert.equal(fillOf(doc([c, SB('oddPage'), P('x')]), 0), 'fill');
  assert.equal(fillOf(doc([c, { type: 'pageBreak' }, P('x')]), 0), 'fill');
  // TrailingNode's empty last paragraph is the document's end.
  assert.equal(fillOf(doc([c, { type: 'paragraph' }]), 0), 'fill');
  assert.equal(fillOf(doc([c, { type: 'paragraph' }, P('x')]), 0), 'balance');
});

test('Two and Three on a narrow text width narrow the spacing, never drawing fewer columns than their count', () => {
  const three = preset('three', 150);
  assert.equal(three.count, 3);
  assert.equal(three.space, 21);
  assert.ok(3 * MIN + 2 * three.space <= 150 + 0.01);
  assert.equal(preset('three', 80).count, 2);
  assert.equal(preset('two', 50), null);
});

test('wrap and unwrap per Apply to', () => {
  const d = doc([P('one'), P('two'), P('three'), P('four'), SB('continuous'), P('five'), P('six')]);
  // Selected text: the blocks the selection touches.
  let tr = run(stateAt(d, 'two', 'three'), 'selected', preset('two', T));
  assert.equal(shape(tr.doc), 'one | c2:2 | four | sectionBreak | five | six');
  assert.equal(tr.selection.from < tr.selection.to && tr.doc.textBetween(tr.selection.from, tr.selection.to, '|'), 'two|three', 'the selection stays on its text');
  // One unwraps the same blocks; a partial unwrap splits the columns node.
  const st2 = EditorState.create({ doc: tr.doc, selection: TextSelection.create(tr.doc, tr.selection.from) });
  assert.equal(shape(run(st2, 'selected', null).doc), 'one | two | c2:1 | four | sectionBreak | five | six');
  // Whole document: each section's blocks, never the section break.
  assert.equal(shape(run(stateAt(d, 'one'), 'whole', preset('three', T)).doc), 'c3:4 | sectionBreak | c3:2');
  // This section and This point forward.
  assert.equal(shape(run(stateAt(d, 'six'), 'section', preset('two', T)).doc), 'one | two | three | four | sectionBreak | c2:2');
  assert.equal(shape(run(stateAt(d, 'three'), 'forward', preset('two', T)).doc), 'one | two | c2:2 | sectionBreak | five | six');
  // Start new column: a column break before the caret's block, inside the columns node it joins.
  const two = run(stateAt(d, 'one'), 'whole', preset('two', T)).doc;
  const nc = run(stateAt(two, 'three'), 'forward', preset('two', T), { newColumn: true }).doc;
  assert.equal(shape(nc), 'c2:5 | sectionBreak | c2:2');
  assert.equal(nc.child(0).child(2).type.name, 'columnBreak');
  // A different layout over part of a columns node keeps the rest in the old one; one undo step restores (one transaction).
  const mixed = run(stateAt(two, 'two', 'three'), 'selected', preset('three', T)).doc;
  assert.equal(shape(mixed), 'c2:1 | c3:2 | c2:1 | sectionBreak | c2:2');
  // A layout patches the attrs a block had: line between survives a preset.
  const sep = run(stateAt(d, 'one'), 'whole', { ...preset('two', T), sep: true }).doc;
  assert.equal(run(stateAt(sep, 'one'), 'whole', preset('three', T)).doc.child(0).attrs.sep, true);
});

test('Apply to choices follow the selection and the sections', () => {
  const d = doc([P('one'), SB('continuous'), P('two')]);
  assert.deepEqual(applyToOptions(d, stateAt(d, 'one').selection).map((o) => o[0]), ['section', 'forward', 'whole']);
  assert.deepEqual(applyToOptions(d, stateAt(d, 'one', 'one').selection).map((o) => o[0]), ['selected', 'whole']);
  assert.deepEqual(applyToOptions(d, stateAt(d, 'one', 'two').selection).map((o) => o[0]), ['sections', 'whole']);
  const single = doc([P('one')]);
  assert.deepEqual(applyToOptions(single, stateAt(single, 'one').selection).map((o) => o[0]), ['whole', 'forward']);
});

test('a column break splits the paragraph at the caret, only in top-level or column text', () => {
  const d = doc([COLS({ count: 2 }, [P('left right')])]);
  const st = stateAt(d, 'right');
  const tr = st.tr;
  assert.equal(insertColumnBreak(tr), true);
  assert.deepEqual(tr.doc.child(0).content.content.map((n) => n.type.name === 'paragraph' ? n.textContent : n.type.name), ['left ', 'columnBreak', 'right']);
  assert.equal(tr.selection.$from.parent.textContent, 'right');
  const tbl = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [P('cell')] }] }] }] });
  assert.equal(insertColumnBreak(stateAt(tbl, 'cell').tr), false);
});

test('column boxes for the ruler: equal columns as drawn, in px', () => {
  const text = (T * 4) / 3;
  const b = colBoxes(preset('two', T), text);
  assert.equal(b.length, 2);
  assert.ok(Math.abs(b[0].width - (207.65 * 4) / 3) < 0.02);
  assert.ok(Math.abs(b[1].left - ((207.65 + 36) * 4) / 3) < 0.02);
  assert.equal(colBoxes(null, text), null);
});

test('the text column at a position: its section\'s paper less the margins and a side gutter, or one column inside columns', () => {
  const wide = { ...LETTER, margin: { ...LETTER.margin, left: 108, right: 108 } }; // Letter with 1.5 inch margins: 396 pt
  const gutter = { ...LETTER, margin: { ...LETTER.margin, gutter: 36 } }; // 1 inch margins and a half inch gutter: 432 pt
  const landscape = { ...LETTER, w: 792, h: 612, orient: 'landscape' }; // 648 pt
  const ends = (sect) => ({ type: 'sectionBreak', attrs: { kind: 'nextPage', sect } }); // a break holds the sect of the section it ends
  const d = schema.nodeFromJSON({ type: 'doc', attrs: { sect: landscape }, content: [P('One'), ends(wide), P('Two'), ends(gutter),
    COLS({ count: 2, space: 36 }, [P('Three')]), ends(LETTER), P('Four')] });
  const at = (text) => stateAt(d, text).selection.from;
  assert.equal(columnWidthAt(d, at('One')), 528); // 396 pt
  assert.equal(columnWidthAt(d, at('Two')), 576); // 432 pt
  assert.equal(columnWidthAt(d, at('Three')), (624 - 48) / 2); // two columns of 468 pt with 36 pt between
  assert.equal(columnWidthAt(d, at('Four')), 864); // the last section, wider than the first
  const top = schema.nodeFromJSON({ ...d.toJSON(), attrs: { ...d.attrs, settings: { ...d.attrs.settings, gutterAtTop: true } } });
  assert.equal(columnWidthAt(top, at('Two')), 624); // a gutter at the top leaves the width alone
});

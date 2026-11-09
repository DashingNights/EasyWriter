import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { BUILTIN_STYLES } from '../src/document/defaults.mjs';
import { documentExtensions } from '../src/document/schema.js';
import {
  BODY, blocksOf, collapseStep, expandStep, firstLineOf, indentsOf, levelChanges, levelOf, moveGap, moveOrder, runEnd, shownOf, subtreeEnd,
  symbolOf,
} from '../src/document/wp/outline/levels.mjs';

// Outline view (docs/plans/word/plan.md §3 outline): levels, the tree, the shown set and the level and move rules.
const schema = getSchema(documentExtensions(50));
const t = (text) => [{ type: 'text', text }];
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: t(text) });
const p = (text, attrs = {}) => ({ type: 'paragraph', attrs, content: t(text) });
const STYLES = { list: BUILTIN_STYLES };
const doc = (content, attrs = { styles: STYLES }) => schema.nodeFromJSON({ type: 'doc', attrs, content });
const L = (...levels) => levels.map((level) => ({ level }));

test('levels come from the outline attribute, then the style chain, else body text', () => {
  const d = doc([h(1, 'A'), h(3, 'B'), p('C'), p('D', { outline: 4 }), p('E', { styleId: 'Heading8' }), h(2, 'F')]);
  assert.deepEqual(blocksOf(d).map((b) => b.level), [0, 2, BODY, 4, 7, 1]);
  // A document without style definitions still reads its headings by name.
  const bare = doc([h(2, 'A'), p('B', { styleId: 'Heading7' }), p('C')], {});
  assert.deepEqual(blocksOf(bare).map((b) => b.level), [1, 6, BODY]);
  // An outline attribute wins over the heading style.
  assert.equal(levelOf(d, schema.nodeFromJSON({ type: 'heading', attrs: { level: 1, outline: 3 }, content: t('x') })), 3);
  // A table counts as body text.
  const table = schema.nodeFromJSON({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('x')] }] }] });
  assert.equal(levelOf(d, table), BODY);
});

test('subtrees, symbols and indents', () => {
  const b = L(0, BODY, 1, BODY, 2, 1, 0);
  assert.deepEqual(b.map((_, i) => subtreeEnd(b, i)), [6, 2, 5, 4, 5, 6, 7]);
  assert.deepEqual(b.map((_, i) => symbolOf(b, i)), ['plus', 'body', 'plus', 'body', 'minus', 'minus', 'minus']);
  assert.deepEqual(indentsOf(b), [0, 1, 1, 2, 2, 1, 0]);
  assert.deepEqual(indentsOf(L(BODY, 0)), [0, 0], 'body text above every heading sits at the margin');
});

test('Show Level n and collapsed headings decide the shown set', () => {
  const b = L(0, BODY, 1, 2, BODY, 1, 0, BODY);
  assert.deepEqual(shownOf(b), b.map(() => true));
  assert.deepEqual(shownOf(b, { limit: 1 }), [true, false, true, false, false, true, true, false], 'Show Level 2 hides Heading 3 and body text');
  // A heading collapsed to its own level hides its whole subtree; Expand on another shows past the global limit.
  assert.deepEqual(shownOf(b, { limit: BODY, over: new Map([[2, 1]]) }), [true, true, true, false, false, true, true, true]);
  assert.deepEqual(shownOf(b, { limit: 0, over: new Map([[6, BODY]]) }), [true, false, false, false, false, false, true, true]);
  // A hidden heading's own limit does not show its subtree.
  assert.deepEqual(shownOf(b, { limit: 0, over: new Map([[2, BODY]]) }), [true, false, false, false, false, false, true, false]);
});

test('Expand shows the next hidden level and Collapse hides the lowest shown one', () => {
  const b = L(0, 1, 2, BODY, 1, 0);
  const view = { limit: 0, over: new Map() };
  assert.equal(expandStep(b, 0, view), 1);
  assert.equal(expandStep(b, 0, { limit: 0, over: new Map([[0, 1]]) }), 2);
  assert.equal(expandStep(b, 0, { limit: BODY, over: new Map() }), null, 'nothing more to show');
  assert.equal(collapseStep(b, 0, { limit: BODY, over: new Map() }), 2, 'body text hides first');
  assert.equal(collapseStep(b, 0, { limit: 2, over: new Map() }), 1);
  assert.equal(collapseStep(b, 0, { limit: 1, over: new Map() }), 0, 'then the whole subtree');
  assert.equal(collapseStep(b, 0, view), null, 'nothing under it shows');
});

test('Promote and Demote: body text, Heading 1, Heading 9 and the levels Word gives', () => {
  const b = L(0, BODY, 2, BODY, 8);
  assert.deepEqual([...levelChanges(b, [0], -1)], [], 'Promote on Heading 1 does nothing');
  assert.deepEqual([...levelChanges(b, [4], 1)], [], 'Demote on Heading 9 does nothing');
  assert.deepEqual([...levelChanges(b, [2], -1)], [[2, 1]]);
  assert.deepEqual([...levelChanges(b, [2], 1)], [[2, 3]]);
  assert.deepEqual([...levelChanges(b, [3], -1)], [[3, 2]], 'Promote on body text gives the level of the heading above');
  assert.deepEqual([...levelChanges(L(BODY), [0], -1)], [[0, 0]], 'with no heading above, Heading 1');
  assert.deepEqual([...levelChanges(b, [3], 1)], [], 'Demote leaves body text');
  assert.deepEqual([...levelChanges(b, [2, 3], -1)], [[2, 1]], 'a heading with its body text: the body text stays');
  assert.deepEqual([...levelChanges(b, [1, 2, 3], 0, 0)], [[1, 0], [2, 0], [3, 0]], 'Promote to Heading 1');
  assert.deepEqual([...levelChanges(b, [0, 1], 0, BODY)], [[0, BODY]], 'Demote to Body Text');
});

test('the outline attribute paragraph changes that attribute (setLevel through a transaction)', async () => {
  // The command module needs the app; this checks the rule's data: a paragraph with its own outline keeps its style.
  const d = doc([p('A', { outline: 2 })]);
  const state = EditorState.create({ schema, doc: d });
  const tr = state.tr.setNodeAttribute(0, 'outline', 1);
  assert.equal(levelOf(tr.doc, tr.doc.firstChild), 1);
  assert.equal(tr.doc.firstChild.type.name, 'paragraph');
});

test('Move Up and Move Down targets carry a collapsed subtree', () => {
  // 0 H1, 1 H2 (collapsed: 2 and 3 hidden), 2 H3, 3 body, 4 H2, 5 body
  const shown = [true, true, false, false, true, true];
  assert.equal(runEnd(shown, 1), 3);
  assert.equal(moveGap(shown, 1, 1, 1), 5, 'Move Down passes the next shown block');
  assert.equal(moveGap(shown, 4, 4, -1), 1, 'Move Up passes the previous shown block, its hidden subtree after the run');
  assert.equal(moveGap(shown, 0, 0, -1), null);
  assert.equal(moveGap(shown, 4, 5, 1), null);
  assert.deepEqual(moveOrder(1, 3, 5), { lo: 1, hi: 4, order: [4, 1, 2, 3] });
  assert.deepEqual(moveOrder(4, 4, 1), { lo: 1, hi: 4, order: [4, 1, 2, 3] });
  assert.equal(moveOrder(1, 3, 2), null, 'a gap inside the run moves nothing');
});

// Suggestion records ride on the same node attributes (the kit adds `suggest`); the harness case checks them in the app.
test('a move is one replace step that keeps list numbering with its paragraphs', () => {
  const d = doc([h(1, 'A'), h(2, 'B'), p('b1', { numbering: { numId: 1, ilvl: 0 } }), h(2, 'C'), p('c1')]);
  const state = EditorState.create({ schema, doc: d });
  const blocks = blocksOf(d);
  const plan = moveOrder(1, 2, 5);
  const tr = state.tr.replaceWith(blocks[plan.lo].pos, blocks[plan.hi].end, plan.order.map((i) => blocks[i].node));
  assert.equal(tr.steps.length, 1);
  assert.deepEqual(tr.doc.content.content.map((n) => n.textContent), ['A', 'C', 'c1', 'B', 'b1']);
  const moved = tr.doc.child(4);
  assert.deepEqual(moved.attrs.numbering, { numId: 1, ilvl: 0 });
});

test('Show First Line Only shortens body text paragraphs only', () => {
  const d = doc([h(1, 'A'), p('long body'), h(2, 'B')]);
  assert.deepEqual(firstLineOf(blocksOf(d), true), [false, true, false]);
  assert.deepEqual(firstLineOf(blocksOf(d), false), [false, false, false]);
});

test('a collapsed heading keeps its limit through a level change, its undo, a move and the move undone', async () => {
  const { remapOver } = await import('../src/document/wp/outline/plugin.js');
  const d = doc([h(1, 'A'), h(2, 'B'), p('b1'), h(2, 'C'), p('c1')]);
  const state = EditorState.create({ schema, doc: d });
  const blocks = blocksOf(d);
  const over = new Map([[blocks[1].pos, 1]]);
  // Promote B: setNodeMarkup rewraps it in place.
  const promote = state.tr.setNodeMarkup(blocks[1].pos, schema.nodes.heading, { ...blocks[1].node.attrs, level: 1 });
  assert.deepEqual([...remapOver(over, promote)], [[blocks[1].pos, 1]]);
  const undo = EditorState.create({ schema, doc: promote.doc }).tr.step(promote.steps[0].invert(d));
  assert.deepEqual([...remapOver(over, undo)], [[blocks[1].pos, 1]]);
  // Move B's subtree below C's, then undo it: the limit follows the same node object back.
  const plan = moveOrder(1, 3, 5);
  const move = state.tr.replaceWith(blocks[plan.lo].pos, blocks[plan.hi].end, plan.order.map((i) => blocks[i].node));
  const back = EditorState.create({ schema, doc: move.doc }).tr.step(move.steps[0].invert(d));
  const afterMove = remapOver(over, move);
  assert.equal(move.doc.nodeAt([...afterMove.keys()][0]).textContent, 'B');
  assert.deepEqual([...remapOver(afterMove, back)], [[blocks[1].pos, 1]]);
  // Deleting B drops its limit.
  assert.equal(remapOver(over, state.tr.delete(blocks[1].pos, blocks[1].end)).size, 0);
});

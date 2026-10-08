import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockKind, paletteSections, rankTool } from '../src/app/tool-rank.mjs';

// A slice of the registry (src/app/tools.js) in registry order; the palette sorts by score, ties keep this order.
const TOOLS = [
  ['Pen', ['draw', 'brush', 'pencil', 'freehand', 'red', 'colour', 'color']],
  ['Eraser', ['erase', 'rubber', 'remove stroke', 'erasor']],
  ['Shape', ['shapes', 'draw shape', 'rectangle']],
  ['Box', ['rectangle', 'square']],
  ['Circle', ['ellipse', 'oval', 'round']],
  ['Bold', ['strong', 'thick']],
  ['Text colour', ['colour', 'color', 'font colour', 'red', 'blue']],
  ['Heading 1', ['h1', 'title', 'heading']],
  ['Heading 2', ['h2', 'title', 'subheading', 'heading']],
  ['Bullet list', ['unordered', 'dots', 'points', 'list']],
  ['Redo', ['again', 'repeat']],
];

const ranked = (q, tools = TOOLS) => tools
  .map(([label, keywords]) => [label, rankTool(q, label, keywords)])
  .filter(([, score]) => score > 0)
  .sort((a, b) => b[1] - a[1])
  .map(([label]) => label);

test('an exact or prefix label match beats a keyword match', () => {
  assert.equal(ranked('pen')[0], 'Pen');
  assert.equal(ranked('circle')[0], 'Circle');
  assert.equal(ranked('bol')[0], 'Bold');
  assert.equal(ranked('Shape')[0], 'Shape');
});

test('keywords find the tool', () => {
  assert.equal(ranked('h2')[0], 'Heading 2');
  assert.equal(ranked('draw')[0], 'Pen');
  assert.equal(ranked('erasor')[0], 'Eraser');
  assert.equal(ranked('dots')[0], 'Bullet list');
  assert.equal(ranked('COLOR')[0], 'Pen'); // registry order: board tools come first
});

test('a whole synonym beats a label that only starts with the query', () => {
  const text = TOOLS.filter(([l]) => l !== 'Pen'); // text mode: no pen
  assert.deepEqual(ranked('red', text).slice(0, 2), ['Text colour', 'Redo']);
  assert.equal(ranked('red')[0], 'Pen');
});

test('fuzzy: letters in order, misses score 0', () => {
  assert.equal(ranked('bld')[0], 'Bold');
  assert.deepEqual(ranked('bol'), ['Bold']); // not "b…o…l" across a keyword such as "block style"
  assert.equal(rankTool('zzz', 'Bold', ['strong']), 0);
  assert.ok(rankTool('', 'Bold') > 0);
});

// A node-selected block (SPEC §7c): its section, then Suggested, then the groups with the other entries.
test('a selected block: its actions first (the main one first), then Suggested, then the groups', () => {
  const e = (id, group) => ({ id, group, label: id, keywords: [] });
  const entries = [e('flowchart', 'Insert'), e('canvas-delete', 'Item'), e('canvas-edit', 'Item'), e('undo', 'Edit'),
    e('flow-library-open', 'Flowchart'), e('flow-new', 'Flowchart'), e('settings', 'App'), e('assistant', 'App')];
  const shown = (o) => paletteSections(entries, o).filter(([, list]) => list.length).map(([heading, list]) => [heading, list.map((x) => x.id)]);
  assert.deepEqual(shown({ block: 'flowchart' }), [
    ['Flowchart canvas', ['canvas-edit', 'canvas-delete']], ['Suggested', ['flow-library-open', 'assistant']],
    ['Insert', ['flowchart']], ['Edit', ['undo']], ['Flowchart', ['flow-new']], ['App', ['settings']],
  ]);
  assert.deepEqual(shown({}).map(([heading]) => heading), ['Insert', 'Item', 'Edit', 'Flowchart', 'App']); // nothing selected
  assert.equal(paletteSections(entries, { block: 'planChart' })[0][0], 'Plan chart');
});

test('blockKind: what the palette calls a node-selected block', () => {
  assert.equal(blockKind('canvas', { flow: { id: 'f1', rev: 1 }, items: [] }), 'flowchart');
  assert.equal(blockKind('canvas', { items: [{ type: 'shape', shape: 'rect' }, { type: 'connector' }] }), 'flowchart');
  assert.equal(blockKind('canvas', { items: [{ type: 'image' }] }), 'image');
  assert.equal(blockKind('canvas', { items: [{ type: 'image' }, { type: 'text' }] }), 'canvas');
  assert.deepEqual(['planChart', 'whiteboard', 'table', 'horizontalRule'].map((t) => blockKind(t, {})), ['planChart', 'whiteboard', null, null]);
});

test('tie-break: the block section, then Suggested, then the rest; match quality first', () => {
  assert.ok(rankTool('del', 'Delete', ['remove'], 'block') > rankTool('del', 'Delete board', ['remove board']));
  assert.ok(rankTool('open', 'Open in library', [], 'block') > rankTool('open', 'Open plan board', [], 'suggested'));
  assert.ok(rankTool('open', 'Open plan board', [], 'suggested') > rankTool('open', 'Open plan board', []));
  assert.ok(rankTool('assistant', 'Assistant', []) > rankTool('assistant', 'Edit', ['assistant help'], 'block')); // exact label wins
});

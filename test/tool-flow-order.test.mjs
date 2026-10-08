import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowchartMode, rankTool } from '../src/app/tool-rank.mjs';

// Flowchart mode (SPEC §7c): a slice of the registry in registry order (basic shapes before flowchart kinds), [label,
// keywords, category]; the palette sorts by score, ties keep this order.
const TOOLS = [
  ['Select', ['pointer', 'move'], undefined],
  ['Pen', ['draw', 'write', 'stroke'], undefined],
  ['Box', ['rectangle', 'square', 'process'], 'basic'],
  ['Rounded box', ['rounded rectangle', 'pill', 'button'], 'basic'],
  ['Circle', ['ellipse', 'oval', 'round'], 'basic'],
  ['Terminator', ['start', 'end', 'stop', 'pill'], 'flowchart'],
  ['Data', ['input', 'output', 'parallelogram'], 'flowchart'],
  ['Data (reversed)', ['input', 'output', 'parallelogram'], 'flowchart'],
  ['Database', ['db', 'cylinder', 'storage'], 'flowchart'],
  ['On-page connector', ['connector', 'reference', 'circle'], 'flowchart'],
  ['Add text', ['text', 'write', 'label', 'note'], 'text'],
  ['Connector labels', ['label', 'text', 'caption'], 'text'],
  ['Connector', ['arrow', 'link', 'edge'], undefined],
  ['Copy as Mermaid', ['mermaid', 'text', 'export'], undefined],
];

const ranked = (q, flow) => TOOLS
  .map(([label, keywords, category]) => [label, rankTool(q, label, keywords, flow ? category : undefined)])
  .filter(([, score]) => score > 0)
  .sort((a, b) => b[1] - a[1])
  .map(([label]) => label);

test('flowchart mode: match quality first, then flowchart > text > basic > rest on equal quality', () => {
  assert.equal(ranked('data', true)[0], 'Data');
  assert.deepEqual(ranked('circle', true).slice(0, 2), ['Circle', 'On-page connector']); // exact label beats the keyword
  assert.deepEqual(ranked('text', true), ['Add text', 'Connector labels', 'Copy as Mermaid']);
  assert.deepEqual(ranked('pill', true), ['Terminator', 'Rounded box']);
  assert.deepEqual(ranked('pill', false), ['Rounded box', 'Terminator']);
  assert.deepEqual(ranked('write', true), ['Add text', 'Pen']);
  assert.deepEqual(ranked('write', false), ['Pen', 'Add text']); // outside flowchart mode: registry order
});

test('flowchartMode: the library editor, or a canvas that is a flowchart', () => {
  const shape = (kind) => ({ type: 'shape', shape: kind });
  assert.equal(flowchartMode({ type: 'flows', flowId: 'f1' }, null), true);
  assert.equal(flowchartMode({ type: 'flows', flowId: null }, null), false); // the library list
  assert.equal(flowchartMode({ type: 'editor' }, null), false); // the document, a whiteboard
  const ed = { type: 'editor' };
  assert.equal(flowchartMode(ed, { flow: { id: 'f1', rev: 3 }, items: [] }), true); // synced
  assert.equal(flowchartMode(ed, { source: { format: 'mermaid', text: 'graph TD' }, items: [] }), true); // imported
  assert.equal(flowchartMode(ed, { items: [shape('rect'), { type: 'connector' }] }), true);
  assert.equal(flowchartMode(ed, { items: [shape('rect'), shape('diam')] }), true); // Decision: a flowchart kind
  assert.equal(flowchartMode(ed, { items: [shape('rect'), shape('ellipse'), shape('frame'), { type: 'text' }] }), false);
  assert.equal(flowchartMode(ed, { flow: null, source: null }), false);
});

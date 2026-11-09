// insert-shapes-in-canvas (docs/plans/word/briefs/insert-shapes-in-canvas.md): with a drawing canvas edited or selected, every
// Insert Shapes entry arms the canvas board's tool for it; a one-shape canvas and no canvas leave Insert Shapes as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHAPE_KINDS } from '../src/flow/shapes.mjs';
import { defaultLooks, SHAPE_MAP, toolLook } from '../src/document/wp/shapes/map.mjs';
import { armTool, LINE_KINDS } from '../src/tooling/shape-picker.mjs';
import { boardTool, drawIn } from '../src/document/wp/shapes/target.js';

/** A stand-in board that records what armTool set. */
const fakeBoard = () => {
  const b = { calls: [] };
  for (const m of ['setShapeTool', 'setConnTool', 'setMode']) b[m] = (x) => b.calls.push([m, x]);
  return b;
};

test('each Insert Shapes entry has the board tool that draws it', () => {
  assert.deepEqual(boardTool('Oval'), { kind: 'ellipse' });
  assert.deepEqual(boardTool('Connector: Elbow Arrow'), { line: 'Connector: Elbow Arrow' });
  assert.deepEqual(['Curve', 'Freeform: Shape', 'Freeform: Scribble'].map((n) => boardTool(n).line), ['Curve', 'Freeform: Shape', 'Freeform: Scribble']);
  assert.deepEqual(boardTool('Vertical Text Box'), { textBox: true, vertical: true });
  assert.equal(boardTool('No Such Shape'), null);
  // Every kind an entry arms has its board command (pool-board.js kindCommand: every kind but the line kinds).
  const kinds = new Set(SHAPE_KINDS.filter((k) => !LINE_KINDS[k.kind]).map((k) => k.kind));
  assert.deepEqual(Object.keys(SHAPE_MAP).filter((n) => !boardTool(n)), [], 'every entry arms a board tool');
  assert.deepEqual(Object.keys(SHAPE_MAP).map((n) => boardTool(n).kind).filter((k) => k && !kinds.has(k)), []);
});

test('armTool arms the tool the rail and keys arm', () => {
  let b = fakeBoard();
  armTool(b, { line: 'Connector: Elbow Arrow' });
  assert.deepEqual(b.calls, [['setConnTool', { route: 'ortho', heads: { start: 'none', end: 'arrow' } }], ['setMode', 'connector']]);
  b = fakeBoard();
  armTool(b, { line: 'Curve' });
  assert.deepEqual(b.calls, [['setMode', 'curve']]);
  b = fakeBoard();
  armTool(b, { kind: 'ellipse' });
  assert.deepEqual(b.calls, [['setShapeTool', { shape: 'ellipse' }], ['setMode', 'shape']]);
});

test('a text box in a canvas takes the default text box look: Word\'s, or the one Set as Default Text Box gave', () => {
  const word = toolLook(defaultLooks(), 'textbox');
  assert.equal(word.shape, 'rect');
  assert.equal(word.html, '', 'a text box: a shape with text');
  assert.equal(word.autoFit, false);
  assert.equal(word.fill, 'solid');
  assert.equal(word.fillColor.toUpperCase(), '#FFFFFF', 'Background 1');
  assert.equal(word.color.toUpperCase(), '#000000');
  assert.equal(word.width, 0.6667, 'a 1/2 pt line (0.5 pt in CSS px)');
  assert.equal(word.themeColors.fillColor.attrs.val, 'bg1');
  const own = toolLook(defaultLooks({ objectDefaults: { txDef: { fill: null, line: { color: '#C00000', width: 2, dash: 'dashed' } } } }), 'textbox');
  assert.deepEqual([own.fill, own.fillColor, own.color, own.width, own.dash], ['none', undefined, '#C00000', 2.6667, 'dashed']);
});

test('no canvas edited or selected, or a selected one-shape canvas: nothing is drawn in a canvas', () => {
  assert.equal(drawIn({}, 'Oval'), false);
  const attrs = { w: 100, h: 100, dw: 100, frame: { x: 0, y: 0, w: 100, h: 100, item: 'a' }, bg: 'transparent', items: [{ id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 100, h: 100 }] };
  const view = { nodeDOM: () => ({ scView: { node: { type: { name: 'canvas' }, attrs } } }) };
  assert.equal(drawIn({ obj: { kind: 'canvas', pos: 3 }, ed: { view } }, 'Oval'), false);
});

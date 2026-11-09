// Shapes' pure map (docs/plans/word/briefs/shapes.md Acceptance): every Word shape name maps to a board kind or a connector, and
// the outline and style lists hold Word's entries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DASHES, HEADS } from '../src/flow/model.mjs';
import { kindOf } from '../src/flow/shapes.mjs';
import { changedShape, DASH_MAP, dragBox, fitItems, HEAD_MAP, SHAPE_GROUPS, SHAPE_MAP, shapeItem, styleGallery, WEIGHTS } from '../src/document/wp/shapes/map.mjs';

// Word's gallery: Lines (connectors and the board's curve, freeform and pen tools), then the shared shape gallery (src/flow/gallery.mjs) with the two text box tools at
// the head of Basic Shapes; every shape is a DrawingML preset drawn by its own geometry, so none is lossy.
const TOOLS = { 'Text Box': 'textBox', 'Vertical Text Box': 'verticalTextBox', Curve: 'curve', 'Freeform: Shape': 'freeform', 'Freeform: Scribble': 'pen' };

test('every Word shape maps to the kind that draws its preset, a connector or its tool', () => {
  const names = SHAPE_GROUPS.flatMap(([, n]) => n);
  assert.equal(names.length, Object.keys(SHAPE_MAP).length, 'each name in one group');
  for (const name of names) {
    const m = SHAPE_MAP[name];
    assert.ok(m, name);
    if (TOOLS[name]) assert.equal(m.tool, TOOLS[name], name);
    else if (m.conn) assert.ok(['straight', 'ortho', 'curve'].includes(m.conn.route) && HEADS.includes(m.conn.heads.end), name);
    else assert.equal(kindOf(m.kind)?.prst, m.prst, name + ' -> ' + m.kind);
  }
  assert.deepEqual(SHAPE_GROUPS.map(([g]) => g), ['Lines', 'Rectangles', 'Basic Shapes', 'Block Arrows', 'Equation Shapes', 'Flowchart', 'Stars and Banners', 'Callouts']);
});

test('named mappings', () => {
  assert.equal(SHAPE_MAP.Rectangle.kind, 'rect');
  assert.equal(SHAPE_MAP.Oval.kind, 'ellipse');
  assert.equal(SHAPE_MAP['Flowchart: Decision'].kind, 'diam');
  assert.equal(SHAPE_MAP['Flowchart: Terminator'].kind, 'stadium');
  assert.deepEqual(SHAPE_MAP['Arrow: Down'], { kind: 'downArrow', prst: 'downArrow' });
  const la = shapeItem('Line Arrow', { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(la.type, 'connector');
  assert.equal(la.heads.end, 'arrow');
});

test('a click gives a 72 pt (96 px) square; Change Shape keeps the colours', () => {
  const r = shapeItem('Rectangle');
  assert.equal(r.shape, 'rect');
  assert.deepEqual([r.w, r.h], [96, 96]);
  const o = changedShape({ ...r, fillColor: '#FF0000' }, 'Oval');
  assert.equal(o.shape, 'ellipse');
  assert.equal(o.fillColor, '#FF0000');
  assert.equal(changedShape(r, 'Line'), null);
});

test('fitItems moves the item to 0,0 and binds the frame to it', () => {
  const f = fitItems([shapeItem('Rectangle', { x: 100, y: 100, w: 120, h: 80 })]);
  assert.deepEqual([f.w, f.h, f.items[0].x, f.items[0].y, f.frame.item], [120, 80, 0, 0, f.items[0].id]);
  assert.deepEqual([fitItems([shapeItem('Oval', { x: 5, y: 5, w: 10, h: 10 })]).w], [40]);
});

test('dragBox: Shift squares, Ctrl draws from the centre', () => {
  assert.deepEqual(dragBox({ x: 100, y: 100 }, { x: 220, y: 180 }), { x: 100, y: 100, w: 120, h: 80, flipX: false, flipY: false });
  assert.equal(dragBox({ x: 0, y: 0 }, { x: 50, y: 20 }, { square: true }).h, 50);
  assert.deepEqual(dragBox({ x: 100, y: 100 }, { x: 120, y: 110 }, { centre: true }), { x: 80, y: 90, w: 40, h: 20, flipX: false, flipY: false });
});

test('outline lists', () => {
  assert.deepEqual(WEIGHTS, [0.25, 0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6]);
  assert.deepEqual(Object.values(DASH_MAP).map(([l]) => l), ['Solid', 'Round Dot', 'Square Dot', 'Dash', 'Dash Dot', 'Long Dash', 'Long Dash Dot', 'Long Dash Dot Dot']);
  for (const [, d] of Object.values(DASH_MAP)) assert.ok(DASHES.includes(d));
  for (const h of Object.values(HEAD_MAP)) assert.ok(HEADS.includes(h.start) && HEADS.includes(h.end));
});

test('styleGallery has a row per accent', () => {
  for (const theme of ['dark', 'light']) {
    const g = styleGallery(theme);
    assert.deepEqual([...new Set(g.map((s) => s.group))], [1, 2, 3, 4, 5, 6].map((n) => 'Accent ' + n));
    assert.ok(g.every((s) => /^#[0-9a-f]{6}$/i.test(s.patch.color)));
  }
});

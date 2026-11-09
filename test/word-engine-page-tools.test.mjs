// engine-page-tools (docs/plans/engine/stage2b.md): the page tools' pure parts and their rows on the Documents table.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dragBox } from '../src/document/canvas/tools/shapes.js';
import { dragCrop, sourceOf } from '../src/document/canvas/tools/pictures.js';
import { snapToEdge, strokeOf } from '../src/document/canvas/tools/ink.js';
import { activeTool, noteTool } from '../src/document/canvas/tools/state.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { OBJECTS } from '../src/document/canvas/rows/objects.mjs';
import { PAGE } from '../src/document/canvas/rows/page.mjs';

test('the crosshair box: Shift keeps it square, Ctrl draws from the centre, a line turns in 45 degree steps', () => {
  assert.deepEqual(dragBox({ x: 10, y: 10 }, { x: 50, y: 30 }), { x: 10, y: 10, w: 40, h: 20, flipH: false, flipV: false });
  assert.deepEqual(dragBox({ x: 10, y: 10 }, { x: 50, y: 30 }, { square: true }), { x: 10, y: 10, w: 40, h: 40, flipH: false, flipV: false });
  assert.deepEqual(dragBox({ x: 50, y: 50 }, { x: 60, y: 70 }, { centre: true }), { x: 40, y: 30, w: 20, h: 40, flipH: false, flipV: false });
  const l = dragBox({ x: 0, y: 0 }, { x: 100, y: 10 }, { square: true, line: true });
  assert.ok(Math.abs(l.h) < 1e-9 && Math.abs(l.w - Math.hypot(100, 10)) < 1e-9, JSON.stringify(l));
  assert.equal(dragBox({ x: 50, y: 0 }, { x: 10, y: 20 }).flipH, true);
});

test('crop handles: a dragged edge crops by what it moves and stops at the source and the 5 percent floor', () => {
  const f = { x: 100, y: 100, w: 80, h: 40 };
  const s = sourceOf(f, [0, 0, 0, 0]);
  assert.deepEqual(s, { x: 100, y: 100, w: 80, h: 40 });
  const r = dragCrop(f, s, { r: 1 }, { x: 160, y: 0 });
  assert.deepEqual(r.frame, { x: 100, y: 100, w: 60, h: 40 });
  assert.deepEqual(r.crop.map((v) => Math.round(v * 1000) / 1000), [0, 0, 0.25, 0]);
  // Back out past the source edge: no more than uncropped.
  assert.equal(dragCrop(f, s, { r: 1 }, { x: 400, y: 0 }).frame.w, 80);
  assert.ok(dragCrop(f, s, { l: 1 }, { x: 999, y: 0 }).frame.w >= 0.05 * 80 - 1e-9);
  // A cropped picture's source reaches past its visible frame.
  assert.deepEqual(sourceOf({ x: 100, y: 100, w: 60, h: 40 }, [0, 0, 0.25, 0]), { x: 100, y: 100, w: 80, h: 40 });
});

test('the stencil ruler snaps a stroke whose ends lie on its edge, and pens become draw.stroke params', () => {
  const edge = { a: { x: 0, y: 100 }, b: { x: 400, y: 100 } };
  assert.deepEqual(snapToEdge([[10, 103], [50, 96], [90, 101]], edge), [[10, 100], [90, 100]]);
  assert.equal(snapToEdge([[10, 130], [90, 101]], edge), null);
  assert.deepEqual(strokeOf({ kind: 'highlighter', color: '#ffff00', width: 6 }), { tool: 'highlighter', color: 'FFFF00', width: 17.01 });
  assert.equal(strokeOf({ kind: 'brushPen', color: '#000000', width: 2 }).tool, 'pen');
});

test('the tool now on is noted by name, and only its own end clears it', () => {
  const a = {};
  const b = {};
  noteTool('crop', a);
  noteTool('editPoints', b);
  assert.equal(noteTool(null, a), false);
  assert.equal(activeTool(), 'editPoints');
  assert.equal(noteTool(null, b), true);
  assert.equal(activeTool(), null);
});

test('the page tools\' rows run on a canvas draft (none off)', () => {
  const ids = ['insert.illustrations.shapes', 'insert.text.textBox.drawHorizontalTextBox', 'shapeFormat.insertShapes.editShape.editPoints',
    'shapeFormat.insertShapes.editShape.rerouteConnectors', 'pictureFormat.adjust.color.setTransparentColor', 'pictureFormat.size.crop',
    'pictureFormat.size.crop.crop', 'graphicsFormat.arrangeSize.crop', 'draw.drawingTools.drawingTools', 'draw.stencils.ruler', 'draw.replay.inkReplay',
    'layout.arrange.wrapText.editWrapPoints', 'layout.arrange.align.distributeHorizontally', 'layout.arrange.align.distributeVertically',
    'layout.arrange.align.viewGridlines', 'view.show.gridlines', 'layout.arrange.align.gridSettings', 'home.editing.select.selectObjects', 'pictures.objectLayer'];
  for (const id of ids) assert.notEqual(formOf(OBJECTS[id]), 'off', id);
  for (const id of ['insert.tables.table.drawTable', 'tableLayout.draw.drawTable', 'tableLayout.draw.eraser', 'tableDesign.borders.borderPainter',
    'tableDesign.borders.borderStyles.borderSampler', 'tableLayout.table.viewGridlines', 'view.show.ruler']) assert.notEqual(formOf(PAGE[id]), 'off', id);
});

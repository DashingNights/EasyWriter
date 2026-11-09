// engine-cmd-objects (docs/plans/engine/stage2.md S2): the Objects rows' argument mapping, which no harness check reads directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import {
  OBJECTS, aspectCrop, colorOf, correctionOf, hexOf, positionItem, positionOf, shapeSteps, wordArtOf,
} from '../src/document/canvas/rows/objects.mjs';

test('every Objects row is one of the row forms', () => {
  const bad = Object.entries(OBJECTS).filter(([, row]) => !formOf(row)).map(([id]) => id);
  assert.deepEqual(bad, []);
  assert.ok(Object.keys(OBJECTS).length >= 225);
});

test("Insert > Shapes maps Word's names to the engine (presets, lines, text boxes)", () => {
  assert.deepEqual(shapeSteps('Rectangle'), [['insert.shape', { kind: 'rectangle' }]]);
  assert.deepEqual(shapeSteps('Hexagon'), [['insert.shape', { kind: 'rectangle' }], ['shape.change', { preset: 'hexagon' }]]);
  assert.deepEqual(shapeSteps('Line Arrow: Double'), [['insert.shape', { kind: 'line', arrow: 'both' }]]);
  assert.deepEqual(shapeSteps('Vertical Text Box')[1], ['shape.textDirection', { dir: 'eaVert' }]);
  assert.equal(shapeSteps('No Such Shape'), null);
});

test('gallery ids convert to the engine forms', () => {
  assert.equal(hexOf('#c00000'), 'C00000');
  assert.equal(hexOf({ color: '#1F4E79' }), '1F4E79');
  assert.equal(hexOf(null), null);
  assert.deepEqual(wordArtOf('wa7'), { style: 'outlined', fill: '156082' });
  assert.equal(wordArtOf('wa31'), null);
  assert.deepEqual(correctionOf('soften25'), { sharpen: -25 });
  assert.deepEqual(correctionOf('b-20c40'), { brightness: -20, contrast: 40 });
  assert.deepEqual(colorOf('sat33'), { mode: 'saturation', saturation: 33 });
  assert.deepEqual(colorOf('tone4700'), { mode: 'tone', temperature: 4700 }); // engine-gaps-pictures: every recolour has a form
  assert.equal(positionOf('positionInMiddleRightWithSquareTextWrapping'), 'middleRight');
});

test('the Position gallery reads object.get back', () => {
  const o = (pos, extra = {}) => ({ floating: true, wrap: 'square', position: { hRel: 'margin', vRel: 'margin', ...pos }, ...extra });
  assert.equal(positionItem(o({ hAlign: 'center', vAlign: 'bottom' })), 'positionInBottomCenterWithSquareTextWrapping');
  assert.equal(positionItem(o({ hAlign: 'left', vAlign: 'top' }, { wrap: 'tight' })), null);
  assert.equal(positionItem({ floating: false }), 'inLineWithText');
});

test('Crop to an aspect ratio crops centred at the largest area', () => {
  // A 2:1 picture shown 40 x 20, cropped to 1:1: a quarter off each side, shown 40 x 40.
  const o = { w: 40, h: 20, picture: { crop: [0, 0, 0, 0], original: { w: 4, h: 2 } } };
  assert.deepEqual(aspectCrop(o, 1, 1), { left: 0.25, right: 0.25, top: 0, bottom: 0, width: 40, height: 40 });
  assert.equal(aspectCrop({ w: 1, h: 1, picture: {} }, 1, 1), null);
});

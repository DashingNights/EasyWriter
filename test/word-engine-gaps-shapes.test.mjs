// engine-gaps-shapes (docs/plans/engine/stage2b.md): the pure halves of the canvas rows: Fill Effects' fills as the engine's params
// and back, the Layout dialog's engine steps, and Shape Styles as one undo step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogFill, engineFill, gradientParams, stopColor } from '../src/document/wp/page-background/engine-fill.mjs';
import { layoutSteps, stateOfObject } from '../src/document/wp/float-layout/engine-layout.mjs';
import { OBJECTS, shapeStyleSteps } from '../src/document/canvas/rows/objects.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';

test('Fill Effects fills become the engine\'s params and open again from them', async () => {
  assert.deepEqual(stopColor('rgba(255, 0, 16, 0.25)'), ['FF0010', 75]);
  const g = gradientParams({ kind: 'gradient', colors: 'two', color1: '#112233', color2: '#FFFFFF', style: 'vertical', variant: 2 });
  assert.equal(g.gradient.type, 'linear');
  assert.equal(g.gradient.angle, 0);
  assert.deepEqual(g.gradient.stops.map((s) => s.color), ['112233', 'FFFFFF', '112233']);
  assert.deepEqual(gradientParams({ kind: 'gradient', colors: 'one', color1: '#000000', style: 'fromCorner', variant: 3 }).gradient.focus, [100, 100, 0, 0]);
  assert.deepEqual(await engineFill({ kind: 'pattern', pattern: 'dkDnDiag', fg: '#C00000', bg: '#ffff00' }), { pattern: { preset: 'dkDnDiag', fg: 'C00000', bg: 'FFFF00' } });
  assert.deepEqual(await engineFill({ kind: 'picture', src: 'data:image/png;base64,AAAA' }), { picture: { data: 'AAAA', tile: false } });
  // A texture of our own needs a browser to draw it; Other Texture's picture does not.
  assert.equal(await engineFill({ kind: 'texture', texture: 'canvas' }), null);
  assert.deepEqual(await engineFill({ kind: 'texture', src: 'data:image/png;base64,BBBB' }), { picture: { data: 'BBBB', tile: true } });
  assert.equal(dialogFill({ pattern: { preset: 'pct5', fg: '000000', bg: 'FFFFFF' } }).pattern, 'pct5');
  assert.equal(dialogFill({ picture: { media: 'm', tile: true, title: 'canvas' } }).texture, 'canvas');
  assert.equal(dialogFill({ gradient: { stops: [{ color: '112233' }, { color: 'FFFFFF' }], kind: { type: 'linear', angle: 0 } } }).style, 'vertical');
  assert.equal(dialogFill({ color: 'FF0000' }), null);
  // From corner opens on its own corner; a rectangular gradient from a file opens as From center.
  const two = [{ color: '112233' }, { color: 'FFFFFF' }];
  for (const v of [0, 1, 2, 3]) {
    const g = gradientParams({ kind: 'gradient', colors: 'two', color1: '#112233', color2: '#FFFFFF', style: 'fromCorner', variant: v });
    assert.deepEqual([dialogFill(g).style, dialogFill(g).variant], ['fromCorner', v]);
  }
  assert.equal(dialogFill({ gradient: { stops: two, type: 'rectangular', focus: [50, 50, 50, 50] } }).style, 'fromCenter');
  assert.equal(dialogFill({ gradient: { stops: two, kind: { type: 'path', shape: 'rect', focus: [100, 100, 0, 0] } } }).variant, 3);
});

test('the Layout dialog sends only what changed, in one execMany', () => {
  const o = { type: 'shape', w: 100, h: 50, wrap: 'square', wrapText: 'bothSides', moveWithText: true, rotation: 0,
    position: { hRel: 'column', vRel: 'paragraph', x: 10, y: 20, hAlign: null, vAlign: null }, dist: { left: 9, right: 9, top: 0, bottom: 0 } };
  const start = stateOfObject(o);
  assert.deepEqual(layoutSteps(start, start, o), []);
  const s = { ...start, hMode: 'align', hAlign: 'center', hAlignRel: 'margin', side: 'left', rotate: 30 };
  assert.deepEqual(layoutSteps(start, s, o), [
    ['arrange.float', { wrapText: 'left', h: { rel: 'margin', align: 'center' } }],
    ['arrange.rotation', { degrees: 30 }],
  ]);
  assert.deepEqual(layoutSteps(start, { ...start, wrap: 'inline' }, o), [['arrange.wrap', { wrap: 'inline' }]]);
  assert.deepEqual(layoutSteps(start, { ...start, h: 80 }, { ...o, type: 'image' }), [['picture.size', { width: 100, height: 80 }]]);
});

test('Shape Styles is one step of fill and outline; this package\'s rows are no gap rows', () => {
  const steps = shapeStyleSteps('a1v1');
  assert.deepEqual(steps.map(([id]) => id), ['shape.fill', 'shape.outline']);
  assert.deepEqual(steps[0][1], { color: null });
  assert.equal(shapeStyleSteps('nope'), null);
  for (const id of ['shapeFormat.shapeStyles.shapeFill.picture', 'shapeFormat.shapeStyles.shapeFill.pattern', 'shapeFormat.shapeStyles.launcher',
    'layout.arrange.wrapText.moreLayoutOptions', 'layout.arrange.group.regroup', 'layout.pageSetup.breaks.textWrapping', 'pictures.textBoxConvert',
    'developer.controls.legacyTools.insertFrame', 'shapeFormat.insertShapes.addText', 'shapeFormat.wordArtStyles.launcher']) {
    assert.notEqual(formOf(OBJECTS[id]), 'off', id);
  }
});

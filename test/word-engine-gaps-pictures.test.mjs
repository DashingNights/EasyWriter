// engine-gaps-pictures (docs/plans/engine/stage2b.md): Picture Format's gallery items as the engine's picture.format params and
// back, so an item applied on a canvas draft reads as picked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { domEffects, effectParams, engineEffects, hex6, sameEffect, styleOf, styleSteps } from '../src/document/wp/picture-format/engine.mjs';
import { colorOf } from '../src/document/canvas/rows/objects.mjs';

const accent = (slot) => ({ accent1: '#156082', accent2: '#E97132' })[slot] ?? '#000000';

test('effect items become picture.format params in the engine units', () => {
  assert.deepEqual(effectParams('shadow', 'outerBottomRight', accent), { shadow: { color: '000000', transparency: 60, blur: 4, distance: 3, angle: 45 } });
  assert.deepEqual(Object.keys(effectParams('shadow', 'innerTop', accent)), ['innerShadow']);
  assert.deepEqual(effectParams('shadow', 'none', accent), { shadow: null, innerShadow: null });
  assert.deepEqual(effectParams('reflection', 'half4', accent), { reflection: { size: 50, distance: 4, transparency: 50, blur: 0.5 } });
  assert.deepEqual(effectParams('glow', '8accent2', accent), { glow: { color: 'E97132', size: 8, transparency: 60 } });
  assert.deepEqual(effectParams('3DRotation', 'isoLeftDown', accent).rotation, { x: -45, y: 35, z: 0, fov: 0 });
  // A preset sets the shadow, bevel and rotation, leaving the rest.
  const p = effectParams('preset', 'preset2', accent);
  assert.ok(p.shadow && p.bevel?.kind === 'circle' && p.rotation === null && !('glow' in p));
  assert.equal(effectParams('glow', 'nope', accent), null);
});

test('the engine look reads back as the item that made it', () => {
  // object.get gives colours as [r, g, b] and percents.
  const fx = { shadow: { color: [0, 0, 0], transparency: 60, blur: 4, distance: 3, angle: 45, rotWithShape: false },
    rotation: { x: -45, y: 35, z: 0, fov: 0 }, glow: { color: [233, 113, 50], size: 8, transparency: 60 } };
  const dom = domEffects(fx);
  assert.equal(dom.shadow.transparency, 0.6);
  assert.ok(sameEffect('shadow', dom.shadow, { kind: 'outer', blur: 4, distance: 3, angle: 45 }));
  assert.ok(sameEffect('3DRotation', dom.rotation3d, { camera: 'isometricLeftDown' }));
  assert.ok(!sameEffect('3DRotation', dom.rotation3d, { camera: 'isometricRightUp' }));
  assert.ok(sameEffect('glow', dom.glow, { size: 8, color: '#E97132' }));
  assert.ok(sameEffect('reflection', null, null));
  assert.deepEqual(engineEffects({ softEdge: null }), { softEdge: null });
  assert.equal(hex6([255, 0, 16]), 'FF0010');
});

test('a picture style is its outline, effects and shape in one step, and reads back', () => {
  const steps = styleSteps('reflectedRoundedRectangle');
  assert.deepEqual(steps[1], ['picture.cropToShape', { preset: 'roundRect' }]);
  assert.equal(steps[0][1].outline, null);
  assert.ok(steps[0][1].clear && steps[0][1].reflection);
  const look = { outline: null, cropShape: 'roundRect', fx: { reflection: steps[0][1].reflection } };
  assert.equal(styleOf(look), 'reflectedRoundedRectangle');
  assert.equal(styleSteps('nope'), null);
});

test('every recolour item has an engine form', () => {
  assert.deepEqual(colorOf('recolor-bw25'), { mode: 'blackAndWhite', threshold: 25 });
  assert.deepEqual(colorOf('recolor-dark-accent2'), { mode: 'dark', color: 'E97132' });
  assert.deepEqual(colorOf('recolor-light-lt2'), { mode: 'light', color: '0E2841' });
  assert.deepEqual(colorOf('recolor-none'), { mode: 'none' });
  assert.equal(colorOf('nope'), null);
});

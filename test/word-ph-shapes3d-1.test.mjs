// ph-shapes3d-1 (docs/plans/word/briefs/ph-shapes3d-1.md): the compatibility-mode ribbon on the canvas engine. Word's legacy
// Shadow Effects data and rows, the Text Box tab's rows, and the spec's ids taken out of the placeholders.
import assert from 'node:assert/strict';
import test from 'node:test';
import { OBJECTS } from '../src/document/canvas/rows/objects.mjs';
import { formOf } from '../src/document/canvas/rows/forms.mjs';
import { SHADOW_ON, SHADOW_STYLES, nudgedShadow, shadowGallery, shadowOffset, shadowParams } from '../src/document/wp/shapes/map.mjs';
import { REASONS } from '../src/tooling/reasons.mjs';
import * as S from '../src/document/ribbon/spec.mjs';

const near = (a, b) => Math.abs(a - b) < 0.01;
const nearOffset = (s, want) => {
  const [x, y] = shadowOffset(s);
  return near(x, want[0]) && near(y, want[1]);
};

test('the shadow Shadow On/Off turns on first is Word\'s: 2 pt, 2 pt, gray, opaque', () => {
  assert.deepEqual(shadowOffset(SHADOW_ON).map((n) => Math.round(n)), [2, 2]);
  assert.equal(SHADOW_ON.transparency, 0);
  assert.equal(SHADOW_ON.color, '808080');
  assert.equal(SHADOW_ON.blur, 0);
});

test('the five Drop Shadow styles are Word\'s offsets and transparencies', () => {
  const want = [[-6, -6], [6, -6], [-6, 6], [6, 6], [2, 2]];
  const ids = Object.keys(SHADOW_STYLES);
  assert.deepEqual(ids, ['shadowStyle1', 'shadowStyle2', 'shadowStyle3', 'shadowStyle4', 'shadowStyle5']);
  ids.forEach((id, i) => {
    assert.ok(nearOffset(SHADOW_STYLES[id], want[i]), `${id} offset`);
    assert.equal(SHADOW_STYLES[id].transparency, i === 4 ? 0 : 50, `${id} transparency`);
  });
});

test('a nudge moves the shadow one point each way, through a round trip of the engine\'s distance and angle', () => {
  let s = SHADOW_ON;
  for (const [dx, dy, want] of [[0, -1, [2, 1]], [-1, 0, [1, 1]], [0, 1, [1, 2]], [1, 0, [2, 2]]]) {
    s = nudgedShadow(s, dx, dy);
    assert.ok(nearOffset(s, want), `nudge ${dx},${dy} gives ${want}: ${JSON.stringify(shadowOffset(s))}`);
  }
});

test('shadowParams names the colour the command takes, from object.get\'s [r, g, b]', () => {
  assert.equal(shadowParams({ color: [128, 0, 255], transparency: 50, blur: 0, distance: 1, angle: 0 }).color, '8000FF');
  assert.equal(shadowParams({ color: '808080', transparency: 0, blur: 0, distance: 1, angle: 0 }).color, '808080');
});

test('the gallery lists No Shadow and the five styles, the one that matches active', () => {
  const none = shadowGallery(null);
  assert.equal(none.length, 6);
  assert.equal(none[0].id, 'noShadow');
  assert.equal(none[0].active, true);
  assert.ok(none.slice(1).every((i) => !i.active));
  const four = { color: [128, 128, 128], ...SHADOW_STYLES.shadowStyle4 };
  const g = shadowGallery(four);
  assert.equal(g.filter((i) => i.active).map((i) => i.id).join(), 'shadowStyle4');
});

/** A ctx for the rows: the engine records exec calls, object.get answers `obj`. */
function stub(ctxPatch = {}, obj = { kind: 'shape', shape: { effects: { shadow: null } } }) {
  const calls = [];
  const state = { obj };
  const ctx = {
    in: { compat: true, ...ctxPatch.in },
    obj: { kind: 'shape', pos: { story: 'body', path: [0], off: 0 } },
    engine: {
      exec: async (id, args) => (calls.push([id, args]), { ok: true, value: null }),
      query: async () => ({ value: state.obj }),
    },
    read: () => state.obj,
    toast: () => {},
    dialog: async () => null,
    ...ctxPatch,
  };
  return { ctx, calls, state };
}

test('Shadow On/Off: on from nothing sends the default, off keeps it, on again brings it back', async () => {
  const onOff = OBJECTS['shapeFormat.shadowEffects.shadowOnOff'];
  const { ctx, calls, state } = stub();
  await onOff.run(ctx);
  assert.deepEqual(calls.at(-1), ['shape.effects', { shadow: SHADOW_ON }]);
  assert.equal(onOff.active(ctx), false);

  // off: what object.get now gives, in its form
  state.obj = { kind: 'shape', shape: { effects: { shadow: { color: [128, 128, 128], ...SHADOW_ON } } } };
  assert.equal(onOff.active(ctx), true);
  await onOff.run(ctx);
  assert.deepEqual(calls.at(-1), ['shape.effects', { shadow: null }]);

  state.obj = { kind: 'shape', shape: { effects: { shadow: null } } };
  await onOff.run(ctx);
  assert.deepEqual(calls.at(-1), ['shape.effects', { shadow: shadowParams({ color: [128, 128, 128], ...SHADOW_ON }) }]);
});

test('Shadow On/Off remembers each shape\'s own shadow; another shape\'s never comes back', async () => {
  const onOff = OBJECTS['shapeFormat.shadowEffects.shadowOnOff'];
  const { ctx, calls, state } = stub();
  const at = (off, shadow) => ({ kind: 'shape', pos: { story: 'body', path: [0], off }, shape: { effects: { shadow } } });
  state.obj = at(0, null);
  await onOff.run(ctx);
  assert.deepEqual(calls.at(-1), ['shape.effects', { shadow: SHADOW_ON }]);
  state.obj = at(0, { ...SHADOW_STYLES.shadowStyle4, color: [0, 255, 0] });
  await onOff.run(ctx); // off: shape 0 remembers Style 4
  state.obj = at(3, null);
  await onOff.run(ctx); // another shape never had one
  assert.deepEqual(calls.at(-1), ['shape.effects', { shadow: SHADOW_ON }]);
  state.obj = at(0, null);
  await onOff.run(ctx); // shape 0 on again gets its own back
  assert.equal(calls.at(-1)[1].shadow.color, '00FF00');
  assert.equal(calls.at(-1)[1].shadow.transparency, 50);
});

test('a nudge on a shape with no shadow turns the default one on, then nudges it', async () => {
  const { ctx, calls } = stub();
  await OBJECTS['shapeFormat.shadowEffects.nudgeShadowUp'].run(ctx);
  assert.equal(calls.at(-1)[0], 'shape.effects');
  assert.ok(nearOffset(calls.at(-1)[1].shadow, [2, 1]), JSON.stringify(calls.at(-1)[1]));
});

test('the legacy shadow rows show only in a compatibility file', () => {
  const off = Object.fromEntries(Object.entries(OBJECTS).filter(([id]) => id.startsWith('shapeFormat.shadowEffects.')));
  assert.equal(Object.keys(off).length, 7);
  for (const [id, row] of Object.entries(off)) {
    const { ctx } = stub({ in: { compat: false } });
    assert.equal(row.enabled(ctx), false, id);
    assert.equal(row.reason(ctx), REASONS.compat, id);
  }
});

test('every id of the Text Box tab\'s two tables has a row', () => {
  const ids = [
    'shapeFormat.shadowEffects.shadowEffects', 'shapeFormat.shadowEffects.shadowEffects.shadowColor', 'shapeFormat.shadowEffects.shadowOnOff',
    'shapeFormat.shadowEffects.nudgeShadowUp', 'shapeFormat.shadowEffects.nudgeShadowLeft', 'shapeFormat.shadowEffects.nudgeShadowRight',
    'shapeFormat.shadowEffects.nudgeShadowDown',
    'textBox.text.drawTextBox', 'textBox.text.drawTextBox.drawHorizontalTextBox', 'textBox.text.drawTextBox.drawVerticalTextBox',
    'textBox.text.textDirection', 'textBox.text.createLink', 'textBox.textBoxStyles.textBoxStyles', 'textBox.size.shapeHeight.more',
    'textBox.size.shapeHeight.less', 'textBox.size.shapeWidth.more', 'textBox.size.shapeWidth.less',
  ];
  for (const id of ids) {
    assert.ok(OBJECTS[id], id);
    assert.notEqual(formOf(OBJECTS[id]), 'off', id);
  }
});

test('the compatibility ids are no placeholders; the 3-D ones still are', () => {
  const ids = [
    'shapeFormat.shadowEffects.shadowEffects', 'shapeFormat.shadowEffects.shadowEffects.shadowColor', 'shapeFormat.shadowEffects.nudgeShadowUp',
    'shapeFormat.shadowEffects.nudgeShadowLeft', 'shapeFormat.shadowEffects.shadowOnOff', 'shapeFormat.shadowEffects.nudgeShadowRight',
    'shapeFormat.shadowEffects.nudgeShadowDown',
    'textBox.shadowEffects.shadowEffects', 'textBox.shadowEffects.nudgeShadowUp', 'textBox.shadowEffects.nudgeShadowLeft',
    'textBox.shadowEffects.shadowOnOff', 'textBox.shadowEffects.nudgeShadowRight', 'textBox.shadowEffects.nudgeShadowDown',
    'textBox.text.drawTextBox', 'textBox.text.drawTextBox.drawHorizontalTextBox', 'textBox.text.drawTextBox.drawVerticalTextBox',
    'textBox.text.textDirection', 'textBox.text.createLink',
    'textBox.textBoxStyles.textBoxStyles', 'textBox.textBoxStyles.shapeFill', 'textBox.textBoxStyles.shapeOutline',
    'textBox.textBoxStyles.changeShape', 'textBox.textBoxStyles.launcher',
    'textBox.arrange.position', 'textBox.arrange.bringForward', 'textBox.arrange.sendBackward', 'textBox.arrange.wrapText',
    'textBox.arrange.align', 'textBox.arrange.group', 'textBox.arrange.rotate',
    'textBox.size.shapeHeight', 'textBox.size.shapeWidth', 'textBox.size.launcher',
    'textBox.size.shapeHeight.more', 'textBox.size.shapeHeight.less', 'textBox.size.shapeWidth.more', 'textBox.size.shapeWidth.less',
  ];
  for (const id of ids) {
    const spec = S.CONTROLS[id] ?? S.ITEMS[id] ?? S.MENUS[id] ?? S.FEATURES[id];
    assert.ok(spec, `${id} is in the spec`);
    assert.equal(spec.needs, undefined, `${id} has no needs`);
  }
  assert.equal(S.CONTROLS['textBox.3DEffects.tiltUp'].needs, 'render3d');
  assert.equal(S.CONTROLS['shapeFormat.3DEffects.tiltUp'].needs, 'render3d');
});

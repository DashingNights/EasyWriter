// bd-look (docs/plans/board/briefs/bd-look.md): the chrome's view of a stored board item, and the patch it writes back. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PX, hex, legacyOf, newShape, patchOf, kindOf, plainOf, rgb, textStory, toPt, toPx } from '../src/board/look.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);

test('a colour is a lowercase hex and back, and anything else is null', () => {
  assert.deepEqual(rgb('#ff0010'), [255, 0, 16]);
  assert.deepEqual(rgb('#FF0010'), [255, 0, 16]);
  assert.equal(hex([255, 0, 16]), '#ff0010');
  assert.equal(hex([0, 0, 0]), '#000000');
  assert.equal(rgb('red'), null);
  assert.equal(rgb('#f00'), null);
  assert.equal(hex(undefined), null);
  assert.equal(hex('red'), null);
});

test('points are four thirds of a px', () => {
  assert.equal(PX, 4 / 3);
  assert.equal(toPx(30), 40);
  assert.equal(toPt(40), 30);
});

test('a stored shape is the old form in px: rectangle, stroke, solid or no fill', () => {
  const legacy = legacyOf({ type: 'shape', x: 30, y: 0, w: 90, h: 60, stroke: [0, 0, 0], strokeWidth: 1.5, fill: null, kind: 'rectangle' });
  assert.equal(legacy.x, 40);
  assert.equal(legacy.w, 120);
  assert.equal(legacy.width, 2);
  assert.equal(legacy.fill, 'none');
  assert.equal(legacy.color, '#000000');
  assert.equal(legacy.shape, 'rect');
});

test('a patch names stored fields only: colour and position in the engine units', () => {
  assert.deepEqual(patchOf({ type: 'shape' }, { x: 40, color: '#ff0000' }), { x: 30, stroke: [255, 0, 0] });
});

test('every mapped row round trips through the old form', () => {
  const rows = [
    { type: 'shape', x: 30, y: 12.5, w: 90, h: 60, rot: 45, flipX: true, flipY: false, opacity: 0.5, hidden: true, locked: false },
    { type: 'shape', kind: 'rectangle', stroke: [1, 2, 3], strokeWidth: 1.5 },
    { type: 'shape', kind: 'rectangle', fill: null },
    { type: 'shape', kind: 'rectangle', fill: [255, 0, 0] },
    { type: 'shape', kind: 'rectangle', fill: { type: 'pattern', preset: 'ltUpDiag', fg: [0, 0, 255], bg: [255, 255, 255] } },
    { type: 'shape', kind: 'ellipse' },
    { type: 'shape', kind: 'roundedRectangle' },
    { type: 'picture', media: 'abc', crop: [0.1, 0.2, 0.4, 0.3] },
    { type: 'connector', color: [9, 8, 7], width: 1.5, from: { item: 'a' }, to: { x: 10, y: 20 }, route: 'curve', points: [{ x: 1, y: 2 }], heads: { end: 'arrow' } },
  ];
  for (const item of rows) {
    const back = patchOf(item, legacyOf(item));
    for (const [k, v] of Object.entries(item)) {
      if (k === 'type' || v === false || v == null) continue;
      if (back[k] === undefined) continue; // an unchanged value is no op
      if (typeof v === 'number') near(back[k], v);
      else assert.deepEqual(back[k], v, `${item.type} ${k}`);
    }
  }
});

test('a flip reads as both of the old form\'s flips', () => {
  const legacy = legacyOf({ type: 'shape', kind: 'rectangle', flipX: true, flipY: true });
  assert.equal(legacy.flipX, true);
  assert.equal(legacy.flipY, true);
  assert.equal(legacy.mirrorX, true);
  assert.equal(legacy.mirrorY, true);
  assert.deepEqual(patchOf({ type: 'shape' }, { mirrorX: true }), { flipX: true });
});

test('a hatch fill and a crop use the stored keys', () => {
  const legacy = legacyOf({ type: 'shape', kind: 'rectangle', fill: { type: 'pattern', preset: 'ltUpDiag', fg: [255, 0, 0], bg: [255, 255, 255] } });
  assert.equal(legacy.fill, 'hatch');
  assert.equal(legacy.fillColor, '#ff0000');
  assert.deepEqual(patchOf({ type: 'shape' }, { fill: 'hatch', fillColor: '#ff0000' }),
    { fill: { type: 'pattern', preset: 'ltUpDiag', fg: [255, 0, 0], bg: [255, 255, 255] } });
  assert.deepEqual(patchOf({ type: 'picture' }, { crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }).crop, [0.1, 0.2, 0.4, 0.3]);
});

test('a gradient or a picture fill reads as a solid of its main colour and stays unless the patch names one', () => {
  const gradient = { type: 'gradient', stops: [{ pos: 0, color: [0, 0, 0] }, { pos: 100, color: [255, 255, 255] }] };
  const legacy = legacyOf({ type: 'shape', kind: 'rectangle', fill: gradient });
  assert.equal(legacy.fill, 'solid');
  assert.equal(legacy.fillColor, '#ffffff');
  assert.deepEqual(patchOf({ type: 'shape', fill: gradient }, { x: 4 }), { x: 3 });
  assert.deepEqual(patchOf({ type: 'shape', fill: gradient }, { fillColor: '#000000' }).fill, [0, 0, 0]);
});

test('the type, id and groups the chrome reads', () => {
  assert.equal(legacyOf({ id: 'x', type: 'picture' }).type, 'image');
  assert.equal(legacyOf({ id: 'x', type: 'ink' }).type, 'stroke');
  assert.equal(legacyOf({ id: 'x', type: 'connector' }).type, 'connector');
  assert.equal(legacyOf({ id: 'x', type: 'shape', kind: 'rect' }).id, 'x');
  assert.deepEqual(legacyOf({ id: 'x', type: 'shape', kind: 'rect' }, ['outer', 'inner']).groups, ['outer', 'inner']);
});

test('a picture names its media with media: and its crop as fractions', () => {
  const legacy = legacyOf({ type: 'picture', media: 'key', crop: [0.1, 0.2, 0.4, 0.3] });
  assert.equal(legacy.src, 'media:key');
  assert.deepEqual(legacy.crop, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  assert.deepEqual(patchOf({ type: 'picture' }, legacy).media, 'key');
});

test('an old kind maps to the stored shape kind, a preset to its name', () => {
  assert.deepEqual(kindOf('rect'), { kind: 'rectangle' });
  assert.deepEqual(kindOf('round'), { kind: 'roundedRectangle' });
  assert.deepEqual(kindOf('ellipse'), { kind: 'ellipse' });
  assert.deepEqual(kindOf('diam'), { kind: 'diamond' });
  assert.deepEqual(kindOf('hexagon'), { prst: 'hexagon' });
  assert.deepEqual(legacyOf({ type: 'shape', kind: 'hexagon' }).shape, 'hexagon');
});

test('a preset with its adjust values is extra.preset, both ways', () => {
  const item = { type: 'shape', kind: 'hexagon', extra: { preset: ['hexagon', [['adj', 2]]] } };
  const legacy = legacyOf(item);
  assert.equal(legacy.shape, 'hexagon');
  assert.equal(legacy.prst, 'hexagon');
  assert.deepEqual(legacy.av, [['adj', 2]]);
  assert.deepEqual(patchOf(item, legacy).extra, { preset: ['hexagon', [['adj', 2]]] });
});

test('a story is the old form\'s html, and text is the story', () => {
  assert.equal(plainOf(textStory('a\n大')), 'a\n大');
  assert.deepEqual(textStory('a\n大').blocks[1], { kind: 'para', text: '大', runs: [{ len: 3 }] });
  assert.deepEqual(textStory('a\n').blocks[1].runs, [], 'an empty line has no runs');
  assert.equal(legacyOf({ type: 'text', story: textStory('a <b>\nc') }).html, '<p>a &lt;b&gt;</p><p>c</p>');
});

test('the old form is a copy: the item is never changed', () => {
  const item = { type: 'shape', kind: 'rectangle', x: 30, y: 0, w: 90, h: 60, stroke: [0, 0, 0], fill: [1, 2, 3] };
  const before = structuredClone(item);
  legacyOf(item);
  assert.deepEqual(item, before);
});

test('a text item\'s colour and its other style fields belong to the story, not to stored fields', () => {
  assert.deepEqual(patchOf({ type: 'text' }, { color: '#ff0000', font: 'Arial', size: 12, bold: true, align: 'left', fit: true, bg: '#ffffff' }), {});
  assert.deepEqual(patchOf({ type: 'shape' }, { color: '#ff0000' }), { stroke: [255, 0, 0] });
});

test('a solid fill keeps its transparency in an 8-digit colour and back', () => {
  const fill = { type: 'solid', color: [255, 0, 0], transparency: 50 };
  const legacy = legacyOf({ type: 'shape', kind: 'rect', fill });
  assert.equal(legacy.fill, 'solid');
  assert.equal(legacy.fillColor, '#ff000080');
  const back = patchOf({ type: 'shape', kind: 'rect', fill }, legacy).fill;
  assert.deepEqual(back.color, [255, 0, 0]);
  assert.ok(Math.abs(back.transparency - 50) < 0.2, `${back.transparency}`);
});

test('an 8-digit colour is a colour and its transparency, and the transparent swatch is fully transparent', () => {
  assert.deepEqual(rgb('#ff000080'), [255, 0, 0]);
  const half = patchOf({ type: 'shape' }, { fill: 'solid', fillColor: '#ff000080' }).fill;
  assert.deepEqual(half.color, [255, 0, 0]);
  assert.ok(Math.abs(half.transparency - 49.80392156862745) < 1e-9, `${half.transparency}`);
  assert.equal(patchOf({ type: 'shape' }, { fill: 'solid', fillColor: '#00000000' }).fill.transparency, 100);
});

test('recolouring a pattern keeps its preset and its background', () => {
  const fill = { type: 'pattern', preset: 'dkVert', fg: [1, 2, 3], bg: [200, 100, 0] };
  assert.deepEqual(patchOf({ type: 'shape', kind: 'rect', fill }, { fillColor: '#ff8800' }).fill,
    { type: 'pattern', preset: 'dkVert', fg: [255, 136, 0], bg: [200, 100, 0] });
});

test('none to a solid with no colour takes the new shape\'s default fill', () => {
  assert.deepEqual(patchOf({ type: 'shape', kind: 'rect', fill: null }, { fill: 'solid' }).fill, [74, 127, 224]);
  assert.deepEqual(newShape({ shape: 'rect', fill: 'solid' }).fill, [74, 127, 224]);
});

test('changing a preset shape to a plain one clears its preset and its freeform', () => {
  const item = { type: 'shape', kind: 'hexagon', freeform: { paths: [] }, extra: { preset: ['hexagon', [['adj', 2]]] } };
  const plain = patchOf(item, { shape: 'rect' });
  assert.deepEqual(plain, { kind: 'rectangle', freeform: null, extra: {} });
  const after = { ...item, ...plain };
  assert.equal(legacyOf(after).shape, 'rect');
  assert.equal(legacyOf(after).prst, undefined);
  const round = patchOf(item, legacyOf(item));
  assert.equal('prst' in round, false);
  assert.deepEqual(round.extra, { preset: ['hexagon', [['adj', 2]]] });
});

test('a connector\'s free ends and waypoints are px in the old form and points when patched back', () => {
  const item = { type: 'connector', from: { x: 30, y: 12.3 }, to: { item: 'a', anchor: 'e', pin: true }, points: [{ x: 60, y: 0 }], heads: { end: 'arrow' } };
  const legacy = legacyOf(item);
  assert.deepEqual(legacy.from, { x: 40, y: 16.4 });
  assert.deepEqual(legacy.to, { item: 'a', anchor: 'e', pin: true });
  assert.deepEqual(legacy.points, [{ x: 80, y: 0 }]);
  assert.equal(patchOf(item, legacy).from, undefined, 'an unchanged end is no op');
  assert.deepEqual(patchOf(item, { from: { x: 41, y: 16.4 } }).from, { x: 30.75, y: 12.3 });
});

test('legacyOf hands out copies, so the chrome cannot change the store without an op', () => {
  const item = { type: 'connector', from: { x: 30, y: 0 }, points: [{ x: 10, y: 20 }], heads: { start: 'bar' } };
  const legacy = legacyOf(item);
  legacy.from.x = 999;
  legacy.points[0].x = 999;
  legacy.heads.start = 'none';
  assert.deepEqual(item.from, { x: 30, y: 0 });
  assert.deepEqual(item.points, [{ x: 10, y: 20 }]);
  assert.deepEqual(item.heads, { start: 'bar' });
  const preset = { type: 'shape', kind: 'hexagon', extra: { preset: ['hexagon', [['adj', 2]]] } };
  legacyOf(preset).av[0][1] = 99;
  assert.deepEqual(preset.extra.preset[1], [['adj', 2]]);
});

test('points round so an unchanged value is not written again', () => {
  assert.equal(toPt(toPx(12.3)), 12.3);
  assert.deepEqual(patchOf({ type: 'shape', x: 12.3 }, { x: toPx(12.3) }), {});
  assert.deepEqual(patchOf({ type: 'shape', x: 12.3 }, { x: toPx(12.4) }), { x: 12.4 });
});

test('a group or doc item has no old form, and callers skip it', () => {
  assert.equal(legacyOf({ id: 'g', type: 'group' }), null);
  assert.equal(legacyOf({ id: 'd', type: 'doc', draft: 'x' }), null);
});

test('a click-placed shape is 160 x 110 px unless the kind asks for another box, with the look\'s stroke and no fill', () => {
  const shape = newShape({ shape: 'rect', color: '#ff0000', width: 2, opacity: 1 });
  assert.equal(shape.type, 'shape');
  assert.equal(shape.kind, 'rectangle');
  near(shape.w, toPt(160));
  near(shape.h, toPt(110));
  assert.deepEqual(shape.stroke, [255, 0, 0]);
  near(shape.strokeWidth, 1.5);
  assert.equal(shape.opacity, 1);
  assert.equal('fill' in shape, false);
  const circle = newShape({ shape: 'sm-circ', color: '#000000', width: 1 });
  near(circle.w, toPt(60)); // KINDS' own box
  near(circle.h, toPt(60));
  const placed = newShape({ shape: 'rect' }, { x: 10, y: 20, w: 300, h: 200 });
  assert.deepEqual([placed.x, placed.y, placed.w, placed.h], [10, 20, 300, 200]);
  assert.deepEqual(newShape({ shape: 'rect', fill: 'solid', fillColor: '#00ff00' }).fill, [0, 255, 0]);
  assert.deepEqual(newShape({ shape: 'hexagon', av: [['adj', 1]] }).extra, { preset: ['hexagon', [['adj', 1]]] });
});

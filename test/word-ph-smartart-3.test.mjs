// ph-smartart-3 (docs/plans/word/briefs/ph-smartart-3.md): the Format tab's shape and text looks on a canvas draft. The shape
// rows in objects.mjs act on a picked diagram shape too, and the Format tab's own rows go through smartArt.look. Pure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_COMMANDS } from '../src/document/canvas/commands.mjs';
import { SHAPE_CHOICES, SHAPE_PRESETS } from '../src/document/canvas/smart-art/layouts.mjs';
import { pickItem } from '../src/document/canvas/smart-art/state.mjs';
import { shapeStyleSteps } from '../src/document/canvas/rows/objects.mjs';
import { CONTROLS } from '../src/document/ribbon/spec.mjs';

const FEATURES = [
  'smartArtFormat.shapes.changeShape',
  'smartArtFormat.shapes.larger',
  'smartArtFormat.shapes.smaller',
  'smartArtFormat.shapeStyles.shapeStyles',
  'smartArtFormat.shapeStyles.shapeFill',
  'smartArtFormat.shapeStyles.shapeOutline',
  'smartArtFormat.wordArtStyles.textFill',
  'smartArtFormat.wordArtStyles.textFill.moreFillColors',
];

/** The row a Format tab control runs: its own, or the one its `cmd` alias names. */
const row = (id) => ENGINE_COMMANDS[CONTROLS[id]?.cmd ?? id];

const POS = { page: 0, para: 0, off: 0 };
/** The selected object `object.get` answers: a diagram of three items, item 2 with `look`. */
const diagram = (look = null) => ({
  pos: POS, w: 400, h: 200,
  smartArt: { spec: { layout: 'process', colors: 'colorful', rtl: false, items: [{ text: 'A', level: 0 }, { text: 'B', level: 0 },
    { text: 'C', level: 0, ...(look && { look }) }] }, shapes: [] },
});
/** A row's ctx: the selected `obj`, `object.get` from both read and query, and every engine.exec recorded. */
const ctxFor = ({ kind = 'smartArt', pick = null, look = null, value = diagram(look) } = {}) => {
  pickItem(pick == null && kind !== 'smartArt' ? null : POS, pick);
  const execs = [];
  const ctx = {
    obj: { kind, pos: POS },
    engine: { exec: (id, args) => (execs.push([id, args]), Promise.resolve({ ok: true })), query: async () => ({ value }) },
    read: () => value,
    dialog: async () => null,
  };
  return { ctx, execs };
};

test('the eight Format ids have a row, their own or through the shape rows they alias', () => {
  for (const id of FEATURES) assert.ok(row(id)?.run, `${id} has a row`);
});

test('Shape Fill fills the picked diagram item, or every item with none picked, and No Fill sends none', async () => {
  const picked = ctxFor({ pick: 2 });
  assert.equal(await row('smartArtFormat.shapeStyles.shapeFill').run(picked.ctx, { color: '#C00000' }), true);
  assert.deepEqual(picked.execs, [['smartArt.look', { fill: 'C00000', items: [2] }]]);

  const all = ctxFor();
  await row('smartArtFormat.shapeStyles.shapeFill').run(all.ctx, { color: '#C00000' });
  assert.deepEqual(all.execs, [['smartArt.look', { fill: 'C00000' }]]);

  const none = ctxFor({ pick: 2 });
  await row('smartArtFormat.shapeStyles.shapeFill').run(none.ctx, { color: null });
  assert.deepEqual(none.execs, [['smartArt.look', { fill: 'none', items: [2] }]]);
});

test('Shape Outline lines the picked diagram item, and its Weight sets the line width', async () => {
  const { ctx, execs } = ctxFor({ pick: 1 });
  await row('smartArtFormat.shapeStyles.shapeOutline').run(ctx, { color: '#112233' });
  await row('smartArtFormat.shapeStyles.shapeOutline').run(ctx, { color: null });
  assert.deepEqual(execs, [['smartArt.look', { line: '112233', items: [1] }], ['smartArt.look', { line: 'none', items: [1] }]]);

  const w = ctxFor({ pick: 1 });
  await ENGINE_COMMANDS['shapeFormat.shapeStyles.shapeOutline.weight'].run(w.ctx, 3);
  assert.deepEqual(w.execs, [['smartArt.look', { lineWidth: 3, items: [1] }]]);
});

test('Shape Styles on a diagram takes its fill and its outline, not its dash', async () => {
  const [[, fill], [, line]] = shapeStyleSteps('a1v1');
  const { ctx, execs } = ctxFor({ pick: 2 });
  assert.equal(await row('smartArtFormat.shapeStyles.shapeStyles').run(ctx, 'a1v1'), true);
  assert.deepEqual(execs, [['smartArt.look', { fill: fill.color ?? fill.pattern?.fg ?? 'none', line: line.color, lineWidth: line.width, items: [2] }]]);
});

test('Larger and Smaller step the picked shape by 10 percent and stop at 300 and 50', async () => {
  const up = ctxFor({ pick: 2, look: { scale: 110 } });
  await row('smartArtFormat.shapes.larger').run(up.ctx);
  assert.deepEqual(up.execs, [['smartArt.look', { scale: 120, items: [2] }]]);

  const floor = ctxFor({ pick: 2, look: { scale: 50 } });
  assert.equal(await row('smartArtFormat.shapes.smaller').run(floor.ctx), false);
  assert.deepEqual(floor.execs, []);

  const ceiling = ctxFor({ pick: 2, look: { scale: 300 } });
  assert.equal(await row('smartArtFormat.shapes.larger').run(ceiling.ctx), false);
  assert.deepEqual(ceiling.execs, []);
});

test('Larger needs a picked shape, and shows plain disabled with none', () => {
  const larger = row('smartArtFormat.shapes.larger');
  const none = ctxFor();
  assert.equal(larger.enabled(none.ctx), false);
  assert.equal(larger.reason(none.ctx), null);
  assert.equal(larger.enabled(ctxFor({ pick: 1 }).ctx), true);
});

test('Change Shape sends the picked preset, and the gallery lists the 24 presets a diagram draws', async () => {
  const { ctx, execs } = ctxFor({ pick: 0 });
  await row('smartArtFormat.shapes.changeShape').run(ctx, 'hexagon');
  assert.deepEqual(execs, [['smartArt.look', { shape: 'hexagon', items: [0] }]]);

  assert.equal(SHAPE_CHOICES.length, 24);
  assert.deepEqual(new Set(SHAPE_CHOICES.map((c) => c.prst)), SHAPE_PRESETS);
  for (const c of SHAPE_CHOICES) {
    assert.ok(c.name, `${c.prst} has Word's name`);
    assert.ok(c.group, `${c.prst} has its group`);
  }
});

test('Text Fill sends the picked colour, and the diagram look takes its hex', async () => {
  const { ctx, execs } = ctxFor({ pick: 1 });
  await row('smartArtFormat.wordArtStyles.textFill').run(ctx, { color: '#112233' });
  assert.deepEqual(execs, [['smartArt.look', { textColor: '112233', items: [1] }]]);
});

test('a diagram from another program disables the shape rows, with their reason', () => {
  const foreign = ctxFor({ value: {} }).ctx; // kind smartArt, but object.get keeps no model
  for (const id of ['smartArtFormat.shapeStyles.shapeFill', 'smartArtFormat.shapeStyles.shapeOutline',
    'smartArtFormat.shapeStyles.shapeStyles']) {
    assert.equal(row(id).enabled(foreign), false, `${id} is off on a foreign diagram`);
    assert.equal(row(id).reason(foreign), 'Select a shape first.');
  }
});

test('on a shape the same Shape Fill row still calls shape.fill', async () => {
  const value = { pos: POS, w: 100, h: 50, shape: { fill: { color: '156082' } } };
  const { ctx, execs } = ctxFor({ kind: 'shape', value });
  await row('smartArtFormat.shapeStyles.shapeFill').run(ctx, { color: '#C00000' });
  assert.deepEqual(execs, [['shape.fill', { color: 'C00000' }]]);
});

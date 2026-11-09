// ph-smartart-1 (docs/plans/word/briefs/ph-smartart-1.md): the diagram model, Arrange, Size, Right to Left and Reset on the
// engine (src/engine/wasm, npm run build first). The fourteen ids the package lands draw from the ribbon spec without a
// placeholder reason, and the engine keeps a look and the mirror through a command, a .docx and an engine save.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { CONTROLS, ITEMS } from '../src/document/ribbon/spec.mjs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { Engine, initSync } from '../src/engine/wasm/ew.js';

const FEATURES = [
  'smartArtDesign.createGraphic.rightToLeft',
  'smartArtDesign.reset.resetGraphic',
  'smartArtFormat.accessibility.altText',
  'smartArtFormat.arrange.position',
  'smartArtFormat.arrange.wrapText',
  'smartArtFormat.arrange.bringForward',
  'smartArtFormat.arrange.sendBackward',
  'smartArtFormat.arrange.selectionPane',
  'smartArtFormat.arrange.align',
  'smartArtFormat.arrange.group',
  'smartArtFormat.arrange.rotate',
  'smartArtFormat.size.shapeHeight',
  'smartArtFormat.size.shapeWidth',
  'smartArtFormat.size.launcher',
];

const WASM = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);
const exec = (e, id, args = {}) => JSON.parse(e.exec(id, JSON.stringify(args)));
const objectGet = (e) => exec(e, 'object.get').value;
const diagram = (e) => objectGet(e)?.smartArt ?? null;

/** A fresh engine with the bundled fonts, opened on nothing. */
async function engine() {
  const e = new Engine();
  await addBundledFonts(e, (url) => fs.readFileSync(url));
  return e;
}

test('the fourteen ids draw from the ribbon spec without a placeholder reason', () => {
  for (const id of FEATURES) {
    const c = CONTROLS[id] ?? ITEMS[id];
    assert.ok(c, `${id} has a control or item`);
    assert.equal(c.needs, undefined, `${id} is not a placeholder`);
  }
});

test('a diagram, its mirror, a look and a reset on the engine', { skip: !fs.existsSync(WASM) && 'no built engine (npm run build)' }, async () => {
  initSync({ module: fs.readFileSync(WASM) });
  const e = await engine();
  exec(e, 'insert.smartArt', { layout: 'process' });
  let d = diagram(e);
  assert.equal(d.spec.items.length, 4);
  assert.equal(d.shapes.length, 4);

  // Right to Left mirrors the boxes about the graphic's middle; undo puts them back.
  const before = d.shapes.map((s) => s.rect);
  const w = objectGet(e).w;
  assert.ok(exec(e, 'smartArt.layout', { rtl: true }).ok);
  d = diagram(e);
  assert.equal(d.spec.rtl, true);
  d.shapes.forEach((s, k) => {
    assert.ok(Math.abs(s.rect[0] - (w - before[k][0] - before[k][2])) < 0.01, `shape ${k}: ${s.rect[0]} against ${before[k][0]} and ${w}`);
  });
  assert.ok(JSON.parse(e.undo()).ok);
  assert.deepEqual(diagram(e).shapes.map((s) => s.rect[0]), before.map((r) => r[0]));

  // A look on item 1: a 1.2 scale about the same centre, and item 0 keeps none.
  const old = diagram(e).shapes.find((s) => s.item === 1).rect;
  assert.ok(exec(e, 'smartArt.look', { items: [1], fill: 'C00000', line: 'none', textColor: 'FFFFFF', shape: 'hexagon', scale: 120 }).ok);
  d = diagram(e);
  const held = d.spec.items[1].look;
  assert.deepEqual([held.fill, held.noLine, held.textColor, held.shape, held.scale], ['C00000', true, 'FFFFFF', 'hexagon', 120]);
  assert.equal(d.spec.items[0].look, undefined);
  const grown = d.shapes.find((s) => s.item === 1).rect;
  assert.ok(Math.abs(grown[2] - old[2] * 1.2) < 0.01, `width ${grown[2]} against ${old[2]}`);
  assert.ok(Math.abs(grown[0] + grown[2] / 2 - (old[0] + old[2] / 2)) < 0.01, 'the centre stays');
  assert.ok(JSON.parse(e.undo()).ok);
  assert.equal(diagram(e).shapes.find((s) => s.item === 1).rect[2], old[2], 'one undo takes the whole change back');

  // Every key null: every item goes back to the layout's look.
  exec(e, 'smartArt.look', { items: [1], fill: 'C00000', scale: 120 });
  assert.ok(exec(e, 'smartArt.look', { fill: null, line: null, textColor: null, shape: null, scale: null }).ok);
  assert.ok(diagram(e).spec.items.every((it) => it.look === undefined));

  // Bad params are refused and change nothing.
  for (const bad of [{ fill: 'red' }, { shape: 'cloud' }, { items: [9] }]) {
    const r = exec(e, 'smartArt.look', bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }

  // Reset clears the looks and the colours; the mirror, the layout and the items stay.
  exec(e, 'smartArt.look', { items: [1], fill: 'C00000' });
  exec(e, 'smartArt.layout', { rtl: true });
  exec(e, 'smartArt.colors', { variant: 'accent4' });
  assert.ok(exec(e, 'smartArt.reset').ok);
  d = diagram(e);
  assert.ok(d.spec.items.every((it) => it.look === undefined));
  assert.equal(d.spec.colors, 'accent1');
  assert.equal(d.spec.rtl, true);
  assert.deepEqual([d.spec.layout, d.spec.items.length], ['process', 4]);

  // Moving the items through smartArt.items keeps their looks.
  exec(e, 'smartArt.look', { items: [2], fill: '1F4E79' });
  const items = diagram(e).spec.items;
  assert.ok(exec(e, 'smartArt.items', { items }).ok);
  assert.deepEqual(diagram(e).spec.items[2].look?.fill, '1F4E79');
});

test('a look and the mirror survive a .docx and an engine save', { skip: !fs.existsSync(WASM) && 'no built engine (npm run build)' }, async () => {
  initSync({ module: fs.readFileSync(WASM) });
  const e = await engine();
  exec(e, 'insert.smartArt', { layout: 'process' });
  exec(e, 'smartArt.look', { items: [1], fill: 'C00000', line: 'none', textColor: 'FFFFFF', shape: 'hexagon', scale: 120 });
  exec(e, 'smartArt.layout', { rtl: true });
  const spec = diagram(e).spec;
  for (const kind of ['docx', 'engine']) {
    const again = new Engine();
    again.open(e.save(kind), kind);
    assert.ok(exec(again, 'select.objects', { index: 0 }).ok, `${kind}: the diagram is there`);
    assert.deepEqual(diagram(again)?.spec, spec, `${kind}: the same diagram`);
  }
});

test('a diagram wraps and resizes, and lays out at its new size', { skip: !fs.existsSync(WASM) && 'no built engine (npm run build)' }, async () => {
  initSync({ module: fs.readFileSync(WASM) });
  const e = await engine();
  exec(e, 'insert.smartArt', { layout: 'process' });
  assert.ok(exec(e, 'arrange.wrap', { wrap: 'square' }).ok, 'an EasyWriter diagram wraps');
  assert.equal(objectGet(e).floating, true);
  assert.ok(exec(e, 'arrange.bounds', { width: 300 }).ok);
  const o = objectGet(e);
  assert.equal(o.w, 300);
  for (const s of o.smartArt.shapes) {
    assert.ok(s.rect[0] >= -0.5 && s.rect[0] + s.rect[2] <= 300.5, `a shape fits 300 points: ${JSON.stringify(s.rect)}`);
  }
});

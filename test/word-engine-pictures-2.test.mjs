// engine-pictures-2 (docs/plans/word/briefs/engine-pictures-2.md): Graphics Format on a canvas draft recolours an SVG graphic as
// vector art (its SVG rewritten, then put back through picture.change) and converts it to shapes through the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphicColour, graphicStyle, recolouredSvg } from '../src/document/wp/picture-format/engine.mjs';
import { OBJECTS } from '../src/document/canvas/rows/objects.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 192 96"><rect width="96" height="96" fill="#C00000"/>'
  + '<path d="M96 0h96v96z" fill="none" stroke="#000"/></svg>';
const b64 = (s) => Buffer.from(s).toString('base64');
const text = (s) => Buffer.from(s, 'base64').toString();

test('Graphics Styles, Fill and Outline items become the recolour the DOM editor gives', () => {
  assert.deepEqual(graphicStyle('fill-accent2'), { fill: '#E97132', stroke: 'none' });
  assert.deepEqual(graphicStyle('outline-accent1'), { fill: 'none', stroke: '#156082', strokeWidth: 1 });
  const dark = graphicStyle('dark-accent1');
  assert.ok(dark.fill !== dark.stroke && dark.strokeWidth === 1);
  assert.equal(graphicStyle('nope'), null);
  assert.equal(graphicColour('noFill'), 'none');
  assert.equal(graphicColour('accent2'), '#E97132');
  assert.equal(graphicColour('#00b050'), '#00B050');
  assert.equal(graphicColour('bad'), null);
});

test('an SVG is recoloured as vector art, its outline weight in its own units', () => {
  const filled = text(recolouredSvg(b64(SVG), { fill: '#00B050' }, 72));
  // The filled shape takes the colour; the outline-only one stays unfilled.
  assert.match(filled, /<rect[^>]*fill="#00B050"/);
  assert.match(filled, /<path[^>]*fill="none"/);
  // 3 pt on a graphic 72 pt (96 px) wide whose viewBox is 192 units: 4 px are 8 units.
  const outlined = text(recolouredSvg(b64(SVG), { stroke: '#FF0000', strokeWidth: 3 }, 72));
  assert.match(outlined, /stroke="#FF0000"/);
  assert.match(outlined, /stroke-width="8"/);
  assert.equal(recolouredSvg(b64('not an svg'), { fill: '#000000' }, 72), null);
});

test('the Graphics Format rows are on for an SVG graphic and say why for anything else', () => {
  const graphic = { engine: {}, obj: { kind: 'graphic' } };
  const picture = { engine: {}, obj: { kind: 'picture' } };
  for (const id of ['graphicsFormat.change.convertToShape', 'graphicsFormat.graphicsStyles.styles', 'graphicsFormat.graphicsStyles.graphicsFill',
    'graphicsFormat.graphicsStyles.graphicsOutline']) {
    const row = OBJECTS[id];
    assert.ok(row.enabled(graphic) && !row.reason(graphic), id);
    assert.ok(!row.enabled(picture) && row.reason(picture), id);
  }
});

test('Convert to Shape runs the engine command; a recolour reads the stored SVG and writes it back', async () => {
  const calls = [];
  const engine = {
    exec: async (id, args) => (calls.push([id, args]), { ok: true }),
    query: async (id, args) => (id === 'object.get' ? { value: { w: 72, picture: { svg: true } } } : (calls.push([id, args]), { value: { mime: 'image/svg+xml', base64: b64(SVG) } })),
  };
  const ctx = { engine, obj: { kind: 'graphic' } };
  assert.equal(await OBJECTS['graphicsFormat.change.convertToShape'].run(ctx), true);
  assert.deepEqual(calls.at(-1), ['graphic.convertToShape', {}]);
  assert.equal(await OBJECTS['graphicsFormat.graphicsStyles.graphicsFill'].run(ctx, 'accent6'), true);
  assert.deepEqual(calls.at(-2), ['picture.data', { stored: true }]);
  const [id, args] = calls.at(-1);
  assert.equal(id, 'picture.change');
  assert.match(text(args.data), /<rect[^>]*fill="#4EA72E"/);
  assert.equal(OBJECTS['graphicsFormat.graphicsStyles.graphicsFill'].value(), '#4EA72E');
});

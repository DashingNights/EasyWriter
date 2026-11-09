// border-widths (docs/plans/word/briefs/border-widths.md): the room each paragraph border style takes, as Word lays it out
// (borders/model.mjs lineWidth, measured with .smoke-data/word/fixture/out/probe/border-widths), and the layout predictor giving a
// bordered paragraph that room.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayout } from '../src/document/layout/engine.mjs';
import { lineWidth } from '../src/document/wp/borders/model.mjs';

test('each style takes Word\'s room across its edge', () => {
  const w = (style, width) => lineWidth({ style, width });
  // Word's probe, w:sz 4 (½ pt), 12 (1 ½ pt) and 48 (6 pt).
  const cases = {
    single: [0.5, 1.5, 6], dotted: [0.5, 1.5, 6], thick: [0.5, 1.5, 6], inset: [0.5, 1.5, 6],
    double: [1.5, 4.5, 18], triple: [2.5, 7.5, 30],
    thinThickSmallGap: [2, 3, 7.5], thickThinSmallGap: [2, 3, 7.5], thinThickThinSmallGap: [3.5, 4.5, 9],
    thinThickMediumGap: [1, 3, 12], thinThickThinMediumGap: [1.5, 4.5, 18],
    thinThickLargeGap: [2.75, 3.75, 8.25], thinThickThinLargeGap: [4, 6, 15],
    wave: [3, 3.75, 3], doubleWave: [5.25, 5.25, 5.25], dashDotStroked: [3, 3, 3], threeDEmboss: [2, 3, 9], threeDEngrave: [2, 3, 9],
  };
  for (const [style, want] of Object.entries(cases)) assert.deepEqual([0.5, 1.5, 6].map((x) => w(style, x)), want, style);
  assert.equal(w('threeDEmboss', 2.875), 4.375, 'just under 3 pt the 3-D lines add 1.5');
  assert.equal(w('threeDEmboss', 3), 6, 'from 3 pt they add 3');
  assert.equal(lineWidth({ style: 'nil', width: 6 }), 0);
  assert.equal(lineWidth(null), 0);
  assert.equal(lineWidth({ style: 'single' }), 0.5, 'no width is Word\'s ½ pt');
});

// The fake measurer of word-layout-predictor.test.mjs: a 12 pt line is 16 px and the 213.33 px body holds 13 plain lines.
const fake = () => ({
  stats: { calls: 0, hits: 0, ms: 0, fonts: 0 },
  width: (_f, t) => [...t].length * 10,
  metrics: (font) => {
    const px = Number(/([\d.]+)px/.exec(font)[1]);
    return { asc: px * 0.8, desc: px * 0.2, ascU: px * 0.8, descU: px * 0.2 };
  },
});
const sect = { w: 300, h: 200, orient: 'portrait', margin: { top: 20, right: 20, bottom: 20, left: 20, header: 0, footer: 0, gutter: 0 } };
const heightOf = (borders) => {
  const L = createLayout(fake());
  L.open({ type: 'doc', content: [{ type: 'paragraph', attrs: { borders }, content: [{ type: 'text', text: 'line' }] }],
    attrs: { styles: { defaults: { run: { size: 12 }, para: {} }, list: {} }, settings: { defaultTabStop: 36 }, sect, numbering: null, theme: null } });
  return Math.round(L.run().heights[0] * 100) / 100;
};

test('the predictor gives a bordered paragraph the room of its lines and their distance from text', () => {
  assert.equal(heightOf(null), 16, 'a plain 12 pt line');
  // Double wavy top and bottom: 5.25 pt each.
  const wave = { style: 'doubleWave', width: 0.5, space: 0 };
  assert.equal(heightOf({ top: wave, bottom: wave }), 30);
  // A 1 pt distance on each side adds 2.67 px.
  assert.equal(heightOf({ top: { ...wave, space: 1 }, bottom: { ...wave, space: 1 } }), 32.67);
  // A switched-off edge takes no room, its distance included.
  assert.equal(heightOf({ top: { style: 'nil', space: 31 } }), 16);
});

// Presets as Word draws them at their handles' ends (docs/plans/word/briefs/shape-geometry-word.md). Word's own drawing is compared
// shape by shape in the harness case shape-geometry-word; these pin the two causes found there, at several box sizes, since the
// guides' rounding scales with the box.
import assert from 'node:assert/strict';
import test from 'node:test';
import { evalGuides, builtins, presetShape } from '../src/flow/presets.mjs';

const SIZES = [[240, 165], [77, 53], [731520, 502920]];

test('sin and cos round as Word\'s do', () => {
  // Word's values (2026-10-30, read from its PDF of custom geometry that draws each guide as a coordinate in EMU, to about 60 EMU):
  // the rounding error of a quarter turn's cos and sin magnified 1e15 times (drawn 1e6 times larger), and sin at 359.99998 degrees
  // less sin at -0.00002 degrees magnified 1e18 times. Turning the angle to radians in one step gives 1.194 for c450 and -1099 here.
  const v = evalGuides([['c90', 'cos 1000000000000000 5400000'], ['s180', 'sin 1000000000000000 10800000'], ['c270', 'cos 1000000000000000 16200000'],
    ['s360', 'sin 1000000000000000 21600000'], ['c450', 'cos 1000000000000000 27000000'],
    ['a', 'sin 1000000000 21599999'], ['b', 'sin 1000000000 -1'], ['d', '+- a 0 b'], ['near', '*/ d 1000000000 1']], builtins(10, 10));
  const word = { c90: 61214, s180: 122428, c270: -183642, s360: -244983, c450: 306197 };
  for (const [k, w] of Object.entries(word)) assert.ok(Math.abs(v[k] * 1e6 - w) < 60, `${k}: ${v[k]} against Word's ${w / 1e6}`);
  assert.ok(Math.abs(v.near + 254) < 60, `${v.near} against Word's -254`);
});

test('leftCircularArrow with both angles at 359.99998 degrees draws its whole inner ring, as Word does', () => {
  for (const [w, h] of SIZES) {
    const s = presetShape('leftCircularArrow', { adj1: 25000, adj2: 0, adj3: 21599999, adj4: 21599999, adj5: 25000 }, w, h);
    // The ring's left edge is at hc - rw2, the arrow's lines on the right half: the shape without its ring starts past the centre.
    assert.ok(s.bounds.x < w * 0.3, `${w} x ${h}: ${s.bounds.x}`);
  }
});

test('circularArrow with no head width keeps its body and loses its head, inside its box, as Word does', () => {
  for (const [w, h] of SIZES) {
    // At adj5 0 the published formulas put both arc ends at the centre and ring the shape in two whole ellipses, one centred on
    // the box's left edge.
    const s = presetShape('circularArrow', { adj5: 0 }, w, h);
    assert.ok(s.bounds.x > -w * 1e-6 && s.bounds.x + s.bounds.w < w * (1 + 1e-6), `${w} x ${h}: ${JSON.stringify(s.bounds)}`);
    // Everything at its ends (the comparison's 'min' case): Word draws the shape as one point at the right middle.
    const min = presetShape('circularArrow', { adj1: 0, adj2: 0, adj3: 0, adj4: 0, adj5: 0 }, w, h);
    assert.ok(min.bounds.w < w * 1e-6 && min.bounds.h < h * 1e-6, `${w} x ${h}: ${JSON.stringify(min.bounds)}`);
  }
});

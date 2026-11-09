// The colour picker's two leftovers: the triangle's hue reached by keys, and typed HSL lightness keeping the saturation through white.
import test from 'node:test';
import assert from 'node:assert/strict';
import { areaKey, fieldText, hsvaOf, withField } from '../src/tooling/kit/color.mjs';

const near = (hex, want) => {
  const n = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
  n(hex).forEach((v, i) => assert.ok(Math.abs(v - n(want)[i]) <= 1, `${hex} is not ${want}`));
};

test('typing L=100 then L=50 returns to the colour', () => {
  const white = withField(hsvaOf('#cc3344'), 'l', '100');
  assert.equal(fieldText('hex', white), '#FFFFFF');
  near(fieldText('hex', withField(white, 'l', '50')), '#cc3344');
});

test('Shift with left and right turns the triangle hue by 1 % of the ring', () => {
  const c = { h: 100, s: 0.5, v: 0.5, a: 1 };
  const right = areaKey('triangle', c, 'ArrowRight', true, 200, 160);
  const left = areaKey('triangle', c, 'ArrowLeft', true, 200, 160);
  assert.deepEqual(Object.keys(right), ['h']);
  assert.ok(Math.abs(right.h - 103.6) < 1e-9 && Math.abs(left.h - 96.4) < 1e-9);
});

test('the hue wraps round the ring', () => {
  const p = areaKey('triangle', { h: 0, s: 0.5, v: 0.5, a: 1 }, 'ArrowLeft', true, 200, 160);
  assert.ok(Math.abs(p.h - 356.4) < 1e-9);
});

test('a plain arrow moves the body and keeps the hue', () => {
  const p = areaKey('triangle', { h: 100, s: 0.5, v: 0.5, a: 1 }, 'ArrowRight', false, 200, 160);
  assert.ok(p && !('h' in p));
});

test('a key that is no arrow changes nothing', () => {
  assert.equal(areaKey('triangle', { h: 100, s: 0.5, v: 0.5, a: 1 }, 'Enter', false, 200, 160), null);
});

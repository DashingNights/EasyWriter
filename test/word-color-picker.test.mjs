import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaHandles, areaPart, areaPick, corners, FORMATS, fieldText, formatShown, hexOfHsva, hslOfHsv, hsvaOf, hsvOf, hsvOfHsl, rgbaOf, rgbOfHsv,
  transparencyOf, withField, withTransparency,
} from '../src/tooling/kit/color.mjs';

// The colour picker's models (docs/plans/word/briefs/color-picker.md): the formats, their round trips and the picking areas.
// Expected values are CSS Color 4's (#3366CC is hsl(220 60% 50%) and HSB 220 75 80).

const near = (a, b, d = 1e-9) => assert.ok(Math.abs(a - b) <= d, `${a} vs ${b}`);
const W = 208;
const H = 160;
const grey = hsvaOf('#808080');
/** Colour `c` with every field of format `fmt` typed in order, from `typed` {key: text}. */
const typeAll = (fmt, typed, c = grey) => FORMATS[fmt][1].reduce((o, [key]) => withField(o, key, typed[key]) ?? assert.fail(`${key} ${typed[key]}`), c);

test('hex text reads as #rgb, #rrggbb and #rrggbbaa, with or without the #', () => {
  assert.deepEqual(rgbaOf('#f80'), [255, 136, 0, 1]);
  assert.deepEqual(rgbaOf('3366cc'), [51, 102, 204, 1]);
  assert.deepEqual(rgbaOf('#11223380'), [17, 34, 51, 128 / 255]);
  assert.equal(rgbaOf('#12345'), null);
  assert.equal(rgbaOf('red'), null);
  assert.equal(hexOfHsva(hsvaOf('#3366CC')), '#3366cc');
  assert.equal(hexOfHsva({ h: 0, s: 1, v: 1, a: 0.5 }), '#ff000080', 'half opacity writes the alpha byte');
  assert.equal(hexOfHsva({ h: 0, s: 1, v: 1, a: 1 }), '#ff0000', 'full opacity writes six digits');
});

test('each format shows #3366CC as CSS does', () => {
  const c = hsvaOf('#3366CC');
  const shown = (fmt) => FORMATS[fmt][1].map(([key]) => fieldText(key, c));
  assert.deepEqual(shown('hex'), ['#3366CC']);
  assert.deepEqual(shown('rgb'), ['51', '102', '204']);
  assert.deepEqual(shown('rgba'), ['51', '102', '204', '100']);
  assert.deepEqual(shown('hsl'), ['220', '60', '50']);
  assert.deepEqual(shown('hsla'), ['220', '60', '50', '100']);
  assert.deepEqual(shown('hsb'), ['220', '75', '80']);
});

test('the models round-trip: every 8-bit RGB through HSV, and HSV through HSL', () => {
  for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) {
    const back = rgbOfHsv(hsvOf([r, g, b]));
    [r, g, b].forEach((x, i) => near(back[i], x, 1e-9));
    const [h, s, v] = hsvOf([r, g, b]);
    const [h2, s2, v2] = hsvOfHsl(hslOfHsv([h, s, v]), s);
    near(h2, h);
    if (v) near(s2, s, 1e-9);
    near(v2, v, 1e-9);
  }
});

test('typed values come back within one unit after the colour is stored as hex and read again', () => {
  const check = (fmt, typed) => {
    const hex = hexOfHsva(typeAll(fmt, typed));
    const back = hsvaOf(hex);
    for (const [key] of FORMATS[fmt][1]) {
      if (key === 'hex') assert.equal(fieldText(key, back), typed.hex.toUpperCase(), hex);
      else {
        let d = Math.abs(Number(fieldText(key, back)) - Number(typed[key]));
        if (key === 'h') d = Math.min(d, 360 - d);
        assert.ok(d <= 1, `${fmt} ${key}: typed ${typed[key]}, back ${fieldText(key, back)} (${hex})`);
      }
    }
  };
  for (const hex of ['#3366CC', '#00B0F0', '#C00000', '#FFFFFF', '#000000', '#7F7F7F', '#3366CC80']) check('hex', { hex });
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (const b of [0, 17, 128, 255]) {
    check('rgb', { r, g, b });
    for (const a of [0, 1, 37, 50, 99, 100]) check('rgba', { r, g, b, a });
  }
  // Hue survives 8 bits only where the colour has chroma: these keep at least 92 units between the largest and smallest channel.
  for (let h = 0; h < 360; h += 17) {
    for (const sl of [60, 80, 100]) for (const l of [40, 50, 60]) {
      check('hsl', { h, sl, l });
      check('hsla', { h, sl, l, a: 63 });
    }
    for (const s of [60, 80, 100]) for (const v of [60, 80, 100]) check('hsb', { h, s, v });
  }
});

test('a field takes only values in its range, and a typed grey keeps the hue', () => {
  const c = hsvaOf('#3366CC');
  assert.equal(withField(c, 'r', '256'), null);
  assert.equal(withField(c, 'h', '361'), null);
  assert.equal(withField(c, 'a', '101'), null);
  assert.equal(withField(c, 'l', 'abc'), null);
  assert.equal(withField(c, 'hex', '#12'), null);
  // R and G at 128 make rgb(128 128 204), hue 240; B at 128 then makes it grey, which keeps that hue.
  const greyed = ['r', 'g', 'b'].reduce((o, key) => withField(o, key, '128'), c);
  assert.equal(hexOfHsva(greyed), '#808080');
  near(greyed.h, 240, 1e-6);
  assert.equal(withField(greyed, 'h', '360').h, 0, 'a hue of 360 is 0');
});

test('without opacity the picker shows RGBA and HSLA as RGB and HSL; an unknown format is Hex', () => {
  assert.equal(formatShown('rgba', false), 'rgb');
  assert.equal(formatShown('hsla', false), 'hsl');
  assert.equal(formatShown('hsb', false), 'hsb');
  assert.equal(formatShown('rgba', true), 'rgba');
  assert.equal(formatShown('cmyk', true), 'hex');
  assert.equal(formatShown(undefined, false), 'hex');
});

test('the square picks saturation across and brightness up', () => {
  assert.deepEqual(areaPick('square', grey, 0, 0, W, H), { s: 0, v: 1 });
  assert.deepEqual(areaPick('square', grey, W, H, W, H), { s: 1, v: 0 });
  assert.deepEqual(areaPick('square', grey, -40, 999, W, H), { s: 0, v: 0 }, 'a drag past the edge clamps');
});

test('the triangle picks the hue on its ring and saturation and value inside, its corners being the hue, white and black', () => {
  const c = { h: 120, s: 0.5, v: 0.5, a: 1 };
  const [hue, white, black] = corners(W, H);
  const at = (p) => ({ ...c, ...areaPick('triangle', c, p[0], p[1], W, H, 'body') });
  assert.equal(hexOfHsva(at(hue)), '#00ff00');
  assert.equal(hexOfHsva(at(white)), '#ffffff');
  assert.equal(hexOfHsva(at(black)), '#000000');
  const ring = [W / 2 + 76 * Math.cos(Math.PI), H / 2]; // on the ring, left of the centre: 180 degrees
  assert.equal(areaPart('triangle', ...ring, W, H), 'ring');
  assert.equal(areaPart('triangle', W / 2, H / 2, W, H), 'body');
  near(areaPick('triangle', c, ...ring, W, H, 'ring').h, 180, 1e-9);
  // An inside point's handle comes back to it.
  const p = [W / 2 - 5, H / 2 + 10];
  const [hx, hy] = areaHandles('triangle', at(p), W, H)[0];
  near(hx, p[0], 1e-9);
  near(hy, p[1], 1e-9);
});

test('the HSL wheel picks hue around and saturation outward at the kept lightness', () => {
  const c = hsvaOf('#808080');
  const R = H / 2;
  const edge = { ...c, ...areaPick('wheel', c, W / 2 + R * Math.cos((240 * Math.PI) / 180), H / 2 + R * Math.sin((240 * Math.PI) / 180), W, H) };
  const [h, s, l] = hslOfHsv([edge.h, edge.s, edge.v]);
  near(h, 240, 1e-6);
  near(s, 1, 1e-9);
  near(l, hslOfHsv([c.h, c.s, c.v])[2], 1e-9);
  const p = [W / 2 + 20, H / 2 - 30];
  const [hx, hy] = areaHandles('wheel', edge && { ...edge, ...areaPick('wheel', edge, ...p, W, H) }, W, H)[0];
  near(hx, p[0], 1e-6);
  near(hy, p[1], 1e-6);
});

test('a grey keeps its hue while the area is dragged through it and back', () => {
  const start = { h: 200, s: 0.6, v: 0.7, a: 1 };
  // The square: to its left edge (grey) and back to where it started.
  let c = { ...start, ...areaPick('square', start, 0, 50, W, H) };
  assert.equal(c.s, 0);
  c = { ...c, ...areaPick('square', c, 0.6 * W, 0.3 * H, W, H) };
  assert.equal(hexOfHsva(c), hexOfHsva(start));
  // The wheel's centre and the triangle's white to black edge are grey too.
  near({ ...start, ...areaPick('wheel', start, W / 2, H / 2, W, H) }.h, 200);
  const [, white, black] = corners(W, H);
  const edge = areaPick('triangle', start, (white[0] + black[0]) / 2, (white[1] + black[1]) / 2, W, H, 'body');
  near(edge.s, 0, 1e-9);
  assert.equal('h' in edge, false);
});

test('HSL lightness taken to black and back keeps the saturation', () => {
  const c = hsvaOf('#3366CC'); // hsl(220 60% 50%)
  const black = withField(c, 'l', '0');
  assert.equal(hexOfHsva(black), '#000000');
  assert.equal(fieldText('sl', black), '60');
  assert.equal(hexOfHsva(withField(black, 'l', '50')), '#3366cc');
});

test('a Word fill transparency in percent goes to the picker as alpha and back', () => {
  assert.equal(withTransparency('#3366CC', 0), '#3366CC');
  assert.equal(withTransparency('#3366CC', undefined), '#3366CC');
  assert.equal(withTransparency('#3366CC', 50), '#3366CC80');
  assert.equal(withTransparency('#3366CC', 100), '#3366CC00');
  assert.deepEqual(transparencyOf('#3366CC80'), { color: '3366CC', transparency: 50 });
  assert.deepEqual(transparencyOf('#3366cc'), { color: '3366CC', transparency: 0 });
  assert.equal(transparencyOf(null), null);
  for (const pct of [0, 1, 25, 37, 50, 99, 100]) assert.equal(transparencyOf(withTransparency('#102030', pct)).transparency, pct);
});

// Picture Format's pure part (src/document/wp/picture-format/pictures.mjs; docs/plans/word brief picture-format.md Acceptance).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjustFilters, aspectCrop, compressSize, effectsCss, filterSvg, fillCrop, fitCrop, PICTURE_STYLES, recolorSvg, resetAttrs, svgOf, svgUnits, svgUrl, toneGains,
} from '../src/document/wp/picture-format/pictures.mjs';

test('brightness adds and contrast pivots on mid grey: a linear transfer', () => {
  const f = adjustFilters({ brightness: 0.2, contrast: -0.2 });
  assert.deepEqual(f.transfer, { slope: 0.8, intercept: 0.3 });
  assert.match(filterSvg({ brightness: 0.2, contrast: -0.2 }), /type="linear" slope="0.8" intercept="0.3"/);
  assert.equal(adjustFilters({}).transfer, null);
});

test('saturation, tone and transparency', () => {
  assert.ok(adjustFilters({ saturation: 0 }).css.includes('saturate(0)'));
  const [r, , b] = toneGains(4700);
  assert.ok(r > b, 'a warm tone has more red than blue');
  assert.deepEqual(toneGains(6500), [1, 1, 1]);
  assert.equal(adjustFilters({ transparency: 0.5 }).opacity, 0.5);
});

test('Set Transparent Color and recolor draw in the SVG filter', () => {
  const svg = filterSvg({ transparentColor: '#FF0000', recolor: { kind: 'grayscale' } });
  assert.match(svg, /type="discrete"/);
  assert.match(svg, /-1 -1 -1 0 3/);
  assert.match(svg, /operator="in"/);
  assert.match(svg, /type="saturate" values="0"/);
});

test('effects as CSS', () => {
  const fx = effectsCss({ shadow: { kind: 'outer', angle: 45, distance: 3, blur: 4, color: '#000000', transparency: 0.6 }, softEdge: 5 });
  assert.match(fx.filter[0], /^drop-shadow\(/);
  assert.match(fx.mask, /linear-gradient/);
  assert.equal(effectsCss({ shadow: { kind: 'inner', angle: 0, distance: 4 } }).inner.length, 1);
});

test('crop arithmetic', () => {
  // Fractions are of each side's own length (Word's a:srcRect): 225 of 300 px kept leaves 0.125 top and bottom.
  assert.deepEqual(aspectCrop(400, 300, '16:9'), { t: 0.125, r: 0, b: 0.125, l: 0 });
  assert.deepEqual(aspectCrop(400, 300, '1:1'), { t: 0, r: 0.125, b: 0, l: 0.125 });
  assert.deepEqual(aspectCrop(400, 300, '4:3'), { t: 0, r: 0, b: 0, l: 0 });
  assert.deepEqual(fillCrop(200, 200, 400, 300), { t: 0, r: 0.125, b: 0, l: 0.125 });
  assert.deepEqual(fitCrop(200, 200, 400, 300), { t: -0.166667, r: 0, b: -0.166667, l: 0 });
  assert.deepEqual(fitCrop(400, 300, 800, 600), { t: 0, r: 0, b: 0, l: 0 });
});

test('compress size', () => {
  assert.equal(compressSize(2000, 3, 150), 450);
  assert.equal(compressSize(300, 3, 150), 300);
});

test('Picture Styles hold the 28 probe names', () => {
  // probe/menus/picture.picture-format.picture-styles.json, in order.
  const names = [
    'Simple Frame, White',
    'Beveled Matte, White',
    'Metal Frame',
    'Drop Shadow Rectangle',
    'Reflected Rounded Rectangle',
    'Soft Edge Rectangle',
    'Double Frame, Black',
    'Thick Matte, Black',
    'Simple Frame, Black',
    'Beveled Oval, Black',
    'Compound Frame, Black',
    'Moderate Frame, Black',
    'Center Shadow Rectangle',
    'Rounded Diagonal Corner, White',
    'Snip Diagonal Corner, White',
    'Moderate Frame, White',
    'Rotated, White',
    'Perspective Shadow, White',
    'Relaxed Perspective, White',
    'Soft Edge Oval',
    'Bevel Rectangle',
    'Bevel Perspective',
    'Reflected Perspective Right',
    'Bevel Perspective Left, White',
    'Reflected Bevel, Black',
    'Reflected Bevel, White',
    'Metal Rounded Rectangle',
    'Metal Oval',
  ];
  assert.deepEqual(PICTURE_STYLES.map((s) => s.name), names);
  assert.ok(PICTURE_STYLES.find((s) => s.id === 'dropShadowRectangle').effects.shadow);
  assert.equal(new Set(PICTURE_STYLES.map((s) => s.id)).size, 28);
});

test('resetAttrs keeps alt, name and layout', () => {
  const attrs = { src: 'data:x', alt: 'A', name: 'P1', layout: { wrap: 'square' }, adjust: { brightness: 0.2 }, border: { width: 3 }, effects: { softEdge: 5 },
    style: 'x', crop: { t: 0.1, r: 0, b: 0, l: 0, shape: 'ellipse' }, rotate: 30, orig: { w: 400, h: 300 }, width: 100, height: 70 };
  const p = resetAttrs(attrs);
  for (const k of ['alt', 'name', 'layout', 'src']) assert.ok(!(k in p), `${k} stays`);
  assert.deepEqual(p.crop, { t: 0.1, r: 0, b: 0, l: 0 });
  assert.equal(p.adjust, null);
  const s = resetAttrs(attrs, { size: true });
  assert.equal(s.crop, null);
  assert.equal(s.rotate, null);
  assert.equal(s.width, 400);
  assert.equal(s.height, 300);
});

test('recolorSvg sets every fill to the colour and keeps none', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#123456" d="M0 0h5v5z"/><rect style="fill: blue; stroke: red" width="2" height="2"/><g fill="none"><circle r="1"/></g></svg>';
  const out = recolorSvg(src, { fill: '#FF0000' });
  assert.equal((out.match(/#123456|blue/g) ?? []).length, 0);
  assert.match(out, /<svg[^>]*fill="#FF0000"/);
  assert.match(out, /path fill="#FF0000"/);
  assert.match(out, /fill: #FF0000/);
  assert.match(out, /g fill="none"/);
  assert.equal(svgOf(svgUrl(out)), out);
  assert.match(recolorSvg(src, { stroke: '#00FF00', strokeWidth: 2 }), /stroke: #00FF00/);
});

test('svgUnits turns points into the SVG user units the picture is drawn at', () => {
  const svg = (vb) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><rect width="1" height="1"/></svg>`;
  assert.equal(svgUnits(svg('0 0 1000 1000'), 0.75, 80), 12.5); // 1 px on screen is 12.5 units of a 1000-unit box drawn 80 px wide
  assert.equal(svgUnits(svg('0 0 10 10'), 3, 100), 0.4);
  assert.equal(svgUnits('<svg width="50px" height="50px"></svg>', 3, 100), 2);
  assert.equal(svgUnits('<svg></svg>', 3, 100), 4);
});

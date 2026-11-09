// vml-effects: VML gradients, shadows, outlines and WordArt warps translate into the DrawingML the importer reads (vml.mjs), and
// the importer's own readers (dml.mjs shapeLook) take them as a gradient, a shadow and a dashed, opacity-carrying line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../src/document/docx/import.mjs';
import { vmlDrawings, color2 } from '../src/document/docx/vml.mjs';
import { shapeLook } from '../src/document/docx/dml.mjs';

const NS = 'xmlns:w="w" xmlns:v="v" xmlns:o="o" xmlns:w10="w10" xmlns:r="r"';
const one = (xml, types) => vmlDrawings(parseXml(`<w:pict ${NS}>${xml}</w:pict>`), types)[0];
const kids = (n, name) => (n?.kids ?? []).filter((k) => typeof k === 'object' && (!name || k.name === name));
const deep = (n, name, out = []) => { for (const k of kids(n)) (k.name === name ? out.push(k) : deep(k, name, out)); return out; };
const find = (n, name) => deep({ kids: [n] }, name)[0] ?? null;
const at = (n, a) => n?.attrs?.[a];
const BOX = 'style="width:100pt;height:50pt"';
const look = (d) => shapeLook(find(d, 'wps:spPr') ?? find(d, 'pic:spPr'), null, { colors: {} });
/** A rect with this v:fill → its gradient as the importer reads it: [angle, kind, 'pos color' ...]. */
const grad = (fill, attrs = 'fillcolor="red"') => {
  const f = look(one(`<v:rect ${BOX} ${attrs}><v:fill color2="blue" type="gradient" ${fill}/></v:rect>`)).fill;
  return [f.angle, f.kind, ...f.stops.map((s) => `${s.pos} ${s.color}`)];
};

test('color2: fill, darken and lighten shade the fill colour', () => {
  assert.equal(color2('fill darken(128)', '804020'), '402010');
  assert.equal(color2('fill lighten(51)', '000000'), 'CCCCCC');
  assert.equal(color2('fill', 'ABCDEF'), 'ABCDEF');
  assert.equal(color2('#00f', 'ABCDEF'), '0000FF');
});

test('linear gradients: angle and focus as Word draws its four variants per shading style', () => {
  // Horizontal (angle 0): focus 100% puts the fill colour on top (a:lin 90: top to bottom).
  assert.deepEqual(grad('focus="100%"'), [90, 'linear', '0 #FF0000', '1 #0000FF']);
  assert.deepEqual(grad(''), [270, 'linear', '0 #FF0000', '1 #0000FF'], 'focus 0 runs back: the fill colour at the bottom');
  assert.deepEqual(grad('focus="50%"'), [270, 'linear', '0 #FF0000', '0.5 #0000FF', '1 #FF0000'], 'focus 50% there and back');
  assert.deepEqual(grad('focus="-50%"'), [270, 'linear', '0 #0000FF', '0.5 #FF0000', '1 #0000FF']);
  // Vertical (-90) and the diagonals (-135, -45): the fill colour on the left, top left and bottom left.
  assert.deepEqual(grad('angle="-90" focus="100%"'), [0, 'linear', '0 #FF0000', '1 #0000FF']);
  assert.deepEqual(grad('angle="-135" focus="100%"'), [45, 'linear', '0 #FF0000', '1 #0000FF']);
  assert.deepEqual(grad('angle="-45" focus="100%"'), [315, 'linear', '0 #FF0000', '1 #0000FF']);
  assert.deepEqual(grad('angle="90" focus="100%"'), [0, 'linear', '0 #FF0000', '1 #0000FF'], 'Word swaps the colours from 180: 90 and -90 match');
});

test('gradient stops: a colors list, opacity2, and color2 as a shade of the fill', () => {
  assert.deepEqual(grad('focus="100%" colors="0 red;32768f lime;1 blue"'), [90, 'linear', '0 #FF0000', '0.5 #00FF00', '1 #0000FF']);
  const d = one(`<v:rect ${BOX} fillcolor="#336699"><v:fill type="gradient" color2="fill darken(0)" focus="100%" opacity=".5" o:opacity2="0"/></v:rect>`);
  const gs = deep(d, 'a:gs').map((g) => [at(g, 'pos'), at(find(g, 'a:srgbClr'), 'val'), at(find(g, 'a:alpha'), 'val')]);
  assert.deepEqual(gs, [['0', '336699', '50000'], ['100000', '000000', '0']]);
  assert.equal(at(find(d, 'a:lin'), 'scaled'), '1', 'VML gradients scale with the shape');
});

test('radial gradients: a path from the focus position; focus 100% puts the fill colour in the middle', () => {
  const d = one(`<v:rect ${BOX} fillcolor="red"><v:fill color2="blue" type="gradientRadial" focus="100%" focusposition=".5,.5" focussize=""/></v:rect>`);
  const f = look(d).fill;
  assert.deepEqual([f.kind, f.stops.map((s) => s.color)], ['radial', ['#FF0000', '#0000FF']]);
  assert.deepEqual(['l', 't', 'r', 'b'].map((k) => at(find(d, 'a:fillToRect'), k)), ['50000', '50000', '50000', '50000']);
  const corner = look(one(`<v:rect ${BOX} fillcolor="red"><v:fill color2="blue" type="gradientRadial" focusposition="1,0"/></v:rect>`)).fill;
  assert.deepEqual(corner.stops.map((s) => s.color), ['#0000FF', '#FF0000']);
});

test('shadows: v:shadow on becomes an outer shadow at its offset, colour and opacity; off or absent gives none', () => {
  const s = look(one(`<v:rect ${BOX}><v:shadow on="t" color="#333" opacity=".5" offset="3pt,4pt"/></v:rect>`)).shadow;
  assert.deepEqual([s.color, s.alpha, s.blur, s.dist], ['#333333', 0.5, 0, 5]);
  assert.ok(Math.abs(s.angle - 53.13) < 0.01, 'the offset 3, 4 points down and right');
  const def = look(one(`<v:oval ${BOX}><v:shadow on="t"/></v:oval>`)).shadow;
  assert.deepEqual([def.color, def.alpha, def.dist, def.angle], ['#808080', 1, 2.83, 45]);
  assert.equal(look(one(`<v:rect ${BOX}><v:shadow on="f"/></v:rect>`)).shadow, null);
  assert.equal(look(one(`<v:rect ${BOX}/>`)).shadow, null);
  const pic = one(`<v:shape ${BOX} type="#_x0000_t75"><v:imagedata r:id="rId1"/><v:shadow on="t" offset="-2pt,2pt"/></v:shape>`);
  assert.equal(at(find(find(pic, 'pic:spPr'), 'a:outerShdw'), 'dir'), String(135 * 60000), 'a picture keeps its shadow');
  const shapetype = new Map();
  one('<v:shapetype id="_x0000_t1" o:spt="1"><v:shadow on="t" offset="1pt,0"/></v:shapetype>', shapetype);
  assert.equal(look(one(`<v:shape type="#_x0000_t1" ${BOX}/>`, shapetype)).shadow.dist, 1, 'a shapetype\'s shadow carries over');
});

test('outlines: preset and custom dashes, opacity, arrows', () => {
  const ln = (stroke) => find(find(one(`<v:line from="0,0" to="100pt,0" strokecolor="red" strokeweight="2pt"><v:stroke ${stroke}/></v:line>`), 'wps:spPr'), 'a:ln');
  const c = ln('dashstyle="4 2 1 2" opacity="25%" startarrow="diamond" endarrow="open" endarrowlength="short"');
  assert.deepEqual(deep(c, 'a:ds').map((d) => [at(d, 'd'), at(d, 'sp')]), [['400000', '200000'], ['100000', '200000']]);
  assert.equal(find(c, 'a:prstDash'), null);
  assert.equal(at(find(c, 'a:alpha'), 'val'), '25000');
  assert.deepEqual([at(find(c, 'a:headEnd'), 'type'), at(find(c, 'a:tailEnd'), 'type'), at(find(c, 'a:tailEnd'), 'len')], ['diamond', 'arrow', 'sm']);
  assert.equal(look(one(`<v:rect ${BOX}><v:stroke dashstyle="1 1"/></v:rect>`)).line.dash, 'dash', 'the importer reads a custom dash as dashed');
  assert.equal(at(find(ln('dashstyle="longDashDotDot"'), 'a:prstDash'), 'val'), 'lgDashDotDot');
});

test('WordArt: its shapetype becomes the text warp; outline and shadow go on the letters; a gradient gives its middle colour', () => {
  const types = new Map();
  one('<v:shapetype id="_x0000_t144" coordsize="21600,21600" o:spt="144" adj="11796480" path="al10800,10800,10800,10800@3@15e"><v:textpath on="t" fitshape="t"/></v:shapetype>', types);
  const d = one('<v:shape type="#_x0000_t144" style="position:absolute;width:200pt;height:100pt" fillcolor="red" strokecolor="navy" strokeweight="1pt">'
    + '<v:fill color2="blue" type="gradient" focus="50%"/><v:shadow on="t" color="silver" offset="2pt,2pt"/>'
    + '<v:textpath style="font-family:&quot;Arial Black&quot;" string="Arch"/></v:shape>', types);
  const body = find(d, 'wps:bodyPr');
  assert.equal(at(find(body, 'a:prstTxWarp'), 'prst'), 'textArchUp');
  assert.deepEqual(kids(body).map((k) => k.name), ['a:prstTxWarp', 'a:noAutofit'], 'the warp comes first in bodyPr');
  const rPr = find(d, 'a:rPr');
  assert.deepEqual(kids(rPr).map((k) => k.name), ['a:ln', 'a:solidFill', 'a:effectLst', 'a:latin'], 'CT_TextCharacterProperties order');
  assert.equal(at(find(kids(rPr, 'a:solidFill')[0], 'a:srgbClr'), 'val'), '0000FF', 'focus 50%: blue in the middle');
  assert.equal(at(find(kids(rPr, 'a:ln')[0], 'a:srgbClr'), 'val'), '000080');
  const sp = find(d, 'wps:spPr');
  assert.ok(find(sp, 'a:noFill') && !find(sp, 'a:effectLst'), 'the shape itself draws nothing and casts no box shadow');
  const plain = one('<v:shape type="#_x0000_t136" style="width:1pt;height:1pt" stroked="f"><v:textpath string="x"/></v:shape>');
  assert.equal(at(find(plain, 'a:prstTxWarp'), 'prst'), 'textPlain', 'an undefined shapetype is named by its id');
  assert.equal(find(find(plain, 'a:rPr'), 'a:ln'), null, 'no outline when not stroked');
  assert.equal(at(find(one('<v:shape o:spt="175" style="width:1pt;height:1pt"><v:textpath string="x"/></v:shape>'), 'a:prstTxWarp'), 'prst'), 'textCanDown');
});

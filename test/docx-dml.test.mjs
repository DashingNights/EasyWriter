import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmlColor, fmtOf, pictureLook, pictureXml, shapeLook, srgbXml } from '../src/document/docx/dml.mjs';
import { parseXml } from '../src/document/docx/import.mjs';

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const X = (xml) => parseXml(`<root ${A}>${xml}</root>`);
const colors = { dk1: '#000000', lt1: '#FFFFFF', accent1: '#4472C4', accent2: '#ED7D31' };
const c = (inner, mods = '') => dmlColor(X(`<a:solidFill>${inner.replace('/>', `>${mods}</${inner.match(/<(a:\w+)/)[1]}>`)}</a:solidFill>`).kids[0], colors);

test('DrawingML colour transforms, each with the spec\'s maths, in the order the file lists them', () => {
  assert.equal(c('<a:schemeClr val="accent1"/>'), '#4472C4');
  assert.equal(c('<a:schemeClr val="tx1"/>'), '#000000', 'tx1 maps to dk1');
  // Word's own theme shades: "Accent 1, Darker 25%" and "Lighter 40%" (HSL luminance).
  assert.equal(c('<a:schemeClr val="accent1"/>', '<a:lumMod val="75000"/>'), '#2F5597');
  assert.equal(c('<a:schemeClr val="accent1"/>', '<a:lumMod val="60000"/><a:lumOff val="40000"/>'), '#8FAADC');
  assert.notEqual(c('<a:schemeClr val="accent1"/>', '<a:lumOff val="40000"/><a:lumMod val="60000"/>'), '#8FAADC', 'order counts');
  assert.equal(c('<a:srgbClr val="000000"/>', '<a:tint val="67000"/>'), '#9B9B9B', 'tint mixes with white in linear RGB');
  assert.equal(c('<a:srgbClr val="FFFFFF"/>', '<a:shade val="50000"/>'), '#BCBCBC', 'shade mixes with black in linear RGB');
  assert.equal(c('<a:srgbClr val="FF0000"/>', '<a:alpha val="50000"/>'), '#FF000080');
  assert.equal(c('<a:srgbClr val="FF0000"/>', '<a:alpha val="50000"/><a:alphaMod val="50000"/>'), '#FF000040');
  assert.equal(c('<a:srgbClr val="FF0000"/>', '<a:comp/>'), '#00FFFF');
  assert.equal(c('<a:srgbClr val="336699"/>', '<a:inv/>'), '#CC9966');
  assert.equal(c('<a:srgbClr val="FF0000"/>', '<a:gray/>'), '#4D4D4D');
  assert.equal(c('<a:srgbClr val="FF0000"/>', '<a:satMod val="0"/>'), '#808080');
  assert.equal(c('<a:srgbClr val="808080"/>', '<a:satOff val="100000"/>'), '#FF0101');
  assert.equal(c('<a:srgbClr val="FF0000"/>', '<a:hueOff val="5400000"/>'), '#80FF00');
  assert.equal(c('<a:srgbClr val="0000FF"/>', '<a:hueMod val="50000"/>'), '#00FF00');
  assert.equal(c('<a:srgbClr val="0000FF"/>', '<a:hue val="0"/>'), '#FF0000');
  assert.equal(c('<a:sysClr val="windowText" lastClr="111111"/>'), '#111111');
  assert.equal(c('<a:prstClr val="red"/>'), '#FF0000');
  assert.equal(c('<a:hslClr hue="0" sat="100000" lum="50000"/>'), '#FF0000');
  assert.equal(c('<a:scrgbClr r="100000" g="0" b="0"/>'), '#FF0000');
  assert.equal(srgbXml('#FF000080'), '<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>', 'the whole percent that gives the byte, as Word writes it');
  assert.equal(srgbXml('#00ff00'), '<a:srgbClr val="00FF00"/>');
});

const THEME = parseXml(`<a:theme ${A}><a:themeElements><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
  <a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="73000"/></a:schemeClr></a:gs>
  <a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
  <a:pattFill prst="pct5"><a:fgClr><a:schemeClr val="phClr"><a:lumMod val="50000"/></a:schemeClr></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill></a:fillStyleLst>
  <a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:ln></a:lnStyleLst>
  <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>
  <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
const ctx = { colors, fonts: { major: 'Aptos Display', minor: 'Aptos' }, fmt: fmtOf(THEME) };
const look = (spPr, style = '') => {
  const r = X(`<sp>${spPr}</sp><st>${style}</st>`);
  return shapeLook(r.kids[0], style ? r.kids[1] : null, ctx);
};

test('style references index the theme\'s lists with phClr as the reference\'s colour; the shape\'s own properties win', () => {
  // The ethics form's checkbox square: no fill or line of its own, lnRef 1 and fillRef 2 in dk1.
  const sq = look('', '<a:lnRef idx="1"><a:schemeClr val="dk1"/></a:lnRef><a:fillRef idx="2"><a:schemeClr val="dk1"/></a:fillRef><a:effectRef idx="1"><a:schemeClr val="dk1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>');
  assert.equal(sq.fill.type, 'gradient');
  assert.deepEqual(sq.fill.stops.map((s) => s.color), ['#9B9B9B', '#8E8E8E', '#797979'], 'grey: black tinted in linear RGB');
  assert.equal(sq.fill.color, '#8E8E8E', 'the middle stop');
  assert.equal(sq.fill.angle, 90);
  assert.deepEqual([sq.line.fill.color, sq.line.width, sq.line.dash], ['#000000', 6350, 'solid']);
  assert.equal(sq.shadow, null, 'effect style 1 is empty');
  assert.deepEqual(sq.font, { face: 'Aptos', color: '#FFFFFF' });
  // phClr carries the reference colour's own transforms, then the list entry's.
  const ref = look('', '<a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent2"/></a:fillRef><a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef>');
  assert.equal(ref.fill.color, c('<a:schemeClr val="accent2"/>', '<a:lumMod val="50000"/>'), 'a pattern is its foreground colour');
  assert.equal(ref.line.fill.color, c('<a:schemeClr val="accent1"/>', '<a:shade val="50000"/>'));
  assert.equal(ref.line.width, 12700);
  assert.deepEqual(ref.shadow, { color: '#000000', alpha: 0.4, blur: 4, dist: 3, angle: 45 });
  assert.equal(look('', '<a:fillRef idx="1001"><a:schemeClr val="accent1"/></a:fillRef>').fill.color, c('<a:schemeClr val="accent1"/>', '<a:tint val="50000"/>'), 'background fill list from 1001');
  assert.equal(look('', '<a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>').fill.type, 'none', 'idx 0 is no fill');
  // Own fill, and an own a:ln that keeps the style's colour but sets its width, dash and ends.
  const own = look('<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:ln w="25400"><a:prstDash val="dash"/><a:headEnd type="oval"/><a:tailEnd type="triangle" w="lg"/></a:ln>',
    '<a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef>');
  assert.equal(own.fill.color, '#00FF00');
  assert.deepEqual([own.line.fill.color, own.line.width, own.line.dash, own.line.head.type, own.line.tail.type, own.line.tail.w], ['#4472C4', 25400, 'dash', 'oval', 'triangle', 'lg']);
  assert.equal(look('<a:ln><a:noFill/></a:ln>', '<a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef>').line, null, 'an own a:noFill line draws none');
  assert.deepEqual([look('').fill.type, look('').line], ['none', null], 'no style: no fill and no line');
});

test('a picture\'s crop, crop shape, border, live colour changes and effects read as Word writes them, and pictureXml writes them back', () => {
  const p = (blip, sp, src = '') => X(`<pic:pic><pic:blipFill><a:blip r:embed="rId1">${blip}</a:blip>${src}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm/>${sp}</pic:spPr></pic:pic>`).kids[0];
  const a = pictureLook(p('', '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:ln w="38100"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:prstDash val="sysDot"/></a:ln>',
    '<a:srcRect l="24997" r="-10000"/>'), colors);
  assert.deepEqual(a.crop, { t: 0, r: -0.1, b: 0, l: 0.24997, shape: 'ellipse' }, 'a negative crop is Fit\'s padding');
  assert.deepEqual(a.border, { color: '#4472C4', width: 3, dash: 'sysDot' });
  assert.deepEqual(pictureLook(p('', '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln>'), colors), { border: { color: 'none' } }, 'No Outline, no crop');
  const adj = (blip) => pictureLook(p(blip, ''), colors).adjust;
  assert.deepEqual(adj('<a:alphaModFix amt="50000"/><a:lum bright="20000" contrast="-20000"/>'), { transparency: 0.5, brightness: 0.2, contrast: -0.2 });
  assert.deepEqual(adj('<a:lum bright="70000" contrast="-70000"/>'), { recolor: { kind: 'washout' } });
  assert.deepEqual(adj('<a:grayscl/>'), { recolor: { kind: 'grayscale' } });
  assert.deepEqual(adj('<a:biLevel thresh="25000"/>'), { recolor: { kind: 'bw', threshold: 0.25 } });
  // A duotone runs from its first colour to its second: Word's "Accent 1 dark" (a shade to white) and "light" (black to a tint).
  assert.equal(adj('<a:duotone><a:schemeClr val="accent1"><a:shade val="45000"/></a:schemeClr><a:prstClr val="white"/></a:duotone>').recolor.kind, 'light');
  assert.deepEqual(adj('<a:duotone><a:prstClr val="black"/><a:srgbClr val="FF0000"/></a:duotone>'), { recolor: { kind: 'dark', color: '#FF0000' } });
  assert.deepEqual(adj('<a:clrChange><a:clrFrom><a:srgbClr val="4682B4"/></a:clrFrom><a:clrTo><a:srgbClr val="4682B4"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>'), { transparentColor: '#4682B4' });
  assert.equal(adj('<a:extLst><a:ext uri="{BEBA8EAE-BF5A-486C-A8C5-ECC9F3942E4B}"><a14:imgProps/></a:ext></a:extLst>'), undefined, 'Word\'s own corrections are in the pixels already');
  const fx = pictureLook(p('', '<a:effectLst><a:glow rad="63500"><a:schemeClr val="accent2"><a:alpha val="40000"/></a:schemeClr></a:glow>'
    + '<a:outerShdw blurRad="76200" dir="13500000" sy="23000" kx="1200000" algn="br"><a:prstClr val="black"><a:alpha val="20000"/></a:prstClr></a:outerShdw>'
    + '<a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/><a:softEdge rad="127000"/></a:effectLst>'
    + '<a:scene3d><a:camera prst="perspectiveFront" fov="7200000"><a:rot lat="1200000" lon="18900000" rev="0"/></a:camera><a:lightRig rig="threePt" dir="t"/></a:scene3d>'
    + '<a:sp3d><a:bevelT w="0" prst="slope"/></a:sp3d>'), colors).effects;
  assert.deepEqual(fx, { shadow: { kind: 'perspective', color: '#000000', transparency: 0.8, size: 1, blur: 6, angle: 225, distance: 0 },
    glow: { size: 5, color: '#ED7D31', transparency: 0.6 }, reflection: { size: 0.35, distance: 0, transparency: 0.48, blur: 0.5 }, softEdge: 10,
    bevel: { kind: 'slope', width: 0, height: 6 }, rotation3d: { x: 45, y: 20, z: 0, perspective: 120 } }, 'Word\'s X rotation of 45 degrees is a longitude of 315');

  const attrs = { crop: { t: 0.1, r: 0, b: 0, l: 0.25, shape: 'roundRect' }, border: { color: '#FF8000', width: 4.5, dash: 'dash' },
    adjust: { transparentColor: '#FFFFFF', recolor: { kind: 'light', color: '#336699' }, brightness: 0.4, contrast: -0.2, transparency: 0.3 },
    effects: { shadow: { kind: 'inner', color: '#000000', transparency: 0.5, blur: 5, angle: 225, distance: 4 }, glow: { size: 8, color: '#156082', transparency: 0.4 },
      reflection: { size: 0.5, distance: 4, transparency: 0.5, blur: 0.5 }, softEdge: 2.5, bevel: { kind: 'circle', width: 6, height: 6 },
      rotation3d: { x: 45, y: 35, z: 0, perspective: 0 } } };
  const x = pictureXml(attrs);
  assert.match(x.sp, /^<a:ln w="57150">.*<\/a:ln><a:effectLst><a:glow .*<a:innerShdw .*<a:reflection .*<a:softEdge rad="31750"\/><\/a:effectLst><a:scene3d>.*<\/a:scene3d><a:sp3d><a:bevelT\/><\/a:sp3d>$/, 'spPr\'s order');
  assert.deepEqual(pictureLook(p(x.blip, x.geom + x.sp, x.crop), colors), attrs);
  for (const kind of ['grayscale', 'washout', 'sepia']) assert.equal(pictureLook(p(pictureXml({ adjust: { recolor: { kind } } }).blip, ''), colors).adjust.recolor.kind, kind === 'sepia' ? 'dark' : kind,
    'Word\'s Sepia is a duotone from black');
});

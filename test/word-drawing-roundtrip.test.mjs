// drawing-roundtrip (docs/plans/word/briefs/drawing-roundtrip.md): pictures and shapes keep, and draw, what Word wrote. The one
// gradient, pattern and picture fill reader and writer (docx/dml.mjs), preset cameras (src/tooling/rotation3d.mjs), SVG pictures
// with their fallback, theme links on pictures and text boxes, hidden lines, and the CSS a text box draws them with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxLook, boxSpXml, colorXml, effectsOf, effectsXml, gradFillEl, gradientOf, heldFallback, heldGradient, heldPattern, pictureLook, pictureSource,
  pictureXml, rethemeItems, svgKey, xmlOf } from '../src/document/docx/dml.mjs';
import { parseXml } from '../src/document/docx/import.mjs';
import { CAMERAS, cameraOf, rotationCss, rotationOf } from '../src/tooling/rotation3d.mjs';
import { boxBackground, gradientCss } from '../src/document/wp/textbox/boxes.mjs';
import { ROTATIONS } from '../src/document/wp/picture-format/pictures.mjs';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
const X = (xml) => parseXml(`<root ${NS}>${xml}</root>`).kids[0];
const colors = { dk1: '#000000', lt1: '#FFFFFF', dk2: '#0E2841', accent1: '#156082', accent2: '#E97132' };
const ctx = { colors };
// Word's own XML from the fixture (all-features.docx).
const LINEAR = '<a:gradFill flip="none" rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="4472C4"/></a:gs><a:gs pos="50000"><a:schemeClr val="bg1"/></a:gs>'
  + '<a:gs pos="100000"><a:srgbClr val="FFD966"/></a:gs></a:gsLst><a:lin ang="2700000" scaled="1"/><a:tileRect/></a:gradFill>';
const CORNER = '<a:gradFill flip="none" rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="4472C4"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFD966"/></a:gs></a:gsLst>'
  + '<a:path path="rect"><a:fillToRect r="100000" b="100000"/></a:path><a:tileRect l="-100000" t="-100000"/></a:gradFill>';
const LINE = '<a:ln w="6350"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln>';
const sp = (inner) => X(`<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1371600" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${inner}</wps:spPr>`);
const spXml = (a, rid) => boxSpXml(a, rid);

test('one gradient reader and writer: Word\'s a:gradFill comes back as it was, flip, scaled, focus and tile rectangles included', () => {
  for (const xml of [LINEAR, CORNER]) {
    const g = gradientOf(X(xml), colors);
    assert.equal(xmlOf(gradFillEl({ gradient: g, themeColors: { 'gradient.stops.1.color': g.stops[1]?.link && { ...g.stops[1].link, color: g.stops[1].color } } })), xml);
  }
  const c = gradientOf(X(CORNER), colors);
  assert.deepEqual([c.kind, c.path, c.focus, c.tile, c.flip], ['radial', 'rect', { r: 1, b: 1 }, { l: -1, t: -1 }, 'none']);
  assert.equal(gradientOf(X(LINEAR), colors).scaled, true);
  assert.equal(gradientOf(X('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>'), colors).scaled, undefined,
    'what the writer writes anyway is not kept');
});

test('a text box keeps a gradient, a pattern, a texture and a picture fill, draws them and writes them back', () => {
  const pictures = { rId7: 'data:image/jpeg;base64,AAAA' };
  const picture = (rid) => pictures[rid] ?? null;
  const g = boxLook(sp(LINEAR + LINE), null, ctx, picture);
  assert.equal(g.fill, g.gradient.color, 'fill is the gradient\'s middle colour');
  assert.equal(g.themeColors['gradient.stops.1.color'].attrs.val, 'bg1');
  assert.equal(g.themeColors['line.color'].el, 'prstClr', 'Word\'s preset black line keeps its form');
  assert.equal(spXml(g), LINEAR + LINE.replace('</a:ln>', '<a:prstDash val="solid"/></a:ln>'));
  assert.match(boxBackground({ ...g, w: 108, h: 54 }), /^linear-gradient\(/);
  assert.match(spXml({ ...g, fill: '#FF0000' }), /^<a:solidFill><a:srgbClr val="FF0000"\/><\/a:solidFill>/, 'a fill the user picks replaces the gradient');

  const PATT = '<a:pattFill prst="lgCheck"><a:fgClr><a:srgbClr val="1F3864"/></a:fgClr><a:bgClr><a:schemeClr val="bg1"/></a:bgClr></a:pattFill>';
  const p = boxLook(sp(PATT + LINE), null, ctx, picture);
  assert.deepEqual(p.fill, { kind: 'pattern', pattern: 'lgCheck', fg: '#1F3864', bg: '#FFFFFF' }, 'Fill Effects\' own terms');
  assert.ok(spXml(p).startsWith(PATT), spXml(p));
  assert.match(boxBackground(p), /^url\("data:image\/svg\+xml/);

  const TEX = '<a:blipFill><a:blip r:embed="rId7"/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" algn="tl"/></a:blipFill>';
  const t = boxLook(sp(TEX + LINE), null, ctx, picture);
  assert.deepEqual(t.fill, { kind: 'texture', src: pictures.rId7, tile: { tx: 0, ty: 0, sx: 100000, sy: 100000, flip: 'none', algn: 'tl' } });
  assert.ok(spXml(t, 'rId3').startsWith(TEX.replace('rId7', 'rId3')));
  assert.match(boxBackground(t), /^url\("data:image\/jpeg[^)]*\) 0 0 \/ auto repeat$/);
  const pic = boxLook(sp('<a:blipFill><a:blip r:embed="rId7"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'), null, ctx, picture);
  assert.equal(pic.fill.kind, 'picture');
  assert.ok(spXml(pic, 'rId4').startsWith('<a:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'));
  assert.equal(boxLook(sp(TEX), null, ctx, () => null).fill, null, 'a picture that cannot be read is no fill');
});

test('No Outline keeps Word\'s hidden line, written back while the box has no line', () => {
  const HIDDEN = '<a:extLst><a:ext uri="{91240B29-F687-4F45-9708-019B960494DF}"><a14:hiddenLine xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" w="6350">'
    + '<a:solidFill><a:prstClr val="black"/></a:solidFill></a14:hiddenLine></a:ext></a:extLst>';
  const b = boxLook(sp(`<a:noFill/><a:ln w="6350"><a:noFill/></a:ln>${HIDDEN}`), null, ctx);
  assert.equal(b.line, null);
  assert.equal(spXml(b), `<a:noFill/><a:ln w="6350"><a:noFill/></a:ln>${HIDDEN}`);
  assert.doesNotMatch(spXml({ ...b, line: { color: '#000000', width: 1, dash: 'solid' } }), /hiddenLine/, 'a line the user sets ends it');
});

test('a theme colour keeps its link while it holds; a new transparency keeps the link, a new colour drops it', () => {
  const link = { el: 'schemeClr', attrs: { val: 'accent1' }, mods: [['alpha', '40000']], color: '#156082' };
  const o = { c: '#156082', themeColors: { c: link } };
  assert.equal(colorXml(o, 'c', '#156082', 0.4), '<a:schemeClr val="accent1"><a:alpha val="40000"/></a:schemeClr>');
  assert.equal(colorXml(o, 'c', '#156082', 0.5), '<a:schemeClr val="accent1"><a:alpha val="50000"/></a:schemeClr>');
  assert.equal(colorXml(o, 'c', '#FF0000', 0.4), '<a:srgbClr val="FF0000"><a:alpha val="40000"/></a:srgbClr>');
  // Design > Colors on a picture's attrs and on a text box with a theme gradient: the middle colour moves with its stops.
  const [p] = rethemeItems([{ border: { color: '#156082', width: 3 }, themeColors: { 'border.color': { ...link, mods: [] } } }], { ...colors, accent1: '#FF0000' });
  assert.equal(p.border.color, '#FF0000');
  const g = boxLook(sp(LINEAR), null, ctx);
  const [b] = rethemeItems([g], { ...colors, lt1: '#000000' });
  assert.equal(b.gradient.stops[1].color, '#000000');
  assert.equal(b.fill, b.gradient.color, 'the gradient still holds');
});

test('a board item\'s gradient and pattern hold while its colour is still the one they show', () => {
  const it = { type: 'shape', fill: 'solid', fillColor: '#8080FF', gradient: { kind: 'linear', angle: 90, stops: [{ pos: 0, color: '#FFFFFF' }, { pos: 1, color: '#0000FF' }] } };
  assert.ok(heldGradient(it));
  assert.equal(heldGradient({ ...it, fillColor: '#FF0000' }), null);
  const pt = { type: 'shape', fill: 'solid', fillColor: '#1F3864', pattern: { prst: 'pct50', fg: '#1F3864', bg: '#FFFFFF' } };
  assert.ok(heldPattern(pt));
  assert.equal(heldPattern({ ...pt, fillColor: '#00FF00' }), null);
});

test('Word\'s preset cameras: their angles, drawn as Word draws them, written back while they hold', () => {
  assert.deepEqual(CAMERAS.isometricLeftDown, { x: -45, y: 35, z: 0, perspective: 0 });
  assert.deepEqual(CAMERAS.perspectiveLeft, { x: -20, y: 0, z: 0, perspective: 45 });
  assert.equal(rotationCss({ preset: 'isometricLeftDown' }), 'perspective(2000px) rotateZ(0deg) rotateX(35deg) rotateY(45deg)', 'Shape Effects\' preset on a text box');
  const r = effectsOf(X('<pic:spPr><a:scene3d><a:camera prst="isometricLeftDown"/><a:lightRig rig="threePt" dir="t"/></a:scene3d></pic:spPr>'), colors).rotation3d;
  assert.deepEqual(r, { ...CAMERAS.isometricLeftDown, camera: 'isometricLeftDown' });
  assert.deepEqual(cameraOf(rotationOf(r)), { camera: 'isometricLeftDown', rot: false });
  assert.equal(effectsXml({ rotation3d: r }), '<a:scene3d><a:camera prst="isometricLeftDown"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>');
  assert.match(effectsXml({ rotation3d: { ...r, x: 10 } }), /<a:camera prst="isometricLeftDown"><a:rot lat="2100000" lon="21000000" rev="0"\/><\/a:camera>/, 'turned by hand: the angles go with it');
  assert.match(effectsXml({ rotation3d: { ...r, perspective: 60 } }), /<a:camera prst="perspectiveFront" fov="3600000"><a:rot /, 'a parallel preset given perspective');
  assert.equal(effectsOf(X('<pic:spPr><a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d></pic:spPr>'), colors), null, 'the front camera turns nothing');
  assert.deepEqual(ROTATIONS.find((x) => x.id === 'isoLeftDown').value, { ...CAMERAS.isometricLeftDown, camera: 'isometricLeftDown' }, 'the gallery draws Word\'s preset');
});

test('a picture keeps cstate, its border and recolour theme colours, and an SVG with Word\'s PNG fallback', () => {
  const PIC = (blip, spPr) => X(`<pic:pic><pic:blipFill><a:blip r:embed="rId1" cstate="print">${blip}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>${spPr}</pic:spPr></pic:pic>`);
  const DUO = '<a:duotone><a:schemeClr val="tx2"><a:shade val="45000"/><a:satMod val="135000"/></a:schemeClr><a:prstClr val="white"/></a:duotone>';
  const BORDER = '<a:ln w="38100"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>';
  const a = pictureLook(PIC(DUO, BORDER), colors);
  assert.equal(a.cstate, 'print');
  assert.equal(a.adjust.recolor.kind, 'light');
  assert.deepEqual(Object.keys(a.themeColors).sort(), ['adjust.recolor.color', 'border.color']);
  const x = pictureXml(a, { svg: 'rId9' });
  assert.equal(x.blip, `${DUO}<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst>`);
  assert.deepEqual(x.blipAttrs, { cstate: 'print' });
  assert.equal(x.sp, BORDER);
  assert.match(pictureXml({ ...a, border: { ...a.border, color: '#00FF00' } }).sp, /<a:srgbClr val="00FF00"\/>/, 'a colour picked by the user goes out as itself');

  const SVG = 'data:image/svg+xml;base64,PHN2Zy8+';
  const PNG = 'data:image/png;base64,AAAA';
  const blip = X('<a:blip r:embed="rId1"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId2"/></a:ext></a:extLst></a:blip>');
  const shown = pictureSource(blip, (rid) => ({ rId1: PNG, rId2: SVG })[rid]);
  assert.deepEqual(shown, { src: SVG, fallback: { src: PNG, of: svgKey(SVG) } }, 'the SVG shows; the PNG is its fallback');
  assert.equal(heldFallback(shown), PNG);
  assert.equal(heldFallback({ ...shown, src: 'data:image/svg+xml;base64,PHN2ZyBmaWxsPSJyZWQiLz4=' }), null, 'a recoloured SVG needs a new fallback');
  assert.deepEqual(pictureSource(X('<a:blip r:embed="rId1"/>'), () => PNG), { src: PNG });
});

test('a Word gradient\'s CSS: a scaled one runs along the stretched box, a path one from its focus to its tile\'s edges', () => {
  const stops = [{ pos: 0, color: '#4472C4' }, { pos: 1, color: '#FFD966' }];
  assert.equal(gradientCss({ kind: 'linear', angle: 90, scaled: true, stops }, 2, 1), 'linear-gradient(180deg, #4472C4 0%, #FFD966 100%)');
  assert.equal(gradientCss({ kind: 'linear', angle: 45, scaled: true, stops }, 2, 1), 'linear-gradient(153.43deg, #4472C4 0%, #FFD966 100%)', 'CSS\'s "to bottom right" on a 2:1 box');
  assert.equal(gradientCss({ kind: 'linear', angle: 45, stops }, 2, 1), 'linear-gradient(135deg, #4472C4 0%, #FFD966 100%)', 'unscaled: the angle as it is');
  assert.equal(gradientCss({ kind: 'radial', path: 'rect', focus: { r: 1, b: 1 }, tile: { l: -1, t: -1 }, stops }, 108, 54),
    'radial-gradient(108pt 54pt at 0% 0%, #4472C4 0%, #FFD966 100%)', 'From Corner: the top left corner out to the far edges');
  assert.equal(gradientCss({ kind: 'radial', stops }, 108, 54), 'radial-gradient(54pt 27pt at 50% 50%, #4472C4 0%, #FFD966 100%)', 'From Center');
});

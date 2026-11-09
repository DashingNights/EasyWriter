// default-shape-look (docs/plans/word/briefs/default-shape-look.md): a Document's new shapes, lines and text boxes take its theme's
// default looks (a:objectDefaults, else Word's own through the theme) as theme links, Set as Default writes them, and .docx export
// and import carry them in theme1.xml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLooks, defaultOf, shapeItem, toolLook } from '../src/document/wp/shapes/map.mjs';
import { objectDefaultsInto, objectDefaultsOf, objectDefaultsXml, THEMES, withObjectDefault } from '../src/document/wp/design/model.mjs';
import { linkColor, PLAIN_FMT, rethemeItems } from '../src/document/docx/dml.mjs';
import { exportDocx } from '../src/document/docx/export.mjs';
import { importDocx, parseXml } from '../src/document/docx/import.mjs';
import { readZip, text } from '../src/document/docx/zip.mjs';
import { THEME } from '../src/document/defaults.mjs';

const PX = 96 / 72;
const shade15 = { el: 'schemeClr', attrs: { val: 'accent1' }, mods: [['shade', '15000']] };

test("without objectDefaults: Word's own looks through the theme, as theme links", () => {
  const { spDef, lnDef, txDef } = defaultLooks(THEME);
  assert.equal(spDef.fillColor, THEME.colors.accent1);
  assert.equal(spDef.color, linkColor(shade15, THEME.colors), 'the outline is Accent 1 at its 15 % shade');
  assert.deepEqual(spDef.themeColors.fillColor.attrs, { val: 'accent1' });
  assert.deepEqual(spDef.themeColors.color.mods, [['shade', '15000']]);
  assert.equal(spDef.width, Math.round(PX * 10000) / 10000, "the theme's second line style: 1 pt");
  assert.equal(spDef.textColor, THEME.colors.lt1);
  assert.equal(spDef.styleRefs.lnRef.idx, '2');
  assert.equal(lnDef.color, THEME.colors.accent1);
  assert.equal(lnDef.width, Math.round((PX / 2) * 10000) / 10000, "the theme's first line style: 1/2 pt");
  assert.deepEqual([txDef.fill, txDef.line.color, txDef.line.width], ['#FFFFFF', '#000000', 0.5], 'a text box: Background 1 and a black 1/2 pt line');
  assert.deepEqual(txDef.themeColors.fill.attrs, { val: 'bg1' });
});

test("another theme's Accent 1, a .docx theme's own line widths; Design > Colors recolours what was drawn", () => {
  const ember = THEMES.find((t) => t.id === 'ember');
  const looks = defaultLooks(ember);
  assert.equal(looks.spDef.fillColor, ember.colors.accent1);
  const kept = { ...THEME, kept: { xml: '<a:lnStyleLst><a:ln w="9525"/><a:ln w="25400"/><a:ln w="38100"/></a:lnStyleLst>' } };
  assert.equal(defaultLooks(kept).spDef.width, Math.round(2 * PX * 10000) / 10000, 'lnRef 2 is the theme part\'s 2 pt line');

  const rect = shapeItem('Rectangle', { x: 0, y: 0, w: 96, h: 48 });
  const line = shapeItem('Line', { x: 0, y: 0, w: 96, h: 0 });
  assert.deepEqual([rect.fillColor, rect.color, line.color], [THEME.colors.accent1, linkColor(shade15, THEME.colors), THEME.colors.accent1]);
  const [r2, l2] = rethemeItems([rect, line], ember.colors);
  assert.deepEqual([r2.fillColor, r2.color, l2.color], [ember.colors.accent1, linkColor(shade15, ember.colors), ember.colors.accent1]);
  const arc = shapeItem('Arc', null);
  assert.deepEqual([arc.fill, arc.color, arc.width], ['none', THEME.colors.accent1, line.width], 'an arc draws in the line look, unfilled');
});

test('the board tools: shapes, the Lines connectors, and Curve open in the line look, closed in the shape look', () => {
  const looks = defaultLooks(THEME);
  assert.equal(toolLook(looks, 'shape', 'rect'), looks.spDef);
  assert.equal(toolLook(looks, 'conn'), looks.lnDef);
  const path = toolLook(looks, 'path');
  assert.deepEqual([path.open.fill, path.open.color, path.open.fillColor], ['none', THEME.colors.accent1, THEME.colors.accent1]);
  assert.equal(path.closed, looks.spDef);
});

test('Set as Default Shape: the next shape is green; the default goes out in theme1.xml and comes back', async () => {
  const green = { ...shapeItem('Oval', null), fillColor: '#00B050', width: 3 };
  const look = defaultOf('spDef', green, 0.5);
  assert.equal(look.width, 1.5, 'a width at the canvas display scale');
  assert.equal(look.themeColors.fillColor, undefined, 'a colour the user picked is no longer a theme link');
  assert.ok(look.themeColors.color, 'the outline still is');
  const theme = withObjectDefault(THEME, 'spDef', look);
  assert.equal(shapeItem('Rectangle', null, {}, (tool, kind) => toolLook(defaultLooks(theme), tool, kind)).fillColor, '#00B050');
  assert.equal(defaultLooks(theme).lnDef.color, THEME.colors.accent1, 'the line default is unchanged');

  // Export writes it into theme1.xml; import reads it back.
  const xml = objectDefaultsXml(theme.objectDefaults);
  assert.match(xml, /^<a:objectDefaults><a:spDef><a:spPr><a:solidFill><a:srgbClr val="00B050"\/><\/a:solidFill><a:ln w="\d+"><a:solidFill><a:schemeClr val="accent1"><a:shade val="15000"\/>/);
  assert.match(xml, /<\/a:spPr><a:bodyPr\/><a:lstStyle\/><a:style><a:lnRef idx="2">/);
  const back = objectDefaultsOf(parseXml(`<a:theme>${xml}</a:theme>`).kids[0], { colors: THEME.colors, fmt: PLAIN_FMT, fonts: THEME.fonts });
  assert.deepEqual([back.spDef.fillColor, back.spDef.color, back.spDef.textColor], [look.fillColor, look.color, look.textColor]);
  assert.ok(Math.abs(back.spDef.width - look.width) < 0.001, 'the width to the EMU');

  const doc = { type: 'doc', attrs: { theme }, content: [{ type: 'paragraph' }] };
  const { bytes } = await exportDocx(doc);
  const part = text((await readZip(bytes)).get('word/theme/theme1.xml'));
  assert.match(part, /<\/a:themeElements><a:objectDefaults><a:spDef>.*00B050.*<\/a:spDef><\/a:objectDefaults><\/a:theme>$/s);
  const reopened = (await importDocx(bytes, { fresh: true })).doc.attrs.theme;
  assert.equal(defaultLooks(reopened).spDef.fillColor, '#00B050');
  assert.deepEqual(reopened.kept.objectDefaults, reopened.objectDefaults, 'what import read is kept to tell a change on export');
});

test("a .docx theme's own objectDefaults stay as Word wrote them until one is set", () => {
  const xml = '<a:theme><a:themeElements/><a:objectDefaults><a:spDef><a:spPr/><a:bodyPr wrap="none"/><a:lstStyle/></a:spDef></a:objectDefaults></a:theme>';
  const read = { spDef: { fill: 'none' } };
  const theme = { ...THEME, objectDefaults: read, kept: { xml, objectDefaults: structuredClone(read) } };
  assert.equal(objectDefaultsInto(xml, theme), xml);
  const set = withObjectDefault(theme, 'lnDef', defaultLooks(THEME).lnDef);
  assert.match(objectDefaultsInto(xml, set), /<a:themeElements\/><a:objectDefaults><a:spDef><a:spPr><a:noFill\/>.*<a:lnDef>.*<\/a:objectDefaults><\/a:theme>$/);
  const plain = '<a:theme><a:themeElements/></a:theme>';
  assert.equal(objectDefaultsInto(plain, THEME), plain, 'no defaults set: nothing written');
});

test('Set as Default Text Box and Line take what each default keeps', () => {
  const box = { ...defaultLooks(THEME).txDef, w: 144, h: 72, fill: '#FFC000', line: { color: '#C00000', width: 2, dash: 'dash' }, layout: {} };
  const tx = defaultOf('txDef', box);
  assert.deepEqual(Object.keys(tx).sort(), ['fill', 'line'], 'the look only, with no link left on a picked colour');
  const back = objectDefaultsOf(parseXml(`<a:theme>${objectDefaultsXml({ txDef: tx })}</a:theme>`).kids[0], { colors: THEME.colors, fmt: PLAIN_FMT, fonts: THEME.fonts });
  assert.deepEqual([back.txDef.fill, back.txDef.line.color, back.txDef.line.width], ['#FFC000', '#C00000', 2]);
  const ln = defaultOf('lnDef', { ...shapeItem('Line', null), color: '#7030A0', width: 4, heads: { start: 'none', end: 'arrow' } });
  assert.deepEqual([ln.color, ln.width, ln.heads], ['#7030A0', 4, undefined], 'a line default keeps its look, not its arrowheads');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { BUILTIN_STYLES, newDocumentJson, THEME } from '../src/document/defaults.mjs';
import { resolveColor } from '../src/office.mjs';
import {
  colorItems, COLOR_SETS, EFFECTS, fontItems, FONT_SETS, savedSet, setTheme, SPACING, spacingKey, STYLE_SETS, styleSetOf, THEMES, themeWith, withSetSpacing, withSpacing,
  rethemeValue, withStyleSet,
} from '../src/document/wp/design/model.mjs';

// The design work package's pure logic (docs/plans/word/briefs/design.md Acceptance).
const schema = getSchema(documentExtensions(50));
const near = (a, b) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1);
const harbour = THEMES.find((t) => t.id === 'harbour');

function docWith(content) {
  const json = newDocumentJson({});
  json.content = content;
  return EditorState.create({ doc: schema.nodeFromJSON(json) });
}
const run = (text, attrs) => ({ type: 'text', text, marks: [{ type: 'textStyle', attrs }] });

test('a theme re-resolves runs and style runs that hold a themeColor, and leaves plain colours', () => {
  const link = { slot: 'accent1', lum: -0.25 };
  const state = docWith([{ type: 'paragraph', content: [run('linked', { color: resolveColor(THEME, link), themeColor: link }), run('plain', { color: '#123456' })] }]);
  const theme = themeWith(state.doc.attrs.theme, harbour);
  const tr = setTheme(state.tr, theme);
  const marks = [];
  tr.doc.descendants((n) => { if (n.isText) marks.push(n.marks[0].attrs); });
  const want = resolveColor(theme, link);
  assert.ok(near(marks[0].color, want), `${marks[0].color} vs ${want}`);
  assert.equal(marks[1].color, '#123456');
  const h1 = tr.doc.attrs.styles.list.Heading1.run;
  assert.ok(near(h1.color, resolveColor(theme, h1.themeColor)), 'Heading 1 follows the new accent');
  assert.notEqual(h1.color, BUILTIN_STYLES.Heading1.run.color);
  assert.equal(tr.doc.attrs.theme.fonts.major, harbour.fonts.major);
  assert.equal(tr.steps.filter((s) => s.constructor.name === 'DocAttrStep').length >= 1, true);
});

test('a style set replaces Normal and Heading 1 to 9 and keeps a user style; Reset restores the built-ins', () => {
  const styles = structuredClone(newDocumentJson({}).attrs.styles);
  styles.list.Mine = { type: 'paragraph', name: 'Mine', run: { bold: true } };
  const set = styleSetOf('strongHeadings');
  const next = withStyleSet(styles, set, THEME);
  assert.equal(next.list.Mine.run.bold, true);
  assert.equal(next.list.Heading1.run.caps, true);
  assert.equal(next.list.Heading2.run.bold, true);
  assert.equal(next.defaults.run.size, 11);
  assert.ok(next.defaults.run.lang, 'the proofing language stays');
  assert.equal(next.styleSet, 'strongHeadings');
  const back = withStyleSet(next, STYLE_SETS[0], THEME);
  // The built-ins with their theme colours resolved by resolveColor (Word's stored hex differs by at most 1 per channel).
  for (const id of ['Normal', 'Heading1', 'Heading9', 'Title', 'IntenseQuote']) assert.deepEqual(back.list[id], rethemeValue(BUILTIN_STYLES[id], THEME), id);
  assert.ok(near(back.list.Heading1.run.color, BUILTIN_STYLES.Heading1.run.color));
  assert.equal(back.defaults.run.size, 12);
  assert.equal(back.list.Mine.run.bold, true);
});

test('each Paragraph Spacing preset writes its defaults spacing, and Default returns the set\'s', () => {
  let styles = structuredClone(newDocumentJson({}).attrs.styles);
  styles.list.Normal = { ...styles.list.Normal, para: { spacing: { after: 20 } } };
  assert.equal(spacingKey(styles), null);
  for (const [key, { before, after, line }] of Object.entries(SPACING)) {
    const s = withSpacing(styles, key);
    assert.deepEqual(s.defaults.para.spacing, { before, after, line: { rule: 'auto', value: line } }, key);
    assert.equal(s.list.Normal.para.spacing, undefined, 'Normal\'s own spacing is cleared');
    assert.equal(spacingKey(s), key);
  }
  styles = withSpacing(styles, 'double');
  assert.deepEqual(styles.defaults.para.spacing, { before: 0, after: 8, line: { rule: 'auto', value: 2 } });
  assert.equal(spacingKey(withSetSpacing(styles)), 'default');
});

test('a saved style set comes back through styleSetOf', () => {
  const styles = withStyleSet(newDocumentJson({}).attrs.styles, styleSetOf('ruled'), THEME);
  const saved = savedSet('Mine', styles);
  const set = styleSetOf('custom:Mine', [saved]);
  assert.equal(set.name, 'Mine');
  assert.deepEqual(set.list.Heading1, styles.list.Heading1);
});

// Word's names from probe/menus/design.themes.json, design.colors.json, design.document-formatting.json and design.effects.json.
const WORD_NAMES = new Set(['Custom', 'Theme1', 'Office', 'Office 2013 - 2022 Theme', 'Facet', 'Gallery', 'Integral', 'Ion', 'Ion Boardroom', 'Organic',
  'Retrospect', 'Slice', 'Wisp', 'Banded', 'Basis', 'Berlin', 'Circuit', 'Damask', 'Dividend', 'Droplet', 'Frame', 'Main Event', 'Mesh',
  'Metropolitan', 'Parallax', 'Parcel', 'Savon', 'Slate', 'Vapor Trail', 'View', 'Wood Type', 'Office 2013 - 2022', 'Office 2007 - 2010',
  'Grayscale', 'Blue Warm', 'Blue', 'Blue II', 'Blue Green', 'Green', 'Green Yellow', 'Yellow', 'Yellow Orange', 'Orange', 'Orange Red', 'Red Orange',
  'Red', 'Red Violet', 'Violet', 'Violet II', 'Median', 'Paper', 'Marquee', 'Slipstream', 'Aspect', 'This Document', 'Document', 'Basic (Elegant)',
  'Basic (Simple)', 'Basic (Stylish)', 'Black & White (Capitalized)', 'Black & White (Classic)', 'Black & White (Numbered)', 'Black & White (Word 2013)',
  'Casual', 'Centered', 'Lines (Distinctive)', 'Lines (Simple)', 'Lines (Stylish)', 'Minimalist', 'Shaded', 'Word', 'Word 2003', 'Word 2010', 'Word 2013',
  'Subtle Solids', 'Banded Edge', 'Smokey Glass', 'Glow Edge', 'Grunge Texture', 'Frosted Glass', 'Top Shadow', 'Inset', 'Milk Glass', 'Riblet',
  'Reflection', 'Extreme Shadow', 'Glossy',
  // design.fonts.json: the sets' names
  'Calibri', 'Arial', 'Corbel', 'Candara', 'Franklin Gothic', 'Century Gothic', 'Tw Cen MT', 'Cambria', 'Garamond', 'Georgia', 'Century Schoolbook',
  'Calibri-Cambria', 'Arial-Times New Roman', 'Calibri Light-Constantia', 'Century Gothic-Palatino Linotype', 'Tw Cen MT-Rockwell',
  'Times New Roman-Arial', 'Constantia-Franklin Gothic Book', 'Consolas-Verdana', 'Arial Black-Arial', 'Garamond-TrebuchetMs', 'Gill Sans MT', 'TrebuchetMs']);

test('no theme, colour set, font set, style set or effect is named as one of Word\'s, nor mentions Office or Word', () => {
  const names = [...THEMES, ...COLOR_SETS, ...FONT_SETS, ...STYLE_SETS, ...EFFECTS].map((x) => x.name);
  for (const n of names) {
    assert.ok(!WORD_NAMES.has(n), n);
    assert.ok(!/\b(office|word|microsoft)\b/i.test(n), n);
  }
  assert.equal(new Set(THEMES.map((t) => t.name)).size, THEMES.length);
  for (const t of THEMES) assert.equal(Object.keys(t.colors).length, 12, t.name);
});

test('saved colour and font sets head the galleries under Custom', () => {
  const theme = THEMES[0];
  const colors = colorItems(theme, [{ name: 'Custom 1', colors: { ...theme.colors, accent1: '#FF0000' } }]);
  assert.deepEqual([colors[0].id, colors[0].group, colors[0].label], ['custom:Custom 1', 'Custom', 'Custom 1']);
  assert.ok(colors.find((c) => c.id === 'default').active);
  const fonts = fontItems(theme, [{ name: 'Custom 1', major: 'Georgia', minor: 'Verdana' }]);
  assert.deepEqual([fonts[0].group, fonts[0].label], ['Custom', 'Custom 1, Heading Font: Georgia, Body Font: Verdana']);
});

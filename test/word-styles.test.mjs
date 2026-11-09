// The styles work package's pure logic (docs/plans/word/briefs/styles.md Acceptance) and stylesheet.js's character styles,
// linked halves and v1 key names.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_STYLES, newDocumentJson } from '../src/document/defaults.mjs';
import { resolved, styleSheetCss } from '../src/document/stylesheet.js';
import {
  addTextAction, addTextItemOf, CHAR_STYLES, charHalfOf, describe, displayName, foldDirect, formattingOf, galleryIds, linkedParaOf, linkedPart,
  matchedStyle, nameProblem, needs, newDocumentPatch, nextStyleName, outlineLevel, patchStyle, pilcrow, styleFromFormatting, usage, v2, withDefaults,
} from '../src/document/wp/styles/model.mjs';

const list = structuredClone(BUILTIN_STYLES);
const names = (ids) => ids.map((id) => displayName(list, id));

test('the gallery of a new Document holds Word\'s 16 quick styles in uiPriority order', () => {
  assert.deepEqual(names(galleryIds(list, {})), ['Normal', 'No Spacing', 'Heading 1', 'Heading 2', 'Title', 'Subtitle', 'Subtle Emphasis',
    'Emphasis', 'Intense Emphasis', 'Strong', 'Quote', 'Intense Quote', 'Subtle Reference', 'Intense Reference', 'Book Title', 'List Paragraph']);
  assert.deepEqual(galleryIds(list, {}).filter((id) => pilcrow(list, id)), ['Normal', 'NoSpacing', 'ListParagraph']);
});

test('Heading 3 joins the gallery once Heading 2 is used, Heading 4 once Heading 3 is', () => {
  const used = usage([{ styleId: 'Heading2', chars: [] }, { styleId: 'Normal', chars: ['Strong', 'Strong'] }]);
  assert.deepEqual(used, { Heading2: 1, Normal: 1, Strong: 1 });
  // Two separate Strong runs in one paragraph are two instances.
  assert.equal(usage([{ styleId: 'Normal', chars: ['Strong', null, 'Strong', 'Emphasis'] }]).Strong, 2);
  const ids = galleryIds(list, used);
  assert.deepEqual(ids.slice(0, 5), ['Normal', 'NoSpacing', 'Heading1', 'Heading2', 'Heading3']);
  assert.ok(!ids.includes('Heading4'));
  assert.ok(galleryIds(list, { Heading3: 2 }).includes('Heading4'));
  // Remove from Style Gallery and a new style's qFormat.
  assert.ok(!galleryIds({ ...list, Title: { ...list.Title, qFormat: false } }, {}).includes('Title'));
  assert.equal(galleryIds({ ...list, Memo: { type: 'paragraph', name: 'Memo', qFormat: true } }, {}).at(-1), 'Memo');
  // A linked style's character half never shows.
  assert.ok(!galleryIds({ ...list, Heading1Char: { type: 'character', name: 'Heading 1 Char', link: 'Heading1', qFormat: true } }, {}).includes('Heading1Char'));
});

test('the seven character style definitions', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(CHAR_STYLES).map(([id, s]) => [id, s.run])), {
    SubtleEmphasis: { italic: true, color: '#404040', themeColor: { slot: 'dk1', lum: 0.25 } },
    Emphasis: { italic: true },
    IntenseEmphasis: { italic: true, color: '#0F4761', themeColor: { slot: 'accent1', lum: -0.25 } },
    Strong: { bold: true },
    SubtleReference: { smallCaps: true, color: '#5A5A5A', themeColor: { slot: 'dk1', lum: 0.35 } },
    IntenseReference: { bold: true, smallCaps: true, spacing: 0.25, color: '#0F4761', themeColor: { slot: 'accent1', lum: -0.25 } },
    BookTitle: { bold: true, italic: true, spacing: 0.25 },
  });
  for (const s of Object.values(CHAR_STYLES)) assert.equal(s.type, 'character');
  assert.deepEqual(needs(list, 'Strong').add, { Strong: CHAR_STYLES.Strong });
  assert.equal(needs({ ...list, Strong: CHAR_STYLES.Strong }, 'Strong').add, null);
});

test('linked styles: part of a paragraph takes the character half, a caret or whole paragraphs the paragraph style', () => {
  const one = [{ from: 1, to: 20 }];
  assert.equal(linkedPart({ empty: false, from: 3, to: 9, blocks: one }), 'char');
  assert.equal(linkedPart({ empty: true, from: 3, to: 3, blocks: one }), 'para');
  assert.equal(linkedPart({ empty: false, from: 1, to: 20, blocks: one }), 'para');
  assert.equal(linkedPart({ empty: false, from: 3, to: 25, blocks: [...one, { from: 22, to: 30 }] }), 'para');
  assert.equal(linkedPart({ empty: false, from: 3, to: 9, blocks: one }, true), 'para');
  // The half: added with a link both ways; an old document pairs Heading1Char with Heading1 by id.
  const n = needs(list, 'Heading1', true);
  assert.deepEqual(n.add.Heading1Char, { type: 'character', name: 'Heading 1 Char', link: 'Heading1', uiPriority: 9, run: list.Heading1.run });
  assert.deepEqual(n.patch, { Heading1: { link: 'Heading1Char' } });
  const old = { ...list, Heading1Char: { type: 'character', name: 'Heading 1 Char' } };
  assert.equal(charHalfOf(old, 'Heading1'), 'Heading1Char');
  assert.equal(linkedParaOf(old, 'Heading1Char'), 'Heading1');
  assert.equal(charHalfOf(list, 'Normal'), null);
});

test('Create a Style: the next free name and a linked style from the direct formatting', () => {
  assert.equal(nextStyleName(list), 'Style1');
  assert.equal(nextStyleName({ ...list, Style1: { type: 'paragraph', name: 'Style1' }, X: { name: 'style2' } }), 'Style3');
  const fmt = formattingOf([{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#FF0000', size: null, charStyle: 'Strong' } }],
    { textAlign: 'center', styleId: 'Quote', numbering: null });
  assert.deepEqual(fmt, { run: { bold: true, color: '#FF0000' }, para: { textAlign: 'center' } });
  assert.deepEqual(styleFromFormatting(list, 'Memo', 'Normal', fmt), {
    id: 'Memo', style: { type: 'paragraph', name: 'Memo', basedOn: 'Normal', next: 'Memo', qFormat: true, link: 'MemoChar', run: fmt.run, para: fmt.para },
  });
  assert.equal(nameProblem(list, 'Heading 1'), 'That name belongs to a built-in style.');
  assert.equal(nameProblem(list, 'Strong'), 'That name belongs to a built-in style.');
  assert.equal(nameProblem(list, 'Memo'), null);
  assert.equal(nameProblem({ ...list, Memo: { name: 'Memo' } }, 'memo'), 'Another style already has that name.');
});

test('Update to Match Selection patches the style under v2 names and keeps its other keys', () => {
  const fmt = formattingOf([{ type: 'italic' }, { type: 'textStyle', attrs: { size: 24 } }], { textAlign: 'right' });
  const next = patchStyle(list.Quote, fmt);
  assert.deepEqual(next.para, { textAlign: 'right', spacing: { before: 8 } });
  assert.deepEqual(next.run, { italic: true, size: 24, color: '#404040', themeColor: { slot: 'dk1', lum: 0.25 } });
  assert.equal(next.basedOn, 'Normal');
  assert.equal(next.next, 'Normal');
  // A character style takes only the run.
  assert.deepEqual(patchStyle(CHAR_STYLES.Strong, fmt), { ...CHAR_STYLES.Strong, run: { bold: true, italic: true, size: 24 } });
});

test('Update to Match Selection from another style: the style takes the look of the selection over its own base', () => {
  // Heading 1 matched to a Normal paragraph with italic: only the italic differs from Normal, its colour and size go, its level stays.
  const normal = { run: { font: '+minor', size: 12 }, para: { spacing: { after: 8 } } };
  const h1 = matchedStyle(list.Heading1, { run: { ...normal.run, italic: true }, para: normal.para }, normal);
  assert.deepEqual(h1.run, { italic: true });
  assert.deepEqual(h1.para, { outline: 0 });
  assert.equal(h1.basedOn, 'Normal');
  // A toggle the base turns on and the selection lacks is turned off; a character style takes only the run.
  assert.deepEqual(matchedStyle(CHAR_STYLES.Strong, { run: { italic: true } }, { run: {} }).run, { italic: true });
  assert.deepEqual(matchedStyle({ type: 'paragraph', basedOn: 'X' }, { run: {}, para: {} }, { run: { bold: true }, para: {} }).run, { bold: false });
});

test('Automatically update folds a new centring into the style', () => {
  assert.deepEqual(foldDirect({ textAlign: null, spacing: { after: 4 } }, { textAlign: 'center', spacing: { after: 4 }, styleId: 'Memo' }),
    { para: { textAlign: 'center' }, clear: ['textAlign'] });
  assert.deepEqual(foldDirect({ textAlign: 'center' }, { textAlign: 'center' }), { para: {}, clear: [] });
});

test('outline levels: own, else the style chain, else the heading level, else Body Text', () => {
  assert.equal(outlineLevel(2, { outline: 0 }, 1), 2);
  assert.equal(outlineLevel(null, resolved(list, 'Heading2').para, 2), 1);
  assert.equal(outlineLevel(null, {}, 3), 2);
  assert.equal(outlineLevel(null, resolved(list, 'Normal').para), 9);
});

test('Add Text: Level n applies Heading n; Do Not Show takes a heading to Normal, else sets Body Text', () => {
  assert.deepEqual(addTextAction('level2', false), { style: 'Heading2' });
  assert.deepEqual(addTextAction('doNotShowInTableOfContents', true), { style: 'Normal' });
  assert.deepEqual(addTextAction('doNotShowInTableOfContents', false), { para: { outline: 9 } });
  assert.equal(addTextItemOf(9), 'doNotShowInTableOfContents');
  assert.equal(addTextItemOf(1), 'level2');
  assert.equal(addTextItemOf(5), null);
});

test('Set As Default writes the document defaults, and the new-document settings when asked', () => {
  const styles = newDocumentJson({}).attrs.styles;
  const next = withDefaults(styles, 'run', { font: 'Georgia' });
  assert.equal(next.defaults.run.font, 'Georgia');
  assert.equal(next.defaults.run.size, 12);
  assert.equal(next.list, styles.list);
  const nd = newDocumentPatch({ styles: null, theme: null }, { half: 'para', value: { spacing: { after: 0 } } });
  assert.deepEqual(nd.styles.defaults.para, { spacing: { after: 0 } });
  assert.equal(newDocumentJson({ word: { newDocument: nd } }).attrs.styles.defaults.para.spacing.after, 0);
  assert.deepEqual(newDocumentPatch(nd, { id: 'Memo', style: { type: 'paragraph' } }).styles.list, { Memo: { type: 'paragraph' } });
});

test('stylesheet: a character style, a linked half drawn from its paragraph style, and v1 key names', () => {
  const styles = { defaults: {}, list: { ...list, ...structuredClone(CHAR_STYLES), Heading1Char: { type: 'character', name: 'Heading 1 Char', link: 'Heading1' } } };
  const css = styleSheetCss('.s', styles, null);
  assert.match(css, /\.s \[data-cstyle="Strong"\]\{font-weight:bold\}/);
  assert.match(css, /\.s \[data-cstyle="Heading1Char"\]\{font-family:var\(--doc-major\);font-size:20pt;color:#0F4761/);
  // Quote's v1 align and Title's v1 charSpacing; a v2 textAlign on Normal does not beat Quote's own align.
  styles.list.Normal = { ...styles.list.Normal, para: { textAlign: 'justify' } };
  const css2 = styleSheetCss('.s', styles, null);
  assert.match(css2, /\.s \[data-style="Quote"\]\{[^}]*text-align:center/);
  assert.match(css2, /\.s \[data-style="Title"\]\{[^}]*letter-spacing:-0\.5pt/);
  assert.match(css2, /\.s \[data-style="IntenseQuote"\]\{[^}]*border-top:/);
  assert.equal(resolved(styles.list, 'Quote').para.align, 'center'); // the mirror schema.js effectiveProps reads
  assert.deepEqual(v2(list.IntenseQuote).para.borders, list.IntenseQuote.para.border);
  // Heading 7 to 9 are paragraphs with the styleId.
  assert.match(css2, /\.s \[data-style="Heading7"\]\{/);
  assert.match(describe(list, list.Quote), /Font: Italic, Font color: #404040, Centered/);
});

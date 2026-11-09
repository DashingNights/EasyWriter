// Work package clipboard (docs/plans/word plan.md §3): paste options as transforms on slice JSON, source detection and defaults,
// option availability, smart cut and paste, the Clipboard pane's items, the Spike, and the Format Painter's pick-up and apply plan.
// The Word slice below is what the schema parses from test/fixtures/word-paste.html (normaliseHtml needs a DOM, so the parsed JSON
// is written out here; the harness case pastes the HTML itself).
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_STYLES, DEFAULT_NUMBERING, THEME } from '../src/document/defaults.mjs';
import {
  applyMode, availableModes, defaultMode, pasteCase, sourceKind, stylesConflict,
} from '../src/document/wp/clipboard/modes.mjs';
import { applyPlan, nextPainter, pickUp, wordAt } from '../src/document/wp/clipboard/painter.mjs';
import { addItem, pasteAllOrder, RING_MAX, spikeAppend, spikeTake } from '../src/document/wp/clipboard/ring.mjs';
import { deleteFix, spaced, wholeWords } from '../src/document/wp/clipboard/smart.mjs';
import { WORD_DEFAULTS } from '../src/document/word/settings.mjs';

const text = (t, marks) => ({ type: 'text', text: t, ...(marks && { marks }) });
const ts = (attrs) => ({ type: 'textStyle', attrs });
const para = (content, attrs = {}) => ({ type: 'paragraph', attrs: { styleId: null, spacing: null, indent: null, numbering: null, textAlign: null, ...attrs }, content });
const marksOf = (n) => (n.marks ?? []).map((m) => m.type).sort();
const allText = (nodes) => nodes.map((n) => (n.content ?? []).map((c) => c.text ?? '').join('')).join('\n');

// test/fixtures/word-paste.html as the Document schema parses it (Heading 1, a Normal paragraph of mixed runs, Title).
const WORD_SLICE = [
  para([text('Quarterly report')], { styleId: 'Heading1' }),
  para([
    text('Plain text, '),
    text('Cambria red 14', [ts({ font: 'Cambria', size: 14, color: '#FF0000' })]),
    text(', '),
    text('accent two', [ts({ color: '#E97132', themeColor: { slot: 'accent2', lum: 0 } })]),
    text(', '),
    text('highlighted', [ts({ highlight: 'yellow' })]),
    text(' and '),
    text('bold', [{ type: 'bold' }]),
    text('.'),
  ]),
  para([text('Title text')], { styleId: 'Title' }),
];
const WORD_HTML = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><p class=MsoNormal style="mso-list:l0">x</p></html>';

const dstStyles = JSON.parse(JSON.stringify({ defaults: {}, list: BUILTIN_STYLES }));
const DEST = { destAttrs: { styleId: 'Quote', spacing: { after: 4 }, indent: null, numbering: null, textAlign: 'center' }, destMarks: [ts({ font: 'Arial', size: 9 })] };

test('source kinds: our HTML, Word HTML, other HTML, plain text and pictures', () => {
  assert.equal(sourceKind({ html: '<p data-pm-slice="1 1 []">a</p>', text: 'a' }), 'ours');
  assert.equal(sourceKind({ html: WORD_HTML, text: 'x' }), 'word');
  assert.equal(sourceKind({ html: '<b>web</b>', text: 'web' }), 'html');
  assert.equal(sourceKind({ html: '', text: 'plain' }), 'text');
  assert.equal(sourceKind({ image: 'data:image/png;base64,AA' }), 'picture');
  assert.equal(sourceKind({}), null);
});

test('the paste case picks within, between, conflict or other, and the settings give the default', () => {
  const content = [para([text('a')], { styleId: 'Custom' })];
  const src = { docKey: 'd1', styles: { list: { Custom: { type: 'paragraph', name: 'Custom', run: { bold: true } } } } };
  assert.equal(pasteCase('ours', content, src, { docKey: 'd1', styles: src.styles }), 'within');
  assert.equal(pasteCase('ours', content, src, { docKey: 'd2', styles: { list: {} } }), 'between');
  const clash = { docKey: 'd2', styles: { list: { Custom: { type: 'paragraph', name: 'Custom', run: { italic: true } } } } };
  assert.equal(pasteCase('ours', content, src, clash), 'conflict');
  assert.ok(stylesConflict(content, src.styles, clash.styles));
  assert.equal(pasteCase('word', content, null, clash), 'other');
  assert.equal(pasteCase('text', content, null, clash), 'other');
  const p = WORD_DEFAULTS.paste;
  assert.equal(defaultMode('within', p), 'keepSourceFormatting');
  assert.equal(defaultMode('between', p), 'keepSourceFormatting');
  assert.equal(defaultMode('conflict', p), 'useDestinationStyles');
  assert.equal(defaultMode('other', p), 'mergeFormatting');
  assert.equal(defaultMode('pictures', p), 'keepSourceFormatting');
});

test('the options that fit each kind of clipboard', () => {
  assert.deepEqual(availableModes('text'), ['mergeFormatting', 'keepTextOnly']);
  assert.deepEqual(availableModes('html'), ['keepSourceFormatting', 'mergeFormatting', 'keepTextOnly']);
  assert.deepEqual(availableModes('picture'), ['picture']);
  assert.deepEqual(availableModes('word'), ['keepSourceFormatting', 'mergeFormatting', 'keepTextOnly']);
  assert.deepEqual(availableModes('ours', { stylesDiffer: true, themeDiffer: true, picture: true }),
    ['keepSourceFormatting', 'mergeFormatting', 'useDestinationStyles', 'useDestinationTheme', 'picture', 'keepTextOnly']);
});

test('Keep Source Formatting keeps font and colour and adds a style the destination lacks', () => {
  const custom = { type: 'paragraph', name: 'Fancy', basedOn: 'Normal', run: { font: 'Georgia' } };
  const content = [para([text('Hello', [ts({ font: 'Cambria', color: '#FF0000' })])], { styleId: 'Fancy' })];
  const srcStyles = { ...dstStyles, list: { ...dstStyles.list, Fancy: custom } };
  const out = applyMode('keepSourceFormatting', content, { srcStyles, dstStyles, srcTheme: THEME, dstTheme: THEME, ...DEST });
  assert.equal(out.content[0].attrs.styleId, 'Fancy');
  assert.deepEqual(out.content[0].content[0].marks[0].attrs, { font: 'Cambria', color: '#FF0000' });
  // Its basedOn style Normal is in the destination already, so only Fancy is added (ensureStyles keeps what is there).
  assert.deepEqual(Object.keys(out.addStyles).filter((id) => !dstStyles.list[id]), ['Fancy']);
  assert.deepEqual(out.addStyles.Fancy, custom);
  // Word's slice keeps its runs whole under K.
  const word = applyMode('keepSourceFormatting', WORD_SLICE, { dstStyles, dstTheme: THEME, ...DEST });
  assert.deepEqual(word.content[1].content[1].marks, WORD_SLICE[1].content[1].marks);
});

test('Keep Source Formatting turns a clashing style into direct formatting and fixes theme colours to the source theme', () => {
  // The destination's Quote is italic already, so only the source's bold and alignment differ and become direct formatting.
  const srcStyles = { list: { ...dstStyles.list, Quote: { type: 'paragraph', name: 'Quote', basedOn: 'Normal', run: { bold: true, italic: true, color: '#123456' }, para: { textAlign: 'right' } } } };
  const srcTheme = { ...THEME, colors: { ...THEME.colors, accent2: '#00FF00' } };
  const content = [para([text('q', [ts({ themeColor: { slot: 'accent2', lum: 0 }, color: '#E97132' })])], { styleId: 'Quote' })];
  const out = applyMode('keepSourceFormatting', content, { srcStyles, dstStyles, srcTheme, dstTheme: THEME, ...DEST });
  const p = out.content[0];
  assert.equal(p.attrs.textAlign, 'right');
  const run = p.content[0];
  assert.deepEqual(marksOf(run), ['bold', 'textStyle']);
  const style = run.marks.find((m) => m.type === 'textStyle').attrs;
  assert.equal(style.color, '#00FF00', 'the theme colour resolves to the source theme hex (own colour wins over the style colour)');
  assert.equal(style.themeColor, null);
  // Use Destination Theme keeps the theme link.
  const h = applyMode('useDestinationTheme', content, { srcStyles, dstStyles, srcTheme, dstTheme: THEME, ...DEST });
  assert.deepEqual(h.content[0].content[0].marks.find((m) => m.type === 'textStyle').attrs.themeColor, { slot: 'accent2', lum: 0 });
});

test('Merge Formatting keeps only bold, italic and underline and takes the destination paragraph', () => {
  const out = applyMode('mergeFormatting', WORD_SLICE, { dstStyles, ...DEST });
  for (const p of out.content) {
    assert.equal(p.attrs.styleId, 'Quote');
    assert.equal(p.attrs.textAlign, 'center');
  }
  const runs = out.content[1].content;
  assert.deepEqual(marksOf(runs[1]), ['textStyle'], 'Cambria red 14 loses its own font and colour, takes the destination font');
  assert.deepEqual(runs[1].marks[0].attrs, { font: 'Arial', size: 9 });
  assert.deepEqual(marksOf(runs[7]), ['bold', 'textStyle']);
  assert.equal(allText(out.content), allText(WORD_SLICE));
});

test('Merge Formatting and Keep Text Only never copy the records of the destination paragraph onto pasted paragraphs', () => {
  const destAttrs = { ...DEST.destAttrs, suggest: { id: 's1' }, pChange: { author: 'a' }, markRev: { id: 1 }, collapsed: true, pageBreakBefore: true, frame: { w: 1 } };
  const three = [para([text('a')]), para([text('b')]), para([text('c')])];
  for (const mode of ['mergeFormatting', 'keepTextOnly']) {
    const out = applyMode(mode, three, { destAttrs, destMarks: [] });
    for (const p of out.content) {
      assert.equal(p.attrs.styleId, 'Quote', mode);
      for (const k of ['suggest', 'pChange', 'markRev', 'collapsed', 'pageBreakBefore', 'frame']) assert.ok(!(k in p.attrs), `${mode} drops ${k}`);
    }
  }
});

test('Use Destination Styles keeps style ids and drops formatting the source style gave', () => {
  const srcStyles = { list: { ...dstStyles.list, Quote: { type: 'paragraph', name: 'Quote', run: { italic: true, color: '#123456' }, para: { textAlign: 'right' } } } };
  const content = [para([text('q', [{ type: 'italic' }, ts({ color: '#123456', size: 20 })])], { styleId: 'Quote', textAlign: 'right' })];
  const out = applyMode('useDestinationStyles', content, { srcStyles, dstStyles, ...DEST });
  const p = out.content[0];
  assert.equal(p.attrs.styleId, 'Quote');
  assert.equal(p.attrs.textAlign, null);
  assert.deepEqual(p.content[0].marks, [ts({ color: null, size: 20 })]);
});

test('Keep Text Only gives tab-separated cells and typed list labels with keepBullets', () => {
  const cell = (t) => ({ type: 'tableCell', attrs: {}, content: [para([text(t)])] });
  const table = { type: 'table', attrs: {}, content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }, { type: 'tableRow', content: [cell('c'), cell('d')] }] };
  const list = [
    para([text('first')], { numbering: { numId: -5, ilvl: 0, abstract: 'decimal' } }),
    para([text('second', [{ type: 'bold' }])], { numbering: { numId: -5, ilvl: 0, abstract: 'decimal' } }),
    { type: 'image', attrs: { src: 'data:image/png;base64,AA' } },
  ];
  const out = applyMode('keepTextOnly', [table, ...list], { keepBullets: true, numbering: DEFAULT_NUMBERING, destAttrs: DEST.destAttrs, destMarks: [] });
  assert.ok(out.flat);
  assert.deepEqual(out.content.map((p) => (p.content ?? []).map((c) => c.text).join('')), ['a\tb', 'c\td', '1. first', '2. second']);
  assert.ok(out.content.every((p) => p.type === 'paragraph' && p.attrs.numbering === null && p.content.every((c) => !c.marks)));
  const plain = applyMode('keepTextOnly', list, { keepBullets: false, numbering: DEFAULT_NUMBERING });
  assert.deepEqual(plain.content.map((p) => p.content[0].text), ['first', 'second']);
  const word = applyMode('keepTextOnly', WORD_SLICE, { keepBullets: true });
  assert.equal(allText(word.content), allText(WORD_SLICE));
});

test('Keep Text Only pastes inline content alone (a bold word) as plain text', () => {
  const out = applyMode('keepTextOnly', [text('Pasted words', [{ type: 'bold' }])], { destAttrs: {}, destMarks: [] });
  assert.ok(out.flat);
  assert.deepEqual(out.content.map((p) => [p.type, p.content]), [['paragraph', [{ type: 'text', text: 'Pasted words' }]]]);
});

test('Keep Text Only pastes an inline field alone as its result', () => {
  const out = applyMode('keepTextOnly', [{ type: 'field', attrs: { code: 'DATE', result: '28/10/2026' } }], { destAttrs: {}, destMarks: [] });
  assert.deepEqual(out.content.map((p) => [p.type, p.content]), [['paragraph', [{ type: 'text', text: '28/10/2026' }]]]);
});

test('within the same Document Keep Source Formatting changes nothing', () => {
  const out = applyMode('keepSourceFormatting', WORD_SLICE, { sameDoc: true });
  assert.equal(out.content, WORD_SLICE);
});

test('smart cut and paste on the index-editing.md cases', () => {
  // Delete `two` from `one two three`.
  const s = 'one two three';
  assert.ok(wholeWords(s, 4, 7));
  assert.equal(deleteFix(' ', ' '), 'after');
  assert.ok(!wholeWords(s, 5, 7), 'part of a word is no whole word');
  // A word pasted between words gets the missing space.
  assert.equal(spaced('e', 'two', ' '), ' two');
  assert.equal(spaced(' ', 'two', 't'), 'two ');
  // A paste right before punctuation drops the space.
  assert.equal(spaced(' ', 'three ', '.'), 'three');
  // Inside a word no space is added (unverified in Word).
  assert.equal(spaced('l', 'two', 'p'), 'two');
  assert.equal(deleteFix(' ', '.'), 'before');
});

test('the Clipboard pane holds 24 items newest first and Paste All goes oldest first', () => {
  let ring = [];
  for (let i = 1; i <= 30; i++) ring = addItem(ring, { id: `c${i}`, text: `item ${i}`, html: '' });
  assert.equal(ring.length, RING_MAX);
  assert.equal(ring[0].id, 'c30');
  assert.equal(ring.at(-1).id, 'c7');
  assert.equal(addItem(ring, { id: 'again', text: 'item 30', html: '' }), ring, 'the newest is not added twice');
  assert.deepEqual(pasteAllOrder(ring.slice(0, 3)).map((x) => x.id), ['c28', 'c29', 'c30']);
});

test('the Spike adds a paragraph mark per piece and empties on insert', () => {
  let entries = [{ id: 'x', name: 'Other', gallery: 'AutoText', content: [] }];
  entries = spikeAppend(entries, [para([text('one')])], { now: 't' });
  entries = spikeAppend(entries, [text('two')], { now: 't' });
  const spike = entries.find((e) => e.name === 'Spike');
  assert.equal(spike.gallery, 'AutoText');
  assert.equal(spike.category, 'General');
  assert.equal(spike.insert, 'content');
  assert.deepEqual(spike.content.map((b) => [b.type, b.content[0].text]), [['paragraph', 'one'], ['paragraph', 'two']]);
  const { content, entries: rest } = spikeTake(entries);
  assert.equal(content.length, 2);
  assert.deepEqual(rest.map((e) => e.name), ['Other']);
  assert.deepEqual(spikeTake(rest).content, []);
});

test('Format Painter pick-up and apply on the four behaviour-tests.tsv painter rows', () => {
  const bold = [{ type: 'bold' }, ts({ color: '#FF0000' })];
  // Rows 1 and 2: picked at the caret in a bold word (or from a word), applied by dragging over a word: characters only.
  const p1 = pickUp([...bold, { type: 'link', attrs: { href: 'x' } }], 'paragraph', { textAlign: 'center', spacing: { after: 30 }, suggest: { a: 1 } });
  assert.deepEqual(p1.marks.map((m) => m.type), ['bold', 'textStyle'], 'a link is not formatting');
  assert.ok(!('suggest' in p1.para.attrs));
  assert.deepEqual(applyPlan({ empty: false, sameParagraph: true }), { chars: 'selection', para: false });
  assert.deepEqual(applyPlan({ empty: false, sameParagraph: true, wholeParagraph: true }), { chars: 'selection', para: true }, 'a triple-click');
  // Row 3: a whole paragraph picked up from its plain first character gives no bold.
  assert.deepEqual(pickUp([], 'paragraph', {}).marks, []);
  // Row 4: applied at a caret inside a word: the word takes the marks, its paragraph the alignment and space after.
  assert.deepEqual(applyPlan({ empty: true, sameParagraph: true }), { chars: 'word', para: true });
  assert.deepEqual(wordAt('alpha beta gamma', 7), [6, 10]);
  assert.equal(wordAt('alpha  beta', 6), null);
  // A selection that runs past a paragraph end takes both.
  assert.deepEqual(applyPlan({ empty: false, sameParagraph: false }), { chars: 'selection', para: true });
  // Once, sticky after a quick second run, off after that.
  assert.equal(nextPainter(null, 0, 1000), 'once');
  assert.equal(nextPainter('once', 1000, 1300), 'sticky');
  assert.equal(nextPainter('once', 1000, 2000), null);
  assert.equal(nextPainter('sticky', 1000, 1100), null);
});

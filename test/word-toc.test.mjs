import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { newDocumentJson } from '../src/document/defaults.mjs';
import { fieldCtx, parseField, registerField } from '../src/document/fields/registry.mjs';
import {
  FIELDS, NO_TOC, NO_TOF, captionInline, tcCode, tocBlocks, tocCode, tocEntries, tocState, tofCode, computeToc,
} from '../src/document/wp/toc/toc.mjs';

// The toc package's pure builders (docs/plans/word/briefs/toc.md Acceptance) on doc JSON fixtures.
for (const [name, type] of Object.entries(FIELDS)) registerField(name, type);
const schema = getSchema(documentExtensions(50));
const base = newDocumentJson({});
const doc = (...content) => schema.nodeFromJSON({ ...base, content });
const t = (text) => ({ type: 'text', text });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const p = (text, attrs = {}) => ({ type: 'paragraph', attrs, content: [t(text)] });
const fld = (code, result = null) => ({ type: 'field', attrs: { code, result } });
const entries = (d, code) => tocEntries(d, parseField(code));
const texts = (d, code) => entries(d, code).map((e) => `${e.level}:${e.text}`);
// A table's paragraphs as text, the page part included (a PAGEREF field shows its result).
const lines = (blocks) => blocks.map((b) => (b.content ?? []).map((c) => c.text ?? c.attrs?.result ?? '').join(''));

const sample = doc(h(1, 'One'), p('Body'), h(2, 'Two'), h(3, 'Three'), h(4, 'Four'), p('Outlined', { outline: 0 }));

test('\\o "1-3" lists Heading 1 to 3 in order; \\u adds a paragraph with outline level 1', () => {
  assert.deepEqual(texts(sample, 'TOC \\o "1-3" \\h \\z'), ['1:One', '2:Two', '3:Three']);
  assert.deepEqual(texts(sample, 'TOC \\o "1-3" \\h \\z \\u'), ['1:One', '2:Two', '3:Three', '1:Outlined']);
});

test('\\t "Heading 2,1" alone lists only Heading 2, at level 1', () => {
  assert.deepEqual(texts(sample, 'TOC \\t "Heading 2,1"'), ['1:Two']);
});

test('\\n 2-2 drops the level 2 page numbers and their tabs; \\p "-" writes the separator', () => {
  const f = parseField('TOC \\o "1-2" \\n 2-2');
  const blocks = tocBlocks(tocEntries(sample, f), f, { pageOf: () => '1' });
  assert.deepEqual(lines(blocks), ['One\t1', 'Two']);
  assert.ok(blocks[0].attrs.tabs, 'level 1 keeps its right tab');
  assert.equal(blocks[1].attrs.tabs, undefined);
  const g = parseField('TOC \\o "1-1" \\p "-"');
  const chapter = doc(h(1, 'Chapter heading'));
  assert.deepEqual(lines(tocBlocks(tocEntries(chapter, g), g, { pageOf: () => '1' })), ['Chapter heading-1']);
});

test('\\c "Figure" lists the paragraphs holding SEQ Figure; \\a needs Caption-style paragraphs', () => {
  const figs = doc(p('Intro'), { type: 'paragraph', content: [t('Figure '), fld('SEQ Figure \\* ARABIC', '1'), t(' A cat')] }, p('Other'));
  assert.deepEqual(texts(figs, 'TOC \\h \\z \\c "Figure"'), ['1:Figure 1 A cat']);
  const f = parseField('TOC \\a "Figure"');
  assert.deepEqual(lines(tocBlocks(tocEntries(figs, f), f)), [NO_TOF]);
  const captioned = doc({ type: 'paragraph', attrs: { styleId: 'Caption' }, content: [t('Figure '), fld('SEQ Figure \\* ARABIC', '1'), t(': A cat')] });
  assert.deepEqual(texts(captioned, 'TOC \\a "Figure"'), ['1:A cat']);
  assert.deepEqual(lines(tocBlocks([], parseField('TOC \\o'))), [NO_TOC]);
});

test('\\f F picks only TC \\f F; \\l 1-2 takes both TC levels', () => {
  const tcs = doc({ type: 'paragraph', content: [t('x'), fld('TC "Figure entry" \\f F'), fld('TC "Manual entry" \\l 2'), fld('TC "Deep" \\l 3')] });
  assert.deepEqual(texts(tcs, 'TOC \\f F'), ['1:Figure entry']);
  assert.deepEqual(texts(tcs, 'TOC \\f \\l 1-2'), ['2:Manual entry']);
  assert.deepEqual(texts(tcs, 'TOC \\f F \\l 1-2'), ['1:Figure entry']);
});

test('entries carry PAGEREF fields and links to the headings\' _Toc bookmarks', () => {
  const marked = doc({ type: 'heading', attrs: { level: 1 }, content: [
    { type: 'bookmark', attrs: { name: '_Toc123456789', id: '_Toc123456789' } }, t('One'),
    { type: 'bookmark', attrs: { name: '_Toc123456789', id: '_Toc123456789', end: true } }] });
  const f = parseField('TOC \\o "1-3" \\h \\z \\u');
  const [b] = tocBlocks(tocEntries(marked, f), f, { pageOf: () => '3', width: 450, leader: 'none' });
  assert.equal(b.attrs.styleId, 'TOC1');
  assert.deepEqual(b.attrs.tabs, [{ pos: 450, align: 'right', leader: 'none' }]);
  const field = b.content.find((c) => c.type === 'field');
  assert.deepEqual(field.attrs, { code: 'PAGEREF _Toc123456789 \\h', result: '3' });
  assert.equal(b.content[0].marks[0].attrs.anchor, '_Toc123456789');
  // The field type: a full update builds the same, Update page numbers only refreshes the PAGEREF results.
  const withToc = doc({ type: 'fieldBlock', attrs: { code: 'TOC \\o "1-3" \\h \\z \\u' }, content: [b] }, ...marked.toJSON().content);
  const pages = computeToc(parseField('TOC \\o "1-3"'), fieldCtx({ doc: withToc, pos: 0, mode: 'pages', pageAt: () => ({ label: '7' }) }));
  assert.deepEqual(lines(pages.blocks), ['One\t7']);
});

test('the caption builder with chapter numbers; the TC builder escapes quotes', () => {
  const c = captionInline('Figure', { chapter: { level: 1, sep: 'hyphen' }, seq: 2, chapterText: '3', text: ' A dog' });
  assert.deepEqual(c.map((n) => n.attrs?.code ?? n.text), ['Figure ', 'STYLEREF 1 \\s', '-', 'SEQ Figure \\* ARABIC \\s 1', ' A dog']);
  assert.deepEqual(lines([{ content: c }]), ['Figure 3-2 A dog']);
  assert.equal(tcCode('Say "hi"'), 'TC "Say \\"hi\\"" \\f C \\l "1"');
  assert.deepEqual(parseField(tcCode('Say "hi"')).args, ['Say "hi"']);
});

test('dialog state and switches round-trip', () => {
  const v = tocState('TOC \\o "1-3" \\h \\z \\u');
  assert.equal(tocCode(v), 'TOC \\o "1-3" \\h \\z \\u', 'the gallery table reads back unchanged');
  assert.match(tocCode({ ...v, levels: 2 }), /\\o "1-2"/);
  assert.equal(tocState(tocCode({ ...v, levels: 2 })).levels, 2);
  assert.equal(tocState(tocCode({ ...v, hyperlinks: false })).hyperlinks, false);
  assert.doesNotMatch(tocCode({ ...v, hyperlinks: false }), /\\h/);
  assert.equal(tocState(tocCode(v), 'none').leader, 'none');
  const f = parseField(tocCode(v));
  assert.equal(tocBlocks(tocEntries(sample, f), f, { leader: 'none' })[0].attrs.tabs[0].leader, 'none');
  assert.equal(tocState(tocCode({ ...v, rightAlign: false })).rightAlign, false);
  assert.equal(tocState(tocCode({ ...v, pageNumbers: false })).pageNumbers, false);
  assert.equal(tofCode({ hyperlinks: true, pageNumbers: true, rightAlign: true, label: 'Figure', includeLabel: true }), 'TOC \\h \\z \\c "Figure"');
});

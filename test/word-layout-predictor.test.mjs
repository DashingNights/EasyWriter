// The layout predictor's engine (src/document/layout, docs/plans/word/briefs/layout-predictor.md) with a fake measurer: every
// character 10 px wide, ascent 0.8 and descent 0.2 of the size, so a 12 pt (16 px) line is 16 px in both line models.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayout, EST } from '../src/document/layout/engine.mjs';
import { colBoxes, columnWidthOf } from '../src/document/layout/width.mjs';
import * as resolvedMod from '../src/document/model/resolved.mjs';
import * as sheet from '../src/document/stylesheet.js';
import { columnWidthAt } from '../src/document/wp/columns/model.mjs';

const fake = () => {
  const stats = { calls: 0, hits: 0, ms: 0, fonts: 0 };
  return {
    stats,
    width: (_f, t) => (stats.calls++, [...t].length * 10),
    metrics: (font) => {
      const px = Number(/([\d.]+)px/.exec(font)[1]);
      return { asc: px * 0.8, desc: px * 0.2, ascU: px * 0.8, descU: px * 0.2 };
    },
  };
};
// 300 x 200 pt paper with 20 pt margins: 346.67 px of text width and a 213.33 px body, 13 lines of 16 px.
const sect = { w: 300, h: 200, orient: 'portrait', margin: { top: 20, right: 20, bottom: 20, left: 20, header: 0, footer: 0, gutter: 0 } };
const wide = { ...sect, w: 600, h: 200, orient: 'landscape' };
const attrs = { styles: { defaults: { run: { size: 12 }, para: {} }, list: {} }, settings: { defaultTabStop: 36 }, sect, numbering: null, theme: null };
const p = (text, more = {}) => ({ type: 'paragraph', attrs: { styleId: null, ...more }, content: text ? [{ type: 'text', text }] : [] });
const docOf = (content, more = {}) => ({ type: 'doc', attrs: { ...attrs, ...more }, content });
const layout = (doc, opts) => {
  const L = createLayout(fake(), opts);
  L.open(doc);
  return L;
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} is not ${b}`);
const texts = (L, i) => L.lines([i])[0].map((para) => para.map((l) => l.text));

test('greedy breaks under the editor\'s space rule and Word\'s', () => {
  // A right indent leaves 75 px of the 260 pt text width (56.25 pt).
  const narrow = (spaces) => texts(layout(docOf([p('aaa bbb ccc', { indent: { right: 260 - 56.25 } })]), { spaces }), 0)[0];
  assert.deepEqual(narrow('hang'), ['aaa bbb ', 'ccc']);
  assert.deepEqual(narrow('break'), ['aaa ', 'bbb ccc']);
  // After a hyphen, between ideographs, a word wider than the line by characters, a hard break.
  const at = (content, right) => texts(layout(docOf([{ type: 'paragraph', attrs: { indent: { right } }, content }])), 0)[0];
  assert.deepEqual(at([{ type: 'text', text: 'well-known' }], 260 - 45), ['well-', 'known']);
  assert.deepEqual(at([{ type: 'text', text: '漢字漢字' }], 260 - 18.75), ['漢字', '漢字']);
  assert.deepEqual(at([{ type: 'text', text: 'abcdefghij' }], 260 - 33.75), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(at([{ type: 'text', text: 'a' }, { type: 'hardBreak' }], 0), ['a', '']);
});

test('the editor\'s line boxes: raised text, exact spacing under the font, a scaled run kept whole', () => {
  const run = (text, attrs) => ({ type: 'text', text, marks: [{ type: 'textStyle', attrs }] });
  const h = (para) => layout(docOf([para])).run().heights[0];
  // 12 pt text: 12.8 px over the baseline and 3.2 under it; raised 10 pt (13.33 px) the line box grows by that.
  near(h({ type: 'paragraph', attrs: {}, content: [{ type: 'text', text: 'a ' }, run('up', { position: 10 })] }), 16 + 40 / 3);
  // Exactly 0.7 pt: every line box is 0.93 px, though the font is taller.
  near(h(p('one', { spacing: { line: { rule: 'exact', value: 0.7 } } })), 0.7 * 4 / 3);
  // 'aaa bbb' at 200% is one 140 px box: with 100 px of room it overflows on one line instead of wrapping.
  const L = layout(docOf([{ type: 'paragraph', attrs: { indent: { right: 260 - 75 } }, content: [run('aaa bbb', { scale: 200 })] }]));
  assert.deepEqual(texts(L, 0)[0], ['aaa bbb']);
});

test('a generated document paginates through planPages', () => {
  const doc = docOf(Array.from({ length: 30 }, (_, i) => p(`line ${i}`)));
  const r = layout(doc).run();
  assert.equal(r.count, 3);
  assert.deepEqual(r.pages.map((pg) => pg.block), [0, 13, 26]);
  assert.ok(r.heights.every((h) => h === 16));
  // A page break starts the next page at the block after it.
  const broken = docOf([p('a'), { type: 'pageBreak', attrs: {} }, p('b')]);
  assert.deepEqual(layout(broken).run().pages.map((pg) => pg.block), [0, 2]);
});

test('an edit lays out the edited paragraph again and moves the pages after it', () => {
  const doc = docOf(Array.from({ length: 30 }, (_, i) => p(`line ${i}`)));
  const L = layout(doc);
  const first = L.run();
  assert.equal(first.counts.relaid, 30);
  // Block 2 grows to three lines (346 px holds 34 characters): pages now start at blocks 11 and 24.
  L.edit({ from: 2, to: 3, nodes: [p('x'.repeat(80))] });
  const r = L.run();
  assert.equal(r.counts.relaid, 1);
  assert.equal(r.heights[2], 48);
  assert.deepEqual(r.pages.map((pg) => pg.block), [0, 11, 24]);
  assert.equal(r.changed, 1, 'the first page keeps its start');
  // Nothing changed: nothing lays out again.
  assert.equal(L.run().counts.relaid, 0);
  // A paragraph inserted before every other shifts them without laying them out.
  L.edit({ from: 0, to: 0, nodes: [p('new')] });
  const r2 = L.run();
  assert.equal(r2.counts.relaid, 1);
  assert.equal(r2.heights.length, 31);
});

test('each section lays out at its own width: portrait, landscape and two columns', () => {
  near(columnWidthOf(sect, {}), 346.67);
  near(columnWidthOf(wide, {}), 746.67);
  const two = { count: 2, space: 36 };
  assert.equal(columnWidthOf(sect, {}, two), colBoxes(two, columnWidthOf(sect, {}))[0].width);
  const text = 'word '.repeat(30).trim(); // 149 characters, 1490 px
  const doc = docOf([
    p(text),
    { type: 'sectionBreak', attrs: { kind: 'nextPage', sect } },
    p(text),
    { type: 'sectionBreak', attrs: { kind: 'nextPage', sect: wide } },
    { type: 'columns', attrs: { count: 2, space: 36 }, content: [p(text)] },
  ], { sect });
  const L = layout(doc, { spaces: 'break' }); // the counts below hold each word's trailing space on its line
  const r = L.run();
  const lines = (i) => L.lines([i])[0][0];
  assert.equal(lines(0).length, 5); // 346.67 px: 6 words a line
  assert.equal(lines(2).length, 3); // 746.67 px: 14 words a line
  assert.equal(L.lines([4])[0][0].length, 15, 'a column of the narrow section: 149.33 px, 2 words a line');
  assert.ok(lines(2).every((l) => l.w <= 746.67 + 0.01));
  // Each section starts its own page, and the columns fold their 15 lines into 7.5 lines' height.
  assert.equal(r.pages.length, 3);
  assert.equal(r.heights[4], 120);
  assert.ok(r.est[4] & EST.approx);
});

test('the editor\'s measured height stands until the block changes', () => {
  const doc = docOf(Array.from({ length: 10 }, (_, i) => p(`line ${i}`)));
  const L = layout(doc);
  L.run();
  L.correct(3, 40);
  let r = L.run();
  assert.equal(r.heights[3], 40);
  assert.ok(r.est[3] & EST.dom);
  assert.equal(r.counts.relaid, 0);
  L.edit({ from: 3, to: 4, nodes: [p('changed')] });
  r = L.run();
  assert.equal(r.heights[3], 16);
  assert.equal(r.est[3] & EST.dom, 0);
});

test('content the engine does not model is marked as an estimate', () => {
  const img = { type: 'image', attrs: { width: 100, height: 40, layout: null } };
  const float = { type: 'image', attrs: { width: 100, height: 40, layout: { wrap: 'square' } } };
  const doc = docOf([
    { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: 'a ' }, img] },
    { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: 'b' }, float] },
    { type: 'paragraph', attrs: {}, content: [{ type: 'text', text: 'c' }, { type: 'noteRef', attrs: { kind: 'footnote' } }] },
    p('x'.repeat(34 * 14)), // 14 lines: taller than the 13-line body
  ]);
  const r = layout(doc).run();
  assert.equal(r.heights[0], 40, 'a picture on the line sets its height');
  assert.equal(r.est[0], 0);
  assert.ok(r.est[1] & EST.float);
  assert.ok(r.est[2] & EST.note);
  assert.ok(r.est[3] & EST.oversize);
  // The inline picture's frame: after 'a ' (20 px), at the top of page 1's body.
  assert.deepEqual(r.frames.find((f) => f.block === 0), { block: 0, page: 0, x: 20, y: 0, w: 100, h: 40 });
});

test('list labels count over the document and survive typing', () => {
  const numbering = { nums: { 1: { abstract: 'a' } }, abstract: { a: { levels: [{ fmt: 'decimal', text: '%1.', start: 1, left: 36, hanging: 18 }] } } };
  const item = (t) => p(t, { numbering: { numId: 1, ilvl: 0 } });
  const doc = docOf([item('one'), item('two'), item('three')], { numbering });
  const L = layout(doc);
  L.run();
  assert.equal(doc.content.length, 3);
  // Typing in the second item keeps every label: only it lays out again.
  L.edit({ from: 1, to: 2, nodes: [item('two!')] });
  assert.equal(L.run().counts.relaid, 1);
  // A new item before them renumbers the rest, so they lay out again (their label is part of their key).
  L.edit({ from: 0, to: 0, nodes: [item('zero')] });
  assert.equal(L.run().counts.relaid, 4);
});

test('stylesheet.js re-exports the pure style resolution, and columnWidthAt uses the shared width', () => {
  assert.equal(sheet.resolved, resolvedMod.resolved);
  assert.equal(sheet.charRun, resolvedMod.charRun);
  assert.equal(sheet.resolvedAll, resolvedMod.resolvedAll);
  const list = { Base: { type: 'paragraph', para: { textAlign: 'center' }, run: { size: 14 } }, Kid: { type: 'paragraph', basedOn: 'Base', run: { bold: true } } };
  assert.deepEqual(resolvedMod.resolved(list, 'Kid').run, { size: 14, bold: true });
  assert.equal(resolvedMod.resolved(list, 'Kid').para.align, 'center');
  const pmDoc = { attrs: { sect, settings: {} }, content: { size: 2 }, resolve: () => ({ depth: 0 }), descendants: () => {} };
  near(columnWidthAt(pmDoc, 0), 346.67);
});

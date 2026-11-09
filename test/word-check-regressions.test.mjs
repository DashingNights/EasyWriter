// check-regressions (docs/plans/word/briefs/check-regressions.md): the layout predictor keeps each footnote's room at the foot of
// its reference's page, as the page engine does (planPages notes). The fake measurer of word-layout-predictor.test.mjs: every
// character 10 px wide, ascent 0.8 and descent 0.2 of the size, so a 12 pt line is 16 px and the 213.33 px body holds 13 lines.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLayout, EST } from '../src/document/layout/engine.mjs';

const fake = () => ({
  stats: { calls: 0, hits: 0, ms: 0, fonts: 0 },
  width: (_f, t) => [...t].length * 10,
  metrics: (font) => {
    const px = Number(/([\d.]+)px/.exec(font)[1]);
    return { asc: px * 0.8, desc: px * 0.2, ascU: px * 0.8, descU: px * 0.2 };
  },
});
const sect = { w: 300, h: 200, orient: 'portrait', margin: { top: 20, right: 20, bottom: 20, left: 20, header: 0, footer: 0, gutter: 0 } };
const docOf = (content, settings = {}) => ({ type: 'doc', content,
  attrs: { styles: { defaults: { run: { size: 12 }, para: {} }, list: {} }, settings: { defaultTabStop: 36, ...settings }, sect, numbering: null, theme: null } });
const p = (text, extra = []) => ({ type: 'paragraph', attrs: {}, content: [{ type: 'text', text }, ...extra] });
const note = (kind, text) => ({ type: 'noteRef', attrs: { kind, id: `${kind}1`, content: [p(text)], mark: null } });
const starts = (doc) => {
  const L = createLayout(fake());
  L.open(doc);
  return L.run();
};
// 30 one-line paragraphs, the note's reference in paragraph `at`.
const withNote = (at, n, settings) => docOf(Array.from({ length: 30 }, (_, i) => (i === at ? p(`line ${i}`, [n]) : p(`line ${i}`))), settings);

test('a footnote takes room at the foot of its reference\'s page', () => {
  assert.deepEqual(starts(withNote(-1)).pages.map((pg) => pg.block), [0, 13, 26], 'no note: 13 lines a page');
  // The note's line (its raised label grows it to 20.2 px) and Word's 12 pt separator leave room for 11 lines.
  const r = starts(withNote(2, note('footnote', 'note')));
  assert.deepEqual(r.pages.map((pg) => pg.block), [0, 11, 24]);
  assert.ok(r.est[2] & EST.note);
  // A reference on the page's last line goes on with its note when not even the note's first line fits under it; that page then
  // holds 11 lines too.
  assert.deepEqual(starts(withNote(12, note('footnote', 'note'))).pages.map((pg) => pg.block), [0, 12, 23]);
  // A separator of the document's own (two lines) takes its own room.
  const sep = { separator: [p('a'), p('b')] };
  assert.deepEqual(starts(withNote(2, note('footnote', 'note'), { footnotePr: { sep } })).pages.map((pg) => pg.block), [0, 10, 23]);
  // An endnote collects at the document's end: no room on the page.
  assert.deepEqual(starts(withNote(2, note('endnote', 'note'))).pages.map((pg) => pg.block), [0, 13, 26]);
});

test('a note taller than the page carries on to the next page\'s foot', () => {
  // 40 lines of note text (644 px): the reference's page keeps its own line and fills the rest with the note; each page after
  // gives the carried text half its body (6 lines of text) until it runs out.
  const long = { type: 'noteRef', attrs: { kind: 'footnote', id: 'f1', mark: null, content: Array.from({ length: 40 }, (_, i) => p(`n${i}`)) } };
  assert.deepEqual(starts(withNote(0, long)).pages.map((pg) => pg.block), [0, 1, 7, 13, 19, 25]);
});

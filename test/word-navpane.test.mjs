import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { Suggestions } from '../src/suggest/extension.js';
import { collapsedRanges, headingsOf, levelOf, moveSection, sectionRange, treeOf } from '../src/document/wp/navpane/headings.mjs';
import { pagesWithHits, snippet } from '../src/document/wp/navpane/results.mjs';

// The Navigation pane's pure model (docs/plans/word/briefs/navpane.md acceptance).
const schema = getSchema([...documentExtensions(50), Suggestions]); // Suggestions adds the blocks' suggest attribute
const t = (text) => [{ type: 'text', text }];
const h = (level, text, attrs = {}) => ({ type: 'heading', attrs: { level, ...attrs }, content: t(text) });
const p = (text, attrs = {}) => ({ type: 'paragraph', attrs, content: t(text) });
const make = (blocks, styles) => schema.nodeFromJSON({ type: 'doc', ...(styles && { attrs: { styles } }), content: blocks });
const posOf = (doc, text) => {
  let at = null;
  doc.forEach((n, pos) => { if (at == null && n.textContent === text) at = pos; });
  return at;
};

test('headingsOf reads heading nodes, outline attributes and style outlines; body text is left out', () => {
  const styles = { list: { Chapter: { type: 'paragraph', name: 'Chapter', para: { outline: 1 } }, Sub: { type: 'paragraph', basedOn: 'Chapter' },
    Body: { type: 'paragraph', para: { outline: 9 } } } };
  const doc = make([h(1, 'One'), p('body'), p('Outlined', { outline: 0 }), p('Styled', { styleId: 'Sub' }), p('Plain', { styleId: 'Body' }),
    p('Nine', { outline: 9 })], styles);
  assert.deepEqual(headingsOf(doc).map((x) => [x.text, x.level]), [['One', 1], ['Outlined', 1], ['Styled', 2]]);
});

test('levelOf rereads a cached paragraph when the styles change', () => {
  const para = p('Styled', { styleId: 'Chapter' });
  const a = make([para], { list: { Chapter: { type: 'paragraph', para: { outline: 1 } } } });
  const node = a.child(0);
  assert.equal(levelOf(a, node), 2);
  const b = schema.nodeFromJSON({ type: 'doc', attrs: { styles: { list: { Chapter: { type: 'paragraph', para: { outline: 4 } } } } }, content: [] }).copy(a.content);
  assert.equal(b.child(0), node, 'the same node under new styles');
  assert.equal(levelOf(b, node), 5);
});

test('treeOf nests across skipped levels', () => {
  const doc = make([h(1, 'A'), h(3, 'A.x'), h(2, 'A.1'), h(1, 'B'), h(2, 'B.1')]);
  const tree = treeOf(headingsOf(doc));
  const shape = (ns) => ns.map((n) => [n.text, shape(n.children)]);
  assert.deepEqual(shape(tree), [['A', [['A.x', []], ['A.1', []]]], ['B', [['B.1', []]]]]);
});

test('sectionRange ends at the next heading of the same or a higher level', () => {
  const doc = make([h(1, 'A'), p('a'), h(2, 'A.1'), p('a1'), h(3, 'A.1.x'), p('x'), h(1, 'B'), p('b')]);
  const end = doc.content.size;
  assert.equal(sectionRange(doc, posOf(doc, 'B')).to, end, 'the last heading runs to the end');
  assert.equal(sectionRange(doc, posOf(doc, 'A.1.x')).to, posOf(doc, 'B'), 'a heading followed by a higher one');
  assert.equal(sectionRange(doc, posOf(doc, 'A')).to, posOf(doc, 'B'), 'nested subheadings belong to their parent');
  assert.equal(sectionRange(doc, posOf(doc, 'a')), null, 'body text has no section');
});

test('moveSection moves a section with its numbering and suggestion records', () => {
  const rec = { ins: { id: 's1', g: 'g1', by: 'agent', at: 1, n: 1, sig: 'x' } };
  const doc = make([h(1, 'A'), p('a'), h(1, 'B'), { type: 'paragraph', attrs: { numbering: { numId: 1, ilvl: 0 }, suggest: rec }, content: t('item') }, h(1, 'C')]);
  const tr = EditorState.create({ doc }).tr;
  const at = moveSection(tr, posOf(doc, 'B'), 0);
  assert.equal(at, 0);
  assert.deepEqual(headingsOf(tr.doc).map((x) => x.text), ['B', 'A', 'C']);
  const item = tr.doc.child(1);
  assert.equal(item.textContent, 'item');
  assert.deepEqual(item.attrs.numbering, { numId: 1, ilvl: 0 });
  assert.deepEqual(item.attrs.suggest, rec);
  // Down past C, and a drop inside its own section is refused.
  const tr2 = EditorState.create({ doc }).tr;
  moveSection(tr2, 0, doc.content.size);
  assert.deepEqual(headingsOf(tr2.doc).map((x) => x.text), ['B', 'C', 'A']);
  assert.equal(moveSection(EditorState.create({ doc }).tr, 0, posOf(doc, 'a')), null);
});

test('collapsedRanges merges nested collapsed headings', () => {
  const doc = make([h(1, 'A'), p('a'), h(2, 'A.1'), p('a1'), h(1, 'B'), p('b')]);
  const A = posOf(doc, 'A');
  const A1 = posOf(doc, 'A.1');
  assert.deepEqual(collapsedRanges(doc, [A1]), [{ from: posOf(doc, 'a1'), to: posOf(doc, 'B') }]);
  assert.deepEqual(collapsedRanges(doc, [A1, A]), [{ from: posOf(doc, 'a'), to: posOf(doc, 'B') }]);
  assert.deepEqual(collapsedRanges(doc, [posOf(doc, 'B')]), [{ from: posOf(doc, 'b'), to: doc.content.size }]);
});

test('snippet keeps the term at its offsets', () => {
  const text = 'The quick brown fox jumps over the lazy dog and keeps running far beyond the hills of the valley below';
  const from = text.indexOf('lazy');
  const s = snippet(text, from, from + 4, 15);
  assert.equal(s.term, 'lazy');
  assert.ok(text.includes(s.before.replace(/^\.\.\./, '') + 'lazy' + s.after.replace(/\.\.\.$/, '')));
  assert.deepEqual(snippet('ab', 0, 1), { before: '', term: 'a', after: 'b' });
});

test('pagesWithHits lists each page once, in order', () => {
  const pageOf = (pos) => (pos < 10 ? 0 : pos < 20 ? 1 : 2);
  assert.deepEqual(pagesWithHits([{ from: 25 }, { from: 3 }, { from: 5 }, { from: 22 }], pageOf), [0, 2]);
});

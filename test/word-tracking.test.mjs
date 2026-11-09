import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Slice, Fragment } from '@tiptap/pm/model';
import { addRowAfter, deleteRow } from '@tiptap/pm/tables';
import { documentExtensions } from '../src/document/schema.js';
import { revisionsOf } from '../src/document/model/review.mjs';
import { trackingPlugin } from '../src/document/wp/tracking/record.mjs';
import { resolveTr } from '../src/document/wp/tracking/resolve.mjs';
import { AUTHOR_COLORS, authorColor, markupCss } from '../src/document/wp/tracking/colors.mjs';
import { barsKey, barsPlugin } from '../src/document/wp/tracking/bars.mjs';

// Track Changes engine (docs/plans/word/briefs/tracking.md Acceptance): recording and resolving on plain EditorStates with
// prosemirror-history and the tracking plugin, with a fixed author and clock.
const schema = getSchema(documentExtensions(50));
const DATE = '2026-10-28T09:00:00.000Z';
const ME = { name: 'Ada', initials: 'AR' };
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...content) => ({ type: 'paragraph', content: content.length ? content : undefined });
const ins = (id, author = 'Ana') => ({ type: 'insertion', attrs: { id, author, date: DATE } });
const settings = { trackRevisions: true };

function make(content, { attrs = {}, opts = {} } = {}) {
  let n = 0;
  const doc = schema.nodeFromJSON({ type: 'doc', attrs: { settings, people: [], ...attrs }, content });
  return EditorState.create({
    doc,
    plugins: [history(), trackingPlugin({ user: () => ME, now: () => DATE, id: () => `id${++n}`, ...opts }), barsPlugin()],
  });
}
const run = (state, fn) => state.apply(fn(state.tr));
const text = (state) => state.doc.textContent;
const marksAt = (state, pos) => state.doc.resolve(pos).nodeAfter?.marks.map((m) => [m.type.name, m.attrs.author ?? null, m.attrs.id ?? null]) ?? [];
const typeAt = (state, pos, s) => run(state, (tr) => tr.insertText(s, pos));
const strip = (doc) => JSON.parse(JSON.stringify(doc.toJSON(), (k, v) => (v === null ? undefined : v)));

test('typed text carries one insertion mark with the author and date, and more typing beside it keeps its id', () => {
  let s = make([p(t('xy'))]);
  s = typeAt(s, 2, 'abc');
  assert.equal(text(s), 'xabcy');
  const m = s.doc.resolve(2).nodeAfter.marks.find((x) => x.type.name === 'insertion');
  assert.deepEqual([m.attrs.author, m.attrs.date], ['Ada', DATE]);
  assert.equal(s.doc.resolve(2).nodeAfter.text, 'abc', 'one run');
  s = typeAt(s, 5, 'd');
  assert.equal(s.doc.resolve(2).nodeAfter.text, 'abcd', 'the next letter joins the run');
  const revs = revisionsOf(s.doc).filter((r) => r.kind === 'insert');
  assert.equal(revs.length, 1);
  assert.deepEqual(s.doc.attrs.people.map((x) => x.name), ['Ada'], 'a new author joins people in the same transaction');
});

test('deleting plain text keeps it with a deletion mark; Backspace moves the caret left; another Backspace over it only moves', () => {
  let s = make([p(t('abcde'))]);
  s = run(s, (tr) => tr.setSelection(TextSelection.create(tr.doc, 3, 5)).deleteSelection());
  assert.equal(text(s), 'abcde');
  assert.deepEqual(marksAt(s, 3).map((m) => m[0]), ['deletion']);
  assert.equal(s.doc.resolve(3).nodeAfter.text, 'cd');
  // Backspace at the end of 'abc|de' over plain 'c'... use a fresh doc for the caret rules.
  let b = make([p(t('abc'))]);
  b = run(b, (tr) => tr.setSelection(TextSelection.create(tr.doc, 4)));
  b = run(b, (tr) => tr.delete(3, 4));
  assert.equal(text(b), 'abc');
  assert.equal(b.selection.head, 3, 'the caret moved left of the deleted letter');
  const before = b.doc;
  b = run(b, (tr) => tr.delete(3, 4));
  assert.ok(b.doc.eq(before), 'Backspace over deleted text changes nothing');
  // Delete at 'a|bc' keeps the caret right of the deleted letter, and the next Delete joins the same revision.
  let f = make([p(t('abc'))]);
  f = run(f, (tr) => tr.setSelection(TextSelection.create(tr.doc, 2)));
  f = run(f, (tr) => tr.delete(2, 3));
  assert.equal(f.selection.head, 3, 'the caret moved right of the deleted letter');
  f = run(f, (tr) => tr.delete(3, 4));
  assert.equal(revisionsOf(f.doc).filter((r) => r.kind === 'delete').length, 1, 'one deletion run');
});

test('deleting your own insertion removes it; another author\'s insertion gets a deletion mark on top', () => {
  let s = make([p(t('ab'))]);
  s = typeAt(s, 2, 'XY');
  s = run(s, (tr) => tr.delete(2, 4));
  assert.equal(text(s), 'ab');
  let o = make([p(t('a'), t('BC', [ins('o1', 'Ben')]), t('d'))]);
  o = run(o, (tr) => tr.delete(2, 4));
  assert.equal(text(o), 'aBCd');
  assert.deepEqual(marksAt(o, 2).map((m) => m[0]).sort(), ['deletion', 'insertion']);
});

test('Backspace at a paragraph start keeps two paragraphs with markRev.del on the first; Enter sets markRev.ins', () => {
  let s = make([p(t('one')), p(t('two'))]);
  s = run(s, (tr) => tr.setSelection(TextSelection.create(tr.doc, 6)));
  s = run(s, (tr) => tr.join(5));
  assert.equal(s.doc.childCount, 2);
  assert.equal(s.doc.child(0).attrs.markRev?.del?.author, 'Ada');
  assert.equal(s.selection.head, 4, 'the caret sits at the end of the first paragraph');
  let e = make([p(t('abcd'))]);
  e = run(e, (tr) => tr.split(3));
  assert.equal(e.doc.childCount, 2);
  assert.equal(e.doc.child(0).attrs.markRev?.ins?.author, 'Ada');
  assert.equal(e.doc.child(1).attrs.markRev ?? null, null);
  // Backspace over your own new paragraph mark joins for real.
  e = run(e, (tr) => tr.join(4));
  assert.equal(e.doc.childCount, 1);
  assert.equal(e.doc.child(0).attrs.markRev ?? null, null);
});

test('bold on plain text records formatChange with old []; reject removes the bold', () => {
  let s = make([p(t('word'))]);
  s = run(s, (tr) => tr.addMark(1, 5, schema.marks.bold.create()));
  const fc = s.doc.child(0).firstChild.marks.find((m) => m.type.name === 'formatChange');
  assert.deepEqual(fc.attrs.old, []);
  const r = s.apply(resolveTr(s, 'reject'));
  assert.deepEqual(r.doc.child(0).firstChild.marks, []);
});

test('a heading change records pChange and reject gives the paragraph back', () => {
  let s = make([p(t('Title'))]);
  const orig = s.doc;
  s = run(s, (tr) => tr.setBlockType(1, 6, schema.nodes.heading, { level: 1 }));
  assert.equal(s.doc.child(0).type.name, 'heading');
  assert.equal(s.doc.child(0).attrs.pChange?.old?.type, 'paragraph');
  const r = s.apply(resolveTr(s, 'reject'));
  assert.deepEqual(strip(r.doc).content, strip(orig).content);
});

test('addRowAfter sets rev.ins and deleteRow keeps the row with rev.del', () => {
  const cell = (x) => ({ type: 'tableCell', content: [p(t(x))] });
  let s = make([{ type: 'table', content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }] }, p()]);
  s = run(s, (tr) => tr.setSelection(TextSelection.create(tr.doc, 4)));
  addRowAfter(s, (tr) => { s = s.apply(tr); });
  const table = s.doc.child(0);
  assert.equal(table.childCount, 2);
  assert.equal(table.child(1).attrs.rev?.ins?.author, 'Ada');
  s = run(s, (tr) => tr.setSelection(TextSelection.create(tr.doc, 4)));
  deleteRow(s, (tr) => { s = s.apply(tr); });
  assert.equal(s.doc.child(0).childCount, 2, 'the deleted row stays');
  assert.equal(s.doc.child(0).child(0).attrs.rev?.del?.author, 'Ada');
});

test('accept all and reject all of one mixed doc give the final and original text', () => {
  let s = make([p(t('The cat sat.')), p(t('End'))]);
  const original = s.doc;
  s = typeAt(s, 5, 'big ');
  s = run(s, (tr) => tr.delete(13, 17)); // 'sat.'... part of the text
  s = run(s, (tr) => tr.addMark(1, 4, schema.marks.italic.create()));
  s = run(s, (tr) => tr.split(tr.doc.child(0).nodeSize - 1));
  const accepted = s.apply(resolveTr(s, 'accept'));
  const rejected = s.apply(resolveTr(s, 'reject'));
  const final = make([p(t('The', [{ type: 'italic' }]), t(' big cat ')), p(), p(t('End'))]).doc;
  assert.deepEqual(strip(accepted.doc).content, strip(final).content);
  assert.equal(revisionsOf(accepted.doc).length, 0);
  assert.deepEqual(strip(rejected.doc).content, strip(original).content);
});

test('a selection resolves only the part of a change it covers', () => {
  let s = make([p()]);
  s = typeAt(s, 1, 'hello world');
  assert.equal(revisionsOf(s.doc).filter((r) => r.kind === 'insert').length, 1, 'one run');
  const r = s.apply(resolveTr(s, 'reject', () => true, { range: { from: 7, to: 12 } })); // 'world'
  assert.equal(text(r), 'hello ');
  assert.deepEqual(marksAt(r, 1).map((m) => m[0]), ['insertion'], 'hello stays inserted');
});

test('a deleted page break stays with rev.del, and accepting it removes it', () => {
  let s = make([p(t('ab')), { type: 'pageBreak' }, p(t('cd'))]);
  s = run(s, (tr) => tr.delete(4, 5));
  assert.equal(s.doc.child(1).type.name, 'pageBreak');
  assert.equal(s.doc.child(1).attrs.rev?.del?.author, 'Ada');
  const a = s.apply(resolveTr(s, 'accept'));
  assert.deepEqual(a.doc.content.content.map((n) => n.type.name), ['paragraph', 'paragraph']);
});

test('one undo after a tracked deletion returns the original doc', () => {
  let s = make([p(t('abcde'))]);
  const orig = s.doc;
  s = run(s, (tr) => tr.delete(2, 4));
  assert.notEqual(s.doc, orig);
  undo(s, (tr) => { s = s.apply(tr); });
  assert.ok(s.doc.eq(orig));
});

test('suggest, history and addToHistory false transactions get no marks', () => {
  for (const [k, v] of [['suggest', 'x'], ['history$', { redo: false }], ['addToHistory', false]]) {
    let s = make([p(t('ab'))]);
    s = run(s, (tr) => tr.insertText('Z', 2).setMeta(k, v));
    assert.equal(revisionsOf(s.doc).length, 0, k);
  }
  let off = make([p(t('ab'))], { attrs: { settings: null } });
  off = typeAt(off, 2, 'Z');
  assert.equal(revisionsOf(off.doc).length, 0, 'a v1 document (settings null) records nothing');
});

test('a drop move gives one move name to both halves', () => {
  let s = make([p(t('one two three'))]);
  s = run(s, (tr) => {
    const slice = tr.doc.slice(5, 9);
    tr.delete(5, 9);
    tr.replace(10, 10, slice);
    return tr.setMeta('uiEvent', 'drop');
  });
  const moves = revisionsOf(s.doc).filter((r) => r.move);
  assert.equal(moves.length, 2);
  assert.equal(moves[0].move, moves[1].move);
  assert.deepEqual(moves.map((r) => r.kind).sort(), ['delete', 'insert']);
});

test('author colours are stable in people order', () => {
  const people = [{ name: 'Ana' }, { name: 'Ben' }];
  assert.equal(authorColor(people, 'Ana'), AUTHOR_COLORS[0]);
  assert.equal(authorColor(people, 'Ben'), AUTHOR_COLORS[1]);
  assert.equal(authorColor(people, 'Cy'), AUTHOR_COLORS[2], 'a new author takes the next place');
  const css = markupCss('.X', {}, people);
  assert.ok(css.indexOf('"Ana"') < css.indexOf('"Ben"') && css.includes(AUTHOR_COLORS[1]));
});

test('change bars follow the paragraphs that hold a change, and only those', () => {
  const bars = (st) => barsKey.getState(st).find().map((d) => st.doc.resolve(d.from).index(0));
  let s = make([p(t('one')), p(t('two')), p(t('three'))]);
  assert.deepEqual(bars(s), []);
  s = typeAt(s, 7, 'X'); // in 'two'
  assert.deepEqual(bars(s), [1]);
  s = run(s, (tr) => tr.addMark(1, 4, schema.marks.bold.create()));
  assert.deepEqual(bars(s).sort(), [0, 1]);
  s = s.apply(resolveTr(s, 'accept'));
  assert.deepEqual(bars(s), [], 'accepting clears every bar');
});

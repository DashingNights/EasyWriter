import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { history, redoDepth, undo } from '@tiptap/pm/history';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import { dropOrphanComments } from '../src/document/model/review.mjs';
import {
  addComment, addReply, authorOf, commentAt, commentsOf, copyThreads, deleteAll, deleteThreads, filterThreads, isEmpty, orphaned, pasteIds, remapSlice, setEntry,
  stepThread, threadOf, timeAgo, untracked, withoutThreads, wordAt,
} from '../src/document/wp/comments/comments.mjs';

// Comments (docs/plans/word/plan.md §3 comments): the pure model over the Document schema.
const schema = getSchema(documentExtensions(50));
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...content) => ({ type: 'paragraph', ...(content.length && { content }) });
const cm = (id) => ({ type: 'comment', attrs: { id } });
const stateOf = (content, attrs = {}) => EditorState.create({ schema, doc: schema.nodeFromJSON({ type: 'doc', attrs, content }), plugins: [history()] });
const who = { author: 'Ada Reviewer', initials: 'AR', date: '2026-10-28T10:00:00Z', content: [p(t('Note'))] };
const apply = (state, tr) => state.apply(tr);

test('wordAt picks the word at, inside and at the end of a word', () => {
  const s = stateOf([p(t('Hello brave world'))]);
  const at = (pos) => wordAt(s.doc, pos);
  assert.deepEqual(at(1), { from: 1, to: 6 }, 'at the start');
  assert.deepEqual(at(9), { from: 7, to: 12 }, 'inside');
  assert.deepEqual(at(18), { from: 13, to: 18 }, 'at the end of the paragraph: the word before');
  assert.deepEqual(at(6), { from: 1, to: 6 }, 'at a word end before a space: the word before');
  assert.equal(wordAt(stateOf([p(t('a  b'))]).doc, 3), null, 'between two spaces: none');
  // A content control adds open and close positions its text does not show: 'ab' fills 1..5, 'cd' starts at 6.
  const sdt = stateOf([p({ type: 'sdtInline', content: [t('ab')] }, t(' cd'))]);
  assert.deepEqual(wordAt(sdt.doc, 7), { from: 6, to: 8 }, 'a word after a content control');
});

test('addComment adds the mark and the entry in one transaction', () => {
  const s0 = stateOf([p(t('Hello world'))]);
  const { tr, id } = addComment(s0, { from: 1, to: 6 }, who);
  const s1 = apply(s0, tr);
  assert.equal(id, '1');
  const [c] = commentsOf(s1.doc);
  assert.deepEqual([c.id, c.from, c.to, c.text, c.author, c.initials, c.done, c.parent], ['1', 1, 6, 'Hello', 'Ada Reviewer', 'AR', false, null]);
  assert.deepEqual(s1.doc.attrs.people, [{ name: 'Ada Reviewer', initials: 'AR', color: '#c0504d' }]);
  assert.equal(undo(s1, (u) => { assert.equal(commentsOf(s1.apply(u).doc).length, 0); }), true, 'one undo step removes both');
  // An empty paragraph: a zero-width space carries the mark.
  const e = apply(stateOf([p()]), addComment(stateOf([p()]), { from: 1, to: 1 }, who).tr);
  assert.equal(commentsOf(e.doc)[0].text, '​');
});

test('reply, edit, resolve and reopen change only the entry', () => {
  let s = stateOf([p(t('Hello world'))]);
  s = apply(s, addComment(s, { from: 1, to: 6 }, who).tr);
  const marks = (st) => JSON.stringify(st.doc.toJSON().content);
  const before = marks(s);
  const r = addReply(s, '1', { ...who, author: 'Ben', initials: 'B' });
  s = apply(s, r.tr);
  assert.equal(r.id, '2');
  assert.equal(s.doc.attrs.comments['2'].parent, '1');
  assert.equal(commentsOf(s.doc)[0].replies[0].id, '2');
  assert.equal(s.doc.attrs.people.length, 2, 'a new author joins people');
  s = apply(s, setEntry(s, '1', { content: [p(t('Edited'))] }));
  assert.equal(s.doc.attrs.comments['1'].content[0].content[0].text, 'Edited');
  s = apply(s, setEntry(s, '1', { done: true }));
  assert.equal(s.doc.attrs.comments['1'].done, true);
  s = apply(s, setEntry(s, '1', { done: false }));
  assert.equal(s.doc.attrs.comments['1'].done, false);
  assert.equal(marks(s), before, 'the text and marks never changed');
  assert.equal(s.doc.attrs.comments['2'].author, 'Ben');
});

test('deleteThread removes every mark and reply; a carrier space goes too', () => {
  let s = stateOf([p(t('Hello world')), p(t('Second'))]);
  s = apply(s, addComment(s, { from: 1, to: 20 }, who).tr); // across both paragraphs
  s = apply(s, addReply(s, '1', who).tr);
  s = apply(s, addComment(s, { from: 7, to: 12 }, who).tr); // overlapping thread 3
  assert.deepEqual(commentsOf(s.doc).map((c) => c.id), ['1', '3']);
  s = apply(s, deleteThreads(s, ['1']));
  assert.deepEqual(Object.keys(s.doc.attrs.comments), ['3']);
  assert.deepEqual(commentsOf(s.doc).map((c) => [c.id, c.text]), [['3', 'world']]);
  let e = stateOf([p()]);
  e = apply(e, addComment(e, { from: 1, to: 1 }, who).tr);
  e = apply(e, deleteThreads(e, ['1']));
  assert.equal(e.doc.textContent, '');
});

test('a comment on a field: mark and entry together, every change finds it, delete takes the mark', () => {
  const field = { type: 'field', attrs: { code: 'FILLIN "Name?"', result: 'Name' } };
  let s = stateOf([p(t('Cover '), field, t(' page'))]);
  s = s.apply(s.tr.setSelection(NodeSelection.create(s.doc, 7)));
  s = apply(s, addComment(s, s.selection, who).tr);
  const fieldMarks = (st) => st.doc.nodeAt(7).marks.map((m) => m.attrs.id);
  assert.deepEqual(fieldMarks(s), ['1']);
  assert.deepEqual(commentsOf(s.doc).map((c) => [c.id, c.from, c.to, c.author]), [['1', 7, 8, 'Ada Reviewer']]);
  assert.equal(commentAt(s), '1', 'the field selected');
  s = apply(s, setEntry(s, '1', { done: true }));
  assert.equal(s.doc.attrs.comments['1'].done, true);
  s = apply(s, deleteThreads(s, ['1']));
  assert.deepEqual([fieldMarks(s), Object.keys(s.doc.attrs.comments)], [[], []]);
  // A range holding text and the field goes whole too.
  s = apply(s, addComment(s, { from: 1, to: 13 }, who).tr);
  s = apply(s, deleteThreads(s, ['1']));
  assert.equal(commentsOf(s.doc).length, 0);
  assert.ok(!s.doc.rangeHasMark(0, s.doc.content.size, schema.marks.comment));
});

test('a mark with no entry is no comment, and the open path drops it', () => {
  const field = { type: 'field', attrs: { code: 'FILLIN "Name?"', result: 'Name' }, marks: [cm('1')] };
  const json = { type: 'doc', attrs: { comments: {}, people: [{ name: 'Author', initials: 'A' }] }, content: [p(t('Cover ', [cm('1')]), field, t(' page'))] };
  assert.deepEqual(commentsOf(schema.nodeFromJSON(json)), []);
  const clean = dropOrphanComments(json);
  assert.ok(!JSON.stringify(clean.content).includes('comment'));
  assert.equal(clean.attrs, json.attrs);
  const kept = { ...json, attrs: { comments: { 1: { author: 'A' } } } };
  assert.equal(dropOrphanComments(kept), kept, 'nothing to drop: the same object');
});

test('the author: the user name, else the OS account, else Author', () => {
  assert.deepEqual(authorOf({ name: 'Ada Reviewer', initials: '' }, 'kelvin'), { name: 'Ada Reviewer', initials: 'AR' });
  assert.deepEqual(authorOf({ name: '', initials: '' }, 'kelvin'), { name: 'kelvin', initials: 'K' });
  assert.deepEqual(authorOf(undefined, ''), { name: 'Author', initials: 'A' });
});

test('deleteAll with shown, all and resolved', () => {
  let s = stateOf([p(t('one two three'))]);
  for (const [a, b] of [[1, 4], [5, 8], [9, 14]]) s = apply(s, addComment(s, { from: a, to: b }, who).tr);
  s = apply(s, setEntry(s, '2', { done: true }));
  const ids = (st) => commentsOf(st.doc).map((c) => c.id);
  assert.deepEqual(ids(apply(s, deleteAll(s, 'resolved'))), ['1', '3']);
  assert.deepEqual(ids(apply(s, deleteAll(s, 'shown', 'active'))), ['2']);
  assert.deepEqual(ids(apply(s, deleteAll(s, 'shown', null))), []);
  assert.deepEqual(ids(apply(s, deleteAll(s, 'all'))), []);
  assert.equal(deleteAll(stateOf([p(t('x'))]), 'all'), null);
});

test('the active and resolved filters, and Previous and Next in order with a wrap', () => {
  const list = [{ id: 'a', from: 1, done: false }, { id: 'b', from: 5, done: true }, { id: 'c', from: 9, done: false }];
  assert.deepEqual(filterThreads(list, 'active').map((c) => c.id), ['a', 'c']);
  assert.deepEqual(filterThreads(list, 'resolved').map((c) => c.id), ['b']);
  assert.equal(filterThreads(list, null).length, 3);
  assert.equal(stepThread(list, 1, 1).id, 'b');
  assert.equal(stepThread(list, 9, 1).id, 'a', 'Next wraps');
  assert.equal(stepThread(list, 5, -1).id, 'a');
  assert.equal(stepThread(list, 1, -1).id, 'c', 'Previous wraps');
});

test('commentAt finds the thread under the caret or the selection', () => {
  let s = stateOf([p(t('Hello world'))]);
  s = apply(s, addComment(s, { from: 7, to: 12 }, who).tr);
  const at = (a, b = a) => commentAt(s.apply(s.tr.setSelection(TextSelection.create(s.doc, a, b))));
  assert.equal(at(9), '1');
  assert.equal(at(7), '1', 'at the start of the range');
  assert.equal(at(2), null);
  assert.equal(at(1, 9), '1');
});

test('pasted marks with a used id get a new id and a copied thread', () => {
  let s = stateOf([p(t('Hello world'))]);
  s = apply(s, addComment(s, { from: 1, to: 6 }, who).tr);
  s = apply(s, addReply(s, '1', who).tr);
  const used = s.doc.attrs.comments;
  let next = 3;
  const { slice, map } = remapSlice(s.doc.slice(1, 6), (id) => (used[id] ? String(next++) : id));
  assert.deepEqual(map, { 1: '3' });
  assert.equal(slice.content.firstChild.marks[0].attrs.id, '3');
  const comments = copyThreads(used, Object.entries(map).map(([from, to]) => [to, threadOf(used, from)]));
  assert.equal(comments['3'].author, 'Ada Reviewer');
  assert.deepEqual(Object.entries(comments).filter(([, c]) => c.parent === '3').length, 1, 'the reply is copied under the new thread');
  const dropped = remapSlice(s.doc.slice(1, 6), () => null);
  assert.equal(dropped.slice.content.firstChild.marks.length, 0, 'a mark without a source is dropped');
});

test('a cut and paste of a whole thread and part of another gives every range its own id', () => {
  // Thread 1 on 'Hello', thread 2 on 'brave', thread 3 on 'world'; the cut took all of 3, so the doc keeps 1 and 2.
  let s = stateOf([p(t('Hello brave world'))]);
  for (const r of [{ from: 1, to: 6 }, { from: 7, to: 12 }, { from: 13, to: 18 }]) s = apply(s, addComment(s, r, who).tr);
  s = apply(s, addReply(s, '3', who).tr);
  const clip = new Map(['2', '3'].map((id) => [id, threadOf(s.doc.attrs.comments, id)]));
  const slice = s.doc.slice(9, 18);
  const comments = withoutThreads(s.doc.attrs.comments, ['3']);
  const { slice: out, pairs } = pasteIds(slice, comments, clip);
  const ids = []; out.content.descendants((n) => { if (n.isText) ids.push(n.marks[0]?.attrs.id); });
  assert.deepEqual(ids, ['4', undefined, '3'], 'the used id 2 moves past the kept id 3');
  assert.deepEqual(pairs.map(([id]) => id), ['4', '3']);
  const next = copyThreads(comments, pairs);
  assert.equal(Object.values(next).filter((c) => c.parent === '3').length, 1, 'thread 3 keeps its own reply');
  assert.equal(Object.values(next).filter((c) => c.parent === '4').length, 0, 'thread 2 copied as 4 brings none');
});

test('a paste from another draft copies the source thread, not the thread of the same id here', () => {
  let a = stateOf([p(t('Hello'))]);
  a = apply(a, addComment(a, { from: 1, to: 6 }, { ...who, content: [p(t('From A'))] }).tr);
  let b = stateOf([p(t('World'))]);
  b = apply(b, addComment(b, { from: 1, to: 6 }, { ...who, content: [p(t('From B'))] }).tr);
  const clip = new Map([['1', threadOf(a.doc.attrs.comments, '1')]]);
  const { pairs } = pasteIds(a.doc.slice(1, 6), b.doc.attrs.comments, clip);
  assert.deepEqual(pairs.map(([id, src]) => [id, src.entry.content[0].content[0].text]), [['2', 'From A']]);
});

test('Esc on an empty new comment removes it with no redo step and an undo that changes nothing', () => {
  let s = stateOf([p(t('Hello'))]);
  s = apply(s, addComment(s, { from: 1, to: 6 }, { ...who, content: [p()] }).tr);
  s = apply(s, deleteThreads(s, ['1']).setMeta('addToHistory', false)); // as endEdit({cancelNew}) dispatches it
  assert.equal(commentsOf(s.doc).length, 0);
  assert.equal(redoDepth(s), 0, 'no redo brings it back');
  undo(s, (u) => { s = s.apply(u); });
  assert.deepEqual([commentsOf(s.doc).length, Object.keys(s.doc.attrs.comments ?? {}).length], [0, 0], 'undo leaves no comment');
  assert.equal(s.doc.textContent, 'Hello');
});

test('deleting all anchored text drops the thread; deleting part keeps it', () => {
  let s = stateOf([p(t('Hello world'))]);
  s = apply(s, addComment(s, { from: 7, to: 12 }, who).tr);
  const part = s.tr.delete(7, 9);
  assert.deepEqual(orphaned([part], s.apply(part)), []);
  const all = s.tr.delete(6, 12);
  const after = s.apply(all);
  assert.deepEqual(orphaned([all], after), ['1']);
  assert.deepEqual(withoutThreads(after.doc.attrs.comments, ['1']), {});
  const other = s.tr.delete(1, 3);
  assert.deepEqual(orphaned([other], s.apply(other)), [], 'text outside any comment');
});

test('comment text is never tracked; empty content', () => {
  const ins = { type: 'insertion', attrs: { id: 'i', author: 'A', date: 'x' } };
  const del = { type: 'deletion', attrs: { id: 'd', author: 'A', date: 'x' } };
  assert.deepEqual(untracked([p(t('kept', [ins]), t('gone', [del]))]), [p(t('kept'))]);
  assert.equal(isEmpty([p()]), true);
  assert.equal(isEmpty([p(t('​'))]), true);
  assert.equal(isEmpty([p(t('x'))]), false);
});

test('the time strings for 10 s, 5 min and 2 days', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const ago = (ms) => timeAgo(new Date(now - ms).toISOString(), now);
  assert.equal(ago(10e3), 'Just now');
  assert.equal(ago(5 * 60e3), '5 minutes ago');
  const d = new Date(now - 2 * 864e5);
  assert.equal(ago(2 * 864e5), `${d.getDate()} Oct 2026, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  assert.deepEqual([timeAgo(null, now), timeAgo(undefined, now), timeAgo('', now), timeAgo('nonsense', now)], ['', '', '', ''], 'never 1 Jan 1970');
});

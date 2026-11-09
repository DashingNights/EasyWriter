// Content controls and legacy forms (docs/plans/word plan.md §3 content-controls): property paths, locks, placeholders, bindings and
// the form field options, through schema v2's own nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { AllSelection, EditorState, Plugin, TextSelection } from '@tiptap/pm/state';
import { documentExtensions } from '../src/document/schema.js';
import {
  addDropItem, checkFormText, computedCode, DOC_PROPS, EN_SPACES, ffDefaults, ffForm, ffResult, formatDate, formFf, lockRefusal, nextBookmarkName, quoteCode, resetFf,
} from '../src/document/wp/content-controls/model.mjs';
import { follow, lockCheck, typeInto } from '../src/document/wp/content-controls/rules.js';

const schema = getSchema(documentExtensions(50));
const t = (text) => ({ type: 'text', text });
const p = (...content) => ({ type: 'paragraph', content });
const cc = (sdt, ...content) => ({ type: 'sdtInline', attrs: { sdt }, content });
const doc = (content, attrs = {}) => schema.nodeFromJSON({ type: 'doc', attrs, content });
const stateOf = (d) => EditorState.create({ doc: d, plugins: [new Plugin({ appendTransaction: follow })] });
/** The position of the first control with `id` in `d`. */
const posOf = (d, id) => {
  let at = null;
  d.descendants((n, pos) => {
    if (at == null && n.attrs?.sdt?.id === id) at = pos;
  });
  return at;
};

test('the 15 Document Property items and their props paths', () => {
  assert.equal(DOC_PROPS.length, 15);
  const paths = Object.fromEntries(DOC_PROPS.map(([, label, path]) => [label, path]));
  assert.deepEqual(paths, {
    Abstract: 'cover.abstract', Author: 'core.creator', Category: 'core.category', Comments: 'core.description', Company: 'app.company',
    'Company Address': 'cover.address', 'Company E-mail': 'cover.email', 'Company Fax': 'cover.fax', 'Company Phone': 'cover.phone',
    Keywords: 'core.keywords', Manager: 'app.manager', 'Publish Date': 'cover.publishDate', Status: 'core.contentStatus', Subject: 'core.subject',
    Title: 'core.title',
  });
});

test('locks: an sdtLocked control cannot be deleted, a contentLocked one cannot change, a group keeps its text but not its controls', () => {
  const locked = doc([p(t('a '), cc({ id: '1', lock: 'sdtLocked' }, t('keep')), t(' b'))]);
  const at = posOf(locked, '1');
  const gone = doc([p(t('a  b'))]);
  assert.match(lockRefusal(locked, gone), /cannot be deleted/);
  const edited = EditorState.create({ doc: locked }).tr.insertText('x', at + 2).doc;
  assert.equal(lockRefusal(locked, edited), null, 'sdtLocked alone lets the content change');

  const frozen = doc([p(cc({ id: '2', lock: 'contentLocked' }, t('fixed')))]);
  const typed = EditorState.create({ doc: frozen }).tr.insertText('x', posOf(frozen, '2') + 2).doc;
  assert.match(lockRefusal(frozen, typed), /cannot be edited/);

  const grouped = doc([{ type: 'sdtBlock', attrs: { sdt: { id: 'g', type: 'group' } }, content: [p(t('Name: '), cc({ id: '3' }, t('Ann')))] }]);
  const inner = EditorState.create({ doc: grouped }).tr.insertText('e', posOf(grouped, '3') + 4).doc;
  assert.equal(lockRefusal(grouped, inner), null, 'a nested control of a group stays editable');
  const outer = EditorState.create({ doc: grouped }).tr.insertText('Full ', 3).doc;
  assert.match(lockRefusal(grouped, outer), /Only the content controls/);
  const both = doc([{ type: 'sdtBlock', attrs: { sdt: { id: 'g', type: 'group', lock: 'sdtContentLocked' } }, content: [p(t('x '), cc({ id: '4', lock: 'sdtContentLocked' }, t('y')))] }]);
  assert.match(lockRefusal(both, doc([p(t('x'))])), /cannot be deleted/);
});

test('placeholders: the first character replaces the placeholder and emptying the control brings it back', () => {
  const d = doc([p(t('Name: '), cc({ id: '1', type: 'richText', showingPlaceholder: true }, t('Type here.')))]);
  const at = posOf(d, '1');
  let state = stateOf(d).apply(stateOf(d).tr.setSelection(TextSelection.create(d, at + 1, at + 11)));
  const tr = typeInto(state, 'A');
  state = state.apply(tr);
  let node = state.doc.nodeAt(at);
  assert.equal(node.textContent, 'A');
  assert.equal(node.attrs.sdt.showingPlaceholder, false);
  state = state.applyTransaction(state.tr.insertText('nn', at + 2)).state;
  assert.equal(state.doc.nodeAt(at).textContent, 'Ann');
  const { state: emptied } = state.applyTransaction(state.tr.delete(at + 1, at + 4));
  node = emptied.doc.nodeAt(at);
  assert.equal(node.textContent, 'Type here.', 'the placeholder text is back');
  assert.equal(node.attrs.sdt.showingPlaceholder, true);
  assert.equal(typeInto(stateOf(doc([p(cc({ id: 'c', type: 'checkbox' }, t('☐')))])), 'x'), null, 'the caret is outside the control');
});

test('bindings: typing in a bound control writes props, and a props change rewrites every control bound to it', () => {
  const d = doc([p(cc({ id: '1', type: 'text', binding: { prop: 'core.title' }, showingPlaceholder: true, placeholder: '[Title]' }, t('[Title]'))),
    p(cc({ id: '2', type: 'text', binding: { prop: 'core.title' }, showingPlaceholder: true, placeholder: '[Title]' }, t('[Title]')))]);
  const at = posOf(d, '1');
  let state = stateOf(d);
  state = state.applyTransaction(typeInto(state.apply(state.tr.setSelection(TextSelection.create(d, at + 1))), 'Report')).state;
  assert.equal(state.doc.attrs.props.core.title, 'Report');
  assert.equal(state.doc.nodeAt(posOf(state.doc, '2')).textContent, 'Report', 'the other bound control follows');
  state = state.applyTransaction(state.tr.setDocAttribute('props', { core: { title: 'Plan', subject: 'x' } })).state;
  assert.equal(state.doc.nodeAt(posOf(state.doc, '1')).textContent, 'Plan');
  assert.equal(state.doc.nodeAt(posOf(state.doc, '2')).textContent, 'Plan');
  assert.equal(state.doc.attrs.props.core.subject, 'x', 'other props stay');
});

test('text form fields: Maximum length and Type checks, and the QUOTE code of each Text format', () => {
  const ff = (patch) => ({ ...ffDefaults('text', 'Text1'), ...patch });
  assert.match(checkFormText(ff({ maxLength: 3 }), 'abcd'), /at most 3/);
  assert.equal(checkFormText(ff({ maxLength: 3 }), 'abc'), null);
  assert.match(checkFormText(ff({ type: 'number' }), '1a'), /number/);
  for (const bad of ['$', '-', '%', '()']) assert.match(checkFormText(ff({ type: 'number' }), bad), /number/, `${bad} is no number`);
  assert.equal(computedCode(ff({ type: 'currentDate', format: 'M/d/yyyy' })), 'DATE \\@ "M/d/yyyy"');
  assert.equal(computedCode(ff({ type: 'calculated', default: '=2+3', format: '0.00' })), '= 2+3 \\# "0.00"');
  assert.equal(computedCode(ff({ type: 'regular' })), null);
  assert.equal(checkFormText(ff({ type: 'number' }), '1,234.50'), null);
  assert.match(checkFormText(ff({ type: 'date' }), '31/31'), /date/);
  assert.equal(checkFormText(ff({ type: 'date' }), '10/28/2026'), null);
  assert.equal(quoteCode(ff({ format: 'UPPERCASE' }), 'ann'), 'QUOTE "ann" \\* Upper');
  assert.equal(quoteCode(ff({ format: 'LOWERCASE' }), 'Ann'), 'QUOTE "Ann" \\* Lower');
  assert.equal(quoteCode(ff({ format: 'FIRST CAPITAL' }), 'ann b'), 'QUOTE "ann b" \\* FirstCap');
  assert.equal(quoteCode(ff({ format: 'TITLE CASE' }), 'say "hi"'), 'QUOTE "say \\"hi\\"" \\* Caps');
  assert.equal(quoteCode(ff({ type: 'number', format: '0.00' }), '3'), 'QUOTE "3" \\# "0.00"');
  assert.equal(quoteCode(ff({ type: 'date', format: 'MMMM d, yyyy' }), '10/28/2026'), 'QUOTE "10/28/2026" \\@ "MMMM d, yyyy"');
  assert.equal(quoteCode(ff({}), 'x'), null, 'no format, no QUOTE');
});

test('Reset Form Fields, results and bookmark names', () => {
  assert.deepEqual(resetFf('text', ffDefaults('text', 'Text1')).result, EN_SPACES, 'an empty text field shows five en spaces');
  assert.equal(resetFf('text', { ...ffDefaults('text', 'Text1'), default: 'Ann' }).result, 'Ann');
  const box = resetFf('checkBox', { ...ffDefaults('checkBox', 'Check1'), default: true, checked: false });
  assert.equal(box.ff.checked, null);
  assert.equal(box.result, '☒');
  assert.equal(resetFf('dropDown', { ...ffDefaults('dropDown', 'Dropdown1'), items: ['A', 'B'], result: 1 }).result, 'A');
  assert.equal(ffResult('checkBox', { checked: true }), '☒');
  assert.equal(nextBookmarkName('Check', ['Check1', 'text1', 'check2']), 'Check3');
});

test('a drop-down refuses a 26th item, and ff round-trips through the options dialogs\' value objects', () => {
  let items = [];
  for (let i = 1; i <= 25; i++) items = addDropItem(items, `Item ${i}`);
  assert.equal(items.length, 25);
  assert.match(addDropItem(items, 'Item 26'), /at most 25/);
  assert.match(addDropItem(['A'], 'A'), /already/);
  for (const kind of ['text', 'checkBox', 'dropDown']) {
    const ff = { ...ffDefaults(kind, 'X1'), help: 'Help', future: { kept: true } };
    assert.deepEqual(formFf(ff, ffForm(kind, ff)), ff, `${kind} round-trips`);
  }
  const edited = formFf({ name: 'Text1', future: 1 }, { ...ffForm('text', { name: 'Text1' }), maxLength: 5 });
  assert.equal(edited.maxLength, 5);
  assert.equal(edited.future, 1, 'a key the dialog does not know survives');
});

test('dates show in the control\'s picture', () => {
  assert.equal(formatDate(new Date(Date.UTC(2026, 9, 28))), '10/28/2026');
  assert.equal(formatDate(new Date(Date.UTC(2026, 0, 5)), 'dddd, MMMM d, yyyy'), 'Monday, January 5, 2026');
});

test('locks hold against a select-all edit; only a load (setContent) replaces the whole document past them', () => {
  const d = doc([p(t('a '), cc({ id: '1', lock: 'sdtLocked' }, t('keep')), t(' b'))]);
  const state = EditorState.create({ doc: d });
  const all = state.tr.setSelection(new AllSelection(d));
  assert.match(lockCheck(all.deleteSelection(), state), /cannot be deleted/, 'Ctrl+A then Delete');
  assert.match(lockCheck(state.tr.setSelection(new AllSelection(d)).insertText('x'), state), /cannot be deleted/, 'Ctrl+A then typing');
  const load = state.tr.replaceWith(0, d.content.size, schema.nodes.paragraph.create()).setMeta('preventUpdate', false);
  assert.equal(lockCheck(load, state), null, 'setContent loads a new document');
  const frozen = doc([p(t('a '), cc({ id: '2', lock: 'contentLocked' }, t('fixed')))]);
  const fs = EditorState.create({ doc: frozen });
  assert.equal(lockCheck(fs.tr.setSelection(new AllSelection(frozen)).insertText('fixed!'), fs), null, 'contentLocked alone lets the control go');
  const both = doc([p(t('a '), cc({ id: '3', lock: 'sdtContentLocked' }, t('fixed')))]);
  const bs = EditorState.create({ doc: both });
  assert.match(lockCheck(bs.tr.setSelection(new AllSelection(both)).deleteSelection(), bs), /cannot be deleted/);
});

test('an IME or a paste inside a placeholder keeps only the new text', () => {
  const d = doc([p(t('Name: '), cc({ id: '1', type: 'richText', showingPlaceholder: true }, t('Type here.')))]);
  const at = posOf(d, '1');
  const state = stateOf(d);
  const { state: next } = state.applyTransaction(state.tr.insertText('你', at + 6)); // the caret after "Type " (arrived by arrow keys)
  const node = next.doc.nodeAt(at);
  assert.equal(node.textContent, '你');
  assert.equal(node.attrs.sdt.showingPlaceholder, false);
});

test('pasted copies get their own ids; pictures and other text leave bound props alone; a publish date is stored as yyyy-MM-dd', () => {
  const one = cc({ id: '1', type: 'text', lock: 'sdtLocked' }, t('x'));
  const d = doc([p(one, t(' '), one)]);
  const { state: s1 } = stateOf(d).applyTransaction(stateOf(d).tr.insertText('y', 1 + 3 + 1));
  const ids = [];
  s1.doc.descendants((n) => { if (n.attrs?.sdt?.id) ids.push(n.attrs.sdt.id); });
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'the copy has a new id');

  const pic = doc([p(cc({ id: 'p', type: 'picture', binding: { prop: 'core.title' }, showingPlaceholder: true }))], { props: { core: { title: 'Plan' } } });
  let ps = stateOf(pic);
  ps = ps.applyTransaction(ps.tr.insert(posOf(pic, 'p') + 1, schema.text('z'))).state;
  assert.equal(ps.doc.attrs.props.core.title, 'Plan', 'a picture writes nothing to its text property');
  ps = ps.applyTransaction(ps.tr.setDocAttribute('props', { core: { title: 'Other' } })).state;
  assert.equal(ps.doc.nodeAt(posOf(ps.doc, 'p')).attrs.sdt.type, 'picture');
  assert.equal(ps.doc.nodeAt(posOf(ps.doc, 'p')).textContent, 'z', 'a props change does not overwrite the picture');

  const box = doc([p(cc({ id: 'c', type: 'checkbox', checked: false, binding: { prop: 'core.title' } }, t('☐')))]);
  let bs = stateOf(box);
  bs = bs.applyTransaction(bs.tr.setDocAttribute('props', { core: { title: 'Plan' } })).state;
  assert.equal(bs.doc.nodeAt(posOf(bs.doc, 'c')).textContent, '☐', 'a check box ignores a value that is not yes or no');
  bs = bs.applyTransaction(bs.tr.setDocAttribute('props', { core: { title: 'true' } })).state;
  assert.equal(bs.doc.nodeAt(posOf(bs.doc, 'c')).attrs.sdt.checked, true);

  const date = { format: 'M/d/yyyy', full: null };
  const dd = doc([p(cc({ id: 'd', type: 'date', date, binding: { prop: 'cover.publishDate' }, showingPlaceholder: true, placeholder: '[Publish Date]' }, t('[Publish Date]')))]);
  let ds = stateOf(dd);
  ds = ds.applyTransaction(ds.tr.setDocAttribute('props', { cover: { publishDate: '2026-10-28' } })).state;
  const shown = ds.doc.nodeAt(posOf(ds.doc, 'd'));
  assert.equal(shown.textContent, '10/28/2026');
  assert.equal(shown.attrs.sdt.date.full, '2026-10-28T00:00:00Z');
  const dpos = posOf(ds.doc, 'd');
  const picked = ds.tr.replaceWith(dpos + 1, dpos + shown.nodeSize - 1, schema.text('11/2/2026'))
    .setNodeMarkup(dpos, null, { ...shown.attrs, sdt: { ...shown.attrs.sdt, date: { ...date, full: '2026-11-02T00:00:00Z' } } });
  ds = ds.applyTransaction(picked).state;
  assert.equal(ds.doc.attrs.props.cover.publishDate, '2026-11-02', 'a picked day is stored as yyyy-MM-dd');
});

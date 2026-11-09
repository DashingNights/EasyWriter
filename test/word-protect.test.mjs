import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { Editor, getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { DocAttrStep } from '@tiptap/pm/transform';
import { startEnforcing } from '../src/document/wp/protect/act.js';
import { sectionsOf } from '../src/document/model/sections.mjs';
import { documentExtensions } from '../src/document/schema.js';
import { allowed, judge, regionsOf, rulesOf } from '../src/document/wp/protect/filter.mjs';
import { hashPassword, verifyPassword } from '../src/document/wp/protect/hash.mjs';

// Restrict Editing (docs/plans/word/briefs/protect.md Acceptance): the password hash and the enforcement filter's decisions.
const schema = getSchema(documentExtensions(50));
const perm = (ed) => [{ type: 'permission', attrs: { id: ed, ed } }];
const para = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks && { marks }) }] });

function stateOf(content, attrs = {}) {
  const doc = schema.nodeFromJSON({ type: 'doc', attrs, content });
  return EditorState.create({ schema, doc });
}
const prot = (edit, extra = {}) => ({ settings: { protection: { edit, enforcement: true, formatting: false, ...extra } } });
/** Text position of `needle` inside `state`'s doc. */
const at = (state, needle) => {
  let found = -1;
  state.doc.descendants((n, pos) => {
    if (found < 0 && n.isText && n.text.includes(needle)) found = pos + n.text.indexOf(needle);
  });
  assert.ok(found >= 0, needle);
  return found;
};
const ok = (state, tr, opts) => allowed(tr, rulesOf(state.doc, opts));

test('hash equals node pbkdf2Sync and verify accepts only the right password', async () => {
  const salt = new Uint8Array(16).fill(7);
  const h = await hashPassword('Kd8-unique', salt);
  const expect = pbkdf2Sync('Kd8-unique', Buffer.from(salt), 100000, 64, 'sha512').toString('base64');
  assert.equal(h.hashValue, expect);
  assert.equal(h.saltValue, Buffer.from(salt).toString('base64'));
  assert.equal(h.algorithmName, 'PBKDF2-SHA-512');
  const fresh = await hashPassword('secret');
  assert.ok(await verifyPassword('secret', fresh));
  assert.ok(!(await verifyPassword('Secret', fresh)));
});

test('read only: regions for everyone and for the current user only', () => {
  const s = stateOf([para('Locked text.'), para('Open text.', perm('everyone')), para('Ada text.', perm('Ada Reviewer')), para('Bo text.', perm('Bo'))],
    prot('readOnly'));
  const user = { user: 'Ada Reviewer' };
  assert.equal(regionsOf(s.doc, 'Ada Reviewer').length, 2);
  assert.ok(!ok(s, s.tr.insertText('x', at(s, 'text.')), user), 'outside a region');
  assert.ok(ok(s, s.tr.insertText('x', at(s, 'Open') + 2), user), 'inside everyone');
  assert.ok(ok(s, s.tr.insertText('x', at(s, 'Ada') + 2), user), 'inside the user');
  assert.ok(!ok(s, s.tr.insertText('x', at(s, 'Bo') + 1), user), 'inside another name');
  assert.ok(!ok(s, s.tr.insertText('x', at(s, 'Bo') + 1), { user: '' }), 'no user name');
  // Meta-only transactions pass.
  assert.ok(ok(s, s.tr.setMeta('x', 1).setSelection(s.selection), user));
});

test('comments: comment marks and comment attrs pass, typing does not', () => {
  const s = stateOf([para('Some words here.')], prot('comments'));
  const from = at(s, 'words');
  assert.ok(ok(s, s.tr.addMark(from, from + 5, schema.marks.comment.create({ id: 'c1' }))));
  assert.ok(ok(s, s.tr.setDocAttribute('comments', { c1: { author: 'Ada', content: [] } })));
  assert.ok(!ok(s, s.tr.insertText('x', from)));
  assert.ok(!ok(s, s.tr.addMark(from, from + 5, schema.marks.bold.create())));
});

test('forms: only inside content controls in protected sections', () => {
  const sdt = { id: '1', type: 'text', lock: 'none' };
  const content = [
    { type: 'paragraph', content: [{ type: 'text', text: 'Name: ' }, { type: 'sdtInline', attrs: { sdt }, content: [{ type: 'text', text: 'Fill' }] }] },
    { type: 'sectionBreak', attrs: { kind: 'continuous', sect: { formProt: true } } },
    para('Free section.'),
  ];
  const s = stateOf(content, { ...prot('forms'), sect: { formProt: false } });
  assert.ok(!ok(s, s.tr.insertText('x', at(s, 'Name') + 1)), 'outside the sdt');
  assert.ok(ok(s, s.tr.insertText('x', at(s, 'Fill') + 1)), 'inside the sdt');
  assert.ok(ok(s, s.tr.insertText('x', at(s, 'Free') + 1)), 'section without formProt');
});

test('formatting: bold blocked, unlocked style allowed, locked style blocked', () => {
  const styles = { list: { Quote: { type: 'paragraph', name: 'Quote' }, Title: { type: 'paragraph', name: 'Title', locked: true } } };
  const s = stateOf([para('Plain words.')], { ...prot('none', { formatting: true }), styles });
  const from = at(s, 'Plain');
  assert.ok(!ok(s, s.tr.addMark(from, from + 5, schema.marks.bold.create())));
  const setStyle = (id) => s.tr.setNodeMarkup(0, null, { ...s.doc.firstChild.attrs, styleId: id });
  assert.ok(ok(s, setStyle('Quote')));
  assert.ok(!ok(s, setStyle('Title')));
  assert.ok(!ok(s, s.tr.setNodeAttribute(0, 'textAlign', 'center')), 'paragraph property');
  assert.ok(ok(s, s.tr.insertText('typing ', from)), 'typing is free');
});

test('viewing and final block every doc change; engine and appended roots pass', () => {
  const s = stateOf([para('Some words.', perm('everyone'))]);
  assert.equal(rulesOf(s.doc), null);
  assert.ok(!allowed(s.tr.insertText('x', 3), rulesOf(s.doc, { viewing: true })), 'viewing, even inside a region');
  assert.ok(allowed(s.tr.insertText('x', 1).setMeta('wordEngine', true), rulesOf(s.doc, { viewing: true })));
  const final = stateOf([para('Some words.')], { props: { custom: [{ name: '_MarkAsFinal', type: 'bool', value: true }] } });
  assert.ok(!ok(final, final.tr.insertText('x', 2)));
  assert.ok(!ok(final, final.tr.setDocAttribute('people', [])));
  // An appended transaction passes when its root passed.
  const root = s.tr.insertText('x', 3);
  assert.ok(judge(root, null));
  const appended = s.apply(root).tr.insertText('y', 3).setMeta('appendedTransaction', root);
  assert.ok(judge(appended, rulesOf(s.doc, { viewing: true })));
  assert.ok(!judge(s.tr.insertText('y', 3).setMeta('appendedTransaction', s.tr), rulesOf(s.doc, { viewing: true })));
  // tracked changes lets edits through.
  const t = stateOf([para('Some words.')], prot('trackedChanges'));
  assert.ok(ok(t, t.tr.insertText('x', 2)));
});

test('only engine changes touch the protection: an undo of Start Enforcing is refused', () => {
  const before = { protection: { edit: 'none', enforcement: false } };
  for (const attrs of [prot('trackedChanges'), prot('none', { formatting: true })]) {
    const s = stateOf([para('Some words.')], attrs);
    const undo = s.tr.step(new DocAttrStep('settings', before));
    assert.ok(!ok(s, undo), attrs.settings.protection.edit);
    assert.ok(ok(s, undo.setMeta('wordEngine', true)), 'engine');
    assert.ok(ok(s, s.tr.setDocAttribute('settings', { ...s.doc.attrs.settings, zoom: 120 })), 'another setting');
  }
  const t = stateOf([para('Some words.')], { ...prot('trackedChanges'), sect: { formProt: true } });
  assert.ok(!ok(t, t.tr.setDocAttribute('sect', { formProt: false })), 'sect.formProt');
  assert.ok(ok(t, t.tr.setDocAttribute('sect', { formProt: true, pgSz: { w: 1 } })), 'other sect keys');
});

test('formatting: theme changes are blocked only with Block Theme or Scheme switching', () => {
  const free = stateOf([para('Some words.')], prot('none', { formatting: true }));
  assert.ok(ok(free, free.tr.setDocAttribute('theme', { name: 'x' })));
  const lock = stateOf([para('Some words.')], prot('none', { formatting: true, lockTheme: true }));
  assert.ok(!ok(lock, lock.tr.setDocAttribute('theme', { name: 'x' })));
});

test('forms: Start Enforcing with no section choice protects every section', async () => {
  const ed = new Editor({ element: null, extensions: documentExtensions(50), content: { type: 'doc', content: [
    para('One.'), { type: 'sectionBreak', attrs: { kind: 'continuous', sect: {} } }, para('Two.'),
  ] } });
  await startEnforcing(ed, { edit: 'forms', formatting: false, fmt: null, sections: null }, '');
  assert.deepEqual(sectionsOf(ed.state.doc).map((x) => x.sect.formProt), [true, true]);
  ed.destroy();
});

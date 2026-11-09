import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { documentExtensions } from '../src/document/schema.js';
import { fieldCtx, parseField, registerFieldProvider, updateState } from '../src/document/fields/registry.mjs';
import { counts } from '../src/document/wp/fields-info/count.mjs';
import { docCounts } from '../src/document/wp/statusbar/docCount.mjs';
import { bindPrompt, DOCPROPERTY_NAMES, FIELDS, parseValue } from '../src/document/wp/fields-info/fields.mjs';

// fields-info (docs/plans/word/briefs/fields-info.md): the Word Count copy and the information fields.
const schema = getSchema(documentExtensions(50));
const P = (...content) => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)) });
const docOf = (content, attrs = {}) => schema.nodeFromJSON({ type: 'doc', attrs, content });
const ctxOf = (doc, extra = {}) => fieldCtx({ doc, pos: 0, draft: { title: 'My draft', created: Date.UTC(2026, 9, 27, 12), revision: 3, savedBy: 'Kel', editMinutes: 12.7 },
  user: { name: 'Kel', initials: 'KW', address: '1 Road' }, ...extra });
const run = (code, ctx) => FIELDS[parseField(code).name].compute(parseField(code), ctx);

// The status bar's counts (statusbar docCount.mjs) in fields-info's shape, so the copy is compared with the status bar's own rule.
const statusCounts = (doc) => {
  const c = docCounts(doc);
  return { words: c.words, chars: c.charsSp, noSpaces: c.chars, paragraphs: c.paras };
};

const FIXTURES = {
  empty: docOf([{ type: 'paragraph' }]),
  punctuation: docOf([P('Hello, world! -- it\'s "fine"... ok?')]),
  lineBreaks: docOf([P('one', { type: 'hardBreak' }, 'two', { type: 'hardBreak' }, 'three')]),
  twoParagraphs: docOf([P('First paragraph here.'), P('Second  one.')]),
  table: docOf([{ type: 'table', content: [{ type: 'tableRow', content: [
    { type: 'tableCell', content: [P('a b')] }, { type: 'tableCell', content: [P('c')] }] }] }, P('after')]),
};

test('count.mjs equals the status bar counts() on five fixtures', () => {
  for (const [name, doc] of Object.entries(FIXTURES)) assert.deepEqual(counts(doc), statusCounts(doc), name);
  assert.equal(counts(FIXTURES.lineBreaks).words, 3);
});

test('FILESIZE: bytes, \\k and \\m round', () => {
  const off = registerFieldProvider('fileSize', () => 13418);
  const ctx = ctxOf(FIXTURES.empty);
  assert.equal(run('FILESIZE', ctx), '13418');
  assert.equal(run('FILESIZE \\k', ctx), '13');
  assert.equal(run('FILESIZE \\m', ctx), '0');
  off();
});

test('DOCPROPERTY resolves the 26 built-in names, a custom property and an unknown name', () => {
  const doc = docOf([P('Two words.')], { props: { core: { title: 'T', creator: 'Ana' }, app: { company: 'Acme' },
    custom: [{ name: 'Client', type: 'text', value: 'Contoso' }, { name: 'Due', type: 'date', value: '2026-03-04' }, { name: 'Ok', type: 'bool', value: true }] } });
  const ctx = ctxOf(doc);
  assert.equal(DOCPROPERTY_NAMES.length, 26);
  for (const name of DOCPROPERTY_NAMES) assert.equal(typeof run(`DOCPROPERTY ${name}`, ctx), 'string', name);
  assert.equal(run('DOCPROPERTY Company', ctx), 'Acme');
  assert.equal(run('DOCPROPERTY Words', ctx), '2');
  assert.equal(run('DOCPROPERTY TotalEditingTime', ctx), '12');
  assert.equal(run('DOCPROPERTY Template', ctx), 'Normal.dotm');
  assert.equal(run('DOCPROPERTY "Client"', ctx), 'Contoso');
  assert.equal(run('DOCPROPERTY client', ctx), 'Contoso');
  assert.equal(run('DOCPROPERTY Ok', ctx), 'Y');
  // a custom date shows the en-US short date, M/d/yyyy
  assert.equal(run('DOCPROPERTY Due', ctx), '3/4/2026');
  assert.match(run('DOCPROPERTY CreateTime', ctx), /^10\/27\/2026 \d{1,2}:\d{2} [AP]M$/);
  assert.deepEqual(run('DOCPROPERTY Nope', ctx), { error: 'Error! Unknown document property name.' });
});

test('INFO: NumWords equals NUMWORDS, Manager is unknown, a new value writes the property', () => {
  const doc = docOf([P('one two three'), P('four')]);
  const ctx = ctxOf(doc);
  assert.equal(run('INFO NumWords', ctx), run('NUMWORDS', ctx));
  assert.equal(run('NUMWORDS', ctx), '4');
  assert.equal(run('NUMCHARS', ctx), String(counts(doc).noSpaces));
  assert.deepEqual(run('INFO Manager', ctx), { error: 'Error! Unknown info keyword.' });
  const shared = updateState({ props: [] });
  assert.equal(run('INFO Subject "New"', ctxOf(doc, { shared })), 'New');
  assert.deepEqual(shared.props, [{ path: 'core.subject', value: 'New' }]);
});

test('TITLE falls back to the draft title; AUTHOR "Ana" queues setProp; USERNAME "Ana" leaves settings alone', () => {
  const doc = docOf([P('x')]);
  assert.equal(run('TITLE', ctxOf(doc)), 'My draft');
  assert.equal(run('TITLE', ctxOf(docOf([P('x')], { props: { core: { title: 'Real' } } }))), 'Real');
  assert.equal(run('AUTHOR', ctxOf(doc)), 'Kel'); // a null creator shows the user name
  const shared = updateState({ props: [] });
  assert.equal(run('AUTHOR "Ana"', ctxOf(doc, { shared })), 'Ana');
  assert.deepEqual(shared.props, [{ path: 'core.creator', value: 'Ana' }]);
  const user = { name: 'Kel', initials: 'KW', address: '1 Road' };
  const ctx = ctxOf(doc, { user });
  assert.equal(run('USERNAME "Ana"', ctx), 'Ana');
  assert.equal(run('USERNAME', ctx), 'Kel');
  assert.equal(run('USERINITIALS', ctx), 'KW');
  assert.deepEqual(user, { name: 'Kel', initials: 'KW', address: '1 Road' });
  assert.equal(run('REVNUM', ctx), '3');
  assert.equal(run('LASTSAVEDBY', ctx), 'Kel');
  assert.equal(run('FILENAME', ctx), 'My draft');
});

test('DOCVARIABLE reads doc.attrs.vars; a missing one is an error', () => {
  const ctx = ctxOf(docOf([P('x')], { vars: { Ref: 'R-7' } }));
  assert.equal(run('DOCVARIABLE Ref', ctx), 'R-7');
  assert.deepEqual(run('DOCVARIABLE Other', ctx), { error: 'Error! No document variable supplied.' });
});

test('FILLIN prompts with its \\d default; ASK assigns the bookmark', async () => {
  const asked = [];
  bindPrompt(async (id, props) => (asked.push([id, props]), 'Typed'));
  const ctx = ctxOf(docOf([P('x')]));
  const f = parseField('FILLIN "Name?" \\d "Bo"');
  assert.equal(await FIELDS.FILLIN.prompt(f, ctx), 'Typed');
  assert.deepEqual(asked[0], ['fillIn', { prompt: 'Name?', value: 'Bo' }]);
  assert.equal(FIELDS.FILLIN.compute(f, ctxOf(docOf([P('x')]), { answer: 'Typed' })), 'Typed');
  assert.equal(FIELDS.FILLIN.compute(f, ctx), 'Bo');
  const shared = updateState();
  const a = parseField('ASK greet "Hi?"');
  assert.equal(a.args[0], 'greet');
  await FIELDS.ASK.prompt(a, ctx);
  assert.equal(asked[1][0], 'ask');
  assert.equal(FIELDS.ASK.compute(a, ctxOf(docOf([P('x')]), { answer: 'Hello', shared })), '');
  assert.equal(shared.assigned.get('greet'), 'Hello');
});

test('a Yes or no custom value saves yes until No is picked', () => {
  // The dialog draws Yes checked while the value is '' (just after picking the type).
  assert.deepEqual(parseValue('bool', ''), { value: true });
  assert.deepEqual(parseValue('bool', 'yes'), { value: true });
  assert.deepEqual(parseValue('bool', 'no'), { value: false });
  assert.deepEqual(parseValue('number', '4.5'), { value: 4.5 });
  assert.ok(parseValue('number', 'x').error);
});

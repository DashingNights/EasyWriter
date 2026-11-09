// Compare and Version History (docs/plans/word plan.md §3 compare): prepare() under the dialog's settings, the converter over
// prepared docs, bursts of history events and versions rebuilt from a history file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { documentExtensions } from '../src/document/schema.js';
import { DEFAULTS, prepare, refusal, resultTitle } from '../src/document/wp/compare/compare.mjs';
import { bursts, docAt, GAP, localVersions } from '../src/document/wp/compare/versions.mjs';
import * as core from '../src/suggest/core.mjs';
import { Suggestions } from '../src/suggest/extension.js';

const schema = getSchema([...documentExtensions(50), Suggestions]); // Suggestions adds the suggest attribute
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...runs) => ({ type: 'paragraph', content: runs.map((r) => (typeof r === 'string' ? t(r) : r)) });
const doc = (...content) => ({ type: 'doc', content });
const bold = (s) => t(s, [{ type: 'bold' }]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const [name, key, a, b] of [
  ['bold-only', 'formatting', p('Plain words here.'), p('Plain ', bold('words'), ' here.')],
  ['case', 'caseChanges', p('Hello there.'), p('hello There.')],
  ['white space', 'whiteSpace', p('Two  spaces here.'), p('Two spaces here.')],
]) {
  test(`prepare: a ${name} difference is equal with ${key} off and different with it on`, () => {
    const on = prepare(doc(a), doc(b), DEFAULTS);
    assert.ok(!same(on.original.content[0], on.revised.content[0]));
    const off = prepare(doc(a), doc(b), { ...DEFAULTS, [key]: false });
    assert.ok(same(off.original.content[0], off.revised.content[0]));
  });
}

test('prepare strips suggestion records and keeps blocks that differ in text', () => {
  const rec = { ...p('Kept'), attrs: { suggest: { ins: { id: 'x', g: 'g', by: 'a', at: 1, n: 1, sig: 's' } } } };
  const r = prepare(doc(rec, p('Old word')), doc(p('Kept'), p('New word')), { ...DEFAULTS, formatting: false });
  assert.deepEqual(r.original.content, [p('Kept'), p('Old word')]);
});

// Original and Revised as the harness case seeds them: one changed word, one bold-only change, one added paragraph, each apart.
const ORIGINAL = doc(p('Keep one.'), p('The quick fox.'), p('Keep two.'), p('Plain words here.'), p('Keep three.'));
const REVISED = doc(p('Keep one.'), p('The quick cat.'), p('Keep two.'), p('Plain ', bold('words'), ' here.'), p('Keep three.'), p('A new line.'));
const entriesOf = (opts) => {
  const { original, revised } = prepare(ORIGINAL, REVISED, opts);
  const a = EditorState.create({ schema, doc: schema.nodeFromJSON(original) });
  const b = EditorState.create({ schema, doc: schema.nodeFromJSON(revised) });
  const call = { g: 'compare-1', by: 'Rev A', at: 1, ids: [] };
  return core.entries(core.convert(a, b, call).doc);
};

test('convert over prepared docs: three entries with Formatting on, two with it off, all by the label', () => {
  const on = entriesOf(DEFAULTS);
  assert.equal(on.length, 3);
  assert.ok(on.every((e) => e.by === 'Rev A'));
  assert.equal(entriesOf({ ...DEFAULTS, formatting: false }).length, 2);
});

test('bursts split at a pause over five minutes', () => {
  const ev = (time, end = time) => ({ sel: null, trs: [{ steps: [], time }, { steps: [], time: end }] });
  const events = [ev(0, 1000), ev(2000), ev(2000 + GAP), ev(3000 + 2 * GAP + 1), ev(4000 + 2 * GAP)];
  assert.deepEqual(bursts(events), [[0, 3], [3, 5]]);
});

test('docAt rebuilds the doc after k events of a history file', () => {
  const base = schema.nodeFromJSON(doc(p('One.')));
  const tr = new Transform(base);
  const events = [];
  const docs = [base];
  for (const [i, text] of [' Two.', ' Three.', ' Four.'].entries()) {
    const at = tr.steps.length;
    tr.insert(tr.doc.content.size - 1, schema.text(text));
    events.push({ sel: null, trs: [{ steps: tr.steps.slice(at).map((s) => s.toJSON()), time: i * 10 * GAP }] });
    docs.push(tr.doc);
  }
  const file = { version: 1, base: base.toJSON(), events, undone: 0, images: {} };
  for (let k = 0; k <= events.length; k++) assert.ok(docAt(file, schema, k).eq(docs[k]), `k = ${k}`);
  // Three bursts: the base and the ends of the first two (the last is the saved doc), newest first.
  assert.deepEqual(localVersions(file).map((v) => v.k), [2, 1, 0]);
  assert.deepEqual(localVersions({ ...file, undone: 1 }).map((v) => v.k), [1, 0]);
});

test('the result title counts up per kind', () => {
  assert.equal(resultTitle('compare'), 'Compare Result 1');
  assert.equal(resultTitle('compare'), 'Compare Result 2');
  assert.equal(resultTitle('combine'), 'Combine Result 1');
});

test('refusal: a forum post or a newer Document is refused', () => {
  assert.equal(refusal({ format: 'document', doc: {} }, 1), null);
  assert.match(refusal({ format: 'forum-post', title: 'Post', doc: {} }, 1), /not a Document/);
  assert.match(refusal({ format: 'document', formatVersion: 3, doc: {} }, 2), /newer EasyWriter/);
});

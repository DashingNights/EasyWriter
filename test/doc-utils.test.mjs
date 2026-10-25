import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartRefs, cleanTitle, copyTitle, draftTitle, flowRefs, wordCount } from '../src/doc-utils.mjs';

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', content });

test('draftTitle', () => {
  assert.equal(draftTitle(doc()), 'Untitled');
  assert.equal(draftTitle(doc({ type: 'paragraph' }, para(text('   ')))), 'Untitled');
  assert.equal(draftTitle(doc(para(text('  Hello world  ')))), 'Hello world');
  const long = 'x'.repeat(100);
  const t = draftTitle(doc(para(text(long))));
  assert.equal(t.length, 60);
  assert.ok(t.endsWith('...'));
  assert.equal(draftTitle(doc(para(text('y'.repeat(60))))), 'y'.repeat(60));
  const wbFirst = doc({ type: 'canvas', attrs: { w: 800, h: 400, bg: 'post', items: [] } }, para(text('After board')));
  assert.equal(draftTitle(wbFirst), 'After board');
});

test('cleanTitle and copyTitle', () => {
  assert.equal(cleanTitle('  a\n b '), 'a b');
  assert.equal(cleanTitle(''), 'Untitled');
  assert.equal(cleanTitle('   '), 'Untitled');
  assert.equal(cleanTitle('z'.repeat(250)), 'z'.repeat(200));
  const copy = copyTitle('w'.repeat(200));
  assert.equal(copy.length, 200);
  assert.ok(copy.endsWith(' (copy)'));
  assert.equal(copyTitle('Notes'), 'Notes (copy)');
});

test('wordCount', () => {
  assert.equal(wordCount(doc()), 0);
  assert.equal(wordCount(doc(para(text('one two'), text(' three')), para(text('four')))), 4);
  assert.equal(wordCount(doc(para(text('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('b  c'))] }] })), 3);
});

test('flowRefs lists the synced canvases with their path and label', () => {
  const A = '3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21';
  const B = '00000000-0000-4000-8000-000000000001';
  const canvas = (flow) => ({ type: 'canvas', attrs: { w: 800, h: 450, items: [], flow } });
  const input = doc(
    para(text('intro')),
    canvas({ id: A, rev: 3 }),
    canvas(null),
    canvas({ id: 'not-a-uuid', rev: 1 }),
    { type: 'blockquote', content: [para(text('q')), canvas({ id: B, rev: 1 })] },
    canvas({ id: A, rev: 4 }),
  );
  const before = structuredClone(input);
  assert.deepEqual(flowRefs(input), [
    { path: [1], flowId: A, label: 'Flowchart 1' },
    { path: [4, 1], flowId: B, label: 'Flowchart 2' },
    { path: [5], flowId: A, label: 'Flowchart 1' },
  ]);
  assert.deepEqual(flowRefs(input, (id) => (id === B ? 'Login flow' : null)).map((r) => r.label), ['Flowchart 1', 'Login flow', 'Flowchart 1']);
  assert.deepEqual(flowRefs(doc(para(text('none')))), []);
  assert.deepEqual(input, before);
});

test('chartRefs lists the plan charts in document order', () => {
  const chart = (id) => ({ type: 'planChart', attrs: { id, planId: 'p', view: 'kanban', options: {}, frozen: null, dw: null } });
  const input = doc(chart('q7w3e9r'), para(text('x')), { type: 'blockquote', content: [chart('a1b2c3d')] });
  assert.deepEqual(chartRefs(input), [{ id: 'q7w3e9r', planId: 'p' }, { id: 'a1b2c3d', planId: 'p' }]);
  assert.deepEqual(chartRefs(doc(para(text('none')))), []);
});

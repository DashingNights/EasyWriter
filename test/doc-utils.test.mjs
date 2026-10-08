import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseStyles, replaceWhiteboards, draftTitle, wordCount, flowRefs, chartRefs } from '../src/doc-utils.mjs';

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', content });
const font = (f) => ({ type: 'fontFamily', attrs: { font: f } });
const size = (s) => ({ type: 'fontSize', attrs: { size: s } });

test('applyBaseStyles adds font and size marks to plain text', () => {
  const out = applyBaseStyles(doc(para(text('hi'))), { baseFont: 'Georgia', baseSize: 125 });
  assert.deepEqual(out.content[0].content[0].marks, [font('Georgia'), size('125')]);
});

test('applyBaseStyles: defaults are a no-op', () => {
  const input = doc(para(text('hi')));
  assert.deepEqual(applyBaseStyles(input, { baseFont: '', baseSize: 100 }), input);
});

test('applyBaseStyles: headings get font but not size; code gets neither', () => {
  const input = doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('H')] },
    { type: 'codeBlock', content: [text('x = 1')] },
    para(text('c', [{ type: 'code' }])),
  );
  const out = applyBaseStyles(input, { baseFont: 'Arial', baseSize: 90 });
  assert.deepEqual(out.content[0].content[0].marks, [font('Arial')]);
  assert.equal(out.content[1].content[0].marks, undefined);
  assert.deepEqual(out.content[2].content[0].marks, [{ type: 'code' }]);
});

test('applyBaseStyles keeps existing font/size marks and does not mutate input', () => {
  const input = doc(para(text('a', [{ type: 'bold' }, font('Impact'), size('200')]), text('b', [{ type: 'italic' }])));
  const before = structuredClone(input);
  const out = applyBaseStyles(input, { baseFont: 'Georgia', baseSize: 80 });
  assert.deepEqual(input, before);
  assert.deepEqual(out.content[0].content[0].marks, [{ type: 'bold' }, font('Impact'), size('200')]);
  assert.deepEqual(out.content[0].content[1].marks, [{ type: 'italic' }, font('Georgia'), size('80')]);
});

test('replaceWhiteboards replaces nested boards in document order', () => {
  const wb = (h) => ({ type: 'whiteboard', attrs: { height: h, bg: 'post', items: [] } });
  const input = doc(
    wb(100),
    { type: 'blockquote', content: [para(text('q')), wb(200)] },
    para(text('end')),
    wb(300),
  );
  const before = structuredClone(input);
  const { doc: out, boards } = replaceWhiteboards(input);
  assert.deepEqual(input, before);
  assert.deepEqual(boards.map((b) => b.height), [100, 200, 300]);
  assert.deepEqual(boards[0], { height: 100, bg: 'post', items: [], kind: 'whiteboard' });
  const ph = (i) => para(text(`[[IMG:${i}]]`));
  assert.deepEqual(out.content[0], ph(0));
  assert.deepEqual(out.content[1].content[1], ph(1));
  assert.deepEqual(out.content[3], ph(2));
  assert.deepEqual(out.content[2], para(text('end')));
});

test('replaceWhiteboards: canvases share the numbering and carry their kind', () => {
  const canvas = { type: 'canvas', attrs: { w: 600, h: 300, dw: 300, bg: 'post', items: [] } };
  const input = doc({ type: 'whiteboard', attrs: { height: 100, bg: 'post', items: [] } }, canvas, para(text('end')));
  const { doc: out, boards } = replaceWhiteboards(input);
  assert.deepEqual(boards.map((b) => b.kind), ['whiteboard', 'canvas']);
  assert.deepEqual(boards[1], { ...canvas.attrs, kind: 'canvas' });
  assert.deepEqual(out.content[1], para(text('[[IMG:1]]')));
  assert.equal(input.content[1].attrs.kind, undefined);
});

test('draftTitle', () => {
  assert.equal(draftTitle(doc()), 'Untitled draft');
  assert.equal(draftTitle(doc({ type: 'paragraph' }, para(text('   ')))), 'Untitled draft');
  assert.equal(draftTitle(doc(para(text('  Hello world  ')))), 'Hello world');
  const long = 'x'.repeat(100);
  const t = draftTitle(doc(para(text(long))));
  assert.equal(t.length, 60);
  assert.ok(t.endsWith('...'));
  assert.equal(draftTitle(doc(para(text('y'.repeat(60))))), 'y'.repeat(60));
  const wbFirst = doc({ type: 'whiteboard', attrs: { height: 400, bg: 'post', items: [] } }, para(text('After board')));
  assert.equal(draftTitle(wbFirst), 'After board');
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

test('replaceWhiteboards: a plan chart between a whiteboard and a canvas is image 1; chartRefs lists the charts', () => {
  const chart = (id) => ({ type: 'planChart', attrs: { id, planId: 'p', view: 'kanban', options: {}, frozen: null, dw: null } });
  const input = doc(
    { type: 'whiteboard', attrs: { height: 100, bg: 'post', items: [] } },
    chart('q7w3e9r'),
    { type: 'canvas', attrs: { w: 600, h: 300, dw: 300, bg: 'post', items: [] } },
    { type: 'blockquote', content: [chart('a1b2c3d')] },
  );
  const { doc: out, boards } = replaceWhiteboards(input);
  assert.deepEqual(boards.map((b) => b.kind), ['whiteboard', 'planChart', 'canvas', 'planChart']);
  assert.deepEqual(out.content[1], para(text('[[IMG:1]]')));
  assert.equal(boards[1].id, 'q7w3e9r');
  assert.deepEqual(chartRefs(input), [{ id: 'q7w3e9r', planId: 'p' }, { id: 'a1b2c3d', planId: 'p' }]);
  assert.deepEqual(chartRefs(doc(para(text('none')))), []);
});

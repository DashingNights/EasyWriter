import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseStyles, replaceWhiteboards } from '../src/integrations/forum/post.mjs';

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
  const wb = (h) => ({ type: 'canvas', attrs: { w: 800, h, dw: 800, bg: 'post', items: [] } });
  const input = doc(
    wb(100),
    { type: 'blockquote', content: [para(text('q')), wb(200)] },
    para(text('end')),
    wb(300),
  );
  const before = structuredClone(input);
  const { doc: out, boards } = replaceWhiteboards(input);
  assert.deepEqual(input, before);
  assert.deepEqual(boards.map((b) => b.h), [100, 200, 300]);
  assert.deepEqual(boards[0], { w: 800, h: 100, dw: 800, bg: 'post', items: [], kind: 'canvas' });
  const ph = (i) => para(text(`[[IMG:${i}]]`));
  assert.deepEqual(out.content[0], ph(0));
  assert.deepEqual(out.content[1].content[1], ph(1));
  assert.deepEqual(out.content[3], ph(2));
  assert.deepEqual(out.content[2], para(text('end')));
});

test('replaceWhiteboards: canvases share the numbering and carry their kind', () => {
  const canvas = { type: 'canvas', attrs: { w: 600, h: 300, dw: 300, bg: 'post', items: [] } };
  const input = doc(canvas, canvas, para(text('end')));
  const { doc: out, boards } = replaceWhiteboards(input);
  assert.deepEqual(boards.map((b) => b.kind), ['canvas', 'canvas']);
  assert.deepEqual(boards[1], { ...canvas.attrs, kind: 'canvas' });
  assert.deepEqual(out.content[1], para(text('[[IMG:1]]')));
  assert.equal(input.content[1].attrs.kind, undefined);
});

test('replaceWhiteboards: a plan chart between two canvases is image 1', () => {
  const chart = (id) => ({ type: 'planChart', attrs: { id, planId: 'p', view: 'kanban', options: {}, frozen: null, dw: null } });
  const input = doc(
    { type: 'canvas', attrs: { w: 800, h: 100, dw: 800, bg: 'post', items: [] } },
    chart('q7w3e9r'),
    { type: 'canvas', attrs: { w: 600, h: 300, dw: 300, bg: 'post', items: [] } },
    { type: 'blockquote', content: [chart('a1b2c3d')] },
  );
  const { doc: out, boards } = replaceWhiteboards(input);
  assert.deepEqual(boards.map((b) => b.kind), ['canvas', 'planChart', 'canvas', 'planChart']);
  assert.deepEqual(out.content[1], para(text('[[IMG:1]]')));
  assert.equal(boards[1].id, 'q7w3e9r');
});

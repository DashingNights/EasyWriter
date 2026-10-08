import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { find, nodeAt, outline, pathOfPos, posOfPath } from '../src/doc-path.mjs';
import { clearRevLog, mapPath, recordRev } from '../src/app/rev.js';
import { getState } from '../src/app/store.js';

const t = (text) => ({ type: 'text', text });
const p = (...c) => ({ type: 'paragraph', content: c });
const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Week 3')] },
    p(t('Alpha beta'), { type: 'hardBreak' }, t('gamma Week 3')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }, { type: 'listItem', content: [p(t('two week 3'))] }] },
    { type: 'whiteboard', attrs: { items: [{ id: 'a' }, { id: 'b' }], height: 300 } },
    p(),
  ],
};

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph block*' },
    whiteboard: { group: 'block', atom: true, attrs: { items: { default: [] }, height: { default: 200 } } },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true, leafText: () => '\n' },
  },
});
const pm = schema.nodeFromJSON(DOC);

test('nodeAt walks child indices; out of range is null', () => {
  assert.equal(nodeAt(DOC, [2, 1, 0]).content[0].text, 'two week 3');
  assert.equal(nodeAt(DOC, [9]), null);
  assert.equal(nodeAt(DOC, [3, 0]), null);
});

test('outline: top level by default, text capped, board and heading attrs', () => {
  const o = outline(DOC);
  assert.deepEqual(o.map((e) => e.path), [[0], [1], [2], [3], [4]]);
  assert.deepEqual(o[0], { path: [0], type: 'heading', text: 'Week 3', attrs: { level: 2 } });
  assert.equal(o[1].text, 'Alpha beta\ngamma Week 3');
  assert.equal(o[2].text, 'one two week 3');
  assert.deepEqual(o[3].attrs, { kind: 'whiteboard', items: 2, w: null, h: 300 });
  assert.deepEqual(outline(DOC, { depth: 3 }).filter((e) => e.path[0] === 2).map((e) => e.path), [[2], [2, 0], [2, 0, 0], [2, 1], [2, 1, 0]]);
  assert.equal(outline({ content: [p(t('x'.repeat(200)))] })[0].text, `${'x'.repeat(120)}... (cut, 200 characters in all)`);
  assert.equal(outline({ content: [p(t('x'.repeat(120)))] })[0].text, 'x'.repeat(120));
});

test('find: block-local offsets (a hard break is one character), case, regex, context', () => {
  const m = find(DOC, { text: 'week 3' });
  assert.deepEqual(m.map((x) => [x.path, x.from, x.to]), [[[0], 0, 6], [[1], 17, 23], [[2, 1, 0], 4, 10]]);
  assert.equal(find(DOC, { text: 'week 3', caseSensitive: true }).length, 1);
  assert.equal(find(DOC, { text: 'w\\w+k \\d', regex: true }).length, 3);
  assert.equal(m[1].context, 'Alpha beta\ngamma Week 3');
  assert.equal(find(DOC, { text: 'a.b' }).length, 0); // literal unless regex
  assert.throws(() => find(DOC, { text: '(', regex: true }));
});

test('posOfPath / pathOfPos round trip on a ProseMirror doc', () => {
  for (const path of [[0], [1], [2], [2, 1], [2, 1, 0], [3], [4]]) {
    const pos = posOfPath(pm, path);
    assert.equal(pm.nodeAt(pos).type.name, nodeAt(DOC, path).type, String(path));
    assert.deepEqual(pathOfPos(pm, pos), path);
  }
  assert.equal(posOfPath(pm, [7]), null);
  assert.equal(posOfPath(pm, [0, 0]), null); // into a textblock's inline content
  assert.deepEqual(pathOfPos(pm, posOfPath(pm, [1]) + 3), [1]); // inside a paragraph: that paragraph
  assert.equal(pathOfPos(pm, pm.content.size), null);
});

test('mapPath follows a path read at an older rev; a deleted block is stale', () => {
  let state = EditorState.create({ doc: pm });
  const apply = (tr) => {
    recordRev(tr);
    state = state.apply(tr);
  };
  clearRevLog();
  const rev = getState().rev; // read here: the whiteboard is [3], the empty paragraph [4]
  apply(state.tr.insert(0, schema.nodes.paragraph.create(null, schema.text('new first'))));
  assert.equal(getState().rev, rev + 1);
  assert.deepEqual(mapPath([3], rev, state.doc), [4]);
  assert.deepEqual(mapPath([2, 1, 0], rev, state.doc), [3, 1, 0]);
  apply(state.tr.insertText('typed ', posOfPath(state.doc, [1]) + 1)); // typing inside the heading moves nothing
  assert.deepEqual(mapPath([3], rev, state.doc), [4]);
  const wb = posOfPath(state.doc, [4]);
  apply(state.tr.delete(wb, wb + state.doc.nodeAt(wb).nodeSize));
  assert.equal(mapPath([3], rev, state.doc), 'stale');
  assert.deepEqual(mapPath([4], rev, state.doc), [4]); // the paragraph after it
  assert.equal(mapPath([0], getState().rev + 1, state.doc), 'stale'); // newer than the doc
  clearRevLog(); // a remount: older revs no longer map
  assert.equal(mapPath([0], rev, state.doc), 'stale');
});

test('mapPath: a block replaced in place (a board write, a block type change) keeps its path', () => {
  let state = EditorState.create({ doc: pm });
  const apply = (tr) => {
    recordRev(tr);
    state = state.apply(tr);
  };
  clearRevLog();
  const rev = getState().rev; // the whiteboard is [3]
  const wb = posOfPath(state.doc, [3]);
  apply(state.tr.setNodeMarkup(wb, undefined, { items: [{ id: 'a' }], height: 300 })); // an atom: a same-size ReplaceStep
  assert.deepEqual(mapPath([3], rev, state.doc), [3]);
  assert.deepEqual(mapPath([4], rev, state.doc), [4]);
  apply(state.tr.setNodeMarkup(posOfPath(state.doc, [1]), schema.nodes.heading, { level: 3 })); // a ReplaceAroundStep
  assert.deepEqual(mapPath([1], rev, state.doc), [1]);
  assert.deepEqual(mapPath([3], rev, state.doc), [3]);
  const h = posOfPath(state.doc, [0]); // the heading, replaced whole by another block of its size: a different block, stale
  apply(state.tr.replaceWith(h, h + state.doc.nodeAt(h).nodeSize, schema.nodes.paragraph.create(null, schema.text('Week 4'))));
  assert.equal(mapPath([0], rev, state.doc), 'stale');
  assert.deepEqual(mapPath([3], rev, state.doc), [3]);
  apply(state.tr.insert(0, schema.nodes.paragraph.create())); // then a block before it still moves it
  assert.deepEqual(mapPath([3], rev, state.doc), [4]);
  const at = posOfPath(state.doc, [4]);
  apply(state.tr.delete(at, at + 1)); // and deleting it is still stale
  assert.equal(mapPath([3], rev, state.doc), 'stale');
});

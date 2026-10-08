import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, GATES } from '../src/app/gates.mjs';

const SUBJECTS = ['ui', 'board', 'doc', 'history', 'draft', 'node', 'flow', 'window'];

test('every gate has a known subject, a test, a message and a fix', () => {
  for (const [id, g] of Object.entries(GATES)) {
    assert.ok(SUBJECTS.includes(g.subject), `${id} subject`);
    assert.equal(typeof g.test, 'function', `${id} test`);
    assert.ok(typeof g.message === 'string' && g.message.length > 0, `${id} message`);
    assert.ok(typeof g.fix === 'string' && g.fix.length > 0, `${id} fix`);
  }
});

test('ui gates read the view and the editor (the store state fits)', () => {
  const ui = { view: { type: 'flows', flowId: null }, editor: {} };
  assert.equal(can('doc.open', ui), true);
  assert.equal(can('doc.open', { view: ui.view, editor: null }), false);
  assert.deepEqual(['view.editor', 'view.plan', 'view.flows', 'view.browser'].map((id) => can(id, ui)), [false, false, true, false]);
  assert.equal(can('view.editor', { view: { type: 'editor' } }), true);
});

test('window.visible reads {visible} (needed by the in-app assistant for headless: false commands)', () => {
  assert.deepEqual([{ visible: true }, { visible: false }, null].map((w) => can('window.visible', w)), [true, false, false]);
});

test('board gates read a snapshot; no board fails them all', () => {
  const one = { kind: 'canvas', count: 1, item: { type: 'image' }, canUndo: true, canRedo: false };
  const many = { kind: 'whiteboard', count: 3, item: null };
  assert.equal(can('board.active', one), true);
  assert.equal(can('board.whiteboard', one), false);
  assert.equal(can('board.whiteboard', many), true);
  assert.deepEqual([one, many, null].map((b) => can('board.canvasMode', b)), [true, false, false]);
  assert.equal(can('board.selection', one), true);
  assert.equal(can('board.selectionMany', one), false);
  assert.equal(can('board.selectionMany', many), true);
  assert.equal(can('board.itemIs', one, null, ['image', 'canvas']), true);
  assert.equal(can('board.itemIs', many, null, ['image']), false);
  assert.equal(can('history.canUndo', one), true);
  assert.equal(can('history.canRedo', one), false);
  for (const id of ['board.active', 'board.whiteboard', 'board.selection', 'board.selectionMany']) assert.equal(can(id, null), false, id);
  assert.equal(can('board.itemIs', null, null, ['image']), false);
});

test('draft, doc, node and flow gates', () => {
  const pushed = { id: 'x', threadUrl: 'https://daf.staffs.ac.uk/topic/1-a/', pushedAt: 5 };
  const fresh = { id: 'y', threadUrl: null, pushedAt: null };
  assert.deepEqual([can('draft.pushed', pushed), can('draft.unpushed', pushed), can('draft.hasThread', pushed)], [true, false, true]);
  assert.deepEqual([can('draft.pushed', fresh), can('draft.unpushed', fresh), can('draft.hasThread', fresh)], [false, true, false]);
  assert.equal(can('draft.unpushed', null), false);
  assert.equal(can('doc.inTable', { inTable: true }), true);
  const synced = { type: 'canvas', attrs: { flow: { id: '3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21', rev: 2 } } };
  const plain = { type: 'canvas', attrs: { flow: null } };
  const wb = { type: 'whiteboard', attrs: {} };
  assert.deepEqual([synced, plain, wb].map((n) => can('node.board', n)), [true, true, true]);
  assert.deepEqual([synced, plain, wb].map((n) => can('node.canvas', n)), [true, true, false]);
  assert.deepEqual([plain, wb, null].map((n) => can('node.whiteboard', n)), [false, true, false]);
  assert.deepEqual([synced, plain, wb].map((n) => can('flow.synced', n)), [true, false, false]);
  assert.deepEqual([synced, plain, wb].map((n) => can('flow.unsynced', n)), [false, true, false]);
  assert.equal(can('flow.open', { id: 'r', board: {} }), true);
  assert.equal(can('flow.present', null), false);
});

test('node.none and node.is read the node-selected block (node.is: the kind the tool search gives it)', () => {
  const flow = { type: 'canvas', attrs: {}, kind: 'flowchart' };
  assert.equal(can('node.none', null), true);
  assert.equal(can('node.none', flow), false);
  assert.equal(can('node.none', { type: 'horizontalRule', attrs: {}, kind: null }), false);
  assert.equal(can('node.is', flow, null, ['flowchart', 'canvas']), true);
  assert.equal(can('node.is', flow, null, ['planChart']), false);
  assert.equal(can('node.is', { type: 'canvas', attrs: {} }, null, ['canvas']), false); // no kind: a command's subject
  assert.equal(can('node.is', null, null, ['canvas']), false);
});

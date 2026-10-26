import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, GATES } from '../src/app/gates.mjs';

const SUBJECTS = ['ui', 'board', 'doc', 'history', 'draft', 'node', 'flow', 'window', 'settings'];

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
  const many = { kind: 'canvas', count: 3, item: null };
  assert.equal(can('board.active', one), true);
  assert.ok(!('board.whiteboard' in GATES));
  assert.deepEqual([one, many, null].map((b) => can('board.canvasMode', b)), [true, true, false]);
  assert.equal(can('board.selection', one), true);
  assert.equal(can('board.selectionMany', one), false);
  assert.equal(can('board.selectionMany', many), true);
  assert.equal(can('board.itemIs', one, null, ['image', 'canvas']), true);
  assert.equal(can('board.itemIs', many, null, ['image']), false);
  assert.equal(can('history.canUndo', one), true);
  assert.equal(can('history.canRedo', one), false);
  for (const id of ['board.active', 'board.selection', 'board.selectionMany']) assert.equal(can(id, null), false, id);
  assert.equal(can('board.itemIs', null, null, ['image']), false);
});

test('draft, doc, node and flow gates', () => {
  const PROJECT = 'project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55';
  const threads = [{ url: PROJECT, title: 'P', thread: 'https://forum.example.com/topic/1-a/' }];
  const pushed = { id: 'x', threadUrl: PROJECT, pushedAt: 5, threads };
  const fresh = { id: 'y', threadUrl: PROJECT, pushedAt: null, threads: [{ url: PROJECT, title: 'P' }] };
  assert.deepEqual([can('draft.pushed', pushed), can('draft.unpushed', pushed), can('draft.hasThread', pushed)], [true, false, true]);
  assert.deepEqual([can('draft.pushed', fresh), can('draft.unpushed', fresh), can('draft.hasThread', fresh)], [false, true, false]);
  assert.equal(can('draft.unpushed', null), false);
  assert.equal(can('doc.inTable', { inTable: true }), true);
  const synced = { type: 'canvas', attrs: { flow: { id: '3f1c2a9e-4b7d-4f1e-9c2a-7d5e1f0b8a21', rev: 2 } } };
  const plain = { type: 'canvas', attrs: { flow: null } };
  const wb = { type: 'whiteboard', attrs: {} };
  assert.deepEqual([synced, plain, wb, null].map((n) => can('node.board', n)), [true, true, false, false]);
  assert.deepEqual([synced, plain, wb].map((n) => can('node.canvas', n)), [true, true, false]);
  assert.ok(!('node.whiteboard' in GATES));
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

test('format.post and format.document read the draft subject (no draft or no format: a forum post)', () => {
  const drafts = [null, {}, { format: null }, { format: 'forum-post' }, { format: 'page' }, { format: 'document' }];
  assert.deepEqual(drafts.map((d) => can('format.post', d)), [true, true, true, true, true, false]);
  assert.deepEqual(drafts.map((d) => can('format.document', d)), [false, false, false, false, false, true]);
  assert.equal(can('format.post', { format: 'forum-post', formatVersion: 2 }), false); // a newer build's draft is neither
});

test("format.box follows the draft's format, not the app default", () => {
  assert.equal(GATES['format.box'].subject, 'draft');
  assert.deepEqual([{}, { format: 'forum-post' }, { format: 'page' }, { format: 'document' }].map((d) => can('format.box', d)), [true, true, false, false]);
});

test("doc.command checks insertBox against the draft's format (before the ask, commands.js failedGates)", async () => {
  const { defs } = await import('../src/app/commands/doc.mjs');
  const { check } = defs.find((d) => d.id === 'doc.command');
  const on = { integrations: { forum: { enabled: true } }, forumWidth: 1454 };
  const off = { integrations: { forum: { enabled: false } } };
  assert.deepEqual(check({ name: 'insertBox' }, {}, off), []);
  assert.deepEqual(check({ name: 'insertBox' }, { format: 'forum-post' }, off), []);
  assert.deepEqual(check({ name: 'insertBox' }, {}, on), []);
  assert.deepEqual(check({ name: 'insertBox' }, { format: 'page' }, on), ['format.box']);
  assert.deepEqual(check({ name: 'toggleBold' }, {}, off), []);
  assert.deepEqual(check({ name: 'insertBox' }, { format: 'document' }, on), ['format.post']);
  for (const name of ['setFontSize', 'unsetTextColor', 'toggleCode', 'toggleBlockquote', 'toggleCodeBlock', 'setHorizontalRule']) {
    assert.deepEqual(check({ name }, { format: 'document' }, on), ['format.post'], name);
  }
  assert.deepEqual(check({ name: 'toggleBold' }, { format: 'document' }, on), []);
});

test('doc.format refuses the forum marks and presets on a non-forum draft', async () => {
  const { defs } = await import('../src/app/commands/doc.mjs');
  const { check } = defs.find((d) => d.id === 'doc.format');
  const doc = { format: 'document' };
  for (const marks of [{ fontSize: 150 }, { textColor: null }, { highlight: 'red' }, { fontFamily: null }, { code: true }]) {
    assert.deepEqual(check({ path: [0], marks }, doc), ['format.post'], Object.keys(marks)[0]);
    assert.deepEqual(check({ path: [0], marks }, {}), [], Object.keys(marks)[0]);
  }
  assert.deepEqual(check({ path: [0], presetId: 'p1' }, doc), ['format.post']);
  assert.deepEqual(check({ path: [0], marks: { bold: true }, block: { align: 'center' } }, doc), []);
});

test('integration gates follow the settings and carry their integration', () => {
  assert.equal(can('integration.forum', { integrations: { forum: { enabled: true } } }), true);
  assert.equal(can('integration.forum', { integrations: { forum: { enabled: false } } }), false);
  assert.equal(can('integration.forum', {}), false);
  for (const id of ['integration.forum', 'app.forum', 'draft.hasThread', 'draft.pushed', 'draft.unpushed']) assert.equal(GATES[id].integration, 'forum', id);
  assert.equal(GATES['doc.open'].integration, undefined);
});

test("wake.forum: the open draft's project links a forum thread, untagged so it holds while the forum is off", () => {
  const [P1, P2] = ['project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55', 'project:1b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55'];
  const threads = [{ url: P1, title: 'P', thread: 'https://forum.example.com/topic/1-a/' }, { url: P2, title: 'Q' }];
  assert.equal(GATES['wake.forum'].integration, undefined);
  assert.equal(GATES['wake.forum'].wake, 'forum'); // commands.js gatesNow leaves it out of ui.state
  assert.equal(can('wake.forum', { id: 'd', threadUrl: P1, threads }), true);
  assert.equal(can('wake.forum', { id: 'd', threadUrl: P2, threads }), false);
  assert.equal(can('wake.forum', null), false);
  assert.match(GATES['integration.forum'].fix, /Push to forum/);
});

test('draft.settled: no suggestion waits in the draft (docs/plans/suggestions.md)', () => {
  assert.equal(can('draft.settled', { suggestions: 2 }), false);
  assert.equal(can('draft.settled', {}), true);
  assert.equal(can('draft.settled', { suggestions: 0 }), true);
});

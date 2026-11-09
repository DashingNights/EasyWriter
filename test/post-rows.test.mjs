// post-rows (docs/plans/engine/stage3-forum.md C2): the forum post's engine table names every granted pool id, every row that
// runs an engine command reads the post's one state (post.context), the app's dialogs and boards run as registered, a preset is
// one execMany of post.mark steps, and a keymap can take a format's own bindings.
import assert from 'node:assert/strict';
import test from 'node:test';
import { POOL_IDS } from '../src/app/pool.js';
import { POST_ROWS } from '../src/document/canvas/rows/post.mjs';
import { APP } from '../src/document/canvas/rows/forms.mjs';
import { createKeymap } from '../src/engine/input/keys.mjs';
import { grants, TEXT_PROFILE } from '../src/tooling/profile.mjs';

const CTX = 'post.context';
const rowOf = (id) => POST_ROWS[id] ?? Object.entries(POST_ROWS).find(([k]) => k.endsWith('.*') && id.startsWith(k.slice(0, -1)))?.[1];

test('every pool id the text profile grants has a row', () => {
  for (const id of Object.values(POOL_IDS)) {
    assert.ok(grants(TEXT_PROFILE, id), `${id} is granted to a post`);
    assert.ok(rowOf(id), `${id} has a row`);
  }
});

test('every row that runs an engine command reads post.context', () => {
  for (const [id, row] of Object.entries(POST_ROWS)) {
    if (row === APP) continue;
    assert.equal(row.state ?? row.reads?.[0], CTX, id);
  }
});

test('the app dialogs and boards run as registered', () => {
  for (const id of ['insert.link', 'insert.canvas', 'insert.flowchart', 'insert.planChart', 'insert.image', 'references.insertCitation',
    'references.manageSources', 'board.select', 'plan.open', 'view.zoom.zoom']) assert.equal(rowOf(id), APP, id);
});

test("the toolbar's commands run the post commands they name", () => {
  const row = (id) => POST_ROWS[id];
  assert.deepEqual([row('text.bold').exec, row('text.bold').args, row('text.bold').state], ['post.mark', { mark: 'bold' }, CTX]);
  assert.deepEqual([row('para.quote').exec, row('para.quote').args], ['post.toggle', { kind: 'quote' }]);
  assert.deepEqual([row('para.bulletList').exec, row('para.bulletList').args], ['post.list', { kind: 'bullet' }]);
  assert.deepEqual([row('insert.rule').exec, row('insert.rule').state], ['post.rule', CTX]);
  assert.deepEqual([row('insert.box').exec, row('insert.box').args], ['post.toggle', { kind: 'box' }]);
  assert.equal(row('table.deleteTable').exec, 'table.deleteTable');
});

test('a preset runs its post.mark steps as one undo step', async () => {
  let steps = null;
  const ctx = { engine: { execMany: (s) => ((steps = s), { ok: true }) }, settings: { presets: [{ bold: true, size: 150, color: 'red' }] } };
  assert.equal(await POST_ROWS['text.preset'].run(ctx, 0), true);
  assert.deepEqual(steps.at(-3), ['post.mark', { size: 150 }]);
  assert.deepEqual(steps.at(-2), ['post.mark', { color: 'red' }]);
  assert.deepEqual(steps.at(-1), ['post.mark', { mark: 'bold', on: true }]);
  assert.deepEqual(steps.slice(0, 4), [['post.mark', { font: null }], ['post.mark', { size: null }], ['post.mark', { color: null }],
    ['post.mark', { highlight: null }]]);
  const refused = { engine: { execMany: async () => ({ ok: false }) }, settings: { presets: [{}] } };
  assert.equal(await POST_ROWS['text.preset'].run(refused, 0), false);
});

test('a size takes the control\'s percent sign', () => {
  assert.deepEqual(POST_ROWS['text.size'].args('150%'), { size: 150 });
  assert.deepEqual(POST_ROWS['text.size'].args(80), { size: 80 });
  assert.equal(POST_ROWS['text.size'].args('big'), null);
});

test("a keymap can take another format's bindings", () => {
  const binds = { 'text.bold': { call: 'exec', args: ['post.mark', { mark: 'bold' }] } };
  const keymap = createKeymap({ defs: [{ id: 'text.bold', scope: 'text' }], among: (ids) => ids[0], chordOf: () => 'Ctrl+B', isMac: () => false, binds });
  assert.deepEqual(keymap({}), { call: 'exec', args: ['post.mark', { mark: 'bold' }] });
});

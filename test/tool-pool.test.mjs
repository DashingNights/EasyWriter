// One tool pool across surfaces (docs/plans/cleanup/tool-pool-surfaces.md F2): activeSurface for every surface, the profiles'
// grants and option lists, Word's commands kept to the Document, and the tool search entries generated from command meta.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setState } from '../src/app/store.js';
import { FONTS, FONT_SIZES, HIGHLIGHTS, TEXT_COLORS } from '../src/format.mjs';
import { FLOW_PROFILE, grantOptions, PLAN_PROFILE, TEXT_PROFILE } from '../src/tooling/profile.mjs';
import { bindServices, commandOf, ctxOf, register, registered, run, toolEntries } from '../src/tooling/registry.js';
import { activeSurface } from '../src/tooling/surface.js';
import '../src/app/pool.js';

const editor = (undo = true) => ({ state: null, can: () => ({ undo: () => undo, redo: () => false }) });
const open = (format, ed = editor()) => setState({ editor: ed, draft: { format }, view: { type: 'editor' }, settings: {} });
const entry = (id) => toolEntries().find((t) => t.id === id);

test('activeSurface covers the Document, the forum post, the page, the flowchart view and the plan page', () => {
  open('document');
  assert.deepEqual({ ...activeSurface(), editor: !!activeSurface().editor, profile: activeSurface().profile.grants },
    { kind: 'document', editor: true, format: 'document', profile: '*', story: null });
  open('forum-post');
  assert.equal(activeSurface().kind, 'text');
  assert.equal(activeSurface().format, 'forum-post');
  assert.equal(activeSurface().profile, TEXT_PROFILE);
  open('page');
  assert.equal(activeSurface().kind, 'text');
  assert.equal(activeSurface().profile, TEXT_PROFILE);
  setState({ view: { type: 'flows' } });
  assert.deepEqual(activeSurface(), { kind: 'flow', editor: null, format: 'flow', profile: FLOW_PROFILE, story: null });
  setState({ view: { type: 'plan', planId: 'p', tab: 'gantt' } });
  assert.deepEqual(activeSurface(), { kind: 'plan', editor: null, format: 'plan', profile: PLAN_PROFILE, story: null });
  setState({ view: { type: 'browser' } });
  assert.equal(activeSurface(), null);
  setState({ view: { type: 'editor' }, editor: null, draft: null });
  assert.equal(activeSurface(), null);
});

test('the text profile lists the forum values as option lists', () => {
  const fonts = FONTS.map((f) => ({ id: f.label, ...f }));
  assert.deepEqual(grantOptions(TEXT_PROFILE, 'fonts', fonts), fonts);
  assert.deepEqual(grantOptions(TEXT_PROFILE, 'fontSizes', [...FONT_SIZES, 300]), FONT_SIZES);
  assert.deepEqual(grantOptions(TEXT_PROFILE, 'textColors', Object.keys(TEXT_COLORS)), Object.keys(TEXT_COLORS));
  assert.deepEqual(grantOptions(TEXT_PROFILE, 'highlights', [...HIGHLIGHTS, 'pink']), HIGHLIGHTS);
  assert.deepEqual(grantOptions(TEXT_PROFILE, 'other', ['a']), []);
});

test('the ctx carries the surface kind and the bound board and chart', () => {
  const board = { id: 'b' };
  const chart = { view: {} };
  bindServices({ board: () => board, chart: () => chart });
  open('forum-post');
  assert.equal(ctxOf().surface, 'text');
  assert.equal(ctxOf().board, board);
  assert.equal(ctxOf().chart, chart);
  setState({ view: { type: 'plan' } });
  assert.equal(ctxOf().surface, 'plan');
  assert.equal(ctxOf().ed, null);
  bindServices({ board: () => null, chart: () => null });
});

test("Word's commands serve only the Document, even under a prefix the forum post grants", () => {
  register('tool-pool-test-word', { 'insert.links.link.insertLink': { run: () => 'word link' } }, ['document']);
  register('tool-pool-test', { 'insert.tpTest': { run: () => 'pool insert' }, 'home.tpTest': { run: () => 'home' } });
  open('document');
  assert.ok(commandOf('insert.links.link.insertLink'));
  assert.ok(commandOf('insert.tpTest'), "the Document's '*' grants the pool command too");
  open('forum-post');
  assert.equal(commandOf('insert.links.link.insertLink'), null);
  assert.equal(run('insert.links.link.insertLink'), false);
  assert.equal(run('insert.tpTest'), 'pool insert');
  assert.equal(commandOf('home.tpTest'), null, 'a non-granted id');
});

test('a generated entry shows only where granted; a disabled command shows with its reason', () => {
  register('tool-pool-test', {
    'plan.tpShown': { run: () => 'shown', meta: { label: 'Shown' } },
    'plan.tpOff': { run: () => true, enabled: () => false, meta: { label: 'Off' } },
    'plan.tpWhy': { run: () => true, enabled: () => false, reason: () => 'Open the Gantt first', meta: { label: 'Why' } },
    'flow.tpFlow': { run: () => true, meta: { label: 'Flow only' } },
  });
  setState({ view: { type: 'plan' } });
  assert.equal(entry('plan.tpShown').when(), true);
  assert.equal(entry('plan.tpShown').run(), 'shown');
  assert.equal(entry('plan.tpOff').when(), false, 'disabled without a reason: hidden');
  assert.equal(entry('plan.tpWhy').when(), true, 'disabled with a reason: shown');
  assert.equal(entry('plan.tpWhy').notice(), 'Open the Gantt first');
  assert.equal(entry('plan.tpShown').notice(), null);
  assert.equal(entry('flow.tpFlow').when(), false, 'the plan profile does not grant flow.');
  setState({ view: { type: 'flows' } });
  assert.equal(entry('flow.tpFlow').when(), true);
  assert.equal(entry('plan.tpShown').when(), false);
});

test('Undo and Redo: generated entries on text surfaces through the editor, none in a Document', () => {
  open('forum-post');
  assert.equal(entry('edit.undo').when(), true);
  assert.equal(entry('edit.undo').notice(), null);
  assert.equal(entry('edit.redo').notice(), 'There is nothing to redo', 'nothing to redo: shown disabled with the reason');
  assert.equal(entry('edit.undo').key, 'edit.undo');
  open('forum-post', editor(false));
  assert.equal(entry('edit.undo').notice(), 'There is nothing to undo');
  open('document');
  assert.equal(commandOf('edit.undo'), null);
  assert.equal(entry('edit.undo').when(), false);
  setState({ view: { type: 'plan' } });
  assert.equal(entry('edit.undo').when(), false);
});

test("the forum toolset: value commands take only the profile's choices, and none reaches a Document", () => {
  const calls = [];
  const chain = new Proxy({}, { get: (_, k) => (k === 'run' ? () => true : (...args) => (calls.push([k, ...args]), chain)) });
  const ed = { state: { selection: {} }, can: () => ({ undo: () => true, redo: () => false }), chain: () => chain, isActive: () => false, getAttributes: () => ({}) };
  open('forum-post', ed);
  assert.equal(run('text.size', 160), false, 'not a forum size');
  assert.equal(run('text.size', '150%'), true);
  assert.deepEqual(calls.at(-1), ['setFontSize', 150]);
  assert.equal(run('text.font', 'Comic Sans'), false, 'not a forum font');
  run('text.font', 'Andalé Mono');
  assert.deepEqual(calls.at(-1), ['setFontFamily', 'Andale Mono'], 'a font id is its label; the mark keeps its CSS name');
  run('text.color', 'red');
  assert.deepEqual(calls.at(-1), ['setTextColor', 'red']);
  run('text.color', 'root');
  assert.deepEqual(calls.at(-1), ['unsetTextColor'], 'Default clears the colour');
  assert.equal(run('text.highlight', 'pink'), false);
  assert.equal(run('para.align', 'middle'), false);
  assert.equal(entry('text.color').when(), true);
  assert.equal(entry('para.align'), undefined, 'per-value commands keep their hand entries');
  open('document', ed);
  assert.ok(['text.bold', 'text.font', 'para.align', 'insert.table', 'table.deleteRow'].every((id) => commandOf(id) === null));
});

test('every command with meta has a label', () => {
  const entries = toolEntries();
  assert.ok(entries.length >= 2);
  for (const t of entries) assert.ok(typeof t.label === 'string' && t.label.trim(), t.id);
  assert.ok(entries.every((t) => registered().includes(t.id)));
});

test("agents see the forum toolset in tool.list and run it by the old ids ('canvas' is insert.canvas)", async () => {
  const { bindTools, defs } = await import('../src/app/commands/tool.mjs');
  const { TOOL_ALIASES } = await import('../src/app/pool.js');
  const calls = [];
  const chain = new Proxy({}, { get: (_, k) => (k === 'run' ? () => true : (...args) => (calls.push([k, ...args]), chain)) });
  const ed = { state: { selection: {} }, can: () => ({ undo: () => true, redo: () => false }), chain: () => chain, isActive: () => false, getAttributes: () => ({}) };
  open('forum-post', ed);
  // The forum's hand entry 'canvas' as app/tools.js keeps it: it gives way where insert.canvas serves.
  const hand = { id: 'canvas', label: 'Insert canvas (hand)', group: 'Insert', when: () => !commandOf('insert.canvas'), run: () => 'hand' };
  bindTools({ context: () => ({}), all: () => [hand, ...toolEntries()], failedNeeds: () => [], command: () => null, aliases: TOOL_ALIASES });
  const cmd = (id) => defs.find((d) => d.id === id);
  let asked = null;
  const ctx = { source: 'agent:test', policy: { read: 'allow', write: 'ask', destructive: 'ask' }, ask: async (what) => { asked = what; return false; } };

  const list = cmd('tool.list').run(ctx, {});
  const ids = list.map((t) => t.id);
  assert.ok(ids.includes('insert.canvas') && ids.includes('text.bold'), ids.join(' '));
  assert.equal(list.find((t) => t.id === 'insert.canvas').alias, 'canvas');
  assert.equal(list.find((t) => t.id === 'insert.image').headless, false, 'a file picker needs the user');

  await assert.rejects(cmd('tool.run').run(ctx, { id: 'canvas' }), { code: 'denied' });
  assert.equal(asked, 'run the tool "Insert canvas"', "the old id runs insert.canvas, not the hand entry that gave way");

  const allow = { ...ctx, policy: { ...ctx.policy, write: 'allow' } };
  assert.deepEqual(await cmd('tool.run').run(allow, { id: 'color', arg: 'red' }), { id: 'text.color' });
  assert.deepEqual(calls.at(-1), ['setTextColor', 'red'], 'the arg reaches run(id, arg)');
  await assert.rejects(cmd('tool.run').run(allow, { id: 'text.color', arg: 'mauve' }), { code: 'failed' });
});

// engine-surface (docs/plans/engine/viewport-design.md section 4.7, P5): the tools follow the focused canvas draft. The active
// surface carries its SessionClient, the registry routes tooling ids through the Documents table to engine commands, a granted
// command with no row shows disabled with its reason, a command outside the grant is absent, and the ribbon's state is a
// state(ids) snapshot refreshed per selection change. A fake session with the SessionClient's exec, state and on stands in for
// engine-host's (the harness case engine-surface runs the real one in the page area).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setState } from '../src/app/store.js';
import { DOCUMENT } from '../src/formats.mjs';
import { CORE, ENGINE_COMMANDS } from '../src/document/canvas/commands.mjs';
import { WORD_KEYS } from '../src/document/word/keymap.mjs';
import * as SPEC from '../src/document/ribbon/spec.mjs';
import { SessionClient } from '../src/engine/client.js';
import { TEXT_PROFILE } from '../src/tooling/profile.mjs';
import { REASONS } from '../src/tooling/reasons.mjs';
import { bindServices, commandOf, ctxOf, galleryOf, panelOf, registerModule, run, toolEntries } from '../src/tooling/registry.js';
import { activeSurface } from '../src/tooling/surface.js';

const toasts = [];
bindServices({ toast: (t) => toasts.push(t) });
const DOM = { state: null }; // the DOM editor under the canvas
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A SessionClient's tool calls: exec and state record what they get; emit fires a worker event. */
function fakeSession(states = {}) {
  const calls = [];
  const handlers = {};
  return {
    calls,
    states,
    exec: async (id, args) => (calls.push(['exec', id, args]), { ok: true, changed: true }),
    execAs: async (author, tag, steps) => (calls.push(['execAs', author, tag, steps]), { ok: true, changed: true, value: steps.map(() => null), revisions: [0] }),
    state: async (ids) => (calls.push(['state', ids]), Object.fromEntries(ids.map((id) => [id, states[id] ?? { enabled: true, reason: null, checked: false, value: null }]))),
    on: (event, fn) => ((handlers[event] ??= new Set()).add(fn), () => handlers[event].delete(fn)),
    emit: (event) => handlers[event]?.forEach((fn) => fn({})),
    handlers,
  };
}

const doc = (focusedSession = null, format = 'document') => setState({ editor: DOM, draft: { format }, view: { type: 'editor' }, settings: {}, focusedSession });

// Word's DOM commands as base and a package register them, and the canvas module with its table, as the hub does.
const dom = (name) => ({ run: () => `dom ${name}`, active: () => 'dom' });
registerModule({ id: 'base', commands: { 'home.font.bold': dom('bold'), 'insert.illustrations.3DModels': dom('underline'), 'home.paragraph.center': dom('center'),
  'frame.titleBar.search': dom('search') }, galleries: { 'home.styles.styles': () => [{ id: 'Normal' }] }, panels: { colors: () => null } }, ['document']);
registerModule({ id: 'canvas-engine', engine: ENGINE_COMMANDS,
  commands: { 'view.canvasEngine': { run: () => 'switch', meta: { label: 'Canvas engine' } }, 't.meta': { run: () => 'meta', meta: { label: 'Meta' } } } }, ['document']);

test('the table names engine commands the engine registers', () => {
  const dir = fileURLToPath(new URL('../engine/crates/doc-edit/src/', import.meta.url));
  const rust = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.rs')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  // That each row's tooling id is registered (a Word command or a Word key's) is the harness case engine-surface's check: it
  // reads the app's registry, which loads Word's modules (their dialogs are .jsx, which node does not load).
  for (const row of Object.values(ENGINE_COMMANDS)) {
    const eid = typeof row === 'string' ? row : row?.exec; // an engine id or an exec row (rows/forms.mjs); APP, off and specs name none
    if (eid) assert.ok(rust.includes(`CommandSpec::new("${eid}"`), `${eid} is an engine command`);
  }
});

test('the fake session has the SessionClient calls the registry uses', () => {
  for (const call of ['exec', 'state', 'on']) assert.equal(typeof SessionClient.prototype[call], 'function', call);
});

test('activeSurface gives the focused canvas draft its session and no editor; the DOM path is unchanged', () => {
  const session = fakeSession();
  doc();
  assert.equal(activeSurface().editor, DOM);
  assert.equal('session' in activeSurface(), false);
  doc(session);
  assert.deepEqual(activeSurface(), { kind: 'document', editor: null, format: 'document', profile: DOCUMENT.profile, session, story: null });
  setState({ editor: null });
  assert.equal(activeSurface()?.session, session, 'the canvas draft needs no DOM editor');
  doc(session, 'forum-post');
  assert.deepEqual(activeSurface(), { kind: 'text', editor: null, format: 'forum-post', profile: TEXT_PROFILE, session, story: null },
    'a forum post on the engine is the text surface, with the page area session');
  setState({ focusedSession: null });
  assert.equal(activeSurface().editor, DOM, 'without it, the DOM post editor is the surface');
  setState({ view: { type: 'browser' } });
  assert.equal(activeSurface(), null);
  doc();
});

test('on a canvas draft the table runs engine commands, an unlisted granted command is disabled with its reason', async () => {
  const session = fakeSession();
  doc(session);
  await settle();
  const ctx = ctxOf();
  assert.equal(ctx.engine.id, session.id, 'the session, as an agent press sees it (registry.js agentEngine)');
  assert.equal(ctx.engine.calls, session.calls);
  assert.equal(ctx.ed, null);
  assert.equal(ctx.target, null);
  const bold = commandOf('home.font.bold');
  assert.notEqual(bold.run, dom('bold').run);
  assert.equal(commandOf('home.font.bold'), bold, 'one spec object per engine command');
  await run('home.font.bold');
  await run('home.paragraph.center');
  assert.deepEqual(session.calls.filter((c) => c[0] === 'exec'), [['exec', 'format.bold', {}], ['exec', 'para.alignCenter', {}]]);
  // An agent's press (commands.js gives svc.agentInput while it arrives) runs the same command as one execAs: its tracked change.
  bindServices({ agentInput: () => ({ author: 'Assistant', tag: 'g1' }) });
  await run('home.font.bold');
  bindServices({ agentInput: () => null });
  assert.deepEqual(session.calls.filter((c) => c[0] === 'execAs'), [['execAs', 'Assistant', 'g1', [['format.bold', {}]]]]);
  assert.equal(session.calls.filter((c) => c[0] === 'exec').length, 2);

  const underline = commandOf('insert.illustrations.3DModels');
  assert.equal(underline.enabled(ctx), false);
  assert.equal(underline.reason(ctx), REASONS.engine);
  assert.equal(run('insert.illustrations.3DModels'), false);
  assert.equal(commandOf('view.canvasEngine').run(), 'switch', 'an APP row runs as registered');
  assert.equal(commandOf('frame.titleBar.search').run(), 'dom search');

  toasts.length = 0;
  assert.equal(commandOf('t.none'), null);
  assert.equal(run('t.none'), false);
  assert.deepEqual(toasts, [REASONS.pending], 'an unregistered id is still a placeholder');
  assert.deepEqual(galleryOf('home.styles.styles'), [], 'galleries wait for their engine commands');
  assert.equal(panelOf('colors'), null);

  const meta = toolEntries().find((t) => t.id === 't.meta');
  assert.equal(meta.when(), true);
  assert.equal(meta.notice(), REASONS.engine, 'tool search shows it disabled with the reason');

  doc();
  assert.equal(commandOf('home.font.bold').run(), 'dom bold', 'without a focused session the DOM command runs');
  assert.equal(commandOf('insert.illustrations.3DModels').run(), 'dom underline');
  assert.deepEqual(galleryOf('home.styles.styles').map((g) => g.id), ['Normal']);
  assert.ok(panelOf('colors'));
});

test('a command outside the focused format grant is absent on a canvas draft', () => {
  const was = DOCUMENT.profile.grants;
  DOCUMENT.profile.grants = { commands: ['home.paragraph', 'view.'], options: {} };
  try {
    doc(fakeSession());
    assert.equal(commandOf('home.font.bold'), null);
    assert.equal(commandOf('insert.illustrations.3DModels'), null);
    assert.ok(commandOf('home.paragraph.center'));
    assert.equal(toolEntries().find((t) => t.id === 't.meta').when(), false);
    assert.equal(toolEntries().find((t) => t.id === 'view.canvasEngine').when(), true);
  } finally {
    DOCUMENT.profile.grants = was;
    doc();
  }
});

test('the ribbon state is a state(ids) snapshot per selection change, one call in flight, read back after a command', async () => {
  const session = fakeSession({ 'format.bold': { enabled: true, reason: null, checked: true, value: null } });
  doc(session);
  await settle();
  const states = () => session.calls.filter((c) => c[0] === 'state');
  // The first read holds the selection context and every engine id the table's rows read, so the first listing is right.
  assert.equal(states().length, 1);
  const first = states()[0][1];
  assert.equal(first[0], 'document.context', 'the focus reads the selection context');
  assert.ok(['format.bold', 'format.italic', 'para.alignCenter'].every((id) => first.includes(id)), 'the engine ids of the rows are read at once');
  assert.equal(commandOf('home.font.bold').active(ctxOf()), true, 'a control reads the first read at once');
  // Later reads ask only for the ids the drawn controls read since (the state call runs on every key), which join it then.
  commandOf('home.font.italic').active(ctxOf());
  await settle();
  assert.deepEqual(states().map((c) => c[1]).slice(1), [['document.context', 'format.bold', 'format.italic']]);
  const ctx = ctxOf();
  assert.equal(commandOf('home.font.bold').active(ctx), true);
  assert.equal(commandOf('home.font.italic').active(ctx), false);

  session.states['format.bold'] = { enabled: false, reason: 'The document is protected.', checked: false, value: null };
  session.emit('selection');
  session.emit('selection');
  session.emit('layout');
  await settle();
  assert.equal(states().length, 3, 'events while a call runs need no other: the worker answers in order, so the call sees them');
  const after = ctxOf();
  assert.notEqual(after, ctx, 'a changed snapshot gives the ctx readers a new ctx');
  assert.equal(commandOf('home.font.bold').enabled(after), false);
  assert.equal(commandOf('home.font.bold').reason(after), 'The document is protected.');

  session.emit('selection');
  await settle();
  assert.equal(ctxOf(), after, 'an unchanged snapshot re-renders nothing');
  await run('home.font.italic');
  await settle();
  assert.equal(states().length, 5, 'a command reads the state back: a caret format change moves nothing');
  session.emit('command');
  await settle();
  assert.equal(states().length, 6, "a command run elsewhere (the page area's Ctrl+B) reads the state again");

  doc();
  assert.equal(Object.values(session.handlers).reduce((n, s) => n + s.size, 0), 0, 'losing the focus stops listening');
});

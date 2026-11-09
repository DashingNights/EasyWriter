// engine-cmd-scaffold (docs/plans/engine/stage2.md, the Stage 2.0 scaffold): what the six stage-2 packages share. The row tables
// never share a key and hold only the row forms; the registry turns each form into a command on a canvas draft (exec with its
// params and state reading, off with its reason, a CommandSpec as it is, a 'prefix.*' row for a pool), reads ctx.read through the
// session's query and follows document.context for the surface's story; galleries and panels flagged engine: true serve a canvas
// draft; a Word key with no BINDS row runs through the registry; and the engine answers document.context, document.settings,
// execMany as one undo step, query (pure commands only), save as txt and html, and picture.data. A fake session stands in for
// the SessionClient in the registry checks; the engine checks run the real WebAssembly in process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setState } from '../src/app/store.js';
import { CORE, ENGINE_COMMANDS } from '../src/document/canvas/commands.mjs';
import { CHARTS } from '../src/document/canvas/rows/charts.mjs';
import { APP, exec, formOf, off } from '../src/document/canvas/rows/forms.mjs';
import { HOME } from '../src/document/canvas/rows/home.mjs';
import { OBJECTS } from '../src/document/canvas/rows/objects.mjs';
import { PAGE } from '../src/document/canvas/rows/page.mjs';
import { REFERENCES } from '../src/document/canvas/rows/references.mjs';
import { REVIEW } from '../src/document/canvas/rows/review.mjs';
import { SMART_ART } from '../src/document/canvas/rows/smart-art.mjs';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { createKeymap } from '../src/engine/input/keys.mjs';
import { Engine, initSync } from '../src/engine/wasm/ew.js';
import { commandOf, ctxOf, galleryOf, keyCommand, keyHolds, panelOf, registerModule, run } from '../src/tooling/registry.js';
import { activeSurface } from '../src/tooling/surface.js';

const J = JSON.parse;
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

test('the eight row tables never share a key, and every row is one of the forms', () => {
  const seen = new Map();
  for (const [name, rows] of Object.entries({ CORE, HOME, OBJECTS, PAGE, REFERENCES, REVIEW, CHARTS, SMART_ART })) {
    for (const [id, row] of Object.entries(rows)) {
      assert.ok(!seen.has(id), `${id} is in both ${seen.get(id)} and ${name}`);
      seen.set(id, name);
      assert.ok(formOf(row), `${name}'s ${id} is a row form`);
    }
  }
  const wild = [...seen.keys()].filter((k) => k.endsWith('.*')).map((k) => k.slice(0, -1));
  for (const id of seen.keys()) if (!id.endsWith('.*')) assert.ok(!wild.some((w) => id.startsWith(w)), `${id} falls under a '.*' row`);
  assert.equal(Object.keys(ENGINE_COMMANDS).length, seen.size);
  assert.deepEqual([formOf('format.bold'), formOf(APP), formOf(exec('format.bold')), formOf(off('Why.')), formOf({ run() {} }), formOf({}), formOf('')],
    ['engine', 'app', 'exec', 'off', 'spec', null, null]);
});

/** The SessionClient calls the registry uses: exec, execMany, query and state record what they get; emit fires a worker event. */
function fakeSession() {
  const calls = [];
  const handlers = {};
  const states = {};
  const answers = {};
  return {
    calls,
    states,
    answers,
    exec: async (id, args) => (calls.push(['exec', id, args]), { ok: true, changed: true }),
    execMany: async (steps) => (calls.push(['execMany', steps]), { ok: true, changed: true }),
    query: async (id, args) => (calls.push(['query', id, args]), { ok: true, value: answers[id] ?? null }),
    state: async (ids) => (calls.push(['state', ids]), Object.fromEntries(ids.map((id) => [id, states[id] ?? { enabled: true, reason: null, checked: false, value: null }]))),
    on: (event, fn) => ((handlers[event] ??= new Set()).add(fn), () => handlers[event].delete(fn)),
    emit: (event) => handlers[event]?.forEach((fn) => fn({})),
  };
}

const DOM = { state: null }; // the DOM editor (no canvas draft focused)
const doc = (focusedSession = null) => setState({ editor: focusedSession ? null : DOM, draft: { format: 'document' }, view: { type: 'editor' }, settings: {}, focusedSession });
const both = (fn) => Object.assign(fn, { engine: true });
const composite = { run: (ctx) => ctx.engine.execMany([['insert.textBox', {}], ['shape.alignText', { anchor: 'ctr' }]]), enabled: () => true };
registerModule({ id: 'base', commands: { 'x.app': { run: () => 'app' }, 'x.gap': { run: () => 'dom' }, 'x.none': { run: () => 'dom' }, 'board.pen': { run: () => 'pen' } },
  galleries: { 'g.dom': () => [{ id: 'dom' }], 'g.both': both(() => [{ id: 'both' }]) }, panels: { dom: () => null, both: both(() => null) } }, ['document']);
registerModule({ id: 'canvas-engine', engine: {
  'x.app': APP, 'board.*': APP, 'x.gap': off('Needs the theme query.'), 'x.bold': 'format.bold', 'x.composite': composite,
  'x.style': exec('para.style', (arg) => ({ style: arg }), { state: 'para.style', value: (e) => e?.value?.toLowerCase() ?? null }),
  'x.fixed': exec('format.underline', { style: 'double' }),
  'x.when': exec('format.bold', undefined, { when: (ctx) => (ctx.in?.table ? null : 'Put the caret in a table first.') }),
} }, ['document']);

test('the registry runs each row form on a canvas draft', async () => {
  const s = fakeSession();
  doc(s);
  await settle();
  const ctx = ctxOf();
  assert.equal(commandOf('x.app').run(), 'app', 'an APP row runs as registered');
  assert.equal(commandOf('board.pen').run(), 'pen', "a 'board.*' row covers the pool");
  assert.equal(commandOf('x.gap').enabled(ctx), false);
  assert.equal(commandOf('x.gap').reason(ctx), 'Needs the theme query.');
  assert.equal(commandOf('x.none').reason(ctx), 'Not built for the canvas engine yet.', 'no row: the generic reason');
  assert.equal(commandOf('x.composite'), composite, "a CommandSpec row is itself");
  assert.equal(commandOf('x.style'), commandOf('x.style'), 'one spec object per row');

  await run('x.style', 'Heading1');
  await run('x.fixed', 'ignored');
  await run('x.bold');
  const execs = s.calls.filter((c) => c[0] === 'exec').map((c) => c.slice(1));
  assert.deepEqual(execs, [['para.style', { style: 'Heading1' }], ['format.underline', { style: 'double' }], ['format.bold', {}]]);

  s.states['para.style'] = { enabled: true, reason: null, checked: null, value: 'Heading1' };
  s.emit('selection'); // the run above read it before the change: the next selection event reads it again
  await settle();
  assert.equal(commandOf('x.style').value(ctxOf()), 'heading1', 'value maps the snapshot entry');
  assert.ok(s.calls.filter((c) => c[0] === 'state').at(-1)[1].includes('para.style'));
  assert.equal(commandOf('x.when').enabled(ctxOf()), false);
  assert.equal(commandOf('x.when').reason(ctxOf()), 'Put the caret in a table first.');

  const before = s.calls.filter((c) => c[0] === 'state').length;
  await run('x.composite');
  assert.deepEqual(s.calls.find((c) => c[0] === 'execMany')[1], [['insert.textBox', {}], ['shape.alignText', { anchor: 'ctr' }]]);
  assert.equal(s.calls.filter((c) => c[0] === 'state').length, before + 1, 'a CommandSpec row reads the state back after it');

  assert.deepEqual(galleryOf('g.dom'), [], 'a provider that reads the DOM editor waits');
  assert.deepEqual(galleryOf('g.both').map((g) => g.id), ['both']);
  assert.equal(panelOf('dom'), null);
  assert.ok(panelOf('both'));
  doc();
  assert.equal(commandOf('x.gap').run(), 'dom', 'the DOM path is unchanged');
  assert.deepEqual(galleryOf('g.dom').map((g) => g.id), ['dom']);
  assert.ok(panelOf('dom'));
});

test('ctx.read asks the session once per layout, and document.context gives the surface its story', async () => {
  const s = fakeSession();
  s.answers['document.settings'] = { themeName: 'Office' };
  doc(s);
  await settle();
  assert.equal(ctxOf().read('document.settings'), null, 'null until the engine answers');
  await settle();
  const ctx = ctxOf();
  assert.deepEqual(ctx.read('document.settings'), { themeName: 'Office' }, 'then the readers re-render with it');
  ctx.read('document.settings');
  assert.equal(s.calls.filter((c) => c[0] === 'query').length, 1, 'cached');
  s.answers['document.settings'] = { themeName: 'Retrospect' };
  s.emit('layout');
  await new Promise((r) => setTimeout(r, 150)); // read again once typing pauses
  await settle();
  assert.deepEqual(ctxOf().read('document.settings'), { themeName: 'Retrospect' });

  assert.equal(activeSurface().story, null);
  assert.equal(ctxOf().story, 'body');
  s.states['document.context'] = { enabled: true, reason: null, checked: null, value: { story: { kind: 'header', id: 3 }, equation: false } };
  s.emit('selection');
  await settle();
  assert.deepEqual(activeSurface().story, { kind: 'header', editor: null });
  assert.equal(ctxOf().story, 'header');
  assert.equal(ctxOf().engineState['document.context'].value.story.id, 3);
  s.states['document.context'] = { enabled: true, reason: null, checked: null, value: { story: { kind: 'body', id: null }, equation: true } };
  s.emit('selection');
  await settle();
  assert.equal(ctxOf().story, 'equation');
  doc();
  assert.equal(ctxOf().read('document.settings'), null);
  assert.deepEqual(ctxOf().engineState, {});
});

test('a Word key with no BINDS row runs its command through the registry, in its context', () => {
  const defs = [
    { id: 'word.x.go', scope: 'document', cmd: 'x.go', arg: 7, rows: [{ chord: 'Ctrl+K' }] },
    { id: 'word.home.font.bold', scope: 'document', cmd: 'home.font.bold', rows: [{ chord: 'Ctrl+Shift+B' }] },
    { id: 'word.x.outline', scope: 'document', cmd: 'x.outline', rows: [{ chord: 'Alt+Up', when: 'outline' }] },
    { id: 'word.x.cell', scope: 'document', cmd: 'x.cell', rows: [{ chord: 'Alt+Up', when: 'table' }] },
    { id: 'word.x.home', scope: 'document', cmd: 'x.home', rows: [{ chord: 'Home', when: 'table', fallthrough: true }] },
    { id: 'word.x.accent', scope: 'document', cmd: 'x.accent', rows: [{ chord: "Ctrl+'", prefix: true }] },
  ];
  const among = (ids, e) => ids.find((id) => defs.find((d) => d.id === id)?.rows.some((r) => r.chord === e.chord)) ?? null;
  const ran = [];
  const held = new Set();
  let cellRuns = true;
  const keymap = createKeymap({ defs, among, chordOf: (e) => e.chord, isMac: () => false, holds: (w) => held.has(w),
    tool: (cmd, arg, row) => (row?.fallthrough && !cellRuns ? null : () => ran.push([cmd, arg])) });
  const key = (chord) => keymap({ chord, shiftKey: chord.includes('Shift') });

  key('Ctrl+K').run();
  assert.deepEqual(ran, [['x.go', 7]]);
  key('Ctrl+Shift+B').run();
  assert.deepEqual(ran.at(-1), ['home.font.bold', undefined], 'Bold has no BINDS row since stage 2.6: the table maps it');
  ran.pop();
  assert.equal(key('Alt+Up'), null, 'a row whose context does not hold takes no key');
  held.add('table');
  key('Alt+Up').run();
  held.clear();
  held.add('outline');
  key('Alt+Up').run();
  assert.deepEqual(ran.slice(1), [['x.cell', undefined], ['x.outline', undefined]]);
  held.add('table');
  cellRuns = false;
  assert.deepEqual(key('Home'), { call: 'exec', args: ['caret.home', { extend: false }] }, 'a fallthrough row that cannot run leaves the key to the caret');
  key("Ctrl+'").run();
  assert.deepEqual(ran.at(-1), ['x.accent', "Ctrl+'"], 'an accent prefix passes the chord');
});

test('keyCommand and keyHolds follow the focused canvas draft', async () => {
  doc(fakeSession());
  await settle();
  assert.equal(typeof keyCommand('x.gap'), 'function', 'a key runs a disabled command as WordKeys does (it says nothing)');
  assert.equal(keyCommand('x.gap', undefined, { fallthrough: true }), null, 'a fallthrough row that cannot run lets the key go on');
  assert.equal(typeof keyCommand('x.bold', undefined, { fallthrough: true }), 'function');
  assert.equal(keyHolds(undefined), true);
  assert.equal(keyHolds('window'), true);
  assert.equal(keyHolds('table'), false);
  doc();
});

// ---------- The engine (the real WebAssembly, in process) ----------
const WASM = new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

test('the engine answers document.context, document.settings, execMany, query, txt and html saves and picture.data', { skip: !fs.existsSync(WASM) && 'no built engine (npm run build)' }, async () => {
  initSync({ module: fs.readFileSync(WASM) });
  await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
  const e = new Engine();
  const text = () => new TextDecoder().decode(e.save('txt')).trim();
  assert.ok(J(e.exec('text.insert', JSON.stringify({ text: 'One' }))).ok);

  const st = J(e.state(JSON.stringify(['document.context', 'document.settings', 'format.bold'])));
  assert.deepEqual(st['document.context'].value.story, { kind: 'body', id: null });
  assert.equal(st['document.context'].value.table, null);
  assert.equal(st['document.settings'].value.themeColors.length, 12);
  assert.equal(st['document.settings'].value.protectHash, undefined);
  assert.equal(st['format.bold'].checked, false, 'the host table still answers the ids without a spec state');

  const many = J(e.execMany(JSON.stringify([['text.newParagraph'], ['text.insert', { text: 'Two' }]])));
  assert.ok(many.ok && many.changed && many.value.length === 2, JSON.stringify(many));
  assert.match(text(), /^One\r?\nTwo$/);
  J(e.undo());
  assert.equal(text(), 'One', 'one undo step');
  const bad = J(e.execMany(JSON.stringify([['text.insert', { text: ' more' }], ['no.such', {}]])));
  assert.equal(bad.ok, false);
  assert.equal(bad.step, 1);
  assert.equal(text(), 'One', 'a failed step takes the steps before it back');

  const refused = J(e.query('text.insert', JSON.stringify({ text: 'x' })));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not a query/);
  assert.equal(text(), 'One');
  assert.equal(J(e.query('document.context', '{}')).value.story.kind, 'body');
  assert.match(new TextDecoder().decode(e.save('html')), /<[a-z][\s\S]*One/i);

  assert.ok(J(e.exec('insert.picture', JSON.stringify({ data: PNG }))).ok);
  assert.ok(J(e.exec('select.objects', JSON.stringify({ index: 0 }))).ok);
  assert.equal(J(e.state(JSON.stringify(['document.context'])))['document.context'].value.object.kind, 'picture');
  const pic = J(e.exec('picture.data', '{}'));
  assert.deepEqual(pic.value, { mime: 'image/png', base64: pic.value.base64 });
  assert.equal(Buffer.from(pic.value.base64, 'base64').subarray(1, 4).toString(), 'PNG');
});

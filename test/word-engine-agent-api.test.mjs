// engine-agent-api (docs/plans/word/briefs/engine-agent-api.md, docs/plans/engine/stage2b.md decisions 4 and 5): the engine calls
// the assistant needs on a canvas draft, through the built WebAssembly as the worker calls them. execAs runs steps as one undo step
// tracked as changes by the assistant with a suggestion group, while the user's author, Track Changes and caret stay theirs;
// review.changes and review.resolve work by revision id; the pure reads move nothing. The worker's quiet sessions and a key typed
// while an execAs waits run in the harness case (.smoke-data/word/cases/engine-agent-api.js); the host's side of quiet is here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const s = JSON.stringify;

/** An engine holding `text`, written by the user 'Kelvin' with Track Changes off. */
function draft(text) {
  const e = new Engine();
  e.exec('file.setAuthor', s({ name: 'Kelvin' }));
  e.insertText(text);
  return e;
}
const query = (e, id, args = {}) => J(e.query(id, s(args))).value;
const outline = (e) => query(e, 'document.outline');
const changes = (e) => query(e, 'review.changes');
const text = (e) => new TextDecoder().decode(e.save('txt')).replace(/\r?\n$/, '');

test('execAs makes tracked changes by the assistant in one undo step, and the user stays untracked under their name', () => {
  const e = draft('Hello world');
  const { rev, paragraphs: [p] } = outline(e);
  const r = J(e.execAs('Assistant', 'g1', s([['select.at', { para: p.para, from: 5 }], ['text.insert', { text: ' big' }]]), rev));
  assert.ok(r.ok && r.changed, r.error);
  assert.deepEqual(r.revisions, [0]);
  assert.equal(r.rev, outline(e).rev);
  // The caret is where the user left it, at the end: their next key is theirs, untracked.
  e.insertText('!');
  assert.equal(text(e), 'Hello big world!');
  const ch = changes(e);
  assert.deepEqual(ch.map((c) => [c.kind, c.author, c.tag, c.rev, c.text]), [['insert', 'Assistant', 'g1', 0, ' big']]);
  assert.equal(J(e.state(s(['review.trackChanges'])))['review.trackChanges'].checked, false, 'Track Changes stays off');
  assert.deepEqual(outline(e).paragraphs[0].tags, ['g1']);
  // Undo takes the user's key, then the whole call; tracking stays off.
  J(e.undo());
  J(e.undo());
  assert.equal(text(e), 'Hello world');
  assert.equal(J(e.state(s(['review.trackChanges'])))['review.trackChanges'].checked, false);
  e.free();
});

test('a stale or untracked execAs is refused and changes nothing', () => {
  const e = draft('Hello');
  const { rev } = outline(e);
  e.insertText('x');
  const stale = J(e.execAs('Assistant', null, s([['text.insert', { text: 'y' }]]), rev));
  assert.ok(!stale.ok && !stale.changed && /stale/.test(stale.error), s(stale));
  const untracked = J(e.execAs('Assistant', null, s([['text.insert', { text: 'y' }], ['document.setText', { text: 'gone' }]])));
  assert.ok(!untracked.ok && untracked.step === 1, s(untracked));
  assert.deepEqual(untracked.revisions, []);
  assert.equal(text(e), 'Hellox');
  e.free();
});

test('review.resolve accepts one call\'s changes by revision id and leaves the caret', () => {
  const e = draft('one two');
  const id = outline(e).paragraphs[0].para;
  const a = J(e.execAs('Assistant', 'g', s([['select.at', { para: id, from: 3 }], ['text.insert', { text: ' A' }]])));
  const b = J(e.execAs('Assistant', 'g', s([['select.at', { para: id }], ['text.insert', { text: 'B ' }]])));
  assert.notDeepEqual(a.revisions, b.revisions, 'two calls never share a revision');
  const caret = J(e.selection());
  assert.ok(J(e.exec('review.resolve', s({ accept: true, revs: a.revisions }))).ok);
  assert.deepEqual(changes(e).map((c) => c.rev), b.revisions);
  assert.deepEqual(J(e.selection()), caret);
  assert.ok(J(e.exec('review.resolve', s({ accept: false, revs: b.revisions }))).ok);
  assert.equal(text(e), 'one A two');
  e.free();
});

test('the pure reads leave the selection, copy nothing, and count UTF-16 units', () => {
  const e = draft('Find me \u{1F600} here');
  e.exec('edit.find', s({ text: 'me' }));
  const sel = e.selection();
  const m = query(e, 'document.find', { text: 'here' }).matches[0];
  assert.deepEqual([m.from, m.to, m.text], [11, 15, 'here']);
  assert.match(query(e, 'document.html', { para: m.para }).html, /Find me/);
  assert.equal(outline(e).paragraphs[0].text, 'Find me \u{1F600} here');
  assert.equal(e.selection(), sel);
  assert.equal(new TextDecoder().decode(e.copy('text')), 'me', 'the selection the user had');
  e.free();
});

class FakeWorker {
  static all = [];
  sent = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m) {
    this.sent.push(m);
    if (m.id) queueMicrotask(() => this.onmessage({ data: { id: m.id, result: true } }));
  }
  emit(event, data, session) {
    this.onmessage({ data: { event, data, session } });
  }
  terminate() {}
}

test('a quiet session is quiet again, before its open, after a crash', async () => {
  globalThis.Worker = FakeWorker;
  const { EngineHost } = await import('../src/engine/client.js');
  FakeWorker.all.length = 0;
  const host = new EngineHost(new URL('file:///worker.js'), { fonts: false });
  const [a, b] = [host.session('a'), host.session('b')];
  await a.quiet(true);
  await a.open(new Uint8Array(1), 'engine');
  await b.open(new Uint8Array(1), 'engine');
  FakeWorker.all[0].emit('crash', { message: 'boom' });
  assert.deepEqual(FakeWorker.all[1].sent.map((m) => `${m.session} ${m.method}`), ['a quiet', 'a open', 'b open']);
  host.terminate();
});

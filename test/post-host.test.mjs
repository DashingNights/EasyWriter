// C1 post-host (docs/plans/engine/stage3-forum.md section 3): a forum post's page on the engine. postSource opens a DOM post as
// the post kind with the page's width and padding and the settings' base font and size around its doc; a canvas post's saved form
// is wrapped again the same way; checkPost refuses a post the engine's writer would not give back as it is (one stays in the DOM
// editor); postWindow is the DOM page's card in points; and the engine hosts posts only when its switch is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { DOCUMENT, PAGE, formatOf } from '../src/formats.mjs';
import forum from '../src/integrations/forum/manifest.mjs';
import { checkPost, isPost, postSource, postWindow, postsOn } from '../src/document/canvas/post.js';
import { saveOnce } from '../src/engine/model/autosave.mjs';
import { openEditor } from '../src/tooling/surface.js';
import { FORM, POST_FORM, VERSION, adopt, sourceOf, unreadable } from '../src/engine/model/form.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));

const DIR = new URL('./fixtures/posts/', import.meta.url);
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(name, DIR), 'utf8'));
const bytesOf = (source) => JSON.parse(new TextDecoder().decode(source.bytes));

/** A client as session.js has (a SessionClient's save): the engine writes its kind. */
const clientOf = (engine) => ({ save: async (kind) => engine.save(kind) });

test('postWindow is the post page card in points: its width and padding, the text inside', () => {
  const w = postWindow({}, { format: 'forum-post' });
  assert.ok(Math.abs(w.web - (1454 + 2 * 22) * 0.75) < 1e-6, `${w.web} is the 1454 px page plus its 22 px padding`);
  assert.ok(Math.abs(w.margin - 22 * 0.75) < 1e-6, `${w.margin} is the page's padding`);
  const narrow = postWindow({ pageWidth: 1200 }, { format: 'page' });
  assert.ok(Math.abs(narrow.web - (1200 + 2 * 22) * 0.75) < 1e-6);
});

test('postSource opens a DOM post as the post kind, with its page and base text around the doc', () => {
  const doc = fixture('marks.json');
  const source = postSource({ format: 'forum-post', doc }, { pageWidth: 1200, baseFont: 'Arial', baseSize: 125 });
  assert.equal(source.kind, 'post');
  assert.deepEqual(source.dropped, []);
  const body = bytesOf(source);
  assert.deepEqual(body.doc, doc);
  assert.equal(body.width, 1200 + 2 * 22, 'the card width the post is laid out at (its padding each side of the page)');
  assert.equal(body.pad, 22, 'the page padding');
  assert.deepEqual(body.base, { font: 'Arial', size: 125 }, 'the settings base font and size');
  assert.deepEqual(bytesOf(postSource({ format: 'forum-post', doc }, {})).base, { font: '', size: 100 });
});

test('postSource turns an old whiteboard into a canvas first', () => {
  const doc = { type: 'doc', content: [{ type: 'whiteboard', attrs: { bg: 'post', width: 800, height: 400, items: [] } }] };
  const body = bytesOf(postSource({ format: 'forum-post', doc }, {}));
  assert.equal(body.doc.content[0].type, 'canvas');
  assert.equal(body.doc.content[0].attrs.w, 1454, 'a canvas takes at least the page width');
});

test("postSource wraps a canvas post's saved doc again, since its save leaves the page and base out", () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved.' }] }] };
  const draft = { format: 'forum-post', engine: { model: JSON.stringify({ doc, pending: 2 }) } };
  const body = bytesOf(postSource(draft, { baseSize: 150 }));
  assert.deepEqual(body.doc, doc);
  assert.equal(body.width, 1454 + 2 * 22);
  assert.equal(body.pad, 22);
  assert.deepEqual(body.base, { font: '', size: 150 });
});

test('checkPost keeps a post the engine gives back as it is', async () => {
  for (const name of ['marks.json', 'lists.json', 'quotes-code.json', 'objects.json', 'suggestions.json']) {
    const doc = fixture(name);
    const draft = { format: 'forum-post', doc };
    const engine = new Engine(); // one session an open, as the page area's (session.js: opened, then checked)
    try {
      const source = postSource(draft, {});
      engine.open(source.bytes, source.kind);
      await checkPost(clientOf(engine), draft);
    } finally {
      engine.free();
    }
  }
});

test('checkPost refuses a post the engine would change, and says why for stayLine', async () => {
  const engine = new Engine();
  try {
    // A run with bold beside code: the engine's code block takes no marks, so its save writes code alone (A3).
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'code' }] }] }] };
    const draft = { format: 'forum-post', doc };
    const source = postSource(draft, {});
    engine.open(source.bytes, source.kind);
    await assert.rejects(checkPost(clientOf(engine), draft),
      (e) => e.name === 'Error' && typeof e.why === 'string' && /change how it looks/.test(e.why));
  } finally {
    engine.free();
  }
});

test('the engine hosts posts only when it is on, and only a post kit format', () => {
  assert.equal(postsOn({ settings: {} }), false, 'POSTS_ON_ENGINE is off until D2');
  assert.equal(postsOn({ settings: { postEngine: true } }), true, 'the harness cases turn it on for their profile');
  assert.equal(isPost({ format: 'forum-post' }, {}), true);
  assert.equal(isPost({ format: 'page' }, {}), true);
  assert.equal(isPost({ format: 'document' }, {}), false);
  assert.equal(isPost(null, {}), false);
});

test('both post kit formats are at version 3, the canvas form, and a DOM save stamps 1', () => {
  assert.equal(PAGE.version, 3);
  assert.equal(forum.formats[0].version, 3);
  assert.equal(formatOf({ format: 'forum-post', formatVersion: 4 }, {}) , null, 'a newer post form is refused');
  assert.equal(formatOf({ format: 'forum-post', formatVersion: 1 }, {})?.id, 'forum-post');
  assert.equal(DOCUMENT.version, 3, 'the Document keeps its canvas form version');
});

test('a draft with no format is a forum post, as formats.mjs says', () => {
  assert.equal(isPost({}, {}), true);
  assert.equal(isPost({ id: 'p' }, {}), true);
  assert.equal(isPost({ format: 'page' }, {}), true);
  assert.equal(isPost(null, {}), false);
});

test('checkPost compares the doc postSource migrated, so a whiteboard no longer refuses the post', async () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Before the canvas.' }] },
    { type: 'whiteboard', attrs: { bg: 'post', width: 800, height: 400, items: [] } },
    { type: 'paragraph', content: [{ type: 'text', text: 'After it.' }] },
  ] };
  const draft = { format: 'forum-post', doc };
  const engine = new Engine();
  try {
    const source = postSource(draft, {});
    assert.equal(bytesOf(source).doc.content[1].type, 'canvas', 'the whiteboard went in as a canvas');
    engine.open(source.bytes, source.kind);
    await checkPost(clientOf(engine), draft, {});
  } finally {
    engine.free();
  }
});

test('a post record is its own form, refused by every path that does not know posts', async () => {
  const record = { form: POST_FORM, version: VERSION, model: { doc: { type: 'doc', content: [] } } };
  assert.match(unreadable(record), /does not know/, 'a Document path refuses it');
  assert.equal(unreadable(record, POST_FORM), null, 'the post host reads it');
  assert.match(unreadable({ form: FORM, version: VERSION, model: {} }, POST_FORM), /does not know/, 'and the post host refuses a Document record');
  await assert.rejects(sourceOf({ format: 'forum-post', engine: record }, {}), /cannot read a forum post/,
    'a canvas post opened without its host is refused, not opened as an engine Document');
});

test('saveOnce writes a post draft as the post kind and keeps the post form', async () => {
  const doc = fixture('quotes-code.json');
  const draft = { id: 'p', format: 'forum-post', doc };
  const engine = new Engine();
  try {
    engine.open(postSource(draft, {}).bytes, 'post');
    const kinds = [];
    const client = { save: async (kind) => { kinds.push(kind); return engine.save(kind); }, saved: () => {} };
    const parts = [];
    const store = async (part, i, n) => { parts[i] = part; return i === n - 1 ? { id: 'p', updated: 1 } : null; };
    await saveOnce(client, draft, store);
    assert.deepEqual(kinds, ['post'], 'the engine wrote the post JSON, not its model form');
    assert.equal(draft.engine.form, POST_FORM);
    assert.equal('doc' in draft, false, 'the canvas record keeps no DOM doc');
    assert.ok(parts.join('').includes('"form":"easywriter.post"'));
  } finally {
    engine.free();
  }
});

test('adopt takes the form from the draft: a Document keeps its own', () => {
  const doc = adopt({ format: 'document', doc: {} }, '{"body":[]}');
  assert.equal(JSON.parse(doc).engine.form, FORM);
  const post = adopt({ format: 'forum-post', doc: {} }, '{"doc":{},"pending":0}');
  assert.equal(JSON.parse(post).engine.form, POST_FORM);
});

test('the page area, not the record\'s form, says where the open post is edited and filled', () => {
  const post = { id: 'p1', format: 'forum-post', doc: { type: 'doc', content: [] } };
  const engine = { view: { type: 'editor' }, draft: post, settings: { postEngine: true }, editor: null };
  assert.equal(openEditor(engine, 'p1'), 'engine', 'a DOM-form post the page area shows is filled there, before its first save');
  assert.equal(openEditor(engine, 'other'), null, 'a draft that is not open is edited nowhere');
  assert.equal(openEditor({ ...engine, settings: {} }, 'p1'), null, 'no engine and no DOM editor: push must say so, not return');
  assert.equal(openEditor({ view: { type: 'editor' }, draft: post, settings: {}, editor: {} }, 'p1'), 'dom');
});

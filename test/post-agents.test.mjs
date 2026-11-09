// post-agents (docs/plans/engine/stage3-forum.md C5): the assistant's draft commands on a forum post in the canvas engine. A
// post has no document.outline, document.find or document.text (B1's allow list), so the reads come from the engine's saves
// (save('post'), save('md')) and its text.paragraphs, and the writes go through post.insert, post.mark, post.block,
// post.toggle, post.list, post.rule and post.clear. Posts have no revision to pass as execAs's ifRev: a read's saved JSON hash
// is the rev, and a write at an older one refuses as stale when its block changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Marked } from 'marked';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { commit, ENGINE } from '../src/app/commands/engine.mjs';
import { normal } from '../src/integrations/forum/normal.mjs';
import { postToDoc } from '../src/integrations/forum/import.mjs';
import { postSource } from '../src/document/canvas/post.js';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const s = JSON.stringify;
const dec = new TextDecoder();
let ids = 0;

const fixture = (name) => J(fs.readFileSync(new URL(`./fixtures/posts/${name}.json`, import.meta.url), 'utf8'));

/** The engine with `doc` open as a post. */
function opened(doc) {
  const e = new Engine();
  e.open(postSource({ format: 'forum-post', doc }, {}).bytes, 'post');
  return e;
}

/** The worker's answers for engine `e`, as a SessionClient gives them (its save writes the post's own kind). */
const client = (e) => ({
  id: `t${++ids}`,
  query: async (id, a = {}) => J(e.query(id, s(a))),
  locate: async (pos) => J(e.locate(s(pos))),
  execAs: async (author, tag, steps, rev) => J(e.execAs(author, tag ?? undefined, s(steps), rev ?? undefined)),
  execMany: async (steps) => J(e.execMany(s(steps))),
  save: async (kind) => e.save(kind),
  rev: async () => e.rev(),
});

const marked = new Marked();
/** doc.insert's content as the post kit's JSON (commands.js postJson's conversion, for a post). */
const postContent = async (c) => {
  if (c.json) {
    const j = c.json;
    return { json: { type: 'doc', content: Array.isArray(j) ? j : j?.type === 'doc' ? j.content ?? [] : [j] }, dropped: [] };
  }
  const html = c.html ?? marked.parse(c.markdown);
  return { json: postToDoc(html), dropped: [] };
};
/** The executor's ctx for a post (commands.js engineCtx). */
const ctx = (eng, ifRev) => ({ eng, ifRev, draftId: 'd', post: true, presets: [], postContent,
  stripImages: (v) => v, shortImages: (h) => h, noteMarkers: () => [] });
const read = (eng, id, a, ifRev) => ENGINE[id].read(ctx(eng, ifRev), a);
const write = async (eng, id, a, ifRev, tag = 'g1') => commit(eng, [await ENGINE[id].write(ctx(eng, ifRev), a)], tag);
/** The post as the engine saves it. */
const saved = (e) => J(dec.decode(e.save('post'))).doc;
const texts = (e) => saved(e).content.map((n) => {
  const flat = (x) => (x?.type === 'text' ? x.text : (x?.content ?? []).map(flat).join(''));
  return `${n.type}: ${flat(n)}`;
});
/** Accepts the assistant's waiting revisions, as the user's Accept does (an insertion shows either way; a deletion does not). */
const accept = (e) => J(e.exec('review.resolve', s({ accept: true, revs: [...new Set((J(e.query('review.changes', '{}')).value ?? []).map((c) => c.rev))] })));

test('doc.get on a post: its JSON, the forum HTML, the engine Markdown, its text and its top-level blocks', async () => {
  const doc = fixture('quotes-code');
  const e = opened(doc);
  const eng = client(e);
  assert.deepEqual(normal((await read(eng, 'doc.get', { format: 'json' })).content), normal(doc), 'save(post) gives the post kit JSON back');
  const html = (await read(eng, 'doc.get', { format: 'html' })).content;
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-javascript">/);
  assert.match((await read(eng, 'doc.get', { format: 'markdown' })).content, /^> \*A quote/);
  assert.match((await read(eng, 'doc.get', { format: 'text' })).content, /After the rule/);
  const outline = (await read(eng, 'doc.get', { format: 'outline' })).content;
  assert.deepEqual(outline.map((x) => [x.path, x.type]), [[[0], 'blockquote'], [[1], 'codeBlock'], [[2], 'codeBlock'], [[3], 'horizontalRule'], [[4], 'paragraph']]);
  const one = (await read(eng, 'doc.get', { format: 'json', path: [4] })).content;
  assert.equal(one.type, 'paragraph');
});

test('doc.insert at the end, at the start and before a block: post.insert in a split paragraph, so the block keeps its kind', async () => {
  const e = opened({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
  ] });
  const eng = client(e);
  await write(eng, 'doc.insert', { at: 'end', content: { markdown: '## Head\n\nLast.' } });
  accept(e);
  assert.deepEqual(texts(e), ['paragraph: First.', 'paragraph: Second.', 'heading: Head', 'paragraph: Last.']);
  await write(eng, 'doc.insert', { at: 'start', content: { markdown: '## Top' } });
  accept(e);
  assert.deepEqual(texts(e), ['heading: Top', 'paragraph: First.', 'paragraph: Second.', 'heading: Head', 'paragraph: Last.']);
  await write(eng, 'doc.insert', { at: [0], position: 'before', content: { markdown: 'Before' } });
  accept(e);
  assert.deepEqual(texts(e), ['paragraph: Before', 'heading: Top', 'paragraph: First.', 'paragraph: Second.', 'heading: Head', 'paragraph: Last.']);
});

test('doc.format on a post: post.mark for marks, post.block for a paragraph or heading, para.align for the alignment', async () => {
  const e = opened({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Make this bold.' }] }] });
  const eng = client(e);
  await write(eng, 'doc.format', { path: [0], from: 0, to: 4, marks: { bold: true, italic: true } });
  accept(e);
  assert.deepEqual(saved(e).content[0].content[0].marks, [{ type: 'bold' }, { type: 'italic' }]);
  await write(eng, 'doc.format', { path: [0], block: { type: 'heading', level: 2 } });
  accept(e);
  assert.equal(saved(e).content[0].type, 'heading');
  assert.equal(saved(e).content[0].attrs.level, 2);
  await write(eng, 'doc.format', { path: [0], block: { align: 'center' } });
  accept(e);
  assert.equal(saved(e).content[0].attrs.textAlign, 'center');
  await assert.rejects(write(eng, 'doc.format', { path: [0], run: { sizePt: 14 } }), (err) => err.code === 'refused');
});

test('doc.command runs the post\'s own commands on the selection: a mark and a heading; a wrapper cannot be a suggestion', async () => {
  const e = opened({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A line.' }] }] });
  const eng = client(e);
  e.exec('select.all', '{}');
  await write(eng, 'doc.command', { name: 'toggleBold' });
  accept(e);
  assert.deepEqual(saved(e).content[0].content[0].marks, [{ type: 'bold' }]);
  e.exec('select.all', '{}');
  await write(eng, 'doc.command', { name: 'setHeading', args: [{ level: 2 }] });
  accept(e);
  assert.equal(saved(e).content[0].type, 'heading');
  // container.wrap makes no revision, so an assistant's call cannot track it (session/run.rs).
  e.exec('select.all', '{}');
  await assert.rejects(write(eng, 'doc.command', { name: 'toggleBlockquote' }), (err) => /suggestion/.test(err.message));
});

test('doc.find and doc.edit on a post address its blocks: the paths are the post JSON\'s, the offsets UTF-16', async () => {
  const e = opened(fixture('quotes-code'));
  const eng = client(e);
  const hits = await read(eng, 'doc.find', { text: 'nested quote' });
  assert.deepEqual(hits.map((h) => h.path), [[0, 2]]);
  const from = hits[0].from;
  await write(eng, 'doc.edit', { path: [0, 2], from, to: from + 'nested'.length, text: 'inner' });
  accept(e);
  assert.equal(saved(e).content[0].content[2].content[0].text, 'after the inner quote');
});

test('doc.replace and doc.delete put post.insert or text.delete over a block\'s range', async () => {
  const three = () => ({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Beta' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Gamma' }] },
  ] });
  const e = opened(three());
  const eng = client(e);
  await write(eng, 'doc.replace', { path: [1], content: { json: { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Beta 2' }] } } });
  accept(e);
  assert.deepEqual(texts(e), ['paragraph: Alpha', 'heading: Beta 2', 'paragraph: Gamma']);
  const d = opened(three());
  const deng = client(d);
  await write(deng, 'doc.delete', { paths: [[0]] });
  accept(d);
  assert.deepEqual(texts(d), ['paragraph: Beta', 'paragraph: Gamma']);
});

test('a post write at a read\'s rev is stale once that block changed', async () => {
  const e = opened({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One.' }] }] });
  const eng = client(e);
  const { rev } = await read(eng, 'doc.get', { format: 'outline' });
  assert.equal(Number.isInteger(rev), true);
  e.exec('select.all', '{}');
  e.insertText(' changed');
  await assert.rejects(write(eng, 'doc.format', { path: [0], marks: { bold: true } }, rev), (err) => err.code === 'stale');
});

test('doc.get gives the engine revision, which doc.command checks and execAs checks again', async () => {
  const e = opened({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }] });
  const eng = client(e);
  const { rev } = await read(eng, 'doc.get', { format: 'json' });
  assert.equal(Number.isInteger(rev), true, 'the engine session revision, not a hash of the JSON');
  e.exec('select.all', '{}');
  await write(eng, 'doc.command', { name: 'toggleBold' }, rev); // nothing changed since the read
  accept(e);
  assert.deepEqual(saved(e).content[0].content[0].marks, [{ type: 'bold' }]);
  // The user types between the read and the call: the revision moved, so the call is stale and writes nothing.
  const typed = (await read(eng, 'doc.get', { format: 'json' })).rev;
  e.exec('caret.docEnd', '{}');
  e.insertText('!');
  await assert.rejects(write(eng, 'doc.command', { name: 'toggleItalic' }, typed), (err) => err.code === 'stale');
  assert.ok(!saved(e).content[0].content[0].marks?.some((m) => m.type === 'italic'));
});

test('doc.delete of a whole bullet list leaves no empty list item behind', async () => {
  const e = opened({ type: 'doc', content: [
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
    ] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Q' }] }] },
  ] });
  await write(client(e), 'doc.delete', { paths: [[0]] });
  accept(e);
  const doc = saved(e);
  assert.equal(doc.content.some((n) => n.type === 'bulletList' || n.type === 'orderedList'), false, JSON.stringify(doc));
  assert.deepEqual(texts(e).at(-1), 'blockquote: Q', 'the next block keeps its text, with no list item left');
});

test('doc.insert before and after a horizontal rule finds the rule\'s paragraph', async () => {
  const before = opened(fixture('quotes-code'));
  await write(client(before), 'doc.insert', { at: [3], position: 'before', content: { markdown: 'Before the rule.' } });
  accept(before);
  // A rule is an empty paragraph: the paste takes it, so the content lands right after the rule without a stray empty block.
  assert.deepEqual(texts(before).slice(3), ['horizontalRule: ', 'paragraph: Before the rule.', 'paragraph: After the rule']);
  const after = opened(fixture('quotes-code'));
  await write(client(after), 'doc.insert', { at: [3], content: { markdown: 'After the rule too.' } });
  accept(after);
  assert.deepEqual(texts(after).slice(3), ['horizontalRule: ', 'paragraph: After the rule too.', 'paragraph: After the rule']);
});

test('an agent read between two typed runs leaves the typing one undo step', async () => {
  const e = opened({ type: 'doc', content: [{ type: 'paragraph' }] });
  const eng = client(e);
  e.exec('caret.docEnd', '{}');
  e.insertText('ab');
  await read(eng, 'doc.get', { format: 'json' }); // postRev reads the engine's rev without running a command
  e.insertText('cd');
  e.undo();
  assert.equal(dec.decode(e.save('txt')), '', 'one undo takes both runs, so the read did not end the typing run');
});

test('an agent read during an IME composition leaves the composed text exactly as it was', async () => {
  const run = async (mid) => {
    const e = opened({ type: 'doc', content: [{ type: 'paragraph' }] });
    e.exec('caret.docEnd', '{}');
    e.insertText('Hello');
    e.compose('ni', 2, 2);
    if (mid) await mid(client(e));
    e.compose('ni hao', 6, 6);
    e.commit();
    return dec.decode(e.save('txt'));
  };
  const plain = await run(null);
  const readMid = await run((eng) => read(eng, 'doc.get', { format: 'json' }));
  assert.equal(plain, 'Helloni hao');
  assert.equal(readMid, plain, 'the read neither ended the composition nor duplicated its text');
});

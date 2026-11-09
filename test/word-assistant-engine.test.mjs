// assistant-engine (docs/plans/word/briefs/assistant-engine.md, docs/plans/engine/stage2b.md decisions 4 and 7): the assistant's draft
// commands on a canvas draft (src/app/commands/engine.mjs), run on the built WebAssembly through an adapter that answers as the
// worker does. Each write is one execAs call: tracked changes by Assistant with the group as their tag, one undo step, the user's
// typing untracked, a call whose paragraph the user changed refused as stale, and inserted or replaced content keeping its own
// paragraph styles while the paragraphs around it keep theirs, accepted or rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Marked } from 'marked';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';
import { commit, ENGINE } from '../src/app/commands/engine.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const s = JSON.stringify;
let ids = 0;

/** A canvas draft by the user 'Kelvin' with a Title, a centred Normal and a Heading 1 paragraph, Track Changes off. */
function draft() {
  const e = new Engine();
  e.exec('file.setAuthor', s({ name: 'Kelvin' }));
  e.insertText('First para');
  e.exec('text.newParagraph', '{}');
  e.insertText('Second para');
  e.exec('text.newParagraph', '{}');
  e.insertText('Third para');
  const paras = J(e.query('document.outline', '{}')).value.paragraphs;
  for (const [i, step] of [[0, ['para.style', { style: 'Title' }]], [1, ['para.align', { value: 'center' }]], [2, ['para.style', { style: 'Heading 1' }]]]) {
    e.exec('select.at', s({ para: paras[i].para }));
    e.exec(step[0], s(step[1]));
  }
  e.exec('caret.docEnd', '{}');
  return e;
}

/** The worker's answers for engine `e`, as a SessionClient gives them. */
const client = (e) => ({
  id: `t${++ids}`,
  query: async (id, a = {}) => J(e.query(id, s(a))),
  locate: async (pos) => J(e.locate(s(pos))),
  execAs: async (author, tag, steps, rev) => J(e.execAs(author, tag ?? undefined, s(steps), rev ?? undefined)),
  execMany: async (steps) => J(e.execMany(s(steps))),
});
const marked = new Marked();
/** The executor's ctx for a command on `eng` (commands.js engineCtx), HTML from Markdown through marked. */
const ctx = (eng, ifRev) => ({
  eng, ifRev, draftId: 'd', noteMarkers: () => [], shortImages: (h) => h,
  html: async (c) => ({ html: c.html ?? marked.parse(c.markdown), dropped: [] }),
});
const read = (eng, id, a, ifRev) => ENGINE[id].read(ctx(eng, ifRev), a);
/** Runs write command `id` as the assistant in group `tag` → commit's answer. */
const write = async (eng, id, a, ifRev, tag = 'g1') => commit(eng, [await ENGINE[id].write(ctx(eng, ifRev), a)], tag);
const shape = (e) => J(e.query('document.outline', '{}')).value.paragraphs.map((p) => {
  const align = J(e.query('document.paragraph', s({ path: p.path }))).value.paragraph.props?.align;
  return `${p.style}${align ? `/${align}` : ''}: ${p.text}`;
});
const changes = (e) => J(e.query('review.changes', '{}')).value;
const resolveAll = (e, accept) => J(e.exec('review.resolve', s({ accept, revs: [...new Set(changes(e).map((c) => c.rev))] })));
const ORIGINAL = ['Title: First para', 'Normal/center: Second para', 'Heading 1: Third para'];

test('doc.insert after a paragraph: tracked by Assistant in its group, one undo step, the pasted styles and the neighbours kept', async () => {
  const e = draft();
  const eng = client(e);
  const o = await read(eng, 'doc.get', { format: 'outline' });
  assert.deepEqual(o.content.map((x) => x.path), [[0], [1], [2]]);
  e.insertText('!'); // the user's key before the call, at the end
  const r = await write(eng, 'doc.insert', { at: [0], position: 'after', content: { markdown: '## New head\n\nNew **body** text' } });
  e.insertText('?'); // and after it, at the user's caret
  assert.deepEqual(r.results[0].paths, [[1], [2]]);
  assert.equal(r.revisions.length > 0, true);
  assert.deepEqual(shape(e), ['Title: First para', 'Heading 2: New head', 'Normal: New body text', 'Normal/center: Second para', 'Heading 1: Third para!?']);
  assert.ok(changes(e).every((c) => c.author === 'Assistant' && c.tag === 'g1'), s(changes(e)));
  J(e.undo()); // the user's '?'
  J(e.undo()); // the whole call
  assert.deepEqual(shape(e), ['Title: First para', 'Normal/center: Second para', 'Heading 1: Third para!']);
});

test('doc.insert accepted and rejected leaves the paragraphs around it as they were', async () => {
  for (const accept of [true, false]) {
    const e = draft();
    await write(client(e), 'doc.insert', { at: [1], content: { html: '<ul><li>one</li><li>two</li></ul>' } });
    assert.ok(resolveAll(e, accept).ok);
    assert.deepEqual(shape(e), accept ? [ORIGINAL[0], ORIGINAL[1], 'List Paragraph: one', 'List Paragraph: two', ORIGINAL[2]] : ORIGINAL);
  }
});

test('doc.replace puts the new block in the old one\'s place; accepted it keeps its own style, rejected the old one is back', async () => {
  for (const accept of [true, false]) {
    const e = draft();
    const r = await write(client(e), 'doc.replace', { path: [1], content: { markdown: '## Replaced' } });
    assert.deepEqual(r.results[0].paths, [[1]]);
    assert.ok(resolveAll(e, accept).ok);
    assert.deepEqual(shape(e), accept ? [ORIGINAL[0], 'Heading 2: Replaced', ORIGINAL[2]] : ORIGINAL);
  }
});

test('doc.replace refuses to drop a bookmark the paragraph holds unless allowLoss', async () => {
  const e = draft();
  const eng = client(e);
  const p = J(e.query('document.outline', '{}')).value.paragraphs[1];
  e.exec('select.at', s({ para: p.para, from: 0, to: 6 }));
  e.exec('insert.bookmark', s({ name: 'keep' }));
  await assert.rejects(write(eng, 'doc.replace', { path: [1], content: { markdown: 'Gone' } }), (err) => err.data?.code === 'content_lost'
    && err.data.lost.some((l) => l.kind === 'bookmark'));
  await write(eng, 'doc.replace', { path: [1], content: { markdown: 'Gone' }, allowLoss: true });
});

test('doc.edit at doc.find\'s offsets; a call read before the user changed that paragraph is stale, one elsewhere is not', async () => {
  const e = draft();
  const eng = client(e);
  const [hit] = await read(eng, 'doc.find', { text: 'para', caseSensitive: true });
  assert.deepEqual([hit.path, hit.from, hit.to], [[0], 6, 10]);
  const sel = await read(eng, 'doc.selection', {});
  const rev = sel.rev;
  // The user types in the third paragraph: an edit of the first, read before, still goes in.
  e.insertText('x');
  const r = await write(eng, 'doc.edit', { path: hit.path, from: hit.from, to: hit.to, text: 'line' }, rev);
  assert.equal(shape(e)[0], 'Title: First linepara'); // the new word goes before the deleted one, as Word tracks a replacement
  assert.ok(changes(e).some((c) => c.kind === 'insert' && c.text === 'line' && c.author === 'Assistant'));
  // The user changes the first paragraph: the next call read at the call's rev is stale.
  e.exec('select.at', s({ para: J(e.query('document.outline', '{}')).value.paragraphs[0].para, from: 0 }));
  e.insertText('Y');
  await assert.rejects(write(eng, 'doc.edit', { path: [0], from: 0, to: 1, text: 'Z' }, r.rev), (err) => err.code === 'stale');
});

test('doc.format and doc.delete make formatting and deletion revisions by Assistant', async () => {
  const e = draft();
  const eng = client(e);
  await write(eng, 'doc.format', { path: [1], from: 0, to: 6, marks: { bold: true }, block: { type: 'heading', level: 2 } }, undefined, 'g2');
  assert.equal(shape(e)[1], 'Heading 2/center: Second para');
  await write(eng, 'doc.delete', { paths: [[0]] }, undefined, 'g3');
  const kinds = changes(e).map((c) => `${c.kind} ${c.author} ${c.tag}`);
  assert.ok(kinds.includes('format Assistant g2') && kinds.includes('delete Assistant g3'), s(kinds));
  assert.ok(resolveAll(e, true).ok);
  assert.deepEqual(shape(e), ['Heading 2/center: Second para', 'Heading 1: Third para']);
});

test('a batch is one execAs: one undo step for all its writes', async () => {
  const e = draft();
  const eng = client(e);
  const c = ctx(eng);
  const ws = [await ENGINE['doc.insert'].write(c, { at: 'end', content: { markdown: 'Last' } }), await ENGINE['doc.edit'].write(c, { path: [1], from: 0, to: 6, text: 'Middle' })];
  const r = await commit(eng, ws, 'g4');
  assert.deepEqual(r.results[0].paths, [[3]]);
  assert.equal(shape(e)[1], 'Normal/center: MiddleSecond para');
  J(e.undo());
  assert.deepEqual(shape(e), ORIGINAL);
});

test('doc.insert at start puts the content before the first paragraph, which keeps its style', async () => {
  // ponytail: rejected, content of two or more paragraphs leaves an empty paragraph at the top (the engine's paste gives its last
  // paragraph an untracked mark); one paragraph rejects cleanly.
  for (const accept of [true, false]) {
    const e = draft();
    const r = await write(client(e), 'doc.insert', { at: 'start', content: { markdown: '## Top' } });
    assert.deepEqual(r.results[0].paths, [[0]]);
    assert.deepEqual(shape(e).slice(0, 2), ['Heading 2: Top', 'Title: First para']);
    assert.ok(resolveAll(e, accept).ok);
    assert.deepEqual(shape(e), accept ? ['Heading 2: Top', ...ORIGINAL] : ORIGINAL);
  }
  const e = draft();
  const r = await write(client(e), 'doc.insert', { at: 'start', content: { markdown: '## Top\n\nUnder it' } });
  assert.deepEqual(r.results[0].paths, [[0], [1]]);
  assert.deepEqual(shape(e), ['Heading 2: Top', 'Normal: Under it', ...ORIGINAL]);
});

test('a turn\'s writes address the paths of its last read (ifRev), whatever its own earlier writes moved', async () => {
  const e = draft();
  const eng = client(e);
  const { rev } = await read(eng, 'doc.get', { format: 'outline' });
  await write(eng, 'doc.insert', { at: [0], content: { markdown: 'Inserted' } }, rev);
  await write(eng, 'doc.replace', { path: [1], content: { markdown: 'Replaced' } }, rev);
  await write(eng, 'doc.delete', { paths: [[2]] }, rev);
  for (let i = 0; i < 4; i++) await write(eng, 'doc.format', { path: [0], marks: { italic: i % 2 === 0 } }, rev); // more writes than reads kept
  assert.ok(resolveAll(e, true).ok);
  // The draft's last paragraph mark stays, as in Word: deleting the last paragraph empties it.
  assert.deepEqual(shape(e), ['Title: First para', 'Normal: Inserted', 'Normal: Replaced', 'Heading 1: ']);
});

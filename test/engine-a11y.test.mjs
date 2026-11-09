// engine-a11y (docs/plans/word/briefs/engine-a11y.md): the accessibility copy's structure and spelling on the canvas engine: the
// engine's own blocks, locate and posAt (engine/crates/wasm/src/a11y.rs) in its WebAssembly, run in Node behind a small client
// like worker.js. The DOM side (the copy's elements and the DOM selection) runs in the harness case engine-a11y.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blocksOf } from '../src/engine/a11y/blocks.js';
import { copyTree } from '../src/engine/a11y/copy.js';
import { createSpellChecker } from '../src/engine/spell/checker.js';
import { candidates, createSpelling } from '../src/engine/spell/squiggles.js';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { ignoredKind, isIgnored, repeats, tokens } from '../src/document/wp/proofing/words.mjs';
import { served } from '../src/document/wp/proofing/languages.mjs';
import { spellingEntries } from '../src/document/wp/context-menu/menus.mjs';

// The DOM editor's word rules and spelling menu, which the page area passes to the engine's spelling (it imports nothing of the app).
const rules = { tokens, repeats, ignoredKind, isIgnored, served };
const spellMenu = spellingEntries;
import { addBundledFonts } from '../src/engine/fonts/bundled.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
// The engine's own fonts ship beside the .wasm, not in it (viewport-design.md section 11): added once for this file's engines.
await addBundledFonts(new Engine(), (url) => fs.readFileSync(url));
const J = JSON.parse;
const S = JSON.stringify;

/** A client over engine `e` as worker.js serves it: async calls, and 'layout' and 'selection' events after each call. */
function engineClient(e) {
  const listeners = new Map();
  const emit = (name, data) => {
    for (const fn of listeners.get(name) ?? []) fn(data);
  };
  const call = (fn) => async (...args) => {
    const before = e.selection();
    const r = fn(...args);
    const layout = e.takeLayout();
    if (layout) emit('layout', J(layout));
    if (e.selection() !== before) emit('selection', J(e.selection()));
    return r;
  };
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    blocks: call((page) => J(e.blocks(page))),
    locate: call((pos) => J(e.locate(S(pos)))),
    posAt: call((id, offset) => J(e.posAt(String(id), offset))),
    selection: call(() => J(e.selection())),
    select: call((a, h) => e.select(S(a), S(h))),
    caret: call((pos) => J(e.caret(S(pos)))),
    rects: call((a, h) => J(e.rects(S(a), S(h)))),
    insertText: call((text) => J(e.insertText(text))),
    deleteBackward: call((unit) => J(e.deleteBackward(unit))),
    exec: call((id, args = {}) => J(e.exec(id, S(args)))),
  };
}

/** A blank engine with `paras` typed in, one paragraph each, '\f' for a page break → [engine, client]. */
async function typed(...paras) {
  const e = new Engine();
  const c = engineClient(e);
  for (const [i, t] of paras.entries()) {
    if (i) await c.exec(t === '\f' ? 'insert.pageBreak' : 'text.newParagraph');
    // raw: no AutoCorrect, which would fix the misspellings these tests need.
    if (t !== '\f') await c.exec('text.insert', { text: t, raw: true });
  }
  return [e, c];
}

const p = (id, text, more = {}) => ({ id, kind: 'p', text, ...more });
const row = (index, ...texts) => ({ index, cells: texts.map((t, i) => ({ blocks: [p(`c${index}${i}`, t)] })) });

/** The tags of plain node `n` and its element children, nested: 'ul[li[...]]'. */
const shape = (n) => (typeof n === 'string' ? '' : `${n.tag}${(n.kids ?? []).some((k) => typeof k !== 'string') ? `[${n.kids.filter((k) => typeof k !== 'string').map(shape).join(',')}]` : ''}`);
const textOf = (n) => (typeof n === 'string' ? n : (n.kids ?? []).map(textOf).join(''));

test('blocksOf keeps a paragraph that runs over two pages once and merges a split table', async () => {
  const pages = [
    [p('a', 'One'), p('b', 'Two'), { id: 't', kind: 'table', rows: [row(0, 'x', 'y')] }],
    [p('b', 'Two'), { id: 't', kind: 'table', rows: [row(0, 'x', 'y'), row(1, 'z', 'w')] }, p('c', 'Three')],
  ];
  const out = await blocksOf({ blocks: async (i) => structuredClone(pages[i]) }, [0, 1]);
  assert.deepEqual(out.map((b) => b.id), ['a', 'b', 't', 'c']);
  assert.deepEqual(out[2].rows.map((r) => r.index), [0, 1]);
});

test('copyTree marks headings with levels, nests lists and keeps lines, objects and tables', () => {
  const tree = copyTree([
    p('h', 'Title', { level: 1 }),
    p('h7', 'Deep', { level: 7 }),
    p('l1', 'First', { list: { ordered: false, level: 0, marker: '•' } }),
    p('l2', 'Inner', { list: { ordered: true, level: 1, marker: '1.' } }),
    p('l3', 'Second', { list: { ordered: false, level: 0, marker: '•' } }),
    p('x', 'ab cd￼ef', { lines: [3], objects: [{ offset: 5, alt: 'A cat' }] }),
    p('e', ''),
    { id: 't', kind: 'table', rows: [row(1, 'z'), row(0, 'x')] },
    { id: 'o', kind: 'object', alt: 'Chart' },
  ]);
  const [h, h7, list, x, e, t, o] = tree.map((n) => n.node);
  assert.equal(h.tag, 'h1');
  assert.deepEqual([h7.tag, h7.attrs.role, h7.attrs['aria-level']], ['p', 'heading', 7]);
  assert.equal(shape(list), 'ul[li[span[span,span],ol[li[span[span,span]]]],li[span[span,span]]]');
  assert.equal(textOf(list.kids[0]), '• First1. Inner');
  assert.equal(tree.length, 7, 'the list is one top-level entry');
  // A line each: 'ab ', then 'cd' | the picture | 'ef', offsets on the pieces
  assert.equal(shape(x), 'p[span[span],span[span,span,span]]');
  assert.deepEqual(x.kids.flatMap((l) => l.kids).map((k) => k.attrs['data-o']), [0, 3, 5, 6]);
  assert.deepEqual([x.kids[1].kids[1].attrs.role, x.kids[1].kids[1].attrs['aria-label']], ['img', 'A cat']);
  assert.equal(shape(e), 'p[span[span]]', 'an empty paragraph keeps a place for the caret');
  assert.deepEqual(t.kids[0].kids.map(textOf), ['x', 'z'], 'rows in order');
  assert.deepEqual([o.tag, o.attrs.role, o.attrs['aria-label']], ['div', 'img', 'Chart']);
});

test('copyTree gives an unchanged block the same signature and a changed one a new one', () => {
  const a = copyTree([p('a', 'One'), p('b', 'Two')]);
  const b = copyTree([p('a', 'One'), p('b', 'Two!')]);
  assert.equal(a[0].sig, b[0].sig);
  assert.notEqual(a[1].sig, b[1].sig);
});

test('candidates follow the proofing options, Do not check spelling, languages and repeated words', () => {
  const b = p('a', 'Teh NASA abc123 www.example.com the the wrod', { noproof: [[0, 3]] });
  const words = (opts, more = {}) => candidates(b, { opts, rules, ...more }).map((c) => `${c.kind}:${c.word}`);
  assert.deepEqual(words({}), ['spell:the', 'repeat:the', 'spell:wrod']);
  assert.deepEqual(words({ ignoreUpper: false, ignoreNumbers: false, ignoreUrls: false, flagRepeated: false }),
    ['spell:NASA', 'spell:abc123', 'spell:www.example.com', 'spell:the', 'spell:the', 'spell:wrod']);
  assert.deepEqual(words({}, { ignored: ['WROD'] }), ['spell:the', 'repeat:the']);
  const rep = candidates(b, { rules }).find((c) => c.kind === 'repeat');
  assert.equal(b.text.slice(...rep.cut), ' the', 'Delete Repeated Word removes the space and the word');
  const fr = p('f', 'bonjour hello', { langs: [[0, 7, 'fr-FR'], [7, 13, 'en-US']] });
  assert.deepEqual(candidates(fr, { dicts: ['en-US'], rules }).map((c) => [c.word, c.lang]), [['hello', 'en-US']]);
});

/** A backend that flags 'teh' and 'wrod' and counts its calls. */
function backend() {
  const b = {
    asked: [], adds: [],
    misspelled: async (w) => {
      b.asked.push(w);
      return ['teh', 'wrod'].includes(w.toLowerCase()) && !b.adds.includes(w);
    },
    suggest: async (w) => ({ teh: ['the', 'ten'], wrod: ['word', 'wood'] })[w.toLowerCase()] ?? [],
    add: async (w) => b.adds.push(w),
    languages: async () => ({ current: ['en-US'], available: ['en-US'] }),
  };
  return b;
}

test('the checker asks once per word and language, and forgets a word added to the dictionary', async () => {
  const be = backend();
  const ch = createSpellChecker(be);
  assert.deepEqual(await ch.check([{ word: 'teh', lang: 'en-US' }, { word: 'cat', lang: 'en-US' }]), [true, false]);
  assert.deepEqual(await ch.check([{ word: 'teh', lang: 'en-US' }, { word: 'teh', lang: 'en-GB' }]), [true, true]);
  assert.deepEqual(be.asked, ['teh', 'cat', 'teh']);
  await ch.add('teh');
  assert.deepEqual(await ch.check([{ word: 'teh', lang: 'en-US' }]), [false]);
  assert.deepEqual(be.adds, ['teh']);
  const broken = createSpellChecker({ misspelled: async () => { throw new Error('no checker'); }, suggest: async () => [], add: async () => {} });
  assert.deepEqual(await broken.check([{ word: 'teh' }]), [false], 'a failing checker flags nothing');
});

test('the engine gives a page its blocks: headings, lists, lines, languages, Do not check spelling and tables', async () => {
  const [e, c] = await typed('Report title', 'Apples', 'Green ones', `${'A long paragraph that wraps. '.repeat(6)}End`, 'Bonjour le monde 😀 ok');
  // The blocks' stable ids (engine-box, viewport-design.md section 10), in order.
  const id = (await c.blocks(0)).map((b) => b.id);
  const at = (i) => c.posAt(id[i], 0);
  await c.select(await at(0), await at(0));
  await c.exec('para.style', { style: 'Heading1' });
  await c.select(await at(1), await c.posAt(id[2], 10));
  await c.exec('para.bullets');
  await c.select(await at(2), await at(2));
  await c.exec('para.indent');
  const fr = await c.posAt(id[4], 8);
  await c.select(fr, await c.posAt(id[4], 16));
  await c.exec('format.set', { props: { lang: 'fr-FR', noProof: true } });
  await c.select(await c.posAt(id[4], 22), await c.posAt(id[4], 22));
  await c.exec('text.newParagraph');
  await c.exec('insert.table', { rows: 2, cols: 2 });
  await c.exec('text.insert', { text: 'Cell one', raw: true });

  const blocks = await c.blocks(0);
  const [h, l1, l2, long, mixed] = blocks;
  const table = blocks.find((b) => b.kind === 'table');
  assert.deepEqual([h.id, h.kind, h.text, h.level], [id[0], 'p', 'Report title', 1]);
  assert.deepEqual([l1.list.ordered, l1.list.level, l2.list.level], [false, 0, 1]);
  assert.ok(l1.list.marker && !l1.level);
  assert.ok(long.lines?.length >= 1 && long.text[long.lines[0] - 1] === ' ', `lines ${long.lines}`);
  assert.deepEqual(mixed.noproof, [[8, 16]]);
  assert.ok(mixed.langs.some(([s, end, tag]) => s === 8 && end === 16 && tag === 'fr-FR'), S(mixed.langs));
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.rows.map((r) => r.index), [0, 1]);
  assert.equal(table.rows[0].cells[0].blocks[0].text, 'Cell one');

  // Offsets are UTF-16 units both ways: the emoji counts two.
  const ok = await c.posAt(id[4], 22);
  assert.deepEqual(await c.locate(ok), { id: id[4], offset: 22 });
  assert.equal(e.text(S(await c.posAt(id[4], 17)), S(ok)), '😀 ok');
  assert.deepEqual(copyTree(await blocksOf(c, [0])).map((x) => x.node.tag), ['h1', 'ul', 'p', 'p', 'table', 'p']);
  e.free();
});

test('the engine says when the selection changes', async () => {
  const [e, c] = await typed('One', 'Two');
  const seen = [];
  c.on('selection', (s) => seen.push(s));
  const two = (await c.blocks(0))[1].id;
  await c.select(await c.posAt(two, 1), await c.posAt(two, 2));
  assert.deepEqual(seen.map((s) => [s.anchor.path, s.anchor.off, s.head.off]), [[[1], 1, 2]]);
  await c.blocks(0);
  assert.equal(seen.length, 1, 'a call that leaves the selection says nothing');
  e.free();
});

test('spelling squiggles a misspelled word on its page, offers suggestions and replaces the word', async () => {
  const [e, c] = await typed('I wrote teh text.', '\f', 'A wrod here, a cat there.');
  let opts = { asYouType: true };
  const sp = createSpelling({ client: c, checker: createSpellChecker(backend()), options: () => opts, rules, menu: spellMenu });
  await sp.setPages([0, 1]);
  assert.deepEqual(sp.forPage(0).map((s) => s.word), ['teh']);
  const [wrod] = sp.forPage(1);
  assert.equal(wrod.word, 'wrod');
  assert.equal(wrod.rects.length, 1);
  const r = wrod.rects[0];
  assert.ok(r.page === 1 && r.w > 10 && r.h > 5, S(r));
  assert.equal(sp.at(1, r.x + r.w / 2, r.y + r.h / 2)?.word, 'wrod', 'a point on the word finds its squiggle');
  const menu = await sp.menu(wrod);
  assert.deepEqual(menu.filter((m) => m.act === 'replace').map((m) => m.label), ['word', 'wood']);
  assert.ok(menu.some((m) => m.label === 'Add to Dictionary') && menu.some((m) => m.label === 'Ignore All'));
  assert.ok(!menu.some((m) => m.sub?.some((s) => s.act === 'changeAll')));
  await sp.run(wrod, menu[0]);
  assert.equal((await c.blocks(1))[0].text, 'A word here, a cat there.');
  await sp.refresh();
  assert.deepEqual(sp.forPage(1), []);
  opts = { asYouType: false };
  await sp.refresh();
  assert.deepEqual(sp.forPage(0), [], 'Check spelling as you type off');
  opts = { asYouType: true };
  await sp.refresh();
  await sp.run(sp.forPage(0)[0], { act: 'ignoreAll', arg: 'teh' });
  assert.deepEqual(sp.forPage(0), [], 'Ignore All');
  sp.destroy();
  e.free();
});

test('Delete Repeated Word and Ignore on a repeated word', async () => {
  const [e, c] = await typed('the the cat', 'a a dog');
  const sp = createSpelling({ client: c, checker: createSpellChecker(backend()), rules, menu: spellMenu });
  await sp.setPages([0]);
  const [first, second] = sp.forPage(0);
  assert.deepEqual([first.kind, first.word, second.word], ['repeat', 'the', 'a']);
  assert.deepEqual((await sp.menu(first)).map((m) => m.act).filter(Boolean), ['deleteRepeat', 'ignoreOnce']);
  await sp.run(first, { act: 'deleteRepeat' });
  assert.equal((await c.blocks(0))[0].text, 'the cat');
  await sp.run(second, { act: 'ignoreOnce' });
  assert.deepEqual(sp.forPage(0), []);
  sp.destroy();
  e.free();
});

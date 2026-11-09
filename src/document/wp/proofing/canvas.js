// Spelling and Read Aloud on a canvas draft (docs/plans/engine/stage2.md S5): the app's checker and speech over the engine's
// blocks(page), as the canvas squiggles do (src/engine/spell/squiggles.js), not engine commands. The Spelling pane runs the same
// check as on the DOM path (session.js): from the caret to the end, then from the start back to the caret, stopping at each
// flagged and repeated word. Here a place is a paragraph's block id and an offset in its text (blocks.js), and the engine
// selects and changes the word. The rows (canvas/rows/review.mjs) reach this through reviewApp.
import { blocksOf, rpc, textBlocks } from '../../../engine/a11y/blocks.js';
import { createSpellChecker } from '../../../engine/spell/checker.js';
import { candidates } from '../../../engine/spell/squiggles.js';
import { bindReviewApp } from '../../canvas/rows/review.mjs';
import { openSpellMenuAt } from './Bar.jsx';
import { served } from './languages.mjs';
import { readState, startParas, stop } from './readaloud.js';
import { proofOpts } from './spell.js';
import { ignoredKind, isIgnored, repeats, sentenceAround, tokens } from './words.mjs';

const WORD = /[\p{L}\p{M}'’-]/u;
/** The word to look up on engine session `client`: the selection when it stays in one paragraph, else the word at the caret
 * → {word, id, start, end, lang} or null. */
export async function wordHere(client) {
  const sel = await rpc(client, 'selection');
  if (!sel) return null;
  const [a, h, c] = await Promise.all([rpc(client, 'locate', sel.anchor), rpc(client, 'locate', sel.head), rpc(client, 'caret', sel.head)]);
  const b = a && textBlocks(await blocksOf(client, [c?.page ?? 0])).find((x) => x.id === a.id);
  if (!b) return null;
  let [start, end] = h?.id === a.id ? [Math.min(a.offset, h.offset), Math.max(a.offset, h.offset)] : [a.offset, a.offset];
  if (start === end) {
    while (start > 0 && WORD.test(b.text[start - 1])) start--;
    while (end < b.text.length && WORD.test(b.text[end])) end++;
  }
  const word = b.text.slice(start, end).trim();
  const lang = (b.langs ?? []).find(([s, e]) => start >= s && start < e)?.[2] ?? null;
  return word ? { word, id: b.id, start, end, lang } : null;
}

/** Puts `text` over the range `at` ({id, start, end}), or over the selection when `at` is null. */
export async function insertWord(client, at, text) {
  if (at) {
    const [anchor, head] = await Promise.all([rpc(client, 'posAt', at.id, at.start), rpc(client, 'posAt', at.id, at.end)]);
    await rpc(client, 'select', anchor, head);
  }
  await rpc(client, 'insertText', text);
}

const RULES = { tokens, repeats, ignoredKind, isIgnored, served };
const checker = createSpellChecker();
const ignored = new Set(); // Ignore All words, while the window is open
const once = new Set(); // Ignore keys (squiggles.js onceKey)
const onceKey = (id, it) => `${id}\n${it.start}\n${it.word}`;

/** The text blocks of every page, in reading order. */
// ponytail: reads every page per step; walk the pages from the caret's when a long draft makes a step slow.
async function allBlocks(client) {
  const n = (await rpc(client, 'pages'))?.pages?.length ?? 0;
  return textBlocks(await blocksOf(client, Array.from({ length: n }, (_, i) => i)));
}

/** The engine's caret or selection start as {id, offset}, or null. */
async function where(client) {
  const sel = await rpc(client, 'selection');
  return sel ? rpc(client, 'locate', sel.anchor) : null;
}

/** The first flagged or repeated word in `blocks` from place `from` ({i, off}) up to `to` (exclusive, {i, off} or null for the
 * end) → {i, block, start, end, word, kind, lang, cut?} or null. */
async function scan(blocks, from, to, grammar = []) {
  const env = { opts: proofOpts(), ignored: [...ignored], once, lang: null, rules: RULES };
  for (let i = from.i; i < blocks.length && (!to || i <= to.i); i++) {
    const b = blocks[i];
    const list = candidates(b, env).filter((c) => (i > from.i || c.start >= from.off) && (!to || i < to.i || c.start < to.off));
    const words = list.filter((c) => c.kind === 'spell');
    const bad = await checker.check(words);
    const flagged = new Set(words.filter((_, k) => bad[k]));
    const hit = list.find((c) => c.kind === 'repeat' || flagged.has(c));
    const fixed = grammar.filter((x) => x.id === b.id && (i > from.i || x.start >= from.off) && (!to || i < to.i || x.start < to.off)
      && !once.has(onceKey(b.id, x)) && !list.some((c) => c.kind === 'repeat' && c.start < x.end && x.start < c.end));
    const first = [hit, ...fixed].filter(Boolean).sort((a, b2) => a.start - b2.start)[0];
    if (first) return { ...first, i, block: b };
  }
  return null;
}

/** Place `at` ({id, offset}) as {i, off} in `blocks`; an id the list lacks starts at the top. */
const placeOf = (blocks, at) => {
  const i = at ? blocks.findIndex((b) => b.id === at.id) : -1;
  return i < 0 ? { i: 0, off: 0 } : { i, off: at.offset };
};

/** Selects the item's word in the engine → its {anchor, head}. */
async function selectItem(client, it) {
  const [anchor, head] = await Promise.all([rpc(client, 'posAt', it.block.id, it.start), rpc(client, 'posAt', it.block.id, it.end)]);
  await rpc(client, 'select', anchor, head);
  return { anchor, head };
}

// ---------- the Spelling pane's check (session.js's API) ----------

let s = null; // {client, start: {id, offset}, at: {id, offset}, wrapped, item, suggestions, done, busy, grammar}
let snap = null;
const listeners = new Set();
const emit = () => {
  snap = s && { item: s.item, suggestions: s.suggestions, done: s.done, busy: s.busy, grammar: s.grammar };
  for (const fn of listeners) fn();
};
export const spellState = () => snap;
export function onSpell(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function endSpell() {
  s = null;
  emit();
}

/** Starts a check of engine session `client` from its caret → the first item, or null. */
export async function startSpell(client, { grammar = false } = {}) {
  const start = await where(client);
  s = { client, start, at: start, wrapped: false, item: null, suggestions: [], done: false, busy: true, grammar };
  emit();
  return advance();
}

/** The engine's grammar issues as scan items, their offsets in the paragraph's text. */
async function grammarItems(client) {
  const list = (await client.query('review.issues', { kind: 'grammar' }))?.value ?? [];
  return Promise.all(list.map(async (g) => {
    const [a, b] = await Promise.all([rpc(client, 'locate', g.start), rpc(client, 'locate', g.end)]);
    return { id: a?.id, start: a?.offset, end: b?.offset, word: g.text, kind: 'grammar', message: g.message, suggestions: g.suggestions ?? [], lang: g.lang };
  }));
}

async function advance() {
  const me = s;
  if (!me) return null;
  me.busy = true;
  emit();
  const blocks = await allBlocks(me.client);
  const end = me.wrapped ? placeOf(blocks, me.start) : null;
  const grammar = me.grammar ? await grammarItems(me.client) : [];
  let it = await scan(blocks, placeOf(blocks, me.at), end, grammar);
  if (!it && !me.wrapped) {
    me.wrapped = true;
    it = await scan(blocks, { i: 0, off: 0 }, placeOf(blocks, me.start), grammar);
  }
  if (s !== me) return null;
  me.item = it && { ...it, sentence: sentenceAround(it.block.text, it.start, it.end), ...(await selectItem(me.client, it)) };
  me.suggestions = it?.kind === 'spell' ? await checker.suggest(it.word, it.lang) : it?.kind === 'grammar' ? it.suggestions : [];
  if (s !== me) return null;
  me.busy = false;
  me.done = !it;
  emit();
  return me.item;
}

const moveOn = (offset) => {
  s.at = { id: s.item.block.id, offset };
  return advance();
};

export async function change(text) {
  const it = s?.item;
  if (!it || !text) return null;
  await rpc(s.client, 'select', it.anchor, it.head);
  await rpc(s.client, 'insertText', text);
  return moveOn(it.start + text.length);
}

/** Change All: every copy of the word the check would flag, as one undo step (select and type each, from the last back). */
export async function changeAll(text) {
  const it = s?.item;
  if (!it || !text) return null;
  const env = { opts: proofOpts(), ignored: [], once: new Set(), lang: null, rules: RULES };
  const hits = (await allBlocks(s.client)).flatMap((b) => candidates(b, env).filter((c) => c.word === it.word).map((c) => [b.id, c]));
  const steps = [];
  for (const [id, c] of hits.reverse()) {
    const [anchor, focus] = await Promise.all([rpc(s.client, 'posAt', id, c.start), rpc(s.client, 'posAt', id, c.end)]);
    steps.push(['select.range', { anchor, focus }], ['text.insert', { text }]);
  }
  if (steps.length) await rpc(s.client, 'execMany', steps);
  return moveOn(it.start + text.length);
}

export function ignoreOnce() {
  const it = s?.item;
  if (!it) return null;
  once.add(onceKey(it.block.id, it));
  return moveOn(it.end);
}

export function ignoreAll() {
  const it = s?.item;
  if (!it) return null;
  ignored.add(it.word);
  return moveOn(it.end);
}

export async function addToDictionary() {
  const it = s?.item;
  if (!it) return null;
  await checker.add(it.word);
  return s && moveOn(it.end);
}

export async function deleteRepeat() {
  const it = s?.item;
  if (!it || it.kind !== 'repeat') return null;
  const [a, h] = await Promise.all([rpc(s.client, 'posAt', it.block.id, it.cut[0]), rpc(s.client, 'posAt', it.block.id, it.cut[1])]);
  await rpc(s.client, 'select', a, h);
  await rpc(s.client, 'deleteBackward', 'character');
  return moveOn(it.cut[0]);
}

/** The selection the engine draws once it has the word (the page area's selection marks), as a client rectangle; the page
 * area's middle when none shows within a few frames. */
async function markBox() {
  for (let i = 0; i < 12; i++) {
    const marks = document.querySelectorAll('[data-viewport] [data-mark="selection"]');
    if (marks.length) return marks[marks.length - 1].getBoundingClientRect();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const v = document.querySelector('[data-viewport]')?.getBoundingClientRect();
  return v ? { left: v.left + v.width / 2, bottom: v.top + v.height / 2 } : { left: 100, bottom: 100 };
}

// ---------- Read Aloud ----------

/** The paragraphs Read Aloud reads on a canvas draft: from the caret, or only the selection → [{text, lang}]. */
async function readParas(client) {
  const sel = await rpc(client, 'selection');
  if (!sel) return [];
  const [a, h] = await Promise.all([rpc(client, 'locate', sel.anchor), rpc(client, 'locate', sel.head)]);
  const blocks = await allBlocks(client);
  let from = placeOf(blocks, a);
  let to = JSON.stringify(sel.anchor) === JSON.stringify(sel.head) ? null : placeOf(blocks, h);
  if (to && (to.i < from.i || (to.i === from.i && to.off < from.off))) [from, to] = [to, from];
  const out = [];
  for (let i = from.i; i < blocks.length && (!to || i <= to.i); i++) {
    const t = blocks[i].text ?? '';
    const text = t.slice(i === from.i ? from.off : 0, to && i === to.i ? to.off : t.length).replace(/[\n￼]/g, ' ');
    if (text.trim()) out.push({ text, lang: blocks[i].langs?.[0]?.[2] ?? null });
  }
  return out;
}

bindReviewApp({
  spelling: (ctx, o = {}) => (ctx.pane('spelling', true, { n: Date.now(), grammar: !!o.grammar }), true),
  nextMisspelling: async (ctx) => {
    const client = ctx.engine;
    const blocks = await allBlocks(client);
    // From the selection's end, as the DOM path does, so a word already selected is passed over.
    const sel = await rpc(client, 'selection');
    const at = placeOf(blocks, sel ? await rpc(client, 'locate', sel.head) : null);
    const it = await scan(blocks, at, null) ?? await scan(blocks, { i: 0, off: 0 }, at);
    if (!it) return ctx.toast('No more spelling errors.'), true;
    const word = await selectItem(client, it);
    const suggestions = it.kind === 'spell' ? await checker.suggest(it.word, it.lang) : [];
    const box = await markBox();
    openSpellMenuAt(box.left, box.bottom + 2, {
      word: it.word, suggestions,
      replace: async (w) => {
        await rpc(client, 'select', word.anchor, word.head);
        await rpc(client, 'insertText', w);
      },
      // ponytail: the squiggles keep their own Ignore All list (engine/spell/squiggles.js), so the word keeps its squiggle until
      // the page area's menu ignores it too; share one list per window if that shows.
      ignoreAll: () => ignored.add(it.word),
      add: () => checker.add(it.word),
      done: () => document.querySelector('[data-canvas-pages]')?.focus({ preventScroll: true }),
    });
    return true;
  },
  readAloud: async (ctx) => (readState().active ? (stop(), true) : startParas(await readParas(ctx.engine))),
  reading: () => readState().active,
  recheck: () => (ignored.clear(), once.clear(), true),
});

// suggestion-cards-engine (docs/plans/word/briefs/suggestion-cards-engine.md, docs/plans/engine/stage2b.md decision 6): a canvas
// draft's suggestion cards come from the engine's tracked changes by the assistant (src/suggest/cards.mjs over review.changes, read
// from the built WebAssembly as the worker reads it): one card per tagged change, a replace as one card, the user's own changes
// none; Accept with Track Changes on is review.resolve with `keep`, which keeps the change as the assistant's and takes it out of its group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initSync, Engine } from '../src/engine/wasm/ew.js';
import { cardAt, cardOf, cardsOf, stepFrom } from '../src/suggest/cards.mjs';

initSync({ module: fs.readFileSync(new URL('../src/engine/wasm/ew_bg.wasm', import.meta.url)) });
const J = JSON.parse;
const s = JSON.stringify;

/** An engine holding paragraphs `paras`, written by the user 'Kelvin' with Track Changes off. */
function draft(...paras) {
  const e = new Engine();
  e.exec('file.setAuthor', s({ name: 'Kelvin' }));
  paras.forEach((t, i) => {
    if (i) e.exec('text.newParagraph', '{}');
    e.insertText(t);
  });
  return e;
}
const query = (e, id, args = {}) => J(e.query(id, s(args))).value;
const changes = (e) => query(e, 'review.changes');
const para = (e, i) => query(e, 'document.outline').paragraphs[i].para;
const text = (e) => new TextDecoder().decode(e.save('txt')).replace(/\r/g, '').replace(/\n$/, '');
/** The assistant's call in group `tag` → its revision ids. */
const assist = (e, tag, steps) => {
  const r = J(e.execAs('Assistant', tag, s(steps)));
  assert.ok(r.ok, r.error);
  return r.revisions;
};

test('tagged changes by the assistant are cards: a replace is one card, and the user\'s own change is none', () => {
  const e = draft('The quick fox.', 'A lazy dog.');
  const [ins] = assist(e, 'g1', [['select.at', { para: para(e, 0), from: 4 }], ['text.insert', { text: 'very ' }]]);
  const rep = assist(e, 'g2', [['select.at', { para: para(e, 1), from: 2, to: 6 }], ['text.insert', { text: 'sleepy' }]]);
  e.exec('review.trackChanges', s({ value: true }));
  e.exec('caret.docEnd', '{}');
  e.insertText(' Mine.');
  const all = changes(e);
  assert.equal(all.length, 4, s(all));
  const cards = cardsOf(all);
  assert.deepEqual(cards.map((c) => [c.id, c.kind, c.g, c.by, c.text, c.revs.length]),
    [[`r${ins}`, 'insert', 'g1', 'agent:assistant', 'Add “very”', 1], [cards[1].id, 'replace', 'g2', 'agent:assistant', 'Replace “lazy” with “sleepy”', 2]]);
  assert.deepEqual(new Set(cards[1].revs), new Set(rep));
  assert.equal(cardOf(cards, `r${rep[1]}`), cards[1], 'either revision names the replace card');
  assert.equal(cardOf(cards, rep[0]), cards[1]);
  assert.equal(cardAt(cards, cards[0].start), cards[0]);
  assert.ok(cards.every((c) => !c.edited && c.at > 0));
  e.free();
});

test('reject by the card\'s revisions takes a replace back whole, and an accept with Track Changes on keeps it tracked out of its group', () => {
  const e = draft('A lazy dog.', 'Second line here.');
  assist(e, 'g', [['select.at', { para: para(e, 0), from: 2, to: 6 }], ['text.insert', { text: 'sleepy' }]]);
  let [card] = cardsOf(changes(e));
  J(e.exec('review.resolve', s({ accept: false, revs: card.revs })));
  assert.equal(text(e), 'A lazy dog.\nSecond line here.');
  assert.deepEqual(cardsOf(changes(e)), []);
  // Track Changes on: the accepted deletion stays a tracked change by Assistant, out of its group, so it is no card.
  assist(e, 'h', [['select.at', { para: para(e, 1), from: 0, to: 7 }], ['text.delete']]);
  [card] = cardsOf(changes(e));
  assert.equal(card.text, 'Delete “Second”');
  e.exec('review.trackChanges', s({ value: true }));
  assert.ok(J(e.exec('review.resolve', s({ accept: true, keep: true, revs: card.revs }))).ok);
  const left = changes(e);
  assert.deepEqual(left.map((c) => [c.kind, c.author, c.tag ?? null]), [['delete', 'Assistant', null]]);
  assert.deepEqual(cardsOf(left), []);
  e.free();
});

test('a card the user typed inside since it was first read says it was edited', () => {
  const e = draft('Hello world.');
  assist(e, 'g', [['select.at', { para: para(e, 0), from: 6 }], ['text.insert', { text: 'big wide ' }]]);
  const seen = new Map();
  assert.equal(cardsOf(changes(e), seen)[0].edited, false);
  J(e.exec('select.at', s({ para: para(e, 0), from: 10 })));
  e.insertText('X');
  const [c] = cardsOf(changes(e), seen);
  assert.equal(c.edited, true, s(changes(e)));
  // With Track Changes on, the user's own insertion inside it is another revision there.
  const f = draft('Hello world.');
  assist(f, 'g', [['select.at', { para: para(f, 0), from: 6 }], ['text.insert', { text: 'big wide ' }]]);
  f.exec('review.trackChanges', s({ value: true }));
  J(f.exec('select.at', s({ para: para(f, 0), from: 10 })));
  f.insertText('Y');
  assert.equal(cardsOf(changes(f)).find((x) => x.g === 'g').edited, true, s(changes(f)));
  e.free();
  f.free();
});

test('Next and Previous walk the cards and wrap, from the caret when none is active', () => {
  const cards = [1, 5, 9].map((off) => ({ id: `r${off}`, start: { path: [0], off }, end: { path: [0], off: off + 1 } }));
  assert.equal(stepFrom(cards, null, { path: [0], off: 4 }, 1).id, 'r5');
  assert.equal(stepFrom(cards, null, { path: [0], off: 4 }, -1).id, 'r1');
  assert.equal(stepFrom(cards, null, { path: [1], off: 0 }, 1).id, 'r1', 'past the last: the first');
  assert.equal(stepFrom(cards, 'r9', null, 1).id, 'r1');
  assert.equal(stepFrom(cards, 'r1', null, -1).id, 'r9');
  assert.equal(stepFrom([], null, null, 1), null);
});

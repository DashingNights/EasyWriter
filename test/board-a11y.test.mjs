// bd-a11y (docs/plans/board/briefs/bd-a11y.md): the words a screen reader reads for an item and the board's reading order.
// Expected values are the brief's forms, never this code's own output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe, readingList } from '../src/board/a11y.mjs';
import { BoardStore, blankBoard } from '../src/board/store.mjs';

const story = (text) => ({ blocks: [{ kind: 'para', text, runs: [] }] });

test('a shape is its name, its size in px, then its text', () => {
  assert.equal(describe({ type: 'shape', kind: 'rectangle', w: 90, h: 60 }), 'Rectangle, 120 by 80');
  assert.equal(describe({ type: 'shape', kind: 'rectangle', w: 90, h: 60, story: story('Label') }), 'Rectangle, 120 by 80, Label');
  assert.equal(describe({ type: 'shape', kind: 'ellipse', w: 30, h: 30 }), 'Ellipse, 40 by 40');
});

test('a text is its text, at most 200 characters', () => {
  assert.equal(describe({ type: 'text', story: story('Hello there') }), 'Text, Hello there');
  const long = 'x'.repeat(250);
  assert.equal(describe({ type: 'text', story: story(long) }), `Text, ${'x'.repeat(200)}`);
  assert.equal(describe({ type: 'text', story: story('') }), 'Text');
});

test('a picture is its alt, or says it has none', () => {
  assert.equal(describe({ type: 'picture', alt: 'A red square' }), 'Picture, A red square');
  assert.equal(describe({ type: 'picture', alt: '' }), 'Picture, no description');
});

test('a connector names both ends, a free end being a point', () => {
  const names = { a: 'Start box', b: 'End box' };
  assert.equal(describe({ type: 'connector', from: { item: 'a' }, to: { item: 'b' } }, (id) => names[id]),
    'Connector from Start box to End box');
  assert.equal(describe({ type: 'connector', from: { x: 0, y: 0 }, to: { item: 'b' } }, (id) => names[id]),
    'Connector from a point to End box');
});

test('a group counts its members', () => {
  const store = new BoardStore(blankBoard(), { client: 'test' });
  let group = null;
  store.change('Add group', (tx) => {
    group = tx.create({ type: 'group', at: [null, 'A'] });
    for (const at of ['A', 'B', 'C']) tx.create({ type: 'shape', kind: 'rectangle', at: [group, at], x: 0, y: 0, w: 10, h: 10 });
  });
  assert.equal(describe(store.get(group), null, store), 'Group of 3');
});

test('a document is its title, its kind and its page count', () => {
  assert.equal(describe({ type: 'doc', draft: 'd1', summary: { count: 12 } }, (id) => (id === 'd1' ? 'Report' : null)),
    'Report, document, 12 pages');
});

test('a hidden item is left out and a locked one says so', () => {
  assert.equal(describe({ type: 'shape', kind: 'rectangle', w: 90, h: 60, hidden: true }), '');
  assert.equal(describe({ type: 'shape', kind: 'rectangle', w: 90, h: 60, locked: true }), 'Rectangle, 120 by 80, locked');
});

test('the reading order is rows from the top, each left to right', () => {
  const store = new BoardStore(blankBoard(), { client: 'test' });
  let ids = [];
  store.change('Add three', (tx) => {
    ids = [
      tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'A'], x: 0, y: 0, w: 100, h: 50 }),
      tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'B'], x: 140, y: 0, w: 100, h: 50 }),
      tx.create({ type: 'shape', kind: 'rectangle', at: [null, 'C'], x: 0, y: 100, w: 100, h: 50 }),
    ];
  });
  assert.deepEqual(readingList(store), [ids[0], ids[1], ids[2]]);
});

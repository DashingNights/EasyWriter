import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fix, lint, styleArgs, styleAsk } from '../src/app/assistant/style-lint.mjs';

test('fix: dashes, curly quotes and the ellipsis become keyboard text; code and the user\'s own text stay', () => {
  assert.equal(fix('The map \u2014 the old one \u2014 works'), 'The map, the old one, works');
  assert.equal(fix('fast\u2014free'), 'fast, free');
  assert.equal(fix('pages 3\u20135'), 'pages 3-5');
  assert.equal(fix('Note -- this and that - here'), 'Note, this and that, here');
  assert.equal(fix('\u201cHi\u201d, it\u2019s fine\u2026'), '"Hi", it\'s fine...');
  assert.equal(fix('- a list item\n\u2014 another'), '- a list item\n- another');
  assert.equal(fix('Run `a \u2014 b` then'), 'Run `a \u2014 b` then');
  assert.equal(fix('Qwen3.7-Plus and well-known'), 'Qwen3.7-Plus and well-known');
  assert.equal(fix('He wrote: the lane \u2014 wide', 'the lane \u2014 wide and long'), 'He wrote: the lane \u2014 wide'); // found in the draft
});

test('lint: the patterns fix() cannot change, none in plain lists or in the user\'s own text', () => {
  const rules = (t, known) => lint(fix(t), known).map((i) => i.rule);
  assert.deepEqual(rules("It's not a bug, it's a feature."), ['contrast']);
  assert.deepEqual(rules('This is not just a map but also a guide.'), ['contrast']);
  assert.deepEqual(rules('The board is not saved, but the draft is.'), []);
  assert.deepEqual(rules('Great question! The answer is in the second paragraph.'), ['filler']);
  assert.deepEqual(rules("It's worth noting that the lanes are really very wide."), ['intensifiers', 'hedge']);
  assert.deepEqual(rules('The new layout of the map is clean, simple, but powerful.'), ['triplet']);
  assert.deepEqual(rules('We tested the maps Ascent, Lotus and Bind on Friday.'), []);
  assert.deepEqual(rules('We tested the maps Ascent, Lotus, and Bind on Friday.'), []);
  assert.deepEqual(rules('It works. It is fast. It is free. Try the new layout on the board.'), ['triplet']);
  assert.deepEqual(rules('Spawn, mid, lane.'), []); // a short label
  assert.deepEqual(rules('Done \u2705 see the arrow \u2192 there, costs \u00a35'), ['symbol', 'symbol']);
  assert.deepEqual(rules('Caf\u00e9 names stay.'), []);
  assert.deepEqual(rules("It's not a bug, it's a feature.", "the user wrote It's not a bug, it's a feature. here"), []);
});

test('styleArgs: prose strings fixed and linted, ids, paths and colours left alone', () => {
  const r = styleArgs(JSON.stringify({ draftId: 'a\u2014b', path: [1], items: [{ type: 'text', text: 'Mid lane \u2014 wide', color: '#fff' }],
    content: "It's not a lane, it's a chokepoint on the map." }));
  const a = JSON.parse(r.arguments);
  assert.equal(a.draftId, 'a\u2014b');
  assert.equal(a.items[0].text, 'Mid lane, wide');
  assert.deepEqual(r.issues.map((i) => i.rule), ['contrast']);
  assert.match(styleAsk(r.issues, 'that text'), /^Write that text again .* a contrast frame/);
  assert.deepEqual(styleArgs('not json').issues, []);
});

test('lint: a longer list closed by "and" is not a triplet', () => {
  assert.deepEqual(lint('We played Ascent, Lotus, Bind, Haven and Split this week.'), []);
});

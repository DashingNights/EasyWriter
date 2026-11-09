// markup (docs/plans/word briefs/markup.md Acceptance): the formatting describer, the balloons per Show Markup setting, the people
// filter, the Reviewing pane's counts and the dialog values against settings.word.tracking.
import assert from 'node:assert/strict';
import test from 'node:test';
import { authorsOf, balloons, summary, togglePerson } from '../src/document/wp/markup/balloons.mjs';
import { describe } from '../src/document/wp/markup/describe.mjs';
import { COLORS, convertWidth, DEL_MARKS, MARKS, valueIn, labelIn } from '../src/document/wp/markup/options.mjs';
import { parseLength } from '../src/tooling/kit/units.mjs';
import { WORD_DEFAULTS } from '../src/document/word/settings.mjs';

const ts = (patch = {}) => ({ ...WORD_DEFAULTS.tracking, ...patch });
const rev = (kind, id, author, extra = {}) => ({ id, source: 'tracking', kind, author, from: id * 10, to: id * 10 + 5, at: null, text: 'words', ...extra });
const REVS = [rev('insert', 1, 'A'), rev('delete', 2, 'B'), rev('format', 3, 'A', { old: [], now: [{ type: 'bold' }] }), rev('delete', 4, 'A'),
  { id: 's1', source: 'suggestion', kind: 'replace', author: 'agent:assistant', from: 60, to: 70, at: null }];

test('describe names formatting changes as Word does', () => {
  assert.equal(describe([{ type: 'italic' }], [{ type: 'bold' }]), 'Formatted: Font: Bold, Not Italic');
  assert.equal(describe([], [{ type: 'textStyle', attrs: { color: '#FF0000' } }]), 'Formatted: Font color: Red');
  assert.equal(describe([], [{ type: 'textStyle', attrs: { size: 14 } }]), 'Formatted: Font: 14 pt');
  assert.equal(describe([], [{ type: 'textStyle', attrs: { color: '#123456' } }]), 'Formatted: Font color: Custom Color(RGB(18,52,86))');
  assert.equal(describe([{ type: 'bold' }], [{ type: 'bold' }, { type: 'insertion', attrs: { id: '1' } }]), 'Formatted');
});

test('balloons follow the Balloons setting and Display for Review', () => {
  const kinds = (t) => balloons(REVS, t).map((b) => b.rev.kind);
  assert.deepEqual(kinds(ts({ balloons: 'revisions' })), ['delete', 'format', 'delete']);
  assert.deepEqual(kinds(ts({ balloons: 'comments' })), ['format']);
  assert.deepEqual(kinds(ts({ balloons: 'none' })), []);
  for (const display of ['simple', 'none', 'original']) assert.deepEqual(kinds(ts({ balloons: 'revisions', display })), []);
  assert.equal(balloons(REVS, ts({ balloons: 'revisions' }))[0].label, 'Deleted: words');
  assert.equal(balloons(REVS, ts({ balloons: 'comments' }))[0].label, 'Formatted: Font: Bold');
  assert.deepEqual(kinds(ts({ balloons: 'revisions', show: { insDel: false, formatting: true } })), ['format']);
});

test('the people filter keeps only the named authors', () => {
  const t = ts({ balloons: 'revisions', people: ['A'] });
  assert.deepEqual(balloons(REVS, t).map((b) => b.rev.author), ['A', 'A']);
  const authors = authorsOf(REVS, [{ author: 'C', replies: [{ author: 'D', replies: [] }] }], [{ name: 'E' }]);
  assert.deepEqual(authors, ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(togglePerson(null, 'B', ['A', 'B']), ['A']);
  assert.equal(togglePerson(['A'], 'B', ['A', 'B']), null);
});

test('the summary counts each kind', () => {
  const s = summary([...REVS, rev('insert', 5, 'A', { move: 'm1' }), rev('paraMark', 6, 'B', { op: 'delete' })], [{ id: 'c' }]);
  assert.deepEqual(s, { total: 8, insertions: 2, deletions: 4, moves: 1, formatting: 1, comments: 1 });
});

test('dialog values map to settings and back', () => {
  assert.equal(valueIn(MARKS, 'Underline'), 'underline');
  assert.equal(labelIn(MARKS, 'dunderline'), 'Double underline');
  assert.equal(valueIn(COLORS, 'By author'), 'byAuthor');
  assert.equal(labelIn(DEL_MARKS, 'caret'), '^ ');
  assert.ok(Math.abs(parseLength('9.4 cm', 'cm') - WORD_DEFAULTS.tracking.balloonWidth) < 0.01);
  assert.ok(Math.abs(convertWidth(convertWidth(266.45, 'len', 'pct', 595.3), 'pct', 'len', 595.3) - 266.45) < 0.5);
});

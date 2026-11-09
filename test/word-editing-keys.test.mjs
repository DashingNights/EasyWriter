// editing-keys' pure logic (docs/plans/word briefs/editing-keys.md Acceptance): F8 steps on the probe text, accents, Click and
// Type zones, the Go Back ring, Repeat, undo labels and column selection ranges.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compose } from '../src/document/wp/editing-keys/accents.mjs';
import { blockRanges, goBack, pickRepeat, pushEdit, undoLabel } from '../src/document/wp/editing-keys/logic.mjs';
import { charExtend, grow, sentenceAt, shrink, wordAt } from '../src/document/wp/editing-keys/words.mjs';
import { zoneAt } from '../src/document/wp/editing-keys/zones.mjs';

// probe/behaviour-tests.tsv f8-doc: two paragraphs, a section break, a third paragraph.
const PROBE = 'First sentence here. Second sentence follows.\rNext paragraph text.\r\fThird paragraph.\r';

test('word and sentence at the probe caret', () => {
  assert.deepEqual(wordAt(PROBE, 23), [21, 28]);
  assert.deepEqual(sentenceAt(PROBE, 23), [21, 45]);
  assert.deepEqual(sentenceAt(PROBE, 3), [0, 21]);
  assert.deepEqual(wordAt(PROBE, 19), [19, 20], 'a punctuation mark alone');
  assert.deepEqual(wordAt(PROBE, 50), [46, 51], 'the caret right after a word');
});

test('F8 steps and Shift+F8 walks them back to the caret', () => {
  const steps = [];
  let cur = [23, 23];
  for (let i = 0; i < 6; i++) {
    const next = grow(PROBE, 23, cur);
    if (next) cur = next;
    steps.push(cur.join('-'));
  }
  assert.deepEqual(steps, ['21-28', '21-45', '0-46', '0-68', '0-85', '0-85']);
  const back = [];
  for (let i = 0; i < 6; i++) {
    const next = shrink(PROBE, 23, cur);
    if (next) cur = next;
    back.push(cur.join('-'));
  }
  assert.deepEqual(back, ['0-68', '0-46', '21-45', '21-28', '23-23', '23-23']);
});

test('a typed character extends to its next occurrence', () => {
  assert.equal(charExtend(PROBE, 0, 'c'), 13);
  assert.equal(charExtend(PROBE, 0, 'Z'), null);
});

test('accent prefixes', () => {
  assert.equal(compose("Ctrl+'", 'e'), 'é');
  assert.equal(compose("Ctrl+'", 'E'), 'É');
  assert.equal(compose("Ctrl+'", 'd'), 'ð');
  assert.equal(compose('Ctrl+Shift+7', 's'), 'ß');
  assert.equal(compose('Ctrl+,', 'c'), 'ç');
  assert.equal(compose('Ctrl+/', 'o'), 'ø');
  assert.equal(compose("Ctrl+'", 'k'), null, 'a letter with no accented form types itself');
  assert.equal(compose('Ctrl+Alt+Shift+6', 'a'), null);
});

test('Click and Type zones', () => {
  assert.equal(zoneAt(234, 468).kind, 'center');
  assert.equal(zoneAt(450, 468).kind, 'right');
  assert.equal(zoneAt(24, 468).kind, 'indent');
  assert.deepEqual(zoneAt(120, 468), { kind: 'tab', at: 120 });
  assert.equal(zoneAt(5, 468).kind, 'left');
});

test('the Go Back ring keeps four and cycles', () => {
  let ring = [];
  for (const p of [10, 20, 30, 40, 50]) ring = pushEdit(ring, p);
  assert.deepEqual(ring, [50, 40, 30, 20]);
  assert.deepEqual(pushEdit(ring, 52, true), [52, 40, 30, 20]);
  let at = goBack(ring, -1, 5);
  assert.equal(at.pos, 50);
  at = goBack(ring, at.index, at.pos);
  assert.equal(at.pos, 40);
  assert.equal(goBack(ring, -1, 50).pos, 40, 'the caret already at the newest edit goes one further');
  assert.equal(goBack([], -1, 0), null);
});

test('Repeat picks redo, then the last command, then typed text', () => {
  const bold = { id: 'home.font.bold' };
  assert.equal(pickRepeat({ canRedo: true, cmd: bold, typed: 'abc' }), 'redo');
  assert.equal(pickRepeat({ canRedo: false, cmd: bold, cmdAtTyping: null, typed: 'abc' }), 'repeat');
  assert.equal(pickRepeat({ canRedo: false, cmd: bold, cmdAtTyping: bold, typed: 'abc' }), 'type');
  assert.equal(pickRepeat({ canRedo: false, cmd: null, typed: '' }), null);
});

test('undo labels', () => {
  assert.equal(undoLabel({ inserted: 'abc' }), 'Typing "abc"');
  assert.equal(undoLabel({ inserted: 'x'.repeat(500) }), `Typing "${'x'.repeat(40)}..."`);
  assert.equal(undoLabel({ uiEvent: 'paste', inserted: 'x' }), 'Paste');
  assert.equal(undoLabel({ uiEvent: 'cut', deleted: true }), 'Cut');
  assert.equal(undoLabel({ marksOnly: true }), 'Formatting');
  assert.equal(undoLabel({ deleted: true }), 'Clear');
  assert.equal(undoLabel({ command: 'Bold' }), 'Bold');
  assert.equal(undoLabel(), 'Edit');
});

test('column selection ranges from line boxes', () => {
  const line = (start, n) => Array.from({ length: n + 1 }, (_, i) => ({ pos: start + i, x: i * 10 }));
  assert.deepEqual(blockRanges([line(1, 8), line(20, 8), line(40, 1)], 25, 55), [{ from: 4, to: 6 }, { from: 23, to: 25 }]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFS, effective, setMac, WORD_DEFS } from '../src/app/keys.mjs';

// Word's chords act only in a Document (scope 'document'); a shadow there leaves the shadowed binding its chord elsewhere, so a
// forum post's Ctrl+Shift+S stays strikethrough while a Document's opens Apply Styles (briefs/forum-strike-key.md).
test('Word bindings are Document-scoped and their shadows keep the shadowed chords', () => {
  setMac(false);
  assert.ok(WORD_DEFS.length > 0 && WORD_DEFS.every((d) => d.scope === 'document'));
  const apply = WORD_DEFS.find((d) => d.id === 'word.home.styles.styles.applyStyles');
  assert.deepEqual([apply.keys, apply.shadows], [['Ctrl+Shift+S'], ['text.strike']]);
  const binds = effective(DEFS);
  assert.deepEqual(binds['text.strike'], ['Ctrl+Shift+S']);
  assert.equal(DEFS.find((d) => d.id === 'text.strike').scope, 'text');
});

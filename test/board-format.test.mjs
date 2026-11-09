import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD, BOARDS_ON, boardsOn, defaultFormat, FORMATS, formatOf, formatVersionOf } from '../src/formats.mjs';
import { BOARD_PROFILE, grants } from '../src/tooling/profile.mjs';
import { boardOpens } from '../src/tooling/surface.js';

test('a whiteboard is a known format, and a newer formatVersion is refused', () => {
  assert.equal(formatOf({ format: 'board' }).id, 'board');
  assert.equal(formatOf({ format: 'board', formatVersion: 1 }).id, 'board');
  assert.equal(formatOf({ format: 'board', formatVersion: 2 }), null);
});

test('the whiteboard profile grants the board tools only', () => {
  assert.equal(grants(BOARD_PROFILE, 'board.align'), true);
  assert.equal(grants(BOARD_PROFILE, 'edit.undo'), true);
  assert.equal(grants(BOARD_PROFILE, 'home.font.bold'), false);
  assert.equal(grants(BOARD_PROFILE, 'text.bold'), false);
});

test('the HUD ranks a Document over a post over a whiteboard', () => {
  assert.equal(FORMATS.document.hudRank, 2);
  assert.equal(FORMATS['forum-post'].hudRank, 1);
  assert.equal(FORMATS.board.hudRank, 0);
  assert.equal(FORMATS.page.hudRank, 1);
  assert.ok(FORMATS.document.hudRank > FORMATS['forum-post'].hudRank && FORMATS['forum-post'].hudRank > FORMATS.board.hudRank);
});

test('boards are off, and a new draft does not take one until they are on', () => {
  assert.equal(BOARDS_ON, false);
  assert.deepEqual([{}, { boardEngine: false }, { boardEngine: true }].map(boardsOn), [false, false, true]);
  // A stale Settings last format cannot make a new draft a board while they are off, and the fallback is a document.
  assert.notEqual(defaultFormat({ lastFormat: 'board' }, null, { last: true }), 'board');
  assert.equal(defaultFormat({ lastFormat: 'board' }, null, { last: true }), 'document');
  assert.equal(defaultFormat({ boardEngine: true, lastFormat: 'board' }, null, { last: true }), 'board');
  assert.equal(defaultFormat({}, null), 'document');
});

test('a board save stamps the board format\'s own version', () => {
  assert.equal(formatVersionOf({ format: 'board' }), BOARD.version);
});

test('the board slot opens only in the editor view on a whiteboard draft', () => {
  assert.equal(boardOpens({ view: { type: 'editor' }, draft: { format: 'board' } }), true);
  assert.equal(boardOpens({ view: { type: 'plan' }, draft: { format: 'board' } }), false);
  assert.equal(boardOpens({ view: { type: 'editor' }, draft: { format: 'document' } }), false);
  assert.equal(boardOpens({ view: { type: 'editor' }, draft: null }), false);
});

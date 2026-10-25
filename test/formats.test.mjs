import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOf, pageOf } from '../src/formats.mjs';

const on = { integrations: { forum: { enabled: true } }, forumWidth: 1200, pageWidth: 900 };
const off = { integrations: { forum: { enabled: false } }, forumWidth: 1200, pageWidth: 900 };

test('a draft without a format opens in the default format, the forum post, with the forum on or off', () => {
  for (const s of [on, off]) {
    assert.equal(formatOf(null, s).id, 'forum-post');
    assert.equal(formatOf({}, s).id, 'forum-post');
  }
});

test('a stored format: known is itself whatever the switch says, unknown is null', () => {
  assert.equal(formatOf({ format: 'forum-post' }, off).id, 'forum-post');
  assert.equal(formatOf({ format: 'forum-post' }, on).id, 'forum-post');
  assert.equal(formatOf({ format: 'page' }, on).id, 'page');
  assert.equal(formatOf({ format: 'slides' }, on), null);
  assert.equal(formatOf({ format: 'slides' }, off), null);
  assert.equal(formatOf({ format: 'toString' }, on), null);
  assert.deepEqual(pageOf({ format: 'slides' }, on), { format: 'page', width: 900, padding: 22 });
});

test('one page width in both states: pageWidth, never forumWidth', () => {
  assert.equal(pageOf(null, on).width, 900);
  assert.equal(pageOf(null, off).width, 900);
  assert.equal(pageOf({ format: 'page' }, on).width, 900);
  assert.equal(pageOf(null, { forumWidth: 1200 }).width, 1454);
});

test('pages have 22 px padding', () => {
  assert.equal(pageOf(null, on).padding, 22);
  assert.equal(pageOf(null, off).padding, 22);
});

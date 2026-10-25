import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSect } from '../src/document/defaults.mjs';
import { defaultFormat, formatOf, pageOf } from '../src/formats.mjs';

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
  for (const id of ['presentation', 'spreadsheet']) { // reserved, not in this build
    assert.equal(formatOf({ format: id }, on), null);
    assert.equal(formatOf({ format: id }, off), null);
  }
  assert.equal(formatOf({ format: 'toString' }, on), null);
  assert.deepEqual(pageOf({ format: 'presentation' }, on), { format: 'page', width: 900, padding: 22 });
});

test("a formatVersion above the build's is refused; absent counts as 1", () => {
  assert.equal(formatOf({ format: 'forum-post', formatVersion: 2 }, on), null);
  assert.equal(formatOf({ formatVersion: 2 }, on), null);
  assert.equal(formatOf({ format: 'forum-post' }, on).id, 'forum-post');
  assert.equal(formatOf({ format: 'forum-post', formatVersion: 1 }, on).id, 'forum-post');
  assert.equal(formatOf({ format: 'page', formatVersion: 2 }, on), null);
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

test("'document' is a known format whose text width is the paper less its side margins", () => {
  assert.equal(formatOf({ format: 'document' }, off).id, 'document');
  assert.equal(formatOf({ format: 'document', formatVersion: 2 }, on), null);
  const a4 = { doc: { attrs: { sect: defaultSect('a4') } }, format: 'document' };
  const letter = { doc: { attrs: { sect: defaultSect('letter') } }, format: 'document' };
  assert.equal(pageOf(a4, on).width.toFixed(1), '601.7');
  assert.equal(pageOf(letter, on).width, 624);
  assert.equal(pageOf(letter, on).paper.w, 816);
  assert.equal(pageOf(a4, on).padding, 96);
  // No sect in the file yet: the device's paper; the live editor's sect wins over the file's.
  assert.equal(pageOf({ format: 'document' }, { paper: 'letter' }).width, 624);
  assert.equal(pageOf(a4, on, defaultSect('letter')).width, 624);
});

test('defaultFormat: forum post in a forum-thread project with the forum on, else the last pick when asked, else Document', () => {
  const P = 'project:3a7c9e1b-5d2f-4b8a-9c6e-1f0d2b4a6c8e';
  const threads = [{ url: P, title: 'Linked', thread: 'https://forum.test/topic/1-x/' }, { url: 'project:other', title: 'Plain' }];
  const forumOn = { ...on, threads, lastFormat: 'document' };
  assert.equal(defaultFormat(forumOn, P, { last: true }), 'forum-post');
  assert.equal(defaultFormat(forumOn, P), 'forum-post');
  assert.equal(defaultFormat({ ...forumOn, lastFormat: 'forum-post' }, 'project:other', { last: true }), 'forum-post');
  assert.equal(defaultFormat({ ...off, threads, lastFormat: 'document' }, P, { last: true }), 'document'); // the forum off
  // A last pick a new draft can no longer take: the forum went off, a reserved or unknown id, the core page.
  for (const lastFormat of ['forum-post', 'presentation', 'page', 'toString', undefined]) {
    assert.equal(defaultFormat({ ...off, threads, lastFormat }, null, { last: true }), 'document', String(lastFormat));
  }
  // drafts.create's rule ignores the last pick.
  assert.equal(defaultFormat({ ...forumOn, lastFormat: 'forum-post' }, 'project:other'), 'document');
  assert.equal(defaultFormat({ ...forumOn, lastFormat: 'forum-post' }, null), 'document');
});

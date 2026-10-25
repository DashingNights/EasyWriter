import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forumOrigin, hasForum, normalizeThread, siteOf, slugTitle, topicId, topicOf } from '../src/integrations/forum/topic.mjs';

const SITE = 'https://forum.example.com';
const CANON = 'https://forum.example.com/topic/12345-level-design/';

test('normalizeThread gives one canonical URL per topic', () => {
  for (const pasted of [
    CANON,
    '  https://forum.example.com/topic/12345-level-design  ',
    'http://www.forum.example.com/topic/12345-level-design/',
    'forum.example.com/topic/12345-level-design/page/3/',
    'https://forum.example.com/topic/12345-level-design/?do=getNewComment#comment-9',
    'https://forum.example.com/topic/12345-level-design#replies',
  ]) assert.equal(normalizeThread(pasted, SITE), CANON, pasted);
  assert.equal(normalizeThread('https://forum.example.com/topic/12345', SITE), 'https://forum.example.com/topic/12345/');
});

test('normalizeThread rejects other URLs', () => {
  for (const other of ['', 'level design', 'https://forum.example.com/', 'https://forum.example.com/forum/12-games/',
    'https://evil.example/forum.example.com/topic/1-x/', 'https://forum.example.com/topic/abc/', 'https://forum.example.com/topic/1-x/ y'])
    assert.equal(normalizeThread(other, SITE), '', other);
});

test('slugTitle reads the slug', () => {
  assert.equal(slugTitle(CANON), 'Level design');
  assert.equal(slugTitle('https://forum.example.com/topic/12345/'), 'Topic 12345');
  assert.equal(slugTitle('nope'), '');
  assert.equal(slugTitle('https://forum.example.com/topic/7-caf%C3%A9-notes/'), 'Café notes');
});

test('topicId matches one topic across slugs', () => {
  assert.equal(topicId('HTTPS://FORUM.EXAMPLE.COM/TOPIC/12345-LEVEL-DESIGN/'), '12345');
  assert.equal(topicId('https://forum.example.com/topic/12345-renamed/page/2/'), topicId(CANON));
  assert.equal(topicId('https://forum.example.com/forum/12-games/'), '');
});

test('normalizeThread takes only the set forum', () => {
  assert.equal(normalizeThread(CANON, 'https://other.example.org'), '');
  assert.equal(normalizeThread(CANON, ''), '');
  assert.equal(forumOrigin(' forum.example.com/ '), SITE);
  assert.equal(forumOrigin('http://forum.example.com'), '');
});

test("topicOf: a project's linked thread, an old thread's own key, else none", () => {
  const key = 'project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55';
  const threads = [{ url: key, title: 'A', thread: CANON }, { url: 'project:1b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55', title: 'B' }];
  assert.equal(topicOf(threads, key), CANON);
  assert.equal(topicOf(threads, threads[1].url), '');
  assert.equal(topicOf(threads, CANON), CANON); // keyed by its topic URL (added before projects), listed or not
  assert.equal(topicOf(threads, null), '');
  assert.equal(siteOf('http://www.forum.example.com/topic/1-a/'), SITE);
  const on = { integrations: { forum: { enabled: true } } };
  assert.ok(hasForum({ ...on, forumUrl: SITE, threads }));
  assert.ok(!hasForum({ ...on, forumUrl: SITE, threads: threads.slice(1) })); // the site stays, but no project links a thread
  assert.ok(!hasForum({ ...on, forumUrl: '', threads }));
  assert.ok(!hasForum({ integrations: { forum: { enabled: false } }, forumUrl: SITE, threads })); // turned off in Settings > Integrations
});

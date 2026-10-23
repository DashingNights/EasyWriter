import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forumOrigin, isProject, migrateSettings, mergeThreads, normalizeThread, slugTitle, topicId } from '../src/thread-url.mjs';

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

test('mergeThreads merges by topic and keeps the stored URL', () => {
  const old = { url: 'https://forum.example.com/topic/12345-old-name/', title: 'Old name', subject: '', year: '', forum: '' };
  const found = [{ url: 'https://forum.example.com/topic/12345-new-name/', title: 'New name', subject: 'Games', year: '2026', forum: 'Dev' },
    { url: 'https://forum.example.com/topic/9-other/', title: 'Other', subject: '', year: '', forum: '' }];
  const { threads, added } = mergeThreads([old], found);
  assert.equal(added, 1);
  assert.deepEqual(threads[0], { ...found[0], url: old.url });
  assert.equal(threads.length, 2);
});

test('normalizeThread takes only the set forum', () => {
  assert.equal(normalizeThread(CANON, 'https://other.example.org'), '');
  assert.equal(normalizeThread(CANON, ''), '');
  assert.equal(forumOrigin(' forum.example.com/ '), SITE);
  assert.equal(forumOrigin('http://forum.example.com'), '');
});

test('a project key is a thread key', () => {
  assert.ok(isProject('project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55'));
  assert.ok(!isProject('project:x') && !isProject(CANON));
});

test('migrateSettings: saved threads keep forum mode and the DAF site; anything else stays as it is', () => {
  const threads = [{ url: 'https://daf.staffs.ac.uk/topic/1-a/', title: 'A' }];
  assert.deepEqual(migrateSettings({ threads }), { threads, mode: 'forum', forumUrl: 'https://daf.staffs.ac.uk' });
  assert.deepEqual(migrateSettings({ threads: [] }), { threads: [] });
  assert.deepEqual(migrateSettings({ threads, mode: 'projects' }), { threads, mode: 'projects' });
  assert.equal(migrateSettings(null), null);
});

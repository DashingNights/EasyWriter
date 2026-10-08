import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeThreads, normalizeThread, slugTitle, topicId } from '../src/thread-url.mjs';

const CANON = 'https://daf.staffs.ac.uk/topic/12345-level-design/';

test('normalizeThread gives one canonical URL per topic', () => {
  for (const pasted of [
    CANON,
    '  https://daf.staffs.ac.uk/topic/12345-level-design  ',
    'http://www.daf.staffs.ac.uk/topic/12345-level-design/',
    'daf.staffs.ac.uk/topic/12345-level-design/page/3/',
    'https://daf.staffs.ac.uk/topic/12345-level-design/?do=getNewComment#comment-9',
    'https://daf.staffs.ac.uk/topic/12345-level-design#replies',
  ]) assert.equal(normalizeThread(pasted), CANON, pasted);
  assert.equal(normalizeThread('https://daf.staffs.ac.uk/topic/12345'), 'https://daf.staffs.ac.uk/topic/12345/');
});

test('normalizeThread rejects other URLs', () => {
  for (const other of ['', 'level design', 'https://daf.staffs.ac.uk/', 'https://daf.staffs.ac.uk/forum/12-games/',
    'https://evil.example/daf.staffs.ac.uk/topic/1-x/', 'https://daf.staffs.ac.uk/topic/abc/', 'https://daf.staffs.ac.uk/topic/1-x/ y'])
    assert.equal(normalizeThread(other), '', other);
});

test('slugTitle reads the slug', () => {
  assert.equal(slugTitle(CANON), 'Level design');
  assert.equal(slugTitle('https://daf.staffs.ac.uk/topic/12345/'), 'Topic 12345');
  assert.equal(slugTitle('nope'), '');
  assert.equal(slugTitle('https://daf.staffs.ac.uk/topic/7-caf%C3%A9-notes/'), 'Café notes');
});

test('topicId matches one topic across slugs', () => {
  assert.equal(topicId('HTTPS://DAF.STAFFS.AC.UK/TOPIC/12345-LEVEL-DESIGN/'), '12345');
  assert.equal(topicId('https://daf.staffs.ac.uk/topic/12345-renamed/page/2/'), topicId(CANON));
  assert.equal(topicId('https://daf.staffs.ac.uk/forum/12-games/'), '');
});

test('mergeThreads merges by topic and keeps the stored URL', () => {
  const old = { url: 'https://daf.staffs.ac.uk/topic/12345-old-name/', title: 'Old name', subject: '', year: '', forum: '' };
  const found = [{ url: 'https://daf.staffs.ac.uk/topic/12345-new-name/', title: 'New name', subject: 'Games', year: '2026', forum: 'Dev' },
    { url: 'https://daf.staffs.ac.uk/topic/9-other/', title: 'Other', subject: '', year: '', forum: '' }];
  const { threads, added } = mergeThreads([old], found);
  assert.equal(added, 1);
  assert.deepEqual(threads[0], { ...found[0], url: old.url });
  assert.equal(threads.length, 2);
});

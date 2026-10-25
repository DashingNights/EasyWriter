import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProject, legacyTopic } from '../src/thread-url.mjs';

const CANON = 'https://forum.example.com/topic/12345-level-design/';

test('a project key is a thread key', () => {
  assert.ok(isProject('project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55'));
  assert.ok(!isProject('project:x') && !isProject(CANON));
});

test('a legacy topic key matches its other links by host and topic number', () => {
  assert.equal(legacyTopic('https://www.Site.test/topic/12-a/?tab=comments'), 'site.test/12');
  assert.equal(legacyTopic('https://site.test/topic/12-b/page/2/'), 'site.test/12');
  assert.equal(legacyTopic('project:0b2c8f0e-1c4e-4f8a-9d6a-2b7f3c9e1a55'), '');
  assert.equal(legacyTopic('https://site.test/forum/12/'), '');
});

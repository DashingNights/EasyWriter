import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TAGS, draftTag, draftsWithTag, pruneMap, tagDraft, tagList } from '../src/app/drafts-meta.js';

const drafts = (...ids) => ids.map((id) => ({ id }));

test('the default tags (To do, In progress, Done) stand in for a missing key; saved tags win', () => {
  assert.deepEqual(tagList({}).map((t) => [t.name, t.color]), [['To do', '#e5e5e5'], ['In progress', '#3d99f5'], ['Done', '#62d926']]);
  assert.deepEqual(tagList({ tags: [] }), []);
});

test('a draft has its tag, or null when untagged or the tag is gone', () => {
  const s = { draftTags: { a: 'done', b: 'gone' } };
  assert.equal(draftTag(s, 'a'), DEFAULT_TAGS[2]);
  assert.equal(draftTag(s, 'b'), null);
  assert.equal(draftTag(s, 'c'), null);
  assert.deepEqual(draftsWithTag(s, drafts('a', 'b', 'c'), 'done'), drafts('a'));
  assert.deepEqual(draftsWithTag(s, drafts('a', 'b', 'c'), null), drafts('b', 'c'));
});

test('tagging sets or clears one draft and drops entries of deleted drafts or tags', () => {
  const s = { draftTags: { a: 'todo', gone: 'done', b: 'old' } };
  assert.deepEqual(tagDraft(s, drafts('a', 'b', 'c'), 'c', 'progress'), { a: 'todo', c: 'progress' });
  assert.deepEqual(tagDraft(s, drafts('a', 'b'), 'a', null), {});
  assert.deepEqual(s.draftTags, { a: 'todo', gone: 'done', b: 'old' }, 'input not mutated');
});

test('pruneMap keeps entries whose draft and target exist', () => {
  assert.deepEqual(pruneMap({ a: 'F', b: 'G', x: 'F' }, drafts('a', 'b'), [{ id: 'F' }]), { a: 'F' });
  assert.deepEqual(pruneMap(undefined, drafts('a'), [{ id: 'F' }]), {});
});

// One author resolver for comments, revisions and Compare (docs/plans/word/briefs/review-author.md).
import assert from 'node:assert/strict';
import test from 'node:test';
import { accountName, authorOf } from '../src/document/wp/comments/comments.mjs';

test('the order: tracking author, user name, account, Author', () => {
  const user = { name: 'Ada Reviewer', initials: '' };
  assert.equal(authorOf(user, 'kelvin', 'Track Person').name, 'Track Person');
  assert.equal(authorOf(user, 'kelvin', '  ').name, 'Ada Reviewer');
  assert.equal(authorOf(user, 'kelvin', null).name, 'Ada Reviewer');
  assert.equal(authorOf({ name: '' }, 'kelvin', null).name, 'kelvin');
  assert.equal(authorOf({ name: '' }, '', null).name, 'Author');
  assert.equal(authorOf({ name: 'Ada', initials: 'XY' }, '', 'Track Person').initials, 'XY', 'set initials win');
  assert.equal(authorOf({}, '', 'Track Person').initials, 'TP');
});

test('no window.api in Node: the account is empty', () => assert.equal(accountName(), ''));

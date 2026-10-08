import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsDigest, cyrb53 } from '../src/app/digest.mjs';

test('cyrb53 is stable and spreads', () => {
  assert.equal(cyrb53('hello'), cyrb53('hello'));
  assert.notEqual(cyrb53('hello'), cyrb53('hellp'));
  assert.match(cyrb53(''), /^[0-9a-z]+$/);
});

test('argsDigest replaces strings over 1 KB, keeps the rest', () => {
  const big = 'x'.repeat(1025);
  const args = { a: 'short', n: 3, list: [big, null], deep: { s: big } };
  const h = { $len: 1025, $hash: cyrb53(big) };
  assert.deepEqual(argsDigest(args), { a: 'short', n: 3, list: [h, null], deep: { s: h } });
  assert.equal(args.list[0], big); // not mutated
  assert.equal(argsDigest('y'.repeat(1024)), 'y'.repeat(1024));
});

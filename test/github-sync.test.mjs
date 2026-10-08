import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// github-sync.js requires electron; stub it so the pure parts can be imported under plain node.
const require = createRequire(import.meta.url);
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: { app: {} } };
const { plan, blobSha } = require('../src/github-sync.js');

test('blobSha matches git hash-object', () => {
  assert.equal(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('plan: three-way merge per file', () => {
  const base = { same: 'a', mine: 'a', theirs: 'a', both: 'a', bothSame: 'a', goneHere: 'a', goneThere: 'a', goneBoth: 'a' };
  const local = { same: 'a', mine: 'b', theirs: 'a', both: 'b', bothSame: 'c', goneThere: 'a', newHere: 'x', newBothDiff: 'p' };
  const remote = { same: 'a', mine: 'a', theirs: 'b', both: 'c', bothSame: 'c', goneHere: 'a', newThere: 'y', newBothDiff: 'q' };
  const { take, conflicts } = plan(local, remote, base);
  assert.deepEqual(take.sort(), ['newThere', 'theirs', 'goneThere'].sort());
  assert.deepEqual(conflicts.sort(), ['both', 'newBothDiff'].sort());
});

test('plan: no base takes what only GitHub has and flags differing files', () => {
  const { take, conflicts } = plan({ a: '1', b: '2' }, { b: '3', c: '4' }, {});
  assert.deepEqual(take, ['c']);
  assert.deepEqual(conflicts, ['b']);
});

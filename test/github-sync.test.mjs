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
const home = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ew-gh-'));
require('node:fs').writeFileSync(`${home}/github-token.json`, '{"login":"me","token":"eA=="}');
const stub = { app: { getPath: () => home }, net: {}, safeStorage: { decryptString: () => 'token' } };
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };
const { plan, push, blobSha } = require('../src/github-sync.js');

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

test('plan: a picture missing on GitHub is never deleted here', () => {
  const p = `images/${'a'.repeat(64)}.png`;
  assert.deepEqual(plan({ [p]: '1' }, {}, { [p]: '1' }), { take: [], conflicts: [] });
  assert.deepEqual(plan({}, { [p]: '1' }, {}).take, [p]);
});

test('push: new pictures go up in commits of 32 MB first; a file GitHub finds too large is skipped', async () => {
  // A fake of the git database API: blobs, trees (with base_tree), commits and the branch ref.
  const blobs = new Set();
  const trees = new Map();
  const commits = new Map();
  let head = 'c0';
  const marker = blobSha(Buffer.from('m'));
  trees.set('t0', { '.easywriter': marker });
  commits.set('c0', 't0');
  let n = 0;
  stub.net.fetch = async (url, { method, body }) => {
    const b = body && JSON.parse(body);
    const json = (status, v) => ({ ok: status < 300, status, json: async () => v });
    if (url.endsWith('/git/blobs')) {
      if (b.content.length > 30e6) return json(422, { message: 'Sorry, your input was too large to process.' });
      const sha = blobSha(Buffer.from(b.content, 'base64'));
      blobs.add(sha);
      return json(201, { sha });
    }
    if (url.endsWith('/git/trees')) {
      const t = { ...(b.base_tree ? trees.get(b.base_tree) : {}) };
      for (const e of b.tree) {
        const sha = e.content != null ? blobSha(Buffer.from(e.content)) : e.sha;
        assert.ok(e.content != null || blobs.has(sha) || Object.values(trees.get(commits.get(head))).includes(sha), `${e.path}: unknown blob`);
        t[e.path] = sha;
      }
      trees.set(`t${++n}`, t);
      return json(201, { sha: `t${n}` });
    }
    if (url.endsWith('/git/commits')) {
      assert.deepEqual(b.parents, [head]);
      commits.set(`c${++n}`, b.tree);
      return json(201, { sha: `c${n}` });
    }
    if (method === 'PATCH') {
      head = b.sha;
      return json(200, {});
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const pic = (i, mb) => [`images/${String(i).repeat(64)}.png`, Buffer.alloc(mb * 1024 * 1024, i)];
  const local = new Map([['.easywriter', Buffer.from('m')], pic(1, 20), pic(2, 20), pic(4, 25), pic(3, 20), ['drafts/x.json', Buffer.from('{"a":1}')]]);
  const saves = [];
  const out = await push('me/backup', { branch: 'main', head: 'c0', files: { '.easywriter': marker } }, local, (s) => saves.push(s));
  assert.deepEqual(Object.keys(out.skipped), [pic(4, 0)[0]]);
  assert.equal(saves.length, 2); // pictures 1 and 2 each in a commit of their own, then 3 and the draft in the last
  assert.deepEqual(Object.keys(saves[1].files).sort(), ['.easywriter', pic(1, 0)[0], pic(2, 0)[0]]);
  const files = trees.get(commits.get(head));
  assert.deepEqual(files, out.files);
  assert.deepEqual(Object.keys(files).sort(), ['.easywriter', 'drafts/x.json', pic(1, 0)[0], pic(2, 0)[0], pic(3, 0)[0]]);
  const again = await push('me/backup', { branch: 'main', head, files }, local, () => assert.fail('nothing to send'));
  assert.equal(again.head, head);
});

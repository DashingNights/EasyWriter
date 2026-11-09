import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// dictation-main.js requires electron; stub it so download() runs under plain node, with fetch serving `body`.
const require = createRequire(import.meta.url);
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: { app: {}, session: {} } };
const { download, MODELS, VAD, BIN } = require('../src/dictation-main.js');

const body = Buffer.from('model bytes');
globalThis.fetch = async () => new Response(body);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const opts = (sha256) => ({ sha256, signal: new AbortController().signal, report: () => {} });

test('every download has a pinned sha256 and the server a pinned tag', () => {
  for (const f of [...MODELS, VAD, BIN]) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  assert.match(BIN.tag, /^v\d+\.\d+\.\d+$/);
});

test('download keeps a file that matches its sha256 and refuses one that does not, or has none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-dict-'));
  const dest = path.join(dir, 'ggml-small.bin');
  await download('https://x/ok', dest, opts(sha(body)));
  assert.deepEqual(fs.readFileSync(dest), body);
  fs.rmSync(dest);
  for (const bad of [sha(Buffer.from('other')), undefined, null, '']) {
    await assert.rejects(download('https://x/bad', dest, opts(bad)), /checksum mismatch/);
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(`${dest}.part`), false);
  }
});

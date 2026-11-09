import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// provider-keys.js requires electron; stub app.getPath and safeStorage ("enc:" + text stands in for DPAPI).
const require = createRequire(import.meta.url);
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
let home;
const safe = {
  available: true,
  isEncryptionAvailable: () => safe.available,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => {
    const s = b.toString();
    if (!s.startsWith('enc:')) throw new Error('another account');
    return s.slice(4);
  },
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: { app: { getPath: () => home }, safeStorage: safe } };
const { reveal, hide, migrate } = require('../src/provider-keys.js');

const read = (f) => JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'));
function profile(settings) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-keys-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings));
  return path.join(home, 'settings.json');
}

test('migrate moves plaintext keys out of settings.json, once', async () => {
  safe.available = true;
  const file = profile({ theme: 'dark', assistant: { provider: 'qwen', qwenKey: 'q-1', googleKey: '', apiKey: 'a-1' } });
  await migrate(file);
  const s = read('settings.json');
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.assistant, { provider: 'qwen', hasQwenKey: true, hasGoogleKey: false, hasDeepseekKey: false, hasApiKey: true });
  assert.equal(Buffer.from(read('provider-keys.json').qwenKey, 'base64').toString(), 'enc:q-1');
  assert.equal(JSON.stringify(read('provider-keys.json')).includes('q-1'), false);
  const back = await reveal(s);
  assert.equal(back.assistant.qwenKey, 'q-1');
  assert.equal(back.assistant.apiKey, 'a-1');
  const before = fs.readFileSync(file, 'utf8');
  await migrate(file);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('without OS encryption the keys stay in settings.json', async () => {
  safe.available = false;
  const file = profile({ assistant: { qwenKey: 'q-1' } });
  await migrate(file);
  assert.deepEqual(read('settings.json'), { assistant: { qwenKey: 'q-1' } });
  assert.equal(fs.existsSync(path.join(home, 'provider-keys.json')), false);
  const s = { assistant: { qwenKey: 'q-2' } };
  assert.equal(await hide(s), s);
  safe.available = true;
});

test('set, replace and clear a key; a key this account cannot decrypt is kept', async () => {
  safe.available = true;
  profile({});
  fs.writeFileSync(path.join(home, 'provider-keys.json'), JSON.stringify({ googleKey: Buffer.from('other-account').toString('base64') }));
  const write = async (assistant) => fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(await hide({ assistant }))); // as setSettings: the revealed settings plus the change
  await write({ deepseekKey: 'd-1' });
  assert.equal((await reveal(read('settings.json'))).assistant.deepseekKey, 'd-1');
  await write({ ...(await reveal(read('settings.json'))).assistant, deepseekKey: 'd-2' });
  assert.equal((await reveal(read('settings.json'))).assistant.deepseekKey, 'd-2');
  await write({ ...(await reveal(read('settings.json'))).assistant, deepseekKey: '' });
  const s = read('settings.json');
  assert.equal(s.assistant.hasDeepseekKey, false);
  assert.equal((await reveal(s)).assistant.deepseekKey, undefined);
  assert.deepEqual(Object.keys(read('provider-keys.json')), ['googleKey']);
  assert.equal(s.assistant.hasGoogleKey, true);
});

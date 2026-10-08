import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// chrome-signin.js requires electron; stub it so the pure mapper can be imported under plain node.
const require = createRequire(import.meta.url);
const Module = require('node:module');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return realResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: { app: {}, session: {} } };
const { toElectronCookie } = require('../src/chrome-signin.js');

test('secure domain cookie with leading dot keeps domain and maps sameSite/expiry', () => {
  const { details, skip } = toElectronCookie({ name: 'SID', value: 'abc', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: 1800000000 });
  assert.equal(skip, undefined);
  assert.deepEqual(details, {
    url: 'https://google.com/', name: 'SID', value: 'abc', path: '/',
    secure: true, httpOnly: true, sameSite: 'no_restriction', domain: '.google.com', expirationDate: 1800000000,
  });
});

test('__Host- host-only cookie omits domain; missing sameSite is unspecified; session cookie omits expiry', () => {
  const { details } = toElectronCookie({ name: '__Host-x', value: 'v', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: false, expires: -1 });
  assert.equal('domain' in details, false);
  assert.equal('expirationDate' in details, false);
  assert.equal(details.sameSite, 'unspecified');
  assert.equal(details.url, 'https://accounts.google.com/');
});

test('insecure cookie gets http url and Lax maps to lax', () => {
  const { details } = toElectronCookie({ name: 'c', value: '1', domain: 'example.com', path: '/a', secure: false, sameSite: 'Lax', expires: 0 });
  assert.equal(details.url, 'http://example.com/a');
  assert.equal(details.secure, false);
  assert.equal(details.sameSite, 'lax');
  assert.equal('expirationDate' in details, false); // expires 0 is a session cookie
  const fromHttps = toElectronCookie({ name: 'c', value: '1', domain: 'example.com', path: '/a', secure: false, sourceScheme: 'Secure' });
  assert.equal(fromHttps.details.url, 'https://example.com/a'); // set over https, though not a Secure cookie
});

test('partitioned cookie is skipped', () => {
  const r = toElectronCookie({ name: 'p', value: '1', domain: '.google.com', path: '/', secure: true, partitionKey: { topLevelSite: 'https://x.com' } });
  assert.equal(r.skip, 'partitioned');
  assert.equal(r.details, undefined);
});

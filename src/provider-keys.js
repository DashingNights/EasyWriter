// The assistant providers' API keys: encrypted (safeStorage) in provider-keys.json, as github-sync.js keeps the GitHub token.
// settings.json keeps only a has<Field> flag per key; getSettings puts the keys back, so the renderer and assistant-main.js see
// them as before. Without OS encryption (a Linux desktop with no keyring) the keys stay in settings.json in plaintext, as before.
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { isPlainObject, readJson, serialized, writeJsonAtomic } = require('./file-family.js');

const FIELDS = ['qwenKey', 'googleKey', 'deepseekKey', 'apiKey'];
const flag = (f) => `has${f[0].toUpperCase()}${f.slice(1)}`;
const keysFile = () => path.join(app.getPath('userData'), 'provider-keys.json');
const str = (v) => (typeof v === 'string' ? v : '');

/** {raw: the file's base64 ciphertexts, keys: the ones this computer can decrypt}, or null without OS encryption or when the file
 * cannot be read (no write then, so nothing in it is lost). */
async function load() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let raw;
  try {
    raw = (await readJson(keysFile())) ?? {};
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  const keys = {};
  for (const f of FIELDS) {
    try {
      if (typeof raw[f] === 'string') keys[f] = safeStorage.decryptString(Buffer.from(raw[f], 'base64'));
    } catch {} // encrypted for another Windows account: kept in the file, not shown
  }
  return { raw, keys };
}

/** Settings as read from settings.json → with the stored keys in assistant (a plaintext key in settings.json wins). */
async function reveal(s) {
  const k = isPlainObject(s?.assistant) && (await load());
  const found = k ? Object.fromEntries(FIELDS.filter((f) => !str(s.assistant[f]) && k.keys[f]).map((f) => [f, k.keys[f]])) : {};
  return Object.keys(found).length ? { ...s, assistant: { ...s.assistant, ...found } } : s;
}

/** Settings about to be written (keys revealed) → the copy for settings.json, after the keys went to provider-keys.json. Without
 * encryption, or with an unreadable keys file, `s` as it is. Must run inside serialized(). */
async function hide(s) {
  const k = isPlainObject(s?.assistant) && (await load());
  if (!k) return s;
  const raw = {};
  const assistant = { ...s.assistant };
  for (const f of FIELDS) {
    const v = str(assistant[f]);
    if (v) raw[f] = v === k.keys[f] ? k.raw[f] : safeStorage.encryptString(v).toString('base64');
    else if (typeof k.raw[f] === 'string' && !(f in k.keys)) raw[f] = k.raw[f]; // another account's key: left alone
    delete assistant[f];
    assistant[flag(f)] = f in raw;
  }
  if (JSON.stringify(raw) !== JSON.stringify(k.raw)) await writeJsonAtomic(keysFile(), raw); // before settings.json drops them
  return { ...s, assistant };
}

/** At start: moves plaintext keys out of settings.json (`file`) once; nothing to do after that or without OS encryption. */
const migrate = (file) =>
  serialized(async () => {
    const s = await readJson(file).catch(() => null);
    if (isPlainObject(s?.assistant) && FIELDS.some((f) => str(s.assistant[f]))) {
      const out = await hide(await reveal(s));
      if (out !== s) await writeJsonAtomic(file, out);
    }
  });

module.exports = { reveal, hide, migrate, FIELDS };

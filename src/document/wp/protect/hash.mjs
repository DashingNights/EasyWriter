// The protection password's salted hash (docs/plans/word/briefs/protect.md Data): PBKDF2 over the UTF-8 password with SHA-512,
// 100000 iterations and a 16-byte random salt, fields in base64. crypto.subtle runs the same in Electron and node 22. Only the
// hash is kept; the password is never stored, logged or sent. This is not Word's ECMA-376 scheme, so a later .docx export
// cannot carry the password (Word's hash is the upgrade path).

export const ALGORITHM = 'PBKDF2-SHA-512';
export const SPIN_COUNT = 100000;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The base64 PBKDF2-SHA-512 hash (64 bytes) of `password` with `salt` bytes over `count` iterations. */
async function derive(password, salt, count) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: count }, key, 512));
}

/** → {algorithmName, hashValue, saltValue, spinCount} for `password`, with a fresh random salt unless `salt` (bytes) is given. */
export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  return { algorithmName: ALGORITHM, hashValue: await derive(password, salt, SPIN_COUNT), saltValue: b64(salt), spinCount: SPIN_COUNT };
}

/** Whether `password` matches the hash in `prot` ({hashValue, saltValue, spinCount}); no stored hash accepts any password. */
export async function verifyPassword(password, prot) {
  if (!prot?.hashValue) return true;
  if (prot.algorithmName && prot.algorithmName !== ALGORITHM) return false;
  return (await derive(password, unb64(prot.saltValue ?? ''), prot.spinCount ?? SPIN_COUNT)) === prot.hashValue;
}

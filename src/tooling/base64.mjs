// Bytes to base64 and back with plain web APIs (btoa, atob), for the import's worker, a page and Node alike.

/** `bytes` (a Uint8Array) as base64, built in chunks so a large picture does not overflow the call stack. */
export function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Base64 text `b64` as a Uint8Array. */
export const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

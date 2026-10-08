// Audit digests (SPEC §8; agent-automation plan §4.2). Pure and import-free; cyrb53 is copied from history.js (not exported).

/** 53-bit string hash (cyrb53), base 36. */
export function cyrb53(s) {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
}

const LIMIT = 1024;

/** A copy of `args` with every string longer than 1 KB replaced by {$len, $hash}. */
export function argsDigest(args) {
  if (typeof args === 'string') return args.length > LIMIT ? { $len: args.length, $hash: cyrb53(args) } : args;
  if (Array.isArray(args)) return args.map(argsDigest);
  if (args && typeof args === 'object') return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, argsDigest(v)]));
  return args;
}

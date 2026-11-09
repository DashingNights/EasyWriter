// Fractional order keys in base 62. Plain string compare keeps them sorted.

export const D = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const MAX_KEY = 64;

/** A key strictly between `a` and `b` (null: no bound) by plain string compare. Throws when a >= b or past MAX_KEY chars. */
export function between(a = null, b = null) {
  if (b == null) return a == null ? 'V' : after(a);
  if (a != null && !(a < b)) throw new Error(`order key ${a} is not before ${b}`);
  let out = '';
  let open = false;
  for (let i = 0; ; i++) {
    const da = a != null && i < a.length ? D.indexOf(a[i]) : 0;
    const db = open ? 62 : b != null && i < b.length ? D.indexOf(b[i]) : 0;
    if (db - da > 1) return out + D[Math.floor((da + db) / 2)];
    out += D[da];
    if (db - da === 1) open = true;
    if (out.length >= MAX_KEY) throw new Error(`order key longer than ${MAX_KEY} characters`);
  }
}

/** The key after `a`: its last character that is not 'z' goes up by one and what follows it is dropped; all 'z' gets '1' appended. */
export function after(a) {
  let key;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== 'z') {
      key = a.slice(0, i) + D[D.indexOf(a[i]) + 1];
      break;
    }
  }
  if (key === undefined) key = a + '1';
  if (key.length > MAX_KEY) throw new Error(`order key longer than ${MAX_KEY} characters`);
  return key;
}

/** `n` keys evenly spread, all of the shortest length L with 62^L >= 4(n + 1). */
export function spread(n) {
  let L = 1;
  while (62 ** L < 4 * (n + 1)) L++;
  const total = 62 ** L;
  const keys = [];
  for (let i = 0; i < n; i++) {
    let v = Math.floor(((i + 1) * total) / (n + 1));
    let s = '';
    for (let k = 0; k < L; k++) {
      s = D[v % 62] + s;
      v = Math.floor(v / 62);
    }
    keys.push(s);
  }
  return keys;
}

/** Keys for inserting at `index` into `keys` (sorted, may hold equal neighbours) -> {key, rekey: [[i, newKey]]}. */
export function keyAt(keys, index) {
  const prev = keys[index - 1] ?? null;
  const next = keys[index] ?? null;
  const rekey = [];
  try {
    let bound = next;
    if (prev !== null && prev === next) {
      let end = index;
      while (end < keys.length && keys[end] === prev) end++;
      const afterRun = keys[end] ?? null;
      let last = prev;
      for (let k = index; k < end; k++) {
        last = between(last, afterRun);
        rekey.push([k, last]);
      }
      bound = rekey[0][1];
    }
    return { key: between(prev, bound), rekey };
  } catch {
    const fresh = spread(keys.length);
    return {
      key: between(index > 0 ? fresh[index - 1] : null, index < keys.length ? fresh[index] : null),
      rekey: fresh.map((k, i) => [i, k]),
    };
  }
}

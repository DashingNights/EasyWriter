// QR Code encoder for DISPLAYBARCODE ... QR (docs/plans/word/plan.md §3 fields-draw, §1.1: our own code, no dependency).
// ISO/IEC 18004: numeric, alphanumeric and byte mode, versions 1 to 40, Reed-Solomon over GF(256) with polynomial 0x11D,
// the block split and interleave, the 8 masks with the penalty rules, format and version information. No Kanji mode
// (Word refuses Japanese text anyway). Pure: text in, a module matrix out.

/** Error correction levels by DISPLAYBARCODE's \q value (0 to 3). */
export const LEVELS = ['L', 'M', 'Q', 'H'];
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// Error correction codewords per block and the number of blocks, by level and version (ISO/IEC 18004 Table 9; index 0 unused).
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

// ---------- GF(256) and Reed-Solomon ----------
const mul = (x, y) => {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
};

/** The generator polynomial of `degree` (coefficients without the leading 1, highest first). */
function divisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = mul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = mul(root, 0x02);
  }
  return r;
}

/** The `degree` error correction codewords of `data` (bytes). */
export function rsRemainder(data, degree) {
  const div = divisor(degree);
  const r = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => (r[i] ^= mul(c, factor)));
  }
  return r;
}

/** The syndromes of a whole block (data then its ECC): all zero when the block is a codeword. */
export function syndromes(block, degree) {
  const out = [];
  let x = 1;
  for (let i = 0; i < degree; i++) {
    let s = 0;
    for (const b of block) s = mul(s, x) ^ b;
    out.push(s);
    x = mul(x, 0x02);
  }
  return out;
}

// ---------- capacity ----------
/** Data modules of `version` after the function patterns. */
function rawModules(version) {
  let r = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (version >= 7) r -= 36;
  }
  return r;
}

/** Data codewords (excluding error correction) of `version` at `level`. */
export const dataCapacity = (version, level) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[level][version] * BLOCKS[level][version];

// ---------- data encoding ----------
/** The mode for `text`: numeric, alphanumeric or byte (one segment for the whole text). */
const modeOf = (text) => (/^[0-9]*$/.test(text) ? 'numeric' : [...text].every((c) => ALNUM.includes(c)) ? 'alnum' : 'byte');
const MODE_BITS = { numeric: 1, alnum: 2, byte: 4 };
const countBits = (mode, version) => {
  const i = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alnum: [9, 11, 13], byte: [8, 16, 16] }[mode][i];
};

/** The segment bits of `text` in `mode` (without the header). */
function payload(text, mode) {
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  if (mode === 'numeric') {
    for (let i = 0; i < text.length; i += 3) {
      const g = text.slice(i, i + 3);
      put(Number(g), g.length * 3 + 1);
    }
  } else if (mode === 'alnum') {
    for (let i = 0; i < text.length; i += 2) {
      if (i + 1 < text.length) put(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
      else put(ALNUM.indexOf(text[i]), 6);
    }
  } else for (const b of new TextEncoder().encode(text)) put(b, 8);
  return bits;
}

/** The data codewords of `text` at `version` and `level`, padded, or null when it does not fit. */
export function dataCodewords(text, version, level) {
  const mode = modeOf(text);
  const body = payload(text, mode);
  const count = mode === 'byte' ? new TextEncoder().encode(text).length : text.length;
  if (count >= 1 << countBits(mode, version)) return null;
  const cap = dataCapacity(version, level) * 8;
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(MODE_BITS[mode], 4);
  put(count, countBits(mode, version));
  bits.push(...body);
  if (bits.length > cap) return null;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** The data split into blocks, each with its ECC: [{data, ecc}] (ISO/IEC 18004 §7.5.2: short blocks first). */
export function blocksOf(data, version, level) {
  const n = BLOCKS[level][version];
  const ecc = ECC_PER_BLOCK[level][version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortLen = Math.floor(raw / n) - ecc; // data codewords of a short block
  const shorts = n - (raw % n);
  const out = [];
  for (let i = 0, k = 0; i < n; i++) {
    const len = shortLen + (i < shorts ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    out.push({ data: d, ecc: rsRemainder(d, ecc) });
  }
  return out;
}

/** The final codeword sequence: data interleaved across blocks, then error correction interleaved. */
function interleave(blocks) {
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < blocks[0].ecc.length; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

// ---------- format and version information ----------
/** The 15 format bits for `level` and `mask` (BCH(15,5), XOR 101010000010010). */
export function formatBits(level, mask) {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits of `version` (BCH(18,6)), for versions 7 and up. */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

// ---------- the matrix ----------
function alignment(version) {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** A matrix with the function patterns of `version` drawn: {size, m (dark), fn (reserved)}; m[y][x]. */
function base(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = alignment(version);
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  placeFormat({ size, m, fn, set }, 0); // reserves the format areas; drawn for real after the mask is chosen
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  return { size, m, fn, set };
}

function placeFormat({ size, set }, bits) {
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the dark module
}

/** Places the codeword bits in the zigzag order. */
function placeData({ size, m, fn }, codewords) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - v : v;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function applyMask({ size, m, fn }, mask) {
  const f = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && f(x, y)) m[y][x] = !m[y][x];
}

/** The penalty score of matrix `m` (ISO/IEC 18004 §7.8.3). Rule 3 counts each 1011101 inside the symbol once when four light
 * modules (cut short at the edge) lie on either side, and rule 4 steps by whole 5 % deviations: with these readings the mask
 * matches Word's own symbol for "https://example.com" (mask 0; the stricter reading picks mask 2). */
export function penalty(m) {
  const size = m.length;
  let score = 0;
  const line = (get) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) s += PENALTY.N1 + run - 5;
        run = 1;
      }
    }
    const light = (a, b) => {
      for (let i = Math.max(a, 0); i < Math.min(b, size); i++) if (get(i)) return false;
      return true;
    };
    for (let i = 0; i + 6 < size; i++) {
      const core = get(i) && !get(i + 1) && get(i + 2) && get(i + 3) && get(i + 4) && !get(i + 5) && get(i + 6);
      if (core && (light(i - 4, i) || light(i + 7, i + 11))) s += PENALTY.N3;
    }
    return s;
  };
  for (let y = 0; y < size; y++) score += line((x) => m[y][x]);
  for (let x = 0; x < size; x++) score += line((y) => m[y][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += PENALTY.N2;
    }
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  score += Math.floor((Math.abs(dark * 2 - total) * 10) / total) * PENALTY.N4;
  return score;
}

/** Whether QR can encode `text`: ASCII only, as Word allows (Japanese text gave "Data contains unsupported character(s)."). */
export const qrSupports = (text) => /^[\x00-\x7f]*$/.test(text);

/** Encodes `text` at error correction `level` → {version, size, mask, level, modules: boolean[][] (row by row, dark true, no quiet
 * zone)}, or null when it fits no version. `opts.version` and `opts.mask` force them (tests). */
export function encodeQR(text, level = 'M', { version: forceVersion, mask: forceMask } = {}) {
  let version = forceVersion ?? 1;
  let data = null;
  for (; version <= 40; version++) {
    data = dataCodewords(text, version, level);
    if (data || forceVersion) break;
  }
  if (!data) return null;
  const codewords = interleave(blocksOf(data, version, level));
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask != null && mask !== forceMask) continue;
    const q = base(version);
    placeData(q, codewords);
    applyMask(q, mask);
    placeFormat(q, formatBits(level, mask));
    const score = penalty(q.m);
    if (!best || score < best.score) best = { score, mask, m: q.m, size: q.size };
  }
  return { version, size: best.size, mask: best.mask, level, modules: best.m };
}

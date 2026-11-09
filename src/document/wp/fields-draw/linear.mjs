// Linear barcode encoders for DISPLAYBARCODE (docs/plans/word/plan.md §3 fields-draw): Code 128, Code 39, EAN-13, EAN-8, UPC-A,
// UPC-E with add-ons, interleaved 2 of 5 (ITF14 and CASE), NW7 (Codabar) and the Japan Post customer barcode (JPPOST).
// Pure. Each encoder returns {bars} (element widths in units, bar first, alternating bar and space) or {error}, plus what the
// drawing needs: guard bars, text groups, the unit size. Sizes are pt, measured on Word's PDF drawings (probe/fields/out2.pdf).

export const ERR = {
  chars: 'Data contains unsupported character(s).',
  invalid: 'Data is invalid.',
  length: 'Data length is not supported by current type.',
  params: 'Required parameters are missing or incorrect.',
};

/** Element widths from a pattern of digits ('212222') → [2, 1, 2, 2, 2, 2]. */
const widths = (s) => [...s].map(Number);

// ---------- Code 128 ----------
const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 ' +
  '223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 ' +
  '132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 ' +
  '331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 ' +
  '241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 ' +
  '131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');
export const CODE128_PATTERNS = C128;

const inA = (c) => c < 96; // control characters and upper case
const inB = (c) => c >= 32 && c < 128;
const valA = (c) => (c < 32 ? c + 64 : c - 32);
const SET_CODE = { A: 101, B: 100, C: 99 };
const START = { A: 103, B: 104, C: 105 };
// Set B first: on a tie the symbol uses B, as most encoders do (the first set to reach a cost keeps it).
const SETS = ['B', 'C', 'A'];

/** The Code 128 values for `text` (start, data, no check) with the fewest symbols: a shortest path over the three code sets, with
 * Shift for a single character of the other of A and B. → null when a character is outside ASCII. */
export function code128Values(text) {
  const cs = [...text].map((ch) => ch.charCodeAt(0));
  if (cs.some((c) => c > 127)) return null;
  const n = cs.length;
  const digit = (i) => i < n && cs[i] >= 48 && cs[i] <= 57;
  // best[i][set] = {cost, prev, step} for having encoded i characters, now in set.
  const best = Array.from({ length: n + 1 }, () => ({}));
  const relax = (i, set, cost, from, step) => {
    if (!best[i][set] || cost < best[i][set].cost) best[i][set] = { cost, from, step };
  };
  for (const s of SETS) relax(0, s, 1, null, { start: s });
  for (let i = 0; i < n; i++) {
    // Switching set costs one symbol; two switches in a row never beat one, so one pass from the values before it is enough.
    const before = { ...best[i] };
    for (const [s, cur] of Object.entries(before)) for (const t of SETS) if (t !== s) relax(i, t, cur.cost + 1, [i, s], { code: SET_CODE[t] });
    for (const s of SETS) {
      const cur = best[i][s];
      if (!cur) continue;
      const c = cs[i];
      if (s === 'C') {
        if (digit(i) && digit(i + 1)) relax(i + 2, 'C', cur.cost + 1, [i, s], { vals: [(c - 48) * 10 + cs[i + 1] - 48] });
      } else {
        const fits = s === 'A' ? inA(c) : inB(c);
        if (fits) relax(i + 1, s, cur.cost + 1, [i, s], { vals: [s === 'A' ? valA(c) : c - 32] });
        else if (s === 'A' ? inB(c) : inA(c)) relax(i + 1, s, cur.cost + 2, [i, s], { vals: [98, s === 'A' ? c - 32 : valA(c)] });
      }
    }
  }
  let end = null;
  for (const s of SETS) if (best[n][s] && (!end || best[n][s].cost < best[n][end].cost)) end = s;
  const out = [];
  for (let at = [n, end]; at;) {
    const node = best[at[0]][at[1]];
    const { step } = node;
    if (step.start) out.unshift(START[step.start]);
    else if (step.code) out.unshift(step.code);
    else out.unshift(...step.vals);
    at = node.from;
  }
  return out;
}

/** Code 128 symbol for `text`. */
export function code128(text) {
  if (!text) return { error: ERR.length };
  const v = code128Values(text);
  if (!v) return { error: ERR.chars };
  const check = v.reduce((sum, x, i) => sum + x * Math.max(i, 1), 0) % 103;
  const bars = [...v, check, 106].flatMap((x) => widths(C128[x]));
  return { bars, unit: 1.05, quiet: 10, text: [{ text, at: 'all' }] };
}

// ---------- Code 39 ----------
export const CODE39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
const C39 = ('nnnwwnwnn wnnwnnnnw nnwwnnnnw wnwwnnnnn nnnwwnnnw wnnwwnnnn nnwwwnnnn nnnwnnwnw wnnwnnwnn nnwwnnwnn wnnnnwnnw nnwnnwnnw ' +
  'wnwnnwnnn nnnnwwnnw wnnnwwnnn nnwnwwnnn nnnnnwwnw wnnnnwwnn nnwnnwwnn nnnnwwwnn wnnnnnnww nnwnnnnww wnwnnnnwn nnnnwnnww wnnnwnnwn ' +
  'nnwnwnnwn nnnnnnwww wnnnnnwwn nnwnnnwwn nnnnwnwwn wwnnnnnnw nwwnnnnnw wwwnnnnnn nwnnwnnnw wwnnwnnnn nwwnwnnnn nwnnnnwnw wwnnnnwnn ' +
  'nwwnnnwnn nwnwnwnnn nwnwnnnwn nwnnnwnwn nnnwnwnwn').split(' ');
export const CODE39_PATTERNS = Object.fromEntries([...CODE39_CHARS].map((c, i) => [c, C39[i]]).concat([['*', 'nwnnwnwnn']]));

/** Code 39: upper case, digits and - . space $ / + %; `check` (\x) adds the mod 43 character, `stops` (\d) shows the * start and
 * stop in the text. The bars always carry the * start and stop, which every Code 39 reader needs. */
export function code39(text, { check = false, stops = false } = {}) {
  if (!text) return { error: ERR.length };
  if ([...text].some((c) => !CODE39_CHARS.includes(c))) return { error: ERR.chars };
  let data = text;
  if (check) data += CODE39_CHARS[[...text].reduce((s, c) => s + CODE39_CHARS.indexOf(c), 0) % 43];
  const bars = [];
  for (const c of `*${data}*`) {
    if (bars.length) bars.push(1); // the narrow gap between characters
    bars.push(...[...CODE39_PATTERNS[c]].map((x) => (x === 'w' ? 2 : 1)));
  }
  const shown = [...(stops ? `*${text}*` : text)].join(' ');
  return { bars, unit: 0.99, quiet: 0, text: [{ text: shown, at: 'all' }], checkChar: check ? data.at(-1) : null };
}

// ---------- EAN and UPC ----------
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const G = R.map((p) => [...p].reverse().join(''));
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
const UPCE_PARITY = ['GGGLLL', 'GGLGLL', 'GGLLGL', 'GGLLLG', 'GLGGLL', 'GLLGGL', 'GLLLGG', 'GLGLGL', 'GLGLLG', 'GLLGLG'];
const SUP5_PARITY = ['GGLLL', 'GLGLL', 'GLLGL', 'GLLLG', 'LGGLL', 'LLGGL', 'LLLGG', 'LGLGL', 'LGLLG', 'LLGLG'];
const code = (d, set) => (set === 'L' ? L : set === 'G' ? G : R)[d];

/** The mod 10 check digit of `digits` (weights 3 and 1 from the right). */
export function mod10(digits) {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => (sum += Number(d) * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10;
}

/** A module string ('1' bar, '0' space) → element widths, bar first. */
function runs(mods) {
  const out = [];
  let run = 0;
  for (let i = 0; i < mods.length; i++) {
    run++;
    if (i === mods.length - 1 || mods[i] !== mods[i + 1]) {
      out.push(run);
      run = 0;
    }
  }
  return out;
}

/** Digits `data` completed with its check digit to `len`: `len - 1` digits get one, `len` digits must carry a valid one. */
function withCheck(data, len) {
  if (!/^\d+$/.test(data)) return { error: ERR.chars };
  if (data.length === len - 1) return { digits: data + mod10(data) };
  if (data.length !== len) return { error: ERR.length };
  return mod10(data.slice(0, -1)) === Number(data.at(-1)) ? { digits: data } : { error: ERR.invalid };
}

/** The add-on symbol for `digits` (2 or 5): its modules. */
function addon(digits) {
  const ds = [...digits].map(Number);
  const parity = ds.length === 2 ? ['LL', 'LG', 'GL', 'GG'][(ds[0] * 10 + ds[1]) % 4]
    : SUP5_PARITY[(3 * (ds[0] + ds[2] + ds[4]) + 9 * (ds[1] + ds[3])) % 10];
  return '1011' + ds.map((d, i) => code(d, parity[i])).join('01');
}

// EAN and UPC draw at 0.9506 pt a module with 9 modules of quiet zone at each end (out2.pdf: EAN-13 107.42 pt, EAN-8 80.76 pt).
const EAN_UNIT = 0.9506;

/** EAN-13 for 12 or 13 digits; `style` \p: STD, SUP2 (12 + 2 digits), SUP5 (12 + 5) or CASE (a bearer frame). */
export function ean13(data, style = 'STD') {
  const extra = style === 'SUP2' ? 2 : style === 'SUP5' ? 5 : 0;
  if (!/^\d*$/.test(data)) return { error: ERR.chars };
  const main = extra ? data.slice(0, data.length - extra) : data;
  if (extra && (data.length !== 12 + extra && data.length !== 13 + extra)) return { error: ERR.length };
  const c = withCheck(main, 13);
  if (c.error) return c;
  const d = [...c.digits].map(Number);
  const par = EAN13_PARITY[d[0]];
  const mods = '101' + d.slice(1, 7).map((x, i) => code(x, par[i])).join('') + '01010' + d.slice(7).map((x) => code(x, 'R')).join('') + '101';
  return eanSymbol(mods, [[0, 3], [45, 50], [92, 95]], [
    { text: c.digits[0], left: -7, width: 7 }, { text: c.digits.slice(1, 7), left: 3, width: 42 }, { text: c.digits.slice(7), left: 50, width: 42 },
  ], extra ? data.slice(-extra) : null, style === 'CASE');
}

/** EAN-8 for 7 or 8 digits. */
export function ean8(data) {
  const c = withCheck(data, 8);
  if (c.error) return c;
  const d = [...c.digits].map(Number);
  const mods = '101' + d.slice(0, 4).map((x) => code(x, 'L')).join('') + '01010' + d.slice(4).map((x) => code(x, 'R')).join('') + '101';
  return eanSymbol(mods, [[0, 3], [31, 36], [64, 67]], [{ text: c.digits.slice(0, 4), left: 3, width: 28 }, { text: c.digits.slice(4), left: 36, width: 28 }]);
}

/** UPC-A for 11 or 12 digits (EAN-13 with a leading 0, drawn with its own text groups 1 + 5 + 5 + 1). */
export function upca(data, style = 'STD') {
  if (!/^\d*$/.test(data)) return { error: ERR.chars };
  const extra = style === 'SUP2' ? 2 : style === 'SUP5' ? 5 : 0;
  const main = extra ? data.slice(0, data.length - extra) : data;
  const c = withCheck(main, 12);
  if (c.error) return c;
  const sym = ean13(`0${c.digits}${extra ? data.slice(-extra) : ''}`, style);
  if (sym.error) return sym;
  const t = c.digits;
  // UPC-A's first and last pairs of digit codes are drawn as long as the guards.
  sym.guards = [[0, 10], [45, 50], [85, 95]];
  sym.text = [{ text: t[0], left: -7, width: 7 }, { text: t.slice(1, 6), left: 10, width: 35 }, { text: t.slice(6, 11), left: 50, width: 35 },
    { text: t[11], left: 96, width: 7 }];
  return sym;
}

/** The UPC-A digits a UPC-E number system `ns` and six digits `six` stand for (the zero suppression rules). */
export function upceToA(ns, six) {
  const d = [...six];
  const tail = d[5];
  let body;
  if (tail <= '2') body = `${d[0]}${d[1]}${tail}0000${d[2]}${d[3]}${d[4]}`;
  else if (tail === '3') body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  else if (tail === '4') body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  else body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${tail}`;
  return `${ns}${body}`;
}

/** UPC-E for 7 digits starting with 0, or 8 with a valid check (Word refused 1234567). */
export function upce(data) {
  if (!/^\d*$/.test(data)) return { error: ERR.chars };
  if (data.length !== 7 && data.length !== 8) return { error: ERR.length };
  if (data.length === 7 ? data[0] !== '0' : data[0] !== '0' && data[0] !== '1') return { error: ERR.invalid };
  const check = mod10(upceToA(data[0], data.slice(1, 7)));
  if (data.length === 8 && Number(data[7]) !== check) return { error: ERR.invalid };
  const ns = Number(data[0]);
  const par = UPCE_PARITY[check];
  const mods = '101' + [...data.slice(1, 7)].map((x, i) => code(Number(x), ns ? (par[i] === 'G' ? 'L' : 'G') : par[i])).join('') + '010101';
  return eanSymbol(mods, [[0, 3], [45, 51]], [{ text: data[0], left: -7, width: 7 }, { text: data.slice(1, 7), left: 3, width: 42 },
    { text: String(check), left: 52, width: 7 }]);
}

function eanSymbol(mods, guards, text, add = null, frame = false) {
  const extra = add ? '0'.repeat(10) + addon(add) : '';
  return { bars: runs(mods + extra), unit: EAN_UNIT, quiet: 9, guards, text, frame, addon: add ? { at: mods.length + 10, text: add } : null };
}

// ---------- interleaved 2 of 5 (ITF14, CASE) ----------
const I25 = ['nnwwn', 'wnnnw', 'nwnnw', 'wwnnn', 'nnwnw', 'wnwnn', 'nwwnn', 'nnnww', 'wnnwn', 'nwnwn'];

/** Interleaved 2 of 5 for an even count of digits: narrow 2 units, wide 5 (ratio 2.5), at 0.9 pt a unit. */
function itf(digits) {
  const w = (x) => (x === 'w' ? 5 : 2);
  const bars = [2, 2, 2, 2];
  for (let i = 0; i < digits.length; i += 2) {
    const a = I25[digits[i]];
    const b = I25[digits[i + 1]];
    for (let k = 0; k < 5; k++) bars.push(w(a[k]), w(b[k]));
  }
  bars.push(5, 2, 2);
  return bars;
}

/** ITF14 (\c STD 13 or 14 digits, EXT 15 or 16, ADD refused) and CASE (13 or 14 digits): a bearer frame around the bars. */
export function itf14(data, { ext = 'STD', kind = 'ITF14' } = {}) {
  if (!/^\d*$/.test(data)) return { error: ERR.chars };
  // ponytail: \c ADD's length is unknown (Word rejected 13, 17 and 18 digits); it is refused with the length error.
  const len = kind === 'CASE' || ext === 'STD' ? 14 : ext === 'EXT' ? 16 : 0;
  if (!len) return { error: ERR.length };
  const c = withCheck(data, len);
  if (c.error) return c;
  const d = c.digits;
  const groups = kind === 'CASE' ? [d.slice(0, 3), d.slice(3, 8), d.slice(8, 13), d.slice(13)].join(' ') : d;
  return { bars: itf([...d].map(Number)), unit: 0.9, quiet: 6, bearer: 10, text: [{ text: groups, at: 'all' }] };
}

// ---------- NW7 (Codabar) ----------
const NW7_CHARS = '0123456789-$:/.+abcd';
const NW7 = ('0000011 0000110 0001001 1100000 0010010 1000010 0100001 0100100 0110000 1001000 0001100 0011000 1000101 1010001 1010100 ' +
  '0010101 0011010 0101001 0001011 0001110').split(' ');

/** NW7: digits and - $ : / . + between lower-case a to d start and stop characters. Data with no ends draws between a and a,
 * as Word does (probe/fields/out4.pdf: "12345" NW7 \t shows 12345); `stops` (\d) also prints them (out2.pdf shows a12345a).
 * `check` (\x) adds the mod 16 character before the stop, not printed in the text. */
export function nw7(data, { stops = false, check = false } = {}) {
  if (!data) return { error: ERR.length };
  if ([...data].some((c) => !NW7_CHARS.includes(c))) return { error: ERR.chars };
  let d = data;
  let printed = d;
  const ends = (s) => 'abcd'.includes(s[0]) && 'abcd'.includes(s.at(-1)) && s.length >= 2;
  if (!ends(d)) {
    if (/[abcd]/.test(d)) return { error: ERR.invalid };
    d = `a${d}a`;
    if (stops) printed = d;
  }
  if (/[abcd]/.test(d.slice(1, -1))) return { error: ERR.invalid };
  const shown = [...printed].join(' ');
  if (check) {
    const sum = [...d].reduce((s, c) => s + NW7_CHARS.indexOf(c), 0);
    d = d.slice(0, -1) + NW7_CHARS[(16 - (sum % 16)) % 16] + d.at(-1);
  }
  const bars = [];
  for (const c of d) {
    if (bars.length) bars.push(1);
    bars.push(...[...NW7[NW7_CHARS.indexOf(c)]].map((x) => (x === '1' ? 3 : 1)));
  }
  return { bars, unit: 1.04, quiet: 10, text: [{ text: shown, at: 'all' }] };
}

// ---------- JPPOST (Japan Post customer barcode) ----------
// Bars: 1 long, 2 ascender (upper two thirds), 3 descender (lower two thirds), 4 tracker (middle third).
// ponytail: built from the Japan Post customer barcode rules with no Word sample to compare against (out2.pdf draws one, but its
// bars were not decoded); unverified against Word.
const JP = { 1: '114', 2: '132', 3: '312', 4: '123', 5: '141', 6: '321', 7: '213', 8: '231', 9: '411', 0: '144', '-': '414',
  CC1: '324', CC2: '342', CC3: '234', CC4: '432', CC5: '243', CC6: '423', CC7: '441', CC8: '111' };
const JP_VALUE = (k) => ('0123456789-'.includes(k) ? '0123456789-'.indexOf(k) : 10 + Number(k.slice(2)));
const JP_KEYS = Object.keys(JP);

/** The 20 Japan Post symbols of `data`: the 7-digit postal code, then the address digits, hyphens and letters (A to Z as a
 * control symbol plus a digit), padded with CC4. Full-width digits and letters count as half width. */
export function jppostSymbols(data) {
  const s = data.normalize('NFKC').toUpperCase().replace(/[\s‐-―−ー]/g, (c) => (c.trim() ? '-' : ''));
  const postal = s.replace(/-/g, '').slice(0, 7);
  if (!/^\d{7}$/.test(postal)) return null;
  // The postal code is the first seven digits, wherever its own hyphen falls.
  let k = 0;
  let digits = 0;
  while (digits < 7) if (/\d/.test(s[k++])) digits++;
  const address = s.slice(k).replace(/^-+/, '').replace(/-+/g, '-');
  const out = [...postal];
  for (const c of address) {
    if (/[0-9-]/.test(c)) out.push(c);
    else if (/[A-Z]/.test(c)) {
      const i = c.charCodeAt(0) - 65;
      out.push(`CC${1 + Math.floor(i / 10)}`, String(i % 10));
    } else return undefined;
  }
  while (out.length < 20) out.push('CC4');
  return out.slice(0, 20);
}

/** JPPOST: start, 20 symbols, the mod 19 check symbol, stop → {states: '1'...'4' per bar}. */
export function jppost(data) {
  if (!data) return { error: ERR.length };
  const syms = jppostSymbols(data);
  if (syms === undefined) return { error: ERR.chars };
  if (!syms) return { error: ERR.invalid };
  const sum = syms.reduce((t, k) => t + JP_VALUE(k), 0);
  const checkValue = (19 - (sum % 19)) % 19;
  const check = JP_KEYS.find((k) => JP_VALUE(k) === checkValue);
  const states = '13' + syms.map((k) => JP[k]).join('') + JP[check] + '31';
  return { states, pitch: 3.608, barWidth: 1.7, height: 23.76 };
}

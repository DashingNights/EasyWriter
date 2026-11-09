// Line break opportunities for the layout predictor: a small part of UAX #14 (the classes text in Word documents mostly uses),
// plus Intl.Segmenter for Thai, Lao, Khmer and Myanmar, which break between dictionary words. Explicit opportunities only:
// everything else stays together, as the editor's DOM keeps it.
// ponytail: kinsoku is partial (no break before closing punctuation or small kana) and Indic clusters stay whole only as far as
// the class table knows their marks; the full UAX #14 tables if real text shows breaks the DOM does not make.

export const AL = 0, SP = 1, BA = 2, HY = 3, B2 = 4, ZW = 5, GL = 6, OP = 7, CL = 8, EX = 9, IS = 10, SY = 11, QU = 12, NU = 13, ID = 14,
  NS = 15, CM = 16, SA = 17, PR = 18, PO = 19, ZWJ = 20;
const ASCII = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  ASCII[c] = ch === ' ' ? SP : ch === '-' ? HY : '!?'.includes(ch) ? EX : ',.:;'.includes(ch) ? IS : ch === '/' ? SY : '([{'.includes(ch) ? OP
    : ')]}'.includes(ch) ? CL : '"\''.includes(ch) ? QU : c >= 48 && c <= 57 ? NU : '$+\\'.includes(ch) ? PR : ch === '%' ? PO : AL;
}
const OPEN = new Set([0xff08, 0xff3b, 0xff5b, 0x3008, 0x300a, 0x300c, 0x300e, 0x3010, 0x3014, 0x3016, 0x3018, 0x301a, 0x201a, 0x201e]);
const CLOSE = new Set([0xff09, 0xff3d, 0xff5d, 0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x3015, 0x3017, 0x3019, 0x301b, 0x3001, 0x3002, 0xff0c,
  0xff0e, 0xfe50, 0xfe52, 0xff61, 0xff64]);
const SMALL = new Set([0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x308e, 0x3095, 0x3096, 0x30a1, 0x30a3, 0x30a5,
  0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6, 0x30fc, 0x3005, 0x309d, 0x309e, 0x30fd, 0x30fe, 0x30fb, 0xff1a, 0xff1b]);

/** The line break class of code point `c`. */
export function cls(c) {
  if (c < 128) return ASCII[c];
  if (c === 0xa0 || c === 0x2007 || c === 0x2011 || c === 0x202f || c === 0x2060 || c === 0xfeff) return GL;
  if (c === 0x200b) return ZW;
  if (c === 0x200d) return ZWJ;
  if (c === 0x200c || (c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x1f3fb && c <= 0x1f3ff) || (c >= 0x483 && c <= 0x489)
    || (c >= 0x591 && c <= 0x5c7) || (c >= 0x610 && c <= 0x61a) || (c >= 0x64b && c <= 0x65f) || (c >= 0x900 && c <= 0x903) || (c >= 0x93a && c <= 0x94f)) return CM;
  if (c === 0xad || c === 0x2010 || c === 0x2012 || c === 0x2013 || c === 0x3000 || c === 0x1680) return BA;
  if (c === 0x2014) return B2;
  if ((c >= 0x2018 && c <= 0x201f && c !== 0x201a && c !== 0x201e) || c === 0xab || c === 0xbb || c === 0x2039 || c === 0x203a) return QU;
  if (OPEN.has(c)) return OP;
  if (CLOSE.has(c)) return CL;
  if (c === 0xff01 || c === 0xff1f) return EX;
  if (SMALL.has(c)) return NS;
  if ((c >= 0x0e00 && c <= 0x0eff) || (c >= 0x1000 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff)) return SA;
  if ((c >= 0x2e80 && c <= 0x2fff) || (c >= 0x3003 && c <= 0x30ff) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x3400 && c <= 0x4dbf)
    || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x1f000 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3ffff)) return ID;
  if (c === 0x20ac || c === 0xa3 || c === 0xa5) return PR;
  if (c === 0xb0 || c === 0x2030 || c === 0xa2) return PO;
  return AL;
}

/** Whether a line may break before a character of class `cur` after one of class `prev` (`base`: the class before any spaces,
 * `pp`: the class before `prev`). */
export function canBreak(prev, cur, base, pp) {
  if (cur === CM || cur === ZWJ || prev === ZWJ) return false;
  if (prev === ZW) return true;
  if (cur === SP || cur === ZW) return false;
  if (prev === SP) {
    if (cur === CL || cur === EX || cur === IS || cur === SY) return false;
    if (base === OP) return false;
    return !(base === B2 && cur === B2);
  }
  if (prev === GL || cur === GL) return false;
  if (cur === CL || cur === EX || cur === IS || cur === SY) return false;
  if (prev === OP || prev === QU || cur === QU) return false;
  if (cur === BA || cur === HY || cur === NS) return false;
  if (prev === HY) return cur !== NU && pp !== SP && pp !== -1;
  if (prev === BA) return true;
  if (prev === B2 || cur === B2) return !(prev === B2 && cur === B2);
  if (prev === ID || cur === ID) return !(prev === ID && cur === PO) && !(prev === PR && cur === ID);
  if (prev === SY || prev === EX) return cur !== NU;
  return false;
}

let dict = null;
/** Word boundaries of the dictionary scripts in `s` (Intl.Segmenter) → Set of indexes. */
function saBounds(s) {
  dict ??= new Intl.Segmenter('th', { granularity: 'word' });
  const out = new Set();
  for (const seg of dict.segment(s)) out.add(seg.index);
  return out;
}

/** A fresh class state for a paragraph's first item (or after a line break). */
export const startState = () => ({ prev: -1, base: -1, pp: -1 });

/** Splits text item `it` at its break opportunities, carrying the class state `st` across the items of one paragraph: it.sb
 * (segment starts), it.st (where each segment's trailing spaces start), it.b0 (whether a break may come before it). */
export function segment(it, st) {
  const s = it.text;
  const n = s.length;
  const sb = [0];
  const tr = [];
  let trail = -1;
  let sa = null;
  let { prev, base, pp } = st;
  it.b0 = prev === -1;
  for (let i = 0; i < n;) {
    let c = s.charCodeAt(i);
    let w = 1;
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < n) {
      c = ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00) + 0x10000;
      w = 2;
    }
    const k = cls(c);
    if (prev !== -1) {
      let b = canBreak(prev, k, base, pp);
      if (prev === SA && k === SA) b = (sa ??= saBounds(s)).has(i);
      if (b) {
        if (i === 0) it.b0 = true;
        else {
          tr.push(trail >= 0 ? trail : i);
          sb.push(i);
        }
        trail = -1;
      }
    }
    if (k === SP) {
      if (trail < 0) trail = i;
    } else trail = -1;
    if (k !== CM && k !== ZWJ) {
      pp = prev;
      prev = k;
      if (k !== SP) base = k;
    } else if (prev === -1) prev = AL;
    i += w;
  }
  tr.push(trail >= 0 ? trail : n);
  it.sb = sb;
  it.st = tr;
  st.prev = prev;
  st.base = base;
  st.pp = pp;
}

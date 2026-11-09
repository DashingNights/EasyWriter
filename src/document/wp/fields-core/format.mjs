// The general switches of fields (docs/plans/word/index-fields.md General switches; plan.md §1.10): \* case and number formats,
// \# numeric pictures and \@ date-time pictures, with Word's error texts. Pure: the engine applies them to every result.
// Locale: the en-US document language of the probe; other languages go through Intl and are unverified.
import { bahtText, dollarText, fullWidth, halfWidth, numberSwitch, SWITCH_ERROR } from './numbers.mjs';

export const PICTURE_ERROR = 'Error! Unknown character in picture string.';
export const BOOKMARK_ERROR = 'Error! No bookmark name given.';

/** Whether field result `text` is one of Word's error texts, which draw bold. */
export const isError = (text) => typeof text === 'string' && (text.startsWith('Error!') || text.startsWith('!'));

// ---------- \* ----------
const CASES = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  // A word starts after a space or a hyphen, never after an apostrophe: o'neil mcdonald-smith gives O'neil Mcdonald-Smith.
  caps: (s) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, a, c) => a + c.toUpperCase()),
  firstcap: (s) => s.replace(/^(\s*)(\p{L})/u, (m, a, c) => a + c.toUpperCase()),
  mergeformat: (s) => s,
  mergeformatinet: (s) => s,
  charformat: (s) => s,
  dbchar: fullWidth,
  sbchar: halfWidth,
};

const NUMBER = /^\s*[-+]?(\d[\d,]*)?(\.\d+)?\s*$/;
/** `text` as a number when the whole of it is one (grouping commas allowed), else null. */
const wholeNumber = (text) => (NUMBER.test(text) && /\d/.test(text) ? Number(text.replace(/[,\s]/g, '')) : null);

/** `text` after \* switch `name` → the new text, or {error}. Number formats round decimals first (1.7 Arabic gives 2) and leave a
 * result that is no number as it is. */
export function star(text, name) {
  const key = String(name).toLowerCase();
  if (CASES[key]) return CASES[key](text);
  const n = wholeNumber(text);
  if (key === 'dollartext' || key === 'bahttext') {
    if (n == null) return text;
    const r = key === 'dollartext' ? dollarText(n) : bahtText(n);
    return r ?? { error: 'Error! Number cannot be represented in specified format.' };
  }
  const probe = numberSwitch(1, name);
  if (probe === undefined) return { error: SWITCH_ERROR };
  return n == null ? text : numberSwitch(Math.round(n), name);
}

// ---------- \# ----------
/** The number `text` starts with ("12 apples" gives 12) or null. */
export function leadingNumber(text) {
  const m = /^\s*([-+]?)[$€£¥]?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(String(text));
  return m ? Number(m[1] + m[2].replace(/,/g, '')) : null;
}

/** Splits picture `pic` into tokens: {lit} literal text, {seq} a grave-accent SEQ name, or a one-character item. */
function picTokens(pic) {
  const out = [];
  for (let i = 0; i < pic.length; i++) {
    const c = pic[i];
    if (c === "'" || c === '`') {
      const end = pic.indexOf(c, i + 1);
      const body = pic.slice(i + 1, end < 0 ? pic.length : end);
      out.push(c === "'" ? { lit: body } : { seq: body });
      i = end < 0 ? pic.length : end;
    } else out.push(c);
  }
  return out;
}

/** Splits `pic` at its section semicolons (outside quotes). */
function sections(pic) {
  const out = [''];
  let q = null;
  for (const c of pic) {
    if (q) q = c === q ? null : q;
    else if (c === "'" || c === '`') q = c;
    else if (c === ';') {
      out.push('');
      continue;
    }
    out[out.length - 1] += c;
  }
  return out;
}

const DIGIT = new Set(['0', '#', 'x']);

/** Number `n` through numeric picture `pic` (Word's \#: 0 # x . , - + 'text' `SEQ` and positive;negative;zero sections).
 * `seqOf(name)` gives a SEQ counter for the grave item. */
export function numeric(n, pic, seqOf = () => 0) {
  const secs = sections(pic);
  let sec = secs[0];
  let neg = n < 0;
  let signed = true; // a negative number in a single section still shows its minus
  if (secs.length > 1 && n < 0) {
    sec = secs[1];
    neg = false; // the negative section formats the absolute value
    signed = false;
  } else if (secs.length > 2 && n === 0) sec = secs[2];
  const abs = Math.abs(n);
  const toks = picTokens(sec);
  const point = toks.indexOf('.');
  const intToks = point < 0 ? toks : toks.slice(0, point);
  // Fraction placeholders: the run of 0, # and x straight after the point; x rounds at its place and ends the run.
  const frac = [];
  let rest = [];
  if (point >= 0) {
    let k = point + 1;
    for (; k < toks.length && DIGIT.has(toks[k]); k++) {
      frac.push(toks[k]);
      if (toks[k] === 'x') {
        k++;
        break;
      }
    }
    rest = toks.slice(k);
  }
  const fixed = abs.toFixed(frac.length);
  const [whole, fpart = ''] = fixed.split('.');
  const group = intToks.includes(',');
  const slots = intToks.filter((t) => DIGIT.has(t)).length;
  // Integer placeholders fill from the right; the leftmost takes every digit left over unless an x drops them.
  const digits = whole === '0' && !intToks.includes('0') ? '' : whole;
  let out = '';
  let used = 0;
  let sign = false;
  const intOut = [];
  for (let i = intToks.length - 1; i >= 0; i--) {
    const t = intToks[i];
    if (DIGIT.has(t)) {
      used++;
      const d = digits.length - used >= 0 ? digits[digits.length - used] : null;
      let piece = d ?? (t === '0' ? '0' : t === '#' ? ' ' : '0');
      if (used === slots && t !== 'x' && digits.length > slots) piece = digits.slice(0, digits.length - slots + 1);
      intOut.unshift(piece);
    } else if (t === ',') continue;
    else if (t === '-') {
      sign = true;
      intOut.unshift(neg ? '-' : ' ');
    } else if (t === '+') {
      sign = true;
      intOut.unshift(neg ? '-' : n === 0 ? ' ' : '+');
    } else intOut.unshift(t.lit ?? (t.seq != null ? String(seqOf(t.seq)) : t));
  }
  let intText = intOut.join('');
  if (group) intText = intText.replace(/\d+/, (run) => run.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  if (!slots && digits) intText = digits + intText;
  out = intText;
  if (point >= 0) {
    out += '.';
    // A # after the point shows a trailing zero as a space (3 through #.## gives "3.  ").
    let tail = true;
    const f = frac.map((t, i) => fpart[i]);
    for (let i = frac.length - 1; i >= 0; i--) {
      if (tail && f[i] === '0' && frac[i] === '#') f[i] = ' ';
      else tail = false;
    }
    out += f.join('');
    for (const t of rest) out += t.lit ?? (t.seq != null ? String(seqOf(t.seq)) : t);
  }
  if (neg && signed && !sign) out = `-${out}`;
  return out;
}

// ---------- \@ ----------
const fmtCache = new Map();
/** A cached Intl.DateTimeFormat for `lang` and `opts`. */
function dtf(lang, opts) {
  const k = `${lang}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(lang, opts);
    } catch {
      f = new Intl.DateTimeFormat('en-US', opts);
    }
    fmtCache.set(k, f);
  }
  return f;
}

// Word's calendar switches: \h Hijri (the Kuwaiti algorithm, Intl's tabular islamic-tbla matched the probe 5/16/1448), \s Saka,
// \u Um al-Qura (unverified in an en-US run, where Word showed the Gregorian date).
const CALENDARS = { h: 'islamic-tbla', s: 'indian', u: 'islamic-umalqura' };

/** The parts of `date` a picture reads, in calendar `cal` (null: Gregorian). */
function partsOf(date, lang, cal) {
  if (!cal) return { y: date.getFullYear(), M: date.getMonth() + 1, d: date.getDate() };
  const p = Object.fromEntries(dtf(`${lang}-u-ca-${CALENDARS[cal]}`, { year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year ?? p.relatedYear), M: Number(p.month), d: Number(p.day) };
}

/** Splits date picture `pic` into items (MMMM, dd, yyyy, h, AM/PM...) and literals → [{item}|{lit}] or {error}. */
export function dateTokens(pic) {
  const out = [];
  for (let i = 0; i < pic.length;) {
    const c = pic[i];
    if (c === "'") {
      const end = pic.indexOf("'", i + 1);
      out.push({ lit: pic.slice(i + 1, end < 0 ? pic.length : end) });
      i = end < 0 ? pic.length : end + 1;
      continue;
    }
    if (c === '`') return { error: BOOKMARK_ERROR };
    if (/^am\/pm/i.test(pic.slice(i, i + 5))) {
      out.push({ item: 'AM/PM' });
      i += 5;
      continue;
    }
    const max = { M: 4, d: 4, y: 4, h: 2, H: 2, m: 2, s: 2 }[c];
    if (!max) {
      out.push({ lit: c });
      i++;
      continue;
    }
    let k = i;
    while (pic[k] === c) k++;
    // A run longer than the longest item splits: MMMMM is MMMM then M (October10), dddddd is dddd then dd.
    for (let run = k - i; run > 0;) {
      const n = Math.min(run, max);
      if (c === 'y' && n === 3) return { error: PICTURE_ERROR };
      out.push({ item: c.repeat(c === 'y' && n < 3 ? 2 : n) });
      run -= n;
    }
    i = k;
  }
  return out;
}

/** Whether date picture `pic` shows a date at all (TIME is inserted for a time-only picture). */
export const hasDate = (pic) => /[Mdy]/.test(String(pic).replace(/'[^']*'/g, ''));

/** `date` through date-time picture `pic` → text or {error}. `date` null draws Word's never-happened date (PRINTDATE before any
 * print: 0/0/0000 0:00:00 AM, MMM as XXX). `cal`: 'h', 's' or 'u' for the calendar switches. */
export function datePicture(date, pic, { lang = 'en-US', cal = null } = {}) {
  const toks = dateTokens(String(pic));
  if (toks.error) return toks;
  const zero = date == null;
  const p = zero ? { y: 0, M: 0, d: 0 } : partsOf(date, lang, cal);
  const H = zero ? 0 : date.getHours();
  const pad = (v, n) => String(v).padStart(n, '0');
  const name = (opts) => (zero ? 'XXX' : dtf(cal ? `${lang}-u-ca-${CALENDARS[cal]}` : lang, opts).format(date));
  let out = '';
  for (const t of toks) {
    if (t.lit != null) {
      out += t.lit;
      continue;
    }
    switch (t.item) {
      case 'M': out += p.M; break;
      case 'MM': out += pad(p.M, 2); break;
      case 'MMM': out += name({ month: 'short' }); break;
      case 'MMMM': out += name({ month: 'long' }); break;
      case 'd': out += p.d; break;
      case 'dd': out += pad(p.d, 2); break;
      case 'ddd': out += name({ weekday: 'short' }); break;
      case 'dddd': out += name({ weekday: 'long' }); break;
      case 'yy': out += pad(p.y % 100, 2); break;
      case 'yyyy': out += pad(p.y, 4); break;
      case 'h': out += zero ? 0 : H % 12 || 12; break;
      case 'hh': out += zero ? '00' : pad(H % 12 || 12, 2); break;
      case 'H': out += H; break;
      case 'HH': out += pad(H, 2); break;
      case 'm': out += zero ? 0 : date.getMinutes(); break;
      case 'mm': out += pad(zero ? 0 : date.getMinutes(), 2); break;
      case 's': out += zero ? 0 : date.getSeconds(); break;
      case 'ss': out += pad(zero ? 0 : date.getSeconds(), 2); break;
      case 'AM/PM': out += H < 12 ? 'AM' : 'PM'; break; // Word wrote upper case for am/pm too
      default: out += t.item;
    }
  }
  return out;
}

/** `text` read as a date the way the probe machine read it (ISO, then day first: QUOTE "5/1/2026" was 5 January) → Date or null.
 * ponytail: day-first follows the probe's Windows region; reading the system region would need the main process's locale. */
export function parseDate(text) {
  const s = String(text).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i.exec(s);
  if (m) {
    let h = +(m[4] ?? 0);
    if (m[7]) h = (h % 12) + (/p/i.test(m[7]) ? 12 : 0);
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return new Date(y, m[2] - 1, +m[1], h, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  const t = Date.parse(s);
  return Number.isNaN(t) || !/[a-z]/i.test(s) ? null : new Date(t);
}

/** Field result `text` after parsed field `f`'s general switches, in Word's order: \@ (any result that reads as a date; skipped when
 * `datedAlready`, since date fields apply their own picture), \# (any result that starts with a number), then each \* in turn.
 * → text or {error}. */
export function applySwitches(text, f, { seqOf, lang, datedAlready = false } = {}) {
  let out = text;
  if (f.date != null && !datedAlready) {
    const d = parseDate(out);
    if (d) {
      const r = datePicture(d, f.date, { lang });
      if (r.error) return r;
      out = r;
    }
  }
  if (f.numeric != null) {
    const n = leadingNumber(out);
    if (n != null) out = numeric(n, f.numeric, seqOf);
  }
  for (const name of f.format) {
    const r = star(out, name);
    if (r.error) return r;
    out = r;
  }
  return out;
}

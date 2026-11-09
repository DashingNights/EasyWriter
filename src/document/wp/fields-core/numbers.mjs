// Word's number formats (docs/plans/word/plan.md §1.10 numfmt, index-fields.md General switches > \* format): the \* number switches
// and the ST_NumberFormat names lists and the Number dialog use. Pure; fields/numfmt.mjs re-exports numberText from here.
// Probe values are Word 16.0.20527 in an en-US document (index-fields.md); the script rows past the probe columns are unverified.
import { numberLabel } from '../../../office.mjs';

export const NUM_ERROR = 'Error! Number cannot be represented in specified format.';
export const SWITCH_ERROR = 'Error! Unknown switch argument.';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const under100 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
const under1000 = (n) => {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return h ? `${ONES[h]} hundred${r ? ` ${under100(r)}` : ''}` : under100(r);
};

/** English cardinal words for 0 to 999999 (Word's CardText: no "and", tens and units hyphenated) → null above. */
export function cardText(n) {
  if (n < 0 || n >= 1e6) return null;
  const th = Math.floor(n / 1000);
  const r = n % 1000;
  if (!th) return under1000(r);
  return `${under1000(th)} thousand${r ? ` ${under1000(r)}` : ''}`;
}

const IRREGULAR = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** English ordinal words (Word's OrdText: 0 is zeroth, 27 twenty-seventh) → null from 1,000,000. */
export function ordText(n) {
  const card = cardText(n);
  if (card == null) return null;
  return card.replace(/[a-z]+$/, (w) => IRREGULAR[w] ?? (w.endsWith('y') ? `${w.slice(0, -1)}ieth` : `${w}th`));
}

/** 11 → 11th, 21 → 21st, 112 → 112th. */
export const ordinal = (n) => {
  const t = Math.abs(n) % 100;
  const u = Math.abs(n) % 10;
  return `${n}${t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th'}`;
};

/** Word's DollarText: the whole part in words and the cents over 100. Cents that round to 100 wrap to 00 without carrying, as
 * Word does (28.999 gives twenty-eight and 00/100). → null from 1,000,000 or below 0. */
export function dollarText(x) {
  if (!(x >= 0) || x >= 1e6) return null;
  const whole = Math.floor(x);
  const cents = Math.round((x - whole) * 100) % 100;
  return `${cardText(whole)} and ${String(cents).padStart(2, '0')}/100`;
}

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'],
  [4, 'iv'], [1, 'i']];
/** Lower-case roman numerals to 32767 (4000 is mmmm; 0 a space) → null outside. */
export function roman(n) {
  if (n < 0 || n > 32767) return null;
  if (n === 0) return ' ';
  let out = '';
  for (const [v, s] of ROMAN) for (; n >= v; n -= v) out += s;
  return out;
}

/** Word's alphabetic: 1 is a, 27 aa, 52 zz, 53 aaa (letters repeat), to 780; 0 a space → null outside. */
export function alphabetic(n) {
  if (n < 0 || n > 780) return null;
  if (n === 0) return ' ';
  return String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
}

// ---------- scripts (index-fields.md East Asian and other script formats) ----------
const chars = (s) => [...s];
const CIRCLED = chars('①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳');
const STOP = chars('⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛');
const PAREN = chars('⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇');
const IDEO_PAREN = chars('㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩');
const STEMS = chars('甲乙丙丁戊己庚辛壬癸');
const BRANCHES = chars('子丑寅卯辰巳午未申酉戌亥');
const AIUEO = chars('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン');
const IROHA = chars('イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス');
const CHOSUNG = chars('ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ');
const GANADA = chars('가나다라마바사아자차카타파하');
const THAI = chars('กขคงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ');
const ABJAD = chars('ابجدهوزحطيكلمنسعفصقرشتثخذضظغ');
const ARABIC_ALPHA = chars('ابتثجحخدذرزسشصضطظعغفقكلمنهوي');
const HEBREW = chars('אבגדהוזחטיכלמנסעפצקרשת');
const CJK = chars('〇一二三四五六七八九');
const LEGAL = chars('零壹贰叁肆伍陆柒捌玖');

/** Item n (1-based) of `list`, cycling past its end, or null for 0 and below. */
const cycle = (list, n) => (n >= 1 ? list[(n - 1) % list.length] : null);
/** Item n of `list` while n is inside it, else the plain number (Word's GB and zodiac rows fall back to digits). */
const within = (list, n) => (n >= 1 && n <= list.length ? list[n - 1] : String(n));
/** `n`'s digits mapped through `digits` (10 characters for 0 to 9). */
const digitsIn = (n, digits) => String(n).replace(/\d/g, (d) => digits[d]);

/** Chinese counting with the unit characters 十 百 千 (or the financial 拾 佰 仟) below 10000: 28 is 二十八 or 贰拾捌. */
function chinese(n, legal) {
  const d = legal ? LEGAL : CJK;
  const units = legal ? ['', '拾', '佰', '仟'] : ['', '十', '百', '千'];
  if (n === 0) return d[0];
  if (n >= 10000) return digitsIn(n, d); // ponytail: 万 and above not done, digit by digit there
  const s = String(n);
  let out = '';
  let zero = false;
  for (let i = 0; i < s.length; i++) {
    const v = +s[i];
    const place = s.length - 1 - i;
    if (v === 0) {
      zero = true;
      continue;
    }
    if (zero && out) out += d[0];
    zero = false;
    // 10 to 19 read 十, 十一 in the plain form, as Word's DBNum1 does
    out += (v === 1 && place === 1 && i === 0 && !legal ? '' : d[v]) + units[place];
  }
  return out;
}

/** Hebrew letters as numbers (Hebrew1: 28 is כח), 15 and 16 written טו and טז. */
function hebrewNum(n) {
  if (n < 1) return null;
  const vals = [[400, 'ת'], [300, 'ש'], [200, 'ר'], [100, 'ק'], [90, 'צ'], [80, 'פ'], [70, 'ע'], [60, 'ס'], [50, 'נ'], [40, 'מ'], [30, 'ל'],
    [20, 'כ'], [10, 'י'], [9, 'ט'], [8, 'ח'], [7, 'ז'], [6, 'ו'], [5, 'ה'], [4, 'ד'], [3, 'ג'], [2, 'ב'], [1, 'א']];
  let out = '';
  let r = n % 1000;
  for (const [v, s] of vals) {
    if (r === 15 || r === 16) {
      out += r === 15 ? 'טו' : 'טז';
      r = 0;
    }
    for (; r >= v; r -= v) out += s;
  }
  return out;
}

const THAI_DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const THAI_PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
/** Thai cardinal words (28 is ยี่สิบแปด) below 1,000,000. */
function thaiText(n) {
  if (n === 0) return THAI_DIGITS[0];
  const s = String(n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const v = +s[i];
    const place = s.length - 1 - i;
    if (!v) continue;
    if (place === 1 && v === 1) out += 'สิบ';
    else if (place === 1 && v === 2) out += 'ยี่สิบ';
    else if (place === 0 && v === 1 && s.length > 1) out += 'เอ็ด';
    else out += THAI_DIGITS[v] + THAI_PLACES[place];
  }
  return out;
}

const VIET = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
/** Vietnamese cardinal words below 1000 (28 is hai mươi tám); unverified past the probe value. */
function vietText(n) {
  if (n >= 1000) return null;
  const h = Math.floor(n / 100);
  const t = Math.floor(n / 10) % 10;
  const u = n % 10;
  const parts = [];
  if (h) parts.push(`${VIET[h]} trăm`);
  if (t > 1) parts.push(`${VIET[t]} mươi`);
  else if (t === 1) parts.push('mười');
  else if (h && u) parts.push('linh');
  if (u) parts.push(t > 1 && u === 1 ? 'mốt' : t >= 1 && u === 5 ? 'lăm' : VIET[u]);
  return parts.length ? parts.join(' ') : VIET[0];
}

const FULL = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, '　');
const HALF = (s) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');

/** The text of whole number `n` in \* number switch `name` (Word's spelling, case-blind except alphabetic and roman) → a string,
 * {error} when the number is out of range, or undefined when `name` is no number switch. */
export function numberSwitch(n, name) {
  const key = String(name).toLowerCase();
  const err = (v) => (v == null ? { error: NUM_ERROR } : v);
  switch (key) {
    case 'arabic': return String(n);
    case 'arabicdash': return `- ${n} -`;
    case 'alphabetic': return err(alphabetic(n) && (name === 'ALPHABETIC' ? alphabetic(n).toUpperCase() : alphabetic(n)));
    case 'roman': return err(roman(n) && (name === 'ROMAN' ? roman(n).toUpperCase() : roman(n)));
    case 'ordinal': return ordinal(n);
    case 'ordtext': return err(ordText(n));
    case 'cardtext': return err(cardText(n));
    case 'hex': return n < 0 ? { error: NUM_ERROR } : n.toString(16).toUpperCase();
    case 'circlenum': case 'gb3': return within(CIRCLED, n);
    case 'gb1': return within(STOP, n);
    case 'gb2': return within(PAREN, n);
    case 'gb4': return within(IDEO_PAREN, n);
    case 'dbchar': return FULL(String(n));
    case 'sbchar': return String(n);
    case 'dbnum1': case 'kanjinum1': case 'chinesenum1': case 'dbnum3': case 'kanjinum3': case 'chinesenum3': return chinese(n, false);
    case 'dbnum2': case 'kanjinum2': case 'chinesenum2': return chinese(n, true);
    case 'dbnum4': return digitsIn(n, CJK);
    case 'aiueo': return err(cycle(AIUEO, n));
    case 'iroha': return err(cycle(IROHA, n));
    case 'zodiac1': return within(STEMS, n);
    case 'zodiac2': return within(BRANCHES, n);
    case 'zodiac3': return n >= 1 ? STEMS[(n - 1) % 10] + BRANCHES[(n - 1) % 12] : String(n);
    case 'chosung': return err(cycle(CHOSUNG, n));
    case 'ganada': return err(cycle(GANADA, n));
    case 'hebrew1': return err(hebrewNum(n));
    case 'hebrew2': return n >= 1 ? `‏${n <= 22 ? HEBREW[n - 1] : HEBREW[21] + HEBREW[(n - 23) % 22]}` : { error: NUM_ERROR };
    case 'arabicabjad': return n >= 1 ? `‌${cycle(ABJAD, n)}` : { error: NUM_ERROR };
    case 'arabicalpha': return n >= 1 ? `${cycle(ARABIC_ALPHA, n)}‌` : { error: NUM_ERROR };
    case 'hindiarabic': return digitsIn(n, chars('०१२३४५६७८९'));
    case 'thaiarabic': return digitsIn(n, chars('๐๑๒๓๔๕๖๗๘๙'));
    case 'thailetter': return err(cycle(THAI, n));
    case 'thaicardtext': return n < 0 || n >= 1e6 ? { error: NUM_ERROR } : thaiText(n);
    case 'vietcardtext': return err(n < 0 ? null : vietText(n));
    // ponytail: HindiCardText, HindiLetter1 and HindiLetter2 draw Devanagari digits until their word and letter lists are probed
    case 'hindicardtext': case 'hindiletter1': case 'hindiletter2': return digitsIn(n, chars('०१२३४५६७८९'));
    default: return undefined;
  }
}

/** BahtText: Thai currency words (28 is ยี่สิบแปดบาทถ้วน, 28.5 ยี่สิบแปดบาทห้าสิบสตางค์). */
export function bahtText(x) {
  if (!(x >= 0) || x >= 1e6) return null;
  const whole = Math.floor(x);
  const satang = Math.round((x - whole) * 100) % 100;
  return `${thaiText(whole)}บาท${satang ? `${thaiText(satang)}สตางค์` : 'ถ้วน'}`;
}

/** Text in full-width (DBCHAR) or half-width (SBCHAR) forms. */
export const fullWidth = FULL;
export const halfWidth = HALF;

// ST_NumberFormat names (w:numFmt) to \* switch names, for lists, page numbers and the Number dialog.
const ST = {
  decimal: 'Arabic', numberInDash: 'ArabicDash', lowerLetter: 'alphabetic', upperLetter: 'ALPHABETIC', lowerRoman: 'roman', upperRoman: 'ROMAN',
  ordinal: 'Ordinal', ordinalText: 'OrdText', cardinalText: 'CardText', hex: 'Hex', decimalEnclosedCircle: 'CircleNum',
  decimalEnclosedFullstop: 'GB1', decimalEnclosedParen: 'GB2', ideographEnclosedCircle: 'GB4', decimalFullWidth: 'DBCHAR',
  decimalHalfWidth: 'SBCHAR', chineseCounting: 'DBNum1', chineseLegalSimplified: 'DBNum2', chineseCountingThousand: 'DBNum1',
  ideographTraditional: 'Zodiac1', ideographZodiac: 'Zodiac2', ideographZodiacTraditional: 'Zodiac3', aiueo: 'Aiueo', iroha: 'Iroha',
  aiueoFullWidth: 'Aiueo', irohaFullWidth: 'Iroha', chosung: 'Chosung', ganada: 'Ganada', hebrew1: 'Hebrew1', hebrew2: 'Hebrew2',
  arabicAlpha: 'ArabicAlpha', arabicAbjad: 'ArabicAbjad', hindiNumbers: 'HindiArabic', hindiCounting: 'HindiCardText',
  hindiVowels: 'HindiLetter2', hindiConsonants: 'HindiLetter1', thaiNumbers: 'ThaiArabic', thaiLetters: 'ThaiLetter',
  thaiCounting: 'ThaiCardText', vietnameseCounting: 'VietCardText', japaneseCounting: 'DBNum1', japaneseLegal: 'DBNum2',
  japaneseDigitalTenThousand: 'DBNum4', decimalZero: null, none: null, bullet: null,
};

/** Number `n` in ST_NumberFormat `fmt` (plan.md §1.10): Word's text, String(n) for a format without a rule here. decimalZero pads to
 * two digits; none gives ''. Where the \* switch has no text (an error out of range, or its space for 0 in letters and roman) a
 * list label keeps the earlier numberLabel's: '' for 0, letters past 780 and roman past 32767, else the plain number. */
export function numberText(n, fmt) {
  if (fmt === 'none') return '';
  if (fmt === 'decimalZero') return n >= 0 && n < 10 ? `0${n}` : String(n);
  const name = ST[fmt];
  const r = name ? numberSwitch(n, name) : undefined;
  return typeof r === 'string' && r !== ' ' ? r : numberLabel(n, fmt);
}

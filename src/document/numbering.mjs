// List labels of a Document's flat list paragraphs (docs/plans/document.md Lists, docs/plans/word plan.md §1.8 and §3 lists): each
// numbered paragraph holds {numId, ilvl} (or gets it from its paragraph style's para.numbering) and doc.attrs.numbering holds the
// definitions (numbering.xml: abstract levels and the nums that use them). Also Word's libraries (bullets, numbering, multilevel
// lists), the number styles, and the list operations as pure functions: lists.js and the lists package apply them, Node tests
// check them.
import { numberText } from './wp/fields-core/numbers.mjs';
import { DEFAULT_NUMBERING, LIST_ABSTRACTS } from './defaults.mjs';
import { styleChain, styleIdOf } from './model/styles.mjs';

export const MAX_LEVEL = 8;
const PT_CM = 72 / 2.54;
const cm = (v) => Math.round(v * PT_CM * 100) / 100;

// ---------- number styles ----------
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };

/** `n` in English words ('twenty-seven'), up to 999999. */
function words(n) {
  if (n < 20) return ONES[n] || 'zero';
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ''}`;
  return `${words(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${words(n % 1000)}` : ''}`;
}
/** The ordinal of English words: the last word takes 'th' or its own form ('twenty-first'). */
const ordinalWords = (w) => w.replace(/([a-z]+)$/, (last) => ORD[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`));
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const suffix = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');

// Chinese counting (v: Word knowledge, not observed): digits and the ten, hundred and thousand units; 10 to 19 drop the leading one.
function counting(n, digits, units) {
  if (n <= 0 || n > 9999) return String(n);
  const parts = String(n).split('').map(Number);
  let out = '';
  let zero = false;
  parts.forEach((d, i) => {
    const u = parts.length - 1 - i;
    if (!d) {
      zero = out !== '';
      return;
    }
    if (zero) out += digits[0];
    zero = false;
    out += (d === 1 && u === 1 && i === 0 && !units.legal ? '' : digits[d]) + (u ? units[u] : '');
  });
  return out;
}
const CN = '〇一二三四五六七八九';
const UNITS_CN = ['', '十', '百', '千'];
const LEGAL_TW = Object.assign(['', '拾', '佰', '仟'], { legal: true });
const LEGAL_CN = Object.assign(['', '拾', '佰', '仟'], { legal: true });
const cycle = (chars, n) => chars[(n - 1) % chars.length];
// A letter list past its last letter doubles it, as Word's a, b, c do (aa after z; unverified for the other scripts).
const letters = (chars, n) => (n < 1 ? String(n) : chars[(n - 1) % chars.length].repeat(Math.ceil(n / chars.length)));
const digits = (n, set) => String(n).replace(/\d/g, (d) => set[d]);
const CJK_DIGITS = [...'〇一二三四五六七八九'];
const KO_DIGITS = [...'영일이삼사오육칠팔구'];
// Half-width katakana as Word's aiueo and iroha lists draw them (ヰ and ヱ have no half-width form).
const AIUEO_HALF = [...'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ'];
const IROHA_HALF = [...'ｲﾛﾊﾆﾎﾍﾄﾁﾘﾇﾙｦﾜｶﾖﾀﾚｿﾂﾈﾅﾗﾑｳヰﾉｵｸﾔﾏｹﾌｺｴﾃｱｻｷﾕﾒﾐｼヱﾋﾓｾｽ'];
const ARABIC_ALPHA = [...'أبتثجحخدذرزسشصضطظعغفقكلمنهوي'];
const ARABIC_ABJAD = [...'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ'];
const HEBREW = [...'אבגדהוזחטיכלמנסעפצקרשת'];
// Word's hindiVowels draws the consonants and hindiConsonants the vowels (all-features.pdf: क, ख, ग and अ, आ, इ).
const HINDI_CONSONANTS = [...'कखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह'];
const HINDI_VOWELS = ['अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ऋ', 'ए', 'ऐ', 'ओ', 'औ'];
const HINDI_WORDS = ['', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ', 'दस'];
const KO_NATIVE = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉'];
const KO_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
const RUSSIAN = [...'абвгдежзиклмнопрстуфхцчшщэюя'];

/** Label of item `n` (from 1) in OOXML number format `fmt` (ST_NumberFormat); `format` is a custom format's pattern ('001, 002,
 * 003, ...'), whose first number's width pads the label with zeros. The East Asian sets follow Word's names (v: unverified). */
export function formatNumber(n, fmt, format) {
  switch (fmt) {
    case 'none': return '';
    case 'bullet': return '';
    case 'decimalZero': return String(n).padStart(2, '0');
    case 'custom': return String(n).padStart(/^\d+/.exec(format ?? '')?.[0].length ?? 1, '0');
    case 'decimalFullWidth': return String(n).replace(/\d/g, (d) => String.fromCharCode(0xff10 + +d));
    case 'ordinal': return `${n}${suffix(n)}`;
    case 'cardinalText': return capital(words(n));
    case 'ordinalText': return capital(ordinalWords(words(n)));
    case 'taiwaneseCountingThousand':
    case 'chineseCountingThousand':
    case 'chineseCounting':
    case 'taiwaneseCounting': return counting(n, CN, UNITS_CN);
    case 'ideographLegalTraditional': return counting(n, '零壹貳參肆伍陸柒捌玖', LEGAL_TW);
    case 'chineseLegalSimplified': return counting(n, '零壹贰叁肆伍陆柒捌玖', LEGAL_CN);
    case 'ideographTraditional': return cycle('甲乙丙丁戊己庚辛壬癸', n);
    case 'ideographZodiac': return cycle('子丑寅卯辰巳午未申酉戌亥', n);
    // The formats whose list labels differ from the field switches' (fields-core numbers.mjs numberText draws the rest).
    case 'chicago': return letters(['*', '†', '‡', '§'], n);
    case 'ideographDigital':
    case 'taiwaneseDigital':
    case 'koreanDigital2': return digits(n, CJK_DIGITS);
    case 'japaneseLegal': return counting(n, '〇壱弐参四伍六七八九', Object.assign(['', '拾', '百', '阡'], { legal: true }));
    case 'aiueo': return letters(AIUEO_HALF, n);
    case 'iroha': return letters(IROHA_HALF, n);
    case 'decimalFullWidth2': return formatNumber(n, 'decimalFullWidth');
    case 'decimalEnclosedCircleChinese': return numberText(n, 'decimalEnclosedCircle');
    case 'koreanDigital': return digits(n, KO_DIGITS);
    case 'koreanCounting': return counting(n, KO_DIGITS, ['', '십', '백', '천']);
    case 'koreanLegal': return n > 0 && n < 100 ? KO_TENS[Math.floor(n / 10)] + KO_NATIVE[n % 10] : counting(n, KO_DIGITS, ['', '십', '백', '천']);
    case 'arabicAlpha': return letters(ARABIC_ALPHA, n);
    case 'arabicAbjad': return letters(ARABIC_ABJAD, n);
    case 'hebrew2': return letters(HEBREW, n);
    case 'hindiVowels': return letters(HINDI_CONSONANTS, n);
    case 'hindiConsonants': return letters(HINDI_VOWELS, n);
    case 'hindiCounting': return HINDI_WORDS[n] || numberText(n, 'hindiNumbers'); // ponytail: words to ten, digits past it
    case 'russianLower': return letters(RUSSIAN, n);
    case 'russianUpper': return letters(RUSSIAN, n).toUpperCase();
    default: return numberText(n, fmt);
  }
}

/** Word's Number style list (Define New Number Format, Define New Multilevel List, probe/dialogs), in its order: [id, label, fmt,
 * format]. The id is the fmt, or the custom pattern's first number for the zero-padded ones. */
export const NUMBER_STYLES = [
  ['none', '(none)', 'none'], ['decimal', '1, 2, 3, …', 'decimal'], ['decimalFullWidth', 'Double byte …', 'decimalFullWidth'],
  ['upperRoman', 'I, II, III, …', 'upperRoman'], ['lowerRoman', 'i, ii, iii, …', 'lowerRoman'], ['upperLetter', 'A, B, C, …', 'upperLetter'],
  ['lowerLetter', 'a, b, c, …', 'lowerLetter'], ['taiwaneseCountingThousand', '一, 二, 三 (繁)…', 'taiwaneseCountingThousand'],
  ['ideographLegalTraditional', '壹, 貳, 參 …', 'ideographLegalTraditional'], ['chineseCountingThousand', '一, 二, 三 (简)…', 'chineseCountingThousand'],
  ['chineseLegalSimplified', '壹, 贰, 叁 …', 'chineseLegalSimplified'], ['ideographTraditional', '甲, 乙, 丙 …', 'ideographTraditional'],
  ['ideographZodiac', '子, 丑, 寅 …', 'ideographZodiac'], ['ordinal', '1st, 2nd, 3rd …', 'ordinal'], ['cardinalText', 'One, Two, Three …', 'cardinalText'],
  ['ordinalText', 'First, Second, Third …', 'ordinalText'], ['decimalZero', '01, 02, 03, …', 'decimalZero'],
  ['001', '001, 002, 003, …', 'custom', '001, 002, 003, ...'], ['0001', '0001, 0002, 0003, …', 'custom', '0001, 0002, 0003, ...'],
  ['00001', '00001, 00002, 00003, …', 'custom', '00001, 00002, 00003, ...'],
];
/** The NUMBER_STYLES id of level `lvl`. */
export const styleIdOfLevel = (lvl) => (lvl?.fmt === 'custom' ? /^\d+/.exec(lvl.format ?? '')?.[0] ?? 'decimal' : lvl?.fmt ?? 'decimal');
/** The level keys {fmt, format} of NUMBER_STYLES id `id`. */
export function styleLevel(id) {
  const s = NUMBER_STYLES.find(([i]) => i === id) ?? NUMBER_STYLES[1];
  return { fmt: s[2], format: s[3] };
}

// ---------- labels ----------
/** The level definition {fmt, text, start, left, hanging, ...} of `ilvl` in num `numId`, or null. */
export function levelOf(numbering, numId, ilvl) {
  const num = numbering?.nums?.[numId];
  return numbering?.abstract?.[num?.abstract]?.levels?.[ilvl] ?? null;
}

/** 'bullet' or 'number' for num `numId` (by its first level), or null when the num is unknown. */
export function kindOf(numbering, numId) {
  const lvl = levelOf(numbering, numId, 0);
  return lvl ? (lvl.fmt === 'bullet' ? 'bullet' : 'number') : null;
}

/** The start value of level `k` of num `num` on `levels`: the num's override, then (level 1) the num's v1 start, then the level's. */
const startOf = (num, levels, k) => num?.overrides?.[k]?.start ?? (k === 0 && num?.start != null ? num.start : levels[k]?.start ?? 1);

/** Label text of level `lvl` for the counts `c` of its list: lvlText with each %N filled with level N's count in its format (all
 * decimal under Legal style numbering, isLgl); a bullet level is its glyph. */
export function labelText(lvl, levels, c, start = (k) => levels[k]?.start ?? 1) {
  if (lvl.fmt === 'bullet') return lvl.text ?? '';
  return (lvl.text ?? '').replace(/%([1-9])/g, (_, d) => {
    const L = levels[d - 1];
    const n = c[d - 1] ?? start(d - 1);
    // Legal style turns roman, letter and the other formats into decimal but keeps the zero-padded ones ('01', '001').
    const keep = !lvl.isLgl || L?.fmt === 'none' || L?.fmt === 'decimalZero' || L?.fmt === 'custom';
    return keep ? formatNumber(n, L?.fmt ?? 'decimal', L?.format) : String(n);
  });
}

/** The labels of `items` (the numbering attrs {numId, ilvl} of the numbered paragraphs, in document order) under `numbering`:
 * one string per item, null where the num or level is unknown. Each num counts on its own, so numbering continues across the
 * paragraphs between its items and a new num restarts at its start value (its override first); an item resets the deeper
 * levels that restart after its level (lvlRestart, by default every deeper level; 0 never). */
export function listLabels(items, numbering) {
  const counts = new Map(); // numId → count per level
  return items.map((it) => {
    if (!it) return null;
    const { numId, ilvl } = it;
    const num = numbering?.nums?.[numId];
    const levels = numbering?.abstract?.[num?.abstract]?.levels;
    const lvl = levels?.[ilvl];
    if (!lvl) return null;
    const start = (k) => startOf(num, levels, k);
    const key = String(numId);
    const c = counts.get(key) ?? [];
    counts.set(key, c);
    c[ilvl] = (c[ilvl] ?? start(ilvl) - 1) + 1;
    for (let j = ilvl + 1; j < c.length; j++) {
      const r = levels[j]?.restart ?? j;
      if (r > ilvl) c[j] = undefined;
    }
    return labelText(lvl, levels, c, start);
  });
}

/** The numbering of paragraph `node` in `doc` (a ProseMirror doc or JSON doc with attrs): its own {numId, ilvl}, else its paragraph
 * style's para.numbering (List Bullet, a heading linked to a multilevel list); null when it has none or numId 0 (Word's "no
 * numbering" over a numbered style). */
export function numOf(doc, node) {
  const own = node.attrs?.numbering;
  if (own && !('numId' in own)) return null; // the doc node: its numbering attribute holds the definitions
  if (own) return own.numId === 0 ? null : own;
  if (own === undefined) return null;
  const chain = styleChain(doc, styleIdOf(node));
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i].para?.numbering;
    if (n !== undefined) return n?.numId ? { numId: n.numId, ilvl: n.ilvl ?? 0 } : null;
  }
  return null;
}

let lastKey = 0;
/** A key for a list that a parse or paste brings in (Markdown, HTML lists, Word's mso-list): negative, so it never names a num.
 * Its paragraphs carry numbering {numId: key, ilvl, abstract} until the list gets a num of its own (numberNewLists here,
 * lists.js for an open Document), so separate lists count separately, as in Word. */
export const newListKey = () => --lastKey;

// ---------- libraries ----------
const level = (fmt, text, i, left, hanging, more) => ({ fmt, text, start: 1, left, hanging, ...more, ...(fmt === 'bullet' && { glyph: text }) });
const nine = (f) => Array.from({ length: 9 }, (_, i) => f(i));

/** Word's Bullet Library in its order: the glyph drawn (Unicode) with Word's own font and code, kept for docx export. */
export const BULLETS = [
  { id: 'solidCircle', label: 'Solid Circle', char: '•', font: 'Symbol', code: 'F0B7' },
  { id: 'solidCircleLarge', label: 'Solid Circle', char: '●', font: 'Wingdings', code: 'F06C' },
  { id: 'hollowCircle', label: 'Hollow Circle', char: 'o', font: 'Courier New', code: '006F' },
  { id: 'solidSquare', label: 'Solid Square', char: '▪', font: 'Wingdings', code: 'F0A7' },
  { id: 'fourDiamonds', label: 'Four Small Diamonds', char: '❖', font: 'Wingdings', code: 'F076' },
  { id: 'hollowArrow', label: 'Hollow Arrow', char: '➢', font: 'Wingdings', code: 'F0D8' },
  { id: 'checkmark', label: 'Checkmark', char: '✓', font: 'Wingdings', code: 'F0FC' },
];

/** Word's Numbering Library in its order (probe/menus/home.numbering.json): the first level's fmt and text; I. and i. are
 * right-aligned, their number ending at the aligned-at position. */
export const NUMBERINGS = [
  { id: 'decimal', label: '1.', fmt: 'decimal', text: '%1.' },
  { id: 'decimalParen', label: '1)', fmt: 'decimal', text: '%1)' },
  { id: 'upperRomanRight', label: 'I.', fmt: 'upperRoman', text: '%1.', jc: 'right' },
  { id: 'upperLetter', label: 'A.', fmt: 'upperLetter', text: '%1.' },
  { id: 'lowerLetterParen', label: 'a)', fmt: 'lowerLetter', text: '%1)' },
  { id: 'lowerLetter', label: 'a.', fmt: 'lowerLetter', text: '%1.' },
  { id: 'lowerRomanRight', label: 'i.', fmt: 'lowerRoman', text: '%1.', jc: 'right' },
];

const H = (i) => `Heading${i + 1}`;
const twips = (t) => t / 20;
/** Word's List Library of multilevel lists in the gallery's order (probe/menus/home.multilevel-list.json). Positions are the
 * probe's cm where its description shows them; the deeper levels follow Word's definitions (v). `link`: levels linked to Heading 1
 * to 9 (pStyle), so a heading of that style is numbered through its style. */
export const MULTILEVEL = [
  { id: 'paren', label: '1) a) i)', levels: nine((i) => level(['decimal', 'lowerLetter', 'lowerRoman'][i % 3],
    [`%${i + 1})`, `(%${i + 1})`, `%${i + 1}.`][Math.floor(i / 3)], i, 18 * (i + 1), 18)) },
  { id: 'outline', label: '1. 1.1. 1.1.1.', levels: nine((i) => level('decimal', `${nine((k) => `%${k + 1}.`).slice(0, i + 1).join('')}`, i,
    twips([360, 792, 1224, 1728, 2232, 2736, 3240, 3744, 4320][i]), twips([360, 432, 504, 648, 792, 936, 1080, 1224, 1440][i]))) },
  { id: 'bullets', label: '❖ ➢ ▪ ●', levels: nine((i) => level('bullet', ['❖', '➢', '▪', '●'][i % 4], i, 18 * (i + 1), 18)) },
  { id: 'article', label: 'Article I.', link: true, levels: nine((i) => [
    level('upperRoman', 'Article %1.', i, 0, 0), level('decimalZero', 'Section %1.%2', i, 0, 0, { isLgl: true }),
    level('lowerLetter', '(%3)', i, 36, 21.6), level('lowerRoman', '(%4)', i, 43.2, 14.4, { jc: 'right' }),
    level('decimal', '%5)', i, 50.4, 21.6), level('lowerLetter', '%6)', i, 57.6, 21.6), level('lowerRoman', '%7)', i, 64.8, 14.4, { jc: 'right' }),
    level('lowerLetter', '%8.', i, 72, 21.6), level('lowerRoman', '%9.', i, 79.2, 14.4, { jc: 'right' })][i]) },
  { id: 'headings', label: '1 1.1 1.1.1', link: true, levels: nine((i) => level('decimal', nine((k) => `%${k + 1}`).slice(0, i + 1).join('.'), i,
    [cm(0.76), cm(1.02), 36, 43.2, 50.4, 57.6, 64.8, 72, 79.2][i], [cm(0.76), cm(1.02), 36, 43.2, 50.4, 57.6, 64.8, 72, 79.2][i])) },
  { id: 'roman', label: 'I. A. 1.', link: true, levels: nine((i) => level(['upperRoman', 'upperLetter', 'decimal', 'lowerLetter', 'decimal',
    'lowerLetter', 'lowerRoman', 'lowerLetter', 'lowerRoman'][i], ['%1.', '%2.', '%3.', '%4)', '(%5)', '(%6)', '(%7)', '(%8)', '(%9)'][i], i,
  i ? cm(1.27 * i) : 0, 0)) },
  { id: 'chapter', label: 'Chapter 1', link: true, levels: nine((i) => (i ? level('bullet', '', i, 0, 0) : level('decimal', 'Chapter %1', i, 0, 0))) },
].map((m) => ({ ...m, levels: m.link ? m.levels.map((l, i) => ({ ...l, pStyle: H(i) })) : m.levels }));

/** Every definition a list command can add: the defaults, LIST_ABSTRACTS, the Numbering Library's and the multilevel lists. */
export const ABSTRACTS = {
  ...LIST_ABSTRACTS,
  ...Object.fromEntries(NUMBERINGS.map((n) => [n.id, { levels: DEFAULT_NUMBERING.abstract.decimal.levels.map((l, i) => (i ? l
    : { ...l, fmt: n.fmt, text: n.text, ...(n.jc && { jc: n.jc }) })) }])),
  ...Object.fromEntries(MULTILEVEL.map((m) => [`ml.${m.id}`, { levels: m.levels }])),
};

// ---------- nums and definitions ----------
/** `numbering` with a new num on definition `abstract` (copied from ABSTRACTS on first use; a definition neither has becomes
 * 'decimal'), and that num's id. `more` adds num keys (overrides). */
export function addNum(numbering, abstract, more) {
  const numId = Math.max(0, ...Object.keys(numbering.nums).map(Number).filter(Number.isFinite)) + 1;
  const out = setNumsAbstract(numbering, [numId], abstract);
  if (more) out.nums[numId] = { ...out.nums[numId], ...more };
  return { numId, numbering: out };
}

/** `numbering` with nums `numIds` (new ones made) on definition `abstract`, added as addNum adds it; a num keeps its start. */
export function setNumsAbstract(numbering, numIds, abstract) {
  const a = numbering.abstract[abstract] || ABSTRACTS[abstract] ? abstract : 'decimal';
  const nums = { ...numbering.nums };
  for (const id of numIds) nums[id] = { ...nums[id], abstract: a };
  return { ...numbering, abstract: numbering.abstract[a] ? numbering.abstract : { ...numbering.abstract, [a]: structuredClone(ABSTRACTS[a]) }, nums };
}

const sameLevels = (a, b) => a.length === b.length && a.every((l, i) => Object.keys({ ...l, ...b[i] }).every((k) =>
  JSON.stringify(l[k]) === JSON.stringify(b[i][k])));

/** `numbering` with a definition holding `levels`: a known one with the same levels (the document's or a library one), else a new
 * customN, so no edit ever changes a definition other lists share. → {numbering, abstract}. */
export function settle(numbering, levels, extra = {}) {
  const known = { ...ABSTRACTS, ...numbering.abstract };
  let a = Object.keys(known).find((name) => sameLevels(known[name].levels, levels) && known[name].name === extra.name);
  if (!a) {
    let i = 1;
    while (known[`custom${i}`]) i++;
    a = `custom${i}`;
  }
  const abstract = numbering.abstract[a] ? numbering.abstract : { ...numbering.abstract, [a]: { ...(known[a] ?? {}), ...extra, levels } };
  return { numbering: { ...numbering, abstract }, abstract: a };
}

/** `numbering` with num `numId`'s levels replaced by `f(levels)` (a list of nine level objects), through settle. */
export function patchLevels(numbering, numId, f, extra) {
  const num = numbering.nums[numId];
  const cur = numbering.abstract[num?.abstract] ?? ABSTRACTS[num?.abstract];
  if (!cur) return numbering;
  const s = settle(numbering, f(structuredClone(cur.levels)), { ...(cur.name && { name: cur.name }), ...extra });
  return { ...s.numbering, nums: { ...s.numbering.nums, [numId]: { ...num, abstract: s.abstract } } };
}

/** `numbering` with level object `pick` (fmt, text with %1, jc, glyph or pic) on the levels that `items` (the selected paragraphs'
 * numbering) are at, through their whole lists, as Word's library changes the selected level of the list. Null when an item is
 * outside a list or at a level of the other kind (bullet or number). */
export function setListLevels(numbering, items, pick) {
  const bullet = (lvl) => lvl.fmt === 'bullet';
  if (!items.length || !items.every((n) => n && levelOf(numbering, n.numId, n.ilvl) && bullet(levelOf(numbering, n.numId, n.ilvl)) === bullet(pick))) return null;
  let out = numbering;
  for (const numId of new Set(items.map((n) => n.numId))) {
    const ilvls = new Set(items.filter((n) => n.numId === numId).map((n) => n.ilvl));
    out = patchLevels(out, numId, (levels) => levels.map((l, k) => {
      if (!ilvls.has(k)) return l;
      const { glyph, pic, jc, format, ...rest } = l;
      return { ...rest, fmt: pick.fmt, text: (pick.text ?? '').replaceAll('%1', `%${k + 1}`), ...(pick.glyph && { glyph: pick.glyph }),
        ...(pick.pic && { pic: pick.pic }), ...(pick.metafile && { metafile: pick.metafile }), ...(pick.jc && { jc: pick.jc }), ...(pick.format && { format: pick.format }) };
    }));
  }
  return out;
}

/** `numbering` with definition `abstract`'s first level (the Numbering library's pick) on the levels `items` are at (setListLevels). */
export function setListFormat(numbering, items, abstract) {
  const pick = (numbering.abstract[abstract] ?? ABSTRACTS[abstract])?.levels[0];
  return pick ? setListLevels(numbering, items, pick) : null;
}

/** `numbering` with the lists of `content` (TipTap JSON nodes numbered on `source`, another Document's numbering) brought in on
 * definitions and nums of their own (Insert > Text from File) → {numbering, content}; a num the source lacks leaves its
 * paragraph unnumbered. */
export function adoptLists(numbering, source, content) {
  let out = numbering;
  const made = new Map(); // source numId → numId
  const walk = (node) => {
    const n = node.attrs?.numbering;
    if (n?.numId != null) {
      if (!made.has(n.numId)) {
        const num = source?.nums?.[n.numId];
        const def = num && source.abstract?.[num.abstract];
        if (def) {
          let id = `${num.abstract}`;
          for (let k = 2; out.abstract[id] && JSON.stringify(out.abstract[id]) !== JSON.stringify(def); k++) id = `${num.abstract}-${k}`;
          out = { ...out, abstract: { ...out.abstract, [id]: structuredClone(def) } };
          const { abstract, ...more } = num;
          const added = addNum(out, id, Object.keys(more).length ? structuredClone(more) : undefined);
          out = added.numbering;
          made.set(n.numId, added.numId);
        } else made.set(n.numId, null);
      }
      const numId = made.get(n.numId);
      const { numbering: _, ...rest } = node.attrs;
      node.attrs = numId == null ? rest : { ...node.attrs, numbering: { ...n, numId } };
    }
    node.content?.forEach(walk);
  };
  const copy = structuredClone(content);
  copy.forEach(walk);
  return { numbering: out, content: copy };
}

/** TipTap JSON `doc` of a new Document (its attrs.numbering set) with each list its content brought in on a num of its own. */
export function numberNewLists(doc) {
  let numbering = doc.attrs.numbering;
  const made = new Map(); // key:abstract → numId
  const walk = (node) => {
    const n = node.attrs?.numbering;
    if (n?.abstract) {
      const key = `${n.numId}:${n.abstract}`;
      if (!made.has(key)) {
        const added = addNum(numbering, n.abstract);
        numbering = added.numbering;
        made.set(key, added.numId);
      }
      node.attrs = { ...node.attrs, numbering: { numId: made.get(key), ilvl: n.ilvl } };
    }
    node.content?.forEach(walk);
  };
  doc.content?.forEach(walk);
  return { ...doc, attrs: { ...doc.attrs, numbering } };
}

// ---------- list operations over all numbered paragraphs ----------
// `all` is the numbering {numId, ilvl} of every numbered paragraph in document order; each operation returns {numbering, set}
// where set maps an index of `all` to its new numbering. lists.js writes both in one transaction.

/** The indices from `i` on that are in `all[i]`'s list (its num), to the document's end. */
const restOf = (all, i) => all.map((n, k) => (k >= i && n?.numId === all[i].numId ? k : -1)).filter((k) => k >= 0);

/** Restart at `start` (Restart at 1, Set Numbering Value's Start new list): item `i` and the rest of its list at its level or
 * deeper (at the first level, the rest of the list) get a new num on the same definition, with a start override at the item's
 * level when `start` is not that level's own start. Below the first level the new num also starts each parent level at the
 * parent's number, so 2.2. restarted reads 2.1. and the next first-level item stays 3. on the old num. */
export function restartAt(numbering, all, i, start = 1) {
  const n = all[i];
  const num = numbering.nums[n?.numId];
  if (!num) return null;
  const overrides = {};
  for (let k = i - 1, min = n.ilvl; k >= 0 && min > 0; k--) { // the item's parents, nearest first
    if (all[k]?.numId !== n.numId || all[k].ilvl >= min) continue;
    min = all[k].ilvl;
    overrides[min] = { start: valueAt(numbering, all, k) };
  }
  const lvl = levelOf(numbering, n.numId, n.ilvl);
  if ((start ?? 1) !== (lvl?.start ?? 1)) overrides[n.ilvl] = { start };
  const added = addNum(numbering, num.abstract, Object.keys(overrides).length ? { overrides } : undefined);
  const rest = restOf(all, i);
  const end = rest.findIndex((k) => all[k].ilvl < n.ilvl);
  return { numbering: added.numbering, set: new Map(rest.slice(0, end < 0 ? rest.length : end).map((k) => [k, { numId: added.numId, ilvl: all[k].ilvl }])) };
}

/** The index of the last item before `i` in another list on the same definition (the list Continue Numbering joins), or -1. */
export function previousList(numbering, all, i) {
  const a = numbering.nums[all[i]?.numId]?.abstract;
  for (let k = i - 1; k >= 0; k--) if (all[k] && all[k].numId !== all[i].numId && numbering.nums[all[k].numId]?.abstract === a) return k;
  return -1;
}

/** Continue Numbering (and Set Numbering Value's Continue from previous list): item `i` and the rest of its list join the previous
 * list on the same definition. With `value` (Advance value) above the number it would get, they take a new num starting there
 * instead. Null when there is no previous list. */
export function continueAt(numbering, all, i, value = null) {
  const k = previousList(numbering, all, i);
  if (k < 0) return null;
  const prev = all[k].numId;
  const set = new Map(restOf(all, i).map((j) => [j, { numId: prev, ilvl: all[j].ilvl }]));
  if (value != null && value > valueAt(numbering, all.map((n, j) => set.get(j) ?? n), i)) return restartAt(numbering, all, i, value);
  return { numbering, set };
}

/** The number item `i` of `all` counts at its level (Set Numbering Value's "Set value to" starts there). */
export function valueAt(numbering, all, i) {
  const n = all[i];
  const num = numbering.nums[n?.numId];
  const levels = numbering.abstract[num?.abstract]?.levels;
  if (!levels) return 1;
  let c = startOf(num, levels, n.ilvl) - 1;
  for (let k = 0; k <= i; k++) {
    const m = all[k];
    if (m?.numId !== n.numId) continue;
    if (m.ilvl === n.ilvl) c++;
    else if (m.ilvl < n.ilvl && (levels[n.ilvl]?.restart ?? n.ilvl) > m.ilvl) c = startOf(num, levels, n.ilvl) - 1;
  }
  return c;
}

/** Adjust List Indents on level `ilvl` of num `numId`: number position `pos` and text indent `text` (pt) become left = text and
 * hanging = text - pos; `suff` ('tab', 'space', 'nothing') and `tab` (pt or null) as given. */
export function adjustIndents(numbering, numId, ilvl, { pos, text, suff, tab }) {
  return patchLevels(numbering, numId, (levels) => levels.map((l, k) => {
    if (k !== ilvl) return l;
    const { tab: _, ...rest } = l;
    return { ...rest, left: text, hanging: text - pos, suff: suff ?? l.suff ?? 'tab', ...(tab != null && { tab }) };
  }));
}

// ---------- keys ----------
/** Enter in an empty list item (editing.enterEmptyList): one level up while it is deeper than the first (U), else the list ends.
 * → the paragraph's new numbering, null for no list. */
export const enterEmpty = (n) => (n.ilvl > 0 ? { ...n, ilvl: n.ilvl - 1 } : null);

/** Backspace at the start of paragraph text (editing.backspaceList, autoformat.tabIndent): a list item loses its number and keeps
 * its text indent; then the indent goes (the first-line indent first); then Backspace joins as usual. `para` is {numbered, indent,
 * level: the level's {left, hanging}}, `tabIndent` the AutoFormat option. → {numbering: null, indent} | {indent} | null to join. */
export function backspaceStep({ numbered, indent, level: lvl }, tabIndent = true) {
  const i = indent ?? {};
  if (numbered) return { numbering: null, indent: lvl ? { ...i, left: i.left ?? lvl.left } : indent ?? null };
  if (!tabIndent) return null;
  if (i.firstLine) {
    const { firstLine, ...rest } = i;
    return { indent: Object.keys(rest).length ? rest : null };
  }
  if (i.left) {
    const { left, ...rest } = i;
    return { indent: Object.keys(rest).length ? rest : null };
  }
  return null;
}

/** Tab at the start of a non-list paragraph with text under autoformat.tabIndent: the first press sets a first-line indent of one
 * default stop, later presses raise the left indent by one (Word, P/index-editing.md line 62). → the new indent. */
export function tabIndentStep(indent, stop = 36) {
  const i = indent ?? {};
  return i.firstLine > 0 ? { ...i, left: (i.left ?? 0) + stop } : { ...i, firstLine: stop };
}

// ---------- AutoFormat ----------
// Typed at a paragraph start and followed by a space or Tab (P/index-editing.md line 137-138). Bullets: * gives •, - a dash, > and
// the arrows an arrow (U: the glyphs Word picks for > -> => are unverified). Numbers: only 1, A, a, I and i start a list ('5. ' stays text).
const AUTO_BULLETS = { '*': '•', '-': '–', '>': '➢', '->': '→', '=>': '⇨' };
const AUTO_NUMBERS = { '1.': ['decimal', '%1.'], '1)': ['decimal', '%1)'], '(1)': ['decimal', '(%1)'], 'A.': ['upperLetter', '%1.'],
  'a)': ['lowerLetter', '%1)'], 'I.': ['upperRoman', '%1.'], 'i.': ['lowerRoman', '%1.'] };

/** The list that typing `typed` (a paragraph's text before the space or Tab) starts: {kind: 'bullets', glyph} or {kind:
 * 'numbering', fmt, text}, or null. */
export function autoFormatList(typed) {
  const t = typed.replace(/^\s+/, '');
  if (AUTO_BULLETS[t]) return { kind: 'bullets', fmt: 'bullet', glyph: AUTO_BULLETS[t], text: AUTO_BULLETS[t] };
  if (AUTO_NUMBERS[t]) return { kind: 'numbering', fmt: AUTO_NUMBERS[t][0], text: AUTO_NUMBERS[t][1] };
  return null;
}

/** The definition's levels with level 1 set to `pick` (fmt, text, glyph) over `base` ('bullet' or 'decimal'). */
export const firstLevelAs = (pick, base) => ABSTRACTS[base].levels.map((l, i) => {
  if (i) return l;
  const { glyph, pic, jc, format, ...rest } = l;
  return { ...rest, fmt: pick.fmt, text: pick.text, ...(pick.glyph && { glyph: pick.glyph }), ...(pick.pic && { pic: pick.pic }), ...(pick.metafile && { metafile: pick.metafile }),
    ...(pick.jc && { jc: pick.jc }), ...(pick.format && { format: pick.format }) };
});

// ---------- LISTNUM ----------
/** The named LISTNUM lists Word ships (fields.json LISTNUM): NumberDefault 1) a) i), LegalDefault 1. 1.1. 1.1.1., OutlineDefault
 * (the probe's \s 5 gives "5.", so its first level is decimal with a period, v for the deeper levels). */
export const LISTNUM_LISTS = {
  numberdefault: MULTILEVEL[0].levels,
  legaldefault: MULTILEVEL[1].levels,
  outlinedefault: nine((i) => level(['decimal', 'upperLetter', 'decimal', 'lowerLetter', 'decimal', 'lowerLetter', 'lowerRoman', 'lowerLetter',
    'lowerRoman'][i], ['%1.', '%2.', '%3.', '%4)', '(%5)', '(%6)', '(%7)', '(%8)', '(%9)'][i], i, 0, 0)),
};

/** The text of the last LISTNUM field in `seq`, the document up to it in order: {para: {numId, ilvl} | null} for each paragraph start
 * (numbered or not) and {field: {name, level, start}} for each LISTNUM field (level 1-based or null, start or null). A named field
 * counts in its list (the built-in names, or a definition whose ListNum field list name matches); a field with no name continues
 * the paragraph's list one level below the paragraph's, or the last list item above at its level. ponytail: list paragraphs after
 * a field do not count its number. */
export function listNumText(seq, numbering) {
  const counts = new Map(); // list key → counts per level
  const bump = (key, levels, ilvl, start) => {
    const c = counts.get(key) ?? [];
    counts.set(key, c);
    c[ilvl] = start != null ? start : (c[ilvl] ?? (levels[ilvl]?.start ?? 1) - 1) + 1;
    for (let j = ilvl + 1; j < c.length; j++) c[j] = undefined;
    return c;
  };
  let last = null; // the last list item: {numId, ilvl}
  let inPara = null; // the numbering of the paragraph being walked
  let out = '';
  const all = [];
  for (const e of seq) {
    if ('para' in e) {
      inPara = e.para;
      if (e.para) {
        all.push(e.para);
        last = e.para;
      }
      continue;
    }
    const f = e.field;
    const name = (f.name ?? '').toLowerCase();
    let levels = LISTNUM_LISTS[name];
    let key = `name:${name}`;
    let ilvl = f.level != null ? f.level - 1 : 0;
    if (!levels && name) {
      const a = Object.values(numbering?.abstract ?? {}).find((x) => x.name?.toLowerCase() === name);
      levels = a?.levels ?? LISTNUM_LISTS.numberdefault;
    }
    if (!levels) {
      const base = inPara ?? last;
      if (base) {
        const num = numbering?.nums?.[base.numId];
        levels = numbering?.abstract?.[num?.abstract]?.levels;
        key = `num:${base.numId}`;
        if (!counts.has(key)) {
          // Seed the list's counts from its paragraphs so far.
          const c = [];
          for (const n of all) if (n.numId === base.numId) {
            c[n.ilvl] = (c[n.ilvl] ?? startOf(num, levels, n.ilvl) - 1) + 1;
            for (let j = n.ilvl + 1; j < c.length; j++) c[j] = undefined;
          }
          counts.set(key, c);
        }
        if (f.level == null) ilvl = inPara ? Math.min(MAX_LEVEL, inPara.ilvl + 1) : base.ilvl;
      }
      levels ??= LISTNUM_LISTS.numberdefault;
    }
    ilvl = Math.max(0, Math.min(MAX_LEVEL, ilvl));
    const c = bump(key, levels, ilvl, f.start);
    out = labelText(levels[ilvl], levels, c);
  }
  return out;
}

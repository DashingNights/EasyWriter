// Dictation (SPEC §7h): pure helpers of the push-to-talk transcription loop. No imports; inputs are never mutated.

export const RATE = 16000; // whisper's sample rate: the capture AudioContext runs at it
const FRAME = RATE * 0.03; // 30 ms level frames
const SPEECH = 0.01; // frame RMS above this (about -40 dBFS) counts as sound

export const DICTATION_DEFAULTS = {
  installed: false,
  model: 'small',
  language: 'en',
  languages: [], // with language 'auto': the ones it picks from ([] = any)
  micId: '', // '' = the system default microphone
  serverPath: '',
  modelPath: '',
  serverUrl: '',
};

/** Every language whisper knows (whisper.cpp `g_lang`, in its order), each in its own name. 'auto' is not in the list. */
export const LANGUAGES = [
  ['en', 'English'], ['zh', '中文'], ['de', 'Deutsch'], ['es', 'Español'], ['ru', 'Русский'], ['ko', '한국어'],
  ['fr', 'Français'], ['ja', '日本語'], ['pt', 'Português'], ['tr', 'Türkçe'], ['pl', 'Polski'], ['ca', 'Català'],
  ['nl', 'Nederlands'], ['ar', 'العربية'], ['sv', 'Svenska'], ['it', 'Italiano'], ['id', 'Bahasa Indonesia'], ['hi', 'हिन्दी'],
  ['fi', 'Suomi'], ['vi', 'Tiếng Việt'], ['he', 'עברית'], ['uk', 'Українська'], ['el', 'Ελληνικά'], ['ms', 'Bahasa Melayu'],
  ['cs', 'Čeština'], ['ro', 'Română'], ['da', 'Dansk'], ['hu', 'Magyar'], ['ta', 'தமிழ்'], ['no', 'Norsk'],
  ['th', 'ไทย'], ['ur', 'اردو'], ['hr', 'Hrvatski'], ['bg', 'Български'], ['lt', 'Lietuvių'], ['la', 'Latina'],
  ['mi', 'Te Reo Māori'], ['ml', 'മലയാളം'], ['cy', 'Cymraeg'], ['sk', 'Slovenčina'], ['te', 'తెలుగు'], ['fa', 'فارسی'],
  ['lv', 'Latviešu'], ['bn', 'বাংলা'], ['sr', 'Српски'], ['az', 'Azərbaycan dili'], ['sl', 'Slovenščina'], ['kn', 'ಕನ್ನಡ'],
  ['et', 'Eesti'], ['mk', 'Македонски'], ['br', 'Brezhoneg'], ['eu', 'Euskara'], ['is', 'Íslenska'], ['hy', 'Հայերեն'],
  ['ne', 'नेपाली'], ['mn', 'Монгол'], ['bs', 'Bosanski'], ['kk', 'Қазақ тілі'], ['sq', 'Shqip'], ['sw', 'Kiswahili'],
  ['gl', 'Galego'], ['mr', 'मराठी'], ['pa', 'ਪੰਜਾਬੀ'], ['si', 'සිංහල'], ['km', 'ខ្មែរ'], ['sn', 'chiShona'],
  ['yo', 'Yorùbá'], ['so', 'Soomaali'], ['af', 'Afrikaans'], ['oc', 'Occitan'], ['ka', 'ქართული'], ['be', 'Беларуская'],
  ['tg', 'Тоҷикӣ'], ['sd', 'سنڌي'], ['gu', 'ગુજરાતી'], ['am', 'አማርኛ'], ['yi', 'ייִדיש'], ['lo', 'ລາວ'],
  ['uz', 'Oʻzbekcha'], ['fo', 'Føroyskt'], ['ht', 'Kreyòl ayisyen'], ['ps', 'پښتو'], ['tk', 'Türkmençe'], ['nn', 'Nynorsk'],
  ['mt', 'Malti'], ['sa', 'संस्कृतम्'], ['lb', 'Lëtzebuergesch'], ['my', 'မြန်မာ'], ['bo', 'བོད་ཡིག'], ['tl', 'Tagalog'],
  ['mg', 'Malagasy'], ['as', 'অসমীয়া'], ['tt', 'Татарча'], ['haw', 'ʻŌlelo Hawaiʻi'], ['ln', 'Lingála'], ['ha', 'Hausa'],
  ['ba', 'Башҡортса'], ['jw', 'Basa Jawa'], ['su', 'Basa Sunda'], ['yue', '粵語'],
];

/** The languages people pick from: LANGUAGES with Chinese as its two scripts (the user, 2026-10-26). Whisper has one Chinese
 * ('zh') and writes either script; whisperLanguages asks for the picked one. A 'zh' saved before stays Chinese in either. */
export const PICK_LANGUAGES = LANGUAGES.flatMap((l) => (l[0] === 'zh' ? [['zh-Hans', '中文（简体）'], ['zh-Hant', '中文（繁體）']] : [l]));
/** A picked language's own name ('zh' too), or its code. */
export const languageName = (code) => [...PICK_LANGUAGES, ...LANGUAGES].find(([c]) => c === code)?.[1] ?? code;

const ENGLISH = new Intl.DisplayNames(['en'], { type: 'language' });
/** A language's English name ('yue' → Cantonese, 'zh-Hant' → Traditional Chinese). whisper's 'jw' is no ISO code. */
export const englishName = (code) => (code === 'jw' ? 'Javanese' : ENGLISH.of(code));

// More names a language is searched by, besides its own, its English one and its code.
const OTHER_NAMES = {
  'zh-Hans': 'Mandarin Putonghua 普通话 汉语 简体', 'zh-Hant': 'Mandarin Guoyu 國語 普通話 繁體 繁体 Taiwan',
  yue: 'Guangdonghua 廣東話 广东话 粤语 Hong Kong', fa: 'Farsi', tl: 'Filipino Pilipino',
  he: 'Ivrit', pa: 'Panjabi', my: 'Myanmar', km: 'Cambodian', ht: 'Creole', sw: 'Kiswahili', no: 'Bokmål', nn: 'Norwegian',
  ja: 'Nihongo', ko: 'Hangugeo', el: 'Hellenic', ms: 'Malaysian', id: 'Indonesia', es: 'Castilian', ca: 'Valencian',
};

/** Where each language is spoken, for the language list's groups; one spoken widely in several places is in each. */
export const REGIONS = [
  ['Europe', 'en de es ru fr pt pl ca nl sv it fi uk el cs ro da hu no hr bg lt la cy sk lv sr sl et mk br eu is bs sq gl oc be yi fo nn mt lb tt ba'],
  ['Americas', 'en es pt fr ht'],
  ['Asia', 'zh-Hans zh-Hant yue ja ko hi bn ur pa gu mr ta te kn ml si ne as sa sd ps fa ar he tr az hy ka kk uz tk tg mn ru tt ba bo my th lo km vi id ms jw su tl'],
  ['Africa', 'ar sw am so ha yo sn ln mg af en fr pt'],
  ['Oceania', 'en mi haw'],
].map(([region, codes]) => [region, PICK_LANGUAGES.filter(([code]) => codes.split(' ').includes(code))]);

const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const SEARCH = new Map(PICK_LANGUAGES.map(([code, name]) => [code, ` ${fold(`${code} ${name} ${englishName(code)} ${OTHER_NAMES[code] ?? ''}`)}`]));

/** The languages a search finds, in PICK_LANGUAGES order: a word of any of their names (or the code) starts with it; a search in
 * another script than Latin may also match inside a word (語 finds 粵語). Accents are ignored. */
export function findLanguages(query) {
  const q = fold(query.trim());
  if (!q) return PICK_LANGUAGES;
  return PICK_LANGUAGES.filter(([code]) => SEARCH.get(code).includes(` ${q}`) || (/[^\x00-\x7f]/.test(q) && SEARCH.get(code).includes(q)));
}

/** The languages the user speaks (settings.dictation): [] = any (Automatic), one = only it, more = Automatic among them. */
export const spoken = ({ language = 'en', languages = [] } = {}) => (language === 'auto' ? languages : [language || 'en']);

/** spoken()'s list → the settings.dictation fields. */
export const spokenFields = (list) => ({ language: list.length === 1 ? list[0] : 'auto', languages: list.length > 1 ? list : [] });

/** Whether the model (an id or a model file's name) knows Cantonese ('yue'), which whisper added in large-v3 (Best quality).
 * Small and Base have no token for it: asked for it, they write dots. */
export const knowsCantonese = (model) => /v3/i.test(model);

// Tried on Small with a Cantonese clip: as Chinese it came out in Mandarin wording, with this line as the prompt in Cantonese.
const CANTONESE_PROMPT = '我哋今日去咗飲茶，佢話唔得閒，係咪真㗎？';

// Whisper writes Chinese in either script; a line in the picked one steers it (tried on Small with two clips: each line gave its
// script, while with none it wrote Traditional).
const SCRIPT_PROMPT = { 'zh-Hans': '以下是普通话的句子。', 'zh-Hant': '以下是普通話的句子。' };

/** settings.dictation and the model → what transcribe asks whisper for: `codes` ([] = any language, one = only it, more =
 * Automatic among them) and a `prompt`. Simplified and Traditional Chinese go as Chinese with a line in that script; Cantonese
 * on a model without it goes as Chinese with a line of written Cantonese. */
export function whisperLanguages(d, model) {
  const list = spoken(d);
  const cantonese = list.includes('yue') && !knowsCantonese(model);
  const codes = [...new Set(list.map((l) => (SCRIPT_PROMPT[l] || (cantonese && l === 'yue') ? 'zh' : l)))];
  // ponytail: one prompt per request, which reaches every language in it. Cantonese on Small wins over a script (Chinese and
  // Cantonese together there both come out in Cantonese wording); Best quality tells them apart.
  return { codes, prompt: cantonese ? CANTONESE_PROMPT : SCRIPT_PROMPT[list.find((l) => SCRIPT_PROMPT[l])] ?? '' };
}

/** After an Automatic pass over `codes`: the listed language to transcribe again with, or null when the text stands (the
 * likeliest language is listed, or the server sent no probabilities). `probs`: whisper-server's verbose_json
 * language_probabilities, {code: p} above 0.001. */
export function retryLanguage(codes, probs) {
  const found = Object.keys(probs ?? {});
  if (!found.length) return null;
  const likeliest = (list) => list.reduce((a, b) => ((probs[b] ?? 0) > (probs[a] ?? 0) ? b : a));
  return codes.includes(likeliest(found)) ? null : likeliest(codes);
}

/** Mono float samples (-1…1) → a 16-bit PCM WAV file. */
export function encodeWav(samples, rate = RATE) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at, s) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); // fmt chunk size
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, 1, true); // mono
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); // byte rate
  out.setUint16(32, 2, true); // block align
  out.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}

/** RMS level of each whole 30 ms frame. */
export function frameLevels(samples) {
  const levels = new Float32Array(Math.floor(samples.length / FRAME));
  for (let f = 0; f < levels.length; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i] * samples[i];
    levels[f] = Math.sqrt(sum / FRAME);
  }
  return levels;
}

/** At least 150 ms of sound: worth sending to the model (silence only makes it hallucinate). */
export const hasSpeech = (samples) => frameLevels(samples).filter((l) => l > SPEECH).length >= 5;

/** Where to commit the uncommitted audio `samples` (a sample index), or -1 to keep it open: the middle of the last pause
 * of at least `pauseMs` that follows sound; past `maxSec` without one, the quietest frame of the last 4 s. */
export function commitPoint(samples, { pauseMs = 600, maxSec = 20 } = {}) {
  const levels = frameLevels(samples);
  const need = Math.ceil(pauseMs / 30);
  let heard = false;
  let run = 0;
  let cut = -1;
  levels.forEach((l, f) => {
    if (l > SPEECH) {
      heard = true;
      run = 0;
    } else if (heard && ++run >= need) {
      cut = (f + 1 - run / 2) * FRAME;
    }
  });
  if (cut >= 0 || samples.length < maxSec * RATE) return Math.floor(cut);
  let quiet = levels.length - 1;
  for (let f = Math.max(0, levels.length - Math.round(4 / 0.03)); f < levels.length; f++) if (levels[f] < levels[quiet]) quiet = f;
  return (quiet + 1) * FRAME;
}

/** The model's text without non-speech tags ("[BLANK_AUDIO]", a lone "(music)") and with single spaces. */
export function cleanText(text) {
  const t = String(text ?? '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^\([^)]*\)$/.test(t) ? '' : t;
}

export const joinText = (...parts) => parts.filter(Boolean).join(' ');

// Dictation (SPEC §7h): pure helpers of the push-to-talk transcription loop. No imports; inputs are never mutated.

export const RATE = 16000; // whisper's sample rate: the capture AudioContext runs at it
const FRAME = RATE * 0.03; // 30 ms level frames
const SPEECH = 0.01; // frame RMS above this (about -40 dBFS) counts as sound

export const DICTATION_DEFAULTS = {
  installed: false,
  model: 'small',
  language: 'en',
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

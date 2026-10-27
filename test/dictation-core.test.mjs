import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, commitPoint, encodeWav, englishName, findLanguages, hasSpeech, joinText, languageName, LANGUAGES, PICK_LANGUAGES, RATE, REGIONS,
  retryLanguage, spoken, spokenFields, whisperLanguages,
} from '../src/app/dictation/core.mjs';

// `ms` of a 220 Hz tone at amplitude `amp` (0 = silence).
const tone = (ms, amp = 0.3) => Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE));
const cat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};

test('encodeWav writes a 16 kHz mono 16-bit PCM WAV with clamped samples', () => {
  const wav = encodeWav(Float32Array.of(0, 1, -1, 2, -0.5));
  const v = new DataView(wav.buffer);
  const ascii = (at, n) => String.fromCharCode(...wav.slice(at, at + n));
  assert.equal(wav.length, 44 + 10);
  assert.deepEqual([ascii(0, 4), ascii(8, 8), ascii(36, 4)], ['RIFF', 'WAVEfmt ', 'data']);
  assert.deepEqual([v.getUint32(4, true), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)],
    [46, 1, 1, 16000, 16, 10]);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true)), [0, 32767, -32767, 32767, -16383]);
});

test('the language list: every whisper language once, English first, each in its own name, no Automatic', () => {
  const codes = LANGUAGES.map(([code]) => code);
  assert.equal(LANGUAGES.length, 100);
  assert.equal(new Set(codes).size, 100);
  assert.deepEqual(LANGUAGES[0], ['en', 'English']);
  assert.ok(!codes.includes('auto'));
  assert.deepEqual(['de', 'ja', 'cy', 'yue'].map((c) => LANGUAGES.find(([code]) => code === c)[1]), ['Deutsch', '日本語', 'Cymraeg', '粵語']);
});

test('the language search: English and other names find a language by any word start; every language has a region', () => {
  const codes = (q) => findLanguages(q).map(([c]) => c);
  assert.deepEqual([englishName('yue'), englishName('jw'), englishName('zh')], ['Cantonese', 'Javanese', 'Chinese']);
  assert.deepEqual(codes('cantonese'), ['yue']);
  assert.deepEqual(codes('MANDARIN'), ['zh-Hans', 'zh-Hant']);
  assert.deepEqual(codes('chin'), ['zh-Hans', 'zh-Hant']); // Simplified / Traditional Chinese
  assert.deepEqual([codes('traditional'), codes('繁體'), codes('简体')], [['zh-Hant'], ['zh-Hant'], ['zh-Hans']]);
  assert.deepEqual(codes('東話'), ['yue']); // inside a word (廣東話) in another script
  assert.deepEqual(codes('語'), ['zh-Hant', 'ja', 'yue']);
  assert.deepEqual(codes('espanol'), ['es']); // accents ignored
  assert.deepEqual(codes('farsi'), ['fa']);
  assert.ok(!codes('an').includes('en'), 'a word start, not anywhere');
  assert.equal(findLanguages('  ').length, 101); // whisper's 100, Chinese as two scripts
  assert.deepEqual([languageName('zh-Hans'), languageName('zh-Hant'), languageName('zh'), languageName('xx')], ['中文（简体）', '中文（繁體）', '中文', 'xx']);
  const placed = new Set(REGIONS.flatMap(([, list]) => list.map(([c]) => c)));
  assert.deepEqual(PICK_LANGUAGES.filter(([c]) => !placed.has(c)), []);
  assert.deepEqual(REGIONS.map(([r]) => r), ['Europe', 'Americas', 'Asia', 'Africa', 'Oceania']);
});

test('languages: the list round-trips through the settings; Cantonese goes as Chinese with a prompt on Small; a retry only off the list', () => {
  assert.deepEqual([spoken({}), spoken({ language: 'auto' }), spoken({ language: 'auto', languages: ['en', 'yue'] })], [['en'], [], ['en', 'yue']]);
  assert.deepEqual([[], ['ja'], ['en', 'yue']].map((l) => spoken(spokenFields(l))), [[], ['ja'], ['en', 'yue']]);
  const both = spokenFields(['en', 'yue']);
  assert.deepEqual(whisperLanguages(both, 'ggml-large-v3-turbo-q5_0.bin'), { codes: ['en', 'yue'], prompt: '' });
  const small = whisperLanguages(both, 'ggml-small.bin');
  assert.deepEqual(small.codes, ['en', 'zh']);
  assert.match(small.prompt, /我哋/);
  assert.deepEqual(whisperLanguages({ language: 'zh' }, 'ggml-small.bin'), { codes: ['zh'], prompt: '' }); // saved before the scripts
  assert.deepEqual(whisperLanguages({ language: 'zh-Hans' }, 'ggml-small.bin'), { codes: ['zh'], prompt: '以下是普通话的句子。' });
  assert.deepEqual(whisperLanguages(spokenFields(['en', 'zh-Hant']), 'ggml-large-v3-turbo-q5_0.bin'), { codes: ['en', 'zh'], prompt: '以下是普通話的句子。' });
  assert.match(whisperLanguages(spokenFields(['zh-Hans', 'yue']), 'ggml-small.bin').prompt, /我哋/); // Cantonese on Small wins
  assert.equal(retryLanguage(['en', 'zh'], { zh: 0.98, en: 0.003 }), null); // the likeliest is listed: its text stands
  assert.equal(retryLanguage(['en', 'zh'], { cy: 0.6, en: 0.3, zh: 0.01 }), 'en');
  assert.equal(retryLanguage(['en', 'yue'], { ja: 0.9 }), 'en'); // neither listed one came back: the first
  assert.equal(retryLanguage(['en', 'zh'], undefined), null); // a server without probabilities
});

test('hasSpeech: silence and a click are not speech, 200 ms of sound is', () => {
  assert.equal(hasSpeech(tone(2000, 0)), false);
  assert.equal(hasSpeech(cat(tone(1000, 0), tone(60), tone(1000, 0))), false);
  assert.equal(hasSpeech(cat(tone(500, 0), tone(200))), true);
});

test('commitPoint: the middle of the last pause of 600 ms after sound; none before sound or while it is short', () => {
  assert.equal(commitPoint(cat(tone(1000), tone(300, 0), tone(500))), -1); // a short pause stays open
  assert.equal(commitPoint(cat(tone(1500, 0), tone(500))), -1); // leading silence is not a pause
  const cut = commitPoint(cat(tone(1000), tone(900, 0), tone(500), tone(800, 0), tone(400)));
  assert.ok(cut > RATE * 2.4 && cut < RATE * 3.0, String(cut / RATE)); // inside the second pause (2.4 s … 3.2 s)
  const ongoing = commitPoint(cat(tone(1000), tone(1200, 0)));
  assert.ok(ongoing > RATE * 1.2 && ongoing < RATE * 2.2, String(ongoing / RATE));
});

test('commitPoint: 20 s without a pause cuts at the quietest moment of the last 4 s', () => {
  const quiet = tone(90, 0.02); // still sound, but the quietest
  const audio = cat(tone(17000), quiet, tone(3500));
  const cut = commitPoint(audio);
  assert.ok(cut >= RATE * 17 && cut <= RATE * 17.12, String(cut / RATE));
  assert.equal(commitPoint(audio, { maxSec: 30 }), -1);
});

test('cleanText drops non-speech tags; joinText skips empty parts', () => {
  assert.equal(cleanText(' [BLANK_AUDIO] '), '');
  assert.equal(cleanText(' (music) '), '');
  assert.equal(cleanText(' Hello  [Music] world (quietly). '), 'Hello world (quietly).');
  assert.equal(joinText('Hello world.', '', 'Next'), 'Hello world. Next');
});

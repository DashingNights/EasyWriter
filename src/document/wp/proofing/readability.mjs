// Readability Statistics (docs/plans/word briefs/proofing.md): the counts, averages and Flesch scores Word shows after a spelling
// check while Options > Proofing > Show readability statistics is on. Pure. Passive Sentences is left out: it needs a grammar
// checker. The syllable rule is our own English approximation, so scores can differ from Word's by a little.
import { countParas } from '../../model/count.mjs';

/** The English syllables of `word` by our rule: vowel groups, less a silent final e, ed or es, at least one. */
export function syllables(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, (m) => m[0]).replace(/^y/, '');
  return Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length);
}

const WORD = /[\p{L}\p{N}]+(?:['\u2019.\-/,][\p{L}\p{N}]+)*/gu;

/** The sentences of paragraph text `p`: runs that end at '.', '!' or '?' followed by a space and a capital, a digit or an opening
 * quote (so 'e.g. this' stays one), holding a word. */
export function sentencesOf(p) {
  return p.split(/(?<=[.!?]['"\u2019\u201d)\]]*)\s+(?=[\p{Lu}\p{N}"'\u201c\u2018(])/u).filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const one = (n) => Math.round(n * 10) / 10;

/** The statistics of paragraph texts `paras` → {words, chars, paras, sentences, sentencesPerPara, wordsPerSentence, charsPerWord,
 * syllables, ease, grade, raw: {ease, grade}}. ease (Flesch Reading Ease) is clamped to 0 to 100 and grade (Flesch-Kincaid Grade
 * Level) to 0 and up, both rounded to one decimal as Word shows them; raw keeps the formulas' own values. */
export function readability(paras) {
  const c = countParas(paras);
  let sentences = 0;
  let syl = 0;
  let wordCount = 0;
  let letters = 0;
  for (const p of paras) {
    sentences += sentencesOf(p).length;
    for (const w of p.match(WORD) ?? []) {
      wordCount++;
      syl += syllables(w);
      letters += [...w].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
    }
  }
  const wps = sentences ? wordCount / sentences : 0;
  const spw = wordCount ? syl / wordCount : 0;
  const ease = 206.835 - 1.015 * wps - 84.6 * spw;
  const grade = 0.39 * wps + 11.8 * spw - 15.59;
  return {
    words: c.words, chars: c.chars, paras: c.paras, sentences, syllables: syl,
    sentencesPerPara: one(c.paras ? sentences / c.paras : 0), wordsPerSentence: one(wps), charsPerWord: one(wordCount ? letters / wordCount : 0),
    ease: wordCount ? one(Math.min(100, Math.max(0, ease))) : 0, grade: wordCount ? one(Math.max(0, grade)) : 0, raw: { ease, grade },
  };
}

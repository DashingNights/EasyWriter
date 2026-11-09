// Builds the Thesaurus word list (docs/plans/word/briefs/ph-misc-2.md §2): LibreOffice's English thesaurus, built from
// WordNet, cut down to the headwords of the en_US dictionary. Run once by hand: node scripts/build-thesaurus.mjs.
// Output: src/document/wp/proofing/thesaurus-en.txt and thesaurus-en.NOTICE.txt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://raw.githubusercontent.com/LibreOffice/dictionaries/4f1df64b2e8e14751aa7c2205d170ca016071315/en/';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'document', 'wp', 'proofing');
const POS = { noun: 'n', verb: 'v', adj: 'a', adv: 'r' };
const MAX_TERMS = 10;
const MAX_SENSES = 12;
const MAX_ANTONYMS = 10;

const get = async (name) => {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`);
  return r.text().then((t) => t.replace(/\r\n/g, '\n'));
};

/** The headwords of en_US.dic, lower-cased. */
function stemsOf(dic) {
  const stems = new Set();
  for (const line of dic.split('\n').slice(1)) {
    const word = line.split('/')[0].trim();
    if (word) stems.add(word.toLowerCase());
  }
  return stems;
}

/** A term stripped of its marker, or null when it is a generic or related term. */
function termOf(raw) {
  const t = raw.trim();
  if (t.endsWith(' (antonym)')) return { antonym: t.slice(0, -' (antonym)'.length).trim() };
  if (t.endsWith('(generic term)') || t.endsWith('(related term)')) return null;
  return { word: t.replace(/ ?\(similar term\)$/, '').trim() };
}

/** th_en_US_v2.dat → the output's lines. */
function entriesOf(dat, stems) {
  const lines = dat.split('\n');
  const out = [];
  let i = 1; // line 0 is the encoding
  while (i < lines.length) {
    const head = lines[i++] ?? '';
    const bar = head.lastIndexOf('|');
    if (bar < 0) continue;
    const word = head.slice(0, bar);
    const n = Number(head.slice(bar + 1));
    const raws = lines.slice(i, i + n);
    i += n;
    if (!/^[a-z][a-z'-]*$/.test(word) || !stems.has(word)) continue;
    const senses = [];
    const antonyms = [];
    for (const raw of raws) {
      const fence = raw.indexOf('|');
      if (fence < 0) continue;
      const pos = POS[raw.slice(1, fence - 1)];
      if (!pos) continue;
      const words = [];
      for (const part of raw.slice(fence + 1).split('|')) {
        const t = termOf(part);
        if (!t) continue;
        if (t.antonym != null) {
          if (t.antonym && t.antonym !== word && !antonyms.includes(t.antonym)) antonyms.push(t.antonym);
          continue;
        }
        const w = t.word;
        if (!w || w.toLowerCase() === word || words.some((x) => x.toLowerCase() === w.toLowerCase())) continue;
        words.push(w);
        if (words.length >= MAX_TERMS) break;
      }
      if (words.length && senses.length < MAX_SENSES) senses.push(`${pos}|${words.join('|')}`);
    }
    if (!senses.length && !antonyms.length) continue;
    out.push([word, ...senses, ...(antonyms.length ? [`~|${antonyms.slice(0, MAX_ANTONYMS).join('|')}`] : [])].join('\t'));
  }
  return out;
}

const [dat, dic, notice] = await Promise.all([get('th_en_US_v2.dat'), get('en_US.dic'), get('WordNet_license.txt')]);
const stems = stemsOf(dic);
const lines = entriesOf(dat, stems);
fs.writeFileSync(path.join(OUT, 'thesaurus-en.txt'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'thesaurus-en.NOTICE.txt'),
  `Thesaurus words from LibreOffice's English thesaurus, ${BASE}th_en_US_v2.dat, built from WordNet.\n\n${notice}`);
console.log(`${lines.length} entries, ${fs.statSync(path.join(OUT, 'thesaurus-en.txt')).size} bytes`);

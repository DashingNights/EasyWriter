// ph-misc-2 (docs/plans/word/briefs/ph-misc-2.md): the Thesaurus word list and its lookup, and the two ids the package takes
// out of the spec's placeholders: review.proofing.thesaurus and review.proofing.spellingAndGrammar.spellingAndGrammar, with
// keys.thesaurusKey (Shift+F7, keymap.mjs) opening the pane.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { REVIEW } from '../src/document/canvas/rows/review.mjs';
import { CONTROLS, ITEMS } from '../src/document/ribbon/spec.mjs';
import { WORD_KEYS } from '../src/document/word/keymap.mjs';
import { baseForms, indexOf, lookup, matchCase } from '../src/document/wp/proofing/thesaurus.mjs';

const FILE = new URL('../src/document/wp/proofing/thesaurus-en.txt', import.meta.url);
const NOTICE = new URL('../src/document/wp/proofing/thesaurus-en.NOTICE.txt', import.meta.url);
const index = indexOf(fs.readFileSync(FILE, 'utf8'));

test('the list has English words and their synonyms and antonyms', () => {
  assert.ok(lookup(index, 'happy').senses.some((s) => s.words.includes('glad')), 'happy has glad');
  assert.ok(lookup(index, 'good').antonyms.includes('bad'), 'good has bad as an antonym');
  assert.equal(lookup(index, 'zzzz'), null);
});

test('baseForms finds the dictionary form of running, cities and hoped', () => {
  assert.ok(baseForms('running').includes('run'));
  assert.ok(baseForms('cities').includes('city'));
  assert.ok(baseForms('hoped').includes('hope'));
});

test('a sense heads with its first word and a Word part-of-speech label', () => {
  assert.ok(lookup(index, 'happy').senses.some((s) => s.heading === 'glad (adj.)'));
});

test('matchCase follows the source word', () => {
  assert.equal(matchCase('Happy', 'glad'), 'Glad');
  assert.equal(matchCase('HAPPY', 'glad'), 'GLAD');
  assert.equal(matchCase('happy', 'glad'), 'glad');
});

test('the list is about 30,000 words and its notice carries the WordNet licence', () => {
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').length - 1;
  assert.ok(lines > 25_000, `${lines} lines`);
  assert.ok(fs.statSync(FILE).size < 3_000_000, `${fs.statSync(FILE).size} bytes`);
  assert.match(fs.readFileSync(NOTICE, 'utf8'), /Princeton University/);
});

test('the Thesaurus and Spelling and Grammar controls are real, with a row each', () => {
  assert.ok(!('needs' in CONTROLS['review.proofing.thesaurus']));
  assert.ok(!('needs' in ITEMS['review.proofing.spellingAndGrammar.spellingAndGrammar']));
  assert.ok(REVIEW['review.proofing.thesaurus'], 'review.proofing.thesaurus');
  assert.ok(REVIEW['review.proofing.spellingAndGrammar.spellingAndGrammar'], 'review.proofing.spellingAndGrammar.spellingAndGrammar');
  assert.ok(WORD_KEYS.some((k) => k.chord === 'Shift+F7' && k.cmd === 'review.proofing.thesaurus'), 'keys.thesaurusKey');
});

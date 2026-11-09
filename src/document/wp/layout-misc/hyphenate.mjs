// Hyphenation points (docs/plans/word plan.md §1.9 Static drawings, briefs/layout-misc.md): Liang's algorithm over the TeX en-US
// patterns (hyph-en-us.mjs). The automatic hyphenation pass, Manual hyphenation and views' Immersive Reader syllables ask it where
// a word may break. Pure, so node tests and the renderer share it.
import { EXCEPTIONS, PATTERNS } from './hyph-en-us.mjs';

let trie = null; // letters → digit array, built on first use
let exceptions = null; // lower-case word → break offsets

function load() {
  trie = new Map();
  for (const p of PATTERNS.split(' ')) {
    const letters = p.replace(/\d/g, '');
    const digits = new Array(letters.length + 1).fill(0);
    let i = 0;
    for (const ch of p) {
      if (ch >= '0' && ch <= '9') digits[i] = +ch;
      else i++;
    }
    trie.set(letters, digits);
  }
  exceptions = new Map();
  for (const w of EXCEPTIONS.split(' ')) {
    const at = [];
    let n = 0;
    for (const ch of w) {
      if (ch === '-') at.push(n);
      else n++;
    }
    exceptions.set(w.replace(/-/g, ''), at);
  }
}

/** The offsets inside `word` where a hyphen may go (a break at offset k puts word.slice(0, k) before the hyphen), for `lang`, with at
 * least min[0] letters before and min[1] after a break (TeX's 2 and 3). Words holding anything but letters get none; only en-US
 * has patterns (other languages: none, recorded). */
export function hyphenate(word, opts = {}) {
  const { lang = 'en-US', min = [2, 3] } = typeof opts === 'string' ? { lang: opts } : opts; // the scaffold stub took lang as a string
  if (typeof word !== 'string' || !/^en(-|$)/i.test(lang) || !/^[A-Za-z]+$/.test(word)) return [];
  const [left, right] = min;
  if (word.length < left + right) return [];
  if (!trie) load();
  const lower = word.toLowerCase();
  const keep = (k) => k >= left && k <= word.length - right;
  if (exceptions.has(lower)) return exceptions.get(lower).filter(keep);
  const w = `.${lower}.`;
  const points = new Array(w.length + 1).fill(0);
  for (let i = 0; i < w.length; i++) {
    for (let j = i + 1; j <= w.length; j++) {
      const digits = trie.get(w.slice(i, j));
      if (!digits) continue;
      for (let k = 0; k < digits.length; k++) if (digits[k] > points[i + k]) points[i + k] = digits[k];
    }
  }
  const out = [];
  // points[k + 1] sits between word[k - 1] and word[k] (the '.' pad shifts it by one).
  for (let k = 1; k < word.length; k++) if (points[k + 1] % 2 && keep(k)) out.push(k);
  return out;
}

export default hyphenate;

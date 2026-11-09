// The Thesaurus's word list and lookup (docs/plans/word/briefs/ph-misc-2.md §3): thesaurus-en.txt, one entry a line, fields
// tab-separated: the headword, each sense as `n|word|word...`, and the antonyms as `~|word|word...` when there are any.
const POS = { n: 'n.', v: 'v.', a: 'adj.', r: 'adv.' };

/** thesaurus-en.txt → Map(headword → its line). */
export function indexOf(text) {
  const index = new Map();
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) index.set(line.slice(0, tab), line);
  }
  return index;
}

/** Word and the forms it may come from, the word itself first. */
// ponytail: rules only, so "ran" finds nothing; add an irregular table if that shows.
export function baseForms(w) {
  const out = [w];
  const add = (f) => {
    if (f.length >= 2 && !out.includes(f)) out.push(f);
  };
  if (w.endsWith('ies') || w.endsWith('ied')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('ier')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('iest')) add(`${w.slice(0, -4)}y`);
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s')) add(w.slice(0, -1));
  for (const end of ['ing', 'ed', 'er', 'est']) {
    if (!w.endsWith(end)) continue;
    const stem = w.slice(0, -end.length);
    add(stem);
    add(`${stem}e`);
    if (stem.length > 1 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1));
  }
  if (w.endsWith('ly')) add(w.slice(0, -2));
  return out;
}

/** The entry of `word` in `index`, tried in baseForms order, lower-cased → {word, senses: [{heading, words}], antonyms} or null.
 * heading: `${words[0]} (${POS[pos]})`, as Word heads a meaning with its first word. */
export function lookup(index, word) {
  for (const form of baseForms(String(word))) {
    const line = index.get(form.toLowerCase());
    if (!line) continue;
    const [head, ...fields] = line.split('\t');
    const senses = [];
    const antonyms = [];
    for (const field of fields) {
      const [pos, ...words] = field.split('|');
      if (pos === '~') antonyms.push(...words);
      else if (POS[pos] && words.length) senses.push({ heading: `${words[0]} (${POS[pos]})`, words });
    }
    return { word: head, senses, antonyms };
  }
  return null;
}

/** `word` in the case of `source`: 'Happy' → 'Glad', 'HAPPY' → 'GLAD', anything else as it is. */
export function matchCase(source, word) {
  const letters = [...String(source)].filter((c) => c.toLowerCase() !== c.toUpperCase());
  const upper = (c) => c === c.toUpperCase() && c !== c.toLowerCase();
  if (letters.length > 1 && letters.every(upper)) return word.toUpperCase();
  if (letters.length && upper(letters[0])) return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

// Sounds like and Find all word forms (docs/plans/word/plan.md §3 find): small English heuristics of our own, since Word's
// come from its proofing tools. Pure.
// ponytail: American Soundex and a suffix stemmer with a short irregular list; a real lemma list would catch more forms.

const CODES = { b: 1, f: 1, p: 1, v: 1, c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2, d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };

/** The Soundex key of `word` ('Smith' and 'Smyth' → 'S530'). */
export function soundex(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  let key = w[0].toUpperCase();
  let prev = CODES[w[0]] ?? 0;
  for (const c of w.slice(1)) {
    const code = CODES[c] ?? 0;
    if (code && code !== prev) key += code;
    if (c !== 'h' && c !== 'w') prev = code; // h and w do not separate equal codes
    if (key.length === 4) break;
  }
  return key.padEnd(4, '0');
}

/** Whether `a` sounds like `b` (Sounds like (English)). */
export const soundsAlike = (a, b) => !!a && soundex(a) === soundex(b);

// Irregular forms → their base.
const IRREGULAR = {};
for (const row of ['be am is are was were been being', 'go goes went gone going', 'have has had having', 'do does did done doing',
  'say says said saying', 'make makes made making', 'take takes took taken taking', 'see sees saw seen seeing', 'come comes came coming',
  'give gives gave given giving', 'get gets got gotten getting', 'know knows knew known knowing', 'think thinks thought thinking',
  'find finds found finding', 'run runs ran running', 'write writes wrote written writing', 'eat eats ate eaten eating',
  'buy buys bought buying', 'bring brings brought bringing', 'begin begins began begun beginning', 'swim swims swam swum swimming',
  'man men', 'woman women', 'child children', 'mouse mice', 'foot feet', 'tooth teeth', 'person people', 'good better best', 'bad worse worst']) {
  const [base, ...forms] = row.split(' ');
  for (const f of [base, ...forms]) IRREGULAR[f] = base;
}

/** The stem Find all word forms compares: irregular forms map to their base, regular suffixes come off ('walked' → 'walk'). */
export function stem(word) {
  let w = word.toLowerCase().replace(/['’]s$/, '');
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 4 && /(ies|ied)$/.test(w)) return `${w.slice(0, -3)}y`;
  const m = w.match(/^(.{2,}?)(ing|ed|es|est|er|s)$/);
  if (m && !(m[2] === 's' && /s$/.test(m[1])) && !(m[2] === 'es' && !/(s|x|z|ch|sh|o)$/.test(m[1]))) w = m[1];
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz|ff)$/.test(w)) w = w.slice(0, -1); // stopped → stop
  return w.replace(/e$/, ''); // making and make meet at 'mak'
}

/** Whether `a` is a form of `b` (Find all word forms (English)). */
export const sameForms = (a, b) => !!a && stem(a) === stem(b);

/** Replace with all word forms: `replacement` given the found word's regular suffix against the query ('walked' found for 'walk'
 * replaced by 'stroll' → 'strolled'). An irregular form keeps the replacement as typed. */
export function inflect(replacement, found, query) {
  const f = found.toLowerCase();
  const q = query.toLowerCase();
  if (IRREGULAR[f] || f === q) return replacement;
  const base = stem(q);
  const tail = f.startsWith(base) ? f.slice(base.length).replace(/^([b-df-hj-np-tv-z])(?=ing|ed|er|est)/, '') : '';
  const r = replacement;
  if (!tail) return r;
  if (r.endsWith('e') && tail[0] === 'e') return r + tail.slice(1); // bake + es → bakes
  if (r.endsWith('e') && tail[0] === 'i') return r.slice(0, -1) + tail; // bake + ing → baking
  return r + tail;
}

// Word's accent prefix keys (index-keys.md Special and international characters): Ctrl plus a mark, then a letter, types the
// letter with that accent. The prefix arrives as the chord keys.mjs chordOf writes. Pure.

const row = (plain, accented) => Object.fromEntries([...plain].map((c, i) => [c, [...accented][i]]));

export const ACCENTS = {
  "Ctrl+'": { ...row('aeiouy', 'áéíóúý'), d: 'ð' },
  'Ctrl+`': row('aeiou', 'àèìòù'),
  'Ctrl+Shift+6': row('aeiou', 'âêîôû'),
  'Ctrl+Shift+`': row('ano', 'ãñõ'),
  'Ctrl+Shift+;': row('aeiouy', 'äëïöüÿ'),
  'Ctrl+Shift+2': row('a', 'å'),
  'Ctrl+Shift+7': row('aos', 'æœß'),
  'Ctrl+,': row('c', 'ç'),
  'Ctrl+/': row('o', 'ø'),
  // Ctrl+Alt+Shift+6 has no table: Word's own result is unknown, so its letter types itself.
};

/** Letter `key` (KeyboardEvent.key) after prefix `chord` → the accented character, or null when the letter has none (it then
 * types itself). Shift on the letter gives the capital. */
export function compose(chord, key) {
  const out = ACCENTS[chord]?.[key.toLowerCase()];
  if (!out) return null;
  if (key === key.toLowerCase()) return out;
  const up = out.toUpperCase();
  return up.length === 1 ? up : out;
}

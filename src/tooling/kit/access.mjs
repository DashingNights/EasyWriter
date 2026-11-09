// Access keys in dialog labels (docs/plans/word/plan.md §1.6). Word's labels mark the key with "&" ('Stri&kethrough'), as the probed
// dialogs record them (probe/dialogs/*.json); "&&" is a literal ampersand. Pure, so the Node tests read it.

/** Label `label` split at its access key marker: {text (without the markers), key (the marked character, lower case, or null), at (its
 * index in text, or -1)}. */
export function accessOf(label) {
  let text = '';
  let key = null;
  let at = -1;
  const s = String(label ?? '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '&' && s[i + 1] === '&') {
      text += '&';
      i++;
    } else if (s[i] === '&' && i + 1 < s.length && key == null) {
      key = s[i + 1].toLowerCase();
      at = text.length;
    } else if (s[i] !== '&') {
      text += s[i];
    }
  }
  return { text, key, at };
}

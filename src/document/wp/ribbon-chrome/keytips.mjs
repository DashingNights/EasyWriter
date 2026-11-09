// KeyTips as a pure machine (docs/plans/word briefs/ribbon-chrome.md): levels (the tab row, a tab's controls, an open menu or
// group), the keys typed so far at the top level, and what a key does there. KeyTips.jsx collects the entries from the DOM's
// [data-keytip] elements and acts on the result; node tests drive it with the spec's own KeyTips. No DOM and no app import.

/** A KeyTip's keys as tokens: 'F P' → ['F', 'P'], 'J I' → ['J', 'I'], '1' → ['1']. */
export const tokens = (keys) => String(keys ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);

/** The machine with nothing showing. */
export const IDLE = Object.freeze({ levels: [] });

/** Opens level `id` (any value the caller names it by) on top of `m`, with nothing typed. */
export const enter = (m, id) => ({ levels: [...m.levels, { id, typed: [] }] });

/** The level showing, or null. */
export const top = (m) => m.levels.at(-1) ?? null;

/** The entries of `entries` ([{keys}]) that still match what the top level has typed. */
export function matching(m, entries) {
  const typed = top(m)?.typed ?? [];
  return entries.filter((e) => {
    const t = tokens(e.keys);
    return t.length > typed.length - 1 && typed.every((k, i) => t[i] === k);
  });
}

/** Key `key` (one character) at the top level of `m`, over that level's `entries` ([{keys, ...}]). → {m, act, entry}:
 * 'press' with the entry whose keys are now complete, 'filter' while more keys are needed (the others dim), or 'miss' when no
 * KeyTip starts so (Word ends KeyTips then). An exact match wins over longer ones only when nothing longer remains. */
export function press(m, key, entries) {
  const level = top(m);
  if (!level) return { m, act: 'miss' };
  const typed = [...level.typed, String(key).toUpperCase()];
  const hits = entries.filter((e) => {
    const t = tokens(e.keys);
    return t.length >= typed.length && typed.every((k, i) => t[i] === k);
  });
  if (!hits.length) return { m, act: 'miss' };
  const exact = hits.filter((e) => tokens(e.keys).length === typed.length);
  if (exact.length && hits.length === exact.length) return { m: setTyped(m, []), act: 'press', entry: exact[0] };
  return { m: setTyped(m, typed), act: 'filter' };
}

const setTyped = (m, typed) => ({ levels: [...m.levels.slice(0, -1), { ...top(m), typed }] });

/** Esc: clears what the top level has typed, else steps back one level. → {m, act: 'clear' | 'back' | 'end'}. */
export function back(m) {
  const level = top(m);
  if (!level) return { m: IDLE, act: 'end' };
  if (level.typed.length) return { m: setTyped(m, []), act: 'clear' };
  const levels = m.levels.slice(0, -1);
  return { m: { levels }, act: levels.length ? 'back' : 'end' };
}

const LETTER = /[A-Z]/;

/** Derived KeyTips for `labels` (Word's rule where the probe has none): for each label, its first letter that no sibling
 * holds, then its later letters, then a digit. `taken`: keys the siblings already hold (their first tokens count). → keys[]
 * in label order, each one character, unique within the menu. */
export function deriveKeytips(labels, taken = []) {
  const used = new Set(taken.map((k) => tokens(k)[0]).filter(Boolean));
  return labels.map((label) => {
    const letters = [...String(label).toUpperCase()].filter((c) => LETTER.test(c));
    const pick = letters.find((c) => !used.has(c)) ?? [...'123456789'].find((c) => !used.has(c)) ?? null;
    if (pick) used.add(pick);
    return pick;
  });
}

/** Unique keys for one level's `entries` ([{keys, label}]): an entry without keys gets a derived one, and entries that share
 * keys get numbers after them as Word does (two 'E' become 'E 1' and 'E 2'), as does a key that is the start of a longer one.
 * → the entries with `keys` set and `derived: true` where the keys were made here. */
export function resolveKeytips(entries) {
  const out = entries.map((e) => ({ ...e }));
  const missing = out.filter((e) => !tokens(e.keys).length);
  const derived = deriveKeytips(missing.map((e) => e.label ?? ''), out.filter((e) => tokens(e.keys).length).map((e) => e.keys));
  missing.forEach((e, i) => { e.keys = derived[i]; e.derived = true; });
  const live = out.filter((e) => e.keys);
  const groups = new Map();
  for (const e of live) {
    const k = tokens(e.keys).join(' ');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const [k, list] of groups) {
    const prefix = [...groups.keys()].some((o) => o !== k && o.startsWith(`${k} `));
    if (list.length < 2 && !prefix) continue;
    let n = 0;
    for (const e of list) {
      let next;
      do next = `${k} ${++n}`; while (groups.has(next));
      e.keys = next;
    }
  }
  return out;
}

// The spellcheck interface the canvas editor asks (docs/plans/engine/plan.md section 1): words in, which are misspelled out, cached
// per word and language so a page that lays out again asks nothing new. A backend answers: on the desktop Electron's webFrame
// checker through preload's api.word.spell (the same Windows checker the DOM editor's contenteditable uses), or the harness stub.
// No imports: plain web code.

/** The desktop backend: the harness stub when a case set one, else preload's api.word.spell; every call is safe without either. */
export function desktopBackend() {
  const api = () => globalThis.__wordTest?.spell ?? globalThis.window?.api?.word?.spell ?? null;
  return {
    misspelled: async (word) => !!(await api()?.misspelled?.(word)),
    suggest: async (word) => {
      const r = await api()?.suggest?.(word);
      return Array.isArray(r) ? r : [];
    },
    add: async (word) => api()?.add?.(word),
    languages: async () => (await api()?.languages?.()) ?? null,
  };
}

/** A checker over `backend` ({misspelled(word, lang), suggest(word, lang), add(word), languages()}) → {check, suggest, add, clear}. */
export function createSpellChecker(backend = desktopBackend()) {
  const cache = new Map(); // `${lang}\n${word}` → misspelled
  const added = new Set(); // words added this session, lower case: the checker's own cache can lag behind an add

  const key = (word, lang) => `${lang ?? ''}\n${word}`;
  /** Whether `word` in `lang` is misspelled; false when the backend fails, so a broken checker draws no squiggles. */
  async function one(word, lang) {
    if (added.has(word.toLowerCase())) return false;
    const k = key(word, lang);
    if (!cache.has(k)) {
      let bad = false;
      try {
        bad = !!(await backend.misspelled(word, lang));
      } catch { /* left unflagged */ }
      cache.set(k, bad);
    }
    return cache.get(k);
  }

  return {
    /** Words `list` ([{word, lang}]) → [misspelled] in the same order. */
    check: (list) => Promise.all(list.map(({ word, lang }) => one(word, lang))),
    /** Up to eight suggestions for `word` in `lang`. */
    async suggest(word, lang) {
      try {
        return (await backend.suggest(word, lang)).slice(0, 8);
      } catch {
        return [];
      }
    },
    /** Adds `word` to the user dictionary. */
    async add(word) {
      added.add(word.toLowerCase());
      for (const k of cache.keys()) if (k.endsWith(`\n${word}`)) cache.delete(k);
      await backend.add(word);
    },
    /** The dictionary languages → {current, available} or null. */
    languages: async () => {
      try {
        return await backend.languages?.();
      } catch {
        return null;
      }
    },
    /** Forgets every answer (the dictionary languages changed). */
    clear: () => cache.clear(),
  };
}

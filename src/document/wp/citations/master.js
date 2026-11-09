// The source master list (plan.md §1.12): every draft's sources the user keeps, in the word store under 'sources', so a
// Document's Source Manager can copy them between drafts. Kept out of settings.json, which saveWord rewrites whole.

/** The master list → Promise of sources ([] when none is stored). */
export async function masterSources() {
  const list = await window.api.word.store.get('sources');
  return Array.isArray(list) ? list : [];
}

/** Stores `list` as the master list. */
export const saveMaster = (list) => window.api.word.store.set('sources', list);

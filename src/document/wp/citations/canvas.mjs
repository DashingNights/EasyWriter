// Citations on a canvas draft (docs/plans/engine/stage2.md S4): the document keeps its sources (the stage-2 decision), so the
// app's source shape (src/references.mjs) is converted to the engine's Source and back, and the app's style ids to the engine's
// style names. Pure, so node tests and the row table (src/document/canvas/rows/references.mjs) load it.

/** The app's style id → the engine's style name. 'harvard' (the course slide's Harvard) has none: the engine has Harvard - Anglia. */
export const ENGINE_STYLE = {
  apa: 'APA', chicago: 'Chicago', gb7714: 'GB/T 7714', gostName: 'GOST (name sort)', gostTitle: 'GOST (title sort)',
  harvardAnglia: 'Harvard (Anglia)', ieee: 'IEEE', iso690Date: 'ISO 690 (author-date)', iso690Num: 'ISO 690 (numerical)', mla: 'MLA',
  sist02: 'SIST02', turabian: 'Turabian',
};
const STYLE_ID = Object.fromEntries(Object.entries(ENGINE_STYLE).map(([id, name]) => [name, id]));

/** The engine's style name → the app's style id, or null. */
export const styleIdOf = (name) => STYLE_ID[name] ?? null;

// Word's source types (Create Source's ids, src/references.mjs SOURCE_TYPES) → the engine's kinds, and back for the app's own types.
const KIND = {
  Book: 'book', BookSection: 'bookSection', JournalArticle: 'article', ArticleInAPeriodical: 'periodical', ConferenceProceedings: 'conference',
  Report: 'report', InternetSite: 'website', DocumentFromInternetSite: 'website', ElectronicSource: 'website', Film: 'film',
};
const APP_TYPE = { book: 'book', bookSection: 'chapter', conference: 'chapter', article: 'article', periodical: 'article', report: 'preprint', website: 'web' };
const WORD_TYPE = Object.fromEntries(Object.entries(KIND).reverse().map(([w, k]) => [k, w]));
const FROM_APP_TYPE = { book: 'book', chapter: 'bookSection', article: 'article', preprint: 'report', web: 'website' };

const str = (v) => (v == null ? '' : String(v));

/** App source `s` (Create Source's result) → the engine's Source. A placeholder keeps only its tag. */
export function toEngineSource(s) {
  const kind = KIND[s.wtype] ?? FROM_APP_TYPE[s.type] ?? 'other';
  return {
    tag: str(s.tag), kind, author: (s.authors ?? []).join('; '), title: str(s.title), year: str(s.year), publisher: str(s.publisher),
    city: str(s.place), journal: str(s.container), volume: str(s.volume), pages: str(s.pages), url: str(s.url), editor: str(s.extra?.editor),
    edition: str(s.extra?.edition), issue: str(s.issue), month: '', day: '', accessed: str(s.accessed), doi: str(s.doi),
  };
}

/** The engine's Source → the app's source shape (for labels in the app's style and for Edit Source). Its id is the tag. */
export function fromEngineSource(e) {
  return {
    id: e.tag, tag: e.tag, type: APP_TYPE[e.kind] ?? 'web', wtype: WORD_TYPE[e.kind] ?? 'Book',
    authors: str(e.author).split(';').map((a) => a.trim()).filter(Boolean), year: str(e.year), title: str(e.title), container: str(e.journal),
    volume: str(e.volume), issue: str(e.issue), pages: str(e.pages), place: str(e.city), publisher: str(e.publisher), doi: str(e.doi),
    url: str(e.url), accessed: str(e.accessed), placeholder: !e.title && !e.author && !e.year,
  };
}

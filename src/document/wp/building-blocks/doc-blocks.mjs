// The document's own building blocks (briefs/file-building-blocks.md): the docParts a .docx carries in word/glossary, which
// import.mjs keeps in doc.attrs.settings.glossary, read as entries beside the user's and written back. Pure, so node tests load it.
import { GALLERIES, validEntry } from './blocks.mjs';

// The file's gallery values (ECMA-376 ST_DocPartGallery) → Word's gallery names. 'placeholder' (the text a content control shows
// while empty), 'any' and 'default' have no gallery in Word's lists, so those docParts stay hidden as Word hides them.
const BASE = {
  autoTxt: 'AutoText', bib: 'Bibliographies', coverPg: 'Cover Pages', eq: 'Equations', ftrs: 'Footers', hdrs: 'Headers', pgNum: 'Page Numbers',
  pgNumB: 'Page Numbers (Bottom of Page)', pgNumMargins: 'Page Numbers (Margins)', pgNumT: 'Page Numbers (Top of Page)', docParts: 'Quick Parts',
  tblOfContents: 'Table of Contents', tbls: 'Tables', txtBox: 'Text Boxes', watermarks: 'Watermarks',
};
const custom = (k) => (k === 'docParts' ? 'custQuickParts' : `cust${k[0].toUpperCase()}${k.slice(1)}`);
export const FILE_GALLERIES = {
  ...BASE,
  ...Object.fromEntries(Object.entries(BASE).map(([k, g]) => [custom(k), `Custom ${g}`])),
  ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`custom${n}`, `Custom ${n}`])),
};
const FILE_VALUE = Object.fromEntries(Object.entries(FILE_GALLERIES).map(([k, g]) => [g, k]));

/** A docPart's gallery value → Word's gallery name, or null when Word lists none (a name is taken as is, as other writers use). */
export const galleryName = (val) => FILE_GALLERIES[val] ?? (GALLERIES.includes(val) ? val : null);

// w:behavior values ↔ the Options rule.
const INSERT_OF = { pg: 'page', p: 'paragraph' };
const BEHAVIOR_OF = { page: 'pg', paragraph: 'p', content: 'content' };

/** The id of docPart `d` at `i` among the entries (its GUID when it has one, which survives other blocks' deletes). */
const idOf = (d, i) => `doc:${d.guid ?? i}`;

/** The usable entries of `glossary` (settings.glossary), in its order: {id, name, gallery, category, description, insert, content,
 * source: 'doc', index (its place in glossary)}. Placeholders, docParts of no listed gallery and those `schema` rejects are skipped. */
export function docEntries(glossary, schema = null) {
  if (!Array.isArray(glossary)) return [];
  const out = [];
  glossary.forEach((d, index) => {
    const gallery = galleryName(d?.gallery);
    if (!gallery || d.types?.includes('bbPlcHdr')) return;
    const e = { id: idOf(d, index), name: d.name ?? '', gallery, category: d.category ?? 'General', description: d.description ?? '',
      insert: INSERT_OF[d.behaviors?.find((b) => INSERT_OF[b])] ?? 'content', content: d.content, source: 'doc', index };
    if (validEntry(e, schema)) out.push(e);
  });
  return out;
}

/** `glossary` with doc entry `e` changed to `next` (name, gallery, category, description, insert): its gallery and behaviour go back
 * in the file's values, everything else of the docPart stays. */
export function patchGlossary(glossary, e, next) {
  return glossary.map((d, i) => {
    if (i !== e.index) return d;
    const gallery = next.gallery === e.gallery ? d.gallery : FILE_VALUE[next.gallery] ?? next.gallery;
    const behaviors = next.insert === e.insert ? d.behaviors : [BEHAVIOR_OF[next.insert]];
    const out = { ...d, name: next.name, gallery, category: next.category, description: next.description, ...(behaviors && { behaviors }) };
    if (!out.description) delete out.description;
    return out;
  });
}

/** `glossary` without doc entry `e`. */
export const dropFromGlossary = (glossary, e) => glossary.filter((_, i) => i !== e.index);

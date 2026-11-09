// Building blocks, pure (docs/plans/word plan.md §1.12 'buildingBlocks', §3 building-blocks): the entry shape and its check, the
// AutoText matchers behind F3 and AutoComplete, the three Options insert rules and the flat text the AUTOTEXT field shows.
// No DOM or app import, so node tests load it.

/** Word's gallery names in the Create New Building Block list (probe/dialogs/create-new-building-block.json, all 35). */
const BASE = ['AutoText', 'Bibliographies', 'Cover Pages', 'Equations', 'Footers', 'Headers', 'Page Numbers', 'Page Numbers (Bottom of Page)',
  'Page Numbers (Margins)', 'Page Numbers (Top of Page)', 'Quick Parts', 'Table of Contents', 'Tables', 'Text Boxes', 'Watermarks'];
export const GALLERIES = [...BASE, 'Custom 1', 'Custom 2', 'Custom 3', 'Custom 4', 'Custom 5', ...BASE.map((g) => `Custom ${g}`)];

export const CATEGORY = 'General';
/** The Options list: insert value → Word's label. */
export const INSERTS = [['content', 'Insert content only'], ['paragraph', 'Insert content in its own paragraph'], ['page', 'Insert content in its own page']];

/** The Options value a new block of `gallery` starts with: whole pages for covers, own paragraphs for block objects. */
export const defaultInsert = (gallery) => (gallery === 'Cover Pages' ? 'page'
  : /^(Table of Contents|Bibliographies|Tables|Text Boxes)$/.test(gallery) ? 'paragraph' : 'content');

const isStr = (v) => typeof v === 'string';

/** Whether `e` is a usable entry: the §1.12 shape, and every block valid in `schema` when one is given (a block a later schema
 * no longer accepts makes the entry unusable, so it is skipped instead of throwing at insert). */
export function validEntry(e, schema = null) {
  if (!e || typeof e !== 'object' || !isStr(e.id) || !e.id || !isStr(e.name) || !e.name.trim() || !GALLERIES.includes(e.gallery)) return false;
  if (!isStr(e.category) || !INSERTS.some(([v]) => v === e.insert) || !Array.isArray(e.content) || !e.content.length) return false;
  if (!schema) return true;
  try {
    for (const b of e.content) schema.nodeFromJSON(b).check();
    return true;
  } catch {
    return false;
  }
}

/** The usable entries of a stored list (anything else, a corrupt file included, gives []). */
export const cleanEntries = (list, schema) => (Array.isArray(list) ? list.filter((e) => validEntry(e, schema)) : []);

/** The Name box's first guess for selected `text`: its first two words (Word: "the first words"), at most 32 characters. */
export const firstWords = (text) => String(text ?? '').trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 32);

const lower = (s) => s.toLocaleLowerCase();
const autoText = (entries) => entries.filter((e) => e.gallery === 'AutoText');

/** F3: the entry named by the text before the caret (`before`, the paragraph's text up to it). An exact name wins, the longest
 * when several names end the text (multi-word names count), and must start at a word start; else the last word (back to the
 * previous space) as a prefix of exactly one name. AutoText entries come before other galleries' of the same name. Case is
 * ignored. → {entry, start (offset in before)} | {error: 'none' | 'ambiguous'} */
export function matchAutoText(entries, before) {
  const text = lower(String(before ?? ''));
  const ordered = [...autoText(entries), ...entries.filter((e) => e.gallery !== 'AutoText')];
  let best = null;
  for (const e of ordered) {
    const name = lower(e.name);
    const start = text.length - name.length;
    if (start < 0 || !text.endsWith(name) || (start > 0 && !/\s/.test(text[start - 1]))) continue;
    if (!best || name.length > best.entry.name.length) best = { entry: e, start };
  }
  if (best) return best;
  const word = /\S*$/.exec(text)[0];
  if (!word) return { error: 'none' };
  const hits = ordered.filter((e) => lower(e.name).startsWith(word));
  const names = new Set(hits.map((e) => lower(e.name)));
  if (!hits.length) return { error: 'none' };
  if (names.size > 1) return { error: 'ambiguous' };
  return { entry: hits[0], start: text.length - word.length };
}

/** AutoComplete: the AutoText entry whose name the text before the caret has started, once at least four of its characters are
 * typed (so names shorter than four never show), counting from a word start; the longest typed part wins, then the name first in
 * the list. A name typed in full shows no tip. → {entry, start} | null */
export function autoCompleteOf(entries, before) {
  const text = String(before ?? '');
  const low = lower(text);
  for (let start = 0; start <= text.length - 4; start++) {
    if (start > 0 && !/\s/.test(text[start - 1])) continue;
    const typed = low.slice(start);
    const hit = autoText(entries).find((e) => e.name.length >= 4 && lower(e.name).startsWith(typed) && e.name.length > typed.length);
    if (hit) return { entry: hit, start };
  }
  return null;
}

const PAGE_BREAK = { type: 'pageBreak' };

/** What inserting `content` (block JSON) with Options `insert` puts in: 'content' with one paragraph gives its inline content (it
 * joins the paragraph at the caret), else blocks; 'paragraph' gives the blocks; 'page' gives the blocks ending in a page break,
 * with one before them too unless `atStart` (the caret at the document's start). → {inline: [...]} | {blocks: [...]} */
export function insertionOf(content, insert, { atStart = false } = {}) {
  const blocks = content ?? [];
  if (insert === 'content' && blocks.length === 1 && blocks[0].type === 'paragraph') return { inline: blocks[0].content ?? [] };
  if (insert !== 'page') return { blocks };
  const body = blocks.at(-1)?.type === 'pageBreak' ? blocks : [...blocks, PAGE_BREAK];
  return { blocks: atStart || body[0]?.type === 'pageBreak' ? body : [PAGE_BREAK, ...body] };
}

/** The text of block JSON `content` on one line (the AUTOTEXT field's result: recorded flattening). */
export function flatText(content) {
  const parts = [];
  const walk = (n) => {
    if (n?.type === 'text') parts.push(n.text ?? '');
    else if (n?.type === 'hardBreak') parts.push(' ');
    for (const c of n?.content ?? []) walk(c);
    if (n?.type === 'paragraph' || n?.type === 'heading') parts.push(' ');
  };
  for (const b of content ?? []) walk(b);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export const MISSING = 'Error! AutoText entry not defined.';

/** The AUTOTEXT and GLOSSARY result for entry `name` among `entries`: its flat text, or Word's error when no entry has that name. */
export function autoTextResult(entries, name) {
  const want = lower(String(name ?? ''));
  const e = want && (autoText(entries).find((x) => lower(x.name) === want) ?? entries.find((x) => lower(x.name) === want));
  return e ? flatText(e.content) : { error: MISSING };
}

/** `rows` sorted by column `key` (the Organizer's headers), `dir` 1 or -1, ties kept in order. */
export const sortRows = (rows, key, dir = 1) => [...rows].sort((a, b) => dir * String(a[key] ?? '').localeCompare(String(b[key] ?? '')));

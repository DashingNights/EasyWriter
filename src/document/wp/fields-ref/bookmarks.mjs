// Bookmarks as data (docs/plans/word/briefs/fields-ref.md): a start and an end `bookmark` node share an id; the range is the
// content between them, so a point bookmark has the two nodes side by side. Word's names begin with a letter, hold letters,
// digits and underscores, and run to 40 characters; a name starting with "_" (_Ref, _Toc, _GoBack) is hidden. Pure: Node tests
// load it.

export const NAME_MAX = 40;
const NAME = /^\p{L}[\p{L}\p{N}_]*$/u;

/** Whether `name` is a name Word's Bookmark dialog accepts (hidden names come from Word itself, never from the dialog). */
export const validName = (name) => typeof name === 'string' && name.length <= NAME_MAX && NAME.test(name);

/** Whether bookmark `name` is hidden (a name Word makes for cross-references, tables of contents and Go Back). */
export const isHidden = (name) => String(name ?? '').startsWith('_');

/** The bookmarks of `doc` in the order of their starts: {name, id, from, to, start, end} where start and end are the marker
 * positions and from..to the bookmarked content. A start without an end marks a point; an end without a start is ignored. Found once
 * per doc (docs never change), so the editor plugin's checks on every change share one walk; the list is frozen, copy it to sort. */
const found = new WeakMap();
export function bookmarksOf(doc) {
  let out = found.get(doc);
  if (!out) found.set(doc, (out = Object.freeze(walk(doc))));
  return out;
}
function walk(doc) {
  const open = new Map();
  const out = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== 'bookmark') return true;
    const key = n.attrs.id || n.attrs.name;
    if (!n.attrs.end) {
      const b = { name: n.attrs.name, id: n.attrs.id, from: pos + 1, to: pos + 1, start: pos, end: null };
      open.set(key, b);
      out.push(b);
    } else {
      const b = open.get(key);
      open.delete(key);
      if (b) Object.assign(b, { to: pos, end: pos });
    }
    return false;
  });
  return out;
}

/** The bookmark of `doc` named `name` (case-insensitive, as Word's names are), or null. */
export const bookmarkNamed = (doc, name) => bookmarksOf(doc).find((b) => b.name.toLowerCase() === String(name).toLowerCase()) ?? null;

/** An id no bookmark of `doc` uses (Word numbers them; any unique string serves). */
export function newBookmarkId(doc, taken = new Set()) {
  let max = 0;
  for (const b of bookmarksOf(doc)) {
    taken.add(String(b.id));
    const n = Number(b.id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  let id = max + 1;
  while (taken.has(String(id))) id++;
  return String(id);
}

/** A hidden cross-reference name Word's way, _Ref and 9 digits, that `doc` does not use yet. `random` is for tests. */
export function refName(doc, random = Math.random) {
  const used = new Set(bookmarksOf(doc).map((b) => b.name.toLowerCase()));
  for (;;) {
    const name = `_Ref${String(Math.floor(random() * 9e8) + 1e8)}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** The bookmarks the Bookmark dialog lists: visible ones (and hidden ones with `hidden`), by name or by location. */
export function listedBookmarks(doc, { hidden = false, sort = 'name' } = {}) {
  const list = bookmarksOf(doc).filter((b) => hidden || !isHidden(b.name));
  return sort === 'name' ? list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) : list;
}

/** Text of `doc` between `from` and `to` as REF shows it: fields as their results, paragraphs joined with a space (Word keeps
 * paragraph marks; a field result here is one line, recorded). */
export const textOf = (doc, from, to) => (from >= to ? '' : doc.textBetween(from, to, ' ', (leaf) => (leaf.type.name === 'field' ? leaf.attrs.result ?? '' : '')));

// The building blocks store (docs/plans/word plan.md §1.12): entries in the word store 'buildingBlocks' (userData/word/), held in a
// cache so galleries, F3, AutoComplete and fields read them synchronously. Clipboard writes the Spike there too, so the cache
// reloads whenever a Document editor takes the focus. Entries a schema no longer accepts are skipped on read, never deleted.
import { cleanEntries } from './blocks.mjs';
import { docEntries } from './doc-blocks.mjs';

const NAME = 'buildingBlocks';
let raw = []; // the stored list as read, invalid entries included, so a save keeps what this build cannot read
let schema = null;
let version = 0;
const listeners = new Set();

const api = () => globalThis.window?.api?.word?.store;
const changed = () => {
  version++;
  for (const fn of listeners) fn();
};

/** The usable entries now (validated against the Document schema once one is known). */
export const entries = () => cleanEntries(raw, schema);
/** +1 per change, for React subscribers. */
export const storeVersion = () => version;
/** Calls `fn` on every change → unsubscribe. */
export const onStore = (fn) => (listeners.add(fn), () => listeners.delete(fn));

/** Sets the schema entries are checked against (the Document editor's). */
export function setSchema(s) {
  if (s && s !== schema) {
    schema = s;
    changed();
  }
}

/** Reads the store again → the usable entries. */
export async function reload() {
  try {
    const list = await api()?.get(NAME);
    raw = Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('Building blocks could not be read', e);
  }
  changed();
  return entries();
}

/** Writes `list` (the whole stored list) and updates the cache. */
async function write(list) {
  raw = list;
  changed();
  await api()?.set(NAME, list);
}

/** Adds `entry`, or replaces the entry of the same id → the saved entry. */
export async function saveEntry(entry) {
  await reload();
  const i = raw.findIndex((e) => e?.id === entry.id);
  await write(i < 0 ? [...raw, entry] : raw.map((e, j) => (j === i ? { ...e, ...entry } : e)));
  return entry;
}

/** Removes the entry with `id`. */
export async function deleteEntry(id) {
  await reload();
  await write(raw.filter((e) => e?.id !== id));
}

// ---------------------------------------------------------------------------------------------
// The document's own blocks (settings.glossary), beside the stored ones

const docCache = new WeakMap(); // glossary array → its entries (AutoComplete reads them on every keypress)

/** The document's blocks of `doc` (a main document node), then the stored entries. */
export function allEntries(doc) {
  const g = doc?.attrs?.settings?.glossary;
  let own = Array.isArray(g) ? docCache.get(g) : [];
  if (!own) docCache.set(g, (own = docEntries(g, doc.type.schema)));
  return [...own, ...entries()];
}

/** Puts `glossary` in `ed`'s document as one undo step, and tells the subscribers (the Organizer lists it). */
export function writeGlossary(ed, glossary) {
  const ok = !!ed?.chain().command(({ tr }) => !!tr.setDocAttribute('settings', { ...tr.doc.attrs.settings, glossary })).run();
  changed();
  return ok;
}

/** A new entry id. */
export const newId = () => globalThis.crypto?.randomUUID?.() ?? `bb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

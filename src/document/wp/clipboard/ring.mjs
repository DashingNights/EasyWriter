// The Clipboard pane's items and the Spike (docs/plans/word plan.md §3 clipboard, §1.12): Word's Office Clipboard keeps the last 24
// cut or copied items, newest first; the Spike is the AutoText building block "Spike" that Ctrl+F3 appends to and Ctrl+Shift+F3
// empties into the text. Pure: node tests load it.

export const RING_MAX = 24;

/** `ring` with `item` ({id, html, text, image, kind}) added first; the oldest falls off past 24, and an item equal to the newest is
 * not added twice (a copy the window-focus read sees again). */
export function addItem(ring, item) {
  const top = ring[0];
  if (top && top.html === item.html && top.text === item.text && top.image === item.image) return ring;
  return [item, ...ring].slice(0, RING_MAX);
}

/** `ring` without the item `id`. */
export const removeItem = (ring, id) => ring.filter((x) => x.id !== id);

/** The items in the order Paste All inserts them: oldest first (Word's order, unverified). */
export const pasteAllOrder = (ring) => [...ring].reverse();

/** A short excerpt of `text` for the pane: one line, at most `max` characters. */
export function excerpt(text, max = 120) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ---------------------------------------------------------------------------------------------
// Spike

/** The Spike's identity in the word store's buildingBlocks (plan.md §1.12; _gaps-fields-core.md G8 entry shape). */
export const SPIKE = { name: 'Spike', gallery: 'AutoText', category: 'General' };
const isSpike = (e) => e?.name === SPIKE.name && e.gallery === SPIKE.gallery;

/** `blocks` (block JSON) as Spike pieces: inline content becomes a paragraph, so each piece ends with a paragraph mark. */
export function asPiece(blocks) {
  return blocks.map((b) => (b.type === 'text' || b.type === 'hardBreak' || b.type === 'image' ? { type: 'paragraph', content: [b] } : b));
}

/** `entries` (the word store's buildingBlocks, or null) with `blocks` appended to the Spike, which is made when missing. */
export function spikeAppend(entries, blocks, { id = 'spike', now = new Date().toISOString() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const piece = asPiece(blocks);
  const i = list.findIndex(isSpike);
  if (i < 0) {
    return [...list, { id, ...SPIKE, description: '', insert: 'content', content: piece, created: now }];
  }
  const out = [...list];
  out[i] = { ...list[i], content: [...(list[i].content ?? []), ...piece] };
  return out;
}

/** `entries` split into the Spike's content (every piece in order, [] when empty) and the entries without the Spike. */
export function spikeTake(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const spike = list.find(isSpike);
  return { content: spike?.content ?? [], entries: list.filter((e) => !isSpike(e)) };
}

// The engine calls the accessibility copy and spelling share (docs/plans/engine/plan.md section 3, extended here as that section
// allows). Plain web code, no imports, so the renderer and node tests load it as is.
//
// The calls this package adds to the engine API (engine/crates/wasm/src/a11y.rs serves them through worker.js):
//   blocks(page) -> [Block]: the blocks that have a line on page `page`, in reading order: the header, the body with the notes
//     and text boxes where the page places them, the footer. A paragraph that runs over two pages comes back on both, whole.
//     Block = {
//       id,                 a key unique in the session while the document is open: a body paragraph's path ("4", "2.1.0.0" in
//                           a table cell), a part's paragraph's after the part's id and a colon ("7:0"), a part's own "7:"
//       kind,               'p' | 'table' | 'container' | 'part' | 'object'
//       text,               a paragraph's text; U+FFFC for an inline object, '\n' for a line break inside the paragraph
//       level?,             1 to 9 for a heading (the outline level of its style)
//       list?,              {ordered, level (0 based), marker} for a list paragraph, marker as drawn ('1.', 'a)', a bullet)
//       lines?,             the text offsets where the second and later laid-out lines start
//       boxes?,             [{line, x, y, w, h, size}] where the paragraph's lines on this page sit, in page points (line is
//                           the line's index: 0 for the first, i for the one starting at lines[i - 1]; size the largest font
//                           size on it); blocksOf adds each box's `surface`
//       objects?,           [{offset, alt | text | hidden}] for the inline objects in text: a picture, shape, equation or note
//                           mark is read by its alt text, a field by its result `text`; a `hidden` one (a bookmark, a comment
//                           anchor, a field's end) has nothing to read
//       langs?, noproof?,   [[start, end, tag]] the run languages; [[start, end]] the runs marked Do not check spelling
//       rows?,              a table's rows on this page: [{index, cells: [{blocks: [Block]}]}]
//       part?, blocks?,     a part's kind ('header', 'footer', 'footnote', 'endnote', 'comment', 'textbox') and its blocks
//       alt?,               an object's alt text
//     }. Offsets count UTF-16 code units, as JavaScript strings do.
//   locate(pos) -> {id, offset}: the paragraph a position is in and its offset in that paragraph's text.
//   posAt(id, offset) -> pos: the position at an offset of a paragraph's text.
//   colors({text, paper} | null): forced colours for the session's tiles (index.js).
//   event 'selection' {anchor, head}: after the selection changes.

/** Calls engine method `name` on `client`, which has either one method per call or EngineClient's generic call(name, args). */
export const rpc = (client, name, ...args) => (typeof client[name] === 'function' ? client[name](...args) : client.call(name, args));

/** Every text block of `blocks` and of the tables, parts and text boxes inside them, in reading order → [Block]. */
export function textBlocks(blocks, out = []) {
  for (const b of blocks ?? []) {
    if (b.kind === 'p') out.push(b);
    else if (b.kind === 'table') for (const r of b.rows ?? []) for (const c of r.cells ?? []) textBlocks(c.blocks, out);
    else textBlocks(b.blocks, out);
  }
  return out;
}

/** Gives every line box in `blocks` its surface, page `page`. */
function tag(blocks, page) {
  for (const b of blocks ?? []) {
    for (const x of b.boxes ?? []) x.surface = page;
    for (const r of b.rows ?? []) for (const c of r.cells ?? []) tag(c.blocks, page);
    tag(b.blocks, page);
  }
}

/** Merges `list` into `out`, each block once: a table split over pages holds its rows merged, a container split over pages
 * merges its own blocks by id. `seen` (id → the block already in `out`) is the list's own. */
function mergeList(out, list, seen) {
  for (const b of list) {
    const had = seen.get(b.id);
    if (!had) {
      const fresh = b.kind === 'table' ? { ...b, rows: [...(b.rows ?? [])] } : b;
      seen.set(b.id, fresh);
      out.push(fresh);
    } else if (b.kind === 'table') {
      for (const r of b.rows ?? []) if (!had.rows.some((x) => x.index === r.index)) had.rows.push(r);
    } else if (b.kind === 'container') {
      mergeList(had.blocks, b.blocks ?? [], new Map(had.blocks.map((x) => [x.id, x])));
    } else if (b.boxes) {
      had.boxes = [...(had.boxes ?? []), ...b.boxes];
    }
  }
}

/** The blocks of pages `pages` in order, each paragraph once with the line boxes of every page it is on, a table split over
 * pages once with its rows merged, a part (a header every page repeats) once → [Block]. `cache` (page → the engine's answer)
 * holds pages asked for before that have not changed since: they are not asked for again. */
export async function blocksOf(client, pages, cache = null) {
  const out = [];
  const seen = new Map();
  for (const page of pages) {
    let list = cache?.get(page);
    if (!list) {
      list = (await rpc(client, 'blocks', page)) ?? [];
      cache?.set(page, list);
    }
    // A copy: the merge below changes the blocks, and the cache keeps the engine's answer.
    if (cache) list = structuredClone(list);
    tag(list, page);
    mergeList(out, list, seen);
  }
  return out;
}

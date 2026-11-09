// Format Painter, Copy Format and Paste Format (docs/plans/word plan.md §3 clipboard, index-editing.md "Typing and editing",
// probe/behaviour-tests.tsv painter rows): what a pick-up takes and where an apply goes. Pick-up takes the marks at the caret or of
// the selection's first character and that paragraph's properties. Apply: a drag gives character formatting only; a click inside a
// word gives that word the marks and its paragraph the paragraph properties; a selection that includes a paragraph end takes both.
// Pure: the plugin passes plain values, node tests load it.

// Marks that carry no formatting: never picked up, never removed by an apply.
export const NON_FORMAT = new Set(['link', 'comment', 'insertion', 'deletion', 'formatChange', 'permission']);
// Paragraph attributes that are not formatting (agent suggestions, revision records, Outline view's collapse).
export const NOT_PARA = new Set(['suggest', 'markRev', 'pChange', 'collapsed']);

/** Whether mark type `name` is formatting the painter carries. */
export const isFormatMark = (name) => !NON_FORMAT.has(name);

/** What a pick-up stores: `marks` (mark JSON at the caret or first character), the paragraph's node `type` and `attrs`. */
export function pickUp(marks, type, attrs) {
  return {
    marks: (marks ?? []).filter((m) => isFormatMark(m.type)),
    para: { type, attrs: Object.fromEntries(Object.entries(attrs ?? {}).filter(([k]) => !NOT_PARA.has(k))) },
  };
}

const WORD = /[\p{L}\p{N}_'’]/u;

/** The word around `offset` in a paragraph's `text` → [from, to) or null when the offset touches no word (the caret between spaces). */
export function wordAt(text, offset) {
  let from = offset;
  let to = offset;
  while (from > 0 && WORD.test(text[from - 1])) from--;
  while (to < text.length && WORD.test(text[to])) to++;
  return from < to ? [from, to] : null;
}

/** Where an apply goes for a selection: `empty` (a click), `sameParagraph` (both ends in one paragraph), `wholeParagraph` (it
 * covers one paragraph from start to end, as a triple-click does). → {chars: 'word' | 'selection' | null, para: whether the
 * paragraph properties apply}. A selection that runs into another paragraph holds a paragraph end, and a whole paragraph stands
 * for Word's triple-click that takes the paragraph mark, so both take the paragraph too (unverified for partial paragraphs). */
export function applyPlan({ empty, sameParagraph, wholeParagraph = false }) {
  if (empty) return { chars: 'word', para: true };
  return { chars: 'selection', para: !sameParagraph || wholeParagraph };
}

/** The painter state after a run of Format Painter at time `now` (ms): off → 'once'; a second run within 500 ms of arming (the
 * double-click) → 'sticky'; any later run → off. `armedAt` is when it was last armed. */
export function nextPainter(current, armedAt, now) {
  if (!current) return 'once';
  if (current === 'once' && now - armedAt <= 500) return 'sticky';
  return null;
}

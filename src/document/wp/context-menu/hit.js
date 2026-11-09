// What a right-click or the menu key hit in a Document (docs/plans/word/briefs/context-menu.md): the hit menus.mjs picks a menu
// from, read from the registry's ctx (story, contextual flags, the object) and the target editor's selection, plus the header band
// from page geometry.
import { geometryOf, scaleOf } from '../../geometry.js';
import { revisionsOf } from '../../model/review.mjs';
import { kindOf } from '../../numbering.mjs';
import { areaAt } from './place.mjs';

const WORD = /[\p{L}\p{N}'’-]/u;

/** The word around the caret of `state` (or the selected text, up to 60 characters) → {from, to, text} or null. */
export function wordAt(state) {
  const { selection: sel } = state;
  if (!sel.empty) {
    const text = state.doc.textBetween(sel.from, sel.to, ' ');
    return text.trim() && text.length <= 60 ? { from: sel.from, to: sel.to, text } : null;
  }
  const { $from } = sel;
  if (!$from.parent.isTextblock) return null;
  const text = $from.parent.textBetween(0, $from.parent.content.size, null, '￼');
  let a = $from.parentOffset;
  let b = a;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length && WORD.test(text[b])) b++;
  if (a === b) return null;
  const start = $from.start();
  return { from: start + a, to: start + b, text: text.slice(a, b) };
}

/** Whether a field node sits beside the caret of `state` or inside its selection (ctxOf only flags a node-selected one). */
function fieldNear({ selection: sel, doc }) {
  const isField = (n) => n?.type.name === 'field';
  if (sel.empty) return isField(sel.$from.nodeBefore) || isField(sel.$from.nodeAfter);
  let found = false;
  doc.nodesBetween(sel.from, sel.to, (n) => !found && !(found = isField(n)));
  return found;
}

/** The page band under the client point `at` of the main editor `main` → 'header', 'footer' or null (geometry PageBoxes are in
 * the editor's zoom-free layout px). */
export function headerAreaAt(main, at) {
  const view = main?.view;
  if (!view?.dom?.isConnected) return null;
  const r = view.dom.getBoundingClientRect();
  return areaAt(geometryOf(main.state)?.pages, (at.y - r.top) / scaleOf(view));
}

/** The hit for `ctx` (registry ctxOf) → the fields menus.mjs menuFor reads. `spelling`: {word, suggestions} of a misspelling;
 * `headerArea`: the page band clicked. */
export function hitOf(ctx, { spelling = null, headerArea = null } = {}) {
  const st = ctx.state;
  const hit = { story: ctx.story, spelling, headerArea };
  // A canvas draft: what the engine's document.context says the selection is in (stage2.md G1), so a heading gets Expand and
  // Collapse, a link its menu and a picture its own.
  if (ctx.engine && !headerArea) return { ...hit, ...canvasHit(ctx.engineState?.['document.context']?.value) };
  if (!st || headerArea) return hit;
  const sel = st.selection;
  const { $from } = sel;
  let block = null;
  for (let d = $from.depth; d >= 0 && !block; d--) if ($from.node(d).isTextblock) block = $from.node(d);
  const num = block?.attrs?.numbering;
  const link = st.schema.marks.link;
  // A story editor holds the story as its own doc, so its tracked changes come back with at null and story positions.
  const rev = revisionsOf(st.doc).find((r) => r.at == null && r.from < r.to && r.from <= sel.from && sel.to <= r.to) ?? null;
  return {
    ...hit,
    list: num?.numId != null,
    numbered: num?.numId != null && kindOf((ctx.ed ?? ctx.target)?.state.doc.attrs.numbering, num.numId) === 'number',
    table: !!ctx.in?.table,
    cells: sel.$anchorCell ? sel.ranges.length : 1,
    picture: ctx.obj?.kind === 'picture' || ctx.obj?.kind === 'graphic',
    shape: sel.node?.type.name === 'textBox', // a text box selected whole, by its border
    link: !!link && (sel.empty ? !!link.isInSet(st.storedMarks ?? $from.marks()) : st.doc.rangeHasMark(sel.from, sel.to, link)),
    field: !!ctx.in?.field || fieldNear(st),
    comment: !!ctx.in?.comment,
    revision: rev && { kind: rev.kind, op: rev.op ?? null },
    heading: block?.type.name === 'heading',
    note: ctx.story === 'footnote' || ctx.story === 'endnote' ? ctx.story : null,
    equation: !!ctx.in?.equation,
    selection: !sel.empty,
    word: wordAt(st)?.text ?? null,
  };
}

/** The hit fields from document.context's value `c` (null before the engine first answers). */
function canvasHit(c) {
  if (!c) return {};
  const rev = typeof c.revision === 'string' ? { kind: c.revision, op: null } : c.revision ?? null;
  return {
    list: !!c.list, numbered: !!c.list?.numbered, table: !!c.table, cells: 1,
    picture: c.object?.kind === 'picture' || c.object?.kind === 'graphic', shape: c.object?.kind === 'textBox',
    link: !!c.link, field: !!c.field, comment: !!c.comments?.length, revision: rev, heading: c.heading != null,
    note: c.story?.kind === 'footnote' || c.story?.kind === 'endnote' ? c.story.kind : null, equation: !!c.equation, selection: false, word: null,
  };
}

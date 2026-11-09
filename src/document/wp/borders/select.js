// What the Borders and Shading tools act on (briefs/borders.md "What an item does depends on the selection"), and the writers
// that apply a model.mjs patch to it: whole paragraphs (or a caret), part of one paragraph (a run), selected cells, a whole table.
// A caret in a cell acts on that cell, as Word's Apply to Cell does.
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { deepPatch, isPlain } from '../../../office.mjs';
import { textblocks } from '../../lists.js';
import { styleChain, styleIdOf } from '../../model/styles.mjs';
import { cellEdges, sixOf } from './model.mjs';

const CELLS = ['tableCell', 'tableHeader'];

/** The cell-level target of a cell selection or a selected table → {table, tablePos, start (pos of the table's content), map,
 * rect, whole} or null. */
function cellsOf(state) {
  const sel = state.selection;
  if (sel instanceof CellSelection) {
    const $a = sel.$anchorCell;
    const d = $a.depth - 1; // $anchorCell sits before the cell, in its row
    const table = $a.node(d);
    const start = $a.start(d);
    const map = TableMap.get(table);
    const rect = map.rectBetween($a.pos - start, sel.$headCell.pos - start);
    return { table, tablePos: start - 1, start, map, rect, whole: rect.left === 0 && rect.top === 0 && rect.right === map.width && rect.bottom === map.height };
  }
  if (sel.node?.type.name === 'table') {
    const map = TableMap.get(sel.node);
    return { table: sel.node, tablePos: sel.from, start: sel.from + 1, map, rect: { left: 0, top: 0, right: map.width, bottom: map.height }, whole: true };
  }
  return null;
}

/** The cell holding the whole selection (a caret or text inside one cell), as a cell-level target, or null. */
function cellAt(state) {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 1; d--) {
    if (!CELLS.includes($from.node(d).type.name)) continue;
    if ($to.depth < d || $to.before(d) !== $from.before(d)) return null;
    const table = $from.node(d - 2);
    const start = $from.start(d - 2);
    const map = TableMap.get(table);
    return { table, tablePos: start - 1, start, map, rect: map.findCell($from.before(d) - start), whole: false };
  }
  return null;
}

/** Whether `state`'s selection is part of one paragraph: a range inside one textblock that leaves some of its text out. */
function partOfParagraph(state) {
  const { $from, $to, empty } = state.selection;
  return !empty && $from.sameParent($to) && $from.parent.isTextblock && ($from.parentOffset > 0 || $to.parentOffset < $from.parent.content.size);
}

/** What the tools act on now → {kind: 'cells', doc, ...cellsOf} | {kind: 'run'} | {kind: 'paras', paras: [{node, pos}]} | null.
 * A caret in a cell acts on that cell; text selected inside one cell acts on the text, with that cell as `cell` (the diagonals
 * and the dialog's Apply to Cell and Table use it). */
export function targetOf(state) {
  if (!state) return null;
  const doc = state.doc;
  const cells = cellsOf(state);
  if (cells) return { kind: 'cells', doc, ...cells };
  const at = cellAt(state);
  if (at && state.selection.empty) return { kind: 'cells', doc, ...at };
  const cell = at ? { kind: 'cells', doc, ...at } : undefined;
  if (partOfParagraph(state)) return { kind: 'run', cell };
  const paras = textblocks(state);
  return paras.length ? { kind: 'paras', paras, cell } : null;
}

/** The edges table `table` draws in `doc`: its style chain's table borders with its own (table.borders) over them (sixOf). */
export function tableEdges(doc, table) {
  let out = {};
  for (const s of styleChain(doc, table.attrs.styleId)) out = { ...out, ...sixOf(s.table?.borders) };
  return { ...out, ...(isPlain(table.attrs.borders) ? table.attrs.borders : null) };
}

/** The selected cells of a cells target → [{id (absolute pos), node, rect, borders (the edges drawn: own, table, style)}]. */
export function cellList(t) {
  const te = tableEdges(t.doc, t.table);
  return t.map.cellsInRect(t.rect).map((rel) => {
    const node = t.table.nodeAt(rel);
    const rect = t.map.findCell(rel);
    return { id: t.start + rel, node, rect, borders: cellEdges(node.attrs.borders, rect, t.map.width, t.map.height, te) };
  });
}

/** Paragraph `node`'s style borders in `doc` (its chain, v1's `border` read as borders), or {}. */
export function styleBorders(doc, node) {
  let out = {};
  for (const s of styleChain(doc, styleIdOf(node))) out = { ...out, ...(s.para?.borders ?? s.para?.border) };
  return out;
}

/** Paragraph `node`'s style shading in `doc`, or null. */
export function styleShading(doc, node) {
  let out = null;
  for (const s of styleChain(doc, styleIdOf(node))) out = s.para?.shading ?? out;
  return out;
}

/** The borders paragraph `node` shows: its style's with its own edges over them. */
export const bordersOf = (doc, node) => ({ ...styleBorders(doc, node), ...node.attrs.borders });

/** The textStyle border over the selection's start (part of a paragraph). */
export function runBorder(state) {
  const type = state.schema.marks.textStyle;
  return type?.isInSet(state.selection.$from.marks())?.attrs.border ?? type?.isInSet(state.doc.resolve(state.selection.from + 1).marks())?.attrs.border ?? null;
}

/** A transaction step: `fn(tr)` run through ctx.chain, so it lands as one undo step on the target with the focus back. */
export const write = (ctx, fn) => ctx.chain((c) => c.command(({ tr }) => {
  fn(tr);
  return true;
}));

/** Patches attribute `key` of the node at `pos` in `tr` (plan.md §1.8: never rebuilt; an empty object becomes null). */
export function patchAttr(tr, pos, key, patch) {
  const old = tr.doc.nodeAt(pos).attrs[key];
  const next = patch === null ? null : isPlain(patch) && isPlain(old) ? deepPatch(old, patch) : isPlain(patch) ? deepPatch({}, patch) : patch;
  tr.setNodeAttribute(pos, key, isPlain(next) && !Object.keys(next).length ? null : next);
}

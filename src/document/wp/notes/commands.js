// The Footnotes group's commands (docs/plans/word/plan.md §1.3, briefs/notes.md): Insert Footnote and Endnote (Ctrl+Alt+F and
// Ctrl+Alt+D through WordKeys), the Next Footnote split button and its menu, Show Notes, the launcher, Convert, the double-click
// jump and x.reveal.note for other packages (navigation pane, find, review).
import { TextSelection } from '@tiptap/pm/state';
import { openPane } from '../../../tooling/panes.jsx';
import { ensureStyles } from '../../model/styles.mjs';
import { closeNote, findNote, openNote, openOf, openWhenDrawn } from './edit.js';
import { convertContent, convertPlan, freshId, NOTE_STYLES, notesOf, STYLE_IDS } from './model.mjs';

export const BODY_ONLY = 'Notes go in the main text.';
const NO_NOTES = 'The document has no notes yet.';

/** Adds to `tr` a `kind` note at the end of its selection (Word puts the reference after the selected text), its text in the
 * Footnote Text or Endnote Text style; the note styles come in on first use. `mark` is a custom mark. → id. */
export function insertNoteTr(tr, kind, { mark = null } = {}) {
  const id = freshId(new Set(notesOf(tr.doc).map((n) => n.node.attrs.id)));
  const node = tr.doc.type.schema.nodes.noteRef.create({ kind, id, mark: mark || null, content: [{ type: 'paragraph', attrs: { styleId: STYLE_IDS[kind].text } }] });
  const to = tr.selection.to;
  tr.replaceRangeWith(to, to, node);
  const styles = ensureStyles(tr.doc, NOTE_STYLES);
  if (styles) tr.setDocAttribute('styles', styles);
  const at = findNote(tr.doc, id);
  if (at) tr.setSelection(TextSelection.create(tr.doc, at.pos + 1));
  tr.scrollIntoView();
  return id;
}

/** Inserts a `kind` note at the end of `ed`'s selection and opens its text (insertNoteTr). → id. */
export function insertNote(ed, kind, opts) {
  const tr = ed.state.tr;
  const id = insertNoteTr(tr, kind, opts);
  ed.view.dispatch(tr);
  openWhenDrawn(ed, id);
  return id;
}

/** The note the selection is on in `ctx`: the open note, a selected reference, or the reference just before or after the caret. */
export function currentNote(ctx) {
  const ed = ctx.ed;
  if (!ed) return null;
  const open = openOf(ed);
  if (open) return findNote(ed.state.doc, open.id);
  const sel = ed.state.selection;
  if (sel.node?.type.name === 'noteRef') return { pos: sel.from, node: sel.node };
  const { $from } = sel;
  for (const n of [$from.nodeBefore, $from.nodeAfter]) {
    if (n?.type.name !== 'noteRef') continue;
    return { pos: n === $from.nodeBefore ? $from.pos - n.nodeSize : $from.pos, node: n };
  }
  return null;
}

/** Moves the caret to the next (`dir` 1) or previous (-1) reference of `kind` from the selection → false when there is none. */
function browse(ctx, kind, dir) {
  const ed = ctx.ed;
  if (!ed) return false;
  const open = openOf(ed);
  const from = open ? findNote(ed.state.doc, open.id)?.pos ?? ed.state.selection.from : ed.state.selection.from;
  closeNote(ed);
  const list = notesOf(ed.state.doc).filter((n) => n.node.attrs.kind === kind);
  const hit = dir > 0 ? list.find((n) => n.pos > from) : list.findLast((n) => n.pos < from);
  if (!hit) {
    ctx.toast(`No ${dir > 0 ? 'next' : 'previous'} ${kind}.`);
    return false;
  }
  ed.chain().focus().setTextSelection(hit.pos).scrollIntoView().run();
  return true;
}

const has = (ctx, kind) => !!ctx.ed && notesOf(ctx.ed.state.doc).some((n) => !kind || n.node.attrs.kind === kind);
const browser = (kind, dir) => ({
  run: (ctx) => browse(ctx, kind, dir),
  enabled: (ctx) => has(ctx, kind),
  reason: (ctx) => (has(ctx, kind) ? null : `The document has no ${kind}s.`),
});
const insert = (kind) => ({
  run: (ctx) => insertNote(ctx.ed, kind),
  enabled: (ctx) => !!ctx.ed && ctx.story === 'body',
  reason: (ctx) => (ctx.story === 'body' ? null : BODY_ONLY),
});

/** Opens a note of `kind` near the caret: the first at or after it, else the last before it. */
function showArea(ctx, kind) {
  const ed = ctx.ed;
  const list = notesOf(ed.state.doc).filter((n) => n.node.attrs.kind === kind);
  const from = ed.state.selection.from;
  const hit = list.find((n) => n.pos >= from) ?? list.at(-1);
  return hit ? openNote(ed, hit.node.attrs.id) : false;
}

/** Show Notes: from a note back to its reference; in Draft the Notes pane; else to the note area of the kind the document has,
 * asking which when it has both. */
async function showNotes(ctx) {
  const ed = ctx.ed;
  const open = openOf(ed);
  if (open) return closeNote(ed, { focusRef: true });
  if (ctx.view === 'draft' || ctx.view === 'outline' || ctx.view === 'web') {
    openPane('notes', {});
    return true;
  }
  const kinds = ['footnote', 'endnote'].filter((k) => has(ctx, k));
  const kind = kinds.length > 1 ? await ctx.dialog('showNotes', {}) : kinds[0];
  return kind ? showArea(ctx, kind) : false;
}

/** Converts notes in one undo step: `mode` 'toEndnotes', 'toFootnotes' or 'swap' over the document, or 'this' for the current
 * note. The note text moves to the other kind's text style and the note styles come in. → the number converted. */
export function convertNotes(ctx, mode) {
  const ed = ctx.ed;
  if (!ed) return 0;
  let plan;
  if (mode === 'this') {
    const cur = currentNote(ctx);
    plan = cur ? [{ ...cur, kind: cur.node.attrs.kind === 'footnote' ? 'endnote' : 'footnote' }] : [];
  } else plan = convertPlan(ed.state.doc, mode);
  if (!plan.length) return 0;
  closeNote(ed);
  const tr = ed.state.tr;
  for (const { pos, node, kind } of plan) tr.setNodeMarkup(pos, null, { ...node.attrs, kind, content: convertContent(node.attrs.content, kind) });
  const styles = ensureStyles(tr.doc, NOTE_STYLES);
  if (styles) tr.setDocAttribute('styles', styles);
  ed.view.dispatch(tr);
  return plan.length;
}

/** A double-click on a reference opens its note; on a note (its story is the target) it returns to the reference. */
function doubleClickMark(ctx) {
  const ed = ctx.ed;
  if (!ed) return false;
  if (openOf(ed)) return closeNote(ed, { focusRef: true });
  const cur = currentNote(ctx);
  return cur ? openNote(ed, cur.node.attrs.id) : false;
}

export const COMMANDS = {
  'references.footnotes.insertFootnote': insert('footnote'),
  'references.footnotes.insertEndnote': insert('endnote'),
  'references.footnotes.nextFootnote': browser('footnote', 1),
  'references.footnotes.nextFootnote.nextFootnote': browser('footnote', 1),
  'references.footnotes.nextFootnote.previousFootnote': browser('footnote', -1),
  'references.footnotes.nextFootnote.nextEndnote': browser('endnote', 1),
  'references.footnotes.nextFootnote.previousEndnote': browser('endnote', -1),
  'references.footnotes.showNotes': {
    run: (ctx) => showNotes(ctx),
    enabled: (ctx) => has(ctx),
    reason: (ctx) => (has(ctx) ? null : NO_NOTES),
  },
  'references.footnotes.launcher': {
    run: (ctx) => {
      ctx.dialog('footnoteAndEndnote', {}); // the dialog does its own work; nothing waits on it
      return true;
    },
    enabled: (ctx) => !!ctx.ed,
  },
  'notes.convert': {
    run: async (ctx, arg) => {
      const mode = arg ?? await ctx.dialog('convertNotes', {});
      return mode ? convertNotes(ctx, mode) : false;
    },
    enabled: (ctx) => has(ctx),
    reason: (ctx) => (has(ctx) ? null : NO_NOTES),
  },
  'notes.doubleClickMark': { run: doubleClickMark, enabled: (ctx) => has(ctx) },
  // Another package shows a note: arg {id, from?, to?} (positions in the note's text).
  'x.reveal.note': {
    run: (ctx, arg) => !!ctx.ed && !!arg?.id && openNote(ctx.ed, arg.id, { select: arg.from == null ? null : { from: arg.from, to: arg.to } }),
  },
};

/** handleDoubleClickOn for a reference in `view`: opens its note. */
export function dblclickRef(view, pos, node) {
  const ed = view.dom.editor;
  if (!ed || view.dom.hasAttribute('data-story')) return false;
  openNote(ed, node.attrs.id);
  return true;
}

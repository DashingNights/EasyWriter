// Footnotes and endnotes (docs/plans/word/plan.md §3 notes, briefs/notes.md): noteRef references drawn with Word's numbering,
// footnote areas on their references' pages (a page layer with a layout pass), endnote areas after the document or each section,
// note text edited in place in a story editor, navigation, the Footnote and Endnote dialog, Convert, the Notes pane, the note
// styles and the noteLabel field provider.
import { footnoteLayer, layoutNotes, measurer } from './area.js';
import { COMMANDS, dblclickRef } from './commands.js';
import { ConvertNotes, FootnoteAndEndnote, ShowNotes } from './dialogs.jsx';
import { closeNote, wireArea } from './edit.js';
import { labelsOf, notesOf } from './model.mjs';
import { NotesPane } from './pane.jsx';
import { notesExtension } from './view.js';

/** Wires a drawn note area `el` of `view` (clicks open notes) and, once it is in place, re-places the open note's editor. */
const wire = (el, view) => {
  const ed = view.dom.editor;
  if (!ed) return;
  wireArea(el, ed);
  queueMicrotask(() => view.dom.dispatchEvent(new CustomEvent('w-notes-drawn')));
};

/** noteLabel for NOTEREF (fields-ref): the first noteRef in [from, to) of the field context's doc → {kind, label, text} or null.
 * One position finds the reference at it. */
function noteLabel(ctx, from, to = from + 1) {
  const doc = ctx?.doc;
  if (!doc || from == null) return null;
  const hit = notesOf(doc).find((n) => n.pos >= from && n.pos < to);
  if (!hit) return null;
  const pageOf = (pos) => ctx.pageAt?.(pos)?.index ?? ctx.geometry?.pageOf?.(pos) ?? 0;
  const l = labelsOf(doc, pageOf).get(hit.pos);
  return l ? { kind: l.kind, label: l.label, text: l.label } : null;
}

export default {
  id: 'notes',
  extensions: [notesExtension({ measurer, dblclick: dblclickRef, wire })],
  commands: COMMANDS,
  dialogs: { footnoteAndEndnote: FootnoteAndEndnote, convertNotes: ConvertNotes, showNotes: ShowNotes },
  panes: { notes: { title: 'Notes', side: 'right', width: 20, Component: NotesPane } },
  layers: [footnoteLayer(wire)],
  passes: [{ id: 'notes', phase: 'after', run: layoutNotes }],
  providers: { noteLabel },
  implements: ['notes.placement', 'notes.separators', 'notes.numbering', 'notes.styles', 'notes.notesPane'],
  setup: (editor) => () => closeNote(editor),
};

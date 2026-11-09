// The noteRef node view, the endnote areas and the labels (docs/plans/word/plan.md §1.2 Node views, briefs/notes.md How). A
// reference draws its label, computed once per doc version (model.mjs labelsOf); Restart each page needs the exact page of each
// reference, which the layout pass (area.js) supplies and patches into the drawn labels. Endnotes are drawn by a widget after the
// last block of the document (or of each section with End of section), so they flow and paginate like text.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { geometryOf } from '../../geometry.js';
import { classTables } from '../../stylesheet.js';
import { contentId, noteBox, sepBox } from './draw.js';
import { effectivePr, endnoteGroups, labelsOf, notesOf, repeatedIds, STYLE_IDS } from './model.mjs';

export const notesKey = new PluginKey('wordNotes');

const RT = new WeakMap(); // EditorView → {doc, labels: Map(pos → {kind, label}), views: Set<NoteView>}
/** The per-view runtime of the notes plugin. */
export function rtOf(view) {
  let r = RT.get(view);
  if (!r) RT.set(view, (r = { doc: null, labels: new Map(), views: new Set() }));
  return r;
}

/** The labels of `view`'s doc → Map(pos → {kind, label, section}): from the geometry's block pages until the layout pass has the
 * exact page of each reference. */
export function labelsFor(view) {
  const rt = rtOf(view);
  const { doc } = view.state;
  if (rt.doc !== doc) {
    const geo = geometryOf(view.state);
    rt.doc = doc;
    rt.labels = labelsOf(doc, (pos) => geo?.pageOf(pos) ?? 0);
  }
  return rt.labels;
}

/** Replaces `view`'s labels (the layout pass's exact ones) and redraws the references → true when a drawn label changed. */
export function setLabels(view, labels) {
  const rt = rtOf(view);
  rt.doc = view.state.doc;
  rt.labels = labels;
  return refresh(view);
}

/** Redraws every reference label of `view` that changed → true when one did (its width can move text). */
export function refresh(view) {
  let changed = false;
  for (const nv of rtOf(view).views) if (nv.draw()) changed = true;
  return changed;
}

/** A noteRef drawn as `sup[data-note]` holding its label, in the Footnote Reference or Endnote Reference character style. */
class NoteView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = view.dom.ownerDocument.createElement('sup');
    this.dom.dataset.note = '';
    this.attrs();
    this.draw();
    rtOf(view).views.add(this);
  }

  attrs() {
    const { kind, id, mark } = this.node.attrs;
    const d = this.dom.dataset;
    d.kind = kind;
    d.id = id;
    d.cstyle = STYLE_IDS[kind]?.ref ?? STYLE_IDS.footnote.ref;
    if (mark) d.mark = mark;
    else delete d.mark;
  }

  /** Draws the current label → true when it changed. */
  draw() {
    const pos = this.getPos();
    const text = (pos == null ? null : labelsFor(this.view).get(pos)?.label) ?? this.node.attrs.mark ?? '';
    if (this.dom.textContent === text) return false;
    this.dom.textContent = text;
    return true;
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.attrs();
    this.draw();
    return true;
  }

  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  ignoreMutation() { return true; }
  destroy() { rtOf(this.view).views.delete(this); }
}

// Endnote areas and the footnote measurer, per doc.
const decoMemo = new WeakMap();

/** The endnote area after a group's last block: the separator, then each endnote. */
function endnoteArea(view, group, wire) {
  const d = view.dom.ownerDocument;
  const { schema, doc } = view.state;
  const labels = labelsFor(view);
  const el = d.createElement('div');
  el.dataset.endnotes = '';
  // The text width from the pages, not view.dom.clientWidth: the area is built inside ProseMirror's render, where a layout read
  // laid the whole document out (a long one took seconds). Its tabs lay out only once it is connected.
  const ctx = { schema, doc, width: geometryOf(view.state)?.pages[0]?.box.text, ownerDocument: d };
  const sep = sepBox(ctx, 'endnote', 'separator', effectivePr('endnote', doc.attrs.settings, null).sep);
  if (sep) el.append(sep);
  for (const { pos, node } of group.notes) {
    el.append(noteBox(ctx, { id: node.attrs.id, kind: 'endnote', label: labels.get(pos)?.label ?? '', content: node.attrs.content }));
  }
  classTables(el); // the table style's class (stylesheet.js tableStyleClass)
  wire?.(el, view);
  return el;
}

/** The decorations of `state`: an endnote area per group, and a hidden measuring box for footnote heights (area.js) at the
 * document's start, before pagination's first widget, so no page measure ever reads it. */
function decorationsOf(state, hooks) {
  const { doc } = state;
  let set = decoMemo.get(doc);
  if (set) return set;
  const notes = notesOf(doc);
  const decos = [];
  if (notes.some((n) => n.node.attrs.kind === 'footnote')) {
    decos.push(Decoration.widget(0, (view) => hooks.measurer(view), { side: -2, key: 'w-notes-measure', ignoreSelection: true, stopEvent: () => true }));
  }
  const labels = labelsOf(doc);
  const sep = contentId(effectivePr('endnote', doc.attrs.settings, null).sep);
  for (const group of endnoteGroups(doc)) {
    const key = group.notes.map(({ pos, node }) => `${node.attrs.id}:${contentId(node.attrs.content)}:${labels.get(pos)?.label}`).join(',');
    const end = group.pos === doc.content.size;
    decos.push(Decoration.widget(group.pos, (view) => endnoteArea(view, group, hooks.wire), {
      side: end ? 1 : -1, key: `w-endnotes:${end ? 'end' : 'section'}:${sep}:${key}`, ignoreSelection: true, stopEvent: () => true, // not its place: an edit above re-created it
    }));
  }
  set = DecorationSet.create(doc, decos);
  decoMemo.set(doc, set);
  return set;
}

/** The notes extension: node view, endnote areas, labels and the double-click on a reference. `hooks` {measurer(view) → element,
 * wire(el, view) (an endnote area's clicks), dblclick(view, pos, node) → handled}. */
export const notesExtension = (hooks) => Extension.create({
  name: 'wordNotes',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: notesKey,
      props: {
        nodeViews: { noteRef: (node, view, getPos) => new NoteView(node, view, getPos) },
        decorations: (state) => decorationsOf(state, hooks),
        handleDoubleClickOn: (view, pos, node) => node.type.name === 'noteRef' && hooks.dblclick(view, pos, node),
      },
      // A pasted or dropped copy of a reference carries its note's id (the clipboard HTML keeps data-id): the copy gets a fresh
      // one. The note that was there before keeps its id, so a cut and paste or a drag moves a note without renaming it.
      appendTransaction(trs, old, state) {
        if (!trs.some((t) => t.docChanged)) return null;
        const mapping = new Mapping();
        for (const t of trs) mapping.appendMapping(t.mapping);
        const fix = repeatedIds(state.doc, (id) => {
          const was = notesOf(old.doc).find((n) => n.node.attrs.id === id);
          const r = was && mapping.mapResult(was.pos, 1);
          return r && !r.deleted ? r.pos : null;
        });
        if (!fix.length) return null;
        const tr = state.tr;
        for (const { pos, id } of fix) tr.setNodeAttribute(pos, 'id', id);
        return tr;
      },
      view: () => ({
        // A new note renumbers the ones after it, whose nodes did not change: redraw every label on a doc change.
        update(view, prev) {
          if (view.state.doc !== prev.doc) refresh(view);
        },
      }),
    })];
  },
});

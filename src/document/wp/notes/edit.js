// Editing a note in place (docs/plans/word/plan.md §1.7 Story editors and the page overlay): a story sub-editor of the note's
// text mounted in the page overlay over the note's drawing (or in the Notes pane), its edits written back into the noteRef's
// content one batch per main undo step. One note is open at a time per document; Esc, a press in the main text or the reference's
// removal closes it.
import { TextSelection } from '@tiptap/pm/state';
import { openPane } from '../../../tooling/panes.jsx';
import { overlayOf, scaleOf } from '../../geometry.js';
import { mountStory, writeBack } from '../../word/story.js';
import { notesOf } from './model.mjs';
import { labelsFor } from './view.js';

const sessions = new WeakMap(); // main editor → {id, kind, story, host, hide, off}

/** The noteRef `id` in `doc` → {pos, node} or null. */
export const findNote = (doc, id) => notesOf(doc).find((n) => n.node.attrs.id === id) ?? null;

/** The note open for editing in `main` → {id, kind, editor, host} or null. */
export function openOf(main) {
  const s = main && sessions.get(main);
  return s && !s.story.editor.isDestroyed ? { id: s.id, kind: s.kind, editor: s.story.editor, host: s.host } : null;
}

/** The drawing of note `id` in `main`'s text (its footnote area part or endnote area box that starts the note), or null. */
export function drawnBox(main, id) {
  const all = main.view.dom.querySelectorAll(`[data-note-box][data-id="${CSS.escape(id)}"]`);
  return [...all].find((el) => el.parentElement?.dataset.notePart !== 'rest') ?? null;
}

/** Puts an overlay host over note `id`'s drawing; false when the note is not drawn. */
function place(main, s) {
  const box = drawnBox(main, s.id);
  if (!box || !s.overlay) return !!box;
  const view = main.view;
  const scale = scaleOf(view);
  const d = view.dom.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  s.host.style.left = `${(r.left - d.left) / scale}px`;
  s.host.style.top = `${(r.top - d.top) / scale}px`;
  s.host.style.width = `${r.width / scale}px`;
  return true;
}

/** Closes the note open in `main`, writing its last batch back. `focusRef` puts the caret after its reference in the main text. */
export function closeNote(main, { focusRef = false } = {}) {
  const s = sessions.get(main);
  if (!s) return false;
  sessions.delete(main);
  s.off();
  s.story.destroy();
  s.host.remove();
  s.hide.remove();
  if (!main.isDestroyed) main.view.dom.dispatchEvent(new CustomEvent('w-notes-session'));
  if (focusRef && !main.isDestroyed) {
    const at = findNote(main.state.doc, s.id);
    if (at) main.chain().focus().setTextSelection(at.pos + 1).scrollIntoView().run();
    else main.commands.focus();
  }
  return true;
}

/** Opens note `id` of `main` for editing: over its drawing, or in `host` (the Notes pane) when given; a note that is not drawn
 * (Draft, Web Layout, Outline) opens the Notes pane. `at` {x, y} puts the caret at a client point, `select` {from, to} selects in
 * the note's text. → true when an editor opened. */
export function openNote(main, id, { host: paneHost = null, at = null, select = null } = {}) {
  const found = findNote(main.state.doc, id);
  if (!found) return false;
  const open = sessions.get(main);
  if (open?.id === id && (!paneHost || open.host.parentElement === paneHost)) {
    open.story.focus();
    return true;
  }
  closeNote(main);
  const view = main.view;
  const overlay = !paneHost;
  if (overlay && !drawnBox(main, id)) {
    openPane('notes', { id });
    return false;
  }
  const d = view.dom.ownerDocument;
  const { kind } = found.node.attrs;
  const host = d.createElement('div');
  host.dataset.noteEdit = kind;
  host.dataset.id = id;
  host.style.setProperty('--w-note-label', JSON.stringify(labelsFor(view).get(found.pos)?.label ?? ''));
  if (overlay) {
    host.style.cssText += ';position:absolute;pointer-events:auto';
    overlayOf(view).append(host);
  } else paneHost.append(host);
  // The drawing stays in the layout under the editor but is not shown.
  const hide = d.createElement('style');
  hide.textContent = `.ProseMirror [data-note-box][data-id="${CSS.escape(id)}"] { visibility: hidden; }`;
  d.head.append(hide);

  const story = mountStory({
    kind,
    host,
    content: found.node.attrs.content,
    onChange: ({ content, attrs }) => {
      if (main.isDestroyed) return;
      writeBack(main, attrs, (tr) => {
        const at2 = findNote(tr.doc, id);
        if (at2) tr.setNodeMarkup(at2.pos, null, { ...at2.node.attrs, content });
      });
    },
    onExit: () => closeNote(main, { focusRef: true }),
  });
  const s = { id, kind, story, host, hide, overlay };
  // A double-click on the note's number (drawn before its first line) goes back to the reference.
  const dbl = (e) => {
    const start = story.editor.view.coordsAtPos(1);
    if (e.clientX < start.left && e.clientY < start.bottom + 2) {
      e.preventDefault();
      closeNote(main, { focusRef: true });
    }
  };
  host.addEventListener('dblclick', dbl);
  // A press in the main text closes the note; a focus that returns there after a dialog or menu does not.
  const onMainDown = () => closeNote(main);
  const onMainTr = ({ transaction }) => {
    if (!transaction.docChanged) return;
    if (!findNote(main.state.doc, id)) closeNote(main);
    else host.style.setProperty('--w-note-label', JSON.stringify(labelsFor(view).get(findNote(main.state.doc, id).pos)?.label ?? ''));
  };
  const onDrawn = () => place(main, s);
  view.dom.addEventListener('mousedown', onMainDown);
  main.on('transaction', onMainTr);
  view.dom.addEventListener('w-notes-drawn', onDrawn);
  s.off = () => {
    host.removeEventListener('dblclick', dbl);
    view.dom.removeEventListener('mousedown', onMainDown);
    main.off('transaction', onMainTr);
    view.dom.removeEventListener('w-notes-drawn', onDrawn);
  };
  sessions.set(main, s);
  view.dom.dispatchEvent(new CustomEvent('w-notes-session'));
  place(main, s);
  story.focus();
  const sv = story.editor.view;
  if (at) {
    const hit = sv.posAtCoords({ left: at.x, top: at.y });
    if (hit) sv.dispatch(sv.state.tr.setSelection(TextSelection.near(sv.state.doc.resolve(hit.pos))));
  } else if (select) {
    const size = sv.state.doc.content.size;
    sv.dispatch(sv.state.tr.setSelection(TextSelection.create(sv.state.doc, Math.min(select.from, size), Math.min(select.to ?? select.from, size))));
  } else story.editor.commands.focus('end');
  host.scrollIntoView?.({ block: 'nearest' });
  return true;
}

/** Opens note `id` once its drawing exists (the frame after an insert draws it); after a few frames without one, the Notes pane. */
export function openWhenDrawn(main, id, opts) {
  let frames = 0;
  const tick = () => {
    if (main.isDestroyed) return;
    if (drawnBox(main, id) || frames++ > 12) openNote(main, id, opts);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Wires a drawn area `el` of `main`'s view: a press on a note opens it there, at the press. */
export function wireArea(el, main) {
  el.addEventListener('mousedown', (e) => {
    const box = e.target.closest?.('[data-note-box]');
    if (!box || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    openNote(main, box.dataset.id, { at: { x: e.clientX, y: e.clientY } });
  });
}

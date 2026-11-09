// Legacy form fields (plan.md §1.8 field ff, §3 content-controls; index-fields.md Legacy form fields): FORMTEXT, FORMCHECKBOX and
// FORMDROPDOWN as field nodes with ff, each between a pair of bookmarks named Text1, Check1, Dropdown1 and up, so REF and = read
// them. They take input only while the document is protected for filling in forms (protect owns the flag; this file only reads
// it): Tab and Shift+Tab move between the enabled fields, Space toggles a check box, Alt+Down opens a drop-down, typing edits a
// text field in a box over it, F1 shows the help text, and Calculate on exit updates every field.
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection } from '@tiptap/pm/state';
import { computeField, updateFields } from '../../fields/engine.js';
import { fieldCtx } from '../../fields/registry.mjs';
import { caseText, checkFormText, EN_SPACES, ffDefaults, ffResult, FORM_KINDS, BOOKMARK_PREFIX, nextBookmarkName, quoteCode, resetFf } from './model.mjs';
import { PickList, popover } from './pop.jsx';

/** The form field kind ('text', 'checkBox', 'dropDown') of field `node`, or null. */
export const kindOf = (node) => (node?.type.name === 'field' ? FORM_KINDS[String(node.attrs.code).trim().split(/\s+/)[0].toUpperCase()] ?? null : null);

/** Whether `doc` is protected for filling in forms (protect's settings.protection, _gaps-tracking.md G4). */
export const formsProtected = (doc) => {
  const p = doc.attrs.settings?.protection;
  return !!p && p.edit === 'forms' && !!p.enforcement;
};

/** Every form field of `doc` in order → [{pos, node, kind}]. */
export function formFields(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    const kind = kindOf(node);
    if (kind) out.push({ pos, node, kind });
  });
  return out;
}

const bookmarkNames = (doc) => {
  const names = [];
  doc.descendants((n) => {
    if (n.type.name === 'bookmark' && !n.attrs.end) names.push(n.attrs.name);
  });
  return names;
};

/** Inserts a form field of `kind` at the selection of `editor`, between its bookmark pair. */
export function insertFormField(editor, kind) {
  const { state } = editor;
  const { schema } = state;
  const name = nextBookmarkName(BOOKMARK_PREFIX[kind], bookmarkNames(state.doc));
  const ff = ffDefaults(kind, name);
  const code = Object.keys(FORM_KINDS).find((k) => FORM_KINDS[k] === kind);
  const id = String(Math.floor(Math.random() * 2 ** 31));
  const nodes = [
    schema.nodes.bookmark.create({ name, id }),
    schema.nodes.field.create({ code, ff, result: ffResult(kind, ff, '') }),
    schema.nodes.bookmark.create({ name, id, end: true }),
  ];
  const { from, to } = state.selection;
  editor.view.dispatch(closeHistory(state.tr.replaceWith(from, to, nodes)).scrollIntoView());
  editor.view.focus();
  return true;
}

/** Writes `ff` patch and the result `text` of the form field at `pos` (meta wordEngine: protect's filter lets a form fill through). */
export function setFormField(view, pos, patch, text) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return false;
  const ff = { ...node.attrs.ff, ...patch };
  const result = text ?? ffResult(kindOf(node), ff, node.attrs.result === EN_SPACES ? '' : node.attrs.result);
  view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, ff, result }, node.marks).setMeta('wordEngine', true));
  afterExit(view, ff);
  return true;
}

/** Calculate on exit: every field updates, so = fields that read the form's bookmarks follow. */
function afterExit(view, ff) {
  const editor = view.dom.editor; // TipTap keeps the editor on its root element
  if (ff.calcOnExit && editor) updateFields(editor, 'all', 'manual');
}

/** Reset Form Fields: every form field back to its default, one undo step. */
export function resetFormFields(view) {
  const tr = view.state.tr;
  for (const { pos, node, kind } of formFields(view.state.doc)) {
    const { ff, result } = resetFf(kind, node.attrs.ff ?? ffDefaults(kind, ''));
    tr.setNodeMarkup(pos, null, { ...node.attrs, ff, result }, node.marks);
  }
  if (tr.docChanged) view.dispatch(tr.setMeta('wordEngine', true));
  return true;
}

/** The text a FORMTEXT shows for typed `value`: its Text format through a QUOTE field (fields-core's formatter), else our case rules. */
export function formattedText(view, pos, ff, value) {
  const code = value ? quoteCode(ff, value) : null;
  if (!code) return value || EN_SPACES;
  const r = computeField(code, fieldCtx({ doc: view.state.doc, pos }));
  const text = typeof r === 'string' ? r : r?.text;
  return text ?? caseText(ff.format, value);
}

/** Opens the box that edits the FORMTEXT at `pos`: Maximum length and Type are checked, Enter or leaving writes it. */
export function editFormText(view, pos, toast) {
  const node = view.state.doc.nodeAt(pos);
  const el = view.nodeDOM(pos);
  if (!node || !el?.getBoundingClientRect) return;
  const ff = { ...ffDefaults('text', ''), ...node.attrs.ff };
  if (!ff.enabled || ff.type === 'currentDate' || ff.type === 'currentTime' || ff.type === 'calculated') return;
  const r = el.getBoundingClientRect();
  const input = document.createElement('input');
  input.setAttribute('data-cc-formtext', '');
  input.value = node.attrs.result === EN_SPACES ? '' : node.attrs.result ?? '';
  if (ff.maxLength > 0) input.maxLength = ff.maxLength;
  input.style.cssText = `position:fixed;left:${r.left}px;top:${r.top - 2}px;min-width:${Math.max(60, r.width + 8)}px;height:${r.height + 4}px;`
    + 'z-index:60;font:inherit;padding:0 2px;border:1px solid var(--ring, #888);background:var(--background, #fff);color:inherit';
  const style = getComputedStyle(el);
  input.style.fontFamily = style.fontFamily;
  input.style.fontSize = style.fontSize;
  document.body.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save, move = 0) => {
    if (done) return;
    if (save) {
      const message = checkFormText(ff, input.value);
      if (message) {
        toast?.(message);
        input.focus();
        return;
      }
      const at = view.state.doc.nodeAt(pos) === node ? pos : null;
      if (at != null) setFormField(view, at, {}, formattedText(view, at, ff, input.value));
    }
    done = true;
    input.remove();
    view.focus();
    if (move) moveField(view, move, toast);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
    else if (e.key === 'F1') { e.preventDefault(); toast?.(ff.help || 'This field has no help text.'); }
  });
  input.addEventListener('blur', () => setTimeout(() => finish(true)));
}

/** Tab (dir 1) or Shift+Tab (dir -1) under forms protection: the next enabled form field, wrapping, selected and opened for input
 * when it is a text field. */
export function moveField(view, dir, toast) {
  const list = formFields(view.state.doc).filter((f) => f.node.attrs.ff?.enabled !== false);
  if (!list.length) return false;
  const here = view.state.selection.from;
  const next = dir > 0 ? list.find((f) => f.pos > here) ?? list[0] : [...list].reverse().find((f) => f.pos < here) ?? list.at(-1);
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, next.pos)).scrollIntoView());
  if (next.kind === 'text') editFormText(view, next.pos, toast);
  return true;
}

/** A form field's input under protection: Space on a check box, Alt+Down on a drop-down → handled. */
export function toggleFormCheck(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  const ff = { ...ffDefaults('checkBox', ''), ...node.attrs.ff };
  if (!ff.enabled) return false;
  return setFormField(view, pos, { checked: !(ff.checked ?? ff.default) });
}

/** Opens a drop-down form field's list under protection. */
export function openFormDrop(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  const ff = { ...ffDefaults('dropDown', ''), ...node.attrs.ff };
  if (!ff.enabled) return false;
  popover(view.nodeDOM(pos), (close) => (
    <PickList items={ff.items.map((label, i) => ({ label, active: i === (ff.result ?? 0) }))} onPick={(i) => {
      close();
      const at = view.state.doc.nodeAt(pos) === node ? pos : null;
      if (at != null) setFormField(view, at, { result: i });
      view.focus();
    }} />
  ));
  return true;
}

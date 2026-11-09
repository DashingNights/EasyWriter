// Edits of content controls (plan.md §1.8 sdt object, §3 content-controls) shared by the node view, the commands and the plugin.
// Every writer patches the sdt object ({...old, ...patch}) and never rebuilds it.
import { Fragment } from '@tiptap/pm/model';
import { PluginKey, TextSelection } from '@tiptap/pm/state';
import { SDT_DEFAULTS } from '../../model/nodes.js';
import { formatDate, newSdt, placeholderOf } from './model.mjs';

/** The plugin's key; a transaction with meta KEY set is the plugin's own (a binding write, a placeholder restore) and skips the locks. */
export const KEY = new PluginKey('contentControls');

/** View state (not stored): Design Mode and Ctrl+Shift+X's tags. */
export const flags = { design: false, tags: false };

/** The sdt object of `node` with the schema's defaults under it. */
export const sdtOf = (node) => ({ ...SDT_DEFAULTS, ...node.attrs.sdt });

const isSdt = (node) => node?.type.name === 'sdtInline' || node?.type.name === 'sdtBlock';

/** The innermost control holding resolved position `$pos` → {pos, node, depth} or null; `type` limits it to one sdt type. */
export function controlAt($pos, type) {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (isSdt(node) && (!type || node.attrs.sdt?.type === type)) return { pos: $pos.before(d), node, depth: d };
  }
  return null;
}

/** The control the selection is on: a node-selected control, else the innermost one around the caret. */
export function selectedControl(state) {
  const { selection } = state;
  if (isSdt(selection.node)) return { pos: selection.from, node: selection.node };
  return controlAt(selection.$from);
}

/** The content of a control of `node`'s kind holding plain `text`: text for an inline control, one paragraph for a block one. */
export function contentOf(schema, node, text) {
  // The text keeps the formatting of the text it replaces (a check box's MS Gothic and size), and a block its first paragraph's.
  let marks = null;
  node.descendants((n) => {
    if (marks == null && n.isText) marks = n.marks;
    return marks == null;
  });
  const inline = text ? schema.text(text, marks) : null;
  if (node.type.name === 'sdtInline') return inline ? Fragment.from(inline) : Fragment.empty;
  const first = node.firstChild?.type === schema.nodes.paragraph ? node.firstChild.attrs : null;
  return Fragment.from(schema.nodes.paragraph.create(first, inline));
}

/** Puts `tr` steps that replace the content of the control at `pos` with plain `text` and patch its sdt with `patch`. */
export function setControl(tr, pos, patch = null, text = undefined) {
  const node = tr.doc.nodeAt(pos);
  if (!node) return tr;
  if (text !== undefined) tr.replaceWith(pos + 1, pos + node.nodeSize - 1, contentOf(tr.doc.type.schema, node, text));
  if (patch) tr.setNodeMarkup(pos, null, { ...node.attrs, sdt: { ...node.attrs.sdt, ...patch } }, node.marks);
  return tr;
}

/** Dispatches a change of the control at `pos` in `view` (one undo step). */
export function editControl(view, pos, patch, text) {
  view.dispatch(setControl(view.state.tr, pos, patch, text).scrollIntoView());
  return true;
}

/** Selects the content of the control at `pos` (a placeholder is picked whole, as Word does). */
export function selectContent(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  if (!node) return;
  const from = node.type.name === 'sdtBlock' ? pos + 2 : pos + 1;
  const to = node.type.name === 'sdtBlock' ? Math.max(from, pos + node.nodeSize - 2) : pos + node.nodeSize - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/** Check Box: flips sdt.checked and draws the matching symbol. */
export function toggleCheck(view, pos) {
  const s = sdtOf(view.state.doc.nodeAt(pos));
  return editControl(view, pos, { checked: !s.checked }, s.checked ? s.uncheckedChar : s.checkedChar);
}

/** Combo Box and Drop-Down List: shows item `i` (its display text). */
export function pickItem(view, pos, i) {
  const item = sdtOf(view.state.doc.nodeAt(pos)).items[i];
  return item ? editControl(view, pos, { showingPlaceholder: false }, item.display) : false;
}

/** Date Picker: shows `date` (a Date, read in UTC) in the control's format and stores the day in sdt.date.full. */
export function pickDate(view, pos, date) {
  const s = sdtOf(view.state.doc.nodeAt(pos));
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const d = { format: 'M/d/yyyy', ...s.date };
  return editControl(view, pos, { showingPlaceholder: false, date: { ...d, full: day.toISOString().replace('.000Z', 'Z') } },
    formatDate(day, d.format));
}

/** Gives every control inside `json` (block JSON) a new id, for a copy that must not share its controls' ids. */
function freshIds(json) {
  const out = { ...json };
  if (out.attrs?.sdt) out.attrs = { ...out.attrs, sdt: { ...out.attrs.sdt, id: newSdt('x').id } };
  if (out.content) out.content = out.content.map(freshIds);
  return out;
}

/** Repeating Section: adds a copy of the last item after it. ponytail: the copy keeps the item's text, as typed; Word resets the
 * copy's controls to their placeholders. */
export function addRepeatingItem(view, pos) {
  const node = view.state.doc.nodeAt(pos);
  const last = node?.lastChild;
  if (!last) return false;
  const copy = view.state.schema.nodeFromJSON(freshIds(last.toJSON()));
  const at = pos + node.nodeSize - 1;
  view.dispatch(view.state.tr.insert(at, copy).scrollIntoView());
  return true;
}

/** Inserts a control of `sdt` at the selection of `editor`: around the selection when `wrap` and text is selected (inline inside
 * one paragraph, else a block control around the paragraphs), else an empty control showing its placeholder, its content selected.
 * `content`: the plain text of a new control instead of the placeholder (a check box's symbol, a bound property's value). */
export function insertControl(editor, sdt, { wrap = true, content, block = false } = {}) {
  const { state } = editor;
  const { schema } = state;
  const { from, to, empty, $from, $to } = state.selection;
  const tr = state.tr;
  if (!empty && wrap && !block && $from.sameParent($to) && $from.parent.inlineContent) {
    const slice = state.doc.slice(from, to).content;
    tr.replaceWith(from, to, schema.nodes.sdtInline.create({ sdt: { ...sdt, showingPlaceholder: false } }, slice));
  } else if (!empty && wrap) {
    const range = $from.blockRange($to);
    if (!range) return false;
    tr.wrap(range, [{ type: schema.nodes.sdtBlock, attrs: { sdt: { ...sdt, showingPlaceholder: false } } }]);
  } else {
    const text = content ?? placeholderOf(sdt);
    const showing = content == null && (!!text || sdt.type === 'picture');
    const type = block ? schema.nodes.sdtBlock : schema.nodes.sdtInline;
    const inner = text ? schema.text(text) : null;
    const node = type.create({ sdt: { ...sdt, showingPlaceholder: showing } }, block ? schema.nodes.paragraph.create(null, inner) : inner);
    if (block && $from.parent.inlineContent && !$from.parent.content.size) tr.replaceWith($from.before(), $from.after(), node);
    else if (block) tr.insert($from.after(), node);
    else tr.replaceSelectionWith(node, false);
    const at = tr.mapping.map(from, -1);
    const found = [];
    tr.doc.nodesBetween(Math.max(0, at - 2), Math.min(tr.doc.content.size, at + node.nodeSize + 2), (n, p) => {
      if (n.attrs?.sdt?.id === sdt.id) found.push(p);
    });
    if (found.length) {
      const p = found[0];
      const inBlock = block ? 1 : 0;
      tr.setSelection(TextSelection.create(tr.doc, p + 1 + inBlock, p + 1 + inBlock + (text?.length ?? 0)));
    }
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Removes the control at `pos`, keeping its content (Ungroup, Remove Content Control, a temporary control after its first edit). */
export function unwrapControl(tr, pos) {
  const node = tr.doc.nodeAt(pos);
  if (node) tr.replaceWith(pos, pos + node.nodeSize, node.content);
  return tr;
}

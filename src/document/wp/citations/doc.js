// Citations and bibliographies in a Document (briefs/citations.md): a citation is an sdtInline {type: 'citation'} holding a
// CITATION field, a bibliography an sdtBlock {type: 'docPart', docPart: {gallery: 'Bibliographies'}} holding an optional Heading 1
// and a BIBLIOGRAPHY fieldBlock. Results are computed from the draft's sources and style (fields.mjs) and written as one undo step.
// app/references.js and this package's commands and dialogs come through here; nothing here imports app/references.js.
import { closeHistory } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { getState } from '../../../app/store.js';
import { styleOf } from '../../../references.mjs';
import { updateFields } from '../../fields/engine.js';
import { parseField } from '../../fields/registry.mjs';
import { SDT_DEFAULTS } from '../../model/nodes.js';
import { flowDepth } from '../columns/model.mjs';
import { ensureStyles } from '../../model/styles.mjs';
import { BIBLIOGRAPHY_STYLE, bibliographyBlocks, citationCode, citationText, parseCitation } from './fields.mjs';

/** Whether the open draft is a Document (a forum post keeps the plain-text builder). */
export const isDocument = () => getState().draft?.format === 'document';
/** The open Document's style: its own, else the default, else Harvard; Word's styles count (references.mjs styleOf). */
export const docStyle = () => styleOf(getState().draft, getState().settings, true);
/** What CITATION and BIBLIOGRAPHY compute from: {sources (the current list), style}. */
export const envNow = () => ({ sources: getState().draft?.sources ?? [], style: docStyle() });

// w:id is a signed 32-bit number in Word's files.
const newId = () => String(1 + Math.floor(Math.random() * 0x7ffffffe));
const NAMES = ['CITATION', 'BIBLIOGRAPHY'];

/** Updates every CITATION and BIBLIOGRAPHY field of `ed` (Update Citations and Bibliography) as one undo step → the count. */
export const updateCitations = (ed) => (ed ? updateFields(ed, 'all', 'manual', { names: NAMES }) : Promise.resolve(0));

/** Writes every unlocked CITATION result and BIBLIOGRAPHY of `tr`'s doc anew (a numbered style renumbers when a citation comes in). */
function refreshIn(tr) {
  const env = envNow();
  const at = [];
  tr.doc.descendants((n, pos) => {
    if (n.type.name !== 'field' && n.type.name !== 'fieldBlock') return true;
    const f = parseField(n.attrs.code);
    if (NAMES.includes(f.name) && !n.attrs.locked) at.push({ n, pos, f });
    return false;
  });
  const { doc } = tr;
  const { schema } = doc.type;
  // From the end, so a bibliography that changes size leaves the earlier positions as they are.
  for (const { n, pos, f } of at.reverse()) {
    if (f.name === 'CITATION') tr.setNodeMarkup(pos, null, { ...n.attrs, result: citationText(parseCitation(f), doc, env), dirty: false }, n.marks);
    else tr.replaceWith(pos + 1, pos + n.nodeSize - 1, bibliographyBlocks(doc, env).map((j) => schema.nodeFromJSON(j)));
  }
  return tr;
}

/** Puts a citation control of `tag` at `ed`'s selection (after a selected block, never in its place). Every citation and
 * bibliography is written anew in the same step (one undo step), since in a numbered style the new one may come first. */
export function insertCitationControl(ed, tag) {
  const { state } = ed;
  const { schema } = state;
  const c = { tags: [tag], lcid: '1033' };
  const field = schema.nodes.field.create({ code: citationCode(c), result: '' });
  const node = schema.nodes.sdtInline.create({ sdt: { ...SDT_DEFAULTS, id: newId(), type: 'citation' } }, field);
  const tr = state.tr;
  if (tr.selection instanceof NodeSelection && !tr.selection.node.isInline) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to)));
  tr.replaceSelectionWith(node, false);
  ed.view.dispatch(closeHistory(refreshIn(tr)).scrollIntoView());
  ed.view.focus();
}

/** Points every CITATION of `ed` that cites tag `from` (first or \m) at `to`, after a source's tag changed. Kept out of the undo
 * history: the sources are not undone, so an undo would leave the citations pointing at a tag no source has. */
export function retagCitations(ed, from, to) {
  const tr = ed.state.tr;
  ed.state.doc.descendants((n, pos) => {
    if (n.type.name !== 'field') return true;
    const f = parseField(n.attrs.code);
    if (f.name !== 'CITATION') return false;
    const c = parseCitation(f);
    if (c.tags.includes(from)) tr.setNodeMarkup(pos, null, { ...n.attrs, code: citationCode({ ...c, tags: c.tags.map((t) => (t === from ? to : t)) }) }, n.marks);
    return false;
  });
  if (tr.docChanged) ed.view.dispatch(tr.setMeta('addToHistory', false));
}

/** The bibliography control for `heading` ('Bibliography', 'References', 'Works Cited'; null: Insert Bibliography, no heading). */
function bibliographyNode(state, heading) {
  const { schema } = state;
  const field = schema.nodes.fieldBlock.create({ code: 'BIBLIOGRAPHY' }, bibliographyBlocks(state.doc, envNow()).map((j) => schema.nodeFromJSON(j)));
  const kids = heading ? [schema.nodes.heading.create({ level: 1 }, schema.text(heading)), field] : [field];
  return schema.nodes.sdtBlock.create({ sdt: { ...SDT_DEFAULTS, id: newId(), type: 'docPart', docPart: { gallery: 'Bibliographies', category: null } } }, kids);
}
const withStyle = (tr) => {
  const styles = ensureStyles(tr.doc, BIBLIOGRAPHY_STYLE);
  if (styles) tr.setDocAttribute('styles', styles);
  return tr;
};

/** Puts a bibliography control (bibliographyNode) at the cursor: in place of the empty paragraph the cursor is in, else after the
 * text flow's block holding it (in newspaper columns, the column's block, as Word does: wp/columns flowDepth); the caret ends after
 * it. The Bibliography style comes in the same step. */
export function insertBibliography(ed, heading = null) {
  const { state } = ed;
  const node = bibliographyNode(state, heading);
  const tr = state.tr;
  const { $from, to } = tr.selection;
  const d = flowDepth($from);
  const top = $from.depth >= d ? $from.node(d) : null; // null: a block of the flow is selected
  const replace = top?.type.name === 'paragraph' && !top.content.size;
  const start = replace ? $from.before(d) : top ? $from.after(d) : to;
  if (replace) tr.replaceWith(start, $from.after(d), node);
  else tr.insert(start, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(start + node.nodeSize), 1));
  ed.view.dispatch(closeHistory(withStyle(tr)).scrollIntoView());
  ed.view.focus();
}

/** The content control of `kind` ('citation' or 'Bibliographies') at or around `state`'s selection → {pos, node} | null. */
export function sdtAt(state, kind) {
  const is = (n) => (kind === 'citation' ? n?.type.name === 'sdtInline' && n.attrs.sdt?.type === 'citation'
    : n?.type.name === 'sdtBlock' && n.attrs.sdt?.docPart?.gallery === kind);
  const sel = state.selection;
  if (is(sel.node)) return { pos: sel.from, node: sel.node };
  const { $from } = sel;
  for (let d = $from.depth; d > 0; d--) if (is($from.node(d))) return { pos: $from.before(d), node: $from.node(d) };
  if (is($from.nodeAfter)) return { pos: $from.pos, node: $from.nodeAfter };
  if (is($from.nodeBefore)) return { pos: $from.pos - $from.nodeBefore.nodeSize, node: $from.nodeBefore };
  return null;
}

/** The CITATION field inside citation control `at` → {pos, node, c (parseCitation)} | null. */
export function citationIn(at) {
  let out = null;
  at.node.descendants((n, p) => {
    if (out || n.type.name !== 'field') return !out;
    const f = parseField(n.attrs.code);
    if (f.name === 'CITATION') out = { pos: at.pos + 1 + p, node: n, c: parseCitation(f) };
    return false;
  });
  return out;
}

/** Gives the citation at the selection of `ed` the parts `c` (Edit Citation), its new result written in the same step. */
export function setCitation(ed, c) {
  const { state } = ed;
  const at = sdtAt(state, 'citation');
  const f = at && citationIn(at);
  if (!f) return false;
  const code = citationCode(c);
  ed.view.dispatch(closeHistory(state.tr.setNodeMarkup(f.pos, null, { ...f.node.attrs, code, result: citationText(c, state.doc, envNow()), dirty: false })));
  return true;
}

/** Convert citation (or bibliography) to static text: the control of `kind` at the selection becomes what it shows. */
export function convertToText(ed, kind) {
  const { state } = ed;
  const at = sdtAt(state, kind);
  if (!at) return false;
  const tr = state.tr;
  if (kind === 'citation') {
    let text = '';
    at.node.descendants((n) => {
      text += n.type.name === 'field' ? n.attrs.result ?? '' : n.isText ? n.text : '';
      return n.type.name !== 'field';
    });
    tr.replaceWith(at.pos, at.pos + at.node.nodeSize, text ? state.schema.text(text, at.node.firstChild?.marks) : []);
  } else {
    const blocks = [];
    at.node.forEach((n) => (n.type.name === 'fieldBlock' ? n.forEach((b) => blocks.push(b)) : blocks.push(n)));
    tr.replaceWith(at.pos, at.pos + at.node.nodeSize, blocks);
  }
  ed.view.dispatch(closeHistory(tr));
  return true;
}

/** Replaces the bibliography control at the selection with the built-in `heading`'s (its title bar's gallery). */
export function replaceBibliography(ed, heading) {
  const { state } = ed;
  const at = sdtAt(state, 'Bibliographies');
  if (!at) return false;
  const tr = state.tr.replaceWith(at.pos, at.pos + at.node.nodeSize, bibliographyNode(state, heading));
  ed.view.dispatch(closeHistory(withStyle(tr)));
  return true;
}

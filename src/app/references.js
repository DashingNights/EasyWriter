import { TextSelection } from '@tiptap/pm/state';
import {
  docStyle, insertBibliography, insertCitationControl, isDocument, retagCitations, updateCitations,
} from '../document/wp/citations/doc.js';
import { citationRuns, cleanSource, isoDay, labels, lookup, nextNumber, numbered, referenceListRuns, tagOf, textJson } from '../references.mjs';
import { activeSurface } from '../tooling/surface.js';
import { afterNodeSel, openDialog, run, saveSettings, updateDraft } from './actions.js';
import { getState, setState } from './store.js';

// The open draft's sources (docs/wiki/references.md, references.mjs): read from a pasted link through main's references.fetch,
// saved on the draft with updateDraft (so they go with it into the GitHub backup), and put in at the text cursor in the draft's
// style. Word's citation tools (document/wp/citations: the Insert Citation menu, Create Source, Source Manager), the tool search
// and the references.* commands all come through here. A Document (docs/plans/word/briefs/citations.md) cites with CITATION and
// BIBLIOGRAPHY fields in content controls (document/wp/citations/doc.js) and gives each source a tag; a forum post or page puts
// the same citations and reference list in as plain text (below). Both take Word's styles.

const EMPTY = [];
/** The open draft's sources (stored order). */
export const sourcesOf = (draft = getState().draft) => draft?.sources ?? EMPTY;
/** The open draft's reference style: its own, else the default, else Harvard (references.mjs styleOf, Word's styles included). */
export const styleNow = () => docStyle();
/** In a Document, refreshes every citation and bibliography after the sources or the style changed (one undo step). */
const refresh = () => (isDocument() ? updateCitations(getState().editor) : Promise.resolve(0));

async function patchDraft(patch) {
  const { draft } = getState();
  if (!draft) throw new Error('Open a draft first.');
  if (!(await updateDraft(draft.id, patch))) throw new Error('The draft could not be saved.');
}
// A draft keeps the style it had when it got its sources, whatever the default becomes later.
const write = (sources) => patchDraft({ sources, ...(!getState().draft?.referenceStyle && { referenceStyle: styleNow() }) });

/** The details of the link, DOI or arXiv id `text` → {source (no id), problem}; throws when `text` is none of those. */
export const lookupLink = (text) => lookup(text, { get: (url, accept) => window.api.references.fetch({ url, accept }), today: isoDay() });

/** Saves `fields` as a source of the open draft: in place of the source with its id, else as a new one (a new id, accessed
 * today unless given) → the saved source. */
export async function saveSource(fields) {
  const list = sourcesOf();
  const known = list.some((s) => s.id === fields.id);
  const source = { ...cleanSource({ accessed: isoDay(), ...fields }), id: known ? fields.id : fields.id ?? crypto.randomUUID() };
  // A Document's fields cite a source by its tag (Smi26), given here when it has none.
  if (isDocument() && !source.tag) source.tag = tagOf(source, new Set(list.filter((s) => s.id !== source.id).map((s) => s.tag)));
  await write(known ? list.map((s) => (s.id === source.id ? source : s)) : [...list, source]);
  // A new tag (a placeholder filled in, or one typed in Edit Source) takes the source's citations with it, as Word's does.
  const old = known && list.find((s) => s.id === source.id)?.tag;
  if (isDocument() && old && old !== source.tag && getState().editor) retagCitations(getState().editor, old, source.tag);
  await refresh();
  return source;
}

/** Removes the source `id` → the removed source. */
export async function removeSource(id) {
  const list = sourcesOf();
  const source = list.find((s) => s.id === id);
  if (!source) throw new Error('That source is not in this draft.');
  await write(list.filter((s) => s.id !== id));
  await refresh();
  return source;
}

/** The open draft's style → `style` (the default stays); a Document's citations and bibliographies follow in one undo step. */
export async function setStyle(style) {
  await patchDraft({ referenceStyle: style });
  await refresh();
}
/** The default style of drafts without their own → `style`. */
export const setDefaultStyle = (style) => saveSettings({ referenceStyle: style });

/** In a numbered draft, gives the sources `ids` (all when left out) that have no number the next ones, in stored order, and
 * saves them → the sources. Citations are plain text, so a number once given never changes. */
export async function numberSources(ids) {
  const list = sourcesOf();
  const missing = numbered(styleNow()) ? list.filter((s) => !s.num && (!ids || ids.includes(s.id))) : [];
  if (!missing.length) return list;
  let next = nextNumber(list);
  const out = list.map((s) => (missing.includes(s) ? { ...s, num: next++ } : s));
  await write(out);
  return out;
}

/** A post in the canvas page area's engine session, or null in the DOM editor. */
const engineOf = () => activeSurface()?.session ?? null;
/** `runs` as the post kit's JSON: the paragraph post.insert writes at the caret. */
const postText = (runs) => [{ type: 'paragraph', content: textJson(runs) }];

/** Puts source `id`'s citation at the text cursor in the draft's style (after a selected block, never in its place): Harvard
 * "(Anthropic, n.d.a)", `narrative` "Anthropic (n.d.a)", et al. in italics; numbered "[1]" (the source's number, given now if
 * it has none) or "Campbell and Verbrugge [1]". A canvas post inserts it through post.insert. */
export async function insertCitation(id, narrative = false) {
  if (isDocument()) return citeInDocument(id);
  const list = await numberSources([id]);
  const s = list.find((x) => x.id === id);
  const style = styleNow();
  if (!s) return;
  const runs = citationRuns(s, labels(list, style).get(id) ?? '', narrative, style);
  const engine = engineOf();
  if (engine) return void engine.exec('post.insert', { json: postText(runs) });
  run((c) => afterNodeSel(c).insertContent(textJson(runs)));
}

/** Puts `blocks` (post kit JSON) after the caret's paragraph, or in its place when it is empty: post.insert has paste
 * semantics, so at a caret inside a paragraph it would splice them into it (and take a selection with them). The caret ends
 * after the last block. */
async function insertBlocksAfter(engine, blocks) {
  await engine.exec('select.paragraph', {});
  const sel = (await engine.query('document.selection', {}))?.value ?? {};
  // The selection's text may end with the next paragraph's mark.
  if (!String(sel.text ?? '').replace(/[\r\n\u2029]/g, '')) {
    await engine.exec('select.collapse', {});
    return engine.exec('post.insert', { json: blocks });
  }
  // A paragraph's selection ends at the next paragraph's start (its mark included): step back to this one's own end, where the
  // empty paragraph in front of the blocks keeps them out of the text beside the caret.
  const next = (sel.focus?.path ?? []).join('.') !== (sel.anchor?.path ?? []).join('.');
  await engine.exec('select.collapse', { end: true });
  if (next) await engine.exec('caret.left', {});
  return engine.exec('post.insert', { json: [{ type: 'paragraph' }, ...blocks] });
}

/** Puts the reference list at the text cursor, one paragraph per entry: in place of the empty paragraph the cursor is in, else
 * after the top-level block holding it. The caret ends after the list. A numbered draft's sources without a number get theirs. */
export async function insertReferenceList() {
  if (isDocument()) {
    if (getState().editor) insertBibliography(getState().editor);
    return;
  }
  const list = referenceListRuns(await numberSources(), styleNow());
  if (!list.length) return;
  const engine = engineOf();
  if (engine) return void insertBlocksAfter(engine, list.map((runs) => ({ type: 'paragraph', content: textJson(runs) })));
  run((c) => c.command(({ tr, state }) => {
    const { schema } = state;
    const nodes = list.map((rs) => schema.nodes.paragraph.create(null, rs.map((r) => schema.text(r.text, r.italic ? [schema.marks.italic.create()] : null))));
    const { $from, to } = tr.selection;
    const top = $from.depth ? $from.node(1) : null; // null: a top-level block is selected
    const replace = top?.type.name === 'paragraph' && !top.content.size;
    const start = replace ? $from.before(1) : top ? $from.after(1) : to;
    if (replace) tr.replaceWith(start, $from.after(1), nodes);
    else tr.insert(start, nodes);
    tr.setSelection(TextSelection.near(tr.doc.resolve(start + nodes.reduce((n, x) => n + x.nodeSize, 0)), -1));
    return true;
  }));
}

/** Word's Source Manager on the draft's sources; in a forum post it also holds the style, a link lookup and Insert Bibliography.
 * Returns at once (a tool search run waits for what its entry returns). */
export function openReferences() {
  openDialog('sourceManager');
}

/** Add New Source: Create Source, then the new source's citation at the cursor → the source, or null when cancelled. */
export async function addNewSource() {
  const fields = await openDialog('createSource', {});
  if (!fields) return null;
  const s = await saveSource(fields);
  await insertCitation(s.id);
  return s;
}

/** A Document: puts source `id`'s citation control at the cursor (Word's Insert Citation), giving the source a tag first if it
 * has none. */
async function citeInDocument(id) {
  let s = sourcesOf().find((x) => x.id === id);
  if (!s) return;
  if (!s.tag) s = await saveSource(s);
  const ed = getState().editor;
  if (ed) insertCitationControl(ed, s.tag);
}

/** Word's Insert Citation menu at the text cursor (References.jsx CitePicker), in place of the quick tools island. On a canvas
 * post the DOM editor under the page area does not show the post, so the menu opens at the page's middle, as the DOM editor's
 * does when it cannot measure the caret. */
export function openCitePicker() {
  const engine = engineOf();
  if (!engine && !getState().editor) return;
  let at = null;
  if (!engine) {
    const ed = getState().editor;
    try {
      const r = ed.view.coordsAtPos(ed.state.selection.from);
      at = { x: r.left, y: r.bottom };
    } catch {
      at = null;
    }
  }
  setState({ citePicker: at ?? { x: innerWidth / 2, y: innerHeight / 3 }, quickTools: null });
}

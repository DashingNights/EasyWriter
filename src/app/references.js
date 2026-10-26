import { TextSelection } from '@tiptap/pm/state';
import { citationRuns, cleanSource, isoDay, labels, lookup, nextNumber, referenceListRuns, styleOf, textJson } from '../references.mjs';
import { afterNodeSel, openDialog, run, saveSettings, updateDraft } from './actions.js';
import { getState, setState } from './store.js';

// The open draft's sources (docs/plans/references.md, references.mjs): read from a pasted link through main's references.fetch,
// saved on the draft with updateDraft (so they go with it into the GitHub backup), and put in at the text cursor in the draft's
// style. The References dialog, the citation picker, the tool search and the references.* commands all come through here.

const EMPTY = [];
/** The open draft's sources (stored order). */
export const sourcesOf = (draft = getState().draft) => draft?.sources ?? EMPTY;
/** The open draft's reference style (references.mjs styleOf). */
export const styleNow = () => styleOf(getState().draft, getState().settings);

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
  await write(known ? list.map((s) => (s.id === source.id ? source : s)) : [...list, source]);
  return source;
}

/** Removes the source `id` → the removed source. */
export async function removeSource(id) {
  const list = sourcesOf();
  const source = list.find((s) => s.id === id);
  if (!source) throw new Error('That source is not in this draft.');
  await write(list.filter((s) => s.id !== id));
  return source;
}

/** The open draft's style → `style` (the default stays). */
export const setStyle = (style) => patchDraft({ referenceStyle: style });
/** The default style of drafts without their own → `style`. */
export const setDefaultStyle = (style) => saveSettings({ referenceStyle: style });

/** In a numbered draft, gives the sources `ids` (all when left out) that have no number the next ones, in stored order, and
 * saves them → the sources. Citations are plain text, so a number once given never changes. */
export async function numberSources(ids) {
  const list = sourcesOf();
  const missing = styleNow() === 'ieee' ? list.filter((s) => !s.num && (!ids || ids.includes(s.id))) : [];
  if (!missing.length) return list;
  let next = nextNumber(list);
  const out = list.map((s) => (missing.includes(s) ? { ...s, num: next++ } : s));
  await write(out);
  return out;
}

/** Puts source `id`'s citation at the text cursor in the draft's style (after a selected block, never in its place): Harvard
 * "(Anthropic, n.d.a)", `narrative` "Anthropic (n.d.a)", et al. in italics; numbered "[1]" (the source's number, given now if
 * it has none) or "Campbell and Verbrugge [1]". */
export async function insertCitation(id, narrative = false) {
  const list = await numberSources([id]);
  const s = list.find((x) => x.id === id);
  const style = styleNow();
  if (s) run((c) => afterNodeSel(c).insertContent(textJson(citationRuns(s, labels(list, style).get(id) ?? '', narrative, style))));
}

/** Puts the reference list at the text cursor, one paragraph per entry: in place of the empty paragraph the cursor is in, else
 * after the top-level block holding it. The caret ends after the list. A numbered draft's sources without a number get theirs. */
export async function insertReferenceList() {
  const list = referenceListRuns(await numberSources(), styleNow());
  if (!list.length) return;
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

/** The References dialog: the style, the sources, adding, editing and removing them, and Insert reference list. Returns at
 * once (a tool search run waits for what its entry returns). */
export function openReferences() {
  openDialog('references');
}

/** The citation picker at the text cursor (References.jsx CitePicker), in place of the quick tools island. */
export function openCitePicker() {
  const ed = getState().editor;
  if (!ed) return;
  let at;
  try {
    const r = ed.view.coordsAtPos(ed.state.selection.from);
    at = { x: r.left, y: r.bottom };
  } catch {
    at = { x: innerWidth / 2, y: innerHeight / 3 };
  }
  setState({ citePicker: at, quickTools: null });
}

// Where mail merge keeps its state (docs/plans/word/plan.md §1.8 doc attr merge, §1.12 draft record and store): the recipient list in
// the draft record (draft.mergeSource, written with draftMeta, so history and autosave never copy it), the user's choices in
// doc.attrs.merge (patched, never rebuilt), and the record shown while previewing in the store (word.preview, a 1-based position in
// the active list), so stepping through records adds no undo step. Highlight Merge Fields is view state in the store too.
import { closeHistory } from '@tiptap/pm/history';
import { draftMeta, toast } from '../../../app/actions.js';
import { getState, setState } from '../../../app/store.js';
import { active, autoMap, refusal } from './data.mjs';

/** doc.attrs.merge's keys before a merge starts (plan.md §1.8). */
export const MERGE_DEFAULTS = { type: null, sourceName: null, fields: null, filter: [], sort: [], map: {}, exclude: [], label: null, envelope: null };

/** The open draft's recipient list {name, fields, records}, or null. */
export const sourceOf = () => getState().draft?.mergeSource ?? null;

/** doc.attrs.merge of editor `ed` with the defaults filled in. */
export const mergeOf = (ed) => ({ ...MERGE_DEFAULTS, ...(ed?.state.doc.attrs.merge ?? {}) });

/** The records the merge goes through for `ed`: filtered, sorted and ticked → [{n, values}]. */
export const activeOf = (ed) => active(sourceOf(), mergeOf(ed));

/** Patches doc.attrs.merge of `ed` with `patch` (keys it does not name survive) as one undo step; `tr` adds to an open transaction. */
export function patchMerge(ed, patch, tr = null) {
  const own = tr ?? ed.state.tr;
  own.setDocAttribute('merge', { ...MERGE_DEFAULTS, ...(own.doc.attrs.merge ?? {}), ...patch });
  if (!tr) ed.view.dispatch(closeHistory(own));
  return own;
}

/** Merge type of `ed` ('letters', 'envelopes', 'labels', 'directory') or null for a normal document. */
export const typeOf = (ed) => ed?.state.doc.attrs.merge?.type ?? null;

/** The record shown while previewing (1-based position in the active list), or null when Preview Results is off. */
export const previewOf = () => getState().word?.preview ?? null;

/** Shows record `n` (clamped to the active list), or turns preview off with null. */
export function setPreview(n) {
  setState({ word: { ...getState().word, preview: n } });
}

/** Whether Highlight Merge Fields is on. */
export const highlightOf = () => !!getState().word?.mergeHighlight;
export const setHighlight = (on) => setState({ word: { ...getState().word, mergeHighlight: !!on } });

/** Makes `source` the open draft's recipient list for `ed`: refused with a toast past the record limit; Match Fields pairs columns
 * by name; a normal document becomes letters. `keep` keeps the filter, sort and exclusions (the list was edited, not replaced).
 * → whether it was taken. */
export async function setSource(ed, source, { keep = false } = {}) {
  const why = refusal(source);
  if (why) {
    toast(why, true);
    return false;
  }
  const merge = mergeOf(ed);
  await draftMeta({ mergeSource: source });
  setState({}); // the draft record changed in place: re-render what reads it
  patchMerge(ed, {
    sourceName: source.name, fields: source.fields, map: autoMap(source.fields, merge.map), type: merge.type ?? 'letters',
    ...(!keep && { filter: [], sort: [], exclude: [] }),
  });
  if (previewOf() != null) setPreview(1);
  return true;
}

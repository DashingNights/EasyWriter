// A Documents draft moving from the DOM editor to the engine as it opens (docs/plans/engine/stage3.md section 1). The record on disk
// and the form kept here stay the DOM form until the first canvas record is stored, so a failed conversion loses nothing: the draft
// goes back to that form and stays on the DOM editor, which session.js says in one line. Pure: node tests load it.
import { isCanvas, openDraft } from '../../engine/model/form.mjs';

/** "A", "A and B", "A, B and C". */
export const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);

/** The DOM form of `draft` to hold while it converts, or null for a canvas draft, which has nothing to keep. saveOnce's adopt drops
 * the doc before the store answers, so a failed first save needs it back. */
export const keepDom = (draft) => (draft && !isCanvas(draft) ? { doc: draft.doc, formatVersion: draft.formatVersion } : null);

/** Puts `draft` (changed in place) back in the DOM form `kept`. */
export function restoreDom(draft, kept) {
  delete draft.engine;
  Object.assign(draft, kept);
}

/** An error whose `why` finishes stayLine's sentence. */
export const refused = (why) => Object.assign(new Error(why), { why });

/** Opens `draft` in `client` (form.mjs openDraft). A DOM draft goes through a .docx export, so one that lost anything there is
 * refused: its next save would drop it for good. */
export async function openChecked(client, draft, deps) {
  const { dropped } = await openDraft(client, draft, deps);
  if (dropped.length) throw refused(`the canvas engine cannot take its ${list(dropped)}`);
}

/** The one line a draft left on the DOM editor shows. An engine's own error is not plain text: the console has it. */
export const stayLine = (title, error) => `${title || 'This draft'} stays in the DOM editor because ${error?.why ?? 'the canvas engine could not read it'}.`;

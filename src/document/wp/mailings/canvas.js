// Mail merge on a canvas draft (engine-gaps-mailings): the app's side of the Mailings rows in src/document/canvas/rows/review.mjs,
// which read and write the engine's merge and open this module's dialogs. A document a merge makes comes back as the engine's
// stored form and opens as a new canvas draft (stage2.md G24).
import { confirmDialog, createDraft } from '../../../app/actions.js';
import { getState, subscribe } from '../../../app/store.js';
import { docOfDraft } from '../../docx/files.js';
import { run } from '../../../tooling/registry.js';
import { bindReviewApp } from '../../canvas/rows/review.mjs';

/** Resolves once the page area has a session other than `before` (the new draft's), or false after `ms`. */
const nextSession = (before, ms = 30000) => new Promise((done) => {
  const ok = () => getState().focusedSession && getState().focusedSession !== before;
  if (ok()) return done(true);
  const off = subscribe(() => ok() && finish(true));
  const timer = setTimeout(() => finish(false), ms);
  function finish(v) {
    off();
    clearTimeout(timer);
    done(v);
  }
});

bindReviewApp({
  // Print Documents prints the new draft once its page area has opened it (Print acts on the focused session): `from` is the
  // session the merge ran on, which the focus may come back to before the new draft's page area opens.
  newDraft: async (title, model, { print = false, from = getState().focusedSession } = {}) => {
    const made = !!(await createDraft({ title, engine: model, format: 'document' }))?.draftId;
    if (made && print && (await nextSession(from))) run('file.print');
    return made;
  },
  confirm: (opts) => confirmDialog(opts),
  // The file picker through the test seam (plan.md §1.16), as the DOM editor's Use an Existing List.
  openFile: (opts) => (globalThis.__wordTest?.openFile ?? window.api.word.openFile)(opts),
  // A draft's title and doc, a canvas draft's read through the engine (engine-canvas-read), for its first table as a list.
  loadDraft: async (id) => {
    const draft = await window.api.drafts.load(id);
    return draft && { title: draft.title, doc: await docOfDraft(draft) };
  },
});

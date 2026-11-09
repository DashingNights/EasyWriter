// Compare, Combine and Restore on the app (docs/plans/word plan.md §3 compare): load the two drafts, prepare them (compare.mjs), open
// the target and write the revised doc as one agent-style round, so the Suggestions plugin records the differences with core.convert
// and the Review tab's Accept, Reject, Previous and Next resolve them.
// engine-canvas-read (docs/plans/engine/stage2b.md, G37): canvas drafts take part too. A comparison whose result goes into a canvas
// draft (shown in place in one, or a new result made while a canvas draft is open) runs in the engine: `review.compare` with the
// other side's bytes, its differences tracked changes by the label. The rest run as before, a canvas side read through the
// engine's .docx (files.js readDocx).
import { closeHistory } from '@tiptap/pm/history';
import { toast as sonner } from 'sonner';
import { createDraft, openDraft, toast } from '../../../app/actions.js';
import { getState, subscribe } from '../../../app/store.js';
import { engineHost } from '../../../engine/client.js';
import { isCanvas, modelBytes } from '../../../engine/model/form.mjs';
import { FORMATS } from '../../../formats.mjs';
import { strip } from '../../../suggest/core.mjs';
import { withCall } from '../../../suggest/extension.js';
import { base64 } from '../../../tooling/base64.mjs';
import { areaOpens } from '../../../tooling/surface.js';
import { docxOfDoc, readDocx } from '../../docx/files.js';
import { wordSettings } from '../../word/settings.mjs';
import { accountName, authorOf } from '../comments/comments.mjs';
import { engineArgs, prepare, refusal, resultTitle } from './compare.mjs';

/** The sources of each comparison result open this session: draft id → {original, revised (doc JSON), originalTitle, revisedTitle},
 * or for a result the engine made {read() → [original, revised] doc JSON, originalTitle, revisedTitle}. */
export const sources = new Map();

/** The label for changes when none is typed: settings.word.user.name, else the OS account, else 'Author' (authorOf). */
export const userName = () => authorOf(wordSettings(getState().settings ?? {}).user, accountName()).name;

/** Whether draft `id` is the open draft shown in the canvas page area with its session in the engine. */
const live = (id) => {
  const s = getState();
  return !!id && s.draft?.id === id && areaOpens(s) && engineHost().ids().includes(id);
};

/** One side of a comparison: draft record `draft` (the open draft's as it is now: loadDraft) titled `title` → {id, title, record,
 * canvas, bytes() → {bytes, kind} for the engine ('engine' or 'docx'; a copy the caller may move), doc() → its doc JSON}, each
 * read once, when first asked. The open canvas draft is read from its session, so unsaved edits count. */
export function sideOf(draft, title = draft?.title || 'Untitled') {
  const id = draft?.id ?? null;
  const inArea = live(id);
  const canvas = inArea || isCanvas(draft);
  let bytesOnce = null;
  let docOnce = null;
  const read = async () => {
    if (inArea && live(id)) {
      const c = engineHost().watch(id); // a watcher: the page area holds the session (engine-session-release)
      try {
        return { bytes: await c.save('engine'), kind: 'engine' };
      } finally {
        c.release();
      }
    }
    if (isCanvas(draft)) return { bytes: modelBytes(draft.engine), kind: 'engine' };
    return { bytes: (await docxOfDoc(draft.doc, title)).bytes, kind: 'docx' };
  };
  const bytes = async () => {
    const b = await (bytesOnce ??= read());
    return { bytes: b.bytes.slice(), kind: b.kind };
  };
  const doc = () => (docOnce ??= (async () => {
    if (!canvas) return draft.doc;
    const b = await bytes();
    return readDocx(b.kind === 'engine' ? await engineHost().convert(b.bytes, 'docx') : b.bytes, title);
  })());
  return { id, title, record: draft, canvas, bytes, doc };
}

/** Draft `id` for comparing → its side (sideOf) or null after a toast saying why not. */
export async function loadDraft(id) {
  const s = getState();
  const draft = id === s.draft?.id ? (isCanvas(s.draft) || live(id) ? s.draft : { ...s.draft, doc: s.editor.getJSON() })
    : await window.api.drafts.load(id).catch(() => null);
  const why = live(id) ? null : refusal(draft, FORMATS.document.version);
  if (why) {
    toast(why, true);
    return null;
  }
  return sideOf(draft);
}

/** Replaces `ed`'s content and every doc attribute with doc JSON `json` in one transaction and one undo step. → whether it changed. */
export function setDoc(ed, json) {
  const node = ed.schema.nodeFromJSON(json);
  const { state } = ed;
  if (state.doc.eq(node)) return false;
  const tr = state.tr.replaceWith(0, state.doc.content.size, node.content);
  for (const [k, v] of Object.entries(node.attrs)) if (JSON.stringify(v) !== JSON.stringify(state.doc.attrs[k])) tr.setDocAttribute(k, v);
  ed.view.dispatch(closeHistory(tr));
  return true;
}

/** Compares doc JSON `original` with `revised` under `opts` and shows the result: in a new draft ('Compare Result N' or 'Combine
 * Result N' by `kind`) or in place in the draft `originalId` or `revisedId` (`opts.where`), the differences as suggestions by
 * `label`. Remembers the sources for Show Source Documents. → the result draft id, or null. */
export async function compareDocs({ original, revised, label, opts, kind = 'compare', originalId = null, revisedId = null, titles = {} }) {
  const prep = prepare(original, revised, opts);
  const where = opts?.where ?? 'new';
  try {
    if (where === 'new') await createDraft({ title: resultTitle(kind), doc: prep.original, format: 'document' });
    else if (!(await openDraft(where === 'original' ? originalId : revisedId))) return null;
  } catch (e) {
    toast(`Could not make the comparison: ${e.message || e}`, true);
    return null;
  }
  const { editor: ed, draft } = getState();
  if (!ed || !draft?.id) return null;
  try {
    // The target first holds the prepared original as the user's own step (a new draft's list numbering, an in-place draft's text),
    // then the revised doc arrives as one round of `label`, which the converter records.
    setDoc(ed, prep.original);
    const at = Date.now();
    withCall(ed, { g: `compare-${at}`, by: label || userName(), at, ids: [] }, 'exact', () => setDoc(ed, prep.revised));
  } catch (e) {
    toast(`Could not make the comparison: ${e.message || e}`, true);
    return null;
  }
  sources.set(draft.id, { original: strip(original), revised: prep.revised, originalTitle: titles.original ?? 'Original', revisedTitle: titles.revised ?? 'Revised' });
  return draft.id;
}

/** Opens canvas draft `id` unless it is open, and once the engine holds it → `fn(session)` with a view of its session (released
 * after), or null when it did not open. */
async function inSession(id, fn) {
  if (!live(id)) {
    if (getState().draft?.id !== id && !(await openDraft(id))) return null;
    // The page area takes the focus once its open has finished.
    const opened = await new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        off();
        resolve(v);
      };
      const timer = setTimeout(() => done(false), 120000);
      const off = subscribe(() => getState().focusedSession?.id === id && live(id) && done(true));
    });
    if (!opened) return null;
  }
  const c = engineHost().watch(id); // a watcher: the page area holds the session (engine-session-release)
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

/** Compares side `a` (the original) with side `b` (the revised) in the engine, the result in a new canvas draft or in place in
 * a canvas draft (`opts.where`), the differences tracked changes by `label`. → the result draft id, or null. */
export async function compareInEngine({ a, b, label, opts, kind = 'compare' }) {
  const id = kind === 'combine' ? 'review.combine' : 'review.compare';
  const args = engineArgs(label || userName(), opts);
  const where = opts?.where ?? 'new';
  const wait = sonner.loading('Comparing the documents...');
  try {
    let draftId;
    if (where === 'new') {
      const [o, r] = [await a.bytes(), await b.bytes()];
      const host = engineHost();
      const model = o.kind === 'engine' ? o.bytes : await host.helper().call('engineForm', [o.bytes, o.kind], [o.bytes.buffer]);
      const result = await host.convert(model, 'engine', [[id, { ...args, revisedData: base64(r.bytes), revisedKind: r.kind }]]);
      ({ draftId } = await createDraft({ title: resultTitle(kind), engine: result, format: 'document' }));
    } else {
      const target = where === 'original' ? a : b;
      // Both sides' bytes as they are before the comparison changes the target: the sources pane reads them later.
      const [o, r] = [await a.bytes(), await b.bytes()];
      const more = where === 'original' ? {} : { originalData: base64(o.bytes), originalKind: o.kind };
      const res = await inSession(target.id, (c) => c.exec(id, { ...args, ...more, revisedData: base64(r.bytes), revisedKind: r.kind }));
      if (!res) throw new Error(`${target.title} did not open`);
      if (!res.ok) throw new Error(res.error ?? 'the engine refused it');
      draftId = target.id;
    }
    sources.set(draftId, { read: () => Promise.all([a.doc(), b.doc()]), originalTitle: a.title, revisedTitle: b.title });
    return draftId;
  } catch (e) {
    toast(`Could not make the comparison: ${e.message || e}`, true);
    return null;
  } finally {
    sonner.dismiss(wait);
  }
}

/** Compares side `a` with side `b`: in the engine when the result goes into a canvas draft (in place in one, or a new result made
 * while a canvas draft is open), else in the DOM editor. → the result draft id, or null. */
export async function compareSides({ a, b, label, opts, kind = 'compare' }) {
  const where = opts?.where ?? 'new';
  const target = where === 'original' ? a : where === 'revised' ? b : null;
  const canvas = target ? live(target.id) || isCanvas(target.record) : areaOpens(getState());
  if (canvas) return compareInEngine({ a, b, label, opts, kind });
  const reading = a.canvas || b.canvas;
  const wait = reading ? sonner.loading('Reading the documents...') : null;
  let docs;
  try {
    docs = await Promise.all([a.doc(), b.doc()]);
  } catch (e) {
    toast(`Could not read the documents: ${e.message || e}`, true);
    return null;
  } finally {
    if (wait != null) sonner.dismiss(wait);
  }
  return compareDocs({ original: docs[0], revised: docs[1], label, opts, kind, originalId: a.id, revisedId: b.id,
    titles: { original: a.title, revised: b.title } });
}

/** Runs the Compare or Combine dialog's result `r` ({original, revised (draft ids), label, opts}). */
export async function compareDrafts(r, kind) {
  const a = await loadDraft(r.original);
  const b = a && (await loadDraft(r.revised));
  if (!b) return null;
  return compareSides({ a, b, label: r.label, opts: r.opts, kind });
}

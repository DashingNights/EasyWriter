// The canvas page area's engine session: opens the current draft in the window's engine (one worker for every draft, src/engine/
// client.js), keeps its page list current from layout events (docs/plans/engine/plan.md section 3) and saves the draft from it
// (docs/plans/engine/model.md): a DOM draft moves to the canvas form at its first save (one that cannot move stays on the DOM
// editor, convert.mjs), a canvas draft opens from that form, and each edit marks the draft dirty, so the app's autosave (actions.js doSave) saves it from the engine. The pages are painted as
// tiles by the page area's Viewport (src/engine/view/tiles.js).
import { useEffect, useState } from 'react';
import { attachCanvas, canvasOpen, confirmDialog, markDirty, replaceOpenDraft, saveNow, takeHistory, toast } from '../../app/actions.js';
import { getState, setState, subscribe, WORKER } from '../../app/store.js';
import { blankModel, modelOf, storyOf } from '../../board/model.mjs';
import { textStory } from '../../board/look.mjs';
import { convertBoxes, convertOn } from '../../board/convert.mjs';
import { readForm } from '../../board/store.mjs';
import { presetFields } from '../../board/tools/place.js';
import { extOf, mediaKey } from '../../board/tools/pictures.js';
import { engineHost, warmEngine } from '../../engine/client.js';
import { editWatch, saveOnce } from '../../engine/model/autosave.mjs';
import { isCanvas, openDraft, toDom } from '../../engine/model/form.mjs';
import { areaOpens } from '../../tooling/surface.js';
import { docxOfOpenDraft } from '../docx/files.js';
import { readWordFile } from '../docx/reader.js';
import { saveWord, wordSettings } from '../word/settings.mjs';
import { keepDom, list, openChecked, refused, restoreDom, stayLine } from './convert.mjs';
import { checkPost, isPost, postSource } from './post.js';

export { areaOpens };

/** Test hook (harness case engine-viewport): `source()` → {bytes, kind} opens that file instead of the open draft. The file is
 * shown only: nothing saves it over the draft. */
export const hooks = { source: null };

/** Whether the Canvas engine switch is on. */
const engineOn = (s) => !!wordSettings(s.settings).canvasEngine;

// engine-gate-prep: the window's first open of a Document in the canvas page area waited for the engine worker and the helper
// to start (575 to 623 ms against 500). Once the app has painted its first frame with the switch on, both start in the
// background (client.js warmEngine): off this thread, so nothing shows. engine-warm-scope: only with the switch on, because the
// DOM editor is the Documents default and a window that never uses the engine must not pay for it; and never beside a real
// open (areaOpens), which needs the workers alone. Not in the background window of computer use.
if (typeof window !== 'undefined' && !WORKER) {
  const off = subscribe(() => {
    if (!engineOn(getState())) return;
    off();
    requestAnimationFrame(() => setTimeout(() => {
      window.__engineWarm = warmEngine({ busy: () => areaOpens(getState()) }); // the harness reads the start cost here
    }));
  });
}

/** The page area's client for draft `id`: its session in the window's engine host, to release (the session closes once no
 * view holds it) with the page area. */
export const connect = (id = getState().draft?.id ?? 'draft') => engineHost().session(id);

/** Whether page lists `a` and `b` ([{w, h, section}]) hold the same pages: the page area places its pages again only when one
 * changed (engine-main-thread-2: every key placed all 959 pages of the Word fixture again). */
const samePages = (a, b) => a?.length === b.length && b.every((p, i) => p.w === a[i].w && p.h === a[i].h && p.section === a[i].section);

/** `pages()`'s answer as {pages, version, settled}: section 3 gives the list and a layout version; `settled` is false while the
 * engine still lays out pages after the list (engine-open). */
const normal = (r) => (Array.isArray(r) ? { pages: r, version: 0, settled: true }
  : { pages: r?.pages ?? [], version: r?.version ?? 0, settled: r?.settled !== false });

/** The open draft as .docx for the engine's open (files.js docxOfOpenDraft). */
async function docx() {
  const out = await docxOfOpenDraft();
  if (!out) throw new Error('No Document is open.');
  return out;
}

/** The three engine-backed steps a canvas conversion takes (bd-convert), on an item session of its own: the board form's text,
 * pictures and DrawingML presets are made the way bd-text and bd-paint make theirs. `done()` releases it. */
async function conversionDeps(draft) {
  const item = engineHost().session('convert:' + draft.id);
  try {
    await item.call('boardInit');
    const base = blankModel(await item.save('engine')); // also modelOf's base, as a board's item session is (model.mjs)
    return {
      done: () => item.release(),
      story: async (html, width, steps = []) => {
        await item.open(modelOf({ type: 'text', story: textStory(''), w: width }, base, {}, { allStyles: true }), 'engine');
        await item.call('paste', ['html', html]);
        // A Word label's html carries a span for each run whose size or colour differs from the item's own (shapes-in.mjs
        // labelOf): the steps below style all the text, so those runs get their own values back.
        const own = runStyles(storyOf(await item.save('engine')));
        if (steps.length) await item.execMany([['select.all', {}], ...steps]);
        return restoreRuns(storyOf(await item.save('engine')), own);
      },
      mediaOf: (src) => mediaKeyOf(src),
      preset: (prst, av, w, h) => presetFields({ item }, prst, av, w, h),
    };
  } catch (e) {
    item.release();
    throw e;
  }
}

/** Each paragraph's runs' own size and colour, by paragraph and run. */
const runStyles = (story) => (story.blocks ?? []).map((b) => (b.runs ?? []).map((r) => ({ size: r.props?.size, color: r.props?.color })));

/** `story` with every run that had its own size or colour given it back (a restyle over all text flattens them). */
function restoreRuns(story, own) {
  (story.blocks ?? []).forEach((b, i) => {
    const runs = b.runs ?? [];
    const was = own[i] ?? [];
    if (runs.length !== was.length) return;
    runs.forEach((r, j) => {
      const { size, color } = was[j];
      if (size === undefined && color === undefined) return;
      r.props = { ...(r.props ?? {}), ...(size !== undefined && { size }), ...(color !== undefined && { color }) };
    });
  });
  return story;
}

/** An old canvas picture's src → its media key (bd-pictures' `mediaKey` of its bytes); a stored reference keeps its key. */
async function mediaKeyOf(src) {
  const ref = /^data:[^;,]*;sha256,([a-f0-9]{64}\.[a-z0-9.+-]+)$/i.exec(String(src));
  if (ref) return ref[1];
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(src));
  if (!m) throw new Error('A canvas picture is not a data URL.');
  const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return mediaKey(bytes, extOf(m[1]));
}

/** A box's data string as its JSON, or null. */
function dataOf(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** React hook: the open draft in the engine → null while it opens, {error} when it cannot, else {client, pages, version, settled,
 * times, latest} (`settled` false while pages after `pages` are still being laid out; `latest.version` the last layout's version,
 * which `version` is only as of the last render). Opens once per mount: a canvas draft from its
 * engine form with the undo history saved beside it (engine-undo-file), a DOM draft as .docx (export.mjs), which its first save
 * here makes a canvas draft (one that cannot move stays on the DOM editor and says why). A draft whose session another view still holds (the page area closing as this one opens) is taken
 * as it is, unsaved edits and undo steps included. Opening saves nothing: only an edit marks the draft dirty. Each save writes the
 * record, then the undo history. After the engine stopped and the host opened the draft again in a new worker from its last
 * save (and its history), the hook hands out a new client, so the page area attaches new canvases, and says so. `times`:
 * performance.now() at the hook's start, the open's end and the first page list, for the Reopen time (viewport-design.md
 * section 12). */
export function useEngine() {
  const [eng, setEng] = useState(null);
  useEffect(() => {
    let dead = false;
    let client = null;
    let offs = [];
    let detach = () => {};
    let edited = null;
    let converting = false; // while the old canvases become the board form: no edit, so no save is owed
    const draft = getState().draft;
    const settings = getState().settings;
    // A forum post (or core page) opens from its post JSON, and its record is saved in that form; its first open is checked
    // against the DOM editor's post (post.js), so one the engine would change stays there.
    const post = isPost(draft, settings);
    const times = { start: performance.now() };
    const latest = { version: 0 }; // the last layout's version, for the harness (state()): no render follows it
    const saving = !hooks.source; // a file shown in place of the draft is never saved over it
    let kept = saving ? keepDom(draft) : null; // the DOM form, until the first save has stored the canvas record
    /** The engine could not open the draft or stopped for good: saves write the record as last saved from now on. A draft that has
     * not stored its canvas record goes back to the DOM form, on the DOM editor that holds it. */
    const failed = (error) => {
      detach();
      if (kept) {
        console.warn('The draft stays in the DOM editor.', error);
        restoreDom(draft, kept);
        setState({ engineRefused: draft });
        toast(stayLine(draft.title, error), true);
      } else setEng({ error });
      canvasOpen(draft, 'failed'); // the page area says why
    };
    const bind = (c, steps = null) => {
      for (const off of offs) off();
      client = c;
      edited = editWatch();
      if (steps) edited({ steps }); // steps the session has already are no edit
      offs = [
        c.on('crash', ({ message, restarting }) => {
          if (!dead && !restarting) failed(new Error(message));
        }),
        c.on('layout', async (e) => {
          // The box fills of a conversion change the document but are no edit: they leave the draft clean until the user's next one.
          const isEdit = edited(e);
          if (saving && isEdit && !converting && getState().draft === draft) markDirty();
          const next = Array.isArray(e?.pages) ? { pages: e.pages, version: e.version, settled: e.settled !== false } : normal(await c.pages());
          if (dead) return;
          latest.version = next.version;
          // A layout that changed no page's size and did not settle (a typed letter) shows nothing new: no render
          // (engine-main-thread-2). The page area hears the event itself for the pages it laid out again.
          setEng((s) => {
            if (s?.client !== c) return s;
            const pages = samePages(s.pages, next.pages) ? s.pages : next.pages;
            return pages === s.pages && next.settled === s.settled ? s : { ...s, ...next, pages };
          });
          if (next.settled) canvasOpen(draft, 'settled');
        }),
        c.on('reopened', async ({ history, steps } = {}) => {
          if (dead || client !== c) return;
          const next = engineHost().session(c.id);
          bind(next, steps);
          c.release();
          const first = normal(await next.pages());
          if (dead) return;
          latest.version = first.version;
          const title = getState().draft?.title || 'this draft';
          toast(`The canvas engine stopped, so ${title} was opened again from its last save.${history ? '' : ' Its undo history is gone.'}`);
          setEng({ client: next, ...first, times, latest });
        }),
      ];
    };
    (async () => {
      if (!saving) {
        const out = await hooks.source();
        if (dead) return;
        bind(connect());
        client.ahead().catch(() => {}); // not awaited: see the draft's open below
        await client.open(out.bytes, out.kind ?? 'docx');
        times.open = performance.now();
      } else {
        if (!draft?.id) throw new Error('No Document is open.');
        const live = engineHost().ids().includes(draft.id);
        const c = connect(draft.id);
        client = c; // the cleanup releases it, also while the call below runs
        // A session another view holds has its undo steps already: they are no edit to save.
        const steps = live ? await c.steps() : null;
        if (dead) return;
        bind(c, steps);
        // engine-open: the open lays out the first pages and the rest in slices, so page 1 shows without waiting for the rest.
        // engine-warm-scope: ahead is not awaited, so the helper reads the file meanwhile. The worker takes calls in order, so
        // ahead still comes before the open; without it the open lays out whole, so its failure is the open's to report.
        if (!live) {
          client.ahead().catch(() => {});
          await openChecked(client, draft, post ? { source: (d) => postSource(d, settings, getState().editor?.view?.dom) } : { docx });
          // A DOM post is checked against what the engine gives back; a canvas post has no DOM doc to compare with.
          if (post && !isCanvas(draft)) await checkPost(client, draft, settings, getState().editor?.view?.dom);
          await openHistory(client, draft, takeHistory(draft), (steps) => edited({ steps }));
        }
        times.open = performance.now();
        if (dead) return;
        // Saves read `client` when they run, so after a crash they save the reopened session.
        const store = (part, i, n) => window.api.drafts.savePart(draft.id, i, n, part);
        const history = (part, i, n) => window.api.drafts.saveHistoryPart(draft.id, i, n, part);
        detach = attachCanvas(draft, async () => {
          const saved = await saveOnce(client, draft, store, {}, { store: history, limit: getState().settings.historyLimit ?? 50 });
          kept = null;
          return saved;
        });
      }
      // bd-convert: an old canvas box becomes the board form once the engine hosts Documents and posts, before the page area
      // shows, so nothing can be typed meanwhile, and before the first save writes the record. A box that cannot convert stays
      // byte for byte as it was, said in one line. The item session is made on the first box that can convert, not on every open.
      if (saving && convertOn()) {
        converting = true;
        try {
          await convertBoxes(client, () => conversionDeps(draft), (line) => toast(line));
          // An edit is laid out in a turn after its reply (worker.js), so a later call's reply follows those layout events: they
          // are handled while `converting` is still true, and leave no save owed.
          await client.pages().catch(() => {});
        } catch (e) {
          console.warn('The canvases were not converted.', e);
        } finally {
          converting = false;
        }
        if (dead) return;
      }
      const first = normal(await client.pages());
      times.pages = performance.now();
      if (dead) return;
      latest.version = first.version;
      setEng({ client, ...first, times, latest });
      if (first.settled) canvasOpen(draft, 'settled');
      if (saving && !isCanvas(draft)) {
        markDirty();
        // The first save: the draft's record is the canvas form from here on (a sync hold can put it off).
        // ponytail: an edit typed in the engine during a first save that fails is lost; the DOM form is what comes back.
        if (!(await saveNow()) && !dead) throw refused('its canvas form could not be saved');
      }
    })().catch((error) => {
      if (!dead) failed(error);
    });
    return () => {
      dead = true;
      canvasOpen(draft, 'closed');
      for (const off of offs) off();
      // Edits not saved yet are saved first, while the saver still holds the session (a draft switch has saved already).
      const c = client;
      (getState().draft === draft && getState().dirty ? saveNow() : Promise.resolve()).finally(() => {
        detach();
        c?.release();
      });
    };
  }, []);
  return eng;
}

/** Takes `history` (the draft's history file as loaded, actions.js takeHistory) into the session `client` just opened canvas
 * draft `draft` in. One saved with another record (its stamp), schema or block ids is dropped without a word (SPEC.md section 7e):
 * the draft opens with no undo history then. `seed(steps)` gets the session's top steps in the same task as the answer, before
 * the layout event that carries them, so they are not taken for an edit. Kept, the history is what a crash's reopen takes back. */
async function openHistory(client, draft, history, seed) {
  if (!history || !isCanvas(draft)) return;
  const r = await client.openHistory(history, draft.engine.stamp ?? '').catch(() => null);
  if (!r?.kept) return;
  seed(r.steps);
  client.savedHistory(draft.engine.stamp, history);
}

/** View > Canvas engine (docs/plans/engine/model.md, Switching between the editors). On, Documents open in the canvas page area,
 * which moves a DOM draft to the canvas form at its first save. Off, Documents open in the DOM editor again and the open canvas
 * draft goes back to it (backToDom). A canvas draft opened while the switch is off still opens in the canvas page area, where the
 * switch turns it back. */
export async function setCanvasEngine(on) {
  // The switch is Documents': a forum post is hosted by post.js (POSTS_ON_ENGINE), and its record is no engine Document to move.
  if (isPost(getState().draft, getState().settings)) return;
  if (!on && !(await listMayGo(getState().draft))) return;
  await saveWord({ canvasEngine: on });
  setState({ engineRefused: null }); // on again: the engine tries the open draft once more
  if (on) return;
  await saveNow(); // a first save still running makes the draft a canvas draft: it is taken back too
  const { draft } = getState();
  if (isCanvas(draft)) await backToDom(draft);
}

/** Whether the switch may go off for the open draft `draft`: a draft holding a canvas made on the Canvas engine stays there (the
 * DOM editor cannot draw its board form, and no down-conversion is written); and the DOM editor cannot hold a canvas draft's
 * recipient list (Word links it as a file of its own, which a draft does not have), so the move back would drop the list the user
 * typed, with its ticks, filter, sort and matched fields. The user is asked first. */
async function listMayGo(draft) {
  const host = engineHost();
  if (!isCanvas(draft) || !host.ids().includes(draft.id)) return true;
  const c = host.session(draft.id);
  try {
    const boxes = (await c.query('box.list', {}).catch(() => null))?.value?.boxes;
    // A draft whose canvases cannot be read stays rather than moving back without them: the switch never fails open.
    if (!Array.isArray(boxes)) {
      toast('This draft stays on the Canvas engine because its canvases could not be read.');
      return false;
    }
    if (boxes.some((b) => b.kind === 'canvas' && readForm(dataOf(b.data)) !== 'old')) {
      toast('This draft has canvases made on the Canvas engine, so it stays there.');
      return false;
    }
    const r = await c.query('mailings.state', {}).catch(() => null);
    if (!r?.value?.hasList) return true;
    return confirmDialog({
      title: 'Turn off the canvas engine?',
      description: 'The DOM editor cannot keep a mail merge recipient list. This document moves back without its list, ticks, filter, sort and matched fields.',
      confirmText: 'Turn off',
      destructive: true,
      human: true,
    });
  } finally {
    c.release();
  }
}

/** Moves the open canvas draft `draft` to the DOM editor: the engine writes .docx, the Word reader (import.mjs, in its worker)
 * reads it, and the draft is saved in the DOM form with a new undo history (actions.js replaceOpenDraft). Edits that land while
 * it converts start it again, so none is left behind in the engine. On failure the draft stays a canvas draft. */
async function backToDom(draft) {
  // A post's record is the post kit's JSON: the DOM post editor reads it as it is, so there is nothing to convert (and the
  // engine's .docx is no post).
  if (isPost(draft, getState().settings)) return;
  const host = engineHost();
  const live = host.ids().includes(draft.id);
  const c = host.session(draft.id);
  const settings = getState().settings;
  const read = (bytes) => readWordFile(`${draft.title || 'Document'}.docx`, bytes, { settings });
  try {
    if (!live) await openDraft(c, draft);
    await c.whenSettled(); // the page area's open lays out in slices, each a new version the check below would take for an edit
    let out = null;
    for (let tries = 0; !out && tries < 3; tries++) {
      const before = (await c.pages()).version;
      const next = await toDom(c, draft, { read });
      if ((await c.pages()).version === before) out = next;
    }
    if (!out) throw new Error('it kept changing while it was converted');
    if (getState().draft !== draft) return; // another draft opened meanwhile: this one stays a canvas draft
    await replaceOpenDraft(out.draft); // a failed save says so itself and leaves the draft unsaved, in the DOM form
    if (out.dropped.length) toast(`${draft.title || 'The draft'} is back in the DOM editor without ${list(out.dropped)}, which it cannot hold.`);
  } catch (e) {
    toast(`Could not move the draft out of the canvas engine: ${e.message || e}`, true);
  } finally {
    c.release();
  }
}

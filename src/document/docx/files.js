// Word files in and out of the app: Save As and Export write the open Document as .docx; Open and a Word file dropped anywhere on
// the window make a new Document draft from it (docs/plans/document.md # interop: entry points), read in a Web Worker behind the
// opening card (docs/plans/word/briefs/open-worker.md). One notice lists what the file could not carry. With the Canvas engine
// switch on, the engine's helper worker reads the file and the draft is a canvas draft from the start (docs/plans/engine/stage2b.md
// decision 2).
import { EditorState } from '@tiptap/pm/state';
import { toast as sonner } from 'sonner';
import { getState } from '../../app/store.js';
import { createDraft, leave, openDraft, openingDone, toast, watchOpen } from '../../app/actions.js';
import { boardOpens } from '../../tooling/surface.js';
import { activeBoard } from '../../whiteboard.js';
import { engineHost } from '../../engine/client.js';
import { isCanvas, kindOf } from '../../engine/model/form.mjs';
import { domDocOf } from '../../engine/model/read.mjs';
import { wordSettings } from '../word/settings.mjs';
import { endOpening, failOpening, painted, startOpening, stepOpening } from '../../app/components/OpenProgress.jsx';
import { showPage } from '../../app/views.js';
import { boardPicture } from '../../export.js';
import { exportDocx, fetchMedia } from './export.mjs';
import { importDocx } from './import.mjs';
import { base64, bytesOf } from '../../tooling/base64.mjs';
import { importDoc } from './doc.mjs';
import { readWordFile, via } from './reader.js';
import { adoptLists } from '../numbering.mjs';
import { accept, entries } from '../../suggest/core.mjs';
import { paginationKey } from '../geometry.js';
import { pageStartsOf } from '../layout-cache.mjs';

const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);

/** A canvas or plan chart drawn as a PNG for the file → {bytes, ext, w, h} or null. */
async function picture(node) {
  try {
    const a = node.attrs ?? {};
    const width = Math.round(a.dw ?? a.w ?? 600);
    const { blob, height } = await boardPicture({ ...a, kind: node.type }, width, 'light', 1);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png', w: width, h: height };
  } catch {
    return null;
  }
}

/** The open Document as .docx bytes → {bytes, dropped} or null when no Document is open. Waiting suggestions go in as tracked
 * changes (core.accept on a copy), each by its own author: an agent's as the assistant, a compare's under the name it carries
 * (the switch to the canvas engine, docs/plans/engine/stage2b/assistant.md section 6). */
export async function docxOfOpenDraft() {
  const { draft, editor } = getState();
  if (!editor || draft?.format !== 'document') return null;
  const { state } = editor;
  const { doc, json } = withSuggestions(state);
  // Word's page hints at the app's own page starts, when the pages are those of the doc written (no suggestion taken in).
  const pages = doc === state.doc ? paginationKey.getState(state)?.geo?.pages : null;
  const pageStarts = pages ? pageStartsOf(doc, pages.filter((p) => !p.blank).slice(1).map((p) => p.from)) : null;
  return exportDocx(json, { media: fetchMedia, picture, title: draft.title ?? '', pageStarts });
}

/** Editor state `state`'s doc with its waiting suggestions taken in as tracked changes → {doc, json}. core.accept writes them as the
 * assistant's: a person's (a compare's, `by` their name) are taken in on their own and their new revisions get that name back. */
function withSuggestions(state) {
  const groups = new Map(); // by → the ids of its suggestions
  for (const e of entries(state.doc)) groups.set(e.by, [...(groups.get(e.by) ?? []), e.id]);
  let doc = state.doc;
  const names = new Map(); // revision id → its author, for a person's
  for (const [by, ids] of groups) {
    const before = revisionIds(doc.toJSON());
    const tr = accept(EditorState.create({ doc }), ids, true);
    if (!tr) continue;
    doc = tr.doc;
    if (typeof by === 'string' && by && !by.startsWith('agent:')) for (const id of revisionIds(doc.toJSON())) if (!before.has(id)) names.set(id, by);
  }
  const json = doc.toJSON();
  if (names.size) renameRevisions(json, names);
  return { doc, json };
}

/** The ids of the revision records ({id, author, ...}: marks and block attributes) in TipTap JSON `v`. */
function revisionIds(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) revisionIds(x, out);
  else if (v && typeof v === 'object') {
    if (typeof v.author === 'string' && v.id != null) out.add(v.id);
    for (const x of Object.values(v)) revisionIds(x, out);
  }
  return out;
}

/** Gives each revision record in TipTap JSON `v` whose id `names` holds that author (in place). */
function renameRevisions(v, names) {
  if (Array.isArray(v)) for (const x of v) renameRevisions(x, names);
  else if (v && typeof v === 'object') {
    if (typeof v.author === 'string' && names.has(v.id)) v.author = names.get(v.id);
    for (const x of Object.values(v)) renameRevisions(x, names);
  }
}

/** Doc JSON `doc` of a draft that is not open as .docx bytes → {bytes, dropped}, written as the open draft's are. */
export const docxOfDoc = (doc, title = '') => exportDocx(doc, { media: fetchMedia, picture, title });

/** .docx `bytes` (the engine's, say) read by the Word reader in its worker → the doc JSON (TipTap). */
export const readDocx = async (bytes, title = 'Document') => (await readWordFile(`${title}.docx`, bytes, { settings: getState().settings })).doc;

/** Draft record `draft`'s doc JSON, for code that reads a draft that is not open (Compare, Version History, mail merge's data
 * source, AutoMark, template styles, RD fields): its own `doc`, or for a canvas record the engine's .docx read by the Word reader
 * (src/engine/model/read.mjs domDocOf), which runs in the engine's helper worker behind any PDF it is making, so a toast says it
 * is reading. → the doc, or null after a toast saying why it could not be read. */
export async function docOfDraft(draft) {
  if (!isCanvas(draft)) return draft?.doc ?? null;
  const name = draft.title || 'Untitled';
  const wait = sonner.loading(`Reading ${name}...`);
  try {
    return await domDocOf(draft, { host: engineHost(), read: (bytes) => readDocx(bytes, name).then((doc) => ({ doc })) });
  } catch (e) {
    toast(`Could not read ${name}: ${e.message || e}`, true);
    return null;
  } finally {
    sonner.dismiss(wait);
  }
}

/** Saves the open Document as a .docx file named `name` (without extension) through the system Save dialog → the path or null.
 * A canvas draft's file is the engine's (`session`, its page area's client). */
export async function saveDocx(name, session = null) {
  const out = session ? { bytes: await session.save('docx'), dropped: [] } : await docxOfOpenDraft();
  if (!out) return toast('Open a Document to save it as a Word file.', true);
  const path = await window.api.word.saveFile({ name: `${(name || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Document'}.docx`, data: base64(out.bytes),
    filters: [{ name: 'Word Document', extensions: ['docx'] }], as: 'base64' });
  if (path && out.dropped.length) toast(`Saved. Word files cannot hold ${list(out.dropped)}, so they were left out.`);
  else if (path) toast('Saved as a Word document.');
  return path;
}

/** Word file `name` (`bytes`) in the engine's form, read in the engine's helper worker → its bytes (the engine's save('engine')
 * form), or null for a template the engine cannot read, which opens in the DOM editor as before. Throws why it cannot open, or
 * `signal`'s reason once it aborts: the read cannot stop part way, so its result is dropped (closing the helper would also end a
 * PDF export it is making). The engine reports nothing it leaves out, so this path has no notice of dropped content. */
async function engineRead(name, bytes, signal) {
  const stop = new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  try {
    return await Promise.race([engineHost().helper().call('engineForm', [bytes, kindOf(name)]), stop]);
  } catch (e) {
    if (signal.aborted) throw e;
    if (/\.dotx$/i.test(name)) return null;
    // The engine's reader says so in its own words (crates/docx PASSWORD_REQUIRED); the DOM path's .doc reader in these.
    throw new Error(/protected with a password/i.test(e?.message ?? '') ? 'This Word file is password protected.' : e?.message || String(e));
  }
}

/** Opens Word file `name` (`source`: its bytes, or the dropped File) as a new Document draft and shows it, behind the opening card
 * from the first moment to the last page laid out (with the Canvas engine switch on, to the first pages the page area paints).
 * Cancel while it reads makes no draft; one while its pages lay out closes the draft and keeps it. A file that cannot open says
 * why on the card and makes no draft. → the draft id, or null. */
export async function openWordFile(name, source) {
  const ctl = new AbortController();
  const back = getState().draft?.id;
  const card = startOpening(name, { stage: 'Reading the file', cancel: () => ctl.abort() });
  let read = null;
  let engine = null;
  try {
    const bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
    if (ctl.signal.aborted) throw ctl.signal.reason;
    stepOpening(card, { stage: 'Reading the document' });
    if (wordSettings(getState().settings).canvasEngine) engine = await engineRead(name, bytes, ctl.signal);
    if (!engine) read = await readWordFile(name, bytes, { settings: getState().settings, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) endOpening(card);
    else failOpening(name, e.message);
    return null;
  }
  // Cancelled while the reader ran on the page (no worker could start), which cannot stop part way.
  if (ctl.signal.aborted) {
    endOpening(card);
    return null;
  }
  stepOpening(card, { stage: 'Drawing the pages', cancel: null });
  await painted();
  // Named after the file, as Word's title bar names it.
  const title = name.replace(/\.(docx?|dotx)$/i, '') || read?.title;
  let draftId;
  try {
    ({ draftId } = await createDraft({ title, doc: read?.doc ?? null, engine, format: 'document', opening: card }));
  } catch (e) {
    console.error(e);
    // A draft that could not mount left the editor area empty: Close opens the one before.
    failOpening(name, e.message, () => getState().editor || leave(null, back));
    return null;
  }
  // createDraft showed it (no second mount through openDraft) and made it the draft the app reopens. A canvas draft's card ends
  // when its page area paints the first pages (actions.js canvasOpen); a step after that changes nothing.
  stepOpening(card, { stage: 'Laying out pages', cancel: () => leave(draftId, back) });
  if (!engine) watchOpen(getState().editor, getState().draft, card);
  await showPage('editor');
  if (read?.dropped.length) toast(`Opened ${name}. EasyWriter left out ${list(read.dropped)}.`);
  return draftId;
}

/** File > Open > Browse (Ctrl+F12): the system Open dialog for a Word file. */
export async function browseWordFile() {
  const f = await window.api.word.openFile({ filters: [{ name: 'Word Documents', extensions: ['docx', 'doc'] }], as: 'base64' });
  return f ? openWordFile(f.name, bytesOf(f.data)) : null;
}

/** Insert > Object > Text from File: a Word, text or Markdown file's body at the cursor of `ed` (the open Document's editor), its
 * lists on numbering of their own; its styles stay the open Document's, as Word's Insert File keeps the destination's. → true
 * when inserted. */
export async function insertTextFromFile(ed) {
  const f = await window.api.word.openFile({ filters: [{ name: 'Word documents and text', extensions: ['docx', 'doc', 'txt', 'md'] }], as: 'base64' });
  if (!f || !ed) return false;
  const bytes = bytesOf(f.data);
  let content;
  let dropped = [];
  if (/\.(txt|md)$/i.test(f.name)) {
    const lines = new TextDecoder().decode(bytes).replace(/\r\n?/g, '\n').split('\n');
    content = lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] }));
  } else {
    try {
      const read = await readWordFile(f.name, bytes, { settings: getState().settings, fresh: true });
      const lists = adoptLists(ed.state.doc.attrs.numbering, read.doc.attrs.numbering, read.doc.content ?? []);
      ed.commands.command(({ tr }) => (tr.setDocAttribute('numbering', lists.numbering), true));
      content = lists.content;
      dropped = read.dropped;
    } catch (e) {
      toast(`${f.name} could not be read: ${e.message}`, true);
      return false;
    }
  }
  if (!ed.chain().focus().insertContent(content).run()) return false;
  if (dropped.length) toast(`Inserted ${f.name}. EasyWriter left out ${list(dropped)}.`);
  return true;
}

// The harness reaches the reader and writer here (.smoke-data/word/cases/docx.js).
// via(): where the last file was read, 'worker' or 'page' (.smoke-data/word/cases/open-worker.js).
if (typeof window !== 'undefined') window.__docx = { exportDocx, importDocx, importDoc, docxOfOpenDraft, openWordFile, readWordFile, via: () => via, state: getState };

const WORD_FILE = /\.(docx?|dotx)$/i;
const wordFiles = (dt) => [...(dt?.files ?? [])].filter((f) => WORD_FILE.test(f.name));
const carriesFiles = (dt) => [...(dt?.types ?? [])].includes('Files');

/** The world point under a drop on the open board, or null (no board area yet). */
const dropPoint = (e) => {
  const board = activeBoard.get();
  return board?.vp ? board.vp.fromClient(e.clientX, e.clientY).world : null;
};

/** The board `id`'s plane once its area is up (BoardArea sets it: activeBoard tells its listeners), or null when it does not
 * come back within `ms`. Not a poll: a listener and one timer that reports the failure. */
function boardReady(id, ms = 8000) {
  return new Promise((resolve) => {
    const finish = (api) => {
      clearTimeout(timer);
      off();
      resolve(api);
    };
    const check = () => {
      const api = activeBoard.get();
      if (api?.draft?.id === id && api.vp) finish(api);
      return false;
    };
    const off = activeBoard.subscribe(check);
    const timer = setTimeout(() => finish(null), ms);
    check();
  });
}

/** `draftId` (a Word file's new draft) onto the board `board` ({id, at}): the file made the draft the open one, so the board
 * comes back, and the draft is placed at the drop point once the board's area is up again. A failure says what happened in
 * one line. → whether it was placed. */
async function placeOnBoard(draftId, board) {
  if (!(await openDraft(board.id).catch(() => false))) {
    toast('The file opened, but the board did not come back, so its draft was not placed.', true);
    return false;
  }
  const api = await boardReady(board.id);
  if (!api) {
    toast('The file opened, but the board did not come back, so its draft was not placed.', true);
    return false;
  }
  const entry = (getState().drafts ?? []).find((d) => d.id === draftId);
  if (!entry) {
    toast('The file opened, but its new draft was not found, so it was not placed.', true);
    return false;
  }
  const { placeDraft } = await import('../../board/instance.js');
  const placed = await placeDraft(api, entry, board.at);
  if (!placed) toast('The file opened, but its draft was not placed on the board.', true);
  return placed;
}

/** Word files dropped anywhere on the window open as new Documents. Capture phase, so the editor never inserts them as text. */
export function installWordDrop(win = window) {
  const over = (e) => {
    if (!carriesFiles(e.dataTransfer)) return;
    // The file names are hidden until the drop; any item that is not a picture may be a Word file.
    const items = [...(e.dataTransfer.items ?? [])];
    if (items.length && items.every((i) => i.kind === 'file' && i.type.startsWith('image/'))) return;
    if (items.some((i) => i.kind === 'file' && (/wordprocessingml|msword/.test(i.type) || !i.type))) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const drop = async (e) => {
    const files = wordFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    // With a board open the file's new draft goes on the board at the drop point, not in the page area (bd-instance).
    const board = boardOpens(getState()) ? { id: getState().draft.id, at: dropPoint(e) } : null;
    for (const f of files) {
      const id = await openWordFile(f.name, f);
      if (!board || !id) continue;
      openingDone(id); // no page area will report for it: the board shows it instead
      await placeOnBoard(id, board);
    }
  };
  win.addEventListener('dragover', over, true);
  win.addEventListener('drop', drop, true);
  return () => {
    win.removeEventListener('dragover', over, true);
    win.removeEventListener('drop', drop, true);
  };
}

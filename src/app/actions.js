import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Frame } from 'lucide-react';
import { createElement as h } from 'react';
import { toast as sonner } from 'sonner';
import { canvasEditor, openCanvasEditor } from '../canvas.js';
import { buildExtensions, applyPreset } from '../extensions.js';
import { buildPayload, draftTitle, wordCount } from '../export.js';
import { mergeThreads, normalizeThread, slugTitle, topicId } from '../thread-url.mjs';
import { activeBoard, finishBoardEdits } from '../whiteboard.js';
import { captureSelection } from './assistant/capture.js';
import { backgroundDraft, dropSession, flushSessions, handOver } from './assistant/sessions.js';
import { installAgent } from './commands.js';
import { notify, PasteNotice } from './components/Notices.jsx';
import { dropDraft, moveBeside, sortDrafts } from './draft-order.mjs';
import { pruneMap, tagDraft } from './drafts-meta.js';
import { initBrowser } from './browser.js';
import { keyAmong, keyIs, setKeybinds } from './keybinds.js';
import { flushFlows, initFlows, insertFlowchartDialog } from './flows.js';
import { can } from './gates.mjs';
import * as history from './history.js';
import { bindPanZoom, zoomAround } from './panzoom.js';
import { flushPlans, initPlans } from './plans.js';
import { clearRevLog, recordRev } from './rev.js';
import { cell, demoDoc, para, sampleImage, text } from './samples/demo.js';
import { flowSample } from './samples/flow.js';
import { planSample } from './samples/plan.js';
import { getState, setState, SMOKE, WORKER, WORKER_DRAFT } from './store.js';
import { closeWorkspace, restoreView, showPage } from './views.js';
import { backgroundClick, viewportRect } from './viewport.js';

export { notify }; // ui.notice (§8) reaches it through ctx.actions
export { normalizeThread }; // threads.add (§8) reaches it through ctx.actions

const api = window.api;
export const DEFAULT_WIDTH = 1454;
const SYSTEM_FONT = 'system-ui, Helvetica, Arial, sans-serif';

const state = getState();
const $ = (sel) => document.querySelector(sel);
const refresh = () => setState({}); // after an in-place change of state.draft

// ---------------------------------------------------------------------------------------------
// Toasts, overlay, dialogs

function toast(message, isError = false) {
  if (isError) sonner.error(message);
  else sonner(message);
}

function showOverlay(text) {
  setState({ overlay: text });
}

function hideOverlay() {
  setState({ overlay: null });
}

/** Opens a form dialog (DialogHost renders it by type). Resolves with its result, or null on Cancel/Escape. */
function openDialog(type, props = {}) {
  return new Promise((resolve) => setState({ dialog: { type, props, resolve } }));
}

/** AlertDialog confirmation. Resolves true on confirm, false on Cancel/Escape. `alert: true` shows only the OK button. */
export function confirmDialog({ title, description = '', confirmText = 'OK', destructive = false, alert = false }) {
  state.confirm?.resolve(false);
  return new Promise((resolve) => setState({ confirm: { title, description, confirmText, destructive, alert, resolve } }));
}

const alertDialog = (title, description) => confirmDialog({ title, description, alert: true });

// ---------------------------------------------------------------------------------------------
// Settings, theme, zoom

function applySettings() {
  const s = state.settings;
  setKeybinds(s.keybinds); // §7k
  const root = document.documentElement;
  root.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
  root.style.setProperty('--forum-width', `${s.forumWidth}px`);
  root.style.setProperty('--base-font', s.baseFont ? `${cssFamily(s.baseFont)}, ${SYSTEM_FONT}` : SYSTEM_FONT);
  root.style.setProperty('--base-scale', String((s.baseSize || 100) / 100));
  applyZoom();
}

export function cssFamily(name) {
  return /\s/.test(name) ? `"${name}"` : name;
}

export async function saveSettings(partial) {
  // The background window (§7i) never writes settings.json: its changes stay in its own memory.
  setState({ settings: WORKER ? { ...state.settings, ...partial } : await api.settings.set(partial) });
  return state.settings;
}

// anchor: area-relative point {x, y} that stays over the same spot of the page (default: the centre of the view).
function applyZoom(anchor) {
  const area = $('#editor-area');
  let zoom = state.zoom / 100;
  if (state.zoom === 'fit') zoom = Math.min(1, (area.clientWidth - VIEW_LEFT - VIEW_RIGHT) / (state.settings.forumWidth + 44));
  zoom = Math.max(0.1, zoom);
  zoomAround(area, $('#page-wrap'), zoom, anchor);
  setState({ zoomPct: Math.round(zoom * 100) });
}

/** 'fit' or a percent (clamped to 10…400; kept to 0.01 so wheel zoom can move in small steps; the UI shows whole
 * percents). `anchor` as for applyZoom. Fit also brings the page home. */
export function setZoom(value, anchor) {
  setState({ zoom: value === 'fit' ? value : Math.min(400, Math.max(10, Math.round(value * 100) / 100)) });
  applyZoom(anchor);
  if (value === 'fit') homeView();
}

// Room the "home" view keeps clear on the left (the board rail) and right, and above the page.
const VIEW_LEFT = 56;
const VIEW_RIGHT = 24;
const VIEW_TOP = 24;

/** Home view: the page centred between the rail and the right edge, its top VIEW_TOP below the top of the view. */
function homeView() {
  const area = $('#editor-area');
  const a = area.getBoundingClientRect();
  const p = $('#page-wrap').getBoundingClientRect();
  area.scrollLeft += p.left - a.left + p.width / 2 - (VIEW_LEFT + (area.clientWidth - VIEW_LEFT - VIEW_RIGHT) / 2);
  area.scrollTop += p.top - a.top - VIEW_TOP;
}

/** Hides or shows the sidebar (Ctrl+\); the editor area's ResizeObserver re-fits the page. */
export const toggleSidebar = () => saveSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed });

// ---------------------------------------------------------------------------------------------
// Toolbar

export function run(fn) {
  if (state.editor) fn(state.editor.chain().focus()).run();
}

/** Moves a node selection (e.g. a clicked whiteboard) to just after the node, so an insert does not replace it. */
export const afterNodeSel = (c) => c.command(({ tr }) => {
  if (tr.selection instanceof NodeSelection) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to)));
  return true;
});

/** Inserts a smart canvas after the selection and edits it in place. */
export function insertCanvas() {
  const ed = state.editor;
  if (!ed) return;
  afterNodeSel(ed.chain()).insertCanvas().run(); // not run(): focus() would pull focus back out of the canvas in a frame
  const $after = ed.state.doc.resolve(ed.state.selection.$from.before(1)); // insertBoard put the caret in the block after it
  openCanvasEditor(ed, $after.pos - $after.nodeBefore.nodeSize);
}

/** Whiteboard text edits reach the doc only when they end; commit an open one before saving or closing. Pending plan and
 * library flowchart writes go out with it. */
export function commitBoardEdit() {
  finishBoardEdits(); // the edited board keeps the focus, so a canvas being edited keeps its keys
  flushPlans();
  flushFlows();
}

/** Focus to the editor, which restores its selection; while a workspace is open (§7g), to its active board, else to the
 * workspace. */
function focusMain() {
  if (can('view.editor', state)) state.editor?.view.focus();
  else (activeBoard.get() ?? $('#workspace-root'))?.focus();
}

/** onCloseAutoFocus of toolbar menus, selects, popovers and dialogs: focus goes back to the editor, which restores its
 * selection (unless the menu item just opened a dialog, e.g. "Manage presets…"). */
export function refocusEditor(e) {
  e?.preventDefault();
  if (!state.dialog && !state.confirm) focusMain();
}

export async function openLinkDialog() {
  const ed = state.editor;
  if (!ed) return;
  const value = await openDialog('link', { href: ed.getAttributes('link').href || '' });
  if (value == null) return;
  let href = value.trim();
  if (!href) {
    run((c) => c.extendMarkRange('link').unsetLink());
    return;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) href = `https://${href}`;
  if (ed.state.selection.empty && !ed.isActive('link')) {
    run((c) => c.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }));
  } else {
    run((c) => c.extendMarkRange('link').setLink({ href }));
  }
}

export function applyPresetAt(index) {
  const preset = state.settings.presets[index];
  if (!preset || !state.editor) return;
  state.editor.commands.focus();
  applyPreset(state.editor, preset);
}

// Summoned popups: the tool search palette and its options panel (§7c), the quick tools (§7d). At most one is shown:
// summoning one closes the others (a new summoned popup closes here too).
export function closeSummoned() {
  closeToolSearch();
  closeQuickTools();
  if (state.toolOptions) setState({ toolOptions: null });
}

// Tool search (§7c; components/ToolSearch.jsx).

/** Ctrl+Space: opens the tool search at the pointer (`at`) for what is active now (the canvas being edited, the active
 * board, else the document) and remembers where the focus was and what was selected (`attach`, for "Resolve with
 * assistant"); closes it when it is open. The selection itself is left as it is. */
export function toggleToolSearch() {
  if (state.toolSearch) return closeToolSearch();
  closeSummoned();
  const board = canvasEditor.get()?.board ?? activeBoard.get();
  board?.saveRange(); // the caret in a text item being edited, before the search input takes the selection
  const at = summonAt();
  let attach = null;
  try {
    attach = captureSelection();
  } catch (e) {
    console.warn('No selection attachment:', e); // the palette opens anyway
  }
  setState({ toolSearch: { board, focus: document.activeElement, at, attach } });
}

export function closeToolSearch() {
  const ctx = state.toolSearch;
  if (!ctx) return;
  setState({ toolSearch: null });
  returnFocus(ctx);
}

/** Focus back where it was before the tool search: an input or the chat box, else the board (the caret into the text being
 * edited), else the editor, which restores its selection. */
export function returnFocus({ board, focus }) {
  if (focus?.isConnected && focus.matches('input, textarea')) focus.focus();
  else if (focus?.isConnected && focus.editor && focus.matches('[data-chat-input]')) focus.editor.view.focus();
  else if (board && !board.destroyed) board.focus();
  else focusMain();
}

// Quick tools (§7d; components/QuickTools.jsx).

let pointer = null; // the last pointer position in the window

/** Where a summoned popup opens: the pointer, else (it never moved in the window) the centre of the page's viewport (§7g). */
function summonAt() {
  if (pointer) return pointer;
  const v = viewportRect();
  return { x: v.left + v.width / 2, y: v.top + v.height / 2 };
}

/** Ctrl+Tab: shows the quick tools island at the pointer for what is active now (as the tool search); hides it when it
 * is shown. Never moves the focus. */
export function toggleQuickTools() {
  if (state.quickTools) return closeQuickTools();
  closeSummoned(); // the tool search gives the focus back first
  const board = canvasEditor.get()?.board ?? activeBoard.get();
  if (!board && !can('view.editor', state)) return; // a workspace without a board: no document to format
  setState({ quickTools: { board, ...summonAt() } });
}

export const closeQuickTools = () => setState({ quickTools: null });

export function setDraftThread(url) {
  if (!state.draft) return;
  state.draft.threadUrl = url || null;
  markDirty();
}

// ---------------------------------------------------------------------------------------------
// Editor + autosave

const ISLAND_CLEARANCE = { top: 8, right: 8, bottom: 96, left: 8 };

let undoLog = null; // the open draft's undo steps, saved with it (§7e, history.js)

/** A TipTap editor on `doc` in `element` with the open draft's extensions and node views; with `historyFile` its undo history
 * rebuilt from it, keeping `keep` undo steps; `onUpdate` after each change. → {editor, log (its undo steps, §7e)}. The open
 * draft's (mountEditor) and the assistant's background sessions' (assistant/sessions.js). */
export function makeEditor(element, doc, historyFile, keep, onUpdate) {
  const editor = new Editor({
    element,
    extensions: [...buildExtensions(state.settings.historyLimit || 50), PasteNotice], // 0 keeps none after closing, still 50 while open
    content: doc || '',
    // The toolbar island floats over the bottom of the editor area: keep the caret scrolled clear of it.
    editorProps: { attributes: { spellcheck: 'true' }, scrollMargin: ISLAND_CLEARANCE, scrollThreshold: ISLAND_CLEARANCE },
    onUpdate,
  });
  // Straight into the view: no transaction, so nothing marks the draft dirty or scrolls.
  const rebuilt = historyFile && history.rebuild(editor.state, historyFile, keep);
  if (rebuilt) editor.view.updateState(rebuilt.state);
  const log = rebuilt?.log ?? history.newLog(editor.state);
  editor.on('transaction', ({ transaction, appendedTransactions }) => history.record(log, transaction, appendedTransactions, editor.state));
  return { editor, log };
}

/** Mounts a new editor on `doc`; with `historyFile` its undo history is rebuilt from it, keeping `keep` undo steps. */
function mountEditor(doc, historyFile = null, keep = state.settings.historyLimit) {
  clearTimeout(state.saveTimer);
  state.dirty = false;
  state.editor?.destroy();
  state.editor = null;
  $('#editor').replaceChildren();
  const { editor: ed, log } = makeEditor($('#editor'), doc, historyFile, keep, () => {
    updateWordCount();
    if (!state.smoke) markDirty();
  });
  state.editor = ed;
  undoLog = log;
  clearRevLog(); // a new doc: the next rev, and no older one maps onto it (§8 Revisions)
  ed.on('transaction', ({ transaction, appendedTransactions }) => recordRev(transaction, appendedTransactions));
  updateWordCount();
  renderSaveStatus(); // also re-renders the toolbar, which follows the new editor (useEditor)
  homeView(); // every draft opens with its page in the home view
}

function updateWordCount() {
  setState({ words: state.editor ? wordCount(state.editor.getJSON()) : 0 });
}

function renderSaveStatus(error) {
  let label;
  if (error) label = 'Save failed';
  else if (state.dirty) label = 'Unsaved';
  else if (state.lastSaved) label = `Saved ${new Date(state.lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  else label = state.draft?.id ? 'Saved' : 'New draft';
  setState({ saveLabel: label, saveError: !!error });
}

function markDirty() {
  state.dirty = true;
  renderSaveStatus();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 800);
}

let saveChain = Promise.resolve(true);

/** Saves the current draft if dirty. Saves are serialized. Resolves true on success (or nothing to save). */
export function saveNow() {
  clearTimeout(state.saveTimer);
  saveChain = saveChain.then(doSave, doSave);
  return saveChain;
}

async function doSave() {
  if (!state.dirty || !state.draft || !state.editor || state.smoke) return true;
  const doc = state.editor.getJSON();
  const historyFile = history.encode(undoLog, state.settings.historyLimit);
  const draft = state.draft;
  Object.assign(draft, { title: draftTitle(doc), doc });
  state.dirty = false;
  state.saving = true;
  setState({ saveLabel: 'Saving...' });
  try {
    const { id, updated } = await api.drafts.save(draft);
    const isNew = !draft.id;
    Object.assign(draft, { id, updated });
    state.lastSaved = updated;
    upsertDraftEntry(draft);
    if (isNew && state.draft === draft) await saveSettings({ lastDraftId: id });
    if (isNew) await saveDraftOrder();
    await api.drafts.saveHistory(id, historyFile);
    renderSaveStatus();
    return true;
  } catch (e) {
    if (state.draft === draft) state.dirty = true;
    renderSaveStatus(true);
    toast(`Could not save the draft: ${e.message || e}`, true);
    return false;
  } finally {
    state.saving = false;
  }
}

/** Saves `draft` held by an editor `ed` other than the open draft's (an assistant background session, assistant/sessions.js), with
 * its undo steps `log`: the same draft file, history file and save chain as the open draft's. Resolves true on success. */
export function saveOther(draft, ed, log) {
  const save = async () => {
    try {
      const doc = ed.getJSON();
      Object.assign(draft, { title: draftTitle(doc), doc });
      Object.assign(draft, await api.drafts.save(draft));
      upsertDraftEntry(draft);
      await api.drafts.saveHistory(draft.id, history.encode(log, state.settings.historyLimit));
      return true;
    } catch (e) {
      toast(`Could not save the draft "${draft.title}": ${e.message || e}`, true);
      return false;
    }
  };
  saveChain = saveChain.then(save, save);
  return saveChain;
}

function upsertDraftEntry(draft) {
  const entry = { id: draft.id, title: draft.title, threadUrl: draft.threadUrl, updated: draft.updated, pushedAt: draft.pushedAt };
  setState({ drafts: [entry, ...state.drafts.filter((d) => d.id !== draft.id)].sort((a, b) => b.updated - a.updated) });
}

// A new draft holding `doc` (TipTap JSON; null: empty). Not persisted until the first change, so empty drafts never pile
// up (createDraft saves one at once).
function newDraft(doc = null, { focus = true } = {}) {
  state.draft = { title: 'Untitled draft', threadUrl: state.settings.selectedThread || null, created: Date.now(), pushedAt: null, doc };
  state.lastSaved = null;
  mountEditor(doc);
  if (focus) state.editor.commands.focus();
}

/** A new draft holding `doc` (TipTap JSON; null: empty) in thread `threadUrl` (undefined: the selected thread), saved at
 * once so it has an id (an empty one too: an agent asked for it), then filed in `folderId` and tagged `tagId`; shown in the
 * editor without taking the focus. Resolves {draftId}; throws when it could not be saved. */
export async function createDraft({ threadUrl, folderId = null, tagId = null, doc = null } = {}) {
  if (!(await saveNow())) throw new Error('The open draft could not be saved');
  newDraft(doc, { focus: false });
  if (threadUrl !== undefined) state.draft.threadUrl = draftThreadUrl(threadUrl);
  markDirty();
  if (!(await saveNow()) || !state.draft.id) throw new Error('The new draft could not be saved');
  const draftId = state.draft.id;
  if (folderId) await moveDraft(draftId, folderId);
  if (tagId) await setDraftTag(draftId, tagId);
  return { draftId };
}

/** Opens the draft `id` and shows the editor page (§7g: from a workspace too); `show: false` keeps the page shown.
 * `remember: false` leaves settings.lastDraftId alone (agents: the draft the app reopens stays the user's choice). */
export async function openDraft(id, { show = true, remember = true } = {}) {
  if (WORKER && id !== WORKER_DRAFT) return toast('This window works on one draft only.');
  flushPlans();
  flushFlows();
  if (!(await saveNow())) return;
  // The background window of computer use saves and closes this draft first (§7i Background window): it is never open twice.
  if (!WORKER && state.worker?.draftId === id) await api.computer.close();
  // The assistant's background session of this draft hands over (§7i Background drafts): its document and undo steps after its
  // last command and save, not the disk copy. A missing or unreadable history file only means no undo history (§7e).
  const bg = await handOver(id);
  const [draft, historyFile] = bg ? [bg.draft, bg.history] : await Promise.all([api.drafts.load(id), api.drafts.loadHistory(id).catch(() => null)]);
  if (!draft) {
    toast('That draft could not be loaded.', true);
    setState({ drafts: await api.drafts.list() });
    return;
  }
  state.draft = draft;
  state.lastSaved = draft.updated;
  if (bg) mountEditor(bg.doc, historyFile, state.settings.historyLimit || 50); // the session's steps, also with 0 kept after closing
  else mountEditor(draft.doc, historyFile);
  if (show) await showPage('editor');
  if (remember) await saveSettings({ lastDraftId: id });
}

export async function startNewDraft() {
  if (WORKER) return toast('This window works on one draft only.');
  if (!(await saveNow())) return;
  newDraft();
  await showPage('editor');
}

export async function unpushDraft(entry) {
  if (!(await confirmDialog({
    title: `Mark "${entry.title}" as not pushed?`,
    description: 'Use this only if you did not press Submit in the forum.',
    confirmText: 'Unpush',
  }))) return;
  try {
    await doUnpushDraft(entry.id);
  } catch (e) {
    toast(`Could not update the draft: ${e.message || e}`, true);
  }
}

// Writes a draft that may not be the open one: the open one through the editor and autosave, another by load → save.
// Resolves false when it could not be saved or loaded.
async function updateDraft(id, patch) {
  if (state.draft?.id === id) {
    Object.assign(state.draft, patch);
    state.dirty = true;
    refresh();
    return saveNow();
  }
  Object.assign(backgroundDraft(id) ?? {}, patch); // an assistant background session's next save keeps the change
  const draft = await api.drafts.load(id);
  if (!draft) return false;
  Object.assign(draft, patch, await api.drafts.save({ ...draft, ...patch }));
  upsertDraftEntry(draft);
  return true;
}

/** Unpush without the dialog (§8 drafts.unpush). */
export const doUnpushDraft = (id) => updateDraft(id, { pushedAt: null });

/** The draft `id` → its thread `url` (as draftThreadUrl; null: none), without a dialog. Another draft is rewritten, which bumps
 * its `updated` (it moves up the sidebar when the list follows it). */
export const setDraftThreadFor = (id, url) => updateDraft(id, { threadUrl: draftThreadUrl(url) });

export async function deleteDraft(entry) {
  if (!(await confirmDialog({
    title: `Delete "${entry.title}"?`,
    description: 'It is moved to the drafts trash folder.',
    confirmText: 'Delete',
    destructive: true,
  }))) return;
  await doDeleteDraft(entry.id);
}

/** Moves the draft `id` to the drafts trash without a dialog; the open one is replaced by the first visible draft. */
export async function doDeleteDraft(id) {
  const isCurrent = state.draft?.id === id;
  if (isCurrent) {
    clearTimeout(state.saveTimer);
    state.dirty = false;
    await saveChain; // an in-flight save must not recreate the file after removal
  } else if (await dropSession(id)) {
    await saveChain; // the same for an assistant background session of it (closed unsaved)
  }
  if (state.worker?.draftId === id) await api.computer.close(); // the background window's last save comes before the removal
  await api.drafts.remove(id);
  setState({ drafts: state.drafts.filter((d) => d.id !== id) });
  if (!isCurrent) return;
  const next = visibleDrafts()[0];
  if (next) await openDraft(next.id, { show: false }); // a delete from a workspace page stays on it
  else newDraft();
}

// ---------------------------------------------------------------------------------------------
// Sidebar

export function threadLabel(t) {
  return t.subject ? `${t.subject} / ${t.title}` : t.title || t.url;
}

/** The listed thread of the topic `url` (any form normalizeThread takes; matched by topic id), or undefined. */
function findThread(url) {
  const id = topicId(url);
  return id ? state.settings.threads.find((t) => topicId(t.url) === id) : undefined;
}

// A draft's thread URL for `url`: the listed thread's (it may predate the canonical form, and its drafts must match it), else
// the canonical URL; null for none or not a forum topic URL.
const draftThreadUrl = (url) => (url ? findThread(url)?.url ?? (normalizeThread(url) || null) : null);

async function refreshStatus() {
  let status;
  try {
    status = await api.forum.status();
  } catch {
    status = { loggedIn: false };
  }
  setState({ status });
  if (status.loggedIn) describeUnnamed();
}

/** Threads added by URL that the forum has not described yet get their names (after a status check or a login). */
const describeUnnamed = () => describeThreads(state.settings.threads.filter((t) => !t.year && !t.subject).map((t) => t.url).slice(0, 50));

/** A thread row (or All drafts): filters the drafts and shows the editor page (§7g). */
export async function selectThread(url) {
  await showPage('editor');
  await saveSettings({ selectedThread: url });
}

export function openInForum(url) {
  api.forum.open(url).catch((e) => toast(`Could not open the forum: ${e.message || e}`, true));
}

export async function removeThread(t) {
  if (!(await confirmDialog({
    title: `Remove "${threadLabel(t)}" from the list?`,
    description: 'Drafts are kept.',
    confirmText: 'Remove',
    destructive: true,
  }))) return;
  await doRemoveThread(t.url);
}

/** Removes the thread `url` from the list without a dialog (its drafts are kept). */
export function doRemoveThread(url) {
  const threads = state.settings.threads.filter((x) => x.url !== url);
  const selectedThread = state.settings.selectedThread === url ? null : state.settings.selectedThread;
  return saveSettings({ threads, selectedThread });
}

export async function addThreadUrl() {
  const value = await openDialog('addThread', {
    validate: (input) => {
      if (!normalizeThread(input)) return 'Enter a forum topic URL like https://daf.staffs.ac.uk/topic/12345-name/';
      if (findThread(input)) return 'That thread is already in the list.';
      return '';
    },
  });
  if (value != null) await addThread(value);
}

/** Adds the thread `url` (canonical, thread-url.mjs) titled `title` (default: from the URL's slug), then looks it up on the
 * forum in the background. Resolves the URL, or null when it is not a forum topic URL or already listed. */
export async function addThread(url, title) {
  const u = normalizeThread(url);
  if (!u || findThread(u)) return null;
  await saveSettings({ threads: [...state.settings.threads, { url: u, title: title || slugTitle(u), subject: '', year: '', forum: '' }] });
  describeThreads([u]);
  return u;
}

// A title the user did not choose: none, the URL (threads added before the forum lookup) or the slug's.
const autoTitle = (t) => !t.title || t.title === t.url || t.title === slugTitle(t.url);

/** Looks the listed threads `urls` up on their topic pages and fills in subject, year and forum, and the title unless the user
 * chose it. Never throws: a thread the forum does not describe (offline, no access, removed) stays as it is. */
async function describeThreads(urls) {
  if (!urls.length) return;
  try {
    const found = new Map((await api.forum.describe(urls)).threads.map((f) => [f.url, f]));
    if (!found.size) return;
    await saveSettings({ threads: state.settings.threads.map((t) => {
      const f = found.get(t.url);
      return f ? { ...t, title: autoTitle(t) ? f.title : t.title, subject: f.subject, year: f.year, forum: f.forum } : t;
    }) });
  } catch {
    // the thread keeps its title from the URL until the next lookup
  }
}

export async function discoverThreads() {
  setState({ discovering: true });
  try {
    const { threads } = await api.forum.discover();
    await saveSettings({ threads: mergeThreads(state.settings.threads, threads).threads });
    toast(`Found ${threads.length} thread${threads.length === 1 ? '' : 's'}.`);
  } catch (e) {
    const message = String(e.message || e);
    await (message.includes('not-logged-in') ? alertDialog('Log in to the forum first.') : alertDialog('Could not find threads', message));
  } finally {
    setState({ discovering: false });
  }
}

export async function login() {
  if (state.status.loggedIn) {
    openInForum('https://daf.staffs.ac.uk/');
    return;
  }
  setState({ loggingIn: true });
  try {
    state.status = await api.forum.login();
    if (state.status.loggedIn) describeUnnamed();
  } catch (e) {
    await alertDialog('Login failed', String(e.message || e));
  } finally {
    setState({ loggingIn: false });
  }
}

export function visibleDrafts() {
  const sel = state.settings.selectedThread;
  return sel ? state.drafts.filter((d) => d.threadUrl === sel) : state.drafts;
}

// Draft folders live in settings only, so moving a draft never rewrites its file.
const folderList = () => state.settings.folders || [];

/** The Drafts list: folders with the visible drafts each holds, then the visible drafts in no folder. With a thread
 * selected, a folder shows when it is empty or holds a draft of that thread. */
export function draftGroups() {
  const map = state.settings.draftFolders || {};
  const ids = new Set(folderList().map((f) => f.id));
  const folderOf = (d) => (ids.has(map[d.id]) ? map[d.id] : null);
  const list = sortDrafts(visibleDrafts(), state.settings.draftOrder);
  const groups = folderList().map((folder) => ({ folder, drafts: list.filter((d) => folderOf(d) === folder.id) }))
    .filter((g) => g.drafts.length || !state.drafts.some((d) => folderOf(d) === g.folder.id));
  return { groups, loose: list.filter((d) => !folderOf(d)) };
}

/** Shows the change at once (the two clicks of a double-click toggle before the first write returns), then saves it. */
function saveFolders(partial) {
  setState({ settings: { ...state.settings, ...partial } });
  return saveSettings(partial);
}

function setFolder(id, patch) {
  return saveFolders({ folders: folderList().map((f) => (f.id === id ? { ...f, ...patch(f) } : f)) });
}

/** Saves the draft → folder map (and `more` settings), dropping entries for drafts or folders that no longer exist. */
function saveDraftFolders(map, folders = folderList(), more = {}) {
  return saveFolders({ folders, draftFolders: pruneMap(map, state.drafts, folders), ...more });
}

/** Saves the manual order with every draft in it (new ones first, deleted ones dropped), so it never follows `updated`. */
function saveDraftOrder() {
  const draftOrder = sortDrafts(state.drafts, state.settings.draftOrder).map((d) => d.id);
  if (draftOrder.join() !== state.settings.draftOrder?.join()) return saveSettings({ draftOrder });
}

/** Drag drop between draft rows: the draft goes just before / after the draft `target` and joins its folder. */
export function placeDraft(id, target, after) {
  const { order, map } = dropDraft(state.drafts, state.settings.draftOrder, state.settings.draftFolders || {}, id, target, after);
  return saveDraftFolders(map, folderList(), { draftOrder: order });
}

/** Drag drop between folders: the folder goes just before / after the folder `target`. */
export function moveFolder(id, target, after) {
  const order = moveBeside(folderList().map((f) => f.id), id, target, after);
  return saveFolders({ folders: order.map((x) => folderList().find((f) => f.id === x)) });
}

/** Adds a folder named "New folder"; resolves with its id (the Sidebar starts renaming it). */
export const newFolder = () => createFolder('New folder');

/** Adds an open folder named `name` (trimmed; empty: "New folder") at the end; resolves with its id. */
export async function createFolder(name) {
  const folder = { id: crypto.randomUUID(), name: name.trim() || 'New folder', open: true };
  await saveFolders({ folders: [...folderList(), folder] });
  return folder.id;
}

export const toggleFolder = (id) => setFolder(id, (f) => ({ open: !f.open }));

export function renameFolder(id, name) {
  if (name.trim()) setFolder(id, () => ({ name: name.trim() }));
}

/** Moves a draft into a folder (and opens it), or to the top level with folderId null. */
export function moveDraft(id, folderId) {
  const folders = folderList().map((f) => (f.id === folderId ? { ...f, open: true } : f));
  return saveDraftFolders({ ...state.settings.draftFolders, [id]: folderId }, folders);
}

export async function deleteFolder(folder) {
  const holds = state.drafts.some((d) => state.settings.draftFolders?.[d.id] === folder.id);
  if (holds && !(await confirmDialog({
    title: `Delete the folder "${folder.name}"?`,
    description: 'Its drafts move back to the top level; no draft is deleted.',
    confirmText: 'Delete folder',
    destructive: true,
  }))) return;
  await doDeleteFolder(folder.id);
}

/** Deletes the folder `id` without a dialog; its drafts move to the top level (none is deleted). */
export const doDeleteFolder = (id) => saveDraftFolders(state.settings.draftFolders || {}, folderList().filter((f) => f.id !== id));

/** Tags a draft (tagId null: untagged). In settings only, like folders: the draft file is never rewritten. */
export const setDraftTag = (id, tagId) => saveSettings({ draftTags: tagDraft(state.settings, state.drafts, id, tagId) });

// ---------------------------------------------------------------------------------------------
// Settings dialog

/** Opens Settings, at `section` (a SettingsDialog section id) when it is one; a click event passed by a handler is ignored. */
export async function openSettings(section) {
  const values = await openDialog('settings', { settings: state.settings, section: typeof section === 'string' ? section : undefined });
  if (values) await changeSettings(values);
}

/** Saves and applies `values` (some settings keys: the dialog's, or settings.patch's, §8). */
export async function changeSettings(values) {
  const s = state.settings;
  const remount = ('theme' in values && values.theme !== s.theme) || ('historyLimit' in values && values.historyLimit !== s.historyLimit);
  await saveSettings(values);
  applySettings();
  // Whiteboard NodeViews read the theme when they render and the history depth is set when the editor is built: remount
  // the editor, its history rebuilt (all the steps the open draft keeps in memory), so they pick the change up.
  if (remount && state.editor && await saveNow()) {
    const keep = state.settings.historyLimit || 50;
    mountEditor(state.editor.getJSON(), history.encode(undoLog, keep), keep);
  }
}

// ---------------------------------------------------------------------------------------------
// Push

async function chooseThread() {
  const threads = state.settings.threads;
  if (!threads.length) {
    await alertDialog('Add a thread first', 'Use "Find my threads" or "Add thread URL".');
    return null;
  }
  return openDialog('chooseThread', { threads, selected: state.settings.selectedThread });
}

/** Fills the forum reply box with the open draft after the human confirm (never submits). A draft without a thread asks
 * for one, or with `requireThread` resolves {code: 'no_thread'} (agents get no thread dialog). */
export async function push({ requireThread = false } = {}) {
  if (!state.editor || !state.draft) return;
  let url = state.draft.threadUrl;
  if (!can('draft.hasThread', state.draft)) {
    if (requireThread) return { code: 'no_thread' };
    url = await chooseThread();
    if (!url) return;
    state.draft.threadUrl = url;
    markDirty();
  }
  const thread = findThread(url);
  const label = thread ? threadLabel(thread) : url;
  if (!(await confirmDialog({
    title: `Fill the reply box of "${label}" with this draft?`,
    description: 'You review and press Submit in the forum window.',
    confirmText: 'Push',
  }))) return;

  let error = null;
  showOverlay('Rendering whiteboards...');
  try {
    commitBoardEdit();
    await saveNow();
    const payload = await buildPayload(state.editor, state.settings);
    showOverlay('Uploading images in the forum window...');
    const result = await api.forum.push({ threadUrl: url, ...payload });
    if (!result?.ok) throw new Error(result?.error || 'Unknown error');
    state.draft.pushedAt = Date.now();
    state.dirty = true;
    refresh();
    await saveNow();
  } catch (e) {
    error = e;
  }
  hideOverlay();
  if (error) await alertDialog('Push failed', String(error.message || error));
  else toast('Content placed in the forum reply box. Review it there and press Submit.');
}

// ---------------------------------------------------------------------------------------------
// Shortcuts and global events

const WINDOW_ZOOM = { 'app.zoomIn': 1, 'app.zoomOut': -1, 'app.zoomReset': 0 };
const PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `text.preset${n}`);
const go = (e, fn) => {
  e.preventDefault();
  fn();
};

// The app's own shortcuts (§7k keybinds: keyIs / keyAmong match the user's chords).
function onKeyDown(e) {
  if (state.dialog || state.confirm) return;
  if (keyIs('app.save', e)) {
    go(e, () => {
      commitBoardEdit();
      saveNow();
    });
  } else if (keyIs('app.toolSearch', e)) {
    // Tool search, also in canvas edit mode, a text item or an input. Window capture: before ProseMirror and the boards;
    // never types a space.
    e.stopPropagation();
    go(e, toggleToolSearch);
  } else if (keyIs('app.quickTools', e)) {
    // Quick tools, in the same places as the tool search. Never moves the focus or cycles a board's items; holding the
    // keys does not toggle it again and releasing them does nothing.
    e.stopPropagation();
    go(e, () => e.repeat || toggleQuickTools());
  } else if (keyAmong(Object.keys(WINDOW_ZOOM), e) && !e.target.closest?.('[data-browser-pane], [data-browser-page]')) {
    // Window zoom: the main window has no menu, so no accelerators. In the browser's pane or page the browser's own zoom
    // keys zoom its tab instead (§7j browserKey).
    go(e, () => api.window.zoom(WINDOW_ZOOM[keyAmong(Object.keys(WINDOW_ZOOM), e)]));
  } else if (keyIs('app.plans', e)) {
    go(e, () => e.repeat || showPage('plan')); // the plan workspace from anywhere (§7g); in it, nothing (no toggle)
  } else if (keyIs('app.browser', e)) {
    go(e, () => e.repeat || showPage('browser')); // the browser (§7j), as the Plans page
  } else if (keyIs('insert.flowchart', e) && can('view.editor', state)) {
    go(e, () => e.repeat || insertFlowchartDialog());
  } else if (canvasEditor.get()) {
    // A canvas being edited handles every other key itself: no document shortcuts.
  } else if (!can('view.editor', state)) {
    // A workspace (§7g): no document shortcuts.
  } else if (keyIs('text.link', e)) {
    go(e, openLinkDialog);
  } else if (keyIs('app.sidebar', e)) {
    go(e, toggleSidebar);
  } else if (keyIs('insert.whiteboard', e)) {
    go(e, () => run((c) => afterNodeSel(c).insertWhiteboard()));
  } else if (keyIs('insert.canvas', e)) {
    go(e, insertCanvas);
  } else if (keyAmong(PRESETS, e) && !e.target.closest?.('.wb')) {
    go(e, () => applyPresetAt(PRESETS.indexOf(keyAmong(PRESETS, e))));
  }
}

function onBeforeUnload(e) {
  if (state.syncReload) return; // GitHub backup: the files on disk are newer than anything in memory
  commitBoardEdit();
  const bg = flushSessions(); // the assistant's background sessions save their last change; null when none has one
  if (state.forceClose || state.smoke || !(state.dirty || state.saving || bg)) return;
  e.preventDefault();
  e.returnValue = false; // cancel this close, save, then close again
  Promise.resolve(bg).then(saveNow).then(async (ok) => {
    if (!ok && !(await confirmDialog({
      title: 'The draft could not be saved.',
      description: 'Close anyway and lose the unsaved changes?',
      confirmText: 'Close anyway',
      destructive: true,
    }))) return;
    state.forceClose = true;
    window.close();
  });
}

/** Restart on the update toast: saves the open draft and the assistant's background sessions as a close does, then main quits
 * and runs the installer. A failed save keeps the app open (its own toast says so). */
async function installUpdate() {
  commitBoardEdit();
  await flushSessions();
  if (await saveNow()) api.update.install();
}

// A click on the editor area's background (around the page or in its padding; §7 Background clicks) puts the caret at the
// nearest text position at the click's height, as a word processor's margin does: a node-selected block or a text selection
// gives way to it and the whiteboards' item selections clear; nothing scrolls. Canvas Mode handles such a click first (§6b).
function marginClick(e) {
  const view = state.editor?.view;
  const area = e.currentTarget;
  const bg = (t) => t === area || t === area.firstElementChild || t.id === 'page-wrap' || t.id === 'editor' || t.classList.contains('page');
  if (!view || !backgroundClick(e, bg)) return;
  e.preventDefault(); // no focus change, no native selection
  for (const el of view.dom.querySelectorAll('.wb')) if (el.wbView?.sel.size) el.wbView.select(null);
  const r = view.dom.getBoundingClientRect();
  const y = Math.min(Math.max(e.clientY, r.top + 1), r.bottom - 1);
  const hit = view.posAtCoords({ left: Math.min(Math.max(e.clientX, r.left + 1), r.right - 1), top: y });
  if (hit) {
    const { doc } = view.state;
    const node = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
    let [$pos, dir] = [doc.resolve(hit.pos), 1];
    if (node?.isBlock && node.isAtom) { // a whiteboard, canvas or chart: before or after it by the click's height
      const b = view.nodeDOM(hit.inside)?.getBoundingClientRect();
      if (b && y < b.top + b.height / 2) dir = -1;
      $pos = doc.resolve(dir < 0 ? hit.inside : hit.inside + node.nodeSize);
    }
    const sel = $pos.parent.inlineContent ? TextSelection.create(doc, $pos.pos)
      : TextSelection.findFrom($pos, dir, true) ?? TextSelection.findFrom($pos, -dir, true);
    if (sel) view.dispatch(view.state.tr.setSelection(sel));
  }
  view.focus();
}

function bindStatic() {
  new ResizeObserver(() => applyZoom()).observe($('#editor-area'));
  // Middle-drag pans the editor area; Ctrl + wheel zooms the page around the pointer (also while a canvas is edited in place).
  bindPanZoom($('#editor-area'), $('#page-wrap'), setZoom);
  $('#editor-area').addEventListener('pointerdown', marginClick);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  // Entering canvas edit mode shows the notice pill (§6b); leaving it, like every other mode change, shows nothing.
  let editing = null;
  canvasEditor.subscribe(() => {
    const s = canvasEditor.get();
    if (s && s !== editing) notify({ icon: h(Frame), text: 'Canvas Mode', mode: true });
    editing = s;
  });
}

// ---------------------------------------------------------------------------------------------
// Startup (main.jsx calls start() once <App/> is in the DOM)

async function init() {
  setState({ settings: await api.settings.get() });
  bindStatic();
  applySettings();
  if (!WORKER) refreshStatus(); // the background window never asks the forum
  setState({ drafts: await api.drafts.list() });
  await saveDraftOrder(); // the first time: the drafts keep their `updated` order
  await initPlans();
  await initFlows();
  if (WORKER) return startWorker();
  initBrowser();
  watchWorker();
  api.update.onReady((version) => sonner(`Update ${version} downloaded`, {
    id: 'update', duration: Infinity, action: { label: 'Restart', onClick: installUpdate },
  }));
  if (!state.settings.demoSeeded && !SMOKE) { // the first start: the demo draft, once (samples/demo.js)
    if (!state.drafts.length) await createDraft({ threadUrl: null, doc: demoDoc() }).catch(() => {}); // saved; lastDraftId opens it below
    await saveSettings({ demoSeeded: true }).catch(() => {}); // deleting it later does not bring it back; a profile with drafts never gets it
  }
  const { lastDraftId } = state.settings;
  const id = state.drafts.some((d) => d.id === lastDraftId) ? lastDraftId : state.drafts[0]?.id;
  if (id) await openDraft(id);
  else newDraft();
  await restoreView(state.settings.lastView); // last: a workspace opens over the open draft
  installAgent(); // window.__agent and the command events (§8)
  startGitHub();
}

/** GitHub backup (SPEC §4b): main runs it. Before it copies files from GitHub here it saves everything through flush(), then
 * reload() shows them; busy() covers the window while closing pushes. A new error is a toast. */
function startGitHub() {
  window.__sync = {
    flush: async () => {
      commitBoardEdit();
      await flushSessions();
      await Promise.all([flushPlans(), flushFlows()]);
      return saveNow();
    },
    reload: () => {
      state.syncReload = true; // saved by flush(): the files on disk are the new ones, so no unload handler saves
      location.reload();
    },
    busy: (text) => {
      document.body.inert = !!text; // no typing or clicks under the overlay
      setState({ overlay: text });
    },
  };
  let error = null;
  api.github.onEvent((s) => {
    if (s.error && s.error !== error) toast(`GitHub backup failed. ${s.error}`, true);
    error = s.error;
  });
  api.github.start();
}

/** The background window of computer use (§7i Background window): its one draft on the editor page, then window.__worker for
 * main, with the draft it holds (null: it could not load it) and release(), its last change saved before main closes it. */
async function startWorker() {
  await openDraft(WORKER_DRAFT, { remember: false });
  window.__worker = { draftId: state.draft?.id ?? null, release: () => { commitBoardEdit(); return saveNow(); } };
}

/** The user's window follows the background window (§7i Background window): the draft it has (the sidebar badge, the chat
 * panel's status line) and its saves (the sidebar entry). */
function watchWorker() {
  api.computer.onEvent((e) => {
    if (e.type === 'worker') setState({ worker: e.draftId ? { draftId: e.draftId, title: e.title } : null, ...(!e.draftId && { workerPane: false }) });
    if (e.type !== 'saved') return;
    upsertDraftEntry(e.entry);
    if (state.worker?.draftId === e.entry.id) setState({ worker: { ...state.worker, title: e.entry.title } });
  });
}

/** The background window takes draft `id` (computer.mjs background.open): the assistant's background session of it ends first,
 * its last change saved, so two editors never hold one draft. → main's answer, a screenshot of that window. */
export async function openInBackground(id, title) {
  await handOver(id);
  return api.computer.open({ draftId: id, title });
}

let ready;

export function start() {
  ready = init().catch((e) => {
    console.error(e);
    alertDialog('EasyWriter failed to start', String(e.message || e));
    throw e;
  });
}

// ---------------------------------------------------------------------------------------------
// Smoke test hook (main process: `electron . --smoke`)

function sampleDoc() {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [text('EasyWriter smoke test')] },
      { type: 'heading', attrs: { level: 2 }, content: [text('Formatting')] },
      para(
        text('Bold', [{ type: 'bold' }]), text(', '),
        text('italic', [{ type: 'italic' }]), text(', '),
        text('underline', [{ type: 'underline' }]), text(', '),
        text('strike', [{ type: 'strike' }]), text(', '),
        text('big', [{ type: 'fontSize', attrs: { size: '150' } }]), text(', '),
        text('blue', [{ type: 'textColor', attrs: { color: 'blue' } }]), text(', '),
        text('highlighted', [{ type: 'highlight', attrs: { color: 'yellow' } }]), text(', '),
        text('Georgia', [{ type: 'fontFamily', attrs: { font: 'Georgia' } }]), text(' and a '),
        text('link', [{ type: 'link', attrs: { href: 'https://daf.staffs.ac.uk/' } }]), text('.')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para(text('Bullet one'))] }, { type: 'listItem', content: [para(text('Bullet two'))] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [para(text('First'))] }, { type: 'listItem', content: [para(text('Second'))] }] },
      { type: 'blockquote', content: [para(text('A quoted paragraph.'))] },
      { type: 'codeBlock', content: [text('const answer = 42;')] },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [cell('tableHeader', 'Header A'), cell('tableHeader', 'Header B')] },
          { type: 'tableRow', content: [cell('tableCell', 'Cell 1'), cell('tableCell', 'Cell 2')] },
        ],
      },
      {
        type: 'box',
        content: [
          { type: 'boxTitle', content: [text('Box title')] },
          { type: 'boxContent', content: [para(text('Box body text.'))] },
        ],
      },
      {
        type: 'whiteboard',
        attrs: {
          height: 300,
          bg: 'post',
          items: [
            { id: 'smokeimg', type: 'image', src: sampleImage(), x: 20, y: 40, w: 400, h: 200 },
            { id: 'smoketxt', type: 'text', html: 'Whiteboard <b>text</b>', x: 460, y: 60, w: 320, size: 20, color: '#ffffff', bold: false, align: 'left', bg: null },
          ],
        },
      },
      {
        type: 'canvas',
        attrs: {
          w: 600,
          h: 300,
          dw: 300,
          bg: 'post',
          items: [
            { id: 'smokeshape', type: 'shape', shape: 'star', x: 200, y: 50, w: 200, h: 200, color: '#e0c952', width: 4, opacity: 1, fill: 'solid', fillColor: '#e09952', flipX: false, flipY: false },
          ],
        },
      },
      ...planSample(),
      ...flowSample(),
      para(text('End of sample.')),
    ],
  };
}

window.__smoke = async () => {
  await ready;
  if (!can('view.editor', state)) await closeWorkspace({ remember: false }); // a restored lastView would hide the sample
  state.smoke = true; // never persist the sample over a real draft
  state.editor.commands.setContent(sampleDoc());
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const payload = await buildPayload(state.editor, state.settings); // waits for the synced canvases' library records
  const badge = document.querySelector('.sc-flow-missing'); // the sample's synced canvas without a record (samples/flow.js)
  if (badge) { // in view for smoke-ui.png (scrolled by hand: the page's CSS zoom misleads scrollIntoView)
    const area = $('#editor-area');
    area.scrollTop += badge.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientHeight / 2;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); // painted before the capture
  }
  return { ...payload, text: state.editor.getText().slice(0, 200), flows: { missingBadge: !!badge } };
};

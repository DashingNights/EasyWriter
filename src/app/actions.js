import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Frame } from 'lucide-react';
import { createElement as h } from 'react';
import { toast as sonner } from 'sonner';
import { canvasEditor, openCanvasEditor } from '../canvas.js';
import { applyPreset } from '../extensions.js';
import { kitOf, loadable } from '../editors.js';
import { cleanTitle, copyTitle } from '../doc-utils.mjs';
import { draftMarks } from '../draft-marks.js';
import { draftTitle, wordCount } from '../export.js';
import { newDocumentJson } from '../document/defaults.mjs';
import { numberNewLists } from '../document/numbering.mjs';
import { defaultFormat, drawTheme, FORMATS, formatOf, pageOf } from '../formats.mjs';
import { each, first, UI } from '../integrations/ui.js';
import { legacyTopic } from '../thread-url.mjs';
import { edited, entries, groups as groupsOf, META as SUGGEST_META } from '../suggest/core.mjs';
import { activeOf, agentInputOpen, resolve as resolveChanges, setActive, setWindowEditor, setWorkerCall, workerIds } from '../suggest/extension.js';
import { activeBoard, contentWidth, finishBoardEdits, migrateBoards } from '../whiteboard.js';
import { captureSelection } from './assistant/capture.js';
import { backgroundDraft, dropSession, flushSessions, handOver } from './assistant/sessions.js';
import { installAgent } from './commands.js';
import { scrollToBlock } from './commands/ui.mjs';
import { openFind, openReplace } from './components/FindBar.jsx';
import { notify, PasteNotice } from './components/Notices.jsx';
import { dropDraft, moveBeside, sortDrafts } from './draft-order.mjs';
import { defaultTag, draftTag, pruneMap, tagDraft } from './drafts-meta.js';
import { initBrowser } from './browser.js';
import { keyAmong, keyIs, setKeybinds } from './keybinds.js';
import { flushFlows, initFlows, insertFlowchartDialog } from './flows.js';
import { can } from './gates.mjs';
import * as history from './history.js';
import { bindPanZoom, keepPlace, zoomAround } from './panzoom.js';
import { flushPlans, initPlans } from './plans.js';
import { clearRevLog, recordRev } from './rev.js';
import { cell, demoDoc, para, sampleImage, text } from './samples/demo.js';
import { flowSample } from './samples/flow.js';
import { planSample } from './samples/plan.js';
import { applyMotion } from './motion.js';
import { getState, setState, SMOKE, WORKER, WORKER_DRAFT } from './store.js';
import { closeWorkspace, restoreView, showPage } from './views.js';
import { backgroundClick, viewportRect } from './viewport.js';

export { notify }; // ui.notice (§8) reaches it through ctx.actions

const api = window.api;
const SYSTEM_FONT = 'system-ui, Helvetica, Arial, sans-serif';
/** The refusal of a draft whose format this build does not know (openDraft, assistant/sessions.js). */
export const NEWER_FORMAT = 'This draft was saved by a newer EasyWriter. Update EasyWriter to open it.';

const state = getState();
const $ = (sel) => document.querySelector(sel);
const refresh = () => setState({}); // after an in-place change of state.draft

// ---------------------------------------------------------------------------------------------
// Toasts, overlay, dialogs

export function toast(message, isError = false) {
  if (isError) sonner.error(message);
  else sonner(message);
}

export function showOverlay(text) {
  setState({ overlay: text });
}

export function hideOverlay() {
  setState({ overlay: null });
}

/** Opens a form dialog (DialogHost renders it by type). Resolves with its result, or null on Cancel/Escape. */
export function openDialog(type, props = {}) {
  return new Promise((resolve) => setState({ dialog: { type, props, resolve } }));
}

let autoConfirm = 0; // > 0 while the assistant in Allow all presses a control (ui-control.js): its confirm passes unseen

/** Runs `fn` with every confirmDialog it opens confirmed at once (not an alert). */
export async function confirming(fn) {
  autoConfirm++;
  try {
    return await fn();
  } finally {
    autoConfirm--;
  }
}

/** AlertDialog confirmation. Resolves true on confirm, false on Cancel/Escape. `alert: true` shows only the OK button.
 * `human: true` always shows it and the assistant cannot press its confirm (data-agent-deny): a choice only the user makes. */
export function confirmDialog({ title, description = '', confirmText = 'OK', destructive = false, alert = false, human = false }) {
  // A confirm opened by the user's own click or key (a trusted event) shows even while the assistant presses a control.
  if (autoConfirm && !alert && !human && !window.event?.isTrusted) return Promise.resolve(true);
  state.confirm?.resolve(false);
  return new Promise((resolve) => setState({ confirm: { title, description, confirmText, destructive, alert, human, resolve } }));
}

export const alertDialog = (title, description) => confirmDialog({ title, description, alert: true });

// ---------------------------------------------------------------------------------------------
// Suggestions (docs/plans/suggestions.md Accept, reject and undo)

/** Accepts or rejects (`action`) the suggestions `sel` picks ({ids} | {group} | {all: true}) in `editor` (draft `draftId`), as
 * `by` (a source). Every accept and reject path comes here: rejecting a change the user edited asks first. → the ids resolved,
 * or null when the user kept them. */
export async function resolveSuggestions(editor, draftId, sel, action, { by = 'ui' } = {}) {
  if (!editor || editor.isDestroyed) return null;
  const doc = editor.state.doc;
  const pick = (e) => sel?.all || (sel?.group ? e.g === sel.group : sel?.ids?.includes(e.id));
  const changes = entries(doc).filter(pick);
  if (!changes.length) return [];
  if (action === 'reject' && changes.some((e) => edited(doc, e.id)) && !(await confirmDialog({
    title: changes.length > 1 ? 'Reject these suggestions?' : 'Reject this suggestion?',
    description: 'You edited this suggestion. Rejecting it also removes your edits.',
    confirmText: 'Reject',
    destructive: true,
  }))) return null;
  if (editor.isDestroyed) return null;
  return resolveChanges(editor, { ids: changes.map((e) => e.id) }, action, { by, draftId });
}

const NO_SUGGESTIONS = { groups: [], count: 0, active: null };
let syncedDoc = null;

/** The change in `list` (core.entries) whose blocks hold position `pos` (a deletion has no text to hold the caret). The end is
 * strict: a block's end is the next block's start, where a node selection or gap cursor on that next block sits. */
export const changeAt = (list, pos) => list.find((e) => e.nodes.some((n, k) => e.starts[k] <= pos && pos < e.starts[k] + n.nodeSize));

/** Mirrors the open editor's waiting changes into state.suggestions (the cards, the status bar slot, the sidebar badge, tool
 * search) after a transaction `tr` that changes the doc or the selection or carries the extension's meta; no `tr`: a new editor.
 * The active change is the one under the caret when the caret moved there, else the last shown. */
export function syncSuggestions(tr) {
  const ed = state.editor;
  if (tr && !tr.docChanged && !tr.selectionSet && tr.getMeta(SUGGEST_META) == null) return;
  if (!ed || ed.isDestroyed) {
    syncedDoc = null;
    if (state.suggestions.count) setState({ suggestions: NO_SUGGESTIONS });
    return;
  }
  const { doc, selection } = ed.state;
  const list = entries(doc);
  if (!list.length) {
    syncedDoc = doc;
    if (state.suggestions !== NO_SUGGESTIONS) setState({ suggestions: NO_SUGGESTIONS });
    return;
  }
  let active = activeOf(ed.state);
  const under = !tr || tr.selectionSet ? changeAt(list, selection.from) : null;
  if (under && under.id !== active) {
    const { id } = under;
    active = id; // the decorations follow in a transaction of their own, after this one
    queueMicrotask(() => !ed.isDestroyed && activeOf(ed.state) !== id && entries(ed.state.doc).some((e) => e.id === id) && setActive(ed, id));
  }
  if (!list.some((e) => e.id === active)) active = null;
  const s = state.suggestions;
  const same = doc === syncedDoc;
  if (same && active === s.active) return;
  syncedDoc = doc;
  setState({ suggestions: { groups: same ? s.groups : groupsOf(doc), count: list.length, active } });
}

/** Makes change `id` of the open draft the active one and centres it in the page's viewport (a card row, a tab, Next, Previous). */
export function showSuggestion(id) {
  const ed = state.editor;
  const e = ed && entries(ed.state.doc).find((x) => x.id === id);
  if (!e) return false;
  setActive(ed, id);
  let pos = e.starts[0] ?? e.from;
  if (e.kind === 'attr') pos = 0;
  else if (e.kind === 'delete' && e.side === 'after') pos = e.from - (ed.state.doc.resolve(e.from).nodeBefore?.nodeSize ?? 0);
  scrollToBlock(ed, Math.min(pos, Math.max(0, ed.state.doc.content.size - 1)));
  return true;
}

/** Moves to the next (`dir` 1) or previous (-1) change in document order, wrapping; from the caret when none is active. */
function stepSuggestion(dir) {
  const ed = state.editor;
  const list = ed ? entries(ed.state.doc) : [];
  if (!list.length) return false;
  let i = list.findIndex((e) => e.id === state.suggestions.active);
  if (i < 0) {
    const at = ed.state.selection.from;
    i = dir > 0 ? list.findIndex((e) => e.kind !== 'attr' && e.from >= at) : list.findLastIndex((e) => e.kind === 'attr' || e.from < at);
    if (i < 0) i = dir > 0 ? 0 : list.length - 1;
  } else i = (i + dir + list.length) % list.length;
  return showSuggestion(list[i].id);
}
export const nextSuggestion = () => stepSuggestion(1);
export const previousSuggestion = () => stepSuggestion(-1);

/** Accepts or rejects the changes `sel` picks in the open draft (resolveSuggestions); when the active change went, the first change
 * left after it becomes active. */
async function review(sel, action) {
  const ed = state.editor;
  if (!ed) return null;
  const before = entries(ed.state.doc);
  const at = before.findIndex((e) => e.id === state.suggestions.active);
  const done = await resolveSuggestions(ed, state.draft?.id ?? null, sel, action);
  if (!done?.length || ed.isDestroyed) return done;
  const left = new Set(entries(ed.state.doc).map((e) => e.id));
  if (at >= 0 && !left.has(before[at].id)) setActive(ed, before.slice(at + 1).find((e) => left.has(e.id))?.id ?? null);
  return done;
}
const activeGroup = () => state.suggestions.groups.find((g) => g.changes.some((e) => e.id === state.suggestions.active))?.g;
/** The review actions of the cards, the keys, the status bar and tool search: the active change, a group (default: the active
 * change's), or every change in the draft. */
export const acceptActive = () => state.suggestions.active && review({ ids: [state.suggestions.active] }, 'accept');
export const rejectActive = () => state.suggestions.active && review({ ids: [state.suggestions.active] }, 'reject');
export const acceptChange = (id) => review({ ids: [id] }, 'accept');
export const rejectChange = (id) => review({ ids: [id] }, 'reject');
export const acceptGroup = (g = activeGroup()) => g && review({ group: g }, 'accept');
export const rejectGroup = (g = activeGroup()) => g && review({ group: g }, 'reject');
export const acceptAll = () => review({ all: true }, 'accept');
export const rejectAll = () => review({ all: true }, 'reject');

// ---------------------------------------------------------------------------------------------
// Settings, theme, zoom

// The app's own colours (settings.uiTheme: dark | light | system) are the class "dark" on <html> (app.css); system follows the
// system's light or dark mode, live. The page preview keeps the page theme (data-theme, settings.theme). The background window
// (§7i) keeps the settings it started with, so it follows prefers-color-scheme, which main sets from uiTheme (applyNativeTheme).
const systemDark = matchMedia('(prefers-color-scheme: dark)');
systemDark.addEventListener('change', () => state.settings && applyUiTheme());

function applyUiTheme() {
  const t = state.settings.uiTheme;
  const dark = WORKER || t === 'system' ? systemDark.matches : t !== 'light';
  document.documentElement.classList.toggle('dark', dark);
  if (dark !== state.uiDark) setState({ uiDark: dark });
}

// The user's palette (settings.palette {dark, light}: key → #rrggbb, Settings > General Palette) over the theme's tokens
// (app.css), as the style element main.jsx adds after app.css. Its CSS is kept in localStorage, so the first frame has it and
// the background window (§7i), whose settings are a copy from its start, takes it from there and follows a change (storage
// event). [key, label, what it colours, tokens]
export const PALETTE = [
  ['background', 'Panels', 'Sidebar, status bar and dialogs', ['background']],
  ['card', 'Bars', 'Title bar, toolbar, islands, menus and cards', ['card', 'popover']],
  ['muted', 'Fills', 'Chips, tracks and secondary buttons', ['muted', 'secondary']],
  ['foreground', 'Text', 'Text and icons', ['foreground', 'card-foreground', 'popover-foreground', 'secondary-foreground', 'accent-foreground']],
  ['muted-foreground', 'Soft text', 'Labels, hints and shortcuts', ['muted-foreground']],
  ['primary', 'Buttons', 'Main buttons and ticked boxes', ['primary']],
  // The canvas (the editor's and flowcharts' area around the page) apart from the page itself: unset, it follows the page
  // theme (page.css --pg-bg); the palette's style element comes after app.css, so a pick wins at equal specificity.
  ['pg-bg', 'Canvas', 'The area around the page in the editor and flowcharts', ['pg-bg']],
];
export const PALETTE_KEY = 'daf-writer.palette';
const lightFill = (hex) => { // a fill that takes dark text
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
};

export function applyPalette(palette = {}) {
  const css = Object.entries({ ':root.dark': palette.dark, ':root:not(.dark)': palette.light }).map(([sel, p]) => {
    const vars = PALETTE.flatMap(([key, , , tokens]) => (p?.[key] ? tokens.map((t) => `--${t}:${p[key]}`) : []));
    if (p?.primary) vars.push(`--primary-foreground:${lightFill(p.primary) ? '#1f1f1f' : '#fafafa'}`);
    return vars.length ? `${sel}{${vars.join(';')}}` : '';
  }).join('');
  document.getElementById('palette').textContent = css;
  try { localStorage.setItem(PALETTE_KEY, css); } catch {} // the main window's only (applySettings)
}
addEventListener('storage', (e) => e.key === PALETTE_KEY && (document.getElementById('palette').textContent = e.newValue ?? ''));

function applySettings() {
  const s = state.settings;
  setKeybinds(s.keybinds); // §7k
  applyUiTheme();
  if (!WORKER) applyPalette(s.palette);
  applyMotion(s);
  const root = document.documentElement;
  root.style.setProperty('--base-font', s.baseFont ? `${cssFamily(s.baseFont)}, ${SYSTEM_FONT}` : SYSTEM_FONT);
  root.style.setProperty('--base-scale', String((s.baseSize || 100) / 100));
  applyPage();
}

/** The open draft's page (formats.mjs pageOf): its width, padding and format on the root (canvas.js reads the root's
 * --page-width) and on the page element (an assistant session's host sets its own, assistant/sessions.js), then the zoom, which
 * fits it. A Document's sheet takes its paper and margins from the live doc.attrs.sect (document.css --sheet-*). */
function applyPage() {
  const { format, width, padding, paper } = pageOf(state.draft, state.settings, sectNow());
  for (const el of [document.documentElement, $('#page-wrap .page')]) {
    if (!el) continue;
    el.style.setProperty('--page-width', `${width}px`);
    el.style.setProperty('--page-pad', `${padding}px`);
    for (const k of ['top', 'right', 'bottom', 'left']) el.style.setProperty(`--sheet-${k}`, paper ? `${paper[k]}px` : null);
    el.style.setProperty('--sheet-body', paper ? `${paper.h - paper.top - paper.bottom}px` : null);
    el.dataset.format = format;
  }
  applyPageTheme();
  applyZoom();
}

/** The root data-theme: the page theme (settings.theme), light while a Document's sheet is shown, since canvases, flowcharts
 * and plan charts read it and the paper is white (docs/plans/document.md Paper colour). A workspace page keeps the page theme:
 * the flowchart library's preset and new flowcharts follow it (flows.js). data-canvas-theme always holds the page theme, so the
 * area around the sheet keeps its colour (page.css --pg-bg). Canvases and plan charts read the theme when they draw: on a
 * change the open editor's are redrawn. Views call it after changing state.view. */
export function applyPageTheme() {
  const root = document.documentElement;
  const page = state.settings.theme === 'light' ? 'light' : 'dark';
  const theme = state.view.type === 'editor' ? drawTheme(state.draft, state.settings) : page;
  root.dataset.canvasTheme = page;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  for (const el of document.querySelectorAll('#editor :is(.sc, .pc)')) (el.scView ?? el.pcView)?.render();
}

/** The open editor's doc.attrs.sect (a Document's page setup, newer than the draft file's), or undefined. */
const sectNow = () => state.editor?.state.doc.attrs.sect ?? undefined;

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
  if (state.zoom === 'fit') {
    const { width, padding, paper } = pageOf(state.draft, state.settings, sectNow());
    zoom = Math.min(1, (area.clientWidth - viewLeft() - VIEW_RIGHT) / (paper?.w ?? width + 2 * padding));
  }
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

/** View > One page (`whole`) and Page width in a Document (docs/plans/document.md Ribbon View): the zoom at which the whole
 * sheet, or its width, fits the view, then the home view. Unlike fit it may go past 100%. */
export function fitSheet(whole) {
  const area = $('#editor-area');
  const { paper } = pageOf(state.draft, state.settings, sectNow());
  if (!paper) return;
  const across = (area.clientWidth - viewLeft() - VIEW_RIGHT) / paper.w;
  setZoom(100 * (whole ? Math.min(across, (area.clientHeight - 2 * VIEW_TOP) / paper.h) : across));
  homeView();
}

// Room the "home" view keeps clear on the left (the board rail) and right, and above the page.
const VIEW_LEFT = 56;
const VIEW_RIGHT = 24;
const VIEW_TOP = 24;
// A Document's left room: its tools island (Ribbon.jsx DocIsland, left-2 and w-60: 15.5rem of the root font size, app.css's
// compact density) and a 16 px gap (docs/plans/document.md step 10). It holds while a canvas is edited too (the narrower board
// rail then), so the sheet does not jump.
const viewDoc = () => 15.5 * parseFloat(getComputedStyle(document.documentElement).fontSize) + 16;
const viewLeft = () => (state.draft?.format === 'document' ? viewDoc() : VIEW_LEFT);

/** Home view: the page centred between the rail and the right edge, its top VIEW_TOP below the top of the view. A Document's
 * sheet wider than that room starts at its left end, so the island never covers the sheet's left edge. The place is marked at
 * once: opening a draft can show or hide the navigation pane in the same render, and that resize must keep this place. */
function homeView() {
  const area = $('#editor-area');
  const a = area.getBoundingClientRect();
  const p = $('#page-wrap').getBoundingClientRect();
  const left = viewLeft();
  const room = area.clientWidth - left - VIEW_RIGHT;
  area.scrollLeft += p.left - a.left - (left + (state.draft?.format === 'document' ? Math.max(0, room - p.width) : room - p.width) / 2);
  area.scrollTop += p.top - a.top - VIEW_TOP;
  place?.mark();
}

let place = null; // the editor area's keepPlace (bindStatic)

/** Hides or shows the sidebar (Ctrl+\); the editor area's keepPlace re-fits and places the page. */
export const toggleSidebar = () => saveSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed });

// ---------------------------------------------------------------------------------------------
// Toolbar

export function run(fn) {
  if (state.editor) fn(state.editor.chain().focus()).run();
}

/** Moves a node selection (e.g. a clicked canvas) to just after the node, so an insert does not replace it. */
export const afterNodeSel = (c) => c.command(({ tr }) => {
  if (tr.selection instanceof NodeSelection) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to)));
  return true;
});

/** Inserts a smart canvas after the selection and edits it in place. */
export function insertCanvas() {
  const ed = state.editor;
  if (!ed) return;
  // A Document's canvas starts at the text width (document.md App objects); a forum post keeps the 800 px default
  const attrs = formatOf(state.draft, state.settings)?.id === 'document' ? { dw: contentWidth(ed.view) } : undefined;
  afterNodeSel(ed.chain()).insertCanvas(attrs).run(); // not run(): focus() would pull focus back out of the canvas in a frame
  const $after = ed.state.doc.resolve(ed.state.selection.$from.before(1)); // insertBoard put the caret in the block after it
  openCanvasEditor(ed, $after.pos - $after.nodeBefore.nodeSize);
}

/** Board text edits reach the doc only when they end; commit an open one before saving or closing. Pending plan and
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

/** Applies font preset `index` (Alt+1..9, the toolbar, tool search): forum posts only, since presets are forum marks (gate
 * format.post). */
export function applyPresetAt(index) {
  const preset = state.settings.presets[index];
  if (!preset || !state.editor || !can('format.post', state.draft)) return;
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

// ---------------------------------------------------------------------------------------------
// Editor + autosave

const ISLAND_CLEARANCE = { top: 8, right: 8, bottom: 96, left: 8 };

let undoLog = null; // the open draft's undo steps, saved with it (§7e, history.js)

/** A TipTap editor on `doc` in `element` with the open draft's extensions and node views; with `historyFile` its undo history
 * rebuilt from it, keeping `keep` undo steps; `onUpdate` after each change. `draft`: the draft `doc` is from, for its page width.
 * → {editor, log (its undo steps, §7e)}. The open draft's (mountEditor) and the assistant's background sessions'
 * (assistant/sessions.js). */
export function makeEditor(element, doc, historyFile, keep, onUpdate, draft) {
  // Whiteboards become canvases before `new Editor`, which blanks a doc with an unknown node; the history file the same way and
  // at the same width, so its replay reaches the converted doc (§6b Converted whiteboards).
  const { width } = pageOf(draft, state.settings);
  doc = migrateBoards(doc, width);
  historyFile = migrateBoards(historyFile, width);
  const editor = new Editor({
    element,
    // The draft's format's own extensions (editors.js); 0 keeps no undo steps after closing, still 50 while open.
    extensions: [...kitOf(formatOf(draft, state.settings).id).extensions(state.settings.historyLimit || 50), PasteNotice],
    content: doc || '',
    // The toolbar island floats over the bottom of the editor area: keep the caret scrolled clear of it. data-doc-id names the
    // draft, so a copied list knows a reopened Document as the same one (document/lists.js; not data-draft, the sidebar rows').
    editorProps: { attributes: { spellcheck: 'true', ...(draft?.id && { 'data-doc-id': draft.id }) }, scrollMargin: ISLAND_CLEARANCE,
      scrollThreshold: ISLAND_CLEARANCE },
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
  applyPage(); // before the editor: node views measure the page
  const { editor: ed, log } = makeEditor($('#editor'), doc, historyFile, keep, () => {
    updateWordCount();
    if (!state.smoke) markDirty();
  }, state.draft);
  state.editor = ed;
  undoLog = log;
  clearRevLog(); // a new doc: the next rev, and no older one maps onto it (§8 Revisions)
  ed.on('transaction', ({ transaction, appendedTransactions }) => recordRev(transaction, appendedTransactions));
  // A Document's page setup changed (tr.setDocAttribute, undo too): the sheet follows.
  ed.on('transaction', ({ transaction }) => transaction.before.attrs.sect !== ed.state.doc.attrs.sect && applyPage());
  ed.on('transaction', ({ transaction }) => syncSuggestions(transaction));
  syncSuggestions();
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

export function markDirty() {
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
  // The title stays: it is set at creation and by a rename only (docs/plans/sidebar-menu.md decision 1).
  Object.assign(draft, { doc, formatVersion: formatOf(draft, state.settings).version });
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
    if (isNew && defaultTag(state.settings)) await setDraftTag(id, defaultTag(state.settings).id); // Settings > Tags, New drafts get
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
      Object.assign(draft, { doc, formatVersion: formatOf(draft, state.settings).version }); // the title stays, as in doSave
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

// `draft`: a draft (its marks read from its doc) or a summary entry (the background window's save, marks included).
function upsertDraftEntry(draft) {
  const entry = { id: draft.id, title: draft.title, threadUrl: draft.threadUrl, updated: draft.updated, pushedAt: draft.pushedAt,
    format: draft.format ?? null, ...(draft.doc ? draftMarks(draft.doc) : { suggestions: draft.suggestions ?? 0, flows: draft.flows ?? [] }) };
  setState({ drafts: [entry, ...state.drafts.filter((d) => d.id !== draft.id)].sort((a, b) => b.updated - a.updated) });
}

// A new draft of `format` holding `doc` (TipTap JSON in that format's schema; null: empty), not saved yet. createDraft saves it
// at once; it stays unsaved only in the plain smoke run and when createDraft's save fails (docs/plans/sidebar-menu.md decision 2).
function newDraft(doc = null, { format, focus = true } = {}) {
  // A Document starts with its own copy of the styles, theme, lists and page setup (docs/plans/document.md Document-level data).
  // Lists in `doc` (drafts.create content) get their own nums.
  if (format === 'document') doc = numberNewLists({ ...newDocumentJson(state.settings), ...doc });
  state.draft = { title: 'Untitled', threadUrl: state.settings.selectedThread || null, created: Date.now(), pushedAt: null,
    format, formatVersion: FORMATS[format].version, doc };
  state.lastSaved = null;
  mountEditor(doc);
  if (focus) state.editor.commands.focus();
}

/** A new draft of `format` holding `doc` (TipTap JSON; null: empty) titled `title` (cleanTitle; empty: the first line of `doc`,
 * else 'Untitled') in thread `threadUrl` (undefined: the selected thread), saved at once so it has an id (an empty one too),
 * then filed in `folderId` and tagged `tagId`; shown in the editor without taking the focus. Every new draft comes through here
 * (docs/plans/sidebar-menu.md decision 2). Resolves {draftId}; throws when it could not be saved. */
export async function createDraft({ title, threadUrl, folderId = null, tagId = null, doc = null, format } = {}) {
  if (!(await saveNow())) throw new Error('The open draft could not be saved');
  newDraft(doc, { format, focus: false });
  state.draft.title = cleanTitle(title || (doc ? draftTitle(doc) : ''));
  if (threadUrl !== undefined) state.draft.threadUrl = draftThreadUrl(threadUrl);
  markDirty();
  if (!(await saveNow()) || !state.draft.id) throw new Error('The new draft could not be saved');
  const draftId = state.draft.id;
  if (folderId) await moveDraft(draftId, folderId);
  if (tagId) await setDraftTag(draftId, tagId);
  return { draftId };
}

/** Opens the draft `id` and shows the editor page (§7g: from a workspace too); `show: false` keeps the page shown.
 * `remember: false` leaves settings.lastDraftId alone (agents: the draft the app reopens stays the user's choice). Resolves true
 * when it opened. */
export async function openDraft(id, { show = true, remember = true } = {}) {
  if (WORKER && id !== WORKER_DRAFT) return toast('This window works on one draft only.');
  flushPlans();
  flushFlows();
  if (!(await saveNow())) return false;
  // The background window of computer use saves and closes this draft first (§7i Background window): it is never open twice.
  if (!WORKER && state.worker?.draftId === id) await api.computer.close();
  // The assistant's background session of this draft hands over (§7i Background drafts): its document and undo steps after its
  // last command and save, not the disk copy. A missing or unreadable history file only means no undo history (§7e).
  const bg = await handOver(id);
  const [draft, historyFile] = bg ? [bg.draft, bg.history] : await Promise.all([api.drafts.load(id), api.drafts.loadHistory(id).catch(() => null)]);
  if (!draft) {
    toast('That draft could not be loaded.', true);
    setState({ drafts: await api.drafts.list() });
    return false;
  }
  // A format or format version this build does not know, or a doc its schema cannot read (editors.js loadable): its nodes or
  // attributes may be unknown here, and the editor would drop them and autosave the loss.
  if (!loadable(draft, state.settings)) {
    toast(NEWER_FORMAT, true);
    return false;
  }
  state.draft = draft;
  state.lastSaved = draft.updated;
  if (bg) mountEditor(bg.doc, historyFile, state.settings.historyLimit || 50); // the session's steps, also with 0 kept after closing
  else mountEditor(draft.doc, historyFile);
  if (show) await showPage('editor');
  if (remember) await saveSettings({ lastDraftId: id });
  return true;
}

/** The format a new draft without the New draft dialog takes (init, doDeleteDraft): as the dialog preselects. */
const fallbackFormat = () => defaultFormat(state.settings, state.settings.selectedThread, { last: true });

/** With nothing left to open (init, doDeleteDraft): a saved empty draft (docs/plans/sidebar-menu.md decision 2), focused as
 * newDraft focuses. The plain smoke run keeps it unsaved: it runs on the real profile. A failed save leaves the unsaved draft
 * in the editor, as a failed autosave does (doSave's toast explains). */
async function fallbackDraft() {
  if (SMOKE) return newDraft(null, { format: fallbackFormat() });
  await createDraft({ format: fallbackFormat() }).catch(() => {});
  state.editor?.commands.focus();
}

/** New draft (sidebar button, Ctrl+N, tool search, the sidebar menu's New draft here with `folderId`, null: the top level): the
 * New draft dialog with its title, folder and format, then a saved draft (createDraft). The folder preselected: `folderId`,
 * else the open draft's folder when the dialog lists it, else none. The picked format is the next dialog's (settings.lastFormat,
 * per device). Cancel or Esc creates nothing. A click handler's event has no folderId. */
export async function startNewDraft({ folderId } = {}) {
  if (WORKER) return toast('This window works on one draft only.');
  const folders = draftGroups().groups.map((g) => g.folder);
  const preset = folderId !== undefined ? folderId : state.settings.draftFolders?.[state.draft?.id];
  const picked = await openDialog('newDraft', { value: fallbackFormat(), folders, folderId: folders.some((f) => f.id === preset) ? preset : null });
  if (!picked) return;
  const { format, title } = picked;
  if (format !== state.settings.lastFormat) await saveSettings({ lastFormat: format });
  // createDraft saves the open draft first: an agent may have edited it while the dialog was up.
  try {
    await createDraft({ format, title, folderId: picked.folderId });
  } catch (e) {
    return toast(e.message, true);
  }
  await showPage('editor');
  state.editor.commands.focus(); // FormDialog gave the focus back before this editor existed; createDraft mounts it unfocused
}

// Writes a draft that may not be the open one: the open one through the editor and autosave, another by load → save.
// Resolves false when it could not be saved or loaded.
export async function updateDraft(id, patch) {
  if (state.draft?.id === id) {
    Object.assign(state.draft, patch);
    state.dirty = true;
    refresh();
    return saveNow();
  }
  Object.assign(backgroundDraft(id) ?? {}, patch); // an assistant background session's next save keeps the change
  // Loaded and saved in the save chain, after any save of that session in flight, so the write never puts back its older doc.
  const write = async () => {
    const draft = await api.drafts.load(id);
    if (!draft) return false;
    Object.assign(draft, patch, await api.drafts.save({ ...draft, ...patch }));
    upsertDraftEntry(draft);
    return true;
  };
  const done = saveChain.then(write, write);
  saveChain = done.catch(() => false); // a failed write rejects for the caller, not for the saves after it
  return done;
}

/** The draft `id` → its thread `url` (as draftThreadUrl; null: none), without a dialog. Another draft is rewritten, which bumps
 * its `updated` (it moves up the sidebar when the list follows it). */
export const setDraftThreadFor = (id, url) => updateDraft(id, { threadUrl: draftThreadUrl(url) });

/** Renames the draft `id` to cleanTitle(`title`) (docs/plans/sidebar-menu.md decision 1). Resolves false when it could not be
 * saved, and writes nothing while the background window of computer use holds the draft: that window saves the draft object it
 * loaded, so its next save would put the old title back. */
export async function renameDraft(id, title) {
  if (state.worker?.draftId === id) {
    toast('The background window has this draft open');
    return false;
  }
  return updateDraft(id, { title: cleanTitle(title) });
}

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
  setState({ drafts: state.drafts.filter((d) => d.id !== id), ...(state.draftClip?.id === id && { draftClip: null }) });
  if (!isCurrent) return;
  const next = visibleDrafts()[0];
  // A delete from a workspace page stays on it; a refused open (unknown format) falls back like init.
  if (!next || !(await openDraft(next.id, { show: false }))) await fallbackDraft();
}

// ---------------------------------------------------------------------------------------------
// Sidebar

/** A project's label: an integration's (the forum's names the thread's subject), else its title, else its key. */
export function threadLabel(t) {
  return first('projectLabel', t) ?? (t.title || t.url);
}

// A draft's project key for `url`: the listed project's, else an integration's (the forum maps a topic URL to the project that
// links it, '' for one it rejects), else for a key of no project (a forum thread added before projects) the listed key of the
// same topic (thread-url.mjs legacyTopic), else the key as it is; null for none or neither.
const draftThreadUrl = (url) => {
  if (!url) return null;
  const { threads } = state.settings;
  const topic = legacyTopic(url);
  return (threads.find((t) => t.url === url)?.url ?? first('resolveProject', url)
    ?? (topic ? threads.find((t) => legacyTopic(t.url) === topic)?.url ?? url : null)) || null;
};

/** A thread row (or All drafts): filters the drafts and shows the editor page (§7g). */
export async function selectThread(url) {
  await showPage('editor');
  await saveSettings({ selectedThread: url });
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

/** New project: an integration's own form (the forum's takes a thread too), else a name. */
export async function addThreadUrl() {
  if (await first('newProject')) return;
  const name = await openDialog('addThread', { validate: (v) => (v.trim() ? '' : 'Enter a name.') });
  if (name) await selectThread(await addProject(name));
}

/** Adds a project titled `title` (a settings.threads entry keyed project:<uuid>). Resolves its key. */
export async function addProject(title) {
  const url = `project:${crypto.randomUUID()}`;
  await saveSettings({ threads: [...state.settings.threads, { url, title: title.trim().slice(0, 200) }] });
  return url;
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

/** A copy of the draft `id` titled '<title> (copy)' (docs/plans/sidebar-menu.md decision 6), not opened: its file with a new id
 * and created (main's file family), pushedAt null and no history file, so its undo starts empty. The source's tag; placed just
 * after the source in its folder, or first in `folderId` when given (null: the top level). `threadUrl` given: the copy's
 * project. The open source and the assistant's background sessions save first, so the copy has their last edits. Resolves
 * {draftId}; throws when the source could not be saved, loaded or copied. */
export async function duplicateDraft(id, { folderId, threadUrl } = {}) {
  if (state.draft?.id === id) {
    commitBoardEdit(); // a canvas edited in place is not in the doc until then
    if (!(await saveNow())) throw new Error('The draft could not be saved');
  }
  await flushSessions();
  const source = await api.drafts.load(id);
  if (!source) throw new Error('That draft could not be loaded');
  // id null: main's save gives it a new id and created, and updated now.
  const copy = { ...source, id: null, title: copyTitle(source.title), pushedAt: null, ...(threadUrl !== undefined && { threadUrl }) };
  Object.assign(copy, await api.drafts.save(copy));
  upsertDraftEntry(copy); // placeDraft, moveDraft and pruneMap keep only drafts in state.drafts
  const tag = draftTag(state.settings, id);
  if (tag) await setDraftTag(copy.id, tag.id);
  if (folderId === undefined) await placeDraft(copy.id, id, true);
  else {
    await moveDraft(copy.id, folderId);
    await saveDraftOrder(); // a draft missing from the order goes first
  }
  return { draftId: copy.id };
}

/** The sidebar's draft clipboard (decision 5): Copy and Cut note the draft; the cut row shows faded until it is pasted. */
export const copyDraft = (id) => setState({ draftClip: { id, cut: false } });
export const cutDraft = (id) => setState({ draftClip: { id, cut: true } });

/** The project a pasted draft joins: the selected one when the draft is in another, else undefined (it keeps its own). */
const pasteProject = (d) => {
  const sel = state.settings.selectedThread;
  return sel && d.threadUrl !== sel ? sel : undefined;
};

/** Paste is possible: the clipped draft still exists, and a cut one whose project would change is not held by the background
 * window (its next save would put the old project back). */
export function canPaste() {
  const clip = state.draftClip;
  const d = clip && state.drafts.find((x) => x.id === clip.id);
  return !!d && !(clip.cut && state.worker?.draftId === d.id && pasteProject(d));
}

/** Pastes the clipped draft into `folderId` (null: the top level): a copy (duplicateDraft; the clipboard keeps the draft) or,
 * cut, the draft itself (the clipboard empties). With a project selected, a draft of another project joins it. */
export async function pasteDraft(folderId) {
  if (!canPaste()) return;
  const { id, cut } = state.draftClip;
  const threadUrl = pasteProject(state.drafts.find((d) => d.id === id));
  try {
    if (!cut) return await duplicateDraft(id, { folderId, threadUrl });
    setState({ draftClip: null });
    if (threadUrl && !(await setDraftThreadFor(id, threadUrl))) throw new Error('The draft could not be saved');
    await moveDraft(id, folderId);
  } catch (e) {
    toast(e.message, true);
  }
}

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
  if (!WORKER) each('onSettings', s, state.settings); // the background window never asks an integration
  // Canvas NodeViews read the theme when they render and the history depth is set when the editor is built: remount
  // the editor, its history rebuilt (all the steps the open draft keeps in memory), so they pick the change up.
  if (remount && state.editor && await saveNow()) {
    const keep = state.settings.historyLimit || 50;
    mountEditor(state.editor.getJSON(), history.encode(undoLog, keep), keep);
  }
}

// ---------------------------------------------------------------------------------------------
// Shortcuts and global events

const WINDOW_ZOOM = { 'app.zoomIn': 1, 'app.zoomOut': -1, 'app.zoomReset': 0 };
const PRESETS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `text.preset${n}`);
const SUGGEST_ACTIONS = { 'suggest.next': nextSuggestion, 'suggest.previous': previousSuggestion, 'suggest.accept': acceptActive, 'suggest.reject': rejectActive };
const SUGGEST_KEYS = Object.keys(SUGGEST_ACTIONS);
const go = (e, fn) => {
  e.preventDefault();
  fn();
};

// The app's own shortcuts (§7k keybinds: keyIs / keyAmong match the user's chords).
function onKeyDown(e) {
  // Window zoom, over dialogs too (Settings > General UI scale shows it): the main window has no menu, so no accelerators. In the
  // browser's pane or page the browser's own zoom keys zoom its tab instead (§7j browserKey).
  const zoom = keyAmong(Object.keys(WINDOW_ZOOM), e);
  if (zoom && !e.target.closest?.('[data-browser-pane], [data-browser-page]')) {
    return go(e, () => api.window.zoom(WINDOW_ZOOM[zoom]).then((settings) => setState({ settings }))); // saved as uiScale
  }
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
  } else if (keyIs('app.plans', e)) {
    go(e, () => e.repeat || showPage('plan')); // the plan workspace from anywhere (§7g); in it, nothing (no toggle)
  } else if (keyIs('app.browser', e)) {
    go(e, () => e.repeat || showPage('browser')); // the browser (§7j), as the Plans page
  } else if (keyIs('insert.flowchart', e) && can('view.editor', state)) {
    go(e, () => e.repeat || insertFlowchartDialog());
  } else if (canvasEditor.get()) {
    // A canvas being edited handles every other key itself: no document shortcuts.
  } else if (keyIs('app.newDraft', e)) {
    go(e, () => e.repeat || startNewDraft()); // from a workspace too, as the sidebar button
  } else if (!can('view.editor', state)) {
    // A workspace (§7g): no document shortcuts.
  } else if (state.suggestions.count && keyAmong(SUGGEST_KEYS, e) && !e.target.closest?.('input, textarea, select')) {
    // The open draft's waiting agent edits (docs/plans/suggestions.md Keys). An agent's keys never decide them (Open decision 11):
    // the background window's input is all an agent's, and the main window's is while a computer.act or press scope is open.
    go(e, agentInputOpen() || window.__worker ? () => {} : SUGGEST_ACTIONS[keyAmong(SUGGEST_KEYS, e)]);
  } else if (keyIs('text.link', e)) {
    go(e, openLinkDialog);
  } else if (keyIs('app.sidebar', e)) {
    go(e, toggleSidebar);
  } else if (keyIs('app.find', e)) {
    go(e, openFind);
  } else if (keyIs('app.replace', e)) {
    go(e, openReplace);
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

const readyToast = (version) => sonner(`Update ${version} downloaded`, {
  id: 'update', duration: Infinity, action: { label: 'Restart', onClick: installUpdate },
});
let downloading = null; // the version the update toast is downloading

/** Download and install on the update toast (settings.autoUpdate off): the toast shows the progress, then installUpdate
 * saves and installs. A failure shows in the toast and keeps the app open. */
async function downloadUpdate(version, click) {
  click.preventDefault(); // the toast stays to show the progress
  downloading = version;
  sonner.loading(`Downloading update ${version}`, { id: 'update', duration: Infinity, action: null });
  try {
    await api.update.download();
  } catch (e) {
    const why = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    sonner.error(`Update ${version} could not download. ${why}`, {
      id: 'update', duration: Infinity, action: { label: 'Try again', onClick: (e) => downloadUpdate(version, e) },
    });
    return;
  } finally {
    downloading = null;
  }
  readyToast(version); // stays when the save fails, so Restart can try again
  await installUpdate();
}

function onUpdateEvent({ type, version, percent }) {
  if (type === 'available' && !downloading) sonner(`Update ${version} available`, {
    id: 'update', duration: Infinity, action: { label: 'Download and install', onClick: (e) => downloadUpdate(version, e) },
  });
  if (type === 'progress' && downloading) sonner.loading(`Downloading update ${downloading} (${Math.round(percent)}%)`, { id: 'update', duration: Infinity, action: null });
  if (type === 'ready' && !downloading) readyToast(version);
}

// A click on the editor area's background (around the page or in its padding; §7 Background clicks) puts the caret at the
// nearest text position at the click's height, as a word processor's margin does: a node-selected block or a text selection
// gives way to it; nothing scrolls. Canvas Mode handles such a click first (§6b).
function marginClick(e) {
  const view = state.editor?.view;
  const area = e.currentTarget;
  const bg = (t) => t === area || t === area.firstElementChild || t.id === 'page-wrap' || t.id === 'editor' || t.classList.contains('page');
  if (!view || !backgroundClick(e, bg)) return;
  e.preventDefault(); // no focus change, no native selection
  const r = view.dom.getBoundingClientRect();
  const y = Math.min(Math.max(e.clientY, r.top + 1), r.bottom - 1);
  const hit = view.posAtCoords({ left: Math.min(Math.max(e.clientX, r.left + 1), r.right - 1), top: y });
  if (hit) {
    const { doc } = view.state;
    const node = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
    let [$pos, dir] = [doc.resolve(hit.pos), 1];
    if (node?.isBlock && node.isAtom) { // a canvas or chart: before or after it by the click's height
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
  // A resize of the editor area (the window, the sidebar, the navigation pane, the chat panel) keeps the page's gaps to the
  // home view's room in proportion, re-fitting the zoom first; a Document's sheet right of its island stays right of it.
  place = keepPlace($('#editor-area'), $('#page-wrap'), () => ({ left: viewLeft(), right: VIEW_RIGHT, top: VIEW_TOP, bottom: 0 }), () => applyZoom());
  // Middle-drag pans the editor area; Ctrl + wheel zooms the page around the pointer (also while a canvas is edited in place).
  bindPanZoom($('#editor-area'), $('#page-wrap'), setZoom, (pct) => setState({ zoomPct: Math.round(pct) }));
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
  setWindowEditor(() => state.editor); // agent presses on the main window reach the open draft's editor (suggest/extension.js)
  setState({ settings: await api.settings.get() });
  bindStatic();
  applySettings();
  if (!WORKER) each('init'); // the background window never asks an integration
  setState({ drafts: await api.drafts.list() });
  await saveDraftOrder(); // the first time: the drafts keep their `updated` order
  await initPlans();
  await initFlows();
  if (WORKER) return startWorker();
  initBrowser();
  watchWorker();
  api.update.onEvent(onUpdateEvent);
  if (!state.settings.demoSeeded && !SMOKE) { // the first start: the demo draft, once (samples/demo.js)
    // A forum post, since the demo uses the forum marks. Saved; lastDraftId opens it below.
    if (!state.drafts.length) await createDraft({ threadUrl: null, doc: demoDoc(), format: 'forum-post' }).catch(() => {});
    await saveSettings({ demoSeeded: true }).catch(() => {}); // deleting it later does not bring it back; a profile with drafts never gets it
  }
  const { lastDraftId } = state.settings;
  const id = state.drafts.some((d) => d.id === lastDraftId) ? lastDraftId : state.drafts[0]?.id;
  if (!id || !(await openDraft(id))) await fallbackDraft();
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
  // setCall: the agent call each computer.act here belongs to, so its edits wait as that call's suggestions (null: none).
  window.__worker = { draftId: state.draft?.id ?? null, release: () => { commitBoardEdit(); return saveNow(); }, setCall: setWorkerCall, callIds: workerIds };
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
        text('link', [{ type: 'link', attrs: { href: 'https://example.com/' } }]), text('.')),
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
  // On a throwaway forum post: a Document (the restored or fallback draft) has none of the sample's nodes, which blanks it.
  newDraft(null, { format: 'forum-post', focus: false });
  state.editor.commands.setContent(migrateBoards(sampleDoc(), pageOf(null, state.settings).width)); // its whiteboard: the converter's end-to-end check
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const payload = await UI.forum.actions.buildPayload(state.editor, state.settings, state.draft); // waits for the synced canvases' library records
  const badge = document.querySelector('.sc-flow-missing'); // the sample's synced canvas without a record (samples/flow.js)
  if (badge) { // in view for smoke-ui.png (scrolled by hand: the page's CSS zoom misleads scrollIntoView)
    const area = $('#editor-area');
    area.scrollTop += badge.getBoundingClientRect().top - area.getBoundingClientRect().top - area.clientHeight / 2;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); // painted before the capture
  }
  return { ...payload, text: state.editor.getText().slice(0, 200), flows: { missingBadge: !!badge } };
};

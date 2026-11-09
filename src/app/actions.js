import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Frame } from 'lucide-react';
import { createElement as h } from 'react';
import { toast as sonner } from 'sonner';
import { canvasEditor, openCanvasEditor } from '../canvas.js';
import { blankBoard } from '../board/store.mjs';
import { applyPreset } from '../extensions.js';
import { kitOf, loadable, setModuleExtensions } from '../editors.js';
import { cleanTitle, copyTitle } from '../doc-utils.mjs';
import { draftMarks } from '../draft-marks.js';
import { draftTitle, wordCount } from '../export.js';
import { newDocumentJson } from '../document/defaults.mjs';
import { dropOrphanComments } from '../document/model/review.mjs';
import { geometryOf, paginationKey } from '../document/geometry.js';
import { stageCache } from '../document/layout-cache.mjs';
import { layoutCacheOf } from '../document/pagination.js';
import { runWordKey, wordKeyWins } from '../document/word/keys.js';
import { EXTENSIONS as MODULE_EXTENSIONS, setupModules } from '../document/wp/index.js';
import { preloadRatios } from '../document/wp/paragraph/extension.js';
import { numberNewLists } from '../document/numbering.mjs';
import { listFonts } from '../document/fonts.js';
import { saveOnce } from '../engine/model/autosave.mjs';
import { adopt, isCanvas, recordText } from '../engine/model/form.mjs';
import { defaultFormat, drawTheme, formatOf, formatVersionOf, pageOf } from '../formats.mjs';
import { each, first, UI } from '../integrations/ui.js';
import { legacyTopic } from '../thread-url.mjs';
import { commandOf, run as runCommand, targetEditor } from '../tooling/registry.js';
import { activeSurface, areaOpens, boardOpens } from '../tooling/surface.js';
import { edited, entries, groups as groupsOf, items as suggestionItems, META as SUGGEST_META } from '../suggest/core.mjs';
import { activeOf, agentInputOpen, logDecisions, resolve as resolveChanges, setActive, setWindowEditor, setWorkerCall, workerIds } from '../suggest/extension.js';
import { activeCard, caretOf, cardsNow, decideCards, freshCards, onEngine, setActiveCard, showCard, watchCards } from '../suggest/canvas.js';
import { cardOf, cmpPos, stepFrom } from '../suggest/cards.mjs';
import { activeBoard, boardBeforeCaret, finishBoardEdits, migrateBoards } from '../whiteboard.js';
import { captureSelectionNow } from './assistant/capture.js';
import { backgroundDraft, dropSession, flushSessions, handOver } from './assistant/sessions.js';
import { installAgent } from './commands.js';
import { scrollToBlock } from './commands/ui.mjs';
import { openFind, openReplace } from './components/FindBar.jsx';
import { notify, PasteNotice } from './components/Notices.jsx';
import { endOpening, failOpening, painted, startOpening, stepOpening } from './components/OpenProgress.jsx';
import { dropDraft, moveBeside, sortDrafts } from './draft-order.mjs';
import { defaultTag, draftTag, pruneMap, tagDraft } from './drafts-meta.js';
import { initBrowser } from './browser.js';
import { keyAmong, keyIs, setKeybinds } from './keybinds.js';
import { keybindsKey } from './keys.mjs';
import { flushFlows, initFlows, insertFlowchartDialog } from './flows.js';
import { can } from './gates.mjs';
import * as history from './history.js';
import { setLiveZoom } from './livezoom.js';
import { bindPanZoom, keepPlace, zoomAround } from './panzoom.js';
import { flushPlans, initPlans } from './plans.js';
import { clearRevLog, recordRev } from './rev.js';
import { cell, para, sampleImage, text } from './samples/demo.js';
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

let dialogCount = 0;

/** The open dialogs, last on top (docs/plans/word/plan.md §1.6 Dialog stack): state.dialogs, plus an entry plans.js, flows.js or
 * prefabs.js put straight into state.dialog. state.dialog is always the top one, so its readers keep working. */
export function dialogStack() {
  const list = state.dialogs ?? [];
  return state.dialog && !list.includes(state.dialog) ? [...list, state.dialog] : list;
}

/** Opens a form dialog (DialogHost renders it by type), over any open one, which stays mounted with its state. Resolves with its
 * result, or null on Cancel/Escape. Opening the dialog already on top again replaces it (cancelled), as before the stack, so a
 * second Ctrl+, never shows two Settings. */
export function openDialog(type, props = {}) {
  return new Promise((resolve) => {
    // Where the focus goes back on close: `board` when it was on a board or its chrome (WordDialog then carries the chrome mark,
    // so a text edit stays open), else the element that had it.
    const focus = document.activeElement;
    const b = activeBoard.get();
    const board = b && (b.owns(focus) || !!focus?.closest?.('[data-board-chrome]')) ? b : null;
    const entry = { type, props, resolve, n: ++dialogCount, focus, board };
    const below = [...dialogStack()];
    const same = below.at(-1)?.type === type ? below.pop() : null;
    if (same) Object.assign(entry, { focus: same.focus, board: same.board });
    setState({ dialogs: [...below, entry], dialog: entry });
    same?.resolve?.(null);
  });
}

/** Closes dialog `entry` with `result`: the dialog under it (if any) is on top again and gets the focus back where it was. */
export function closeDialog(entry, result) {
  const dialogs = dialogStack().filter((d) => d !== entry);
  setState({ dialogs, dialog: dialogs.at(-1) ?? null });
  entry.resolve(result);
  // After Radix's own focus return (refocusEditor declines while a dialog is open): the control that opened the closed dialog, else
  // the dialog now on top, so its keys (Enter, Esc, access keys) work again.
  if (dialogs.length) setTimeout(() => (entry.focus?.isConnected ? entry.focus : [...document.querySelectorAll('[role="dialog"]')].at(-1))?.focus());
  else closedDialog = entry; // the last one: its onCloseAutoFocus (refocusEditor) gives the focus back where it opened
}

let closedDialog = null;

/** The focus back where dialog `entry` opened: its board (a text edit gets its caret back), else the element that had the focus
 * while it is still there, else the editor. Not when something else took the focus meanwhile (a new draft's editor). */
function focusOpener(entry) {
  const a = document.activeElement;
  if (a && a !== document.body) return;
  if (entry.board && !entry.board.destroyed) entry.board.focus();
  else if (entry.focus?.isConnected && entry.focus !== document.body) entry.focus.focus({ preventScroll: true });
  else focusMain();
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
// Suggestions (docs/wiki/suggestions.md Accept, reject and undo)

/** Accepts or rejects (`action`) the suggestions `sel` picks ({ids} | {group} | {all: true}) in `editor` (draft `draftId`), as
 * `by` (a source). Every accept and reject path comes here: rejecting a change the user edited asks first. → the ids resolved,
 * or null when the user kept them. */
export async function resolveSuggestions(editor, draftId, sel, action, { by = 'ui' } = {}) {
  if (!editor || editor.isDestroyed) return null;
  const doc = editor.state.doc;
  const pick = (e) => sel?.all || (sel?.group ? e.g === sel.group : sel?.ids?.includes(e.id));
  const changes = entries(doc).filter(pick);
  // A place of a change decided place by place (core.places): its id is `<change>-<n>` (the cards, the keys, Next and Previous).
  const places = sel?.ids ? suggestionItems(doc, editor.schema).filter((it) => it.place && sel.ids.includes(it.id)) : [];
  if (!changes.length && !places.length) return [];
  if (action === 'reject' && [...changes, ...places.map((it) => it.e)].some((e) => edited(doc, e.id)) && !(await confirmDialog({
    title: changes.length + places.length > 1 ? 'Reject these suggestions?' : 'Reject this suggestion?',
    description: 'You edited this suggestion. Rejecting it also removes your edits.',
    confirmText: 'Reject',
    destructive: true,
  }))) return null;
  if (editor.isDestroyed) return null;
  if (places.length) return resolveChanges(editor, { places: places.map((it) => it.id) }, action, { by, draftId });
  return resolveChanges(editor, { ids: changes.map((e) => e.id) }, action, { by, draftId });
}

const NO_SUGGESTIONS = { groups: [], count: 0, active: null };
let syncedDoc = null;

/** resolveSuggestions on draft `draftId` whose suggestions are the engine's (src/suggest/canvas.js onEngine): `sel` picks its cards
 * ({ids}: a card's id or one of its revisions', {group} or {all: true}). Rejecting a card the user edited asks first, as above,
 * unless `confirm` is false (an agent's call asked on its own card); each decision goes to the same log. → the card ids resolved
 * ([] when the engine refused), or null when the user kept them. */
export async function resolveCanvasSuggestions(draftId, sel, action, { by = 'ui', confirm = true } = {}) {
  const cards = await freshCards(draftId);
  const picked = sel?.all ? cards : sel?.group ? cards.filter((c) => c.g === sel.group)
    : [...new Set((sel?.ids ?? []).map((id) => cardOf(cards, id)).filter(Boolean))];
  if (!picked.length) return [];
  if (confirm && action === 'reject' && picked.some((c) => c.edited) && !(await confirmDialog({
    title: picked.length > 1 ? 'Reject these suggestions?' : 'Reject this suggestion?',
    description: 'You edited this suggestion. Rejecting it also removes your edits.',
    confirmText: 'Reject',
    destructive: true,
  }))) return null;
  if (!(await decideCards(draftId, picked, action))) return [];
  // Logged by revision ids too ('r' and the number: a replace card has two), which an agent's call reports as its changes.
  logDecisions(picked.map((c) => ({ ...c, ids: c.revs.map((r) => `r${r}`) })), action, { by, draftId });
  return picked.map((c) => c.id);
}

/** The engine's cards for the suggestions.* commands, which take them through ctx.actions (commands/suggestions.mjs). */
export const engineSuggestions = { onEngine, freshCards, activeCard, caretOf, showCard };

const CANVAS_NONE = { groups: [], count: 0, active: null, cards: [], canvas: true };
let watched = null; // {id, off}: the draft whose engine cards state.suggestions mirrors

/** Mirrors the open draft's engine cards (src/suggest/canvas.js) into state.suggestions: {groups: [] (the DOM editor's), count,
 * active, cards, canvas: true}. */
function syncCanvas() {
  const { id } = state.draft;
  if (!id) { // a Word file's new draft before its first save: no session yet
    watched?.off();
    watched = null;
    if (!state.suggestions.canvas || state.suggestions.count) setState({ suggestions: CANVAS_NONE });
    return;
  }
  if (watched?.id !== id) {
    watched?.off();
    watched = { id, off: watchCards(id, () => state.draft?.id === id && syncSuggestions()) };
  }
  const cards = cardsNow(id);
  const active = activeCard(id);
  const s = state.suggestions;
  if (s.canvas && s.cards === cards && s.active === active) return;
  setState({ suggestions: cards.length ? { groups: [], count: cards.length, active, cards, canvas: true } : CANVAS_NONE });
}

/** The decision in `list` (core.items) at position `pos`: a place whose words hold it (ends included, a deletion at its point),
 * else a change decided whole whose blocks hold it (a deletion has no text to hold the caret). A block's end is strict: it is the
 * next block's start, where a node selection or gap cursor on that next block sits. */
export const itemAt = (list, pos) => list.find(({ e, place }) => (place ? place.from <= pos && pos <= place.to
  : e.nodes.some((n, k) => e.starts[k] <= pos && pos < e.starts[k] + n.nodeSize)));

/** Mirrors the open editor's waiting changes into state.suggestions (the cards, the status bar slot, the sidebar badge, tool
 * search) after a transaction `tr` that changes the doc or the selection or carries the extension's meta; no `tr`: a new editor.
 * The active change is the one under the caret when the caret moved there, else the last shown. */
export function syncSuggestions(tr) {
  const ed = state.editor;
  if (tr && !tr.docChanged && !tr.selectionSet && tr.getMeta(SUGGEST_META) == null) return;
  // The engine holds a canvas draft's suggestions as the assistant's tracked changes (the hidden editor holds none).
  if (onEngine(state.draft)) return syncCanvas();
  watched?.off();
  watched = null;
  if (!ed || ed.isDestroyed || isCanvas(state.draft)) {
    syncedDoc = null;
    if (state.suggestions.count) setState({ suggestions: NO_SUGGESTIONS });
    return;
  }
  const { doc, selection } = ed.state;
  const list = suggestionItems(doc, ed.schema);
  if (!list.length) {
    syncedDoc = doc;
    if (state.suggestions !== NO_SUGGESTIONS) setState({ suggestions: NO_SUGGESTIONS });
    return;
  }
  let active = activeOf(ed.state);
  const under = !tr || tr.selectionSet ? itemAt(list, selection.from) : null;
  if (under && under.id !== active) {
    const { id } = under;
    active = id; // the decorations follow in a transaction of their own, after this one
    queueMicrotask(() => !ed.isDestroyed && activeOf(ed.state) !== id && suggestionItems(ed.state.doc, ed.schema).some((it) => it.id === id) && setActive(ed, id));
  }
  if (!list.some((e) => e.id === active)) active = null;
  const s = state.suggestions;
  const same = doc === syncedDoc;
  if (same && active === s.active) return;
  syncedDoc = doc;
  setState({ suggestions: { groups: same ? s.groups : groupsOf(doc), count: list.length, active } });
}

/** Makes decision `id` of the open draft (a change, or a place of one: core.items) the active one and centres it in the page's
 * viewport (a card, Next, Previous, an agent's suggestions.show). A change decided place by place shows its first place. */
export function showSuggestion(id) {
  if (onEngine(state.draft)) {
    const c = cardOf(cardsNow(state.draft.id), id);
    if (c) showCard(state.draft.id, c);
    return !!c;
  }
  const ed = state.editor;
  const list = ed ? suggestionItems(ed.state.doc, ed.schema) : [];
  const it = list.find((x) => x.id === id) ?? list.find((x) => x.e.id === id);
  if (!it) return false;
  const { e, place } = it;
  setActive(ed, it.id);
  let pos = place ? e.starts[place.k] : e.starts[0] ?? e.from;
  if (e.kind === 'attr') pos = 0;
  else if (e.kind === 'delete' && e.side === 'after') pos = e.from - (ed.state.doc.resolve(e.from).nodeBefore?.nodeSize ?? 0);
  scrollToBlock(ed, Math.min(pos, Math.max(0, ed.state.doc.content.size - 1)));
  return true;
}

// Where decision `it` (core.items) sits in the doc: a place's words, else its change's.
const itemFrom = (it) => (it.place ? it.place.from : it.e.from);

/** Moves to the next (`dir` 1) or previous (-1) decision in document order, wrapping; from the caret when none is active. */
function stepSuggestion(dir) {
  if (onEngine(state.draft)) {
    // A canvas draft's cards, not every reviewer's changes (review.nextChange walks those).
    const id = state.draft.id;
    if (!cardsNow(id).length) return false;
    const go = (head) => {
      const c = stepFrom(cardsNow(id), activeCard(id), head, dir);
      return !!c && showSuggestion(c.id);
    };
    return activeCard(id) ? go(null) : caretOf(id).then(go);
  }
  const ed = state.editor;
  const list = ed ? suggestionItems(ed.state.doc, ed.schema) : [];
  if (!list.length) return false;
  let i = list.findIndex((it) => it.id === state.suggestions.active);
  if (i < 0) {
    const at = ed.state.selection.from;
    i = dir > 0 ? list.findIndex((it) => it.e.kind !== 'attr' && itemFrom(it) >= at) : list.findLastIndex((it) => it.e.kind === 'attr' || itemFrom(it) < at);
    if (i < 0) i = dir > 0 ? 0 : list.length - 1;
  } else i = (i + dir + list.length) % list.length;
  return showSuggestion(list[i].id);
}
export const nextSuggestion = () => stepSuggestion(1);
export const previousSuggestion = () => stepSuggestion(-1);

/** Accepts or rejects the changes `sel` picks in the open draft (resolveSuggestions); when the active change went, the first change
 * left after it becomes active. */
async function review(sel, action) {
  if (onEngine(state.draft)) return reviewCanvas(sel, action);
  const ed = state.editor;
  if (!ed) return null;
  // Places renumber once one is decided (`<change>-<n>`), so the next active one is found by where it sits.
  const before = suggestionItems(ed.state.doc, ed.schema);
  const at = before.findIndex((it) => it.id === state.suggestions.active);
  const done = await resolveSuggestions(ed, state.draft?.id ?? null, sel, action);
  if (!done?.length || ed.isDestroyed || at < 0) return done;
  const now = suggestionItems(ed.state.doc, ed.schema);
  if (now.some((it) => it.id === before[at].id && itemFrom(it) === itemFrom(before[at]))) return done;
  const from = itemFrom(before[at]);
  setActive(ed, now.find((it) => it.e.kind !== 'attr' && itemFrom(it) >= from)?.id ?? null);
  return done;
}
/** review() on the open canvas draft: its cards through the engine; when the active card went, the first card left from where it
 * was becomes active. */
async function reviewCanvas(sel, action) {
  const id = state.draft.id;
  const was = cardsNow(id).find((c) => c.id === activeCard(id));
  const done = await resolveCanvasSuggestions(id, sel, action);
  if (!done?.length || !was || state.draft?.id !== id) return done;
  const now = cardsNow(id);
  if (!now.some((c) => c.id === was.id)) setActiveCard(id, now.find((c) => cmpPos(c.start, was.start) >= 0)?.id ?? null);
  return done;
}
const activeGroup = () => {
  if (onEngine(state.draft)) return cardsNow(state.draft.id).find((c) => c.id === state.suggestions.active)?.g;
  const ed = state.editor;
  return ed && suggestionItems(ed.state.doc, ed.schema).find((it) => it.id === state.suggestions.active)?.e.g;
};
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
  const t = state.settings.uiTheme ?? 'system';
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
  // The canvas (the editor's and flowcharts' area around the page) apart from the page itself: unset, it is a step off the
  // panels (page.css --pg-bg); the palette's style element comes after app.css, so a pick wins at equal specificity.
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
  setKeybinds(s[keybindsKey()]); // §7k
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
 * the flowchart library's preset and new flowcharts follow it (flows.js). Canvases and plan charts read the theme when they draw: on a
 * change the open editor's are redrawn. Views call it after changing state.view. */
export function applyPageTheme() {
  const root = document.documentElement;
  const page = state.settings.theme === 'light' ? 'light' : 'dark';
  const theme = state.view.type === 'editor' ? drawTheme(state.draft, state.settings) : page;
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
  // A board's app zoom is its camera's (src/board/BoardArea.jsx), not the hidden DOM page under it.
  if (boardCamera) {
    if (state.zoom === 'fit') boardCamera.fit();
    else boardCamera.setCamera({ zoom: state.zoom / 100 });
    if (state.zoom !== 'fit' && state.zoomPct !== Math.round(state.zoom)) setState({ zoomPct: Math.round(state.zoom) });
    return;
  }
  const area = $('#editor-area');
  // A Document zooms about its pages' centre line across (they stay centred), at the view's middle down.
  if (!anchor && area.hasAttribute('data-word-view')) {
    const [v, r] = [area.getBoundingClientRect(), $('#page-wrap').getBoundingClientRect()];
    anchor = { x: r.left + r.width / 2 - v.left, y: area.clientHeight / 2 };
  }
  let zoom = state.zoom / 100;
  if (state.zoom === 'fit') {
    const { width, padding } = pageOf(state.draft, state.settings, sectNow());
    zoom = Math.min(1, (area.clientWidth - VIEW_LEFT - VIEW_RIGHT) / (paperNow()?.w ?? width + 2 * padding));
  }
  zoom = Math.max(0.1, zoom);
  zoomAround(area, $('#page-wrap'), zoom, anchor);
  // Only a new zoom: every resize of the area runs this, and each setState re-renders every Word control (registry ctxOf).
  if (state.zoomPct !== Math.round(zoom * 100)) setState({ zoomPct: Math.round(zoom * 100) });
}

let boardCamera = null; // the open board's {setCamera(camera), fit()}

/** While a board is open, the status bar's zoom shows and drives its camera (src/board/BoardArea.jsx) → a function that ends
 * it and puts the app's zoom back, so the next draft opens at the one it had. */
export function attachBoardCamera(view) {
  boardCamera = view;
  const was = state.zoom;
  return () => {
    if (boardCamera !== view) return;
    boardCamera = null;
    if (state.zoom !== was) setState({ zoom: was });
  };
}

let zoomer = null; // bindPanZoom's {preview, settle} for the editor area

/** The zoom slider moved: shows the page at `pct` percent by a transform (no layout), about the page's centre line in a
 * Document, until settleZoom or a short pause applies it. */
export const previewZoom = (pct) => zoomer?.preview(pct);
/** The zoom slider let go: applies the previewed zoom now. */
export const settleZoom = () => zoomer?.settle();

/** 'fit' or a percent (clamped to 10…500, Word's range, or 2…800 on a board: kept to 0.01 so wheel zoom can move in small
 * steps; the UI shows whole percents). `anchor` as for applyZoom. Fit also brings the page home, or fits a board's items. */
export function setZoom(value, anchor) {
  const [lo, hi] = boardCamera ? [2, 800] : [10, 500];
  setState({ zoom: value === 'fit' ? value : Math.min(hi, Math.max(lo, Math.round(value * 100) / 100)) });
  applyZoom(anchor);
  if (value === 'fit' && !boardCamera) homeView();
}

/** View > One page (`whole`) and Page width in a Document (docs/plans/document.md Ribbon View): the zoom at which the whole
 * sheet, or its width, fits the view, then the home view. Unlike fit it may go past 100%. */
export function fitSheet(whole) {
  const area = $('#editor-area');
  const paper = paperNow();
  if (!paper) return;
  const across = (area.clientWidth - VIEW_LEFT - VIEW_RIGHT) / paper.w;
  setZoom(100 * (whole ? Math.min(across, (area.clientHeight - 2 * VIEW_TOP) / paper.h) : across));
  homeView();
}

/** The paper the zoom fits, in px: the section's, or the widest page's while page-engine (geometry engine 2) lays out pages of
 * several sizes (plan.md §1.9). Undefined for a draft without paper (a forum post). */
function paperNow() {
  const { paper } = pageOf(state.draft, state.settings, sectNow());
  const geo = paper && state.editor && geometryOf(state.editor.state);
  if (geo?.engine !== 2 || !geo.pages.length) return paper;
  return geo.pages.reduce((w, p) => (p.box.w > w.w ? { w: p.box.w, h: p.box.h } : w), { w: 0, h: 0 });
}

// Room the "home" view keeps clear on the left (the board rail) and right, and above the page. A Document keeps the same: its
// ribbon sits above the editor area, not beside it (docs/plans/word/plan.md §2.6).
const VIEW_LEFT = 56;
const VIEW_RIGHT = 24;
const VIEW_TOP = 24;

/** Home view: the page centred between the rail and the right edge, its top VIEW_TOP below the top of the view. A Document's
 * sheet wider than that room starts at its left end, as Word's does. The place is marked at once: opening a draft can show or
 * hide the navigation pane in the same render, and that resize must keep this place. */
function homeView() {
  const area = $('#editor-area');
  const a = area.getBoundingClientRect();
  const p = $('#page-wrap').getBoundingClientRect();
  const room = area.clientWidth - VIEW_LEFT - VIEW_RIGHT;
  area.scrollLeft += p.left - a.left - (VIEW_LEFT + (state.draft?.format === 'document' ? Math.max(0, room - p.width) : room - p.width) / 2);
  area.scrollTop += p.top - a.top - VIEW_TOP;
  place?.mark();
}

let place = null; // the editor area's keepPlace (bindStatic)

/** Hides or shows the sidebar (Ctrl+\); the editor area's keepPlace re-fits and places the page. */
// Under this window width the sidebar's 290 px would leave the main column less than 700 px: the sidebar minimizes to its rail by
// itself and its button shows it over the column instead (state.sidebarPeek), leaving settings.sidebarCollapsed as the user set it.
export const NARROW = '(max-width: 989px)';
export const toggleSidebar = () => (matchMedia(NARROW).matches ? setState({ sidebarPeek: !state.sidebarPeek })
  : saveSettings({ sidebarCollapsed: !state.settings.sidebarCollapsed }));

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

/** Inserts a smart canvas (at the text width, canvas.js) after the selection and edits it in place; `{edit: false}` (the tutorial)
 * leaves it closed. */
export function insertCanvas(opts) {
  const ed = state.editor;
  if (!ed) return;
  afterNodeSel(ed.chain()).insertCanvas().run(); // not focus().run(): focus() would pull focus back out of the canvas in a frame
  if (opts?.edit === false) return;
  openCanvasEditor(ed, boardBeforeCaret(ed.state)); // insertBoard put the caret in the block after it
}

/** Board text edits reach the doc only when they end; commit an open one before saving or closing. Pending plan and
 * library flowchart writes go out with it. */
export function commitBoardEdit() {
  finishBoardEdits(); // the edited board keeps the focus, so a canvas being edited keeps its keys
  flushPlans();
  flushFlows();
}

/** While the canvas page area shows the open draft (surface.js areaOpens), the focus goes to its root, never to the hidden DOM
 * editor under it → whether it does. */
export function focusArea() {
  // A whiteboard's board takes the focus, never the hidden DOM editor under it, which is empty and uneditable (makeEditor).
  if (boardOpens(state)) {
    $('[data-board-slot]')?.focus({ preventScroll: true });
    return true;
  }
  if (!areaOpens(state)) return false;
  $('[data-canvas-pages]')?.focus({ preventScroll: true }); // none yet: the page area takes the focus when it mounts
  return true;
}

/** Focus to the editor commands act on (the registry's target: a header or footnote being edited, else the open draft's editor, or
 * the canvas page area), which restores its selection; while a workspace is open (§7g), to its active board, else to the workspace. */
function focusMain() {
  if (can('view.editor', state)) focusArea() || (targetEditor() ?? state.editor)?.view.focus();
  else (activeBoard.get() ?? $('#workspace-root'))?.focus();
}

/** onCloseAutoFocus of toolbar menus, selects, popovers and dialogs: focus goes back to the editor, which restores its
 * selection (unless the menu item just opened a dialog, e.g. "Manage presets…"); a dialog's goes back where it opened. */
export function refocusEditor(e) {
  e?.preventDefault();
  if (dialogStack().length || state.confirm) return; // a dialog under a closed one takes the focus back (closeDialog)
  // Only a closed dialog's own content takes its opener back; a menu or popover (Radix gives popovers role=dialog) never does.
  const closed = e?.target?.closest?.('[data-word-dialog], [data-slot=dialog-content]') ? closedDialog : null;
  if (!closed) return focusMain();
  closedDialog = null;
  focusOpener(closed);
}

/** A typed address as a link: trimmed, and https:// added when it has no scheme; '' stays '' (no link). */
const address = (value) => {
  const href = String(value ?? '').trim();
  return href && !/^[a-z][a-z0-9+.-]*:/i.test(href) ? `https://${href}` : href;
};

export async function openLinkDialog() {
  const surf = activeSurface();
  // A post in the canvas page area: the value goes to the engine's hyperlink command (insert.link, as rows/references.mjs runs it).
  // A canvas Document keeps Word's Insert Hyperlink below.
  if (surf?.kind === 'text' && !surf.editor) {
    if (!surf.session) return; // the page area has not opened the draft yet
    const now = await surf.session.query('post.context', {});
    const value = await openDialog('link', { href: now?.value?.link ?? '' });
    if (value == null) return;
    const url = address(value);
    if (url) await surf.session.exec('insert.link', { url });
    else await surf.session.exec('insert.removeLink', {});
    return;
  }
  const ed = state.editor;
  if (!ed) return;
  // In a Document, Word's Insert Hyperlink dialog (fields-ref) replaces this one; Word's commands serve only the Document surface,
  // so commandOf is null elsewhere (a forum post's profile grants `insert.` but not Word's ids).
  if (commandOf('insert.links.link.insertLink')) return void runCommand('insert.links.link.insertLink');
  const value = await openDialog('link', { href: ed.getAttributes('link').href || '' });
  if (value == null) return;
  const href = address(value);
  if (!href) {
    run((c) => c.extendMarkRange('link').unsetLink());
    return;
  }
  if (ed.state.selection.empty && !ed.isActive('link')) {
    run((c) => c.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }));
  } else {
    run((c) => c.extendMarkRange('link').setLink({ href }));
  }
}

/** Applies font preset `index` (Alt+1..9, the toolbar, tool search): forum posts only, since presets are forum marks (gate
 * format.post). A post in the canvas page area runs them as post.mark steps through the engine (rows/post.mjs text.preset). */
export function applyPresetAt(index) {
  const preset = state.settings.presets[index];
  if (!preset || !can('format.post', state.draft)) return;
  const surf = activeSurface();
  if (surf?.kind === 'text' && !surf.editor) {
    if (surf.session) runCommand('text.preset', index);
    return;
  }
  if (!state.editor) return;
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
    attach = captureSelectionNow();
  } catch (e) {
    console.warn('No selection attachment:', e); // the palette opens anyway
  }
  const ctx = { board, focus: document.activeElement, at, attach: typeof attach?.then === 'function' ? null : attach };
  setState({ toolSearch: ctx });
  // A canvas draft's selection comes from the engine a moment later: it joins the search still open.
  if (attach !== ctx.attach) attach.then((a) => state.toolSearch === ctx && setState({ toolSearch: { ...ctx, attach: a } }), () => {});
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

// Every Document editor (main, story and session) carries the work packages' extensions; read when one is built (editors.js).
setModuleExtensions(() => MODULE_EXTENSIONS);

let undoLog = null; // the open draft's undo steps, saved with it (§7e, history.js)

/** A TipTap editor on `doc` in `element` with the open draft's extensions and node views; with `historyFile` its undo history
 * rebuilt from it, keeping `keep` undo steps; `onUpdate` after each change. `draft`: the draft `doc` is from, for its page width.
 * → {editor, log (its undo steps, §7e)}. The open draft's (mountEditor) and the assistant's background sessions'
 * (assistant/sessions.js). */
export function makeEditor(element, doc, historyFile, keep, onUpdate, draft) {
  // Whiteboards become canvases before `new Editor`, which blanks a doc with an unknown node; the history file the same way and
  // at the same width, so its replay reaches the converted doc (§6b Converted whiteboards). Comment marks without a thread go
  // here too, before any transaction; a saved history that led to them no longer replays and starts afresh.
  const { width } = pageOf(draft, state.settings);
  doc = dropOrphanComments(migrateBoards(doc, width));
  historyFile = migrateBoards(historyFile, width);
  const editor = new Editor({
    element,
    // The draft's format's own extensions (editors.js); 0 keeps no undo steps after closing, still 50 while open.
    extensions: [...kitOf(formatOf(draft, state.settings).id).extensions(state.settings.historyLimit || 50), PasteNotice],
    content: doc || '',
    // A whiteboard's hidden editor is a mount, not a text: nothing typed into it may reach a save (doSave keeps a board's board).
    editable: formatOf(draft, state.settings)?.id !== 'board',
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
  // EditorPage renders #editor once and keeps it on every page, so it is missing only when the app's shell is gone (the error
  // screen). TipTap given no element builds an editor that is in no page, so the open fails here with the reason instead.
  const host = $('#editor');
  if (!host) throw new Error('The editor area is not in the window.');
  clearTimeout(state.saveTimer);
  state.dirty = false;
  state.editor?.destroy();
  state.editor = null;
  host.replaceChildren();
  applyPage(); // before the editor: node views measure the page
  const { editor: ed, log } = makeEditor(host, doc, historyFile, keep, () => {
    countSoon();
    // A canvas draft's editor here shows its DOM form from the last switch, which no save writes: its edits come from the engine.
    if (!state.smoke && !isCanvas(state.draft)) markDirty();
  }, state.draft);
  state.editor = ed;
  undoLog = log;
  focusMs = 0;
  focusAt = document.hasFocus() ? Date.now() : null;
  clearRevLog(); // a new doc: the next rev, and no older one maps onto it (§8 Revisions)
  ed.on('transaction', ({ transaction, appendedTransactions }) => recordRev(transaction, appendedTransactions));
  // A Document's page setup changed (tr.setDocAttribute, undo too): the sheet follows.
  ed.on('transaction', ({ transaction }) => transaction.before.attrs.sect !== ed.state.doc.attrs.sect && applyPage());
  ed.on('transaction', ({ transaction }) => syncSuggestions(transaction));
  // The work packages' setup runs on a Document's main editor only (plan.md §1.2), never on story or session editors.
  if (formatOf(state.draft, state.settings)?.id === 'document') {
    ed.on('destroy', setupModules(ed));
    const draft = state.draft;
    ed.on('transaction', () => keepLayout(ed, draft));
  }
  syncSuggestions();
  updateWordCount();
  setState({ editor: ed }); // re-renders the toolbar, which follows the new editor (useEditor)
  renderSaveStatus();
  homeView(); // every draft opens with its page in the home view
}

/** mountEditor that leaves no half-built editor when it throws (open-worker): the editor area stays empty, the error goes on to
 * the caller, and the sidebar, the menus and the other drafts keep working. */
function mountSafely(...args) {
  try {
    mountEditor(...args);
  } catch (e) {
    try {
      state.editor?.destroy();
    } catch { /* it broke while it was built */ }
    state.editor = null;
    $('#editor')?.replaceChildren();
    setState({ editor: null });
    throw e;
  }
}

function updateWordCount() {
  clearTimeout(countTimer);
  // A canvas draft's hidden editor is empty: the Word status bar counts from the engine (WordStatusBar.jsx).
  const words = state.editor && !isCanvas(state.draft) ? wordCount(state.editor.getJSON()) : 0;
  if (words !== state.words) setState({ words });
}

// Counting serialises the whole document, about 6 ms at 200 pages, so typing counts once it pauses (plan.md section 6 risk 6).
let countTimer = null;
function countSoon() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateWordCount, 300);
}

function renderSaveStatus(error) {
  let label;
  if (error) label = 'Save failed';
  else if (state.dirty) label = 'Unsaved';
  else if (state.lastSaved) label = `Saved ${new Date(state.lastSaved).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  else label = state.draft?.id ? 'Saved' : 'New draft';
  // markDirty runs on every keypress: an unchanged label notifies no store reader (each notice re-renders every Word ctx reader).
  if (label === state.saveLabel && !!error === state.saveError) return;
  setState({ saveLabel: label, saveError: !!error });
}

export function markDirty() {
  state.dirty = true;
  renderSaveStatus();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 800);
}

let saveChain = Promise.resolve(true);

// Time the window had the focus with the open draft, not yet added to its editMinutes. ponytail: time since the last save is lost
// when another draft opens unsaved; count it at the switch if fields-info's EDITTIME needs it exact.
let focusMs = 0;
let focusAt = null;
const focusTick = () => {
  if (focusAt) focusMs += Date.now() - focusAt;
  focusAt = document.hasFocus() && state.draft ? Date.now() : null;
};

/** A Document's record keys its save adds (docs/plans/word/plan.md §1.12 Draft record): editing minutes, revision, last saved by. */
function savedStats(draft) {
  if (draft.format === 'board') return {}; // a whiteboard has no doc for stats to read (its items are draft.board)
  focusTick();
  const minutes = (draft.editMinutes ?? 0) + focusMs / 60000;
  focusMs = 0;
  return { editMinutes: Math.round(minutes * 100) / 100, revision: (draft.revision ?? 0) + 1, savedBy: state.settings.word?.user?.name ?? '' };
}

/** Merges `patch` into the open draft's record outside its doc (print's `printed`, mailings' `mergeSource`) and saves the record with
 * the doc as last saved, so the doc, its undo history and the dirty flag stay as they are. Resolves true on success. */
export function draftMeta(patch) {
  const draft = state.draft;
  if (!draft) return Promise.resolve(false);
  Object.assign(draft, patch);
  if (!draft.id || state.smoke) return Promise.resolve(true); // the first save writes it
  if (held()) return Promise.resolve(false);
  const save = async () => {
    try {
      // A canvas draft goes as its record's text, the model as last saved spliced in (form.mjs recordText), so the record keeps
      // the model in object form; the engine's unsaved edits stay for its next save.
      const { updated, marks } = await api.drafts.save(isCanvas(draft) ? recordText(draft) : draft);
      Object.assign(draft, { updated });
      upsertDraftEntry(draft, marks);
      return true;
    } catch (e) {
      toast(`Could not save the draft: ${e.message || e}`, true);
      return false;
    }
  };
  saveChain = saveChain.then(save, save);
  return saveChain;
}

/** Saves the current draft if dirty. Saves are serialized. Resolves true on success (or nothing to save). */
export function saveNow() {
  clearTimeout(state.saveTimer);
  saveChain = saveChain.then(doSave, doSave).then((ok) => {
    keepLayout(state.editor, state.draft);
    return writeLayout().then(() => ok);
  });
  return saveChain;
}

// The open Document's layout cache (document/layout-cache.mjs, docs/plans/word/briefs/layout-cache.md), in the draft's own layout
// file beside it (main.js drafts.saveLayout: not in the record, so taking it neither marks the draft updated nor reaches the
// backup, and it holds this machine's fonts). Taken each time the pages settle and written then, at most every LAYOUT_EVERY ms,
// and with the next save: a close or a switch to another draft saves, and typing writes it at most once a burst.
const LAYOUT_EVERY = 30000;
let kept = { ed: null, at: null }; // the editor and pages' layout version (geometry's) the layout was last taken at
let pendingLayout = null; // {id, record} not written yet
let layoutWritten = 0; // when one was last written
const layoutGone = new Set(); // drafts deleted this session: a layout taken before the delete must not write their file again

/** Takes the layout of `draft`'s editor `ed` when its pages are settled and laid out again since it was last taken. */
function keepLayout(ed, draft) {
  if (WORKER || state.smoke || !ed || ed !== state.editor || !draft?.id || formatOf(draft, state.settings)?.id !== 'document' || isCanvas(draft)) return;
  const st = paginationKey.getState(ed.state);
  const at = st?.geo?.version;
  if (!st?.progress?.settled || at == null || (kept.ed === ed && kept.at === at)) return;
  kept = { ed, at };
  const record = layoutCacheOf(ed.view);
  if (!record) return;
  pendingLayout = { id: draft.id, record };
  if (Date.now() - layoutWritten > LAYOUT_EVERY) writeLayout();
}

/** Writes the layout kept and not written yet. A failed write costs only the next open's speed: it resolves either way. */
function writeLayout() {
  const p = pendingLayout;
  if (!p || !api.drafts.saveLayout) return Promise.resolve();
  pendingLayout = null;
  if (layoutGone.has(p.id)) return Promise.resolve();
  layoutWritten = Date.now();
  return api.drafts.saveLayout(p.id, p.record).catch((e) => console.warn('The layout cache was not written.', e));
}

// While GitHub sync covers the window (busy() sets state.syncing), saves wait, except flush()'s own, so nothing written during a
// pull overwrites the files it brings (AR8). A held save keeps the draft dirty.
let flushing = false;
const held = () => state.syncing && !flushing;

/** The formatVersion a save of `draft` stamps: formats.mjs formatVersionOf, which every path that writes a draft's record uses. */
const versionOf = formatVersionOf;

// Canvas drafts (docs/plans/engine/model.md): the engine holds the document, and state.editor shows the DOM form from the last
// switch, so doSave never saves one from state.editor. The canvas page area hands its engine save here (attachCanvas), which
// runs in this save chain and sync hold like every save, so no two runs of a record's pieces (drafts.savePart) interleave.
let canvasSave = null; // {draft, save: () → the store's {id, updated}}

/** While the page area holds `draft`, doSave saves it with `save` (autosave.mjs saveOnce: the engine serialises, this thread
 * sends the record in pieces) → a function that ends it. The first save of a DOM draft switched to the canvas goes this way too:
 * it makes the draft a canvas draft. */
export function attachCanvas(draft, save) {
  const mine = { draft, save };
  canvasSave = mine;
  return () => {
    if (canvasSave === mine) canvasSave = null;
  };
}

/** Saves the open canvas draft `draft`: from its engine while the page area holds it, else (the engine could not open it, the page
 * area is closed, or a Word file's new draft before its first save) the record as last saved with the rest of the draft's keys,
 * such as a new title. */
async function saveCanvas(draft) {
  if (!draft.uid) draft.uid = crypto.randomUUID(); // a board's reference (bd-instance): a record saved before uid had one
  Object.assign(draft, savedStats(draft));
  state.dirty = false;
  state.saving = true;
  setState({ saveLabel: 'Saving...' });
  try {
    const isNew = !draft.id;
    const { marks, ...saved } = canvasSave?.draft === draft ? await canvasSave.save() : await api.drafts.save(recordText(draft));
    Object.assign(draft, saved);
    state.lastSaved = draft.updated;
    upsertDraftEntry(draft, marks);
    if (state.draft === draft) {
      // A DOM draft switched to the canvas: its suggestions went to the engine, and the Word status bar counts from there.
      syncSuggestions();
      updateWordCount();
    }
    if (isNew) await firstSave(draft);
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

async function doSave() {
  if (!state.dirty || !state.draft || state.smoke || held()) return true;
  if (isCanvas(state.draft) || canvasSave?.draft === state.draft) return saveCanvas(state.draft);
  if (!state.editor) return true;
  const doc = state.editor.getJSON();
  const historyFile = history.encode(undoLog, state.settings.historyLimit);
  const draft = state.draft;
  if (!draft.uid) draft.uid = crypto.randomUUID(); // a board's reference (bd-instance): a record saved before uid had one
  // The title stays: it is set at creation and by a rename only (docs/wiki/sidebar-menu.md decision 1). A whiteboard keeps no
  // doc (its items are draft.board): the hidden editor under it is empty, and writing it would give the record a text it has not.
  if (draft.format === 'board') draft.formatVersion = versionOf(draft);
  else Object.assign(draft, { doc, formatVersion: versionOf(draft) });
  if (draft.format === 'document') Object.assign(draft, savedStats(draft));
  state.dirty = false;
  state.saving = true;
  setState({ saveLabel: 'Saving...' });
  try {
    // As JSON text (main.js saveDraft parses it): sending the 16 MB fixture draft as an object held the page 377 to 420 ms (the
    // context bridge copies it, then IPC clones it); as text, stringify and send take about half (open-worker, measured in
    // .smoke-data/word/cases/open-worker.js). The background window sends the object, which computer-main.js checks.
    const { id, updated } = await api.drafts.save(WORKER ? draft : JSON.stringify(draft));
    const isNew = !draft.id;
    Object.assign(draft, { id, updated });
    state.lastSaved = updated;
    upsertDraftEntry(draft);
    if (isNew) await firstSave(draft);
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

/** The bookkeeping of new draft `draft`'s first save, which gave it its id: the draft the app reopens (createDraft's Word file
 * marked as opening, watchOpen), Settings > Tags' tag for new drafts and the draft order. */
async function firstSave(draft) {
  const { id } = draft;
  if (state.draft === draft) await saveSettings({ lastDraftId: id, ...(markNew && { opening: id }) });
  if (defaultTag(state.settings)) await setDraftTag(id, defaultTag(state.settings).id);
  await saveDraftOrder();
}

/** Saves `draft` held by an editor `ed` other than the open draft's (an assistant background session, assistant/sessions.js), with
 * its undo steps `log`: the same draft file, history file and save chain as the open draft's. Resolves true on success. */
export function saveOther(draft, ed, log) {
  // Its doc is not what a canvas draft opens from: a save would report success and lose the edits (sessions.js saves a canvas
  // draft with saveCanvasOther).
  if (isCanvas(draft)) {
    toast(`Could not save the draft "${draft.title}": it is in the canvas engine.`, true);
    return Promise.resolve(false);
  }
  const save = async () => {
    if (held()) return false;
    try {
      const doc = ed.getJSON();
      Object.assign(draft, { doc, formatVersion: versionOf(draft) }); // the title stays, as in doSave
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

/** Saves canvas draft `draft` held by engine session `client` (an assistant background session, assistant/sessions.js) as the page
 * area saves the open one (autosave.mjs saveOnce: the record, then its undo history), in the same save chain and sync hold.
 * Resolves true on success. */
export function saveCanvasOther(draft, client) {
  const save = async () => {
    if (held()) return false;
    try {
      const store = (part, i, n) => api.drafts.savePart(draft.id, i, n, part);
      const hist = (part, i, n) => api.drafts.saveHistoryPart(draft.id, i, n, part);
      const { marks } = (await saveOnce(client, draft, store, {}, { store: hist, limit: state.settings.historyLimit ?? 50 })) ?? {};
      upsertDraftEntry(draft, marks);
      return true;
    } catch (e) {
      toast(`Could not save the draft "${draft.title}": ${e.message || e}`, true);
      return false;
    }
  };
  saveChain = saveChain.then(save, save);
  return saveChain;
}

const marksOf =(d) => ({ suggestions: d?.suggestions ?? 0, flows: d?.flows ?? [], plans: d?.plans ?? [] });

// `draft`: a draft or a summary entry (the background window's save, marks included). Its marks: `marks` (main.js saveDraft's for a
// canvas draft, read from the engine model), else a DOM draft's from its doc, else the summary's, else a canvas draft's last.
function upsertDraftEntry(draft, marks = null) {
  const old = state.drafts.find((d) => d.id === draft.id);
  marks ??= isCanvas(draft) ? marksOf(old) : draft.doc ? draftMarks(draft.doc) : marksOf(draft);
  // The open canvas draft's count is its cards' (main.js reads none from an engine model).
  if (draft === state.draft && state.suggestions.canvas) marks = { ...marks, suggestions: state.suggestions.count };
  // `uid`: what a board's doc item refers to (bd-instance findDraft). `engine`: the Place list shows engine drafts only.
  // `placed`: a whiteboard's live doc items, for the board tree under its sidebar row (Sidebar.jsx): from the live board when
  // this is its record, else kept from its summary.
  const placed = draft.placed ?? (draft.board ? placedIds(draft.board) : old?.placed);
  const entry = { id: draft.id, title: draft.title, threadUrl: draft.threadUrl, updated: draft.updated, pushedAt: draft.pushedAt,
    format: draft.format ?? null, uid: draft.uid ?? null, engine: !!draft.engine, ...marks, ...(placed !== undefined && { placed }) };
  setState({ drafts: [entry, ...state.drafts.filter((d) => d.id !== draft.id)].sort((a, b) => b.updated - a.updated) });
}

/** A whiteboard's placed drafts (main.js placedDrafts, for the sidebar's board tree): its live doc items' draft ids in board
 * order, each once. */
function placedIds(board) {
  const items = Object.values(board?.items ?? {}).filter((i) => i && !i.gone && i.type);
  const keyOf = (i) => i.at?.[1] ?? '';
  const byOrder = (a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const out = [];
  const walk = (parent) => {
    for (const item of items.filter((i) => (i.at?.[0] ?? null) === parent).sort(byOrder)) {
      if (item.type === 'doc' && item.draft && !out.includes(item.draft)) out.push(item.draft);
      walk(item.id);
    }
  };
  walk(null);
  return out;
}

/** The drafts-list entry a board's doc item names: the one with its `draft` id and `uid`, else the one carrying that `uid`
 * (another machine or a later server, where the ids differ), else null. */
export function findDraft(item) {
  const drafts = state.drafts ?? [];
  const byId = drafts.find((d) => d.id === item.draft);
  if (byId && byId.uid === item.uid) return byId;
  if (item.uid == null) return null;
  return drafts.find((d) => d.uid === item.uid) ?? null;
}

// A new draft of `format` holding `doc` (TipTap JSON in that format's schema; null: empty), not saved yet. createDraft saves it
// at once; it stays unsaved only in the plain smoke run and when createDraft's save fails (docs/wiki/sidebar-menu.md decision 2).
// `engine`: a Document's engine model (the helper's engineForm bytes), which makes it a canvas draft; the hidden DOM editor under
// the page area is empty.
function newDraft(doc = null, { format, focus = true, engine = null } = {}) {
  // A Document starts with its own copy of the styles, theme, lists and page setup (docs/plans/document.md Document-level data).
  // Lists in `doc` (drafts.create content) get their own nums.
  if (format === 'document') doc = numberNewLists({ ...newDocumentJson(state.settings), ...doc });
  // `uid`: the reference a board keeps to this draft, synced with the record, so a board on another machine or a later server
  // finds it when the local id differs (docs/plans/board/briefs/bd-instance.md).
  state.draft = { title: 'Untitled', threadUrl: shownThread(), created: Date.now(), pushedAt: null, uid: crypto.randomUUID(),
    format, doc };
  // A whiteboard holds its items in draft.board (src/board/store.mjs) and keeps doc null.
  if (format === 'board') state.draft.board = blankBoard();
  state.draft.formatVersion = versionOf(state.draft);
  if (engine) adopt(state.draft, engine);
  state.lastSaved = null;
  mountSafely(doc);
  if (focus) focusArea() || state.editor.commands.focus();
}

/** A new draft of `format` holding `doc` (TipTap JSON; null: empty) titled `title` (cleanTitle; empty: the first line of `doc`,
 * else 'Untitled') in thread `threadUrl` (undefined: the selected thread), saved at once so it has an id (an empty one too),
 * then filed in `folderId` and tagged `tagId`; shown in the editor without taking the focus. Every new draft comes through here
 * (docs/wiki/sidebar-menu.md decision 2). `opening`: the key of the opening card a Word file's draft opens behind (files.js),
 * whose first save also marks it as opening (watchOpen). `engine`: a Document's engine model, which makes it a canvas draft whose
 * first save writes the canvas record; its card ends when the page area paints its first pages (canvasOpen). Resolves {draftId};
 * throws when it could not be saved. */
export async function createDraft({ title, threadUrl, folderId = null, tagId = null, doc = null, format, opening = null, engine = null } = {}) {
  if (!(await saveNow())) throw new Error('The open draft could not be saved');
  newDraft(doc, { format, focus: false, engine });
  if (engine && opening) following = { draft: state.draft, card: opening };
  state.draft.title = cleanTitle(title || (doc ? draftTitle(doc) : ''));
  if (threadUrl !== undefined) state.draft.threadUrl = draftThreadUrl(threadUrl);
  markDirty();
  stepOpening(opening, { stage: 'Saving the draft' });
  markNew = !!opening;
  const saved = await saveNow().finally(() => { markNew = false; });
  if (!saved || !state.draft.id) throw new Error('The new draft could not be saved');
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
  const [[draft, historyFile], layout] = await Promise.all([bg ? [bg.draft, bg.history] : Promise.all([api.drafts.load(id), api.drafts.loadHistory(id).catch(() => null)]),
    api.drafts.loadLayout?.(id).catch(() => null) ?? null]);
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
  // A large draft, or the one that was still opening when the app last closed, opens behind the opening card, marked as opening
  // until its pages settle (watchOpen).
  const back = state.draft?.id;
  const title = draft.title || 'Untitled';
  // A canvas draft's size is its model's top-level blocks: the engine opens it in the page area, and a `doc` that a record saved
  // before still holds is stale.
  const canvas = isCanvas(draft);
  const blocks = canvas ? draft.engine.model?.body?.length : (bg?.doc ?? draft.doc)?.content?.length;
  const loud = id === suspect || (blocks ?? 0) > BIG;
  const card = loud && startOpening(title, { stage: 'Drawing the pages' });
  if (loud) {
    suspect = null;
    if (remember) await saveSettings({ lastDraftId: id, opening: id });
    await painted();
  }
  // Word's line heights from the font files, before the first layout (font-metrics: otherwise its pages lay out twice).
  if (formatOf(draft, state.settings).id === 'document' && !canvas) await preloadRatios(bg?.doc ?? draft.doc);
  state.draft = draft;
  state.lastSaved = draft.updated;
  stageCache(layout); // the draft's last layout: its editor opens from it (document/layout-cache.mjs)
  if (canvas && loud) following = { draft, card };
  // A canvas draft's undo history is the engine's: its page area takes the file (takeHistory).
  canvasHistory = canvas && !bg ? { draft, file: historyFile } : null;
  try {
    // The session's steps, also with 0 kept after closing. A canvas draft's session stays in the engine for the page area.
    if (bg && !bg.canvas) mountSafely(bg.doc, historyFile, state.settings.historyLimit || 50);
    // The hidden DOM editor under a canvas draft's page area is empty, with no undo history (the engine keeps its own).
    else if (canvas) mountSafely(newDocumentJson(state.settings));
    else mountSafely(draft.doc, historyFile);
  } catch (e) {
    console.error(e);
    failOpening(title, e.message, () => state.editor || leave(id, back));
    return false;
  }
  if (show) await showPage('editor');
  if (loud) {
    stepOpening(card, { stage: 'Laying out pages', cancel: () => leave(id, back) });
    if (!canvas) watchOpen(state.editor, draft, card); // a canvas draft's page area reports to canvasOpen
  } else if (remember) await saveSettings({ lastDraftId: id });
  return true;
}

let canvasHistory = null; // {draft, file}: the history file openDraft loaded for a canvas draft, until its page area takes it

/** The undo history file openDraft loaded for canvas draft `draft` (engine-undo-file), once: the page area takes it into the engine
 * when it opens the draft (src/document/canvas/session.js), which checks that it belongs to the record. Null for another draft. */
export function takeHistory(draft) {
  const h = canvasHistory?.draft === draft ? canvasHistory.file : null;
  canvasHistory = null;
  return h;
}

/** Puts `next`, the open draft in another form (src/document/canvas/session.js: a canvas draft back in the DOM editor), in the
 * editor with a new undo history, since the old one belongs to the other form, and saves it: the save writes the record and the
 * new history over the old. Resolves true once saved. */
export async function replaceOpenDraft(next) {
  const prev = state.draft;
  if (prev?.id !== next.id) return false;
  state.draft = next;
  try {
    mountSafely(next.doc);
  } catch (e) {
    state.draft = prev;
    refresh();
    throw e;
  }
  state.dirty = true;
  return saveNow();
}

// ---------------------------------------------------------------------------------------------
// Opening safely (docs/plans/word/briefs/open-worker.md): a Word file or a large draft opens behind the opening card, and while
// the draft the app reopens at start (settings.lastDraftId) lays out its pages, settings.opening holds its id. A draft that froze
// or crashed the app while it opened then waits for a click at the next start instead of freezing the app again.

const BIG = 1000; // ponytail: top-level blocks (about 40 pages) that make an open show the card; the file's size if blocks mislead
const CALM = 10000; // ms the page answered on time while a draft laid out: its mark goes, settled or not
let suspect = null; // the draft that was still opening when the app last closed (init): it opens on a click, behind the card
let markNew = false; // createDraft's first save of a Word file's draft marks it as opening, with lastDraftId in the same write

/** Follows the pages of `draft`, open in editor `ed`, as they lay out: the opening card `card` (startOpening's key, or null) counts
 * them and ends once they settle; the mark goes then, or once the page has answered on time for CALM ms. Until perf-core
 * publishes paginationKey's progress {done, estimate, settled}, a page count that stands still for a second counts as settled. */
export function watchOpen(ed, draft, card) {
  let last = -1;
  let still = 0;
  let calm = 0;
  let at = Date.now();
  let marked = true;
  const timer = setInterval(() => {
    const now = Date.now();
    calm = now - at < 1000 ? calm + now - at : 0; // a late tick: the page was busy
    at = now;
    const st = ed?.isDestroyed === false ? paginationKey.getState(ed.state) : null;
    const done = st?.progress?.done ?? st?.pages ?? 1;
    still = done === last ? still + 1 : 0;
    last = done;
    if (st) stepOpening(card, { done, estimate: st.progress?.estimate ?? ed.state.doc.attrs.props?.pages ?? null });
    const settled = !st || (st.progress ? st.progress.settled : still >= 4);
    if (marked && (settled || calm >= CALM) && draft.id && state.settings.opening === draft.id) {
      marked = false;
      saveSettings({ opening: null }).catch(() => {});
    }
    if (!settled) return;
    clearInterval(timer);
    endOpening(card);
  }, 250);
}

let following = null; // {draft, card}: a canvas draft opening behind the opening card `card`, which its page area reports to

/** The canvas page area's open of `draft` (session.js, PageArea.jsx) reached `step`: 'painted' (its first pages show, so the
 * opening card ends), 'settled' (every page laid out, so its opening mark goes too), 'failed' (the area says why) or 'closed'. */
export function canvasOpen(draft, step) {
  const f = following;
  if (!f || f.draft !== draft) return;
  endOpening(f.card);
  if (step === 'painted') return;
  following = null;
  if (draft.id && state.settings.opening === draft.id) saveSettings({ opening: null }).catch(() => {});
}

/** Draft `id` will not paint its pages now (a board took it instead of the page area): its opening card ends here, since no
 * page area will report for it. */
export function openingDone(id) {
  const f = following;
  if (!f || f.draft?.id !== id) return;
  endOpening(f.card);
  following = null;
  if (state.settings?.opening === id) saveSettings({ opening: null }).catch(() => {});
}

/** Closes draft `id` (null: a new one that never saved), keeping it in the list: Cancel while its pages lay out, or Close after
 * it failed to open. Opens draft `back` (the one open before) instead, else the newest other draft, else a new one. */
export async function leave(id, back) {
  const to = [back, ...state.drafts.map((d) => d.id)].find((d) => d && d !== id);
  if (!to || !(await openDraft(to))) await fallbackDraft();
}

/** The format a new draft without the New draft dialog takes (init, doDeleteDraft): as the dialog preselects. */
const fallbackFormat = () => defaultFormat(state.settings, shownThread(), { last: true });

/** With nothing left to open (init, doDeleteDraft): a saved empty draft (docs/wiki/sidebar-menu.md decision 2), focused as
 * newDraft focuses. The plain smoke run keeps it unsaved: it runs on the real profile. A failed save leaves the unsaved draft
 * in the editor, as a failed autosave does (doSave's toast explains). */
async function fallbackDraft() {
  if (SMOKE) return newDraft(null, { format: fallbackFormat() });
  await createDraft({ format: fallbackFormat() }).catch(() => {});
  focusArea() || state.editor?.commands.focus();
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
  focusArea() || state.editor.commands.focus(); // FormDialog gave the focus back before this editor existed; createDraft mounts it unfocused
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
    const { marks, ...saved } = await api.drafts.save({ ...draft, ...patch });
    Object.assign(draft, patch, saved);
    upsertDraftEntry(draft, marks);
    return true;
  };
  const done = saveChain.then(write, write);
  saveChain = done.catch(() => false); // a failed write rejects for the caller, not for the saves after it
  return done;
}

/** The draft `id` → its thread `url` (as draftThreadUrl; null: none), without a dialog. Another draft is rewritten, which bumps
 * its `updated` (it moves up the sidebar when the list follows it). */
export const setDraftThreadFor = (id, url) => updateDraft(id, { threadUrl: draftThreadUrl(url) });

/** Renames the draft `id` to cleanTitle(`title`) (docs/wiki/sidebar-menu.md decision 1). Resolves false when it could not be
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
  // A board's camera and its open draft tree go with it: nothing must write settings for a draft that no longer exists.
  const purge = {};
  if (state.settings?.boardViews?.[id]) purge.boardViews = Object.fromEntries(Object.entries(state.settings.boardViews).filter(([k]) => k !== id));
  if (state.settings?.boardTreeOpen?.[id]) purge.boardTreeOpen = Object.fromEntries(Object.entries(state.settings.boardTreeOpen).filter(([k]) => k !== id));
  if (Object.keys(purge).length) await saveSettings(purge);
  layoutGone.add(id); // the next draft's open saves, which would write this one's layout file back beside the trashed draft
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

/** A project row: shows its drafts and the editor page (§7g). */
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

/** The project the Drafts list shows: the selected one while it is listed, else the first (the user, 2026-10-28: no All drafts);
 * null with no projects. */
export function shownThread() {
  const { threads, selectedThread } = state.settings;
  return threads.some((t) => t.url === selectedThread) ? selectedThread : threads[0]?.url ?? null;
}

/** The shown project's drafts; every draft with no projects. */
export function visibleDrafts() {
  const sel = shownThread();
  return sel ? state.drafts.filter((d) => d.threadUrl === sel) : state.drafts;
}

/** The drafts in no listed project (none, or one removed from the list), in the Drafts order: the sidebar's Unlinked drafts,
 * shown once there is a project. */
export const unlinkedDrafts = () => (state.settings.threads.length
  ? sortDrafts(state.drafts.filter((d) => !state.settings.threads.some((t) => t.url === d.threadUrl)), state.settings.draftOrder) : []);

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

/** Shows or hides the drafts placed on whiteboard `id`, under its sidebar row (Sidebar.jsx board tree), kept across restarts. */
export function toggleBoardTree(id) {
  const open = state.settings?.boardTreeOpen ?? {};
  return saveSettings({ boardTreeOpen: { ...open, [id]: !open[id] } });
}

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

/** A copy of the draft `id` titled '<title> (copy)' (docs/wiki/sidebar-menu.md decision 6), not opened: its file with a new id
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
  // id null: main's save gives it a new id and created, and updated now. The uid is the copy's own: a board keeps a reference
  // to one draft by it, so a duplicate must not answer to the original's.
  const copy = { ...source, id: null, uid: crypto.randomUUID(), title: copyTitle(source.title), pushedAt: null,
    ...(threadUrl !== undefined && { threadUrl }) };
  const { marks, ...saved } = await api.drafts.save(copy);
  Object.assign(copy, saved);
  upsertDraftEntry(copy, marks); // placeDraft, moveDraft and pruneMap keep only drafts in state.drafts
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
  const sel = shownThread();
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

/** Whether the setup dialog shows (Setup.jsx): until settings.onboarded, or after Run setup again; never in the background
 * window or the smoke sample run. */
export function setupOpen(s = state) {
  return !!s.settings && !s.smoke && !WORKER && !SMOKE && (s.settings.onboarded !== true || !!s.setup);
}

/** Settings > General Run setup again and its tool search entry: the setup (src/app/setup) from its first page. Nothing is
 * cleared: each page shows the settings as they are. */
export async function runSetup() {
  await saveSettings({ setup: { usedBefore: null, ...state.settings.setup, step: 'welcome' } });
  setState({ setup: true });
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
// A modeless dialog (Find and Replace) leaves the app's keys to the text behind it; a modal dialog, a confirmation or the setup
// keeps them.
const keysHeld = (e) => state.confirm || setupOpen()
  || (dialogStack().length && !(document.querySelector('[data-modeless]') && !e.target.closest?.('[role="dialog"], [role="alertdialog"]')));

function onKeyDown(e) {
  // Word's chords in a Document's text (plan.md §1.13): WordKeys (document/word/keys.js) runs them there, and Word's window-wide
  // keys run here while the focus is in the Document's ribbon, panes, status bar or backstage. Before window zoom: Ctrl+= zooms
  // the page in the text.
  if (wordKeyWins(e)) {
    if (!e.target.closest?.('[data-doc-text]')) runWordKey(e);
    return;
  }
  // Window zoom, over dialogs too (Settings > General UI scale shows it): the main window has no menu, so no accelerators. In the
  // browser's pane or page the browser's own zoom keys zoom its tab instead (§7j browserKey).
  const zoom = keyAmong(Object.keys(WINDOW_ZOOM), e);
  if (zoom && !e.target.closest?.('[data-browser-pane], [data-browser-page]')) {
    return go(e, () => api.window.zoom(WINDOW_ZOOM[zoom]).then((settings) => setState({ settings }))); // saved as uiScale
  }
  if (keysHeld(e)) return; // the setup is modal to the keyboard too
  const isDocument = state.draft?.format === 'document';
  if (keyIs('app.save', e)) {
    go(e, () => {
      commitBoardEdit();
      saveNow();
    });
  } else if (keyIs('app.toolSearch', e) && !(isDocument && e.target.closest?.('[data-pane], [data-reading]'))) {
    // Tool search, also in canvas edit mode, a text item or an input. Window capture: before ProseMirror and the boards;
    // never types a space. In a Document's pane Ctrl+Space opens the pane's menu instead (ribbon-chrome), and while Read Aloud
    // reads it plays or pauses (proofing).
    e.stopPropagation();
    go(e, toggleToolSearch);
  } else if (isDocument && keyIs('app.toolSearchDoc', e)) {
    e.stopPropagation(); // Alt+Q, Word's search box key, in a Document wherever the focus is
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
    // The open draft's waiting agent edits (docs/wiki/suggestions.md Keys). An agent's keys never decide them (Open decision 11):
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
  } else if (keyAmong(PRESETS, e) && can('format.post', state.draft) && !e.target.closest?.('.wb')) {
    // Font presets are forum marks: in a Document Alt+1..9 stay free for the Quick Access Toolbar's KeyTips (ribbon-chrome).
    go(e, () => applyPresetAt(PRESETS.indexOf(keyAmong(PRESETS, e))));
  }
}

/** Globe+Tab or Globe+Space on a Mac (main.js watchGlobe; the page never sees the Globe key): a key press and release at the
 * focus, with fnKey set, so every key reader (this handler, the tutorial, the keybind recorder) sees Fn+Tab or Fn+Space. */
function globeKey({ code, shift, ctrl, alt, meta, repeat }) {
  const el = document.activeElement || document.body;
  for (const type of ['keydown', 'keyup']) {
    const e = new KeyboardEvent(type, { code, key: code === 'Tab' ? 'Tab' : ' ', shiftKey: shift, ctrlKey: ctrl, altKey: alt, metaKey: meta,
      repeat, bubbles: true, cancelable: true, composed: true, modifierFn: true });
    Object.defineProperty(e, 'fnKey', { value: true });
    el.dispatchEvent(e);
  }
}

function onBeforeUnload(e) {
  if (state.syncReload) return; // GitHub backup: the files on disk are newer than anything in memory
  commitBoardEdit();
  const bg = flushSessions(); // the assistant's background sessions save their last change; null when none has one
  if (state.forceClose || state.smoke || !(state.dirty || state.saving || bg || pendingLayout)) return;
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
  // home view's room in proportion, re-fitting the zoom first.
  place = keepPlace($('#editor-area'), $('#page-wrap'), () => ({ left: VIEW_LEFT, right: VIEW_RIGHT, top: VIEW_TOP, bottom: 0 }), () => applyZoom());
  // Middle-drag pans the editor area; Ctrl + wheel zooms the page around the pointer (also while a canvas is edited in place).
  zoomer = bindPanZoom($('#editor-area'), $('#page-wrap'), setZoom, (pct) => setLiveZoom(pct == null ? null : Math.round(pct)),
    () => $('#editor-area').hasAttribute('data-word-view'));
  $('#editor-area').addEventListener('pointerdown', marginClick);
  window.addEventListener('keydown', onKeyDown, true);
  api.keys?.onGlobe(globeKey);
  window.addEventListener('pointermove', (e) => { pointer = { x: e.clientX, y: e.clientY }; }, true);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('focus', focusTick); // the open draft's editing minutes (savedStats)
  window.addEventListener('blur', focusTick);
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
  api.window.onSettings(() => openSettings());
  // The demo draft (samples/demo.js) is no longer created on a new profile (docs/plans/onboarding.md); the flag is still set
  // once, so a profile reads the same to an older build, which would otherwise seed it.
  if (!state.settings.demoSeeded && !SMOKE) await saveSettings({ demoSeeded: true }).catch(() => {});
  const { lastDraftId, opening } = state.settings;
  let id = state.drafts.some((d) => d.id === lastDraftId) ? lastDraftId : state.drafts[0]?.id;
  // Still opening when the app last closed: that draft froze or crashed it. It stays in the list and opens on a click.
  if (id && id === opening) [suspect, id] = [id, state.drafts.find((d) => d.id !== opening)?.id];
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
      flushing = true;
      try {
        commitBoardEdit();
        await flushSessions();
        await Promise.all([flushPlans(), flushFlows()]);
        return await saveNow();
      } finally {
        flushing = false;
      }
    },
    reload: () => {
      state.syncReload = true; // saved by flush(): the files on disk are the new ones, so no unload handler saves
      location.reload();
    },
    busy: (text) => {
      document.body.inert = !!text; // no typing or clicks under the overlay
      state.syncing = !!text; // no agent commands (commands.js invoke) or saves (held) either
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
  // The installed fonts load once in the background when the app is idle, so the Font list never stalls on its first open
  // (the user, 2026-10-26; document/fonts.js caches them). The background window shows no Font list.
  if (!WORKER) ready.then(() => requestIdleCallback(() => listFonts(), { timeout: 5000 }), () => {});
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

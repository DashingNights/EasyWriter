import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { typing } from '../document/typing.mjs';

// One plain store for the shell. Actions write it through setState; components read it with useStore(selector).
// A selector must return a stored value or a primitive, never a new object or array.
// `draft` is mutated in place (its identity means "still the open draft"): select its fields, not the object.
const state = {
  settings: null,
  uiDark: true,      // the app's colours are dark: settings.uiTheme resolved (actions.js applyUiTheme)
  status: { loggedIn: false },
  drafts: [],        // [{id,title,threadUrl,updated,pushedAt}]
  draft: null,       // full draft being edited; no id until first save
  editor: null,      // TipTap Editor; lives outside React state, components re-render through useEditor()
  focusedSession: null, // the SessionClient of the canvas draft holding the focus (docs/plans/engine/viewport-design.md section 4.7): the tools act on it, not `editor`
  boardFocus: null,  // {kind: 'document' | 'text', session, format?} — what a board holds the keys for (bd-hud, bd-text)
  boardHud: null,    // the format whose HUD a board shows (bd-hud hudOf: the most verbose of the focus and the documents in view)
  engineRefused: null, // the open draft the engine could not take: it stays on the DOM editor until it opens again (surface.js areaOpens)
  dirty: false,
  saveTimer: null,
  lastSaved: null,
  saving: false,
  smoke: false,
  forceClose: false,
  // UI state shown by the components
  saveLabel: 'Saved',
  saveError: false,
  words: 0,
  sidebarPeek: false, // the sidebar shown over the main column while the window is too narrow for it (actions.js NARROW)
  zoom: 78,          // 'fit' or a percent; opens at 78 %
  zoomPct: 100,      // the page zoom applied, in percent (the computed one while zoom is 'fit')
  overlay: null,     // push overlay text, null = hidden
  loggingIn: false,  // status and loggingIn: the forum integration's sign-in (forum/actions.js); overlay stays core (GitHub busy())
  dialog: null,      // { type, props, resolve } — the open form dialog
  confirm: null,     // { title, description, confirmText, destructive, alert, resolve } — the open AlertDialog
  toolSearch: null,  // { board, focus, at, attach } — the open tool search (§7c): the board it serves (null: the document), the focus to return to, the selection as an assistant attachment
  toolOptions: null, // { entry, ctx } — the open options panel of a tool search entry (ctx: as toolSearch)
  notices: [],       // [{ id, icon, text, mode? }] — the fading notices above the toolbar island (§7c; Notices.jsx notify)
  quickTools: null,  // { board, x, y } — the open quick tools island (§7d): the board it serves (null: the document), the pointer it opened at
  citePicker: null,  // { x, y } — the open citation picker (References.jsx; references.js openCitePicker): the text cursor's place
  find: null,        // { n, seed } — the open find bar (FindBar.jsx): n +1 per Ctrl+F (focuses it again), seed: a query to start with
  setup: false,      // Run setup again (actions.js runSetup): the setup shows although settings.onboarded is true (setupOpen)
  tutorial: null,    // { step, format, from } — the running tutorial (Tutorial.jsx): its step, its draft's format, the draft open at its start
  view: { type: 'editor' }, // the main column (§7g): {type:'editor'} | {type:'plan', planId, tab} | {type:'flows', flowId} | {type:'browser'}
  browser: { tabs: [], active: null }, // the in-app browser's tabs (§7j; browser.js), mirrored into settings.browser
  planUi: { selection: [], focusId: null, filter: '', options: {} }, // the plan workspace (§7f): selected / focused cards, filter text, label / priority / hide-done filters
  // Commands and agents (§8)
  rev: 0,            // the open draft's revision: +1 per document change and per editor mount, never reset (rev.js)
  agentAsk: [],      // [{ rid, source, title, description, risk, steps?, expires, resolve }] — queued agent requests; AgentAsk.jsx shows the first
  agent: { connections: [], hidden: false }, // connections [{ name, since, disconnect? }] (the assistant's turn now; the pipe later)
  bgWrites: [],      // draft ids the assistant wrote in a background session this turn (§7i Background drafts; the sidebar badge, the chat status)
  worker: null,      // the background window's draft { draftId, title } (§7i Background window), null while it has none
  workerPane: false, // the pane with the background window's live view is shown
  draftClip: null,   // { id, cut } — the sidebar's draft clipboard (§7 Drafts menu): Copy or Cut, for this session only, never the OS clipboard
  // The open draft's waiting agent edits (docs/wiki/suggestions.md; actions.js syncSuggestions): core.groups, their change count,
  // the active change's id (under the caret, else the last shown)
  suggestions: { groups: [], count: 0, active: null },
  // Word parity (docs/plans/word plan.md §1.12): the pane open on each side (src/tooling/panes.jsx; its props live there), and the
  // Word layer's view state, each field written by the package plan.md names. peek: a collapsed ribbon is open over the page
  // after a tab click (tooling/ribbon/Ribbon.jsx).
  panes: { left: null, right: null, bottom: null },
  word: {
    view: 'print', tab: 'home', backstage: null, ribbon: 'full', keytips: false, story: null, extend: null, overtype: false, painter: null,
    preview: null, navSearch: null, mode: 'editing', pen: { style: 'single', width: 0.5, color: null }, tableTool: null, readScreen: null,
    peek: false,
  },
};

// This window is the background window of computer use (§7i Background window: main.js loads the app with ?worker=1&draft=<id>):
// it opens only that draft, saves only it and never writes settings.json.
const query = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
export const WORKER = query.get('worker') === '1';
export const WORKER_DRAFT = WORKER ? query.get('draft') : null;
// The smoke sample run (main.js loads the app with ?smoke=1 for `--smoke` without `--script`): no demo draft (actions.js init).
export const SMOKE = query.get('smoke') === '1';

const listeners = new Set();
let version = 0; // +1 per setState: the Word registry memoises its context on it (src/tooling/registry.js ctxOf)

export const getState = () => state;
export const storeVersion = () => version;

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  version++;
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStore(selector) {
  return useSyncExternalStore(subscribe, () => selector(state));
}

const due = new Set();
let dueTimer = null;
/** Runs `fn` once typing pauses for 100 ms, however often it is asked before then. Typing re-renders the editor's readers this way:
 * the ribbon, the status bar and the rulers took several ms to render after each keypress on long documents
 * (docs/plans/word/plan.md section 6 risk 6), and they show nothing new between two keys. */
export function afterTyping(fn) {
  due.add(fn);
  clearTimeout(dueTimer);
  dueTimer = setTimeout(() => {
    const fns = [...due];
    due.clear();
    for (const f of fns) f();
  }, 100);
}

/** The current editor; the calling component re-renders on every transaction and selection change (typing: once it pauses). */
export function useEditor() {
  const editor = useStore((s) => s.editor);
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!editor) return undefined;
    const onTr = ({ transaction }) => (typing(transaction) ? afterTyping(rerender) : rerender());
    editor.on('transaction', onTr);
    editor.on('selectionUpdate', onTr);
    return () => {
      editor.off('transaction', onTr);
      editor.off('selectionUpdate', onTr);
    };
  }, [editor]);
  return editor;
}

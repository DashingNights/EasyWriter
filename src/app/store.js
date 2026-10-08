import { useEffect, useReducer, useSyncExternalStore } from 'react';

// One plain store for the shell. Actions write it through setState; components read it with useStore(selector).
// A selector must return a stored value or a primitive, never a new object or array.
// `draft` is mutated in place (its identity means "still the open draft"): select its fields, not the object.
const state = {
  settings: null,
  status: { loggedIn: false },
  drafts: [],        // [{id,title,threadUrl,updated,pushedAt}]
  draft: null,       // full draft being edited; no id until first save
  editor: null,      // TipTap Editor; lives outside React state, components re-render through useEditor()
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
  zoom: 78,          // 'fit' or a percent; opens at 78 %
  zoomPct: 100,      // the page zoom applied, in percent (the computed one while zoom is 'fit')
  overlay: null,     // push overlay text, null = hidden
  discovering: false,
  loggingIn: false,
  dialog: null,      // { type, props, resolve } — the open form dialog
  confirm: null,     // { title, description, confirmText, destructive, alert, resolve } — the open AlertDialog
  toolSearch: null,  // { board, focus, at, attach } — the open tool search (§7c): the board it serves (null: the document), the focus to return to, the selection as an assistant attachment
  toolOptions: null, // { entry, ctx } — the open options panel of a tool search entry (ctx: as toolSearch)
  notices: [],       // [{ id, icon, text, mode? }] — the fading notices above the toolbar island (§7c; Notices.jsx notify)
  quickTools: null,  // { board, x, y } — the open quick tools island (§7d): the board it serves (null: the document), the pointer it opened at
  tour: null,        // { step } — the open tour (Onboarding.jsx): the index of its shown step in STEPS
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
};

// This window is the background window of computer use (§7i Background window: main.js loads the app with ?worker=1&draft=<id>):
// it opens only that draft, saves only it and never writes settings.json.
const query = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
export const WORKER = query.get('worker') === '1';
export const WORKER_DRAFT = WORKER ? query.get('draft') : null;
// The smoke sample run (main.js loads the app with ?smoke=1 for `--smoke` without `--script`): no demo draft (actions.js init).
export const SMOKE = query.get('smoke') === '1';

const listeners = new Set();

export const getState = () => state;

export function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStore(selector) {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** The current editor; the calling component re-renders on every transaction and selection change. */
export function useEditor() {
  const editor = useStore((s) => s.editor);
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!editor) return undefined;
    editor.on('transaction', rerender);
    editor.on('selectionUpdate', rerender);
    return () => {
      editor.off('transaction', rerender);
      editor.off('selectionUpdate', rerender);
    };
  }, [editor]);
  return editor;
}

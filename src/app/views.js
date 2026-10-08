import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { canvasEditor } from '../canvas.js';
import { activeBoard, withoutScroll } from '../whiteboard.js';
import { closeSummoned, commitBoardEdit, saveNow, saveSettings } from './actions.js';
import { openBrowser } from './browser.js';
import { openFlows } from './flows.js';
import { openPlan } from './plans.js';
import { getState, setState } from './store.js';

// The main column (SPEC §7g) shows one page: the editor, or a workspace page in its place (the plan workspace or the
// flowchart library). The sidebar navigates between them. The editor page stays mounted behind a workspace (inert, its
// layout kept), so autosave, push and export keep working.

const state = getState();
const root = () => document.getElementById('workspace-root');

/** Shows the workspace `view` ({type: 'plan', planId, tab} | {type: 'flows', flowId}) in place of the editor, the focus in
 * it. `startup`: nothing to save yet; `remember: false` leaves `settings.lastView` as it is. Resolves false when the draft
 * could not be saved (the editor stays). */
export async function openWorkspace(view, { startup = false, remember = true } = {}) {
  closeSummoned(); // an open tool search or quick tools island would keep acting on the hidden document
  commitBoardEdit();
  canvasEditor.get()?.close(true);
  activeBoard.get()?.setMode(null);
  if (!startup && !(await saveNow())) return false;
  const ed = state.editor;
  if (ed?.state.selection instanceof NodeSelection) {
    // A selected board would stay the active board (rail, ribbon, keys) behind the workspace.
    const { tr } = ed.state;
    withoutScroll(() => ed.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to)))));
  }
  ed?.commands.blur();
  setState({ view });
  requestAnimationFrame(() => root()?.focus()); // once React has drawn it
  if (remember) await saveSettings({ lastView: view });
  return true;
}

/** Back to the editor, the focus in it (its selection restored, no scroll). */
export async function closeWorkspace({ remember = true } = {}) {
  commitBoardEdit(); // flushes the plan and flowchart writes
  setState({ view: { type: 'editor' } });
  requestAnimationFrame(() => state.editor?.view.focus()); // once the editor page is no longer inert
  if (remember) await saveSettings({ lastView: { type: 'editor' } });
}

/** Navigation (the sidebar's tabs and draft rows, Ctrl+Alt+P): shows the page `type` ('editor' | 'plan' | 'flows' | 'browser'); the
 * page already shown stays as it is (no toggle). */
export function showPage(type) {
  if (state.view.type === type) return undefined;
  if (type === 'editor') return closeWorkspace();
  return type === 'plan' ? openPlan() : type === 'browser' ? openBrowser() : openFlows();
}

/** Startup: the view of the last session (`settings.lastView`). The plan and flowchart stores fall back to the editor for
 * a plan or flowchart that no longer exists. */
export function restoreView(view) {
  if (view?.type === 'plan') return openPlan(view.planId, view.tab, { startup: true, remember: false });
  if (view?.type === 'flows') return openFlows(view.flowId, { startup: true, remember: false });
  if (view?.type === 'browser') return openBrowser(null, { startup: true, remember: false });
}

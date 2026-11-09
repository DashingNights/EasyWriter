// Views' state (docs/plans/word/plan.md §1.12, briefs/views.md): store word.view with the view to return to, the page movement
// (Vertical, Side to Side, Multiple Pages) that has no store field, and the editor area measures the Zoom dialog converts with.
import { fitSheet, setZoom } from '../../../app/actions.js';
import { getState, setState, useStore } from '../../../app/store.js';
import { pageOf } from '../../../formats.mjs';
import { geometryOf } from '../../geometry.js';
import { reveal } from '../navpane/plugin.js';
import { zoomFor } from './views.mjs';

// The views Esc, Edit Document and Close Reader leave, returning to the view before them (Word's).
const PASSING = new Set(['read', 'focus', 'immersive']);
let before = 'print';

/** Shows view `view` ('print' | 'web' | 'read' | 'outline' | 'draft' | 'focus' | 'immersive'). */
export function setView(view) {
  const word = getState().word;
  if (word.view === view) return;
  if (!PASSING.has(word.view)) before = word.view;
  if (view !== 'print') setMove('vertical');
  setState({ word: { ...word, view, readScreen: view === 'read' ? word.readScreen : null } });
  requestAnimationFrame(centre);
}

/** Centres the sheet across the editor area again (as the app's home view does), since a view changes the sheet's width. */
function centre() {
  const area = document.getElementById('editor-area');
  const wrap = document.getElementById('page-wrap');
  if (!area || !wrap) return;
  const a = area.getBoundingClientRect();
  const p = wrap.getBoundingClientRect();
  area.scrollLeft += p.left - a.left - (KEEP.left + Math.max(0, area.clientWidth - KEEP.left - KEEP.right - p.width) / 2);
}

/** Leaves Read Mode, Focus or the Reader for the view before it. */
export const leaveView = () => setView(PASSING.has(getState().word.view) ? before : 'print');

/** Enters `view`, or leaves it when it shows already (the ribbon's toggles). */
export const toggleView = (view) => (getState().word.view === view ? leaveView() : setView(view));

// ---------------------------------------------------------------------------------------------
// Page movement: {kind: 'vertical' | 'side' | 'multi', grid: {cols, rows}, first: 0-based first page shown, thumbs: Thumbnails}

// Kept in the store under its own key (no scaffold field holds it), so the ribbon's ctx follows it.
const START = { kind: 'vertical', grid: { cols: 2, rows: 1 }, first: 0, thumbs: false };
export const moveNow = () => getState().viewsMove ?? START;

/** Sets the page movement `kind` with `more` ({grid, first, thumbs}). Side to Side fits the pages to the window and switches the
 * zoom off (Word's, briefs/views.md): its Pages set the fitting zoom, and leaving it puts back the zoom from before (`zoomBefore`).
 * Back in Vertical the caret, which paging sideways or a double-click on a page moved, is scrolled into view. */
export function setMove(kind, more = {}) {
  const move = moveNow();
  const next = { ...move, ...more, kind };
  if (kind !== move.kind) next.thumbs = more.thumbs ?? false;
  if (kind === 'side' && move.kind !== 'side') next.zoomBefore = getState().zoom;
  if (JSON.stringify(next) === JSON.stringify(move)) return;
  setState({ viewsMove: next });
  if (kind !== 'vertical' || move.kind === 'vertical') return;
  if (move.kind === 'side' && move.zoomBefore != null) setZoom(move.zoomBefore);
  // Once the pages are laid out again (the white space and the zoom come back).
  const ed = getState().editor;
  if (ed) settled(ed, () => reveal(ed.view, ed.state.selection.head));
}

/** Calls `fn` once the page engine's geometry of `ed` has held still for two frames → cancel. A zoom or white space change lays
 * the pages out again over the next frames, replacing the geometry without a transaction: a page copy drawn, or a scroll to the
 * caret made, before that lands goes by the old page ends. */
export function settled(ed, fn) {
  let raf = 0;
  let last = null;
  let same = 0;
  const step = () => {
    const geo = geometryOf(ed.state);
    same = geo === last ? same + 1 : 0;
    last = geo;
    if (same >= 2) fn();
    else raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
/** Whether Side to Side shows, where the zoom commands are off. */
export const sideways = () => moveNow().kind === 'side';
/** React hook: the page movement. */
export const useMove = () => useStore(moveNow);

// ---------------------------------------------------------------------------------------------
// Zoom

// Room the app's home view keeps clear left and right of the sheet and above it (actions.js VIEW_LEFT, VIEW_RIGHT, VIEW_TOP).
export const KEEP = { left: 56, right: 24, top: 24 };

/** What the Zoom dialog converts with: the room the editor area shows in px, the paper and the text width (layout px). */
export function measure() {
  const area = document.getElementById('editor-area');
  const s = getState();
  const { paper, width } = pageOf(s.draft, s.settings, s.editor?.state.doc.attrs.sect);
  return {
    area: { w: (area?.clientWidth ?? 800) - KEEP.left - KEEP.right, h: (area?.clientHeight ?? 600) - 2 * KEEP.top },
    page: paper ? { w: paper.w, h: paper.h } : { w: width, h: width * 1.3 },
    text: paper ? paper.w - paper.left - paper.right : width,
  };
}

/** Applies a Zoom dialog result {kind, pct, grid}: Page width and Whole page as the base commands do, Text width with the text's left
 * edge at the view's, Many pages as Multiple Pages with that grid, anything else as a percent. */
export function applyZoom({ kind, pct, grid }) {
  if (kind === 'manyPages') return setMove('multi', { grid, first: 0 });
  setMove('vertical');
  if (kind === 'pageWidth' || kind === 'wholePage') return fitSheet(kind === 'wholePage');
  setZoom(kind === 'percent' ? pct : zoomFor(kind, measure()) ?? pct);
  if (kind === 'textWidth') {
    const area = document.getElementById('editor-area');
    const text = document.querySelector('#editor .ProseMirror');
    if (area && text) area.scrollLeft += text.getBoundingClientRect().left - area.getBoundingClientRect().left - KEEP.left;
  }
  return true;
}

// The Reviewing pane's registration (docs/plans/word plan.md §1.7): pane id 'reviewing', docked left (Vertical) or at the bottom
// (Horizontal). openPane reads PaneSpec.side, so the spec's side is a getter on the orientation picked last; settings.word.tracking
// paneSide keeps it across sessions.
import { getState } from '../../../app/store.js';
import { closePane, openPane } from '../../../tooling/panes.jsx';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { ReviewingPane } from './ReviewingPane.jsx';

let side = null; // 'left' | 'bottom' once picked in this session; until then settings.word.tracking.paneSide

const storedSide = () => side ?? wordSettings(getState().settings).tracking.paneSide;

/** The pane spec: the side follows the orientation picked last. */
export const REVIEWING = {
  title: 'Revisions',
  get side() {
    return storedSide() === 'bottom' ? 'bottom' : 'left';
  },
  get width() {
    return this.side === 'bottom' ? 12 : 20;
  },
  Component: ReviewingPane,
};

/** The side the Reviewing pane is open on ('left' or 'bottom'), or null when closed. */
export function paneSideNow() {
  const open = getState().panes ?? {};
  return open.left === 'reviewing' ? 'left' : open.bottom === 'reviewing' ? 'bottom' : null;
}

/** Shows the Reviewing pane as `to` ('left' Vertical, 'bottom' Horizontal) or closes it ('off'); a new orientation is saved. */
export function setReviewingPane(to) {
  if (to === 'off') return closePane('reviewing');
  if (paneSideNow() === to) return undefined;
  closePane('reviewing');
  side = to;
  if (wordSettings(getState().settings).tracking.paneSide !== to) saveWord({ tracking: { paneSide: to } });
  return openPane('reviewing');
}

/** The Reviewing Pane button: opens the pane in the orientation used last, or closes it. */
export const toggleReviewingPane = () => setReviewingPane(paneSideNow() ? 'off' : REVIEWING.side);

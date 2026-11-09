// Word's status bar (docs/plans/word/briefs/statusbar.md): the bar the app's status bar shows for a Document, and one command per
// Customize Status Bar item, so tool search reaches each check: run shows or hides the item (the Zoom Slider with a percent sets
// the zoom, as base's command did), active says whether it shows. statusBar.customize opens the checklist over the bar.
import { setZoom } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { wordSettings } from '../../word/settings.mjs';
import { countParagraph, countText } from './count.mjs';
import { docCounts } from './docCount.mjs';
import { ITEMS } from './items.mjs';
import { customize, toggleItem, WordStatusBar } from './WordStatusBar.jsx';

const shown = (key) => !!wordSettings(getState().settings).statusBar[key];

const commands = Object.fromEntries(ITEMS.map(({ key, label }) => [`statusBar.${key}`, {
  run: (_ctx, arg) => {
    // Side to Side (views, store viewsMove) switches the zoom off, as Word does.
    if (key === 'zoomSlider' && Number.isFinite(arg)) return getState().viewsMove?.kind === 'side' ? false : (setZoom(arg), true);
    toggleItem(key, getState().settings);
    return true;
  },
  active: () => shown(key),
  label: `Show ${label} on the status bar`,
  ...(key === 'zoomSlider' && { value: () => getState().zoomPct }),
}]));

commands['statusBar.customize'] = {
  run: () => {
    const r = document.querySelector('[data-statusbar]')?.getBoundingClientRect();
    return r ? customize.open({ x: r.left + 8, y: r.top }) : false;
  },
  enabled: () => !!document.querySelector('[data-statusbar]'),
};

// Harness seam: the counts the bar shows, so a case can compare them with the rule.
if (typeof window !== 'undefined') {
  window.__word = Object.assign(window.__word ?? {}, {
    statusBar: {
      counts: () => {
        const ed = getState().editor;
        return ed ? docCounts(ed.state.doc, wordSettings(getState().settings).tracking.display) : null;
      },
      countText,
      countParagraph,
    },
  });
}

export default {
  id: 'statusbar',
  commands,
  slots: { statusBar: WordStatusBar },
};

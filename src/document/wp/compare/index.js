// Work package compare (docs/plans/word plan.md §3 compare, briefs/compare.md): Review > Compare (Compare..., Combine..., Show
// Source Documents) and File > Info > Version History. The differences of a comparison are agent-style suggestions (run.js), so the
// Review tab's Accept, Reject, Previous and Next resolve them.
import { createElement as h } from 'react';
import { getState } from '../../../app/store.js';
import { closePane, openPane, paneOpen } from '../../../tooling/panes.jsx';
import { CompareDialog } from './CompareDialog.jsx';
import { HistoryPane } from './HistoryPane.jsx';
import { compareDrafts, sources } from './run.js';
import { SourcesPane } from './SourcesPane.jsx';

const SHOW = 'review.compare.compare.showSourceDocuments';
// Show Source Documents' submenu (probe: Hide Source Documents, Show Original, Show Revised, Show Both).
const SOURCE_ITEMS = [['hide', 'Hide Source Documents'], ['original', 'Show Original'], ['revised', 'Show Revised'], ['both', 'Show Both']];
let shown = 'both'; // the submenu's current item while the pane is open

const hasSources = () => sources.has(getState().draft?.id);

async function start(ctx, kind) {
  const r = await ctx.dialog(kind === 'combine' ? 'combineDocuments' : 'compareDocuments');
  return r ? compareDrafts(r, kind) : false;
}

function showSources(which = 'both') {
  if (which === 'hide') return closePane('sources');
  shown = which;
  openPane('sources', { show: which });
}

export default {
  id: 'compare',
  commands: {
    'review.compare.compare.compare': { run: (ctx) => start(ctx, 'compare') },
    'review.compare.compare.combine': { run: (ctx) => start(ctx, 'combine') },
    [SHOW]: {
      run: (_ctx, arg) => showSources(arg ?? 'both'),
      enabled: hasSources,
      reason: () => 'Compare or combine two documents first.',
      value: () => (paneOpen('sources') ? shown : 'hide'),
    },
    'file.info.versionHistory': { run: () => openPane('versionHistory') },
  },
  galleries: {
    [SHOW]: () => {
      const now = paneOpen('sources') ? shown : 'hide';
      return SOURCE_ITEMS.map(([id, label]) => ({ id, label, active: id === now }));
    },
  },
  dialogs: {
    compareDocuments: (p) => h(CompareDialog, { ...p, kind: 'compare' }),
    combineDocuments: (p) => h(CompareDialog, { ...p, kind: 'combine' }),
  },
  panes: {
    versionHistory: { title: 'Version History', side: 'right', width: 20, Component: HistoryPane },
    sources: { title: 'Source Documents', side: 'right', width: 22, Component: SourcesPane },
  },
  // The Compare dropdown works through its menu items.
  implements: ['review.compare.compare'],
};

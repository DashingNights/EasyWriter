// navpane: Word's Navigation pane (docs/plans/word/briefs/navpane.md). The pane 'navigation' (NavPane.jsx, replacing base's; on a
// canvas draft CanvasNav.jsx), the Find Options dialog, collapsible headings in the text (on a canvas draft the triangles of
// folds.jsx over the page), and the commands that open the pane and collapse headings.
import { getState, setState } from '../../../app/store.js';
import { closePane, openPane, paneOpen } from '../../../tooling/panes.jsx';
import { NavigationPane } from './CanvasNav.jsx';
import { FindOptions } from './FindOptions.jsx';
import './folds.jsx'; // the fold triangles beside headings on a canvas draft
import { headingAtCaret, NavPaneText, setAllCollapsed, setCollapsed } from './plugin.js';

// What find's home.editing.find does for Ctrl+F (plan.md §1.12 navSearch): open the pane and ask it to focus its box holding
// `seed` and search. Harness cases reach it as window.__word.navSearch until find lands.
export function askSearch(seed) {
  openPane('navigation');
  const word = getState().word;
  setState({ word: { ...word, navSearch: { n: (word.navSearch?.n ?? 0) + 1, seed, at: Date.now() } } });
}
if (typeof window !== 'undefined') window.__word = Object.assign(window.__word ?? {}, { navSearch: askSearch });

const toggle = () => (paneOpen('navigation') ? closePane('navigation') : openPane('navigation'));
const onHeading = (op) => ({
  run: (ctx) => !!ctx.ed && setCollapsed(ctx.ed.view, headingAtCaret(ctx.ed.state), op),
  enabled: (ctx) => !!ctx.ed,
});

export default {
  id: 'navpane',
  extensions: [NavPaneText],
  panes: { navigation: { title: 'Navigation', side: 'left', width: 18, Component: NavigationPane } },
  dialogs: { findOptions: FindOptions },
  commands: {
    'view.show.navigationPane': { run: toggle, active: () => paneOpen('navigation') },
    'review.accessibility.checkAccessibility.navigationPane': { run: toggle, active: () => paneOpen('navigation') },
    'navPane.expandHeading': onHeading('expand'),
    'navPane.collapseHeading': onHeading('collapse'),
    'navPane.toggleHeading': onHeading('toggle'),
    // The text's right-click menu (context-menu's): Expand or Collapse Heading at the caret, Expand or Collapse All Headings.
    'navPane.collapsibleHeadings': {
      run: (ctx, arg = 'toggle') => {
        if (!ctx.ed) return false;
        if (arg === 'expandAll' || arg === 'collapseAll') return setAllCollapsed(ctx.ed.view, arg === 'collapseAll') ?? true;
        return setCollapsed(ctx.ed.view, headingAtCaret(ctx.ed.state), arg);
      },
      enabled: (ctx) => !!ctx.ed,
    },
    // Paragraph > Line and Page Breaks > Collapsed by default (the dialog's box is paragraph's): w15:collapsed on the paragraph.
    'paragraph.collapsedByDefault': {
      run: (ctx) => ctx.chain((c) => c.setParaProps({ collapsed: ctx.state.selection.$from.parent.attrs.collapsed ? null : true })),
      active: (ctx) => !!ctx.state?.selection.$from.parent.attrs.collapsed,
      enabled: (ctx) => !!ctx.state,
    },
  },
  implements: ['navPane', 'navPane.search', 'navPane.searchMenu', 'navPane.findOptions', 'navPane.headings', 'navPane.dragHeadings',
    'navPane.headingsMenu', 'navPane.pages', 'navPane.results'],
};

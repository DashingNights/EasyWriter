// ribbon-chrome (docs/plans/word briefs/ribbon-chrome.md): KeyTips, the ribbon's keyboard, Ribbon Display Options, the Quick
// Access Toolbar's menu and position, the Customize Ribbon and Quick Access Toolbar Options pages, F6 focus cycling and the
// pane menu. The renderer's own part (adaptive groups, the display options button, the QAT's position KeyTips) lives in
// src/tooling/ribbon; this module holds the Word-side commands and the window keys.
import { createElement as h, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FilePlus, FileSearch, FolderOpen, Hand, PencilRuler, Printer } from 'lucide-react';
import { getState } from '../../../app/store.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { addControls } from '../../../tooling/ribbon/extra.mjs';
import { activeTab, cycleFocus } from './focus.js';
import { installKeys, KeyTipsLayer, toggleKeytips } from './KeyTips.jsx';
import { CustomizeRibbonPage, QatPage } from './Pages.jsx';
import { openPaneMenu, PaneMenuLayer } from './PaneMenu.jsx';
import { QatMenu } from './QatMenu.jsx';
import { followSettings, ribbonPrefs, saveRibbon } from './state.js';

// The Quick Access Toolbar's buttons that no ribbon control draws (its customise menu adds them), as small controls.
const small = (id, label, icon, tip, more = {}) => ({ id, type: 'button', size: 'small', label, icon, tip, ...more });
addControls({
  'file.new': small('file.new', 'New', FilePlus, 'Starts a new draft.'),
  'file.open': small('file.open', 'Open', FolderOpen, 'Opens a draft.'),
  'print.quickPrint': small('print.quickPrint', 'Quick Print', Printer, 'Prints the document on the default printer as it is set up.'),
  'file.print': small('file.print', 'Print Preview and Print', FileSearch, 'Shows the print preview with the print settings.'),
  'insert.tables.table.drawTable': small('insert.tables.table.drawTable', 'Draw Table', PencilRuler, 'Draws table cells with the pointer.'),
  'frame.qat.touchMouseMode': small('frame.qat.touchMouseMode', 'Touch/Mouse Mode', Hand, 'Spaces the ribbon for a mouse or for touch.',
    { type: 'dropdown', menu: 'frame.qat.touchMouseMode' }),
});

/** Opens Word Options at page `tab`, when the options package has its dialog; else says it is not built yet. */
async function openOptions(ctx, tab) {
  const { WORD_DIALOGS } = await import('../../../tooling/dialogs.js');
  if (!WORD_DIALOGS.wordOptions) return ctx.toast(REASONS.pending);
  return ctx.dialog('wordOptions', { tab });
}

/** The pane holding the focus, else the first one open. */
const paneNow = () => (document.activeElement?.closest?.('[data-pane]') ?? document.querySelector('[data-pane]'))?.dataset.pane ?? null;

const display = () => ribbonPrefs().display;

/** Collapse the Ribbon and its keys (Ctrl+F1, a double-click on a tab, the pin): Show tabs only or Always show Ribbon, saved. */
const collapse = () => saveRibbon({ display: display() === 'tabs' ? 'always' : 'tabs' });

const COMMANDS = {
  'frame.tabRow.collapse': { run: collapse, active: () => display() === 'tabs' },
  'frame.tabRow.ribbonDisplayOptions.showTabsOnly': { run: () => saveRibbon({ display: 'tabs' }), active: () => display() === 'tabs' },
  'frame.tabRow.ribbonDisplayOptions.alwaysShowRibbon': { run: () => saveRibbon({ display: 'always' }), active: () => display() === 'always' },
  'frame.tabRow.ribbonDisplayOptions.hideQuickAccessToolbar': {
    run: () => saveRibbon({ qatHidden: !ribbonPrefs().qatHidden }),
    label: () => (ribbonPrefs().qatHidden ? 'Show Quick Access Toolbar' : 'Hide Quick Access Toolbar'),
  },
  'frame.qat.touchMouseMode': {
    run: (_ctx, arg) => saveRibbon({ touch: arg == null ? !ribbonPrefs().touch : arg === 'touch' }),
    active: () => !!ribbonPrefs().touch,
    value: () => (ribbonPrefs().touch ? 'touch' : 'mouse'),
  },
  'keytips.alt': { run: () => toggleKeytips() },
  'keytips.tooltip': {
    run: () => {
      const el = document.activeElement;
      if (!el?.closest?.('[data-ribbon]')) return false;
      el.blur();
      el.focus({ preventScroll: true }); // a ribbon control's tooltip opens on keyboard focus
      return true;
    },
  },
  'panes.nextPane': { run: () => cycleFocus(1) },
  'panes.prevPane': { run: () => cycleFocus(-1) },
  'panes.paneMenu': { run: () => (paneNow() ? openPaneMenu(paneNow()) : false) },
  'options.customizeRibbon': { run: (ctx) => openOptions(ctx, 'customizeRibbon') },
  'options.qat': { run: (ctx) => openOptions(ctx, 'qat') },
};

/** Touch/Mouse Mode's two choices, for its button on the Quick Access Toolbar. */
const touchModes = () => {
  const touch = !!ribbonPrefs().touch;
  return [{ id: 'mouse', label: 'Mouse', desc: 'Standard ribbon and commands', active: !touch }, { id: 'touch', label: 'Touch', desc: 'More space between commands', active: touch }];
};

/** The badges and the pane menu, drawn through portals from the slot under the ribbon (also while the ribbon is hidden). */
const Layers = () => h(Fragment, null, h(KeyTipsLayer), h(PaneMenuLayer));

export default {
  id: 'ribbon-chrome',
  commands: COMMANDS,
  panels: { 'frame.qat.customize': QatMenu },
  galleries: { 'frame.qat.touchMouseMode': touchModes },
  options: { customizeRibbon: CustomizeRibbonPage, qat: QatPage },
  slots: { belowRibbon: Layers },
  implements: ['frame.qat.customize', 'frame.tabRow.ribbonDisplayOptions', 'frame.tabRow.collapsedGroups', 'keytips.navigation', 'keytips.groupKeyTips',
    'window.toggleRibbonKey'],
  setup() {
    const keys = installKeys();
    const settings = followSettings();
    return () => {
      keys();
      settings();
    };
  },
};

const PAGES = { customizeRibbon: CustomizeRibbonPage, qat: QatPage };

// Harness cases: the tab holding the ribbon's focus, the store's word fields, and an Options page mounted on its own while the
// options package's dialog is not there yet.
if (typeof window !== 'undefined') {
  window.__word = Object.assign(window.__word ?? {}, {
    ribbonChrome: {
      focusTab: () => activeTab()?.dataset.tab ?? null,
      word: () => getState().word,
      mountPage: (id, host) => {
        const root = createRoot(host);
        root.render(h(TooltipProvider, null, h(PAGES[id])));
        return () => root.unmount();
      },
    },
  });
}

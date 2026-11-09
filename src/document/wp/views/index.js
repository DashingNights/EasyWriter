// Work package views (docs/plans/word/plan.md §3 views, briefs/views.md): the View tab's views (Read Mode, Print Layout, Web
// Layout, Draft, Focus and the Reader tab), Page Movement, the Zoom group and dialog, Switch Windows with the next and previous
// draft keys, Close Pane and the ribbon's full-screen mode. store word.view drives each one: the ribbon mount writes it on
// #editor-area as data-word-view, which style.css and pagination key on. Outline is the outline package's.
import { draftGroups, fitSheet, openDraft, setZoom } from '../../../app/actions.js';
import { getState } from '../../../app/store.js';
import { closePane } from '../../../tooling/panes.jsx';
import { areaOpens } from '../../../tooling/surface.js';
import { geometryOf } from '../../geometry.js';
import { saveWord } from '../../word/settings.mjs';
import { bindEsc, ViewsSlot } from './Slot.jsx';
import { applyZoom, leaveView, moveNow, setMove, setView, sideways, toggleView } from './state.js';
import { canvasCaret } from './canvas.mjs';
import { Syllables } from './syllables.js';
import { nextDraft, windowList } from './views.mjs';
import { ZoomDialog } from './ZoomDialog.jsx';

const view = (id) => ({ run: () => setView(id), active: (ctx) => ctx.view === id });
const toggle = (id) => ({ run: () => toggleView(id), active: (ctx) => ctx.view === id });
const inPrint = (ctx) => ctx.view === 'print';
const PRINT_ONLY = 'Shows only in Print Layout.';
// Word switches the zoom off in Side to Side: the pages fit the window, and Vertical brings the zoom back.
const zooms = () => !sideways();
const NO_ZOOM = 'Side to Side fits the pages to the window. Choose Vertical to zoom.';
/** The caret's page (0-based), where Side to Side opens: on a canvas draft the engine's. */
const caretPage = () => (areaOpens(getState()) ? canvasCaret()?.page : getState().editor && geometryOf(getState().editor.state)?.page) || 0;

/** A Reader setting `key` of settings.word.immersive picked from a gallery of `items` ([[id, label]]). */
function readerList(key, items) {
  const id = `immersiveReader.immersiveReader.${key}`;
  return {
    command: {
      [id]: {
        run: (ctx, arg) => (items.some(([v]) => String(v) === String(arg)) ? saveWord({ immersive: { [key]: items.find(([v]) => String(v) === String(arg))[0] } }) : false),
        value: (ctx) => String(ctx.settings.word.immersive[key]),
      },
    },
    gallery: { [id]: (ctx) => items.map(([v, label]) => ({ id: String(v), label, active: ctx.settings.word.immersive[key] === v })) },
  };
}
const readerToggle = (key) => ({
  run: (ctx) => saveWord({ immersive: { [key]: !ctx.settings.word.immersive[key] } }),
  active: (ctx) => !!ctx.settings.word.immersive[key],
});

// Immersive Reader's menus (Word's items). 'default' keeps the page's text width; ponytail: Page Color has None, Sepia and Inverse,
// not Word's further screen colours.
const COLUMN_WIDTH = readerList('columnWidth', [['veryNarrow', 'Very Narrow'], ['narrow', 'Narrow'], ['moderate', 'Moderate'], ['wide', 'Wide'], ['default', 'Default']]);
const PAGE_COLOR = readerList('pageColor', [['none', 'None'], ['sepia', 'Sepia'], ['inverse', 'Inverse']]);
const LINE_FOCUS = readerList('lineFocus', [[0, 'None'], [1, 'One Line'], [3, 'Three Lines'], [5, 'Five Lines']]);

/** The project's drafts in the sidebar's order: each folder's, then those in no folder. */
const ordered = () => {
  const { groups, loose } = draftGroups();
  return [...groups.flatMap((g) => g.drafts), ...loose];
};
const openNext = (step) => {
  const id = nextDraft(ordered(), getState().draft?.id, step);
  return id ? openDraft(id) : false;
};

/** Alt+Shift+C: closes the pane holding the focus, else the right pane, else the left one, else the bottom one. */
function closeOnePane() {
  const own = document.activeElement?.closest?.('[data-pane]')?.dataset.pane;
  const { left, right, bottom } = getState().panes;
  const id = own ?? right ?? left ?? bottom;
  if (!id) return false;
  closePane(id);
  return true;
}

const COMMANDS = {
  'view.views.readMode': toggle('read'),
  'view.views.printLayout': view('print'),
  'view.views.webLayout': view('web'),
  'view.views.draft': view('draft'),
  'view.immersive.focus': toggle('focus'),
  'review.accessibility.checkAccessibility.focus': toggle('focus'),
  'view.immersive.immersiveReader': toggle('immersive'),
  'immersiveReader.close.closeImmersiveReader': { run: () => leaveView() },
  ...COLUMN_WIDTH.command,
  ...PAGE_COLOR.command,
  ...LINE_FOCUS.command,
  'immersiveReader.immersiveReader.textSpacing': readerToggle('textSpacing'),
  'immersiveReader.immersiveReader.syllables': readerToggle('syllables'),

  'view.pageMovement.vertical': { run: () => setMove('vertical'), active: (ctx) => !inPrint(ctx) || moveNow().kind !== 'side' },
  'view.pageMovement.sideToSide': {
    run: () => setMove('side', { first: caretPage() }), active: (ctx) => inPrint(ctx) && moveNow().kind === 'side', enabled: inPrint, reason: () => PRINT_ONLY,
  },
  'views.thumbnails': {
    run: () => setMove('side', { thumbs: !moveNow().thumbs }), active: () => moveNow().kind === 'side' && moveNow().thumbs,
    enabled: (ctx) => inPrint(ctx) && moveNow().kind === 'side', reason: () => 'Shows with Side to Side.',
  },

  'view.zoom.zoom': {
    run: async (ctx) => {
      const r = await ctx.dialog('zoom');
      return r ? applyZoom(r) : false;
    },
    enabled: zooms, reason: () => NO_ZOOM,
  },
  // The base zoom commands, also leaving Multiple Pages.
  'view.zoom.zoom100': { run: () => (setMove('vertical'), setZoom(100)), enabled: zooms, reason: () => NO_ZOOM },
  'view.zoom.onePage': { run: () => (setMove('vertical'), fitSheet(true)), enabled: zooms, reason: () => NO_ZOOM },
  'view.zoom.pageWidth': { run: () => (setMove('vertical'), fitSheet(false)), enabled: zooms, reason: () => NO_ZOOM },
  'view.zoom.multiplePages': {
    run: () => setMove('multi', { grid: { cols: 2, rows: 1 }, first: 0 }), enabled: (ctx) => inPrint(ctx) && zooms(),
    reason: (ctx) => (inPrint(ctx) ? NO_ZOOM : PRINT_ONLY),
  },

  'view.window.switchWindows': { run: (_ctx, id) => (ordered().some((d) => d.id === id) ? openDraft(id) : false) },
  'window.nextWindow': { run: () => openNext(1) },
  'window.prevWindow': { run: () => openNext(-1) },
  'views.closePane': { run: () => closeOnePane() },

  // Word's full-screen mode hides the ribbon until the pointer reaches the top edge. Inside the page area only (direction.md 6): the
  // window itself never goes full screen, so the title strip stays.
  'frame.tabRow.ribbonDisplayOptions.fullScreenMode': {
    run: () => saveWord({ ribbon: { display: 'fullscreen' } }), active: (ctx) => ctx.settings.word.ribbon.display === 'fullscreen',
  },
};

const GALLERIES = {
  ...COLUMN_WIDTH.gallery,
  ...PAGE_COLOR.gallery,
  ...LINE_FOCUS.gallery,
  'view.window.switchWindows': () => windowList(ordered(), getState().draft?.id),
};

// For harness cases: the screen Read Mode shows (store word.readScreen) and the Word settings writer.
if (typeof window !== 'undefined') window.__wordViews = { readScreen: () => getState().word.readScreen, saveWord, order: () => ordered().map((d) => d.id) };

export default {
  id: 'views',
  extensions: [Syllables],
  commands: COMMANDS,
  galleries: GALLERIES,
  dialogs: { zoom: ZoomDialog },
  slots: { viewport: ViewsSlot },
  // Read Mode's menus and paging, object zoom and the draft font are behaviours of the views; the view keys are keymap rows
  // running the view commands.
  implements: ['views.readModeMenus', 'views.readModePaging', 'views.objectZoom', 'views.draftFont', 'keys.viewKeys'],
  setup: () => bindEsc(leaveView),
};

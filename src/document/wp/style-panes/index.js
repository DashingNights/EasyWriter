// Work package style-panes (docs/plans/word plan.md §3, briefs/style-panes.md): the Styles pane, Apply Styles, the Style
// Inspector, Reveal Formatting, Manage Styles, the Organizer, Select All instances and the style area. The style engine, the
// gallery and the Modify and Create New Style dialogs are styles'; this package reaches them only through their command and dialog
// ids (styles.updateToMatch, modifyStyle, createNewStyleFromFormatting); the multiple selection is editing-keys' (x.selection.multi).
import { createElement as h } from 'react';
import { paneOpen } from '../../../tooling/panes.jsx';
import { CanvasApplyStylesPane, CanvasInspectorPane, CanvasRevealPane, CanvasStylesPane } from './canvas.jsx';
import { AssignValueDialog, ManageStylesDialog, OrganizerDialog, StylePaneOptionsDialog, StyleQuestionDialog } from './Dialogs.jsx';
import { selectInstances } from './ops.js';
import { ApplyStylesPane, RevealFormattingPane, StyleInspectorPane } from './OtherPanes.jsx';
import { StyleArea } from './style-area.js';
import { StylesPane } from './StylesPane.jsx';

const toggle = (id) => ({ run: (ctx) => ctx.pane(id), active: () => paneOpen(id) });
/** A pane that draws its canvas form on a canvas draft (canvas.jsx reads the engine). */
const either = (Dom, Canvas) => (p) => h(p.ctx?.engine ? Canvas : Dom, p);

export default {
  id: 'style-panes',
  extensions: [StyleArea],
  panes: {
    styles: { title: 'Styles', side: 'right', width: 16, Component: either(StylesPane, CanvasStylesPane) },
    applyStyles: { title: 'Apply Styles', side: 'left', width: 15, Component: either(ApplyStylesPane, CanvasApplyStylesPane) },
    styleInspector: { title: 'Style Inspector', side: 'left', width: 17, Component: either(StyleInspectorPane, CanvasInspectorPane) },
    revealFormatting: { title: 'Reveal Formatting', side: 'right', width: 18, Component: either(RevealFormattingPane, CanvasRevealPane) },
  },
  commands: {
    'home.styles.launcher': toggle('styles'),
    // Ctrl+Shift+S with the box open focuses it again (Word's behaviour); n changes so the pane refocuses.
    'home.styles.styles.applyStyles': { run: (ctx) => ctx.pane('applyStyles', true, { n: Date.now() }), active: () => paneOpen('applyStyles') },
    'styles.inspector': toggle('styleInspector'),
    'panes.revealFormatting': toggle('revealFormatting'),
    'styles.manage': { run: (ctx, tab) => ctx.dialog('manageStyles', typeof tab === 'string' ? { tab } : {}) },
    'styles.organizer': { run: (ctx) => ctx.dialog('organizer') },
    'styles.selectAllInstances': { run: (ctx, id) => (id ? selectInstances(ctx, id) > 0 : false), enabled: (ctx) => !!ctx.target },
  },
  dialogs: {
    manageStyles: ManageStylesDialog,
    organizer: OrganizerDialog,
    stylePaneOptions: StylePaneOptionsDialog,
    assignStyleValue: AssignValueDialog,
    styleQuestion: StyleQuestionDialog,
  },
  // The two keys are Word's chords for the launcher and Apply Styles (keymap.mjs binds them to those commands); the style area
  // is a view behaviour.
  implements: ['keys.stylesPaneKey', 'keys.applyStylesKey', 'views.styleArea'],
};

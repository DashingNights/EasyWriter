// protect (docs/plans/word/briefs/protect.md): Restrict Editing with formatting and editing restrictions, exceptions and an
// optional hashed password; one enforcement filter for protection, the Viewing mode, a session opened read-only and Mark as
// Final; File > Info > Protect Document.
import { confirmDialog } from '../../../app/actions.js';
import { getState, setState } from '../../../app/store.js';
import { paneOpen } from '../../../tooling/panes.jsx';
import { setSession, writeProtected } from './act.js';
import { AddUsers, FormattingRestrictions, ProtectDocument, SectionProtection } from './dialogs.jsx';
import { FinalBar, markFinal, protectDesc, ProtectDocumentPanel } from './Info.jsx';
import { RestrictEditingPane } from './Pane.jsx';
import { ProtectFilter } from './plugin.js';

if (typeof window !== 'undefined') {
  // Harness seams: store word.mode until tracking's mode menu writes it (_gaps-tracking.md G3 fallback), and Mark as Final until
  // backstage's Info page draws the Protect Document panel.
  window.__word = Object.assign(window.__word ?? {}, {
    protect: { mode: (mode) => setState({ word: { ...getState().word, mode } }), markFinal: () => getState().editor && markFinal(getState().editor) },
  });
}

export default {
  id: 'protect',
  extensions: [ProtectFilter],
  commands: {
    'review.protect.restrictEditing': {
      run: (ctx) => ctx.pane('restrictEditing'),
      enabled: (ctx) => !!ctx.ed || !!ctx.engine,
      active: () => paneOpen('restrictEditing'),
    },
    // The Info page's Protect Document button; its menu is panels['file.info.protectDocument'].
    'file.info.protectDocument': {
      run: (ctx) => ctx.pane('restrictEditing', true),
      enabled: (ctx) => !!ctx.ed || !!ctx.engine,
      desc: protectDesc,
    },
  },
  panes: { restrictEditing: { title: 'Restrict Editing', side: 'right', width: 18, Component: RestrictEditingPane } },
  dialogs: { protectDocument: ProtectDocument, formattingRestrictions: FormattingRestrictions, addUsers: AddUsers, sectionProtection: SectionProtection },
  panels: { 'file.info.protectDocument': ProtectDocumentPanel },
  slots: { belowRibbon: FinalBar },
  implements: ['review.protect', 'developer.protect'],
  // Always Open Read-Only: asks once when the Document opens; yes makes this session read-only.
  setup(editor) {
    if (!writeProtected(editor)) return;
    const t = setTimeout(async () => {
      const yes = await confirmDialog({ title: 'Open read-only?', description: 'The author would like you to open this document read-only unless you need to change it.',
        confirmText: 'Open read-only' });
      if (yes && !editor.isDestroyed) setSession(editor, { session: true });
    });
    return () => clearTimeout(t);
  },
};

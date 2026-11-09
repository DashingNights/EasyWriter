// options: Word's Options dialog (docs/plans/word/briefs/options.md). File > Options opens it; other packages open it on a page and
// section with {tab, section} (Set Default Paste: {tab: 'advanced', section: 'paste'}). Customize Keyboard leaves for the app's
// Settings at Keybinds, which holds EasyWriter's keyboard shortcuts.
import { FontSubstitution } from '../../fonts/FontSubstitution.jsx';
import { leaveForSettings, OptionsDialog } from './OptionsDialog.jsx';

export default {
  id: 'options',
  dialogs: { wordOptions: OptionsDialog, fontSubstitution: FontSubstitution },
  commands: {
    'file.options': { run: (ctx, props) => { ctx.dialog('wordOptions', props ?? {}); return true; } },
    'options.customizeKeyboard': { run: () => { leaveForSettings('keybinds'); return true; } },
  },
  // The built-in pages and the two options the dialog itself delivers.
  implements: ['options.general', 'options.display', 'options.proofing', 'options.save', 'options.language', 'options.accessibility',
    'options.advanced', 'options.measurementUnit', 'options.compatibility'],
};

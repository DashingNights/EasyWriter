// The font work package (docs/plans/word/briefs/font.md, plan.md §3 font): the Font group, the Font, Format Text Effects and
// Phonetic Guide dialogs, the run properties' drawing and Word's character keys.
import { COMMANDS, GALLERIES, IMPLEMENTS } from './commands.js';
import { FontKit } from './extension.js';
import { FontDialog } from './FontDialog.jsx';
import { PhoneticGuide } from './PhoneticGuide.jsx';
import { TextEffectsDialog } from './TextEffectsDialog.jsx';

export default {
  id: 'font',
  extensions: [FontKit],
  commands: COMMANDS,
  galleries: GALLERIES,
  dialogs: { font: FontDialog, phoneticGuide: PhoneticGuide, formatTextEffects: TextEffectsDialog },
  implements: IMPLEMENTS,
};

// Work package autocorrect (docs/plans/word plan.md §3): AutoCorrect and AutoFormat As You Type in Documents, the AutoCorrect
// Options button, AutoFormat now (Ctrl+Alt+K) and the AutoCorrect dialog. The rules are pure (rules.mjs); plugin.js runs them on typed
// input; button.js draws the button; Dialog.jsx is the dialog. Math AutoCorrect is equations' panel, list triggers are lists'.
import { AutoCorrectDialog, ExceptionsDialog } from './Dialog.jsx';
import { AutoCorrect, autoFormatNow, word } from './plugin.js';
import { hooks } from '../../canvas/rows/home.mjs';
import { canvasPlan } from './canvas.mjs';

// AutoFormat Now on a canvas draft plans with the same rules and options (rows/home.mjs).
hooks.autoFormatPlan = (paras) => canvasPlan(paras, word().autoformatNow);

export default {
  id: 'autocorrect',
  extensions: [AutoCorrect],
  commands: {
    'autocorrect.dialog': {
      run: (c, arg) => {
        c.dialog('autoCorrect', arg ?? {}); // the dialog saves on OK; the command does not wait for it
        return true;
      },
    },
    'autoformat.autoFormatNow': { run: (c) => !!c.target && autoFormatNow(c.target), enabled: (c) => !!c.target?.isEditable },
  },
  dialogs: { autoCorrect: AutoCorrectDialog, autoCorrectExceptions: ExceptionsDialog },
  implements: [
    'autocorrect.optionsButton', 'autocorrect.twoInitialCaps', 'autocorrect.capitalizeSentences', 'autocorrect.capitalizeCells',
    'autocorrect.capitalizeDays', 'autocorrect.capsLock', 'autocorrect.replaceText', 'autocorrect.spellingSuggestions',
    'autoformat.smartQuotes', 'autoformat.ordinals', 'autoformat.fractions', 'autoformat.dashes', 'autoformat.boldItalic',
    'autoformat.hyperlinks', 'autoformat.bulletedLists', 'autoformat.numberedLists', 'autoformat.borderLines', 'autoformat.tables',
    'autoformat.headingStyles', 'autoformat.listFormatLikePrevious',
  ],
};

// Spelling, word count, Read Aloud, accessibility and language (docs/plans/word plan.md §3 proofing, briefs/proofing.md): Review >
// Proofing, Speech, Accessibility and Language over Chromium's spell checker and speechSynthesis. The Spelling pane (F7), Alt+F7,
// Word Count with Word's counting rules, Read Aloud, the Accessibility pane, the Thesaurus and the Language dialogs. The canvas
// engine's spelling and grammar check backs the Spelling and Grammar command; grammar squiggles as you type, Editor, Translate and
// Update IME Dictionary stay placeholders (the spec's needs).
import { getState } from '../../../app/store.js';
import { paneOpen } from '../../../tooling/panes.jsx';
import { A11yPane, issuesFor } from './A11yPane.jsx';
import { tally } from './a11y.mjs';
import { openSpellMenu, ProofingBar } from './Bar.jsx';
import { LanguageDialog, LanguagePreferencesDialog, ReadabilityDialog, WordCountDialog, wordCount } from './dialogs.jsx';
import { onceOf, ProofingMarks, tell } from './plugin.js';
import { ReadAloudKeys, readState, start, stop } from './readaloud.js';
import { endSpell } from './session.js';
import { flaggedCount, nextFlagged, refreshLanguages, spellApi, suggest } from './spell.js';
import { SpellPane } from './SpellPane.jsx';
import { ThesaurusPane } from './ThesaurusPane.jsx';
import './canvas.js'; // the Review rows' spelling and Read Aloud on a canvas draft

let flagged = 0; // flagged words of the open Document, counted a moment after each edit (the status bar's proofing value)
let runs = 0; // bumps per F7, so the open pane starts a new check
let counts = 0; // bumps per flagged-word count started

/** Opens the Spelling pane and starts a check from the selection. */
const spelling = (ctx) => {
  if (!ctx.ed) return false;
  ctx.pane('spelling', true, { n: ++runs });
  return true;
};

/** Alt+F7: selects the next flagged word after the caret (wrapping to the start) and opens its menu; with none left, a toast. */
async function nextMisspelling(ctx) {
  const ed = ctx.ed;
  if (!ed) return false;
  const { state } = ed;
  const at = state.selection.to;
  const once = onceOf(state);
  const item = await nextFlagged(state, at, Infinity, once) ?? await nextFlagged(state, 0, at, once);
  if (!item) {
    ctx.toast('No more spelling errors.');
    return true;
  }
  ed.chain().focus().setTextSelection({ from: item.from, to: item.to }).scrollIntoView().run();
  openSpellMenu(ed, item, item.kind === 'spell' ? await suggest(item.word) : []);
  return true;
}

const COMMANDS = {
  'review.proofing.spellingAndGrammar': { run: spelling, enabled: (ctx) => !!ctx.ed, value: () => flagged },
  'review.proofing.spellingAndGrammar.spelling': { run: spelling, enabled: (ctx) => !!ctx.ed },
  'proofing.nextMisspelling': { run: nextMisspelling, enabled: (ctx) => !!ctx.ed },
  // arg 'recheck' (Options > Proofing > Recheck Document) clears Ignore All and Ignore Once; the pane does the others.
  'proofing.ignore': {
    run: (ctx, arg) => {
      if (arg !== 'recheck' || !ctx.ed) return false;
      ctx.ed.commands.setDocSettings({ ignored: [] });
      tell(ctx.ed.view, { clearOnce: true });
      return true;
    },
  },
  'review.proofing.wordCount': { run: (ctx) => ctx.dialog('wordCount'), enabled: (ctx) => !!ctx.ed },
  'wordCount.recount': {
    run: (ctx) => {
      if (!ctx.ed) return false;
      const c = wordCount(ctx.ed, ctx.settings?.word?.proofing?.countNotes ?? true);
      ctx.toast(`${c.words.toLocaleString('en-GB')} ${c.words === 1 ? 'word' : 'words'}`);
      return c.words;
    },
  },
  'review.speech.readAloud': {
    run: (ctx) => (readState().active ? (stop(), true) : start(ctx.ed)),
    enabled: (ctx) => !!ctx.ed,
    active: () => readState().active,
  },
  'review.accessibility.checkAccessibility': {
    run: (ctx) => ctx.pane('accessibility'),
    active: () => paneOpen('accessibility'),
    // Errors and warnings, for the status bar.
    value: (ctx) => {
      if (!ctx.ed) return 0;
      const c = tally(issuesFor(ctx.ed.state.doc));
      return c.error + c.warning;
    },
  },
  'review.accessibility.checkAccessibility.checkAccessibility': { run: (ctx) => ctx.pane('accessibility', true) },
  'review.accessibility.checkAccessibility.optionsAccessibility': { run: (ctx) => ctx.dialog('wordOptions', { page: 'accessibility' }) },
  // The Language dropdown opens its menu; run (tool search, the keyboard) opens Set Proofing Language.
  'review.language.language': { run: (ctx) => ctx.dialog('language') },
  'review.language.language.setProofingLanguage': { run: (ctx) => ctx.dialog('language') },
  'review.language.language.languagePreferences': { run: (ctx) => ctx.dialog('languagePreferences') },
};

/** On a Document's main editor: the dictionary languages, the saved editing languages, and the flagged count after each edit. */
function setup(editor) {
  const saved = getState().settings?.word?.proofing?.languages;
  if (Array.isArray(saved) && saved.length) Promise.resolve(spellApi()?.setLanguages?.(saved)).then(refreshLanguages, refreshLanguages);
  else refreshLanguages();
  let timer = null;
  const scan = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (editor.isDestroyed) return;
      const mine = ++counts; // the count gives the window back as it goes: a later edit's count wins
      const n = await flaggedCount(editor.state, onceOf(editor.state));
      if (mine === counts) flagged = n;
    }, 1200);
  };
  editor.on('update', scan);
  scan();
  return () => {
    clearTimeout(timer);
    editor.off('update', scan);
    endSpell();
    stop();
  };
}

export default {
  id: 'proofing',
  extensions: [ProofingMarks, ReadAloudKeys],
  commands: COMMANDS,
  dialogs: { wordCount: WordCountDialog, readabilityStatistics: ReadabilityDialog, language: LanguageDialog, languagePreferences: LanguagePreferencesDialog },
  panes: {
    spelling: { title: 'Spelling', side: 'right', width: 18, Component: SpellPane },
    thesaurus: { title: 'Thesaurus', side: 'right', width: 18, Component: ThesaurusPane },
    accessibility: { title: 'Accessibility', side: 'right', width: 18, Component: A11yPane },
  },
  slots: { belowRibbon: ProofingBar },
  implements: [
    'proofing.asYouType', 'proofing.pane', 'proofing.options', 'proofing.dictionary', 'proofing.languages', 'proofing.readability',
    'readAloud.controls', 'wordCount.rules', 'font.language', 'keys.readAloudKey', 'keys.proofingKey', 'keys.wordCountKey',
    'immersiveReader.immersiveReader.readAloud',
  ],
  setup,
};

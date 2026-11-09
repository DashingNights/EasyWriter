// What the engine's spelling takes from the DOM editor (src/engine imports nothing of the app): the proofing options with the
// status bar's spelling switch, the word rules and the spelling menu. The Documents page area and a board's sessions share it.
import { getState } from '../../app/store.js';
import { spellingEntries } from '../wp/context-menu/menus.mjs';
import { served } from '../wp/proofing/languages.mjs';
import { ignoredKind, isIgnored, repeats, tokens } from '../wp/proofing/words.mjs';
import { wordSettings } from '../word/settings.mjs';

export const PROOFING = {
  options: () => ({ ...wordSettings(getState().settings ?? {}).proofing, on: getState().settings?.spellCheck ?? true }),
  rules: { tokens, repeats, ignoredKind, isIgnored, served },
  menu: spellingEntries,
};

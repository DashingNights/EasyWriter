// The ribbon's saved choices (settings.word.ribbon, plan.md §1.12) and the store fields the renderer draws from: word.ribbon
// ('full' | 'tabs', the collapsed state), word.qatBelow and word.touch. Settings are the truth; the store follows them, so
// Show tabs only still holds when a draft is reopened or the app restarts.
import { getState, subscribe } from '../../../app/store.js';
import { setWord } from '../../../tooling/ribbon/contexts.js';
import { saveWord, wordSettings } from '../../word/settings.mjs';

/** The saved ribbon choices with their defaults. */
export const ribbonPrefs = () => wordSettings(getState().settings).ribbon;

/** The store fields for prefs `p`; the collapsed state only when the display changed, so a peek stays open. */
function mirror(p, before) {
  const word = getState().word ?? {};
  const patch = {};
  if (!before || before.display !== p.display) {
    const ribbon = p.display === 'tabs' ? 'tabs' : 'full';
    if (word.ribbon !== ribbon) Object.assign(patch, { ribbon, peek: false });
  }
  if (!!word.qatBelow !== !!p.qatBelow) patch.qatBelow = !!p.qatBelow;
  if (!!word.touch !== !!p.touch) patch.touch = !!p.touch;
  if (Object.keys(patch).length) setWord(patch);
}

/** Saves `patch` into settings.word.ribbon and shows it at once (before the settings come back). */
export function saveRibbon(patch) {
  const before = ribbonPrefs();
  mirror({ ...before, ...patch }, before);
  return saveWord({ ribbon: patch });
}

/** Keeps the store in step with the settings while a Document is open → the unsubscribe. */
export function followSettings() {
  let last = ribbonPrefs();
  mirror(last, null);
  return subscribe(() => {
    const now = ribbonPrefs();
    if (now === last) return;
    const before = last;
    last = now;
    mirror(now, before);
  });
}

// The Word status bar's items (index-layout.md Status bar, briefs/statusbar.md): every settings.word.statusBar key in Word's
// order with Word's label, and the texts the items show. Pure: the bar, its Customize Status Bar menu and the node test read it.
// Number of Authors Editing, Signatures, Information Management Policy, Permissions, Macro Recording, Text Predictions and
// Upload Status are cloud or excluded features and are left out.
import { formatLength } from '../../../tooling/kit/units.mjs';

/** [key, Word's label, side] in Word's order. */
export const ITEMS = [
  ['formattedPageNumber', 'Formatted Page Number', 'left'],
  ['section', 'Section', 'left'],
  ['pageNumber', 'Page Number', 'left'],
  ['verticalPosition', 'Vertical Page Position', 'left'],
  ['lineNumber', 'Line Number', 'left'],
  ['column', 'Column', 'left'],
  ['wordCount', 'Word Count', 'left'],
  ['characterCount', 'Character Count (with spaces)', 'left'],
  ['proofing', 'Spelling and Grammar Check', 'left'],
  ['language', 'Language', 'left'],
  ['trackChanges', 'Track Changes', 'left'],
  ['capsLock', 'Caps Lock', 'left'],
  ['overtype', 'Overtype', 'left'],
  ['selectionMode', 'Selection Mode', 'left'],
  ['accessibility', 'Accessibility Checker', 'left'],
  ['focus', 'Focus', 'right'],
  ['viewShortcuts', 'View Shortcuts', 'right'],
  ['zoomSlider', 'Zoom Slider', 'right'],
  ['zoom', 'Zoom', 'right'],
].map(([key, label, side]) => ({ key, label, side }));

export const LABEL = Object.fromEntries(ITEMS.map((i) => [i.key, i.label]));

const num = (n) => Number(n).toLocaleString('en-US');

/** "1,234 words", or "56 of 1,234 words" while text is selected (`part` not null). */
export const wordsText = (total, part = null) => `${part == null ? '' : `${num(part)} of `}${num(total)} ${total === 1 ? 'word' : 'words'}`;

/** "6,789 characters", or "12 of 6,789 characters". */
export const charsText = (total, part = null) => `${part == null ? '' : `${num(part)} of `}${num(total)} ${total === 1 ? 'character' : 'characters'}`;

/** Vertical Page Position: `px` layout px from the page's top edge in `unit` with one decimal ("At 2.5 cm", "At 1\""). Word's
 * exact spacing between the number and the unit is unverified. */
export const positionText = (px, unit) => `At ${formatLength(Math.max(0, px) * 0.75, unit, 1)}`;

/** The selection mode text for store word.extend, or null when no mode is on. */
export const MODE_TEXT = { extend: 'Extend Selection', column: 'Block Selection' };
/** The left end's prompt while F2 or Shift+F2 waits for a place. */
export const PROMPT_TEXT = { move: 'Move to where?', copy: 'Copy to where?' };

/** A language tag's name as Word lists it: 'en-US' → 'English (United States)'; the tag itself when Intl does not know it. */
export function languageName(tag) {
  if (!tag) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

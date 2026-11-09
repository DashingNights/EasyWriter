// The lists of the Track Changes Options and Advanced Track Changes Options dialogs (docs/plans/word plan.md §3 markup), as captured
// in probe/dialogs/advanced-track-changes-options.json, with the settings.word.tracking value of each item (§1.12). Pure.
import { HIGHLIGHTS } from '../../../office.mjs';

// Insertions, Moved to and Formatting.
export const MARKS = [['none', '(none)'], ['color', 'Color only'], ['bold', 'Bold'], ['italic', 'Italic'], ['underline', 'Underline'],
  ['dunderline', 'Double underline'], ['strike', 'Strikethrough'], ['dstrike', 'Double strikethrough']];
// Deletions and Moved from add Hidden, ^ and # before Double strikethrough, as Word lists them.
export const DEL_MARKS = [...MARKS.slice(0, 7), ['hidden', 'Hidden'], ['caret', '^ '], ['pound', '# '], MARKS[7]];
export const COLORS = [['byAuthor', 'By author'], ['auto', 'Auto'], ['black', 'Black'], ['blue', 'Blue'], ['turquoise', 'Turquoise'],
  ['brightGreen', 'Bright Green'], ['pink', 'Pink'], ['red', 'Red'], ['yellow', 'Yellow'], ['white', 'White'], ['darkBlue', 'Dark Blue'],
  ['teal', 'Teal'], ['green', 'Green'], ['violet', 'Violet'], ['darkRed', 'Dark Red'], ['darkYellow', 'Dark Yellow'], ['gray50', 'Gray-50%'],
  ['gray25', 'Gray-25%'], ['classicRed', 'Classic Red'], ['classicBlue', 'Classic Blue']];
export const CELLS = [['byAuthor', 'By author'], ['none', '(none)'], ['pink', 'Pink'], ['lightBlue', 'Light Blue'], ['lightYellow', 'Light Yellow'],
  ['lightPurple', 'Light Purple'], ['lightOrange', 'Light Orange'], ['lightGreen', 'Light Green'], ['gray', 'Gray']];
export const LINES = [['none', '(none)'], ['left', 'Left border'], ['right', 'Right border'], ['outside', 'Outside border']];
export const BALLOONS = [['revisions', 'Revisions'], ['none', 'Nothing'], ['comments', 'Comments and formatting']];
export const PANE = [['off', 'Off'], ['left', 'Vertical'], ['bottom', 'Horizontal']];
export const ORIENTATION = [['auto', 'Auto'], ['preserve', 'Preserve'], ['landscape', 'Force Landscape']];
// Measure in names the document's length unit as Word's list does (Centimeters on a metric system).
export const UNIT_NAMES = { cm: 'Centimeters', mm: 'Millimeters', in: 'Inches', pt: 'Points', pi: 'Picas' };

// Hex of each mark colour by Word's colour index name (office.mjs HIGHLIGHTS). Classic Red and Classic Blue were not probed: these
// two are our pick, the dark red and blue of Word's older revision colours.
export const COLOR_HEX = {
  black: HIGHLIGHTS.black, blue: HIGHLIGHTS.blue, turquoise: HIGHLIGHTS.cyan, brightGreen: HIGHLIGHTS.green, pink: HIGHLIGHTS.magenta,
  red: HIGHLIGHTS.red, yellow: HIGHLIGHTS.yellow, white: HIGHLIGHTS.white, darkBlue: HIGHLIGHTS.darkBlue, teal: HIGHLIGHTS.darkCyan,
  green: HIGHLIGHTS.darkGreen, violet: HIGHLIGHTS.darkMagenta, darkRed: HIGHLIGHTS.darkRed, darkYellow: HIGHLIGHTS.darkYellow,
  gray50: HIGHLIGHTS.darkGray, gray25: HIGHLIGHTS.lightGray, classicRed: '#C00000', classicBlue: '#0070C0',
};
// Table cell highlight fills (pastels; not probed as hex, our pick).
export const CELL_HEX = { pink: '#FFC0CB', lightBlue: '#CCE5FF', lightYellow: '#FFFFCC', lightPurple: '#E5CCFF', lightOrange: '#FFE0B2',
  lightGreen: '#CCFFCC', gray: '#D9D9D9' };

/** The label of `value` in `list` ([[value, label]]), or null. */
export const labelIn = (list, value) => list.find(([v]) => v === value)?.[1] ?? null;
/** The value of `label` in `list`, or null. */
export const valueIn = (list, label) => list.find(([, l]) => l === label)?.[0] ?? null;

// The settings.word.tracking keys the Advanced dialog edits; it shows and writes them as they are stored.
export const ADVANCED_KEYS = ['ins', 'del', 'lines', 'moves', 'moveFrom', 'moveTo', 'cells', 'formatting', 'fmt', 'balloonWidth', 'balloonUnit',
  'balloonLines', 'printOrientation'];

/** The Advanced dialog's value from tracking settings `t`. */
export const advancedOf = (t) => Object.fromEntries(ADVANCED_KEYS.map((k) => [k, t[k]]));

/** Preferred width `w` converted when Measure in switches from `from` to `to` ('len' points or 'pct'), on a sheet `sheetPt` wide. */
export function convertWidth(w, from, to, sheetPt) {
  if (from === to) return w;
  return to === 'pct' ? Math.round((w / sheetPt) * 1000) / 10 : Math.round((w / 100) * sheetPt * 100) / 100;
}

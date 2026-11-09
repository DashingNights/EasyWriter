// Word settings (docs/plans/word plan.md §1.12): settings.word with every key's default, read through wordSettings and written
// through saveWord. A reader whose package has not merged yet reads its keys with these defaults. Large data (building blocks,
// style sets, sources) lives in the word store (api.word.store), never here: saveWord rewrites settings.json whole.
// Pure: saveWord reaches the app's saveSettings through bindSettings, which base.js calls, so node tests load this file.
import { DOCUMENTS_ON_ENGINE } from '../../formats.mjs';

const MARK = (mark, color) => ({ mark, color });

export const WORD_DEFAULTS = {
  units: null, // the profile's default, else the region's unit (kit units.mjs unitOf)
  charUnits: false,
  ruler: true,
  verticalRuler: true,
  marks: { all: false, tabs: false, spaces: false, paragraphs: false, hidden: false, optionalHyphens: false, anchors: true },
  fieldShading: 'selected',
  fieldCodes: false,
  bookmarks: false,
  textBoundaries: false,
  cropMarks: true,
  user: { name: '', initials: '', address: '' },
  // miniToolbar: the bar over a mouse selection, off unless turned on in Options (the user, 2026-10-29: never unasked).
  general: { miniToolbar: false, livePreview: true, screenTips: 'full', shortcutTips: true },
  editing: {
    typingReplaces: true, dragDrop: true, ctrlClickLinks: true, autoWordSelect: false, smartParagraph: false, smartCursoring: false,
    insKeyOvertype: false, insKeyPaste: false, clickAndType: true, promptUpdateStyle: false, normalForLists: false,
  },
  paste: {
    within: 'keep', between: 'keep', conflict: 'destination', other: 'merge', pictures: 'inline', keepBullets: true, button: true, smart: true,
    collectHidden: false,
  },
  proofing: {
    asYouType: true, ignoreUpper: true, ignoreNumbers: true, ignoreUrls: true, flagRepeated: true, hideSpelling: false, readability: false,
    languages: ['en-US'], countNotes: true, accessibilityLive: false,
  },
  readAloud: { rate: 1, voice: null },
  autocorrect: {
    buttons: true, twoCaps: true, sentences: true, cells: true, days: true, capsLock: true, replace: true, spelling: true, entries: null,
    exceptions: { firstLetter: null, initialCaps: ['IDs'], other: [] },
  },
  autoformat: {
    quotes: true, ordinals: true, fractions: true, dashes: true, boldItalic: false, markdown: true, links: true, bulletedLists: true,
    numberedLists: true, borders: true, tables: true, headings: false, listLead: true, tabIndent: true, defineStyles: false,
    firstLineIndentSpaces: false, dateStyle: false, matchParentheses: true, memoClosing: true, asianSpaces: false,
  },
  autoformatNow: {
    headings: true, lists: true, bulletedLists: true, otherParas: true, quotes: true, ordinals: true, fractions: true, dashes: true,
    boldItalic: true, links: true, preserveStyles: true, plainTextEmail: true,
  },
  print: { background: false, hiddenText: false, markup: true, properties: false, updateFields: false, updateLinks: false, reverse: false, drawings: true },
  display: { whiteSpace: true, highlighter: true, tooltips: true, draftFont: null, styleArea: 0, wrapToWindow: false },
  ribbon: {
    display: 'always', developer: false, qat: ['frame.qat.save', 'frame.qat.undo', 'frame.qat.redoRepeat'], qatBelow: false, qatHidden: false,
    touch: false,
  },
  statusBar: {
    formattedPageNumber: false, section: false, pageNumber: true, verticalPosition: false, lineNumber: false, column: false, wordCount: true,
    characterCount: false, proofing: true, language: false, trackChanges: false, capsLock: false, overtype: false, selectionMode: false,
    accessibility: true, focus: true, viewShortcuts: true, zoomSlider: true, zoom: true,
  },
  tracking: {
    author: null, display: 'all', show: { insDel: true, formatting: true, ink: true }, people: null, balloons: 'comments', paneSide: 'left',
    moves: true, formatting: true, ins: MARK('underline', 'byAuthor'), del: MARK('strike', 'byAuthor'), lines: 'outside',
    moveFrom: MARK('dstrike', 'green'), moveTo: MARK('dunderline', 'green'),
    cells: { inserted: 'lightBlue', merged: 'lightYellow', deleted: 'pink', split: 'lightOrange' }, fmt: MARK('none', 'byAuthor'),
    balloonWidth: 266.45, balloonUnit: 'len', balloonLines: true, printOrientation: 'preserve',
  },
  comments: { show: true, view: 'contextual' },
  find: {
    matchCase: false, wholeWord: false, wildcards: false, soundsLike: false, allForms: false, prefix: false, suffix: false, widthForms: false,
    ignorePunct: false, ignoreSpace: false, highlightAll: true, incremental: true,
  },
  readMode: { columnWidth: 'default', pageColor: 'none', layout: 'column' },
  immersive: { columnWidth: 'default', pageColor: 'none', lineFocus: 0, textSpacing: false, syllables: false },
  newDocument: { styles: null, theme: null, pageSetup: null },
  lastMargins: null,
  themeColors: [],
  themeFonts: [],
  stylesPane: { preview: false, noLinked: false },
  dateTime: { format: null, lang: null, update: false },
  captions: { labels: [], numbering: {}, autoCaption: {} },
  autoComplete: true,
  canvasEngine: DOCUMENTS_ON_ENGINE, // Documents in the canvas engine's page area (src/document/canvas); a stored value is one user's choice
  onePageRow: false, // Print Layout's pages one to a row at any zoom; off, a row takes as many as fit across, as Word's does
  toaCategories: {},
  labels: [],
  tableGridlines: false,
  guides: { display: false, page: true, margin: true, paragraph: true, snapObjects: true, snapGrid: false, gridlines: false },
  math: { input: 'unicode', autoBuildUp: true, copyLinear: true, outside: false, replace: true, entries: null, functions: null },
  insertTable: null,
  pens: null,
  recentSymbols: [],
  recentColors: [],
  paneWidths: {},
};

const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** `base` with `over` merged in at every depth: plain objects merge, anything else (arrays, null, values) replaces. */
export function deepMerge(base, over) {
  if (!plain(over)) return over === undefined ? base : over;
  if (!plain(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

const cache = new WeakMap(); // settings object → its merged word settings, so a render per keystroke costs one lookup

/** The Word settings of app `settings`: WORD_DEFAULTS with settings.word deep-merged over them. */
export function wordSettings(settings) {
  if (!plain(settings)) return WORD_DEFAULTS;
  if (!cache.has(settings)) cache.set(settings, deepMerge(WORD_DEFAULTS, settings.word));
  return cache.get(settings);
}

/** The settings.word patch saveWord sends for `patch` over the stored `word`: only the patch's keys, each object merged one
 * level over its stored value. Sending only these keys lets main.js merge `word` by key, so two saves in flight both keep theirs. */
export function wordPatch(word, patch) {
  return Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, plain(v) && plain(word?.[k]) ? { ...word[k], ...v } : v]));
}

// The app's settings access, bound by base.js at load: this module stays free of DOM imports.
let app = null;
/** Binds `{settings: () => current settings, save: (partial) => Promise<settings>}` (the app's getState and saveSettings). */
export const bindSettings = (access) => {
  app = access;
};

/** Saves `patch` into settings.word (merged one level, wordPatch) through the app's saveSettings → the new settings. */
export function saveWord(patch) {
  if (!app) return Promise.reject(new Error('Word settings are not bound yet'));
  return app.save({ word: wordPatch(app.settings()?.word, patch) });
}

// The Options dialog's pages as data (docs/plans/word/briefs/options.md): Word's sections and rows in Word's order, with Word's labels
// (probe/dialogs/word-options.json, "&" marks the access key) less Microsoft's product names. Each row names where it saves and the
// feature id of its reader: a row whose reader is not registered yet still saves and says so. Pure, so node tests load it.

// Where a row saves: settings.word (saveWord), the app's settings (changeSettings, so the theme applies), the open draft's
// doc.attrs.settings (one setDocSettings step) or the store's word slice.
export const STORES = ['word', 'app', 'doc', 'state'];

const check = (label, path, reader, more) => ({ kind: 'check', label, path, reader, ...more });
const pick = (label, path, reader, options, more) => ({ kind: 'pick', label, path, reader, options, ...more });
const off = (kind, label, needs, more) => ({ kind, label, needs, ...more }); // shown disabled with REASONS[needs]

const PASTE_MODES = [['keep', 'Keep Source Formatting'], ['merge', 'Merge Formatting'], ['text', 'Keep Text Only']];
const withDefault = (list, value) => list.map(([v, l]) => [v, v === value ? `${l} (Default)` : l]);
const SCREENTIPS = [['full', 'Show feature descriptions in ScreenTips'], ['short', "Don't show feature descriptions in ScreenTips"], ['none', "Don't show ScreenTips"]];

// Show measurements in units of: null follows the format's default, else the region's unit (kit units.mjs unitOf). A select holds
// strings, so null travels as 'auto'.
export const UNIT_OPTIONS = [['auto', 'Automatic'], ['in', 'Inches'], ['cm', 'Centimeters'], ['mm', 'Millimeters'], ['pt', 'Points'], ['pi', 'Picas']];
export const unitIn = (v) => v ?? 'auto';
export const unitOut = (v) => (v === 'auto' ? null : v);

export const PAGES = [
  { id: 'general', label: 'General', title: 'General options for working with EasyWriter.', sections: [
    { id: 'ui', title: 'User Interface options', rows: [
      check('Show &Mini Toolbar on selection', 'general.miniToolbar', 'miniToolbar.toolbar'),
      check('Enable &Live Preview', 'general.livePreview', null),
      pick('Sc&reenTip style', 'general.screenTips', 'keytips.tooltip', SCREENTIPS),
    ] },
    { id: 'personalize', title: 'Personalize your copy', rows: [
      { kind: 'text', label: '&User name', path: 'user.name', reader: 'review.comments.newComment' },
      { kind: 'text', label: '&Initials', path: 'user.initials', reader: 'review.comments.newComment', width: '6rem' },
      pick('&Theme', 'uiTheme', undefined, [['system', 'Use system setting'], ['dark', 'Dark'], ['light', 'Light']], { store: 'app', fallback: 'system' }),
    ] },
  ] },
  { id: 'display', label: 'Display', title: 'Change how document content is displayed on the screen and when printed.', sections: [
    { id: 'pageDisplay', title: 'Page display options', rows: [
      check('Sho&w white space between pages in Print Layout view', 'display.whiteSpace', 'views.whiteSpace'),
      check('S&how highlighter marks', 'display.highlighter', null),
      check('Show document too&ltips on hover', 'display.tooltips', 'editing.ctrlClickLink'),
    ] },
    { id: 'marks', title: 'Always show these formatting marks on the screen', rows: [
      check('&Tab characters', 'marks.tabs', 'marks.alwaysShow'),
      check('&Spaces', 'marks.spaces', 'marks.alwaysShow'),
      check('Paragraph &marks', 'marks.paragraphs', 'marks.alwaysShow'),
      check('Hi&dden text', 'marks.hidden', 'marks.alwaysShow'),
      check('Optional h&yphens', 'marks.optionalHyphens', 'marks.alwaysShow'),
      check('Obje&ct anchors', 'marks.anchors', 'marks.anchors'),
      check('Show &all formatting marks', 'marks.all', 'marks.alwaysShow'),
    ] },
    { id: 'printing', title: 'Printing options', rows: [
      check('P&rint drawings', 'print.drawings', 'file.print'),
      check('Print &background colors and images', 'print.background', 'file.print'),
      check('Print document &properties', 'print.properties', 'file.print'),
      check('Print hidden te&xt', 'print.hiddenText', 'file.print'),
      check('Update &fields before printing', 'print.updateFields', 'fieldsUi.updateBeforePrint'),
      check('Update lin&ked data before printing', 'print.updateLinks', 'file.print'),
    ] },
  ] },
  { id: 'proofing', label: 'Proofing', title: 'Change how EasyWriter corrects and formats your text.', sections: [
    { id: 'autocorrect', title: 'AutoCorrect options', rows: [
      { kind: 'button', label: '&AutoCorrect Options...', text: 'Change how EasyWriter corrects and formats text as you type:', dialog: 'autoCorrect' },
    ] },
    { id: 'spelling', title: 'When correcting spelling', rows: [
      check('Ignore words in &UPPERCASE', 'proofing.ignoreUpper', 'proofing.options'),
      check('Ignore words that contain num&bers', 'proofing.ignoreNumbers', 'proofing.options'),
      check('Ignore Internet and &file addresses', 'proofing.ignoreUrls', 'proofing.options'),
      check('Flag &repeated words', 'proofing.flagRepeated', 'proofing.options'),
      { kind: 'button', label: '&Custom Dictionaries...', command: 'proofing.dictionary' },
    ] },
    { id: 'spellingGrammar', title: 'When correcting spelling and grammar', rows: [
      check('Check s&pelling as you type', 'proofing.asYouType', 'proofing.asYouType'),
      off('check', 'Mark gra&mmar errors as you type', 'grammar'),
      off('check', 'Freque&ntly confused words', 'grammar'),
      check('Show readabi&lity statistics', 'proofing.readability', 'proofing.readability'),
      { kind: 'button', label: 'Rechec&k Document', command: 'proofing.ignore', arg: 'recheck' },
    ] },
    { id: 'exceptions', title: 'Exceptions for the draft', rows: [
      check('Hide &spelling errors in this document only', 'proofing.hideSpelling', 'proofing.options'),
    ] },
  ] },
  { id: 'save', label: 'Save', title: 'Customize how documents are saved.', sections: [
    { id: 'saveDocuments', title: 'Save documents', rows: [
      { kind: 'note', text: 'EasyWriter saves every change as you type and keeps an undo history.' },
      { kind: 'button', label: '&GitHub backup...', settings: 'github' },
      off('pick', 'Save &files in this format', 'docx', { options: [['draft', 'EasyWriter draft']], value: 'draft' }),
    ] },
    { id: 'fidelity', title: 'Preserve fidelity when sharing this document', rows: [
      off('check', '&Embed fonts in the file', 'docx'),
    ] },
  ] },
  { id: 'language', label: 'Language', title: 'Set the language preferences.', sections: [
    { id: 'displayLanguage', title: 'Display language', rows: [
      { kind: 'note', text: 'Buttons, menus, and other controls show in English.' },
    ] },
    { id: 'languages', title: 'Authoring languages and proofing', rows: [
      { kind: 'languages', label: 'Editing languages', path: 'proofing.languages', reader: 'proofing.languages' },
    ] },
  ] },
  { id: 'accessibility', label: 'Accessibility', title: 'Make EasyWriter more accessible.', sections: [
    { id: 'accessible', title: 'Make your document accessible to others', rows: [
      check('&Keep accessibility checker running while I work', 'proofing.accessibilityLive', 'review.accessibility.checkAccessibility'),
    ] },
    { id: 'appDisplay', title: 'Application display options', rows: [
      pick('Sc&reenTip style', 'general.screenTips', 'keytips.tooltip', SCREENTIPS),
      check('S&how shortcut keys in ScreenTips', 'general.shortcutTips', 'keytips.tooltip'),
    ] },
  ] },
  { id: 'advanced', label: 'Advanced', title: 'Advanced options for working with EasyWriter.', sections: [
    { id: 'editing', title: 'Editing options', rows: [
      check('&Typing replaces selected text', 'editing.typingReplaces', 'editing.typingReplaces'),
      check('When selecting, automatically select entire &word', 'editing.autoWordSelect', 'selection.autoWordSelect'),
      check('Allow text to be &dragged and dropped', 'editing.dragDrop', 'editing.dragDrop'),
      check('Use CTRL + Click to follow &hyperlink', 'editing.ctrlClickLinks', 'editing.ctrlClickLink'),
      check('Use s&mart paragraph selection', 'editing.smartParagraph', 'selection.smartParagraph'),
      check('Us&e smart cursoring', 'editing.smartCursoring', 'navigation.smartCursoring'),
      check('Use the Insert key t&o control overtype mode', 'editing.insKeyOvertype', 'editing.insertKey'),
      check('Use o&vertype mode', 'overtype', 'editing.overtype', { store: 'state', fallback: false }),
      check('Prompt to update st&yle', 'editing.promptUpdateStyle', 'styles.promptUpdate'),
      check('Use &Normal style for bulleted or numbered lists', 'editing.normalForLists', 'lists.restart'),
      check('Enable &click and type', 'editing.clickAndType', 'editing.clickAndType'),
      check('Show AutoComplete suggestions', 'autoComplete', 'editing.autoComplete'),
    ] },
    { id: 'paste', title: 'Cut, copy, and paste', rows: [
      pick('Pasting &within the same document', 'paste.within', 'paste.defaults', withDefault(PASTE_MODES, 'keep')),
      pick('Pasting &between documents', 'paste.between', 'paste.defaults', withDefault(PASTE_MODES, 'keep')),
      pick('Pasting b&etween documents when style definitions conflict', 'paste.conflict', 'paste.defaults',
        withDefault([['keep', 'Keep Source Formatting'], ['destination', 'Use Destination Styles'], ...PASTE_MODES.slice(1)], 'destination')),
      pick('Pasting &from other programs', 'paste.other', 'paste.defaults', withDefault(PASTE_MODES, 'merge')),
      pick('&Insert/paste pictures as', 'paste.pictures', 'paste.defaults', [['inline', 'In line with text'], ['square', 'Square'], ['tight', 'Tight'],
        ['behind', 'Behind text'], ['front', 'In front of text'], ['through', 'Through'], ['topBottom', 'Top and bottom']]),
      check('Keep bu&llets and numbers when pasting text with Keep Text Only option', 'paste.keepBullets', 'paste.defaults'),
      check('&Use the Insert key for paste', 'editing.insKeyPaste', 'editing.insertKey'),
      check('Show Paste &Options button when content is pasted', 'paste.button', 'paste.optionsButton'),
      check('U&se smart cut and paste', 'paste.smart', 'editing.smartCutPaste'),
    ] },
    { id: 'content', title: 'Show document content', rows: [
      check('Show &background colors and images in Print Layout view', 'displayBackground', 'design.pageBackground.pageColor', { store: 'doc' }),
      check('Sho&w text wrapped within the document window', 'display.wrapToWindow', 'view.views.draft'),
      check('Show boo&kmarks', 'bookmarks', 'marks.bookmarks'),
      check('Show te&xt boundaries', 'textBoundaries', 'marks.textBoundaries'),
      check('Show c&rop marks', 'cropMarks', 'marks.cropMarks'),
      check('Show &field codes instead of their values', 'fieldCodes', 'fieldsUi.toggleAll'),
      pick('Field s&hading', 'fieldShading', 'fieldsUi.shading', [['never', 'Never'], ['always', 'Always'], ['selected', 'When selected']]),
      { kind: 'draftFont', label: 'Use &draft font in Draft and Outline views', path: 'display.draftFont', reader: 'views.draftFont' },
      { kind: 'button', label: '&Font Substitution...', dialog: 'fontSubstitution' },
    ] },
    { id: 'display', title: 'Display', rows: [
      pick('Show &measurements in units of', 'units', 'ruler.units', UNIT_OPTIONS, { in: unitIn, out: unitOut }),
      { kind: 'spin', label: 'Styl&e area pane width in Draft and Outline views', path: 'display.styleArea', reader: 'views.styleArea', unit: 'len', min: 0, max: 1584 },
      check('Sho&w measurements in width of characters', 'charUnits', 'home.paragraph.launcher'),
      check('Show verti&cal ruler in Print Layout view', 'verticalRuler', 'ruler.vertical'),
      check('Show Documents in the canvas engine', 'canvasEngine', 'view.canvasEngine'),
      check('Show one page per row in Print Layout', 'onePageRow', 'view.onePageRow'),
      check('S&how shortcut keys in ScreenTips', 'general.shortcutTips', 'keytips.tooltip'),
    ] },
    { id: 'print', title: 'Print', rows: [
      check('P&rint pages in reverse order', 'print.reverse', 'file.print'),
    ] },
    { id: 'general', title: 'General', rows: [
      { kind: 'area', label: 'Mailing a&ddress', path: 'user.address', reader: 'mailings.create.envelopes' },
    ] },
    { id: 'layout', title: 'Layout options for the draft', rows: [
      check("Don't use &HTML paragraph auto spacing", 'compat.htmlAutoSpacing', null, { store: 'doc', invert: true }),
    ] },
    { id: 'compat', title: 'Compatibility options for the draft', rows: [
      off('pick', 'Lay out this document as if created in', null, { options: [['easywriter', 'EasyWriter']], value: 'easywriter',
        help: 'EasyWriter has one layout mode.' }),
    ] },
  ] },
];

// The pages other packages register (module `options`), with Word's names. Add-ins and Trust Center never show.
export const PAGE_LABELS = { customizeRibbon: 'Customize Ribbon', qat: 'Quick Access Toolbar' };
export const EXCLUDED = ['addIns', 'trustCenter'];

/** Every row of every page, with its page and section ids. */
export const allRows = () => PAGES.flatMap((p) => p.sections.flatMap((s) => s.rows.map((r) => ({ ...r, page: p.id, section: s.id }))));

/** The page id `tab` (or its other name `page`) asks for, else General. */
export const pageOf = ({ tab, page } = {}, ids = PAGES.map((p) => p.id)) => (ids.includes(tab ?? page) ? tab ?? page : 'general');

/** The buffer key of a row that saves: its store and path. */
export const keyOf = (row) => `${row.store ?? 'word'}:${row.path}`;

/** The value at dotted `path` in `obj`. */
export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** The stored values of every saving row, from `sources` {word, app, doc, state} (word with its defaults merged). */
export function initialOf(sources) {
  const out = {};
  for (const r of allRows()) {
    if (!r.path) continue;
    const v = getPath(sources[r.store ?? 'word'], r.path);
    out[keyOf(r)] = v === undefined ? r.fallback : v;
  }
  return out;
}

/** The writes for buffer `edits` over `initial` (only keys that changed): {word, app, doc, state}, each null when empty. word is the
 * saveWord patch, one level deep ({group: {key: value}} or {key: value}); doc is the setDocSettings patch. */
export function patchesOf(edits, initial) {
  const out = { word: {}, app: {}, doc: {}, state: {} };
  for (const [key, v] of Object.entries(edits)) {
    if (JSON.stringify(v) === JSON.stringify(initial[key])) continue;
    const [store, path] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const [head, ...rest] = path.split('.');
    if (!rest.length) out[store][head] = v;
    else if (store === 'word' && rest.length > 1) throw new Error(`Options row ${path} is deeper than saveWord merges`);
    else out[store][head] = deepSet(out[store][head] ?? {}, rest, v);
  }
  for (const s of STORES) if (!Object.keys(out[s]).length) out[s] = null;
  return out;
}

const deepSet = (obj, [k, ...rest], v) => ({ ...obj, [k]: rest.length ? deepSet(obj[k] ?? {}, rest, v) : v });

/** The saving rows whose reader is not in `registered` (feature ids the registry knows): stored now, inert until that package lands.
 * A row with reader null is stored only for good. */
export const unbuiltRows = (rows, registered) => rows.filter((r) => r.path && r.reader !== undefined && (r.reader === null || !registered.includes(r.reader)));

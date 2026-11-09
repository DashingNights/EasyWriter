// Word's right-click menus as data (docs/plans/word/briefs/context-menu.md, index-editing.md "Context menus", probe/context-menus.tsv).
// menuFor(hit) picks the menu for what is under the pointer and returns its entries {label, key, cmd, arg?, sub?, menu?, gallery?,
// needs?, act?, sep?}: cmd runs through the registry on ctx.target, menu is a spec MENUS key drawn as a submenu, gallery a gallery
// drawn as Word's icon row, needs a placeholder reason (shown disabled), act a menu-local action (the spelling card). The access
// keys are the probe's (the letter after &); the live order is unverified in Word, so it follows the brief. Pure: node tests load it.
import { REASONS } from '../../../tooling/reasons.mjs';

const SEP = { sep: true };
const CUT = { label: 'Cut', key: 'T', cmd: 'home.clipboard.cut' };
const COPY = { label: 'Copy', key: 'C', cmd: 'home.clipboard.copy' };
const PASTE = { label: 'Paste', key: 'P', cmd: 'home.clipboard.paste' };
const PASTE_OPTIONS = { label: 'Paste Options', cmd: 'home.clipboard.paste', gallery: 'home.clipboard.paste' };
const FONT = { label: 'Font...', key: 'F', cmd: 'home.font.launcher' };
const PARAGRAPH = { label: 'Paragraph...', key: 'P', cmd: 'home.paragraph.launcher' };
const SYNONYMS = { label: 'Synonyms', key: 'Y', cmd: 'review.proofing.thesaurus' };
const READ_ALOUD = { label: 'Read Aloud', key: 'R', cmd: 'review.speech.readAloud' };
const TRANSLATE = { label: 'Translate', key: 'T', cmd: 'review.language.translate', needs: 'cloud' };
const LINK = { label: 'Link', cmd: 'insert.links.link' };
const NEW_COMMENT = { label: 'New Comment', key: 'M', cmd: 'insert.comments.comment' };
const GROUP = { label: 'Group', key: 'G', cmd: 'layout.arrange.group', menu: 'layout.arrange.group' };
const FRONT = { label: 'Bring to Front', key: 'R', at: 10, cmd: 'layout.arrange.bringForward', menu: 'layout.arrange.bringForward' };
const BACK = { label: 'Send to Back', key: 'K', cmd: 'layout.arrange.sendBackward', menu: 'layout.arrange.sendBackward' };
const CAPTION = { label: 'Insert Caption...', key: 'C', cmd: 'references.captions.insertCaption' };
const WRAP = { label: 'Wrap Text', key: 'W', cmd: 'layout.arrange.wrapText', menu: 'layout.arrange.wrapText' };
const search = (word) => ({ label: word ? `Search "${word}"` : 'Search', needs: 'cloud' });

const LIST = (numbered) => [
  { label: 'Adjust List Indents...', key: 'U', cmd: 'lists.adjustIndents' },
  ...(numbered ? [{ label: 'Restart at 1', cmd: 'lists.restart' }] : []),
  { label: 'Continue Numbering', key: 'C', cmd: 'lists.continue' },
  { label: 'Set Numbering Value...', key: 'V', cmd: 'home.paragraph.numbering.setNumberingValue' },
];

const HEADINGS = {
  label: 'Expand/Collapse', key: 'E', sub: [
    { label: 'Expand Heading', key: 'E', cmd: 'navPane.expandHeading' },
    { label: 'Collapse Heading', key: 'C', cmd: 'navPane.collapseHeading' },
    { label: 'Expand All Headings', key: 'X', cmd: 'navPane.collapsibleHeadings', arg: 'expandAll' },
    { label: 'Collapse All Headings', key: 'L', cmd: 'navPane.collapsibleHeadings', arg: 'collapseAll' },
  ],
};

/** The Text menu (contextMenu.text); `word` names the Search entry; `heading` adds Expand/Collapse after the paste row. */
const text = (hit) => [CUT, COPY, PASTE_OPTIONS, ...(hit.heading ? [HEADINGS] : []), SEP, FONT, PARAGRAPH, SEP, search(hit.word), SYNONYMS,
  READ_ALOUD, TRANSLATE, SEP, LINK, NEW_COMMENT];

// Word names the change in Accept and Reject (index-editing.md: "Accept Insertion", "Reject Deletion"; the rest unverified).
const CHANGE = { insert: 'Insertion', delete: 'Deletion', format: 'Formatting Change', paraProps: 'Formatting Change', replace: 'Change', attr: 'Change' };

/** The name of revision `rev` ({kind, op?}) in Accept and Reject: Insertion, Deletion, Formatting Change or Change. */
export function changeName(rev) {
  if (rev?.op && (rev.kind === 'paraMark' || rev.kind === 'row')) return CHANGE[rev.op];
  return CHANGE[rev?.kind] ?? 'Change';
}

const MENUS = {
  text,
  lists: (hit) => [CUT, COPY, PASTE_OPTIONS, SEP, ...LIST(hit.numbered), SEP, FONT, PARAGRAPH, SEP, SYNONYMS, READ_ALOUD, TRANSLATE, SEP, NEW_COMMENT],
  table: (hit) => [CUT, COPY, PASTE_OPTIONS, ...(hit.list ? [SEP, ...LIST(hit.numbered)] : []), SEP, SYNONYMS, READ_ALOUD, TRANSLATE, SEP,
    {
      label: 'Insert', key: 'I', sub: [
        { label: 'Insert Columns to the Left', key: 'L', at: 22, cmd: 'tableLayout.rowsColumns.insertColumnLeft' },
        { label: 'Insert Columns to the Right', key: 'R', at: 22, cmd: 'tableLayout.rowsColumns.insertColumnRight' },
        { label: 'Insert Rows Above', key: 'A', cmd: 'tableLayout.rowsColumns.insertRowAbove' },
        { label: 'Insert Rows Below', key: 'B', cmd: 'tableLayout.rowsColumns.insertRowBelow' },
        { label: 'Insert Cells...', key: 'E', cmd: 'tableLayout.rowsColumns.launcher' },
      ],
    },
    { label: 'Delete Cells...', key: 'D', cmd: 'tableLayout.rowsColumns.delete.deleteCells' },
    hit.cells > 1 ? { label: 'Merge Cells', key: 'G', cmd: 'tableLayout.merge.mergeCells' } : { label: 'Split Cells...', key: 'G', cmd: 'tableLayout.merge.splitCells' },
    { label: 'Border Styles', key: 'B', cmd: 'tableDesign.borders.borderStyles', menu: 'tableDesign.borders.borderStyles' },
    { label: 'Text Direction...', key: 'X', cmd: 'tableLayout.alignment.textDirection' },
    { label: 'Table Properties...', key: 'R', cmd: 'tableLayout.table.properties' },
    SEP, NEW_COMMENT],
  picture: () => [CUT, COPY, PASTE_OPTIONS, SEP,
    { label: 'Save as Picture...', key: 'S', cmd: 'contextMenu.picture.saveAsPicture' },
    { label: 'Change Picture', key: 'A', cmd: 'pictureFormat.adjust.changePicture', menu: 'pictureFormat.adjust.changePicture' },
    GROUP, FRONT, BACK, LINK, CAPTION, WRAP,
    { label: 'View Alt Text...', cmd: 'pictureFormat.accessibility.altText' },
    { label: 'Size and Position...', key: 'Z', cmd: 'pictureFormat.size.launcher' },
    { label: 'Format Picture...', key: 'O', cmd: 'pictureFormat.pictureStyles.launcher' },
    SEP, NEW_COMMENT],
  // A text box selected whole (by its border): Word's shape menu, Set as Default Text Box just before Format Shape (the probe's Set
  // AutoShape Defaults sits before Format AutoShape; the labels and key D are Word's). A shape or line on a canvas has its block menu.
  shape: () => [CUT, COPY, PASTE_OPTIONS, SEP,
    { label: 'Edit Text', key: 'X', cmd: 'shapeFormat.insertShapes.addText' },
    GROUP, FRONT, BACK, LINK, CAPTION, WRAP,
    { label: 'Set as Default Text Box', key: 'D', cmd: 'contextMenu.shape.setAsDefaultTextBox' },
    { label: 'Format Shape...', key: 'O', cmd: 'shapeFormat.shapeStyles.launcher' },
    SEP, NEW_COMMENT],
  hyperlink: (hit) => [
    { label: 'Edit Hyperlink...', key: 'H', cmd: 'insert.links.link' },
    { label: 'Open Hyperlink', key: 'O', cmd: 'contextMenu.hyperlink.open' },
    { label: 'Copy Hyperlink', key: 'C', cmd: 'contextMenu.hyperlink.copy' },
    { label: 'Remove Hyperlink', key: 'R', cmd: 'contextMenu.hyperlink.remove' },
    SEP, ...text(hit)],
  field: () => [CUT, COPY, PASTE_OPTIONS, SEP,
    { label: 'Update Field', key: 'U', cmd: 'fieldsUi.update' },
    { label: 'Edit Field...', key: 'E', cmd: 'fieldsUi.dialog' },
    { label: 'Toggle Field Codes', key: 'T', cmd: 'fieldsUi.toggle' },
    SEP, FONT, PARAGRAPH],
  comment: () => [CUT, COPY, PASTE, SEP,
    { label: 'Edit Comment', key: 'E', cmd: 'comments.cards', arg: 'edit' },
    { label: 'Reply To Comment', key: 'M', at: 12, cmd: 'comments.cards', arg: 'reply' },
    { label: 'Delete Comment', key: 'M', cmd: 'review.comments.delete.delete' },
    { label: 'Mark Comment Done', key: 'O', cmd: 'comments.resolve' },
    SEP, FONT, PARAGRAPH, SEP, NEW_COMMENT],
  revision: (hit) => [
    { label: `Accept ${changeName(hit.revision)}`, key: 'E', cmd: 'review.tracking.accept.acceptThisChange', alt: 'review.tracking.accept' },
    { label: `Reject ${changeName(hit.revision)}`, key: 'R', cmd: 'review.tracking.reject.rejectChange', alt: 'review.tracking.reject' },
    { label: 'Track Changes', key: 'T', cmd: 'review.tracking.trackChanges' },
    SEP, CUT, COPY, PASTE, SEP, NEW_COMMENT],
  headings: text,
  footnote: (hit) => {
    const foot = (hit.note ?? hit.story) !== 'endnote';
    return [CUT, COPY, PASTE, SEP, FONT, PARAGRAPH, { label: 'Style...', key: 'S', cmd: 'home.styles.launcher' }, SEP,
      { label: foot ? 'Go to Footnote' : 'Go to Endnote', key: 'G', cmd: 'notes.doubleClickMark' },
      { label: 'Note Options...', key: 'N', cmd: 'references.footnotes.launcher' },
      { label: foot ? 'Convert to Endnote' : 'Convert to Footnote', key: 'V', cmd: 'notes.convert', arg: 'this' },
      SEP, NEW_COMMENT];
  },
  equation: () => [CUT, COPY, PASTE, SEP,
    { label: 'Professional', key: 'P', cmd: 'equation.conversions.convert.currentProfessional' },
    { label: 'Linear', key: 'L', cmd: 'equation.conversions.convert.currentLinear' },
    { label: 'Save as New Equation...', key: 'S', cmd: 'equation.tools.equation.saveSelectionToEquationGallery' },
    SEP, FONT, PARAGRAPH],
  header: (hit) => [hit.headerArea === 'footer'
    ? { label: 'Edit Footer', key: 'E', cmd: 'insert.headerFooter.footer.editFooter' }
    : { label: 'Edit Header', key: 'H', cmd: 'insert.headerFooter.header.editHeader' }],
};

/** The context of `hit` → one of the 14 menu ids (contextMenu.<id>), the most specific first. */
export function contextOf(hit) {
  if (hit.headerArea) return 'header';
  if (hit.revision) return 'revision';
  if (hit.comment || hit.story === 'comment') return 'comment';
  if (hit.field) return 'field';
  if (hit.equation || hit.story === 'equation') return 'equation';
  if (hit.picture) return 'picture';
  if (hit.shape) return 'shape';
  if (hit.link) return 'hyperlink';
  if (hit.table) return 'table';
  if (hit.note || hit.story === 'footnote' || hit.story === 'endnote') return 'footnote';
  if (hit.list) return 'lists';
  if (hit.heading) return 'headings';
  return 'text';
}

/** The spelling card on top of a misspelling's menu (contextMenu.spelling): up to three suggestions, each with Read Aloud and
 * Change All in its submenu, then Add to Dictionary, Ignore All and See More. */
export function spellingEntries({ word, suggestions = [] }) {
  return [
    ...suggestions.slice(0, 3).map((w) => ({
      label: w, act: 'replace', arg: w, bold: true, sub: [
        { label: 'Read Aloud', key: 'R', act: 'speak', arg: w },
        { label: 'Change All', key: 'A', act: 'changeAll', arg: w },
      ],
    })),
    { label: 'Add to Dictionary', key: 'A', act: 'learn', arg: word },
    { label: 'Ignore All', key: 'I', act: 'ignoreAll', arg: word },
    { label: 'See More', cmd: 'proofing.pane' },
    SEP,
  ];
}

/** Drops leading, trailing and doubled separators. */
const tidy = (list) => list.filter((e, i, a) => !e.sep || (i > 0 && i < a.length - 1 && !a[i - 1].sep));

/** `entries` as drawn when `has(cmd)` says which commands exist: an entry with a reason stays, disabled with it; an entry whose
 * command is missing drops out (a revision entry falls back to its `alt`); a submenu with nothing left drops out; a spec menu
 * entry stays while its command or one of its menu's items (`menus`: the spec MENUS) is registered. */
export function filterEntries(entries, has, menus = {}) {
  const out = [];
  for (const e of entries) {
    if (e.sep || e.act) out.push(e);
    else if (e.needs) out.push({ ...e, disabled: true, reason: REASONS[e.needs] ?? REASONS.pending });
    else if (e.sub) {
      const sub = filterEntries(e.sub, has, menus);
      if (sub.some((s) => !s.sep)) out.push({ ...e, sub });
    } else if (e.menu) {
      if (has(e.cmd) || (menus[e.menu] ?? []).some((m) => m.item && has(m.item))) out.push(e);
    } else if (has(e.cmd)) out.push(e);
    else if (e.alt && has(e.alt)) out.push({ ...e, cmd: e.alt });
  }
  return tidy(out);
}

/** The menu for `hit` ({story, spelling: {word, suggestions} | null, list, numbered, table, cells, picture, shape, link, field, comment,
 * revision: {kind, op?} | null, heading, note, equation, headerArea: 'header' | 'footer' | null, selection, word}) → {id, entries}.
 * `has(cmd)` filters the entries (filterEntries); without it every entry comes back. */
export function menuFor(hit, { has, menus } = {}) {
  const id = contextOf(hit);
  const entries = [...(hit.spelling && id !== 'header' ? spellingEntries(hit.spelling) : []), ...MENUS[id](hit)];
  return { id: hit.spelling && id !== 'header' ? 'spelling' : id, entries: has ? filterEntries(entries, has, menus) : tidy(entries) };
}

/** The entries of `entries` (one level) whose access key is `letter`; disabled entries and separators never match. `at` on an
 * entry is the index Word's caption puts the & before, where it is not the first copy of the letter. */
export const entriesForKey = (entries, letter) => entries.filter((e) => !e.sep && !e.disabled && e.key && e.key === letter.toUpperCase());
/** The first of them, or null. */
export const entryForKey = (entries, letter) => entriesForKey(entries, letter)[0] ?? null;

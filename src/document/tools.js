// A Document's tools (docs/plans/document.md Ribbon, agentsAndTools): documentTools(ed), the definitions the ribbon, the draft
// menu, Word's base commands and the tool search share; DOC_TOOLS are the tool search entries of the Home tab's controls
// (app/tools.js spreads them into its registry). Every entry needs format.document; the shared text entries (Bold, Align,
// Bullets, Undo) run through the open format's T, so they serve Documents too. A forum post's tools are pool commands
// (app/pool.js), which never reach a Document.
import { createElement as h, useEffect, useState } from 'react';
import {
  AArrowDown, AArrowUp, AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, BetweenHorizontalEnd, BetweenVerticalEnd, Frame, Grid2x2X, Italic, Link,
  List, Redo2, RemoveFormatting, SquareKanban, Strikethrough, Subscript, Superscript, Undo2, Workflow, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowDownToLine, ArrowUpToLine, Baseline,
  BetweenHorizontalStart, BetweenVerticalStart, Captions, CaseSensitive, ALargeSmall, ClipboardPaste, ClipboardType, Copy, FileText, Hash, Highlighter,
  ImagePlus, IndentDecrease, IndentIncrease, ListOrdered, ListTree, Mic, MoveHorizontal, PaintBucket, PanelsLeftRight, Pilcrow, Proportions,
  RectangleHorizontal, Rows2, Scan, Scissors, SeparatorHorizontal, Settings2, Table, TableCellsMerge, TableCellsSplit, TextCursorInput, Underline,
  Type, UnfoldVertical, WholeWord,
} from 'lucide-react';
import { MAX_SIZE, MIN_SIZE } from '../office.mjs';
import { addImageFilesToEditor } from '../whiteboard.js';
import { PICTURE_ACCEPT } from '../tooling/metafile.mjs';
import { afterNodeSel, fitSheet, insertCanvas, openDialog, openLinkDialog, run, setZoom, toast } from '../app/actions.js';
import { insertFlowchartDialog } from '../app/flows.js';
import { insertPlanChartDialog } from '../app/plans.js';
import { toggleDictation } from '../app/dictation/dictation.js';
import { withKey } from '../app/keybinds.js';
import { getState } from '../app/store.js';
import { saveDocx } from './docx/files.js';
import { paneOpen, togglePane } from '../tooling/panes.jsx';
import { ctxOf, run as runCommand, targetEditor } from '../tooling/registry.js';
import { activeSurface } from '../tooling/surface.js';
import { base64 } from '../tooling/base64.mjs';
import { kindOf, levelOf } from './numbering.mjs';
import { marginPreset, paperSize, sectFor, tooSmall, unitOf } from './pages.mjs';
import { effectiveProps } from './schema.js';
// Ribbon.jsx imports this module too: its controls are used only when an entry's options render, never at load.
import {
  ColorPanel, FontBox, HighlightPanel, LineSpacingList, MarginsList, NumberingList, OrientationList, PageNumberList, ParagraphFields, ShadingPanel, SizeBox,
  SizeList, TableGrid, UnderlineList,
} from './Ribbon.jsx';
// The Word layer (docs/plans/word plan.md §1.2): its hub registers the base commands and every work package's module. Imported
// here, where the Document's tools load. editors.js cannot import it: the hub pulls in .jsx files and Node tests load
// editors.js, so actions.js hands the hub's extensions over through setModuleExtensions.
import './wp/index.js';

/** The Styles gallery (docs/plans/document.md Ribbon): [styleId, name] in Word's order (its quick styles by priority, observed
 * through COM in Word 16.0.20527); Heading 4-6 show once the Document has one (HEADINGS_MORE). */
export const GALLERY = [['Normal', 'Normal'], ['NoSpacing', 'No Spacing'], ['Heading1', 'Heading 1'], ['Heading2', 'Heading 2'], ['Heading3', 'Heading 3'],
  ['Title', 'Title'], ['Subtitle', 'Subtitle'], ['Quote', 'Quote'], ['IntenseQuote', 'Intense Quote'], ['ListParagraph', 'List Paragraph']];
export const HEADINGS_MORE = [4, 5, 6].map((n) => [`Heading${n}`, `Heading ${n}`]);

/** Clipboard commands as the draft menu runs them (main.js editMenu.act: the window's own cut, copy and paste). */
export const clip = (name) => () => window.api.editMenu.act(name);

/** Opens Word's Word Count dialog (the proofing package's review.proofing.wordCount). */
export const openWordCount = () => runCommand('review.proofing.wordCount');

const tool = (title, keyId, onClick, icon) => ({ title: withKey(title, keyId), keyId, onClick, children: h(icon) });

// Detached file input of Insert > Pictures (click() opens the picker): pictures only, as inline image nodes (whiteboard.js
// addImageFilesToEditor branches on the Document's schema).
const pictureInput = Object.assign(document.createElement('input'), { type: 'file', accept: PICTURE_ACCEPT, multiple: true });
pictureInput.addEventListener('change', () => {
  const files = [...pictureInput.files];
  pictureInput.value = '';
  // The command target: an open header, footer or note story takes the picture, else the body.
  const editor = targetEditor() ?? getState().editor;
  if (files.length && editor) addImageFilesToEditor(editor, files);
});

/** Insert > Table: a `rows` x `cols` table in the Table Grid style (the schema's default), no header row, as Word inserts. */
export const insertTable = (rows, cols) => (engine() ? runCommand('insert.tables.table', { rows, cols })
  : run((c) => afterNodeSel(c).insertTable({ rows, cols, withHeaderRow: false })));

// ---------- Canvas drafts (docs/plans/engine/stage2.md, the Stage 2.0 scaffold) ----------
// The tool search entries no Word command covers (search.js COVERED) act on the focused canvas draft's engine session there, as
// the covered ones do through their Word commands, so they never reach the DOM editor under the canvas. Their gates read the
// engine's selection there (app/tools.js toolContext), and a covered entry shows as its command does, so no `also` reads the DOM
// editor's T on a canvas draft.

/** The focused canvas draft's SessionClient, or null on the DOM path. */
const engine = () => activeSurface()?.session ?? null;

/** Whether the canvas draft's caret is in a table (the engine's document.context, base.js contextOf). */
const engineInTable = () => !!ctxOf().in?.table;

/** Indent and spacing fields on a canvas draft: the caret paragraph's resolved values from the engine (format), each change
 * through para.indents or para.spacing. */
function EngineParagraphFields({ session }) {
  const [para, setPara] = useState(null);
  const read = () => Promise.resolve(session.format()).then((f) => setPara(f?.para ?? null), () => {});
  useEffect(() => {
    read();
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  const field = (key, id, param) => ({ value: para?.[key] ?? 0, set: (pt) => Promise.resolve(session.exec(id, { [param]: pt })).then(read) });
  return h(ParagraphFields, { T: { unit: unitOf(getState().settings?.paper), indentLeft: field('indentLeft', 'para.indents', 'left'),
    indentRight: field('indentRight', 'para.indents', 'right'), spaceBeforePt: field('spaceBefore', 'para.spacing', 'before'),
    spaceAfterPt: field('spaceAfter', 'para.spacing', 'after') } });
}

/** Save as Word file from a canvas draft: the engine writes the .docx (as file.export.changeFileType does there). */
async function saveEngineDocx(session) {
  const name = `${(getState().draft?.title || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Document'}.docx`;
  try {
    const bytes = await session.save('docx');
    const path = await (globalThis.__wordTest?.word ?? window.api.word).saveFile({ name, data: base64(bytes),
      filters: [{ name: 'Word Document', extensions: ['docx'] }], as: 'base64' });
    if (path) toast('Saved as a Word document.');
    return path;
  } catch (e) {
    toast(`Could not save the Word file: ${e?.message ?? e}`, true);
    return null;
  }
}

/** The selected picture's alt text from the Alt text dialog (Dialogs.jsx 'altText'). */
export async function editAltText() {
  const ed = getState().editor;
  const alt = ed?.state.selection.node?.attrs.alt;
  if (ed?.state.selection.node?.type.name !== 'image') return;
  const value = await openDialog('altText', { alt: alt ?? '' });
  if (value != null) run((c) => c.setAltText(value));
}

/** Layout > Margins, Orientation and Size, Insert > Page number, the Page Setup dialog and the tool search: the open Document's
 * sect with `args` (pages.mjs sectFor: {size?, orientation?, margins?, pageNumber?}) applied, one undo step, as doc.pageSetup writes it. False when the
 * margins would leave no room for text. */
export function pageSetup(args) {
  const ed = getState().editor;
  const sect = ed && sectFor(ed.state.doc.attrs.sect, args);
  if (!sect) return false;
  const small = tooSmall(sect);
  if (small) {
    toast(small, true);
    return false;
  }
  // The same page again (a preset already in use, Apply with no edit) adds no undo step.
  if (JSON.stringify(sect) !== JSON.stringify(ed.state.doc.attrs.sect)) run((c) => c.command(({ tr }) => !!tr.setDocAttribute('sect', sect)));
  return true;
}

/** The Page Setup dialog (Custom margins, More sizes; Dialogs.jsx 'pageSetup'), `focus` 'margins' or 'paper' first. */
export async function openPageSetup(focus = 'margins') {
  const ed = getState().editor;
  if (!ed) return;
  const value = await openDialog('pageSetup', { sect: ed.state.doc.attrs.sect, unit: unitOf(getState().settings?.paper), focus });
  if (value) pageSetup(value);
}

/** View > Navigation pane (NavPane.jsx, the pane 'navigation' of src/tooling/panes.jsx), shown beside the editor area while on. */
export const toggleNavPane = () => togglePane('navigation');

/** The Document's tools for editor `ed` (null while there is none): its marks, lists, alignment, tables, inserts and history,
 * its run and paragraph controls: {value, set} for the value controls, ToolButton props for the buttons. Values are what the
 * text shows, its direct formatting else its style's (schema.js effectiveProps). */
export function documentTools(ed) {
  const state = ed?.state;
  const para = state?.selection.$from.parent;
  const props = para?.attrs.numbering !== undefined ? effectiveProps(state.doc, para) : null;
  const rs = ed?.getAttributes('textStyle') ?? {};
  const num = para?.attrs.numbering;
  const kind = num ? kindOf(state.doc.attrs.numbering, num.numId) : null;
  const spacing = props?.para.spacing ?? {};
  const picked = state?.selection.node;
  const cell = state && cellAt(state);
  // The page members read the main doc's sect, which pageSetup writes, also while a story editor (a header) is the target.
  const sect = (getState().editor ?? ed)?.state.doc.attrs.sect;
  // Every change goes to `ed` itself, which is a story editor (a header, a note) when the Word registry targets one.
  const go = (fn) => !!ed && fn(ed.chain().focus()).run();
  const on = (title, keyId, cmd, icon) => tool(title, keyId, () => go((c) => c[cmd]()), icon);
  const mark = (title, keyId, name, cmd, icon) => ({ ...on(title, keyId, cmd, icon), active: !!ed?.isActive(name) });
  const cells = (title, cmd, children) => ({ title, onClick: () => go((c) => c[cmd]()), children });
  // Active from the alignment the text shows, its own else its style's (a Quote paragraph is centred by its style).
  const align = (title, id, value, icon) => ({ ...tool(title, id, () => go((c) => c.setTextAlign(value)), icon), active: (props?.para.align ?? 'left') === value });
  return {
    undo: { ...on('Undo', 'edit.undo', 'undo', Undo2), disabled: !ed?.can().undo() },
    redo: { ...on('Redo', 'edit.redo', 'redo', Redo2), disabled: !ed?.can().redo() },
    bold: mark('Bold', 'text.bold', 'bold', 'toggleBold', Bold),
    italic: mark('Italic', 'text.italic', 'italic', 'toggleItalic', Italic),
    underline: mark('Underline', 'text.underline', 'underline', 'toggleUnderline', Underline),
    strike: mark('Strikethrough', 'text.strike', 'strike', 'toggleStrike', Strikethrough),
    sub: mark('Subscript', 'text.subscript', 'subscript', 'toggleSubscript', Subscript),
    sup: mark('Superscript', 'text.superscript', 'superscript', 'toggleSuperscript', Superscript),
    theme: state?.doc.attrs.theme,
    alignLeft: align('Align left', 'document.alignLeft', 'left', AlignLeft),
    alignCenter: align('Align centre', 'document.alignCenter', 'center', AlignCenter),
    alignRight: align('Align right', 'document.alignRight', 'right', AlignRight),
    justify: align('Justify', 'document.justify', 'justify', AlignJustify),
    bulletList: { ...on('Bullets', 'text.bulletList', 'toggleBulletList', List), active: kind === 'bullet' },
    orderedList: { ...on('Numbering', 'text.orderedList', 'toggleOrderedList', ListOrdered), active: kind === 'number' },
    // Word's Clear All Formatting (schema.js clearFormatting): hyperlinks stay.
    clear: { title: 'Clear formatting', onClick: () => go((c) => c.clearFormatting()), children: h(RemoveFormatting) },
    style: { value: props?.styleId ?? 'Normal', set: (id) => go((c) => c.setStyle(id)) },
    font: { value: rs.font ?? props?.run.font ?? '+minor', set: (font) => go((c) => c.setMark('textStyle', { font })) },
    size: {
      value: rs.size ?? props?.run.size ?? 12,
      set: (pt) => {
        const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(pt * 2) / 2));
        if (Number.isFinite(size)) go((c) => c.setMark('textStyle', { size }));
      },
    },
    grow: tool('Grow font', 'document.growFont', () => go((c) => c.growFont()), AArrowUp),
    shrink: tool('Shrink font', 'document.shrinkFont', () => go((c) => c.shrinkFont()), AArrowDown),
    underlineStyle: { value: ed?.isActive('underline') ? ed.getAttributes('underline').val ?? 'single' : null, set: (val) => go((c) => c.setMark('underline', { val })) },
    // Automatic (null) and a picked colour; `themeColor` {slot, lum} when it came from the theme grid.
    color: {
      title: 'Font colour', value: rs.color ?? null, themeColor: rs.themeColor ?? null,
      set: (color, themeColor = null) => go((c) => c.setMark('textStyle', { color, themeColor }).removeEmptyTextStyle()),
    },
    highlight: { title: 'Highlight', value: rs.highlight ?? null, set: (highlight) => go((c) => c.setMark('textStyle', { highlight }).removeEmptyTextStyle()) },
    numbering: { value: kind === 'number' ? state.doc.attrs.numbering.nums[num.numId]?.abstract : null, set: (abstract) => go((c) => c.applyList(abstract)) },
    indent: tool('Increase indent', 'document.indent', () => go((c) => c.increaseIndent()), IndentIncrease),
    outdent: tool('Decrease indent', 'document.outdent', () => go((c) => c.decreaseIndent()), IndentDecrease),
    lineSpacing: { value: spacing.line?.rule === 'auto' ? spacing.line.value : null, set: (m) => go((c) => c.setLineSpacing(m)) },
    // Add or remove space before / after: 12 pt where there is none, else none.
    spaceBefore: { value: spacing.before ?? 0, toggle: () => go((c) => c.setSpacing({ before: spacing.before ? 0 : 12 })) },
    spaceAfter: { value: spacing.after ?? 0, toggle: () => go((c) => c.setSpacing({ after: spacing.after ? 0 : 12 })) },
    // Layout (step 7): the page, and the paragraph's indents and spacing as spinners. The spinners write without taking the
    // focus, so typing in them goes on.
    margins: { value: sect && marginPreset(sect), set: (margins) => pageSetup({ margins }) },
    orientation: { value: sect?.orient, set: (orientation) => pageSetup({ orientation }) },
    paperSize: { value: sect && paperSize(sect), set: (size) => pageSetup({ size }) },
    // Insert > Page number (step 9): {at, align} on every page, null for none.
    pageNumber: { value: sect?.pageNumber ?? null, set: (pageNumber) => pageSetup({ pageNumber }) },
    unit: unitOf(getState().settings?.paper),
    ...Object.fromEntries([['indentLeft', 'indent', 'left'], ['indentRight', 'indent', 'right'], ['spaceBeforePt', 'spacing', 'before'],
      ['spaceAfterPt', 'spacing', 'after']].map(([key, attr, side]) => [key, {
      // A list paragraph's text sits at its level's indent (lists.js --list-left) unless the paragraph sets its own, as in Word.
      value: (key === 'indentLeft' && num && para.attrs.indent?.left == null ? levelOf(state.doc.attrs.numbering, num.numId, num.ilvl)?.left : null)
        ?? props?.para[attr][side] ?? 0,
      set: (pt) => ed?.chain()[attr === 'indent' ? 'setIndent' : 'setSpacing']({ [side]: pt }).run(),
    }])),
    // View
    navPane: { title: 'Navigation pane', active: paneOpen('navigation'), onClick: toggleNavPane, children: h(ListTree) },
    zoom100: { title: '100%', onClick: () => setZoom(100), children: h(Scan) },
    onePage: { title: 'One page', onClick: () => fitSheet(true), children: h(FileText) },
    pageWidth: { title: 'Page width', onClick: () => fitSheet(false), children: h(MoveHorizontal) },
    // Insert (step 6): Link, Insert canvas, flowchart and plan chart as a forum post has them (app/actions.js, flows.js and plans.js
    // serve both formats).
    link: { ...tool('Link', 'text.link', openLinkDialog, Link), active: !!ed?.isActive('link') },
    canvas: tool('Insert canvas', 'insert.canvas', insertCanvas, Frame),
    flowchart: { ...tool('Insert flowchart', 'insert.flowchart', insertFlowchartDialog, Workflow), disabled: !ed },
    planChart: { title: 'Insert plan chart', onClick: insertPlanChartDialog, children: h(SquareKanban), disabled: !ed },
    // Off on a selected block and across paragraphs or cells, where setPageBreak refuses (in a cell it splits the table).
    pageBreak: { ...tool('Page break', 'document.pageBreak', () => go((c) => c.setPageBreak()), SeparatorHorizontal), disabled: !ed?.can().setPageBreak() },
    image: { title: 'Pictures', onClick: () => pictureInput.click(), children: h(ImagePlus) },
    picture: { alt: picked?.type.name === 'image' ? picked.attrs.alt ?? '' : null, edit: editAltText },
    // The Table tab (while the caret is in a table) and the draft menu's Table submenu.
    addRow: cells('Add row after', 'addRowAfter', h(BetweenHorizontalEnd)),
    addColumn: cells('Add column after', 'addColumnAfter', h(BetweenVerticalEnd)),
    deleteRow: cells('Delete row', 'deleteRow', '-Row'),
    deleteColumn: cells('Delete column', 'deleteColumn', '-Col'),
    deleteTable: cells('Delete table', 'deleteTable', h(Grid2x2X)),
    rowAbove: cells('Insert above', 'addRowBefore', h(BetweenHorizontalStart)),
    rowBelow: cells('Insert below', 'addRowAfter', h(BetweenHorizontalEnd)),
    columnLeft: cells('Insert left', 'addColumnBefore', h(BetweenVerticalStart)),
    columnRight: cells('Insert right', 'addColumnAfter', h(BetweenVerticalEnd)),
    merge: { title: 'Merge cells', disabled: !ed?.can().mergeCells(), onClick: () => go((c) => c.mergeCells()), children: h(TableCellsMerge) },
    split: { title: 'Split cells', disabled: !ed?.can().splitCell(), onClick: () => go((c) => c.splitCell()), children: h(TableCellsSplit) },
    headerRow: { title: 'Header row', active: !!state && headerRow(state), onClick: () => go((c) => c.toggleHeaderRow()), children: h(Rows2) },
    shading: { value: cell?.attrs.shading ?? null, set: (color) => go((c) => c.setCellAttribute('shading', color)) },
    cellAlign: Object.fromEntries([['top', 'Align top', AlignVerticalJustifyStart], ['center', 'Align centre vertically', AlignVerticalJustifyCenter],
      ['bottom', 'Align bottom', AlignVerticalJustifyEnd]].map(([v, title, icon]) => [v, { title, active: (cell?.attrs.vAlign ?? 'top') === v,
      onClick: () => go((c) => c.setCellAttribute('vAlign', v === 'top' ? null : v)), children: h(icon) }])),
  };
}

/** Whether the first row of the table holding the selection is a header row (Table > Header row). */
function headerRow(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return $from.node(d).firstChild?.firstChild?.type.name === 'tableHeader';
  return false;
}

/** The table cell holding the selection's start, or null. */
function cellAt(state) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.spec.tableRole?.endsWith('cell')) return $from.node(d);
  return null;
}

// The tool search entries (SPEC §7c). Formatting needs a caret or text selection in a Document's text, never a board.
const DOC = ['doc.open', 'view.editor', 'node.none', 'format.document'];
const noBoard = (c) => !c.board;
const INSERT = ['doc.open', 'view.editor', 'format.document']; // a node-selected block too: the insert goes after it
const TABLE = [...INSERT, 'doc.inTable'];
const PAGE = INSERT; // the page and the view, whatever is selected
const entry = (id, label, icon, keywords, more) => ({ id: `doc-${id}`, label, group: 'Text', icon: h(icon), keywords, needs: DOC, also: noBoard, ...more });
const SIZE = ['size', 'font size', 'text size', 'points', 'pt', 'bigger', 'smaller', 'larger'];

export const DOC_TOOLS = [
  entry('font', 'Font', CaseSensitive, ['font', 'typeface', 'font family', 'family', 'fonts', 'aptos', 'calibri', 'arial', 'times new roman', 'cambria',
    'serif', 'sans'], { options: (c) => h(FontBox, { T: c.T, wide: true }) }),
  entry('size', 'Font size', ALargeSmall, SIZE, { options: (c) => h(SizeBox, { T: c.T }) }),
  // Options > Advanced > Font Substitution (fonts/FontSubstitution.jsx): the missing fonts, what draws them, and the font licences.
  entry('font-substitution', 'Font substitution', Type, ['font substitution', 'missing fonts', 'substitute font', 'replace font', 'aptos',
    'download aptos', 'carlito', 'caladea', 'liberation', 'open fonts', 'font licences', 'font licenses', 'not installed'],
  { needs: PAGE, run: () => openDialog('fontSubstitution'), headless: false }),
  entry('grow', 'Grow font', AArrowUp, ['grow font', 'increase font size', 'bigger', 'larger', ...SIZE], { key: 'document.growFont', run: (c) => c.T.grow.onClick() }),
  entry('shrink', 'Shrink font', AArrowDown, ['shrink font', 'decrease font size', 'smaller', ...SIZE], { key: 'document.shrinkFont', run: (c) => c.T.shrink.onClick() }),
  entry('underline-style', 'Underline style', Underline, ['underline', 'double underline', 'thick underline', 'dotted', 'dashed', 'wave', 'wavy'],
    { options: (c) => h(UnderlineList, { T: c.T }) }),
  entry('color', 'Font colour', Baseline, ['font colour', 'font color', 'text colour', 'text color', 'colour', 'color', 'red', 'blue', 'green',
    'theme colours', 'automatic', 'hex'], { options: (c) => h(ColorPanel, { T: c.T }) }),
  entry('highlight', 'Text highlight colour', Highlighter, ['highlight', 'highlighter', 'marker', 'yellow', 'text highlight colour', 'background'],
    { options: (c) => h(HighlightPanel, { T: c.T }) }),
  entry('numbering', 'Numbering library', ListOrdered, ['numbering', 'numbered list', 'ordered list', 'letters', 'roman numerals', 'a b c', 'i ii iii'],
    { options: (c) => h(NumberingList, { T: c.T }) }),
  entry('indent', 'Increase indent', IndentIncrease, ['indent', 'increase indent', 'tab', 'move right', 'demote'], { key: 'document.indent', run: (c) => c.T.indent.onClick() }),
  entry('outdent', 'Decrease indent', IndentDecrease, ['outdent', 'decrease indent', 'move left', 'promote', 'unindent'],
    { key: 'document.outdent', run: (c) => c.T.outdent.onClick() }),
  entry('line-spacing', 'Line spacing', UnfoldVertical, ['line spacing', 'line and paragraph spacing', 'double spacing', 'single spacing', '1.5',
    'leading', 'spacing'], { options: (c) => h(LineSpacingList, { T: c.T }) }),
  entry('space-before', 'Add or remove space before', ArrowUpToLine, ['space before', 'spacing before', 'paragraph spacing', 'gap above'],
    { run: (c) => c.T.spaceBefore.toggle() }),
  entry('space-after', 'Add or remove space after', ArrowDownToLine, ['space after', 'spacing after', 'paragraph spacing', 'gap below'],
    { run: (c) => c.T.spaceAfter.toggle() }),
  // One entry per gallery style.
  ...[...GALLERY, ...HEADINGS_MORE].map(([id, label]) => entry(`style-${id}`, label, Pilcrow, ['style', 'styles', 'paragraph style', label.toLowerCase(),
    ...(/^Heading/.test(id) ? ['heading', 'title', 'header'] : [])], { run: (c) => c.T.style.set(id), key: id === 'Normal' ? 'document.normalStyle' : undefined })),
  // The clipboard as the draft menu runs it; agents never reach the user's clipboard.
  entry('paste', 'Paste', ClipboardPaste, ['paste', 'clipboard', 'insert copied'], { group: 'Edit', run: clip('paste'), headless: false, shortcut: 'Ctrl+V' }),
  entry('paste-text', 'Paste as plain text', ClipboardType, ['paste text only', 'keep text only', 'paste plain', 'paste without formatting'],
    { group: 'Edit', run: clip('pasteAndMatchStyle'), headless: false, shortcut: 'Ctrl+Shift+V' }),
  entry('cut', 'Cut', Scissors, ['cut', 'clipboard'], { group: 'Edit', run: clip('cut'), headless: false, shortcut: 'Ctrl+X' }),
  entry('copy', 'Copy', Copy, ['copy', 'clipboard'], { group: 'Edit', run: clip('copy'), headless: false, shortcut: 'Ctrl+C' }),
  entry('dictate', 'Dictate', Mic, ['dictate', 'dictation', 'speech', 'voice', 'microphone', 'talk'], { group: 'Edit', needs: ['format.document'],
    run: toggleDictation, headless: false, key: 'app.dictate' }),
  entry('save-docx', 'Save as Word file', FileText, ['save as', 'export', 'word', 'docx', 'microsoft word', 'download', 'change file type'],
    { group: 'Edit', needs: ['format.document'], run: () => (engine() ? saveEngineDocx(engine()) : saveDocx(getState().draft?.title)), headless: false }),
  entry('word-count', 'Word count', WholeWord, ['word count', 'words', 'characters', 'count', 'statistics', 'paragraphs'],
    { group: 'Edit', needs: ['format.document'], run: openWordCount, headless: false }),

  // Insert. Link, Insert canvas, flowchart and plan chart are the shared entries.
  entry('page-break', 'Page break', SeparatorHorizontal, ['page break', 'new page', 'break', 'next page', 'ctrl enter'],
    { group: 'Insert', needs: INSERT, also: (c) => noBoard(c) && (!!engine() || !c.T.pageBreak.disabled), key: 'document.pageBreak', run: (c) => c.T.pageBreak.onClick() }),
  entry('table', 'Insert table', Table, ['table', 'grid', 'rows', 'columns', 'cells', 'table grid', 'tabel'],
    { group: 'Insert', needs: INSERT, options: () => h(TableGrid) }),
  entry('pictures', 'Pictures', ImagePlus, ['picture', 'pictures', 'image', 'photo', 'img', 'insert picture', 'png', 'jpg', 'screenshot', 'graphic'],
    { group: 'Insert', needs: INSERT, run: (c) => c.T.image.onClick(), headless: false }),
  entry('page-number', 'Page number', Hash, ['page number', 'page numbers', 'number pages', 'footer', 'header', 'page x', 'pagination'],
    { group: 'Insert', needs: PAGE, via: 'doc.pageSetup', options: (c) => h(PageNumberList, { T: c.T }) }),
  entry('alt-text', 'Alt text', Captions, ['alt text', 'alternative text', 'description', 'accessibility', 'picture', 'image', 'caption'],
    { group: 'Insert', needs: INSERT, also: (c) => noBoard(c) && c.block?.type === 'image', run: editAltText, headless: false }),
  // The Table tab. Delete rows, columns and table and Add row / column after are the shared entries.
  entry('row-above', 'Insert row above', BetweenHorizontalStart, ['insert above', 'row above', 'add row', 'new row', 'table row'],
    { group: 'Insert', needs: TABLE, run: (c) => c.T.rowAbove.onClick() }),
  entry('column-left', 'Insert column left', BetweenVerticalStart, ['insert left', 'column left', 'add column', 'new column', 'table column'],
    { group: 'Insert', needs: TABLE, run: (c) => c.T.columnLeft.onClick() }),
  entry('merge', 'Merge cells', TableCellsMerge, ['merge cells', 'merge', 'combine cells', 'join cells', 'table'],
    { group: 'Insert', needs: TABLE, also: (c) => noBoard(c) && (!!engine() || !c.T.merge.disabled), run: (c) => c.T.merge.onClick() }),
  entry('split', 'Split cells', TableCellsSplit, ['split cells', 'split', 'unmerge', 'divide cell', 'table'],
    // Word's Split Cells (the command it runs in a Document) splits any cell, not only a merged one.
    { group: 'Insert', needs: TABLE, also: noBoard, run: (c) => c.T.split.onClick() }),
  entry('header-row', 'Header row', Rows2, ['header row', 'heading row', 'repeat header', 'table header', 'first row'],
    { group: 'Insert', needs: TABLE, toggle: true, active: (c) => c.T.headerRow.active, run: (c) => c.T.headerRow.onClick() }),
  entry('cell-shading', 'Cell shading', PaintBucket, ['shading', 'cell colour', 'cell color', 'fill', 'background', 'table colour'],
    { group: 'Insert', needs: TABLE, options: (c) => h(ShadingPanel, { T: c.T }) }),
  // On a canvas draft the caret's cell is the engine's (document.context), table.properties sets its alignment and table.cellAlign's
  // state (topLeft, center, bottomRight and the rest) says which is on.
  ...[['top', 'Align top', AlignVerticalJustifyStart], ['center', 'Align centre vertically', AlignVerticalJustifyCenter], ['bottom', 'Align bottom', AlignVerticalJustifyEnd]]
    .map(([v, label, icon]) => entry(`cell-align-${v}`, label, icon, ['cell alignment', 'vertical alignment', 'align cell', v, 'table'],
      { group: 'Insert', needs: INSERT, also: (c) => noBoard(c) && (engine() ? engineInTable() : !!c.ed?.isActive('table')),
        active: (c) => (engine() ? String(ctxOf().stateOf('table.cellAlign')?.value ?? '').startsWith(v) : c.T.cellAlign[v].active),
        run: (c) => (engine() ? engine().exec('table.properties', { valign: v }) : c.T.cellAlign[v].onClick()) })),

  // Layout. Agents set the page with doc.pageSetup and indents and spacing with doc.format paragraph; Breaks is Page break.
  entry('margins', 'Margins', PanelsLeftRight, ['margins', 'page margins', 'narrow', 'moderate', 'wide', 'normal margins', 'custom margins', 'page setup'],
    { group: 'Layout', needs: PAGE, via: 'doc.pageSetup', options: (c) => h(MarginsList, { T: c.T }) }),
  entry('orientation', 'Orientation', RectangleHorizontal, ['orientation', 'landscape', 'portrait', 'rotate page', 'sideways', 'page setup'],
    { group: 'Layout', needs: PAGE, via: 'doc.pageSetup', options: (c) => h(OrientationList, { T: c.T }) }),
  entry('paper-size', 'Paper size', Proportions, ['size', 'paper size', 'page size', 'a4', 'letter', 'legal', 'a5', 'executive', 'paper', 'page setup'],
    { group: 'Layout', needs: PAGE, via: 'doc.pageSetup', options: (c) => h(SizeList, { T: c.T }) }),
  entry('page-setup', 'Page setup', Settings2, ['page setup', 'custom margins', 'more paper sizes', 'custom size', 'margins', 'paper'],
    { group: 'Layout', needs: PAGE, run: () => openPageSetup(), headless: false }),
  entry('paragraph-layout', 'Paragraph indent and spacing', TextCursorInput, ['indent left', 'indent right', 'left indent', 'right indent',
    'spacing before', 'spacing after', 'paragraph spacing', 'indentation'],
  { group: 'Layout', options: (c) => (engine() ? h(EngineParagraphFields, { session: engine() }) : h(ParagraphFields, { T: c.T })) }),
  // View
  entry('nav-pane', 'Navigation pane', ListTree, ['navigation pane', 'navigation', 'outline', 'headings', 'document map', 'go to heading', 'jump'],
    { group: 'View', needs: PAGE, toggle: true, active: (c) => c.T.navPane.active, run: toggleNavPane }),
  entry('zoom-100', 'Zoom 100%', Scan, ['100%', 'zoom', 'actual size', 'real size', 'zoom 100'], { group: 'View', needs: PAGE, run: () => setZoom(100) }),
  entry('one-page', 'One page', FileText, ['one page', 'whole page', 'full page', 'zoom', 'fit page'], { group: 'View', needs: PAGE, run: () => fitSheet(true) }),
  entry('page-width', 'Page width', MoveHorizontal, ['page width', 'fit width', 'zoom', 'wide'], { group: 'View', needs: PAGE, run: () => fitSheet(false) }),
];

/** Whether the surface now is a Document (its tools are documentTools'), the open draft's or a board's focused one (bd-hud). */
export const inDocument = () => activeSurface()?.format === 'document';

// Word's base commands (docs/plans/word plan.md §1.3): every control the left tools island offers today, registered under its
// Word feature id through documentTools (T, src/document/tools.js) and today's functions, so nothing regresses when the island
// goes. A work package that owns a feature replaces its entry here (§1.2 merge rules). Also binds the app's services to the
// product-neutral registry (Word's contexts and the typing test among them) and registers the base panels, galleries and the
// navigation pane. Word's commands serve only the Document surface (DOCUMENT), so a forum post's profile granting the `insert.`,
// `references.` or `view.` prefixes never reaches them.
import { createElement as h } from 'react';
import { canvasEditor } from '../../canvas.js';
import { activeChart } from '../../plan-chart.js';
import { activeBoard } from '../../whiteboard.js';
import {
  acceptActive, acceptAll, afterNodeSel, fitSheet, nextSuggestion, openDialog, previousSuggestion, rejectActive, rejectAll, renameDraft, saveNow, saveSettings,
  setZoom, startNewDraft, toast, toggleToolSearch,
} from '../../app/actions.js';
import { openFind, openReplace } from '../../app/components/FindBar.jsx';
import { toggleDictation } from '../../app/dictation/dictation.js';
import { insertReferenceList, openCitePicker, openReferences, setStyle as setReferenceStyle, styleNow } from '../../app/references.js';
import { getState, setState } from '../../app/store.js';
import { PAPER_SIZES } from '../../office.mjs';
import { STYLES as REFERENCE_STYLES } from '../../references.mjs';
import { both } from '../../tooling/engine-provider.mjs';
import { bindServices, commandOf, registerModule } from '../../tooling/registry.js';
import { setWord } from '../../tooling/ribbon/contexts.js';
import { closePane, openPane, registerPanes, togglePane } from '../../tooling/panes.jsx';
import { defaultSect, THEME } from '../defaults.mjs';
import { sectionOf, withDefaults } from '../model/sections.mjs';
import { NavPane } from '../NavPane.jsx';
import { insertTextFromFile } from '../docx/files.js';
import { ColorPanel, HighlightPanel, PageNumberList, ShadingPanel, TableGrid } from '../Ribbon.jsx';
import { clip, documentTools, editAltText, GALLERY, HEADINGS_MORE, openPageSetup } from '../tools.js';
import { typing } from '../typing.mjs';
import { bindSettings, wordSettings } from './settings.mjs';

/** The surface kinds Word's commands serve (registry register): the open Document only. The work package hub uses it too. */
export const DOCUMENT = ['document'];

const IN_KEYS = ['table', 'picture', 'graphics', 'shape', 'textbox', 'equation', 'header', 'outline', 'immersive', 'field', 'sdt', 'comment',
  'revision', 'smartart', 'chart', 'model3d', 'textboxCompat', 'compat'];

// The engine's object kinds (document.context) that show Shape Format, as a text box, a group, a Word drawing canvas and an
// EasyWriter object (a smart canvas edited in place) do in the DOM editor.
const SHAPE_KINDS = new Set(['shape', 'textbox', 'group', 'drawingCanvas', 'box']);

/** The flags and object of a canvas draft from the engine's document.context (the snapshot's): `obj` is {kind (the engine's
 * object kind), pos (its engine Pos), node: null}. `tabContext` (Word's Ctrl+Tab and Tab rows: a cell, a list item's start or
 * Outline view) is for the keys on a canvas draft (registry keyHolds); the DOM editor's keys work it out themselves. */
function engineContext(c, flags) {
  const kind = c.object?.kind ?? null;
  flags.table = !!c.table;
  flags.picture = kind === 'picture';
  flags.graphics = kind === 'graphic';
  flags.shape = SHAPE_KINDS.has(kind);
  flags.textbox = kind === 'textbox' || c.story?.kind === 'textbox';
  // Word's Text Box tab and legacy shadow tools serve compatibility modes 11 and 12, where a text box is VML (probed 2026-11-02).
  flags.compat = (c.compatMode ?? 15) < 14;
  flags.textboxCompat = flags.compat && flags.textbox;
  if (flags.textboxCompat) flags.shape = false; // the Text Box tab takes Shape Format's place
  flags.chart = kind === 'chart';
  flags.smartart = kind === 'smartArt';
  flags.equation ||= !!c.equation;
  flags.field = !!c.field;
  flags.sdt = !!c.control;
  flags.comment = !!c.comments?.length;
  flags.revision = !!c.revision;
  flags.tabContext = flags.table || flags.outline || (!!c.list && !!c.paraStart);
  return { in: flags, obj: kind ? { kind, pos: c.object.pos, node: null } : null };
}

/** The contextual flags and the object the contextual tabs act on (§1.4 Contexts) for `ctx`'s target state, or on a canvas draft
 * for the engine's document.context; `session` is the canvas being edited in place (canvasEditor), which keeps Shape Format. */
function contextOf(ctx, session) {
  const flags = Object.fromEntries(IN_KEYS.map((k) => [k, false]));
  flags.header = ctx.story === 'header' || ctx.story === 'footer';
  flags.outline = ctx.view === 'outline';
  flags.immersive = ctx.view === 'immersive';
  flags.equation = ctx.story === 'equation';
  if (ctx.engine) {
    const c = ctx.engineState?.['document.context']?.value;
    return c ? engineContext(c, flags) : { in: flags, obj: null };
  }
  let obj = null;
  const st = ctx.state;
  if (st) {
    const sel = st.selection;
    const node = sel.node;
    const name = node?.type.name;
    const { $from } = sel;
    const ancestor = (names) => {
      for (let d = $from.depth; d > 0; d--) if (names.includes($from.node(d).type.name)) return { pos: $from.before(d), node: $from.node(d) };
      return null;
    };
    const marked = (mark) => {
      const t = st.schema.marks[mark];
      return !!t && (sel.empty ? !!t.isInSet(st.storedMarks ?? $from.marks()) : st.doc.rangeHasMark(sel.from, sel.to, t));
    };
    const at = (kind) => ({ kind, pos: sel.from, node });
    flags.table = !!ancestor(['table']);
    if (name === 'image') {
      // An SVG picture gets Graphics Format, any other Picture Format, as Word splits them.
      const svg = /^data:image\/svg/i.test(node.attrs.src ?? '');
      flags[svg ? 'graphics' : 'picture'] = true;
      obj = at(svg ? 'graphic' : 'picture');
    }
    const box = name === 'textBox' ? { pos: sel.from, node } : ancestor(['textBox']);
    if (box) {
      flags.shape = flags.textbox = true;
      obj ??= { kind: 'textbox', ...box };
    }
    if (name === 'canvas') flags.shape = true;
    if (name === 'canvas' || name === 'planChart') obj = at(name);
    if (name === 'chart') { // a chart from a .docx: Chart Design and Format show, their commands still placeholders
      flags.chart = true;
      obj = at('chart');
    }
    if (name === 'equation') {
      flags.equation = true;
      obj = at('equation');
    }
    flags.field = name === 'field' || !!ancestor(['fieldBlock']);
    flags.sdt = name === 'sdtInline' || name === 'sdtBlock' || !!ancestor(['sdtInline', 'sdtBlock']);
    flags.comment = marked('comment');
    flags.revision = marked('insertion') || marked('deletion') || marked('formatChange');
  }
  // A canvas of the main editor open in place keeps Shape Format (the ribbon stays mounted while it is edited).
  if (session && ctx.ed && session.editor === ctx.ed) {
    const pos = (session.target?.getPos ?? session.target?.owner?.getPos)?.(); // a canvas node's session keeps getPos on its owner (canvas.js nodeTarget)
    const node = pos == null ? null : ctx.ed.state.doc.nodeAt(pos);
    if (node) {
      flags.shape = true;
      obj = { kind: 'canvas', pos, node };
    }
  }
  return { in: flags, obj };
}

bindServices({
  toast: (text) => toast(text),
  dialog: (id, props) => openDialog(id, props),
  pane: (id, open, props) => (open === undefined ? togglePane(id, props) : open ? openPane(id, props) : closePane(id)),
  tools: (ed) => documentTools(ed),
  canvas: () => canvasEditor.get(),
  onCanvas: (fn) => canvasEditor.subscribe(fn),
  settings: (s) => s && { ...s, word: wordSettings(s) },
  sect: (state, s) => {
    if (!state) return withDefaults(defaultSect(s?.paper));
    const sec = sectionOf(state.doc, state.selection.from);
    // A one-section document without a stored sect takes the new-document paper from settings, as today.
    return sec.holder == null && !state.doc.attrs.sect ? withDefaults(defaultSect(s?.paper)) : sec.sect;
  },
  contextOf,
  typing,
  board: () => canvasEditor.get()?.board ?? activeBoard.get(), // the board tool search serves (actions.js toggleToolSearch)
  chart: () => activeChart.get(),
});
bindSettings({ settings: () => getState().settings, save: (partial) => saveSettings(partial) });

// ---------------------------------------------------------------------------------------------
// Buttons and toggles that are one T member: feature id → member. A table row is enabled only in a table.

const BUTTONS = {
  'frame.qat.undo': 'undo', 'frame.qat.redoRepeat': 'redo', 'draw.undo.undo': 'undo', 'draw.undo.redoRepeat': 'redo',
  'home.font.growFont': 'grow', 'home.font.shrinkFont': 'shrink', 'home.font.clearFormatting': 'clear', 'home.styles.styles.clearFormatting': 'clear',
  'home.font.bold': 'bold', 'home.font.italic': 'italic', 'home.font.strikethrough': 'strike', 'home.font.subscript': 'sub',
  'home.font.superscript': 'sup', 'home.paragraph.decreaseIndent': 'outdent', 'home.paragraph.increaseIndent': 'indent',
  'home.paragraph.alignLeft': 'alignLeft', 'home.paragraph.center': 'alignCenter', 'home.paragraph.alignRight': 'alignRight', 'home.paragraph.justify': 'justify',
  'insert.pages.pageBreak': 'pageBreak', 'layout.pageSetup.breaks.page': 'pageBreak',
  'insert.illustrations.pictures': 'image', 'insert.illustrations.pictures.thisDevice': 'image',
  'insert.links.link': 'link', 'insert.links.link.insertLink': 'link',
  'insert.illustrations.shapes.newDrawingCanvas': 'canvas', 'x.insert.boards.canvas': 'canvas', 'x.insert.boards.flowchart': 'flowchart',
  'x.insert.boards.planChart': 'planChart',
  'references.citationsBibliography.insertCitation': 'cite', 'references.citationsBibliography.insertCitation.addNewSource': 'references',
  'references.citationsBibliography.manageSources': 'references',
  'view.show.navigationPane': 'navPane', 'review.accessibility.checkAccessibility.navigationPane': 'navPane',
  'view.zoom.zoom100': 'zoom100', 'view.zoom.onePage': 'onePage', 'view.zoom.pageWidth': 'pageWidth',
};
const TABLE_BUTTONS = {
  'tableLayout.rowsColumns.insertRowAbove': 'rowAbove', 'tableLayout.rowsColumns.insertRowBelow': 'rowBelow',
  'tableLayout.rowsColumns.insertColumnLeft': 'columnLeft', 'tableLayout.rowsColumns.insertColumnRight': 'columnRight',
  'tableLayout.rowsColumns.delete.deleteRows': 'deleteRow', 'tableLayout.rowsColumns.delete.deleteColumns': 'deleteColumn',
  'tableLayout.rowsColumns.delete.deleteTable': 'deleteTable', 'tableLayout.merge.mergeCells': 'merge', 'tableLayout.merge.splitCells': 'split',
  'tableDesign.tableStyleOptions.headerRow': 'headerRow',
};
// Formatting F4 repeats (Word's Repeat): the run and paragraph formatting, never inserts or views.
const REPEATS = new Set(['grow', 'shrink', 'clear', 'bold', 'italic', 'strike', 'sub', 'sup', 'outdent', 'indent', 'alignLeft', 'alignCenter', 'alignRight', 'justify']);

const button = (key, inTable) => ({
  run: ({ T }) => T[key].onClick(),
  enabled: (ctx) => (!inTable || ctx.in.table) && !ctx.T[key]?.disabled,
  active: ({ T }) => T[key]?.active,
  repeatable: REPEATS.has(key),
});

// ---------------------------------------------------------------------------------------------
// Lists of options: an option feature id runs its parent's command with its last id segment (plan.md §1.4 Derived items), so
// each option is registered as its own id too, with its active state.

/** The parent command `id` taking `values` (option id segment → value) through `set`, and one command per option. */
function options(id, values, set, current, more = {}) {
  const pick = (ctx, arg) => (arg in values ? set(ctx, values[arg], arg) : false);
  return {
    [id]: { run: pick, value: (ctx) => Object.keys(values).find((k) => current(ctx, values[k], k)) ?? null, ...more },
    ...Object.fromEntries(Object.entries(values).map(([k, v]) => [`${id}.${k}`, {
      run: (ctx) => set(ctx, v, k), active: (ctx) => !!current(ctx, v, k), ...more,
    }])),
  };
}

const LIMITS_INDENT = 1584; // pt, Word's indent limit (22 in)
const SPACINGS = { 10: 1, 115: 1.15, 15: 1.5, 20: 2, 25: 2.5, 30: 3 };
const near = (a, b) => a != null && Math.abs(a - b) < 0.01; // 278/240 shows as 1.15
const MARGINS = { normalMargins: 'normal', narrowMargins: 'narrow', moderateMargins: 'moderate', wideMargins: 'wide' };
// The Underline menu's nine styles (probe/menus/home.underline.json), by the id segment of Word's label; null removes it.
const UNDERLINES = {
  underline: ['single', 'Underline'], doubleUnderline: ['double', 'Double underline'], thickUnderline: ['thick', 'Thick underline'],
  dottedUnderline: ['dotted', 'Dotted underline'], dashedUnderline: ['dash', 'Dashed underline'], dotDashUnderline: ['dotDash', 'Dot-dash underline'],
  dotDotDashUnderline: ['dotDotDash', 'Dot-dot-dash underline'], waveUnderline: ['wave', 'Wave underline'], noUnderline: [null, 'No underline'],
};
// The Numbering library (Word's, without the formats the list definitions lack): definition id → its look.
const NUMBERINGS = [['none', 'None'], ['decimal', '1. 2. 3.'], ['lowerLetterParen', 'a) b) c)'], ['lowerLetter', 'a. b. c.'], ['upperLetter', 'A. B. C.'],
  ['lowerRoman', 'i. ii. iii.'], ['upperRoman', 'I. II. III.']];
// The nine cell alignments of Table Layout > Alignment: vertical then horizontal.
const CELL_ALIGNS = Object.fromEntries(['Top', 'Center', 'Bottom'].flatMap((v) => [['Left', 'left'], ['Center', 'center'], ['Right', 'right']].map(([hn, hv]) => [
  v === 'Center' && hn === 'Center' ? 'alignCenter' : `align${v}${hn}`, [v.toLowerCase(), hv]])));

// Split buttons apply their last-used choice (Word's): Yellow highlight and Red font colour until the user picks another.
let lastHighlight = 'yellow';
let lastColor = { color: '#FF0000', themeColor: null };
let lastShading = null;

/** A spinner of Layout > Paragraph: value and set from T member `key`, its More and Less parts stepping by `step(T)` within `min`. */
const spinner = (id, key, step, min) => ({
  [id]: { value: ({ T }) => T[key].value, run: ({ T }, pt) => (Number.isFinite(Number(pt)) ? T[key].set(Math.max(min, Number(pt))) : false) },
  [`${id}.more`]: { run: ({ T }) => T[key].set(Math.min(LIMITS_INDENT, T[key].value + step(T))) },
  [`${id}.less`]: { run: ({ T }) => T[key].set(Math.max(min, T[key].value - step(T))) },
});
const tenth = (T) => T.unit.pt / 10; // 0.1 cm or 0.1 inch, the island's step

const setView = (view) => setState({ word: { ...getState().word, view } });
const hasSuggestions = () => getState().suggestions.count > 0;
const zoomBy = (d) => setZoom(Math.round(getState().zoomPct / 10) * 10 + d);
// Side to Side (views, store viewsMove) fits the pages to the window and switches the zoom off, as Word does.
const zooms = () => getState().viewsMove?.kind !== 'side';

const COMMANDS = {
  ...Object.fromEntries(Object.entries(BUTTONS).map(([id, key]) => [id, button(key, false)])),
  ...Object.fromEntries(Object.entries(TABLE_BUTTONS).map(([id, key]) => [id, button(key, true)])),

  // Quick Access Toolbar, title bar and File
  'frame.qat.save': { run: () => saveNow() },
  'file.save': { run: () => saveNow() },
  'file.new': { run: () => startNewDraft() },
  'frame.titleBar.search': { run: () => toggleToolSearch() },
  // Word's title bar name renames the file; here the draft.
  'frame.titleBar.documentName': {
    enabled: () => !!getState().draft?.id,
    run: async () => {
      const { draft } = getState();
      const title = await openDialog('renameDraft', { value: draft.title });
      if (title?.trim() && title !== draft.title) await renameDraft(draft.id, title);
      return true;
    },
  },
  'insert.text.object.textFromFile': { enabled: (ctx) => !!ctx.ed, run: (ctx) => insertTextFromFile(ctx.ed) },
  // Collapse the Ribbon (Ctrl+F1 through its window key row, the chevron, a double-click on a tab) until ribbon-chrome replaces it.
  'frame.tabRow.collapse': {
    run: () => setWord({ ribbon: getState().word?.ribbon === 'tabs' ? 'full' : 'tabs', peek: false }),
    active: () => getState().word?.ribbon === 'tabs',
  },

  // Clipboard: the window's own cut, copy and paste, as the draft menu runs them. Keep Text Only pastes without formatting.
  'home.clipboard.paste': { run: (_ctx, arg) => clip(arg === 'keepTextOnly' ? 'pasteAndMatchStyle' : 'paste')() },
  'home.clipboard.cut': { run: () => clip('cut')() },
  'home.clipboard.copy': { run: () => clip('copy')() },

  // Font
  'home.font.font': { value: ({ T }) => T.font.value, run: ({ T }, font) => (font ? T.font.set(font) : false), repeatable: true },
  'home.font.fontSize': { value: ({ T }) => T.size.value, run: ({ T }, pt) => (pt != null ? T.size.set(Number(pt)) : false), repeatable: true },
  'home.font.underline': {
    run: (ctx, arg) => {
      if (arg === undefined) return ctx.T.underline.onClick();
      if (!(arg in UNDERLINES)) return false;
      const val = UNDERLINES[arg][0];
      return val ? ctx.T.underlineStyle.set(val) : ctx.chain((c) => c.unsetMark('underline'));
    },
    active: ({ T }) => T.underline.active,
    value: ({ T }) => Object.keys(UNDERLINES).find((k) => UNDERLINES[k][0] === T.underlineStyle.value) ?? null,
    repeatable: true,
  },
  'home.font.textHighlightColor': {
    run: ({ T }, arg) => {
      if (arg) lastHighlight = arg;
      return T.highlight.set(arg === undefined ? lastHighlight : arg);
    },
    value: () => lastHighlight,
    repeatable: true,
  },
  'home.font.fontColor': {
    // arg: '#RRGGBB', {color, themeColor} from the theme grid, or null for Automatic.
    run: ({ T }, arg) => {
      const pick = arg === undefined ? lastColor : arg && typeof arg === 'object' ? arg : { color: arg, themeColor: null };
      if (pick.color) lastColor = pick;
      return T.color.set(pick.color ?? null, pick.themeColor ?? null);
    },
    value: () => lastColor,
    repeatable: true,
  },

  // Paragraph
  'home.paragraph.bullets': { run: ({ T }, arg) => (arg === undefined ? T.bulletList.onClick() : false), active: ({ T }) => T.bulletList.active },
  'home.paragraph.numbering': {
    run: ({ T }, arg) => {
      if (arg === undefined) return T.orderedList.onClick();
      if (arg === 'none') return T.orderedList.active ? T.orderedList.onClick() : false;
      return NUMBERINGS.some(([id]) => id === arg) ? T.numbering.set(arg) : false;
    },
    active: ({ T }) => T.orderedList.active,
    value: ({ T }) => T.numbering.value,
  },
  ...options('home.paragraph.lineAndParagraphSpacing', SPACINGS, ({ T }, m) => T.lineSpacing.set(m), ({ T }, m) => near(T.lineSpacing.value, m), { repeatable: true }),
  'home.paragraph.lineAndParagraphSpacing.addSpaceBeforeParagraph': {
    run: ({ T }) => T.spaceBefore.toggle(), label: ({ T }) => (T.spaceBefore.value ? 'Remove Space Before Paragraph' : 'Add Space Before Paragraph'),
  },
  'home.paragraph.lineAndParagraphSpacing.removeSpaceAfterParagraph': {
    run: ({ T }) => T.spaceAfter.toggle(), label: ({ T }) => (T.spaceAfter.value ? 'Remove Space After Paragraph' : 'Add Space After Paragraph'),
  },

  // Styles, Editing, Voice
  'home.styles.styles': { value: ({ T }) => T.style.value, run: ({ T }, id) => (id ? T.style.set(id) : false), repeatable: true },
  'home.editing.find': { run: () => openFind() },
  'home.editing.find.find': { run: () => openFind() },
  'home.editing.replace': { run: () => openReplace() },
  'home.editing.select.selectAll': { run: (ctx) => ctx.chain((c) => c.selectAll()) },
  'home.voice.dictate': { run: () => toggleDictation() },
  'home.voice.dictate.dictate': { run: () => toggleDictation() },

  // Insert
  'insert.tables.table': {
    // arg {rows, cols} from the grid: a Table Grid table without a header row, as Word inserts it.
    run: (ctx, arg) => (arg?.rows > 0 && arg?.cols > 0 ? ctx.chain((c) => afterNodeSel(c).insertTable({ rows: arg.rows, cols: arg.cols, withHeaderRow: false })) : false),
  },
  'insert.headerFooter.pageNumber': { value: ({ T }) => T.pageNumber.value, run: ({ T }, arg) => (arg === undefined ? false : T.pageNumber.set(arg)) },
  'insert.headerFooter.pageNumber.topOfPage': { run: ({ T }, align) => T.pageNumber.set({ at: 'top', align: align ?? 'center' }) },
  'insert.headerFooter.pageNumber.bottomOfPage': { run: ({ T }, align) => T.pageNumber.set({ at: 'bottom', align: align ?? 'center' }) },
  'insert.headerFooter.pageNumber.removePageNumbers': { run: ({ T }) => T.pageNumber.set(null), enabled: ({ T }) => T.pageNumber.value != null },

  // Layout
  ...options('layout.pageSetup.margins', MARGINS, ({ T }, k) => T.margins.set(k), ({ T }, k) => T.margins.value === k),
  'layout.pageSetup.margins.customMargins': { run: () => openPageSetup('margins') },
  ...options('layout.pageSetup.orientation', { portrait: 'portrait', landscape: 'landscape' }, ({ T }, v) => T.orientation.set(v),
    ({ T }, v) => T.orientation.value === v),
  'layout.pageSetup.size': { value: ({ T }) => T.paperSize.value, run: ({ T }, k) => (k in PAPER_SIZES ? T.paperSize.set(k) : false) },
  'layout.pageSetup.size.morePaperSizes': { run: () => openPageSetup('paper') },
  'layout.pageSetup.breaks': { run: ({ T }, arg) => (arg === 'page' ? T.pageBreak.onClick() : false), enabled: ({ T }) => !T.pageBreak.disabled },
  'layout.pageSetup.launcher': { run: () => openPageSetup('margins') },
  ...spinner('layout.paragraph.indentLeft', 'indentLeft', tenth, -LIMITS_INDENT),
  ...spinner('layout.paragraph.indentRight', 'indentRight', tenth, -LIMITS_INDENT),
  ...spinner('layout.paragraph.spacingBefore', 'spaceBeforePt', () => 6, 0),
  ...spinner('layout.paragraph.spacingAfter', 'spaceAfterPt', () => 6, 0),

  // View
  'view.views.printLayout': { run: () => setView('print'), active: (ctx) => ctx.view === 'print' },
  'views.zoomIn': { run: () => zoomBy(10), enabled: zooms },
  'views.zoomOut': { run: () => zoomBy(-10), enabled: zooms },
  'statusBar.zoomSlider': { value: () => getState().zoomPct, run: (_ctx, pct) => (Number.isFinite(pct) && zooms() ? (setZoom(pct), true) : false) },

  // Table Layout > Alignment (the cell's vertical alignment and its paragraphs' alignment) and Table Design > Shading
  ...Object.fromEntries(Object.entries(CELL_ALIGNS).map(([key, [v, hz]]) => [`tableLayout.alignment.${key}`, {
    run: (ctx) => ctx.chain((c) => c.setCellAttribute('vAlign', v === 'top' ? null : v).setTextAlign(hz)),
    enabled: (ctx) => ctx.in.table,
    active: ({ T }) => !!T.cellAlign[v]?.active && T[{ left: 'alignLeft', center: 'alignCenter', right: 'alignRight' }[hz]].active,
  }])),
  'tableDesign.tableStyles.shading': {
    run: ({ T }, pick) => {
      // The colours panel passes {color, themeColor}; cells store only the hex (no theme link), as ShadingPanel does.
      const arg = pick && typeof pick === 'object' ? pick.color ?? null : pick;
      if (arg !== undefined) lastShading = arg;
      return T.shading.set(arg === undefined ? lastShading : arg);
    },
    enabled: (ctx) => ctx.in.table,
    value: ({ T }) => T.shading.value,
  },

  // Picture
  'pictureFormat.accessibility.altText': { run: () => editAltText(), enabled: (ctx) => ctx.in.picture || ctx.in.graphics },
  'review.accessibility.checkAccessibility.altText': { run: () => editAltText(), enabled: (ctx) => ctx.in.picture || ctx.in.graphics },

  // References (the references builder)
  'references.citationsBibliography.style': {
    value: () => styleNow(), run: (_ctx, id) => (REFERENCE_STYLES.some(([s]) => s === id) ? setReferenceStyle(id) : false),
  },
  'references.citationsBibliography.bibliography': { run: () => insertReferenceList() },
  'references.citationsBibliography.bibliography.insertBibliography': { run: () => insertReferenceList() },

  // Review: Accept, Reject, Previous and Next over the agent's suggestions
  'review.tracking.accept': { run: () => acceptActive(), enabled: hasSuggestions },
  'review.tracking.accept.acceptThisChange': { run: () => acceptActive(), enabled: hasSuggestions },
  'review.tracking.accept.acceptAllChanges': { run: () => acceptAll(), enabled: hasSuggestions },
  'review.tracking.reject': { run: () => rejectActive(), enabled: hasSuggestions },
  'review.tracking.reject.rejectChange': { run: () => rejectActive(), enabled: hasSuggestions },
  'review.tracking.reject.rejectAllChanges': { run: () => rejectAll(), enabled: hasSuggestions },
  'review.tracking.previous': { run: () => previousSuggestion(), enabled: hasSuggestions },
  'review.tracking.next': { run: () => nextSuggestion(), enabled: hasSuggestions },
};

// ---------------------------------------------------------------------------------------------
// Galleries and menu panels. Panels wrap the island's exported controls; they are used only inside render, so the circular
// import between tools.js and Ribbon.jsx never runs at load.

const PLAIN_NUMBERS = [['left', 'Plain Number 1'], ['center', 'Plain Number 2'], ['right', 'Plain Number 3']].map(([id, label]) => ({ id, label }));

const GALLERIES = {
  // Page Number > Top of Page and Bottom of Page: the plain number at the left, centre or right (Word's Plain Number 1 to 3).
  'insert.headerFooter.pageNumber.topOfPage': () => PLAIN_NUMBERS,
  'insert.headerFooter.pageNumber.bottomOfPage': () => PLAIN_NUMBERS,
  // Paste's options (the island's Paste as plain text): Keep Source Formatting and Keep Text Only run Paste with their id.
  'home.clipboard.paste': () => [{ id: 'keepSourceFormatting', label: 'Keep Source Formatting' }, { id: 'keepTextOnly', label: 'Keep Text Only' }],
  'home.styles.styles': ({ T, state }) => {
    const list = state?.doc.attrs.styles?.list ?? {};
    const used = new Set();
    state?.doc.descendants((n) => {
      if (n.type.name === 'heading') used.add(`Heading${n.attrs.level}`);
      return !n.isTextblock;
    });
    return [...GALLERY, ...HEADINGS_MORE.filter(([id]) => used.has(id))].filter(([id]) => list[id])
      .map(([id, label]) => ({ id, label, active: T.style.value === id }));
  },
  'home.font.underline': ({ T }) => Object.entries(UNDERLINES).map(([id, [val, label]]) => ({ id, label, active: val ? T.underlineStyle.value === val : T.underlineStyle.value == null })),
  'home.paragraph.numbering': ({ T }) => NUMBERINGS.map(([id, label]) => ({ id, label, active: id === 'none' ? !T.orderedList.active : T.numbering.value === id })),
  'layout.pageSetup.size': ({ T }) => Object.entries(PAPER_SIZES).map(([id, p]) => ({ id, label: p.label, group: /^Envelope/.test(p.label) ? 'Envelopes' : 'Paper', active: T.paperSize.value === id })),
  'references.citationsBibliography.style': () => REFERENCE_STYLES.map(([id, label]) => ({ id, label, active: styleNow() === id })),
};

// The theme slots in the engine's order (its Settings.themeColors, theme1.xml's clrScheme).
const THEME_SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const hex = (rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** A canvas draft's theme for the colour grids, from the engine's document settings (ctx.read), else the Office default while the
 * read is on its way. */
function engineTheme(ctx) {
  const s = ctx.read('document.settings');
  const colors = s?.themeColors;
  if (!Array.isArray(colors) || colors.length !== THEME_SLOTS.length) return THEME;
  return { name: s.themeName || THEME.name, fonts: { major: s.majorFont || THEME.fonts.major, minor: s.minorFont || THEME.fonts.minor },
    colors: Object.fromEntries(THEME_SLOTS.map((slot, i) => [slot, hex(colors[i])])) };
}

/** The panels' T: the DOM editor's documentTools, or on a canvas draft one that reads and runs command `cmd` through the registry
 * (its row in the engine table), so a panel picks the same way in both editors. */
function panelT(ctx, cmd) {
  if (!ctx.engine) return ctx.T;
  const value = commandOf(cmd)?.value?.(ctx) ?? null;
  const member = { value, themeColor: value?.themeColor ?? null, set: (v) => ctx.run(cmd, v) };
  return { theme: engineTheme(ctx), color: member, highlight: member, shading: member, pageNumber: member };
}


const PANELS = {
  colors: both(({ ctx, cmd, close }) => {
    const id = cmd ?? 'home.font.fontColor';
    const T = panelT(ctx, id);
    return h(ColorPanel, { T: { theme: T.theme, color: { ...T.color, set: (color, themeColor) => ctx.run(id, { color, themeColor }) } }, onPick: close });
  }),
  highlight: both(({ ctx, cmd, close }) => {
    const id = cmd ?? 'home.font.textHighlightColor';
    return h(HighlightPanel, { T: { highlight: { ...panelT(ctx, id).highlight, set: (v) => ctx.run(id, v) } }, onPick: close });
  }),
  shading: both(({ ctx, cmd, close }) => {
    const id = cmd ?? 'tableDesign.tableStyles.shading';
    const T = panelT(ctx, id);
    return h(ShadingPanel, { T: { theme: T.theme, shading: { ...T.shading, set: (v) => ctx.run(id, v) } }, onPick: close });
  }),
  // The grid inserts through tools.js insertTable, which runs Insert > Table's command on a canvas draft.
  tableGrid: both(({ close }) => h(TableGrid, { onPick: close })),
  pageNumber: both(({ ctx }) => h(PageNumberList, { T: panelT(ctx, 'insert.headerFooter.pageNumber') })),
};

registerPanes('base', { navigation: { title: 'Navigation', side: 'left', width: 16, Component: NavPane } });
// Ctrl+wheel zoom is the app's own (panzoom.js); listed so the benchmark counts it.
registerModule({ id: 'base', commands: COMMANDS, galleries: GALLERIES, panels: PANELS, implements: ['views.ctrlWheel'] }, DOCUMENT);

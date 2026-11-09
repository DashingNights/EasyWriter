import { createElement as h, useEffect, useRef } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  AppWindow, BadgeCheck, Check, CheckCheck, ChevronDown, ChevronUp, ListChecks, ListX, ClipboardPaste, Copy, CopyPlus, FilePlus,
  FileText, FolderInput, FolderPlus, Heading1, Heading2, Heading3, Globe, GraduationCap, Heading4, Heading5, Heading6,
  MessagesSquare, MoveHorizontal, PaintBucket, Palette, Pencil, Pilcrow, Puzzle, Redo2, Save, Replace, Scaling, Scissors, Search,
  MessageSquare, Settings, SlidersHorizontal, SpellCheck, SquarePen, TableColumnsSplit, TableRowsSplit, Tag, Trash2, Undo2,
  WandSparkles, Workflow, X, PenLine, Shapes,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SelectItem } from '@/components/ui/select';
import { canvasEditor, flowSource } from '../canvas.js';
import { cleanTitle, TITLE_LIMIT } from '../doc-utils.mjs';
import { DOC_TOOLS, documentTools, inDocument } from '../document/tools.js';
import { COVERED, cover, reasonOf, WORD_TOOLS } from '../document/ribbon/search.js';
import { TEXT_COLORS } from '../extensions.js';
import { all } from '../integrations/ui.js';
import {
  acceptActive, acceptAll, acceptGroup, canPaste, commitBoardEdit, copyDraft, cutDraft, deleteDraft, nextSuggestion, openSettings,
  pasteDraft, previousSuggestion, rejectActive, rejectAll, rejectGroup, runSetup, saveNow, shownThread, startNewDraft, threadLabel,
} from './actions.js';
import { assistantSettings, saveAssistant, toggleChat } from './assistant/assistant.js';
import { providerSearch, PROVIDER_SEARCH } from '../assistant/search.js';
import { closePanes, HOME, newTab, openPane, openPanes } from './browser.js';
import { invoke } from './commands.js';
import { byId } from './commands/catalogue.mjs';
import { PALETTE } from './commands/palette.mjs';
import { bindTools } from './commands/tool.mjs';
import { ItemControls } from './components/board/ItemRibbon.jsx';
import { notify } from './components/Notices.jsx';
import { openFind, openReplace } from './components/FindBar.jsx';
import { toggleSpellCheck } from './components/StatusBar.jsx';
import { PalettePanel } from '../tooling/kit/ColorPick.jsx';
import { BlockSelect, FontBox, NONE, SizeBox, textTools, ToolButton, ToolSelect } from './components/Toolbar.jsx';
import { startTutorial } from './components/Tutorial.jsx';
import { draftTag, tagList } from './drafts-meta.js';
import { openFlows } from './flows.js';
import { can, GATES } from './gates.mjs';
import { getState, useStore } from './store.js';
import { blockKind, flowchartMode } from './tool-rank.mjs';
import { showPage } from './views.js';
import { keyLabel } from './keybinds.js';
import { chordText, osChord } from './keys.mjs';
import { FLOW_TOOLS } from './tools-flow.js';
import { PLAN_TOOLS } from './tools-plan.js';
import { browseWordFile } from '../document/docx/files.js';
import { commandOf, ctxOf, run as runPool, toolEntries } from '../tooling/registry.js';
import { activeSurface } from '../tooling/surface.js';
import { TOOL_ALIASES } from './pool.js';
import './pool-cite.js';
import './pool-board.js';
import './pool-plan.js';

// Tool search registry (SPEC §7c): every toolbar and rail control as {id, label, icon, group, keywords, needs?, also?(ctx),
// run?(ctx), command?, args?(ctx), options?(ctx), shortcut?, toggle?, notice?, category?, risk?, headless?}. `run` and the active
// state are the toolbar's own definitions (textTools) and the Board's action methods; `command` instead runs that command
// (SPEC §8) with `args(ctx)` as source 'palette'; `options` renders the controls the toolbar / rail / ribbon use for it.
// An entry without `run` or `command` opens its options; `category` (flowchart | text | basic) orders flowchart mode's palette
// (tool-rank.mjs). `when(ctx)` is derived from `needs` (gates.mjs, plus the command's own) and `also`, the checks no gate
// expresses (the plan and flowchart entries keep their own `when`). `risk` (default write) and `headless` (default true) are
// what tool.run applies (commands/tool.mjs). ctx: see toolContext().

/** What the entries look at: the editor `ed` with its toolbar definitions `T` (a Document's own, document/tools.js), the main column's `view` (§7g), the
 * `board` the search serves (null: the document) with its `snap`shot, the font presets, `flow`: flowchart mode (§7c),
 * `block`: the node-selected block (selectedBlock), and `suggestions`: the open draft's waiting agent edits (their count). */
export function toolContext(board) {
  const { editor: ed, settings, view, suggestions } = getState();
  const snap = board && !board.destroyed ? board.getSnapshot() : null;
  return { ed, view, T: inDocument() ? documentTools(ed) : textTools(), board, snap, presets: settings?.presets ?? [], flow: flowchartMode(view, snap?.kind === 'canvas' ? board.attrs : null),
    block: onCanvas() ? engineBlock() : selectedBlock(ed, view), suggestions: suggestions.count };
}

/** On a canvas draft the gates read the engine's selection (document.context through the registry's ctx), not the DOM editor
 * under the canvas: the selected object as the `node` subject (a picture is an 'image', as the DOM editor's node), no bar. */
function engineBlock() {
  const o = ctxOf().obj;
  return o ? { type: o.kind === 'picture' ? 'image' : o.kind, attrs: {}, kind: null, view: null } : null;
}

/** The editor's node-selected block as the gates' `node` subject {type, attrs, kind, view}, null with a caret or text
 * selection. `kind` (tool-rank.mjs blockKind) and `view` (its NodeView) are set only where its bar would serve it: the
 * editor view, no canvas edited in place. */
function selectedBlock(ed, view) {
  const sel = ed?.state.selection;
  if (!(sel instanceof NodeSelection)) return null;
  const node = { type: sel.node.type.name, attrs: sel.node.attrs, kind: null, view: null };
  const dom = ed.view.nodeDOM(sel.from);
  const v = dom?.scView ?? dom?.pcView;
  const served = view?.type === 'editor' && !canvasEditor.get() && !!v;
  return served ? { ...node, kind: blockKind(node.type, node.attrs), view: v } : node;
}

/** The subject gate kind `kind` reads in the tool context `c` (gates.mjs; the commands read the same gates, commands.js). */
function subjectOf(kind, c) {
  switch (kind) {
    case 'ui': return { editor: c.ed, view: c.view };
    case 'board': return c.snap;
    case 'doc': return onCanvas() ? { inTable: !!ctxOf().in?.table } : c.ed && { inTable: c.ed.isActive('table') };
    case 'history': return c.snap ?? (c.ed && { canUndo: c.ed.can().undo(), canRedo: c.ed.can().redo() });
    case 'draft': {
      const d = getState().draft; // the loaded file: its waiting suggestions are the live count (gate draft.settled)
      return d && { ...d, threads: getState().settings?.threads, suggestions: getState().suggestions.count };
    }
    case 'settings': return getState().settings;
    case 'node': return c.block;
    case 'flow': { // the record a node-selected synced canvas shows
      const f = c.block?.view?.flow?.();
      return f ? flowSource.get(f.id) : null;
    }
    default: return null;
  }
}

/** An entry's gates: its `needs` and its command's, so the palette and the command cannot disagree. */
const needsOf = (t) => [...(t.needs ?? []), ...(t.command ? byId(t.command).needs : [])].map((n) => (typeof n === 'string' ? { gate: n } : n));

/** [{gate, message, fix}] of the entry `t`'s gates that do not hold in `c` (tool.run reports them). An integration that is off
 * is the only one reported, as the executor does (commands.js failedGates), so its other gates never name it. */
function failedNeeds(t, c) {
  const args = t.args?.(c) ?? {};
  const failed = needsOf(t).filter((n) => (!n.if || n.if(args)) && !can(n.gate, subjectOf(GATES[n.gate].subject, c), args, n.with))
    .map(({ gate, fix }) => ({ gate, message: GATES[gate].message, fix: fix ?? GATES[gate].fix }));
  const off = failed.filter((f) => f.gate.startsWith('integration.'));
  return off.length ? off : failed;
}

const withWhen = (t) => (t.when ? t : { ...t, when: (c) => !failedNeeds(t, c).length && (t.also?.(c) ?? true) });

// Text entries need the editor view (a workspace has no document to format) and a search that serves the document; the
// formatting ones (FORMAT) also a caret or text selection, not a node-selected block.
const TEXT = ['doc.open', 'view.editor'];
const FORMAT = [...TEXT, 'node.none'];
// The forum post's own controls (its presets and block styles): forum posts only (gate format.post, docs/plans/document.md Agent
// commands and gates). A Document brings its own entries; the rest of the forum toolset is pool commands (below).
const POST = [...FORMAT, 'format.post'];
const noBoard = (c) => !c.board;
const inText = (c) => noBoard(c) && !failedNeeds({ needs: TEXT }, c).length;
const itemIs = (...types) => [{ gate: 'board.itemIs', with: types }]; // the one selected item
const blockIs = (...kinds) => [{ gate: 'node.is', with: kinds }]; // the node-selected block (selectedBlock)
const CANVASES = ['flowchart', 'canvas', 'image'];

const T0 = textTools(); // icons and titles of the toolbar controls
const COLOURS = [...Object.values(TEXT_COLORS).map((l) => l.toLowerCase()), 'purple', 'pink', 'grey', 'gray', 'white'];
const ALIGN = ['align', 'alignment', 'allign', 'text align'];
const TOGGLE = { toggle: true };

// A toolbar control (textTools key): its command, icon, shortcut and active state.
const text = (key, label, group, keywords, more) => ({
  id: key, label, group, keywords, needs: group === 'Insert' ? TEXT : FORMAT, also: noBoard, icon: T0[key].children ?? T0[key].icon, key: T0[key].keyId,
  run: T0[key].onClick && ((c) => c.T[key].onClick()), active: (c) => c.T[key].active, ...more,
});

// Paragraph and headings: the block style select's command; options: that select.
const block = (value, label, icon, keywords) => ({
  id: value, label, group: 'Text', icon: h(icon), keywords: [...keywords, 'block style', 'style'], needs: POST, also: noBoard,
  run: (c) => c.T.block.set(value), options: (c) => h(BlockSelect, { T: c.T }),
});

const alignOptions = (c) => ['alignLeft', 'alignCenter', 'alignRight', 'justify'].map((k) => h(ToolButton, { key: k, ...c.T[k] }));

const CORE = [
  // Board tools, item actions and the canvas size bar are pool commands with meta (pool-board.js): generated entries.

  // Selected board items (§6c ribbon: a single item; rail: the whole selection).
  { id: 'item', label: 'Item properties', group: 'Item', icon: h(SlidersHorizontal), needs: itemIs('text', 'stroke', 'shape'),
    options: (c) => h(ItemControls, { board: c.board, item: c.snap.item }),
    keywords: ['properties', 'ribbon', 'style', 'format', 'options', 'settings', 'edit item', 'size', 'text size', 'font size',
      'colour', 'color', 'text colour', 'text color', 'bold', 'align', 'note', 'note colour', 'sticky note', 'width', 'line width',
      'line style', 'fill', 'fill colour'] },

  // A node-selected canvas (§6b canvas bar, CanvasBar.jsx): the bar's actions, on the same NodeView methods; listed first under
  // the block's heading (tool-rank.mjs BLOCK_SECTIONS). Unlink and Save to library are tools-flow.js's entries.
  { id: 'canvas-edit', label: 'Edit', group: 'Item', icon: h(SquarePen), shortcut: 'Enter', needs: blockIs(...CANVASES), notice: 'Canvas Mode',
    run: (c) => c.block.view.open(), keywords: ['edit canvas', 'edit flowchart', 'edit image', 'open', 'enter', 'canvas mode', 'change', 'modify'] },
  { id: 'canvas-library', label: 'Open in library', group: 'Item', icon: h(Workflow), needs: [...blockIs('flowchart'), 'flow.synced', 'flow.present'],
    run: (c) => openFlows(c.block.view.flow().id), keywords: ['library', 'flowchart library', 'open flowchart', 'go to flowchart', 'source', 'original'] },
  { id: 'canvas-actual-size', label: 'Actual size', group: 'Item', icon: h(Scaling), needs: blockIs(...CANVASES),
    run: (c) => c.block.view.setDw(c.block.view.artSize.w), // setDw keeps it within the page width, as the bar's
    keywords: ['artboard size', 'natural size', 'original size', '100%', 'reset size', 'resize', 'smaller'] },
  { id: 'canvas-full-width', label: 'Full width', group: 'Item', icon: h(MoveHorizontal), needs: blockIs(...CANVASES),
    run: (c) => c.block.view.setDw(c.block.view.maxWidth()), keywords: ['page width', 'wide', 'wider', 'stretch', 'fit width', 'resize', 'bigger'] },
  { id: 'canvas-delete', label: 'Delete', group: 'Item', icon: h(Trash2), shortcut: 'Del', notice: 'Deleted', needs: blockIs(...CANVASES), risk: 'destructive',
    run: (c) => c.block.view.remove(), keywords: ['remove', 'delete canvas', 'delete flowchart', 'delete image', 'trash', 'bin', 'del', 'backspace'] },

  // Text mode: the toolbar (and the rail's text mode).
  block('p', 'Paragraph', Pilcrow, ['normal', 'normal text', 'body', 'body text', 'text', 'p', 'plain', 'no heading', 'paragrah']),
  block('h1', 'Heading 1', Heading1, ['h1', 'title', 'heading', 'header', 'header 1', 'heading one', 'big heading', 'main heading']),
  block('h2', 'Heading 2', Heading2, ['h2', 'title', 'subheading', 'sub heading', 'subtitle', 'section', 'header 2', 'heading two']),
  block('h3', 'Heading 3', Heading3, ['h3', 'subheading', 'sub heading', 'subsection', 'header 3', 'heading three']),
  block('h4', 'Heading 4', Heading4, ['h4', 'small heading', 'header 4', 'heading four']),
  block('h5', 'Heading 5', Heading5, ['h5', 'small heading', 'header 5', 'heading five']),
  block('h6', 'Heading 6', Heading6, ['h6', 'smallest heading', 'header 6', 'heading six']),
  text('bold', 'Bold', 'Text', ['strong', 'thick', 'heavy', 'fat', 'emphasis', 'emphasise', 'emphasize', 'b', 'bolt', 'blod'], TOGGLE),
  text('italic', 'Italic', 'Text', ['italics', 'slanted', 'slant', 'oblique', 'emphasis', 'cursive', 'i', 'itallic', 'italik'], TOGGLE),
  text('underline', 'Underline', 'Text', ['underlined', 'underscore', 'line under', 'u', 'undeline', 'underlne'], TOGGLE),
  text('strike', 'Strikethrough', 'Text', ['strike', 'strikeout', 'strike out', 'cross out', 'crossed out', 'line through', 'scratch', 'stroke'], TOGGLE),
  text('sub', 'Subscript', 'Text', ['sub', 'lower', 'below', 'subscipt', 'chemical', 'index'], TOGGLE),
  text('sup', 'Superscript', 'Text', ['sup', 'power', 'exponent', 'raised', 'above', 'squared', 'ordinal', 'superscipt'], TOGGLE),
  text('alignLeft', 'Align left', 'Text', ['left', 'flush left', 'ragged right', 'left align', ...ALIGN], { options: alignOptions }),
  text('alignCenter', 'Align centre', 'Text', ['center', 'centre', 'centered', 'centred', 'middle', 'align center', ...ALIGN], { options: alignOptions }),
  text('alignRight', 'Align right', 'Text', ['right', 'flush right', 'right align', ...ALIGN], { options: alignOptions }),
  text('justify', 'Justify', 'Text', ['justified', 'justify text', 'full width', 'both sides', 'block', ...ALIGN], { options: alignOptions }),
  text('bulletList', 'Bullet list', 'Text', ['unordered', 'unordered list', 'dots', 'points', 'bullets', 'bulleted', 'bullet points', 'ul', 'list', 'buller'], TOGGLE),
  text('orderedList', 'Numbered list', 'Text', ['ordered', 'ordered list', 'numbers', 'numbered', 'numbering', 'ol', 'list', 'steps', 'enumerate', '1 2 3'], TOGGLE),
  text('link', 'Link', 'Text', ['url', 'hyperlink', 'href', 'web', 'website', 'address', 'anchor', 'lnk', 'linc'], { headless: false }),
  text('canvas', 'Insert canvas', 'Insert', ['canvas', 'frame', 'artboard', 'smart canvas', 'graphic', 'design', 'layout', 'canvass',
    'whiteboard', 'board', 'drawing', 'draw', 'sketch', 'diagram', 'doodle', 'paint', 'wb', 'white board']),
  text('addRow', 'Add row after', 'Insert', ['row', 'new row', 'insert row', 'table row'], { needs: [...TEXT, 'doc.inTable'] }),
  text('addColumn', 'Add column after', 'Insert', ['column', 'new column', 'insert column', 'table column', 'col'], { needs: [...TEXT, 'doc.inTable'] }),
  text('deleteRow', 'Delete row', 'Insert', ['remove row', 'row'], { icon: h(TableRowsSplit), needs: [...TEXT, 'doc.inTable'] }),
  text('deleteColumn', 'Delete column', 'Insert', ['remove column', 'column', 'col'], { icon: h(TableColumnsSplit), needs: [...TEXT, 'doc.inTable'] }),
  text('deleteTable', 'Delete table', 'Insert', ['remove table', 'table'], { needs: [...TEXT, 'doc.inTable'], risk: 'destructive' }),
  // Both modes: history; text mode: formatting and presets.
  { id: 'undo', label: 'Undo', group: 'Edit', icon: h(Undo2), key: 'edit.undo', keywords: ['back', 'revert', 'go back', 'step back', 'reverse', 'oops', 'undo last'],
    needs: ['history.canUndo'], also: (c) => !!c.snap || inText(c), run: (c) => (c.board ? c.board.undo() : c.T.undo.onClick()) },
  { id: 'redo', label: 'Redo', group: 'Edit', icon: h(Redo2), key: 'edit.redo', keywords: ['again', 'repeat', 'forward', 'reapply', 'redo last'],
    needs: ['history.canRedo'], also: (c) => !!c.snap || inText(c), run: (c) => (c.board ? c.board.redo() : c.T.redo.onClick()) },
  { id: 'find', label: 'Find in draft', group: 'Edit', icon: h(Search), key: 'app.find', needs: TEXT, also: noBoard, run: openFind, headless: false,
    keywords: ['find', 'search', 'search text', 'look for', 'locate', 'find text', 'ctrl f', 'where is', 'occurrences', 'serch', 'fnd'] },
  { id: 'replace', label: 'Find and replace', group: 'Edit', icon: h(Replace), key: 'app.replace', needs: TEXT, also: noBoard, run: openReplace, headless: false,
    keywords: ['replace', 'replace all', 'find and replace', 'substitute', 'swap', 'change all', 'rename', 'ctrl h', 'replce', 'repalce'] },
  text('clear', 'Clear formatting', 'Edit', ['remove formatting', 'clear format', 'plain text', 'unformat', 'reset format', 'strip', 'clean', 'normal']),
  { id: 'presets', label: 'Manage presets', group: 'Edit', icon: h(Palette), needs: POST, also: noBoard, run: openSettings, headless: false,
    keywords: ['presets', 'font presets', 'edit presets', 'settings', 'preferences', 'options'] },
];

// App (§7c): drafts and the app. New draft and the pickers' choices run commands (source 'palette', audited, SPEC §8).
const runCommand = (id, args) => invoke({ id, args, source: 'palette' }).then((r) => r.ok || notify({ text: r.error.message }));
const saved = () => !!getState().draft?.id; // a draft not saved yet has no id to tag or file
const openId = () => getState().draft?.id;
/** The open draft's folder (null: the top level), where Paste draft puts the draft. */
function openFolder() {
  const { settings } = getState();
  const f = settings.draftFolders?.[openId()];
  return settings.folders?.some((x) => x.id === f) ? f : null;
}

function ThreadPick() {
  const threads = useStore((s) => s.settings.threads);
  const value = useStore(() => shownThread() ?? NONE);
  return h(ToolSelect, { title: 'Project', className: 'w-64', value, onChange: (v) => runCommand(PALETTE.selectThread, { url: v === NONE ? null : v }) },
    ...threads.map((t) => h(SelectItem, { key: t.url, value: t.url }, h('span', { className: 'truncate' }, threadLabel(t)))));
}

function TagPick() {
  const tags = useStore((s) => tagList(s.settings));
  const value = useStore((s) => draftTag(s.settings, s.draft?.id)?.id ?? NONE);
  return h(ToolSelect, { title: 'Tag', className: 'w-44', value, onChange: (v) => runCommand(PALETTE.setTag, { draftId: getState().draft.id, tagId: v === NONE ? null : v }) },
    h(SelectItem, { value: NONE }, 'No tag'),
    ...tags.map((t) => h(SelectItem, { key: t.id, value: t.id }, t.name)));
}

/** The open draft's title in a box, renamed through drafts.rename when the options panel closes (Enter, or a click away);
 * Escape, an empty box or the same title renames nothing (docs/wiki/sidebar-menu.md decision 1). The panel takes Enter and
 * Escape before the box sees them (ToolSearch.jsx OptionsPanel), so the box commits on unmount and a window capture listener,
 * which runs before the panel's, notes Escape. */
function RenameBox() {
  const draft = useRef(getState().draft).current; // the draft the panel opened for
  const value = useRef(draft.title);
  useEffect(() => {
    let cancelled = false;
    const onKey = (e) => { if (e.key === 'Escape') cancelled = true; };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const title = value.current;
      if (!cancelled && title.trim() && cleanTitle(title) !== draft.title) runCommand(PALETTE.rename, { draftId: draft.id, title });
    };
  }, []);
  return h(Input, { autoFocus: true, size: 'xs', className: 'w-64 px-1', 'aria-label': 'Draft title', maxLength: TITLE_LIMIT, defaultValue: draft.title,
    onFocus: (e) => e.target.select(), onChange: (e) => { value.current = e.target.value; } });
}

function FolderPick() {
  const folders = useStore((s) => s.settings.folders) ?? [];
  const value = useStore((s) => s.settings.draftFolders?.[s.draft?.id] ?? NONE);
  return h(ToolSelect, { title: 'Folder', className: 'w-44', value: folders.some((f) => f.id === value) ? value : NONE,
    onChange: (v) => runCommand(PALETTE.move, { draftId: getState().draft.id, folderId: v === NONE ? null : v }) },
  h(SelectItem, { value: NONE }, 'No folder'),
  ...folders.map((f) => h(SelectItem, { key: f.id, value: f.id }, f.name)));
}

const APP = [
  // New draft opens the dialog (a person picks); New document skips it, as Word's Ctrl+N does. The forum adds New forum post.
  { id: 'new-draft', label: 'New draft', group: 'App', icon: h(FilePlus), key: 'app.newDraft', run: startNewDraft, headless: false,
    keywords: ['new', 'create', 'add draft', 'start', 'new file', 'draft', 'folder'] },
  { id: 'new-document', label: 'New document', group: 'App', icon: h(FileText), command: PALETTE.newDraft, args: () => ({ format: 'document' }),
    keywords: ['new document', 'word', 'docx', 'blank document', 'blank', 'report', 'essay', 'letter'] },
  { id: 'new-whiteboard', label: 'New whiteboard', group: 'App', icon: h(Shapes), command: PALETTE.newDraft, args: () => ({ format: 'board' }),
    needs: ['board.on'],
    keywords: ['new whiteboard', 'whiteboard', 'board', 'canvas', 'infinite', 'figma', 'blank board'] },
  { id: 'open-word-file', label: 'Open Word file', group: 'App', icon: h(FileText), run: () => browseWordFile(), headless: false,
    keywords: ['open', 'open file', 'import', 'word', 'docx', 'doc', 'microsoft word', 'open document', 'browse'] },
  { id: 'save', label: 'Save', group: 'App', icon: h(Save), key: 'app.save', needs: ['doc.open'], notice: 'Saved',
    run: () => {
      commitBoardEdit();
      saveNow();
    },
    keywords: ['save', 'save now', 'save draft', 'store', 'keep', 'write'] },
  { id: 'settings', label: 'Settings', group: 'App', icon: h(Settings), run: openSettings, headless: false,
    keywords: ['settings', 'preferences', 'options', 'config', 'configure', 'theme', 'dark mode', 'light mode', 'page width', 'tags'] },
  // Settings > General, where the palette's Canvas swatch sets the canvas colour apart from the page.
  { id: 'canvas-colour', label: 'Canvas colour', group: 'App', icon: h(PaintBucket), run: () => openSettings('general'), headless: false,
    keywords: ['canvas colour', 'canvas color', 'canvas background', 'background colour', 'background color', 'palette', 'theme'] },
  // Settings > Integrations, where an integration is turned on: no integration's own words, so an off one is never named here.
  { id: 'integrations', label: 'Integrations', group: 'App', icon: h(Puzzle), run: () => openSettings('integrations'), headless: false,
    keywords: ['integrations', 'plugins', 'extensions', 'add-ons', 'connect'] },
  // Settings > General Run setup again: the first start's setup from its first page (src/app/setup).
  { id: 'setup', label: 'Run setup again', group: 'App', icon: h(WandSparkles), run: runSetup, headless: false,
    keywords: ['setup', 'onboarding', 'first start', 'wizard'] },
  // Settings > General Start the tutorial (components/Tutorial.jsx).
  { id: 'tutorial', label: 'Start the tutorial', group: 'App', icon: h(GraduationCap), run: startTutorial, headless: false,
    keywords: ['tutorial', 'tour', 'lesson', 'learn', 'guide', 'how to', 'getting started'] },
  { id: 'assistant', label: 'Assistant', group: 'App', icon: h(MessageSquare), key: 'app.assistant', run: () => toggleChat(), headless: false,
    keywords: ['assistant', 'chat', 'ai', 'ask', 'help', 'bot', 'model', 'llm', 'local ai', 'agent', 'copilot', 'assistent', 'asistant'] },
  // The chat's Continue (a turn paused at its token limit, loop.js paused); nothing happens while no turn waits.
  { id: 'assistant-continue', label: 'Continue the assistant', group: 'App', icon: h(MessageSquare), headless: false,
    run: () => getState().assistant?.messages?.findLast((m) => m.resume)?.resume(),
    keywords: ['continue', 'resume', 'keep going', 'token limit', 'assistant', 'turn'] },
  { id: 'spell-check', label: 'Spell check', group: 'App', icon: h(SpellCheck), toggle: true, active: () => getState().settings?.spellCheck ?? true,
    run: toggleSpellCheck, keywords: ['spell check', 'spellcheck', 'spelling', 'spell', 'red underline', 'squiggles', 'typos', 'dictionary', 'proofing', 'spellchecker'] },
  // Settings > Assistant > Writing; headless false like that section's data-agent-deny: agents never change the assistant's settings.
  { id: 'writing-guide', label: 'Human writing guide', group: 'App', icon: h(PenLine), toggle: true, headless: false,
    active: () => assistantSettings().humanWriting, run: () => saveAssistant({ humanWriting: !assistantSettings().humanWriting }),
    keywords: ['writing guide', 'human writing', 'writing style', 'style guide', 'prose', 'tone', 'em dash', 'ai writing', 'sound human', 'HUMAN-WRITING'] },
  { id: 'select-thread', label: 'Select project...', group: 'App', icon: h(MessagesSquare), options: () => h(ThreadPick),
    keywords: ['project', 'select project', 'filter', 'switch project', 'all drafts'] },
  { id: 'rename-draft', label: 'Rename draft...', group: 'App', icon: h(Pencil), also: saved, via: 'drafts.rename', options: () => h(RenameBox),
    keywords: ['rename', 'title', 'name', 'retitle', 'change title'] },
  { id: 'tag-draft', label: 'Tag draft...', group: 'App', icon: h(Tag), also: saved, options: () => h(TagPick),
    keywords: ['tag', 'status', 'label', 'to do', 'todo', 'in progress', 'done', 'mark as', 'workflow'] },
  // The browser (§7j): a new tab in the pane over this page (on the browser page, a new tab there), the browser page, the pane.
  { id: 'browser-new', label: 'New browser window', group: 'App', icon: h(AppWindow), headless: false,
    run: (c) => (can('view.browser', c) ? newTab() : openPane(null, HOME)),
    keywords: ['browser', 'new window', 'new tab', 'web', 'internet', 'google', 'search the web', 'website', 'url', 'chrome', 'look up', 'open page'] },
  { id: 'browser-page', label: 'Browser page', group: 'App', icon: h(Globe), key: 'app.browser', headless: false,
    also: (c) => !can('view.browser', c), run: () => showPage('browser'),
    keywords: ['browser', 'tabs', 'web', 'internet', 'full page', 'go to browser', 'show browser', 'website'] },
  { id: 'browser-close-pane', label: 'Close browser panes', group: 'App', icon: h(X), headless: false,
    also: (c) => !can('view.browser', c) && openPanes().length > 0,
    run: closePanes, keywords: ['close browser', 'hide browser', 'browser pane', 'close pane', 'hide pane', 'minimise', 'minimize'] },
  // The sidebar menu's draft actions for the open draft (docs/wiki/sidebar-menu.md decision 7). The draft clipboard is UI state:
  // Cut, Copy and Paste are headless false, and agents use drafts.duplicate and drafts.move.
  { id: 'duplicate-draft', label: 'Duplicate draft', group: 'App', icon: h(CopyPlus), also: saved, command: PALETTE.duplicate,
    args: () => ({ draftId: openId() }), notice: 'Duplicated', keywords: ['duplicate', 'copy draft', 'clone', 'make a copy', 'duplicate draft'] },
  { id: 'cut-draft', label: 'Cut draft', group: 'App', icon: h(Scissors), also: saved, run: () => cutDraft(openId()), notice: 'Cut', headless: false,
    keywords: ['cut', 'cut draft', 'move draft'] },
  { id: 'copy-draft', label: 'Copy draft', group: 'App', icon: h(Copy), also: saved, run: () => copyDraft(openId()), notice: 'Copied', headless: false,
    keywords: ['copy', 'copy draft'] },
  { id: 'paste-draft', label: 'Paste draft', group: 'App', icon: h(ClipboardPaste), also: () => saved() && canPaste(), run: () => pasteDraft(openFolder()),
    notice: 'Pasted', headless: false, keywords: ['paste', 'paste draft'] },
  { id: 'delete-draft', label: 'Delete draft', group: 'App', icon: h(Trash2), also: saved, run: () => deleteDraft(getState().draft), risk: 'destructive',
    headless: false, keywords: ['delete', 'delete draft', 'remove draft', 'trash', 'discard'] },
  { id: 'new-folder', label: 'New folder', group: 'App', icon: h(FolderPlus), command: PALETTE.newFolder, args: () => ({ name: 'New folder' }),
    keywords: ['new folder', 'add folder', 'create folder', 'folder', 'directory', 'organise', 'organize'] },
  { id: 'move-draft', label: 'Move to folder...', group: 'App', icon: h(FolderInput), also: () => saved() && !!getState().settings.folders?.length,
    options: () => h(FolderPick), keywords: ['folder', 'move', 'file', 'organise', 'organize', 'group', 'directory'] },
];

// Agent edits waiting as suggestions (docs/wiki/suggestions.md Tool search): shown while the open draft has some. Agents only
// move between them (headless): accepting and rejecting is the user's (suggestions.resolve asks the user when an agent does it).
// Each entry has its own verbs: shared ones tie in rankTool's exact-keyword tier, and ties keep registry order ("reject" would pick Next).
const WORDS = ['suggestion', 'suggestions', 'suggest', 'review', 'track changes', 'tracked changes', 'comment', 'ai edits', 'assistant edits',
  'agent edits', 'pending'];
const ACCEPT = [...WORDS, 'accept', 'approve', 'keep'];
const REJECT = [...WORDS, 'reject', 'decline', 'discard'];
const waiting = (c) => c.suggestions > 0 && noBoard(c);
const activeChange = (c) => waiting(c) && !!getState().suggestions.active;
const SUGGEST = [
  { id: 'suggestion-next', label: 'Next suggestion', group: 'Edit', icon: h(ChevronDown), key: 'suggest.next', needs: TEXT, also: waiting,
    run: nextSuggestion, keywords: [...WORDS, 'next change'] },
  { id: 'suggestion-previous', label: 'Previous suggestion', group: 'Edit', icon: h(ChevronUp), key: 'suggest.previous', needs: TEXT, also: waiting,
    run: previousSuggestion, keywords: [...WORDS, 'previous change'] },
  { id: 'suggestion-accept', label: 'Accept suggestion', group: 'Edit', icon: h(Check), key: 'suggest.accept', needs: TEXT, also: activeChange,
    run: acceptActive, headless: false, keywords: ACCEPT },
  { id: 'suggestion-reject', label: 'Reject suggestion', group: 'Edit', icon: h(X), key: 'suggest.reject', needs: TEXT, also: activeChange,
    run: rejectActive, headless: false, keywords: REJECT },
  { id: 'suggestion-group-accept', label: 'Accept suggestions from this request', group: 'Edit', icon: h(ListChecks), needs: TEXT, also: activeChange,
    run: () => acceptGroup(), headless: false, keywords: [...ACCEPT, 'request'] },
  { id: 'suggestion-group-reject', label: 'Reject suggestions from this request', group: 'Edit', icon: h(ListX), needs: TEXT, also: activeChange,
    run: () => rejectGroup(), headless: false, keywords: [...REJECT, 'request'] },
  { id: 'suggestions-accept-all', label: 'Accept all suggestions', group: 'Edit', icon: h(CheckCheck), needs: TEXT, also: waiting,
    run: acceptAll, headless: false, keywords: ACCEPT },
  { id: 'suggestions-reject-all', label: 'Reject all suggestions', group: 'Edit', icon: h(X), needs: TEXT, also: waiting,
    run: rejectAll, headless: false, keywords: REJECT },
  // Settings > Assistant > Permissions; headless false like that section's data-agent-deny: agents never change their own policy.
  { id: 'auto-approve-edits', label: 'Auto-approve assistant edits', group: 'App', icon: h(BadgeCheck), toggle: true, headless: false,
    active: () => assistantSettings().autoApproveEdits === true, run: () => saveAssistant({ autoApproveEdits: assistantSettings().autoApproveEdits !== true }),
    keywords: ['auto approve', 'assistant edits', 'ai edits', 'agent edits', 'suggestions', 'track changes'] },
  // Settings > Assistant > Permissions: the provider's own web search (assistant/search.js), where the provider has one.
  { id: 'provider-search', label: 'Let the provider search the web itself', group: 'App', icon: h(Globe), toggle: true, headless: false,
    also: () => Object.hasOwn(PROVIDER_SEARCH, assistantSettings().provider), active: () => providerSearch(assistantSettings()),
    run: () => saveAssistant({ providerSearch: assistantSettings().providerSearch !== true }),
    keywords: ['web search', 'search the web', 'internet', 'provider search', 'claude code', 'codex', 'qwen', 'websearch', 'webfetch', 'browse'] },
];

const TEXT_IDS = ['connector-label']; // flowchart mode's Text section (the shape kinds and board.text have their category)
// Hand entries a pool command replaces (pool.js TOOL_ALIASES, docs/plans/cleanup/tool-pool-surfaces.md B1 to B4): each gives way
// wherever that command serves the surface, so a tool has one entry; elsewhere (a Document, where cover() runs Word's command) it
// stays.
const pooled = (t) => (TOOL_ALIASES[t.id] ? { ...t, when: (c) => !commandOf(TOOL_ALIASES[t.id]) && t.when(c) } : t);
// On a canvas draft (docs/plans/engine/viewport-design.md section 4.7) an entry a Word command covers shows, reads and explains
// that command, which the engine answers: hidden where the format does not grant it, its active state and its reason the
// command's, so it never falls back to the DOM editor under the canvas. An entry whose notice is the text it shows after running
// has no row for a reason, so it hides while its command cannot run there.
const coveredBy = new Map(COVERED.map(([id, fid]) => [id, fid]));
function onCanvas() {
  return !!activeSurface()?.session;
}
function canvasCovered(t) {
  const fid = coveredBy.get(t.id);
  if (!fid) return t;
  // A command off with no reason hides its entry, as the DOM editor's gates do (a page break in a table).
  const shows = (c) => {
    const spec = commandOf(fid);
    if (!spec || !t.when(c)) return false;
    const reason = reasonOf(fid);
    return typeof t.notice === 'string' ? !reason && spec.enabled?.(ctxOf()) !== false : !!reason || spec.enabled?.(ctxOf()) !== false;
  };
  return {
    ...t,
    when: (c) => (onCanvas() ? shows(c) : t.when(c)),
    ...(t.active && { active: (c) => (onCanvas() ? !!commandOf(fid)?.active?.(ctxOf()) : t.active(c)) }),
    ...(typeof t.notice !== 'string' && { notice: (c) => (onCanvas() ? reasonOf(fid) : t.notice?.(c) ?? null) }),
  };
}
// WORD_TOOLS: the Word commands of a Document (docs/plans/word/plan.md §1.14). cover() makes the existing entries a Word command
// duplicates run that command in a Document.
const TOOLS = [...CORE, ...SUGGEST, ...DOC_TOOLS, ...WORD_TOOLS, ...APP, ...PLAN_TOOLS, ...FLOW_TOOLS, ...all('TOOLS')].map(cover).map(withWhen).map(canvasCovered).map(pooled).map((t) => (TEXT_IDS.includes(t.id) ? { ...t, category: 'text' } : t));

// Generated entries (docs/plans/cleanup/tool-pool-surfaces.md F2): one per registered command with meta (registry toolEntries),
// shown while the focused surface's profile grants it, run through the registry. Agents see and run them as they did the hand
// entries they replaced (tool.run passes its arg to run(id, arg)); a command's meta `agent`, `headless` and `risk` set the rest.
// A value command's entry opens its options: the forum toolbar's own control for the text values (POOL_OPTIONS), else the
// command's options view when its meta says `optionsFirst` (a command that needs the value they pick), as a Word menu entry does.
const POOL_OPTIONS = {
  'text.font': (c) => h(FontBox, { T: c.T }),
  'text.size': (c) => h(SizeBox, { T: c.T }),
  'text.color': (c) => h(PalettePanel, { palette: c.T.color.options, value: c.T.color.value, onChange: c.T.color.set, none: null }),
  'text.highlight': (c) => h(PalettePanel, { palette: c.T.highlight.options, value: c.T.highlight.value, onChange: c.T.highlight.set, none: 'None' }),
};
const poolTools = () => toolEntries().map((t) => ({ ...t, icon: t.icon && h(t.icon),
  ...(POOL_OPTIONS[t.id] ? { options: POOL_OPTIONS[t.id], optionsFirst: true } : t.options && commandOf(t.id)?.meta?.optionsFirst && { optionsFirst: true }) }));

/** Every entry in registry order, then the generated ones, with one entry per font preset. */
const allTools = (c) => [...TOOLS, ...poolTools(), ...c.presets.map((p, i) => withWhen({
  id: `preset-${i}`, label: p.name || `Preset ${i + 1}`, group: 'Text', icon: h(Palette), key: i < 9 ? `text.preset${i + 1}` : undefined,
  keywords: ['preset', 'font preset', 'apply preset', 'style'], needs: POST, also: noBoard, run: () => runPool('text.preset', i),
}))];

/** The chord an entry shows: its binding's (§7k keybinds), else its fixed widget key. */
export const entryKey = (t) => (t.key ? keyLabel(t.key) : t.shortcut && chordText(osChord(t.shortcut))); // a fixed Ctrl+V is ⌘V on a Mac

/** The entries that apply to `c` (toolContext()), in registry order. */
export const listTools = (c) => allTools(c).filter((t) => t.when(c));

bindTools({ context: toolContext, all: allTools, failedNeeds, command: byId, shortcut: entryKey, aliases: TOOL_ALIASES }); // tool.list / tool.run (commands/tool.mjs)

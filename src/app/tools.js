import { createElement as h, useEffect, useRef } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  ALargeSmall, AppWindow, BadgeCheck, BringToFront, Check, CheckCheck, ChevronDown, ChevronUp, ListChecks, ListX, CaseSensitive, ClipboardPaste, Copy, CopyPlus, Crop, Eraser, Eye, EyeOff, FilePlus, FileText, FolderInput, FolderPlus, Group, Heading1,
  Heading2, Heading3, Globe, GraduationCap, Heading4, Heading5, Heading6, ImagePlus, Layers, Lock, LockOpen, Magnet, MessagesSquare, MousePointer2, MoveHorizontal, PaintBucket, Palette, Pen, Pencil, Pilcrow, Pin, Puzzle, Redo2, Save,
  Replace, Scaling, Scissors, Search, MessageSquare, SendToBack, Settings, Shapes, SlidersHorizontal, SpellCheck, SquarePen, TableColumnsSplit, TableRowsSplit, Tag, Trash2,
  Type, Undo2, Ungroup, WandSparkles, Workflow, X, PenLine, BookMarked, Hash, ScrollText, TextQuote,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SelectItem } from '@/components/ui/select';
import { canvasEditor, flowSource } from '../canvas.js';
import { cleanTitle, TITLE_LIMIT } from '../doc-utils.mjs';
import { DOC_TOOLS, documentTools, inDocument } from '../document/tools.js';
import { FONTS, TEXT_COLORS } from '../extensions.js';
import { KINDS } from '../flow/shapes.mjs';
import { all } from '../integrations/ui.js';
import {
  acceptActive, acceptAll, acceptGroup, applyPresetAt, canPaste, commitBoardEdit, copyDraft, cutDraft, deleteDraft, nextSuggestion, openSettings,
  pasteDraft, previousSuggestion, rejectActive, rejectAll, rejectGroup, runSetup, saveNow, startNewDraft, threadLabel,
} from './actions.js';
import { assistantSettings, saveAssistant, toggleChat } from './assistant/assistant.js';
import { closePanes, HOME, newTab, openPane, openPanes } from './browser.js';
import { invoke } from './commands.js';
import { byId } from './commands/catalogue.mjs';
import { PALETTE } from './commands/palette.mjs';
import { bindTools } from './commands/tool.mjs';
import { BgSelect, SnapControls } from './components/board/BoardRail.jsx';
import { toggleLayers } from './components/board/LayersPanel.jsx';
import { ShapeControls, ShapeIcon, StrokeControls } from './components/board/controls.jsx';
import { ItemControls } from './components/board/ItemRibbon.jsx';
import { notify } from './components/Notices.jsx';
import { openFind, openReplace } from './components/FindBar.jsx';
import { ReferenceStyle } from './components/References.jsx';
import { toggleSpellCheck } from './components/StatusBar.jsx';
import { BlockSelect, FontSelect, NONE, SizeSelect, Swatches, textTools, ToolButton, ToolSelect } from './components/Toolbar.jsx';
import { startTutorial } from './components/Tutorial.jsx';
import { draftTag, tagList } from './drafts-meta.js';
import { openFlows } from './flows.js';
import { can, GATES } from './gates.mjs';
import { insertReferenceList, openCitePicker, openReferences, sourcesOf } from './references.js';
import { getState, useStore } from './store.js';
import { blockKind, flowchartMode } from './tool-rank.mjs';
import { showPage } from './views.js';
import { keyLabel } from './keybinds.js';
import { SHAPE_KEYS } from './keys.mjs';
import { FLOW_TOOLS } from './tools-flow.js';
import { PLAN_TOOLS } from './tools-plan.js';

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
  return { ed, view, T: inDocument() ? documentTools(ed) : textTools(ed), board, snap, presets: settings?.presets ?? [], flow: flowchartMode(view, snap?.kind === 'canvas' ? board.attrs : null),
    block: selectedBlock(ed, view), suggestions: suggestions.count };
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
    case 'doc': return c.ed && { inTable: c.ed.isActive('table') };
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
// The forum post's own controls (its value lists, presets, block select and forum-only nodes): forum posts only (gate
// format.post, docs/plans/document.md Agent commands and gates). A Document brings its own entries.
const POST = [...FORMAT, 'format.post'];
const POST_INSERT = [...TEXT, 'format.post'];
const noBoard = (c) => !c.board;
const inText = (c) => noBoard(c) && !failedNeeds({ needs: TEXT }, c).length;
const BOARD = ['board.active'];
const SELECTION = ['board.selection']; // Duplicate, Front / Back, Delete act on every selected item
const itemIs = (...types) => [{ gate: 'board.itemIs', with: types }]; // the one selected item
const blockIs = (...kinds) => [{ gate: 'node.is', with: kinds }]; // the node-selected block (selectedBlock)
const CANVASES = ['flowchart', 'canvas', 'image'];

const T0 = textTools(null); // icons and titles of the toolbar controls
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
const penOptions = (c) => h(StrokeControls, { board: c.board, value: c.snap.pen, set: (p) => c.board.setPen(p), live: true });
const shapeOptions = (c) => h(ShapeControls, { board: c.board, value: c.snap.shape, set: (p) => c.board.setShapeTool(p), live: true });
const tool = (mode) => (c) => c.board.setMode(mode);

const CORE = [
  // Board mode (§6c rail): tools, shape kinds, board actions.
  { id: 'select', label: 'Select', group: 'Board', icon: h(MousePointer2), key: 'board.select', needs: BOARD, run: tool(null),
    keywords: ['pointer', 'cursor', 'move', 'selection', 'mouse', 'pick', 'hand', 'arrow tool', 'exit tool', 'stop drawing'] },
  { id: 'pen', label: 'Pen', group: 'Board', icon: h(Pen), key: 'board.pen', needs: BOARD, run: tool('pen'), options: penOptions,
    keywords: ['draw', 'drawing', 'brush', 'pencil', 'freehand', 'free hand', 'sketch', 'ink', 'marker', 'highlighter', 'scribble',
      'doodle', 'paint', 'write', 'handwriting', 'stroke', 'line', 'pen colour', 'pen color', 'colour', 'color', ...COLOURS, 'black',
      'width', 'thickness', 'thick', 'thin', 'size', 'opacity'] },
  { id: 'eraser', label: 'Eraser', group: 'Board', icon: h(Eraser), key: 'board.eraser', needs: BOARD, run: tool('eraser'),
    keywords: ['erase', 'rubber', 'remove stroke', 'delete stroke', 'erasor', 'eraser tool', 'errase', 'rub out', 'wipe', 'clear ink', 'undraw'] },
  { id: 'shape', label: 'Shape', group: 'Board', icon: h(Shapes), key: 'board.shape', needs: BOARD, run: tool('shape'), options: shapeOptions,
    keywords: ['shapes', 'draw shape', 'geometry', 'figure', 'polygon', 'shap', 'fill', 'outline'] },
  { id: 'keep-tool', label: 'Keep tool', group: 'Board', icon: h(Pin), key: 'board.keepTool', needs: BOARD, toggle: true,
    active: (c) => c.snap.keepTool, run: (c) => c.board.setKeepTool(!c.snap.keepTool),
    keywords: ['keep tool on', 'lock tool', 'tool lock', 'sticky tool', 'stay', 'repeat', 'keep drawing', 'draw many', 'again'] },
  // One entry per registry kind (src/flow/shapes.mjs): its label, keywords, preview and key (SHAPE_KEYS).
  ...KINDS.map(({ kind: shape, label, group, keywords }) => ({
    id: `shape-${shape}`, label, group: 'Board', icon: h(ShapeIcon, { shape, className: 'size-4 text-muted-foreground' }), key: SHAPE_KEYS[shape], needs: BOARD, options: shapeOptions,
    keywords: [...keywords, 'shape'], category: group === 'basic' ? 'basic' : 'flowchart',
    run: (c) => {
      c.board.setShapeTool({ shape });
      c.board.setMode('shape');
    },
  })),
  { id: 'snapping', label: 'Snapping', group: 'Board', icon: h(Magnet), key: 'board.snap', needs: BOARD,
    options: (c) => h(SnapControls, { board: c.board, snap: c.snap.snap }),
    keywords: ['snap', 'magnet', 'magnetic', 'grid', 'guides', 'smart guides', 'align', 'alignment', 'sanp', 'snaping'] },
  { id: 'background', label: 'Background', group: 'Board', icon: h(PaintBucket), needs: BOARD,
    options: (c) => h(BgSelect, { board: c.board, bg: c.snap.bg }),
    keywords: ['bg', 'board colour', 'board color', 'background colour', 'background color', 'backdrop', 'transparent',
      'white', 'black', 'page', 'backround', 'backgroud'] },
  { id: 'layers', label: 'Layers', group: 'Board', icon: h(Layers), needs: BOARD, toggle: true, active: () => getState().settings?.layersPanel ?? true, run: toggleLayers,
    keywords: ['layers panel', 'layer list', 'layer', 'outline', 'tree', 'objects', 'item list', 'z order', 'order', 'reorder', 'stack',
      'hide', 'lock', 'show', 'unlock', 'groups', 'layres', 'layrs'] },
  { id: 'add-text', label: 'Add text', group: 'Insert', icon: h(Type), key: 'board.text', needs: BOARD, run: tool('text'), notice: 'Click to place text',
    keywords: ['text', 'type', 'write', 'label', 'caption', 'text box', 'textbox', 'words', 'sticky note', 'note', 'title'] },
  { id: 'add-image', label: 'Add image', group: 'Insert', icon: h(ImagePlus), key: 'board.image', needs: BOARD, run: (c) => c.board.pickImages(), headless: false,
    keywords: ['image', 'picture', 'photo', 'img', 'pic', 'upload', 'file', 'png', 'jpg', 'screenshot', 'insert image', 'imgae'] },

  // Selected board items (§6c ribbon: a single item; rail: the whole selection).
  { id: 'item', label: 'Item properties', group: 'Item', icon: h(SlidersHorizontal), needs: itemIs('text', 'stroke', 'shape'),
    options: (c) => h(ItemControls, { board: c.board, item: c.snap.item }),
    keywords: ['properties', 'ribbon', 'style', 'format', 'options', 'settings', 'edit item', 'size', 'text size', 'font size',
      'colour', 'color', 'text colour', 'text color', 'bold', 'align', 'note', 'note colour', 'sticky note', 'width', 'line width',
      'line style', 'fill', 'fill colour'] },
  { id: 'duplicate', label: 'Duplicate', group: 'Item', icon: h(Copy), key: 'board.duplicate', notice: 'Duplicated', needs: SELECTION,
    run: (c) => c.board.duplicate(), keywords: ['copy', 'clone', 'duplicate item', 'dupe', 'double', 'repeat', 'duplicat', 'duplcate'] },
  { id: 'front', label: 'Bring to front', group: 'Item', icon: h(BringToFront), key: 'board.front', notice: 'Brought to front',
    needs: SELECTION, run: (c) => c.board.arrange('front'),
    keywords: ['front', 'top', 'raise', 'forward', 'bring forward', 'above', 'z order', 'layer', 'arrange', 'order'] },
  { id: 'back', label: 'Send to back', group: 'Item', icon: h(SendToBack), key: 'board.back', notice: 'Sent to back',
    needs: SELECTION, run: (c) => c.board.arrange('back'),
    keywords: ['back', 'bottom', 'lower', 'behind', 'backward', 'send backward', 'below', 'z order', 'layer', 'arrange', 'order'] },
  // Lock and hide (§6 Layer fields): the selection; Unlock all and Show all while the board has such items.
  { id: 'lock', label: 'Lock', group: 'Item', icon: h(Lock), key: 'board.lock', needs: SELECTION, run: (c) => c.board.setLayer('locked'),
    keywords: ['unlock', 'lock item', 'freeze', 'pin down', 'fix in place', 'protect', 'background', 'screenshot'] },
  { id: 'hide', label: 'Hide', group: 'Item', icon: h(EyeOff), key: 'board.hide', needs: SELECTION, run: (c) => c.board.setLayer('hidden'),
    keywords: ['show', 'hide item', 'invisible', 'visibility', 'conceal', 'unhide'] },
  // Group and ungroup (§6c Groups): two or more items; a selection that covers a whole group.
  { id: 'group', label: 'Group', group: 'Item', icon: h(Group), key: 'board.group', needs: ['board.selectionMany'], run: (c) => c.board.group(),
    keywords: ['group items', 'combine', 'join', 'bundle', 'gather', 'keep together', 'link'] },
  { id: 'ungroup', label: 'Ungroup', group: 'Item', icon: h(Ungroup), key: 'board.ungroup', needs: SELECTION,
    also: (c) => c.board.canUngroup(), run: (c) => c.board.group(false),
    keywords: ['ungroup items', 'split', 'separate', 'break apart', 'unbundle'] },
  { id: 'unlock-all', label: 'Unlock all', group: 'Board', icon: h(LockOpen), needs: BOARD, also: (c) => c.board.items.some((i) => i.locked),
    run: (c) => c.board.setLayer('locked', true), keywords: ['unlock', 'locked', 'unfreeze', 'all items'] },
  { id: 'show-all', label: 'Show all', group: 'Board', icon: h(Eye), needs: BOARD, also: (c) => c.board.items.some((i) => i.hidden),
    run: (c) => c.board.setLayer('hidden', true), keywords: ['show', 'unhide', 'hidden', 'visible', 'reveal', 'all items'] },
  { id: 'delete', label: 'Delete', group: 'Item', icon: h(Trash2), key: 'board.delete', notice: 'Deleted', needs: SELECTION, risk: 'destructive',
    run: (c) => c.board.removeItem(), keywords: ['remove', 'delete item', 'remove item', 'trash', 'bin', 'erase item', 'clear', 'del', 'backspace', 'destroy', 'delet'] },
  { id: 'reset-size', label: 'Reset size', group: 'Item', icon: h(Scaling), needs: itemIs('image'), run: (c) => c.board.resetSize(),
    keywords: ['natural size', 'original size', 'actual size', '100%', 'restore size', 'full size', 'resize', 'reset'] },
  { id: 'reset-crop', label: 'Reset crop', group: 'Item', icon: h(Crop), needs: itemIs('image'), also: (c) => c.snap.item.cropped,
    run: (c) => c.board.resetCrop(), keywords: ['uncrop', 'remove crop', 'undo crop', 'full image', 'whole image', 'restore image', 'crop'] },

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
  { id: 'font', label: 'Font', group: 'Text', icon: h(CaseSensitive), needs: POST, also: noBoard, options: (c) => h(FontSelect, { T: c.T }),
    keywords: ['typeface', 'font family', 'family', 'fonts', 'face', 'type', 'serif', 'sans', 'monospace', ...FONTS.map((f) => f.label)] },
  { id: 'size', label: 'Font size', group: 'Text', icon: h(ALargeSmall), needs: POST, also: noBoard, options: (c) => h(SizeSelect, { T: c.T }),
    keywords: ['size', 'text size', 'bigger', 'larger', 'smaller', 'scale', 'percent', 'big', 'small', 'fontsize'] },
  text('bold', 'Bold', 'Text', ['strong', 'thick', 'heavy', 'fat', 'emphasis', 'emphasise', 'emphasize', 'b', 'bolt', 'blod'], TOGGLE),
  text('italic', 'Italic', 'Text', ['italics', 'slanted', 'slant', 'oblique', 'emphasis', 'cursive', 'i', 'itallic', 'italik'], TOGGLE),
  text('underline', 'Underline', 'Text', ['underlined', 'underscore', 'line under', 'u', 'undeline', 'underlne'], TOGGLE),
  text('strike', 'Strikethrough', 'Text', ['strike', 'strikeout', 'strike out', 'cross out', 'crossed out', 'line through', 'scratch', 'stroke'], TOGGLE),
  text('sub', 'Subscript', 'Text', ['sub', 'lower', 'below', 'subscipt', 'chemical', 'index'], TOGGLE),
  text('sup', 'Superscript', 'Text', ['sup', 'power', 'exponent', 'raised', 'above', 'squared', 'ordinal', 'superscipt'], TOGGLE),
  text('code', 'Inline code', 'Text', ['code', 'monospace', 'mono', 'typewriter', 'backtick', 'snippet', 'programming', 'variable'], { ...TOGGLE, needs: POST }),
  text('color', 'Text colour', 'Text', ['colour', 'color', 'text color', 'font colour', 'font color', 'foreground', 'ink', 'tint', 'hue',
    'paint', 'colur', 'colr', ...COLOURS], { needs: POST, options: (c) => h(Swatches, { swatches: c.T.color.swatches }) }),
  text('highlight', 'Highlight', 'Text', ['highlighter', 'marker', 'background colour', 'background color', 'text background', 'mark',
    'shade', 'fill', 'hilight', 'hilite', 'highlite', 'higlight', 'highligh', ...COLOURS], { needs: POST, options: (c) => h(Swatches, { swatches: c.T.highlight.swatches }) }),
  text('alignLeft', 'Align left', 'Text', ['left', 'flush left', 'ragged right', 'left align', ...ALIGN], { options: alignOptions }),
  text('alignCenter', 'Align centre', 'Text', ['center', 'centre', 'centered', 'centred', 'middle', 'align center', ...ALIGN], { options: alignOptions }),
  text('alignRight', 'Align right', 'Text', ['right', 'flush right', 'right align', ...ALIGN], { options: alignOptions }),
  text('justify', 'Justify', 'Text', ['justified', 'justify text', 'full width', 'both sides', 'block', ...ALIGN], { options: alignOptions }),
  text('bulletList', 'Bullet list', 'Text', ['unordered', 'unordered list', 'dots', 'points', 'bullets', 'bulleted', 'bullet points', 'ul', 'list', 'buller'], TOGGLE),
  text('orderedList', 'Numbered list', 'Text', ['ordered', 'ordered list', 'numbers', 'numbered', 'numbering', 'ol', 'list', 'steps', 'enumerate', '1 2 3'], TOGGLE),
  text('quote', 'Quote', 'Text', ['blockquote', 'block quote', 'quotation', 'citation', 'cite', 'indent', 'qoute'], { ...TOGGLE, needs: POST }),
  text('codeBlock', 'Code block', 'Text', ['pre', 'preformatted', 'source code', 'code', 'snippet', 'monospace', 'program'], { ...TOGGLE, needs: POST }),
  text('link', 'Link', 'Text', ['url', 'hyperlink', 'href', 'web', 'website', 'address', 'anchor', 'lnk', 'linc'], { headless: false }),
  text('canvas', 'Insert canvas', 'Insert', ['canvas', 'frame', 'artboard', 'smart canvas', 'graphic', 'design', 'layout', 'canvass',
    'whiteboard', 'board', 'drawing', 'draw', 'sketch', 'diagram', 'doodle', 'paint', 'wb', 'white board']),
  text('image', 'Insert image', 'Insert', ['image', 'picture', 'photo', 'img', 'pic', 'upload', 'file', 'png', 'jpg', 'screenshot', 'imgae'], { headless: false, needs: POST_INSERT }), // a Document's is Pictures
  text('table', 'Insert table', 'Insert', ['table', 'grid', 'rows', 'columns', 'cells', 'spreadsheet', '3x3', 'tabel', 'tbale'], { needs: POST_INSERT }),
  text('addRow', 'Add row after', 'Insert', ['row', 'new row', 'insert row', 'table row'], { needs: [...TEXT, 'doc.inTable'] }),
  text('addColumn', 'Add column after', 'Insert', ['column', 'new column', 'insert column', 'table column', 'col'], { needs: [...TEXT, 'doc.inTable'] }),
  text('deleteRow', 'Delete row', 'Insert', ['remove row', 'row'], { icon: h(TableRowsSplit), needs: [...TEXT, 'doc.inTable'] }),
  text('deleteColumn', 'Delete column', 'Insert', ['remove column', 'column', 'col'], { icon: h(TableColumnsSplit), needs: [...TEXT, 'doc.inTable'] }),
  text('deleteTable', 'Delete table', 'Insert', ['remove table', 'table'], { needs: [...TEXT, 'doc.inTable'], risk: 'destructive' }),
  text('box', 'Insert titled box', 'Insert', ['box', 'titled box', 'panel', 'callout', 'container', 'card', 'section', 'spoiler'], { needs: [...TEXT, 'format.box'] }),
  text('rule', 'Horizontal rule', 'Insert', ['divider', 'separator', 'line', 'hr', 'rule', 'horizontal line', 'break', 'section break'], { needs: POST_INSERT }),
  // The draft's sources (docs/plans/references.md), in both formats. Agents use the references.* commands.
  { id: 'insert-reference', label: 'Insert reference', group: 'Insert', icon: h(TextQuote), needs: TEXT, also: noBoard, run: openCitePicker, headless: false,
    keywords: ['reference', 'citation', 'cite', 'in-text citation', 'source', 'harvard', 'quote a source', 'referance', 'refrence', 'citeation'] },
  { id: 'references', label: 'References', group: 'Insert', icon: h(BookMarked), needs: TEXT, also: noBoard, run: openReferences, headless: false,
    keywords: ['references', 'sources', 'bibliography', 'works cited', 'citations', 'add source', 'add reference', 'edit source', 'manage sources',
      'harvard', 'doi', 'arxiv', 'paste link'] },
  { id: 'insert-reference-list', label: 'Insert reference list', group: 'Insert', icon: h(ScrollText), needs: TEXT,
    also: (c) => noBoard(c) && sourcesOf().length > 0, run: insertReferenceList,
    keywords: ['reference list', 'bibliography', 'works cited', 'references', 'list of sources', 'insert references', 'harvard'] },
  { id: 'reference-style', label: 'Reference style', group: 'Insert', icon: h(Hash), needs: TEXT, also: noBoard, via: 'references.setStyle',
    options: () => h(ReferenceStyle),
    keywords: ['reference style', 'citation style', 'referencing style', 'harvard', 'ieee', 'numbered', 'numbers', 'numbering', 'author date',
      'default style'] },

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
  const value = useStore((s) => s.settings.selectedThread ?? NONE);
  return h(ToolSelect, { title: 'Project', className: 'w-64', value, onChange: (v) => runCommand(PALETTE.selectThread, { url: v === NONE ? null : v }) },
    h(SelectItem, { value: NONE }, 'All drafts'),
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
 * Escape, an empty box or the same title renames nothing (docs/plans/sidebar-menu.md decision 1). The panel takes Enter and
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
  // The sidebar menu's draft actions for the open draft (docs/plans/sidebar-menu.md decision 7). The draft clipboard is UI state:
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

// Agent edits waiting as suggestions (docs/plans/suggestions.md Tool search): shown while the open draft has some. Agents only
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
];

const TEXT_IDS = ['add-text', 'connector-label']; // flowchart mode's Text section (the shape kinds have their category)
const TOOLS = [...CORE, ...SUGGEST, ...DOC_TOOLS, ...APP, ...PLAN_TOOLS, ...FLOW_TOOLS, ...all('TOOLS')].map(withWhen).map((t) => (TEXT_IDS.includes(t.id) ? { ...t, category: 'text' } : t));

/** Every entry in registry order, with one entry per font preset. */
const allTools = (c) => [...TOOLS, ...c.presets.map((p, i) => withWhen({
  id: `preset-${i}`, label: p.name || `Preset ${i + 1}`, group: 'Text', icon: h(Palette), key: i < 9 ? `text.preset${i + 1}` : undefined,
  keywords: ['preset', 'font preset', 'apply preset', 'style'], needs: POST, also: noBoard, run: () => applyPresetAt(i),
}))];

/** The chord an entry shows: its binding's (§7k keybinds), else its fixed widget key. */
export const entryKey = (t) => (t.key ? keyLabel(t.key) : t.shortcut);

/** The entries that apply to `c` (toolContext()), in registry order. */
export const listTools = (c) => allTools(c).filter((t) => t.when(c));

bindTools({ context: toolContext, all: allTools, failedNeeds, command: byId, shortcut: entryKey }); // tool.list / tool.run (commands/tool.mjs)

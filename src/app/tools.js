import { createElement as h } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  ALargeSmall, AppWindow, BringToFront, CaseSensitive, Copy, Crop, Eraser, FilePlus, FoldVertical, FolderInput, Frame, Heading1, Heading2, Heading3,
  Globe, Heading4, Heading5, Heading6, ImagePlus, Magnet, MessagesSquare, MousePointer2, MoveHorizontal, PaintBucket, Palette, Pen, Pilcrow, Redo2, Save,
  Scaling, MessageSquare, Send, SendToBack, Settings, Shapes, SlidersHorizontal, SquarePen, SquareX, TableColumnsSplit, TableRowsSplit, Tag, Trash2,
  Type, Undo2, Workflow, X,
} from 'lucide-react';
import { SelectItem } from '@/components/ui/select';
import { canvasEditor, flowSource } from '../canvas.js';
import { FONTS, TEXT_COLORS } from '../extensions.js';
import { KINDS } from '../flow/shapes.mjs';
import { applyPresetAt, commitBoardEdit, openSettings, push, saveNow, threadLabel } from './actions.js';
import { toggleChat } from './assistant/assistant.js';
import { closePanes, HOME, newTab, openPane, openPanes } from './browser.js';
import { invoke } from './commands.js';
import { byId } from './commands/catalogue.mjs';
import { PALETTE } from './commands/palette.mjs';
import { bindTools } from './commands/tool.mjs';
import { BgSelect, SnapControls } from './components/board/BoardRail.jsx';
import { ShapeControls, ShapeIcon, StrokeControls } from './components/board/controls.jsx';
import { ItemControls } from './components/board/ItemRibbon.jsx';
import { notify } from './components/Notices.jsx';
import { BlockSelect, FontSelect, NONE, SizeSelect, Swatches, textTools, ToolButton, ToolSelect } from './components/Toolbar.jsx';
import { draftTag, tagList } from './drafts-meta.js';
import { openFlows } from './flows.js';
import { can, GATES } from './gates.mjs';
import { getState, useStore } from './store.js';
import { blockKind, flowchartMode } from './tool-rank.mjs';
import { showPage } from './views.js';
import { keyLabel } from './keybinds.js';
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

/** What the entries look at: the editor `ed` with its toolbar definitions `T`, the main column's `view` (§7g), the
 * `board` the search serves (null: the document) with its `snap`shot, the font presets, `flow`: flowchart mode (§7c), and
 * `block`: the node-selected block (selectedBlock). */
export function toolContext(board) {
  const { editor: ed, settings, view } = getState();
  const snap = board && !board.destroyed ? board.getSnapshot() : null;
  return { ed, view, T: textTools(ed), board, snap, presets: settings?.presets ?? [], flow: flowchartMode(view, snap?.kind === 'canvas' ? board.attrs : null),
    block: selectedBlock(ed, view, board, snap) };
}

/** The editor's node-selected block as the gates' `node` subject {type, attrs, kind, view}, null with a caret or text
 * selection. `kind` (tool-rank.mjs blockKind) and `view` (its NodeView, a whiteboard's Board) are set only where its bar
 * would serve it: the editor view, no canvas edited in place, a whiteboard the search serves with no item selected. */
function selectedBlock(ed, view, board, snap) {
  const sel = ed?.state.selection;
  if (!(sel instanceof NodeSelection)) return null;
  const node = { type: sel.node.type.name, attrs: sel.node.attrs, kind: null, view: null };
  const dom = ed.view.nodeDOM(sel.from);
  const v = dom?.scView ?? dom?.pcView ?? dom?.wbView;
  const served = view?.type === 'editor' && !canvasEditor.get() && !!v && (node.type !== 'whiteboard' || (v === board && snap?.count === 0));
  return served ? { ...node, kind: blockKind(node.type, node.attrs), view: v } : node;
}

/** The subject gate kind `kind` reads in the tool context `c` (gates.mjs; the commands read the same gates, commands.js). */
function subjectOf(kind, c) {
  switch (kind) {
    case 'ui': return { editor: c.ed, view: c.view };
    case 'board': return c.snap;
    case 'doc': return c.ed && { inTable: c.ed.isActive('table') };
    case 'history': return c.snap ?? (c.ed && { canUndo: c.ed.can().undo(), canRedo: c.ed.can().redo() });
    case 'draft': return getState().draft;
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

/** [{gate, message, fix}] of the entry `t`'s gates that do not hold in `c` (tool.run reports them). */
function failedNeeds(t, c) {
  const args = t.args?.(c) ?? {};
  return needsOf(t).filter((n) => (!n.if || n.if(args)) && !can(n.gate, subjectOf(GATES[n.gate].subject, c), args, n.with))
    .map(({ gate }) => ({ gate, message: GATES[gate].message, fix: GATES[gate].fix }));
}

const withWhen = (t) => (t.when ? t : { ...t, when: (c) => !failedNeeds(t, c).length && (t.also?.(c) ?? true) });

// Text entries need the editor view (a workspace has no document to format) and a search that serves the document; the
// formatting ones (FORMAT) also a caret or text selection, not a node-selected block.
const TEXT = ['doc.open', 'view.editor'];
const FORMAT = [...TEXT, 'node.none'];
const noBoard = (c) => !c.board;
const inText = (c) => noBoard(c) && !failedNeeds({ needs: TEXT }, c).length;
const BOARD = ['board.active'];
const WHITEBOARD = ['board.whiteboard'];
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
  id: value, label, group: 'Text', icon: h(icon), keywords: [...keywords, 'block style', 'style'], needs: FORMAT, also: noBoard,
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
  // One entry per registry kind (src/flow/shapes.mjs): its label, keywords and preview.
  ...KINDS.map(({ kind: shape, label, group, keywords }) => ({
    id: `shape-${shape}`, label, group: 'Board', icon: h(ShapeIcon, { shape, className: 'size-4 text-muted-foreground' }), needs: BOARD, options: shapeOptions,
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
      'white', 'black', 'post', 'backround', 'backgroud'] },
  { id: 'fit-height', label: 'Fit height', group: 'Board', icon: h(FoldVertical), needs: WHITEBOARD, run: (c) => c.board.fitHeight(),
    keywords: ['shrink', 'fit', 'height', 'trim', 'auto height', 'tighten', 'resize board', 'board height'] },
  { id: 'delete-board', label: 'Delete board', group: 'Board', icon: h(SquareX), needs: WHITEBOARD, run: (c) => c.board.deleteBoard(), risk: 'destructive',
    keywords: ['remove board', 'delete whiteboard', 'remove whiteboard', 'trash board', 'discard board'] },
  { id: 'add-text', label: 'Add text', group: 'Insert', icon: h(Type), key: 'board.text', needs: BOARD, run: tool('text'), notice: 'Text: click to place',
    keywords: ['text', 'type', 'write', 'label', 'caption', 'text box', 'textbox', 'words', 'sticky note', 'note', 'title'] },
  { id: 'add-image', label: 'Add image', group: 'Insert', icon: h(ImagePlus), key: 'board.image', needs: BOARD, run: (c) => c.board.pickImages(), headless: false,
    keywords: ['image', 'picture', 'photo', 'img', 'pic', 'upload', 'file', 'png', 'jpg', 'screenshot', 'insert image', 'imgae'] },
  { id: 'add-canvas', label: 'Add canvas', group: 'Insert', icon: h(Frame), key: 'board.canvas', needs: WHITEBOARD, run: tool('canvas'), notice: 'Canvas: click to place',
    keywords: ['canvas', 'frame', 'artboard', 'smart canvas', 'insert canvas', 'nested', 'canvass'] },

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
  { id: 'delete', label: 'Delete', group: 'Item', icon: h(Trash2), key: 'board.delete', notice: 'Deleted', needs: SELECTION, risk: 'destructive',
    run: (c) => c.board.removeItem(), keywords: ['remove', 'delete item', 'remove item', 'trash', 'bin', 'erase item', 'clear', 'del', 'backspace', 'destroy', 'delet'] },
  { id: 'reset-size', label: 'Reset size', group: 'Item', icon: h(Scaling), needs: itemIs('image', 'canvas'), run: (c) => c.board.resetSize(),
    keywords: ['natural size', 'original size', 'actual size', '100%', 'restore size', 'full size', 'resize', 'reset'] },
  { id: 'reset-crop', label: 'Reset crop', group: 'Item', icon: h(Crop), needs: itemIs('image'), also: (c) => c.snap.item.cropped,
    run: (c) => c.board.resetCrop(), keywords: ['uncrop', 'remove crop', 'undo crop', 'full image', 'whole image', 'restore image', 'crop'] },
  { id: 'edit-canvas', label: 'Edit canvas', group: 'Item', icon: h(SquarePen), shortcut: 'Enter', needs: itemIs('canvas'),
    run: (c) => c.board.editCanvas(), notice: 'Canvas Mode', keywords: ['open canvas', 'edit', 'enter canvas', 'canvas editor', 'open'] },

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
  { id: 'font', label: 'Font', group: 'Text', icon: h(CaseSensitive), needs: FORMAT, also: noBoard, options: (c) => h(FontSelect, { T: c.T }),
    keywords: ['typeface', 'font family', 'family', 'fonts', 'face', 'type', 'serif', 'sans', 'monospace', ...FONTS.map((f) => f.label)] },
  { id: 'size', label: 'Font size', group: 'Text', icon: h(ALargeSmall), needs: FORMAT, also: noBoard, options: (c) => h(SizeSelect, { T: c.T }),
    keywords: ['size', 'text size', 'bigger', 'larger', 'smaller', 'scale', 'percent', 'big', 'small', 'fontsize'] },
  text('bold', 'Bold', 'Text', ['strong', 'thick', 'heavy', 'fat', 'emphasis', 'emphasise', 'emphasize', 'b', 'bolt', 'blod'], TOGGLE),
  text('italic', 'Italic', 'Text', ['italics', 'slanted', 'slant', 'oblique', 'emphasis', 'cursive', 'i', 'itallic', 'italik'], TOGGLE),
  text('underline', 'Underline', 'Text', ['underlined', 'underscore', 'line under', 'u', 'undeline', 'underlne'], TOGGLE),
  text('strike', 'Strikethrough', 'Text', ['strike', 'strikeout', 'strike out', 'cross out', 'crossed out', 'line through', 'scratch', 'stroke'], TOGGLE),
  text('sub', 'Subscript', 'Text', ['sub', 'lower', 'below', 'subscipt', 'chemical', 'index'], TOGGLE),
  text('sup', 'Superscript', 'Text', ['sup', 'power', 'exponent', 'raised', 'above', 'squared', 'ordinal', 'superscipt'], TOGGLE),
  text('code', 'Inline code', 'Text', ['code', 'monospace', 'mono', 'typewriter', 'backtick', 'snippet', 'programming', 'variable'], TOGGLE),
  text('color', 'Text colour', 'Text', ['colour', 'color', 'text color', 'font colour', 'font color', 'foreground', 'ink', 'tint', 'hue',
    'paint', 'colur', 'colr', ...COLOURS], { options: (c) => h(Swatches, { swatches: c.T.color.swatches }) }),
  text('highlight', 'Highlight', 'Text', ['highlighter', 'marker', 'background colour', 'background color', 'text background', 'mark',
    'shade', 'fill', 'hilight', 'hilite', 'highlite', 'higlight', 'highligh', ...COLOURS], { options: (c) => h(Swatches, { swatches: c.T.highlight.swatches }) }),
  text('alignLeft', 'Align left', 'Text', ['left', 'flush left', 'ragged right', 'left align', ...ALIGN], { options: alignOptions }),
  text('alignCenter', 'Align centre', 'Text', ['center', 'centre', 'centered', 'centred', 'middle', 'align center', ...ALIGN], { options: alignOptions }),
  text('alignRight', 'Align right', 'Text', ['right', 'flush right', 'right align', ...ALIGN], { options: alignOptions }),
  text('justify', 'Justify', 'Text', ['justified', 'justify text', 'full width', 'both sides', 'block', ...ALIGN], { options: alignOptions }),
  text('bulletList', 'Bullet list', 'Text', ['unordered', 'unordered list', 'dots', 'points', 'bullets', 'bulleted', 'bullet points', 'ul', 'list', 'buller'], TOGGLE),
  text('orderedList', 'Numbered list', 'Text', ['ordered', 'ordered list', 'numbers', 'numbered', 'numbering', 'ol', 'list', 'steps', 'enumerate', '1 2 3'], TOGGLE),
  text('quote', 'Quote', 'Text', ['blockquote', 'block quote', 'quotation', 'citation', 'cite', 'indent', 'qoute'], TOGGLE),
  text('codeBlock', 'Code block', 'Text', ['pre', 'preformatted', 'source code', 'code', 'snippet', 'monospace', 'program'], TOGGLE),
  text('link', 'Link', 'Text', ['url', 'hyperlink', 'href', 'web', 'website', 'address', 'anchor', 'lnk', 'linc'], { headless: false }),
  text('whiteboard', 'Insert whiteboard', 'Insert', ['whiteboard', 'board', 'drawing', 'draw', 'sketch', 'diagram', 'doodle', 'paint', 'wb', 'white board']),
  text('canvas', 'Insert canvas', 'Insert', ['canvas', 'frame', 'artboard', 'smart canvas', 'graphic', 'design', 'layout', 'canvass']),
  text('image', 'Insert image', 'Insert', ['image', 'picture', 'photo', 'img', 'pic', 'upload', 'file', 'png', 'jpg', 'screenshot', 'imgae'], { headless: false }),
  text('table', 'Insert table', 'Insert', ['table', 'grid', 'rows', 'columns', 'cells', 'spreadsheet', '3x3', 'tabel', 'tbale']),
  text('addRow', 'Add row after', 'Insert', ['row', 'new row', 'insert row', 'table row'], { needs: [...TEXT, 'doc.inTable'] }),
  text('addColumn', 'Add column after', 'Insert', ['column', 'new column', 'insert column', 'table column', 'col'], { needs: [...TEXT, 'doc.inTable'] }),
  text('deleteRow', 'Delete row', 'Insert', ['remove row', 'row'], { icon: h(TableRowsSplit), needs: [...TEXT, 'doc.inTable'] }),
  text('deleteColumn', 'Delete column', 'Insert', ['remove column', 'column', 'col'], { icon: h(TableColumnsSplit), needs: [...TEXT, 'doc.inTable'] }),
  text('deleteTable', 'Delete table', 'Insert', ['remove table', 'table'], { needs: [...TEXT, 'doc.inTable'], risk: 'destructive' }),
  text('box', 'Insert titled box', 'Insert', ['box', 'titled box', 'panel', 'callout', 'container', 'card', 'section', 'spoiler']),
  text('rule', 'Horizontal rule', 'Insert', ['divider', 'separator', 'line', 'hr', 'rule', 'horizontal line', 'break', 'section break']),

  // Both modes: history; text mode: formatting and presets.
  { id: 'undo', label: 'Undo', group: 'Edit', icon: h(Undo2), key: 'edit.undo', keywords: ['back', 'revert', 'go back', 'step back', 'reverse', 'oops', 'undo last'],
    needs: ['history.canUndo'], also: (c) => !!c.snap || inText(c), run: (c) => (c.board ? c.board.undo() : c.T.undo.onClick()) },
  { id: 'redo', label: 'Redo', group: 'Edit', icon: h(Redo2), key: 'edit.redo', keywords: ['again', 'repeat', 'forward', 'reapply', 'redo last'],
    needs: ['history.canRedo'], also: (c) => !!c.snap || inText(c), run: (c) => (c.board ? c.board.redo() : c.T.redo.onClick()) },
  text('clear', 'Clear formatting', 'Edit', ['remove formatting', 'clear format', 'plain text', 'unformat', 'reset format', 'strip', 'clean', 'normal']),
  { id: 'presets', label: 'Manage presets', group: 'Edit', icon: h(Palette), needs: FORMAT, also: noBoard, run: openSettings, headless: false,
    keywords: ['presets', 'font presets', 'edit presets', 'settings', 'preferences', 'options'] },
];

// App (§7c): drafts and the app. New draft and the pickers' choices run commands (source 'palette', audited, SPEC §8).
const runCommand = (id, args) => invoke({ id, args, source: 'palette' }).then((r) => r.ok || notify({ text: r.error.message }));
const saved = () => !!getState().draft?.id; // a draft not saved yet has no id to tag or file

function ThreadPick() {
  const threads = useStore((s) => s.settings.threads);
  const value = useStore((s) => s.settings.selectedThread ?? NONE);
  return h(ToolSelect, { title: 'Thread', className: 'w-64', value, onChange: (v) => runCommand(PALETTE.selectThread, { url: v === NONE ? null : v }) },
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

function FolderPick() {
  const folders = useStore((s) => s.settings.folders) ?? [];
  const value = useStore((s) => s.settings.draftFolders?.[s.draft?.id] ?? NONE);
  return h(ToolSelect, { title: 'Folder', className: 'w-44', value: folders.some((f) => f.id === value) ? value : NONE,
    onChange: (v) => runCommand(PALETTE.move, { draftId: getState().draft.id, folderId: v === NONE ? null : v }) },
  h(SelectItem, { value: NONE }, 'No folder'),
  ...folders.map((f) => h(SelectItem, { key: f.id, value: f.id }, f.name)));
}

const APP = [
  { id: 'new-draft', label: 'New draft', group: 'App', icon: h(FilePlus), command: PALETTE.newDraft,
    keywords: ['new', 'create', 'add draft', 'new post', 'blank', 'start', 'new document', 'new file', 'draft'] },
  { id: 'save', label: 'Save', group: 'App', icon: h(Save), key: 'app.save', needs: ['doc.open'], notice: 'Saved',
    run: () => {
      commitBoardEdit();
      saveNow();
    },
    keywords: ['save', 'save now', 'save draft', 'store', 'keep', 'write'] },
  // ponytail: runs push() until push.prepare joins the catalogue (board-commands); then `command: 'push.prepare'`.
  { id: 'push', label: 'Push to forum', group: 'App', icon: h(Send), needs: ['doc.open', 'draft.hasThread', 'draft.unpushed'], risk: 'approval',
    run: () => push(), keywords: ['push', 'post', 'publish', 'send', 'forum', 'reply', 'upload', 'submit', 'share'] },
  { id: 'settings', label: 'Settings', group: 'App', icon: h(Settings), run: openSettings, headless: false,
    keywords: ['settings', 'preferences', 'options', 'config', 'configure', 'theme', 'dark mode', 'light mode', 'forum width', 'tags'] },
  { id: 'assistant', label: 'Assistant', group: 'App', icon: h(MessageSquare), key: 'app.assistant', run: () => toggleChat(), headless: false,
    keywords: ['assistant', 'chat', 'ai', 'ask', 'help', 'bot', 'model', 'llm', 'local ai', 'agent', 'copilot', 'assistent', 'asistant'] },
  { id: 'select-thread', label: 'Select thread...', group: 'App', icon: h(MessagesSquare), options: () => h(ThreadPick),
    keywords: ['thread', 'select thread', 'filter', 'topic', 'show thread', 'switch thread', 'all drafts', 'subject'] },
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
  { id: 'move-draft', label: 'Move to folder...', group: 'App', icon: h(FolderInput), also: () => saved() && !!getState().settings.folders?.length,
    options: () => h(FolderPick), keywords: ['folder', 'move', 'file', 'organise', 'organize', 'group', 'directory'] },
];

const TEXT_IDS = ['add-text', 'connector-label']; // flowchart mode's Text section (the shape kinds have their category)
const TOOLS = [...CORE, ...APP, ...PLAN_TOOLS, ...FLOW_TOOLS].map(withWhen).map((t) => (TEXT_IDS.includes(t.id) ? { ...t, category: 'text' } : t));

/** Every entry in registry order, with one entry per font preset. */
const allTools = (c) => [...TOOLS, ...c.presets.map((p, i) => withWhen({
  id: `preset-${i}`, label: p.name || `Preset ${i + 1}`, group: 'Text', icon: h(Palette), key: i < 9 ? `text.preset${i + 1}` : undefined,
  keywords: ['preset', 'font preset', 'apply preset', 'style'], needs: FORMAT, also: noBoard, run: () => applyPresetAt(i),
}))];

/** The chord an entry shows: its binding's (§7k keybinds), else its fixed widget key. */
export const entryKey = (t) => (t.key ? keyLabel(t.key) : t.shortcut);

/** The entries that apply to `c` (toolContext()), in registry order. */
export const listTools = (c) => allTools(c).filter((t) => t.when(c));

bindTools({ context: toolContext, all: allTools, failedNeeds, command: byId, shortcut: entryKey }); // tool.list / tool.run (commands/tool.mjs)

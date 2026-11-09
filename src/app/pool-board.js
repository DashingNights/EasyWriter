// Board and flowchart commands in the one tool pool (docs/plans/cleanup/tool-pool-surfaces.md B3, tool-library.md step 8): the
// board tools, item actions, snapping, background, layers, the canvas size bar and the flowchart library, each with tool search
// meta, so app/tools.js generates their entries. The rail, the item ribbon, the canvas edit bar, the board menu and the flowchart
// editor run them through run(id). They act on ctx.board (a canvas edited in place, the open flowchart) with the Board methods
// the agent catalogue's commands (commands/board.mjs, flow.mjs) also reach, under the catalogue's ids where it has one.
// board.* serve a board in the flowchart view and in drafts (FLOW_PROFILE and TEXT_PROFILE grant `board.`, the Document all);
// flow.* the flowchart view only.
import { createElement as h, useEffect, useRef } from 'react';
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal,
  AlignStartVertical, AlignVerticalDistributeCenter, ArrowLeftRight, BringToFront, Check, ClipboardPaste, Copy, CopyPlus, Crop, Eraser, Eye, EyeOff,
  FileInput, FilePlus2, FlipHorizontal2, FlipVertical2, Group, ImagePlus, Layers, Lock, LockOpen, Magnet, MousePointer2, MoveHorizontal, MoveUpRight, MoveVertical,
  PackagePlus, PaintBucket, Pen, Pencil, Pin, RotateCw, RouteOff, Scaling, Scissors, SendToBack, Shapes, Shrink, Slash, Spline, SquarePlus, Trash2, Type,
  Ungroup, UnfoldVertical, Frame,
} from 'lucide-react';
import { canvasEditor, fitArtboard, setArtboardSize } from '../canvas.js';
import { moveItem } from '../flow/model.mjs';
import { SHAPE_KINDS } from '../flow/shapes.mjs';
import { BG_OPTIONS, itemCopied } from '../whiteboard.js';
import { Input } from '@/components/ui/input';
import { register } from '../tooling/registry.js';
import { armTool, kindEntry, LINE_KINDS, LINE_SHAPES, lineEntry, lineOf, lineSlug } from '../tooling/shape-picker.mjs';
import { LineIcon } from '../tooling/ShapePicker.jsx';
import { openDialog } from './actions.js';
import { BgSelect, SnapControls } from './components/board/BoardRail.jsx';
import { SizeInput } from './components/board/CanvasBar.jsx';
import { ConnectorControls, isArrow, RotateControls, ShapeControls, ShapeIcon, StrokeControls } from './components/board/controls.jsx';
import { TextBackground } from './components/board/ItemRibbon.jsx';
import { toggleLayers } from './components/board/LayersPanel.jsx';
import {
  createFlow, diagramItems, draftThread, duplicateFlow, flowList, importDiagram, insertFlowchartDialog, newFlow, openFlows, removeFlow, updateFlow,
} from './flows.js';
import { selectedFlow } from './components/flows/FlowLibrary.jsx';
import { can } from './gates.mjs';
import { SHAPE_KEYS } from './keys.mjs';
import { createPrefab } from './prefabs.js';
import { getState } from './store.js';

const BOARDS = ['flow', 'text', 'document', 'board']; // a board lives in the flowchart view, in drafts and in a whiteboard draft
const FLOW = ['flow'];

const live = (ctx) => (ctx.board && !ctx.board.destroyed ? ctx.board : null);
const snapOf = (ctx) => live(ctx)?.getSnapshot() ?? null;
const gate = (id, types) => (ctx) => !!live(ctx) && can(id, snapOf(ctx), null, types);
const ON_BOARD = gate('board.active');
const SELECTION = gate('board.selection');
const MANY = gate('board.selectionMany');
const itemIs = (...types) => gate('board.itemIs', types);
const firstShape = (b) => b?.selectedItems().find((i) => i.type === 'shape') ?? null;
const turnable = (ctx) => itemIs('shape', 'image', 'text', 'stroke', 'canvas')(ctx) || MANY(ctx);
/** Whether `board` can do `method`: it has the method (the DOM Board has no placeDraft) and, on the plane board, no later module
 * still owes it (PlaneBoard.can). */
export const boardCan = (board, method) => typeof board?.[method] === 'function' && board.can?.(method) !== false;
/** `enabled` over a board that can do `method`: an action the board lacks, or a later module's that has not landed, shows disabled. */
const able = (method, enabled = ON_BOARD) => (ctx) => enabled(ctx) && boardCan(live(ctx), method);

/** Whether a Paste has something to take: the engine board's own copy (bd-clip's `api.copied`), else the whiteboard's. */
const hasCopy = (ctx) => {
  const b = live(ctx);
  return typeof b?.copied === 'function' ? b.copied() : itemCopied();
};

/** A command on the board: `fn(board, arg, ctx)`, then the board takes the focus, so its keys work right after a click. */
const act = (fn) => (ctx, arg) => {
  const b = live(ctx);
  if (!b) return false;
  const r = fn(b, arg, ctx);
  b.focus();
  return r;
};

// A tool (§6c rail): arg {toggle: true} (a rail click) turns an active tool off again.
const tool = (mode, label, icon, key, keywords, more) => ({
  run: act((b, a) => b.setMode(a?.toggle && b.mode === mode ? null : mode)),
  enabled: ON_BOARD, active: (ctx) => snapOf(ctx)?.mode === mode,
  meta: { label, group: 'Board', icon, key, keywords }, ...more,
});

// The selected text item, or the first of several selected text items (their ribbon sets them all), or null.
const textChosen = (snap) => (snap?.item?.type === 'text' ? snap.item : snap?.group?.type === 'text' ? snap.group.item : null);
const COLOURS = ['colour', 'color', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'grey', 'gray', 'white', 'black'];
const penOptions = (ctx) => h(StrokeControls, { board: ctx.board, value: snapOf(ctx).pen, set: (p) => ctx.board.setPen(p) });
const shapeOptions = (ctx) => h(ShapeControls, { board: ctx.board, value: snapOf(ctx).shape, set: (p) => ctx.board.setShapeTool(p), live: true });
const connOptions = (ctx) => h(ConnectorControls, { board: ctx.board, value: snapOf(ctx).conn, set: (p) => ctx.board.setConnTool(p) });
const lineOptions = (ctx) => h(ConnectorControls, { board: ctx.board, value: snapOf(ctx).line, set: (p) => ctx.board.setLineTool(p) });

// The Line (L) and Arrow (Shift+L) tools: free lines, whose ends go where they are put (nothing under them sticks, snaps or binds),
// beside the Connector (A), whose ends stick and route. arg {toggle: true} (a rail click) turns the active one off again.
const LINE_WORDS = ['straight line', 'free line', 'two point', 'raster', 'rule', 'segment', 'no snap', 'non snapping', 'draw line'];
const lineTool = (arrow, label, icon, key, keywords) => ({
  run: act((b, a) => (a?.toggle && b.mode === 'line' && isArrow(snapOf({ board: b }).line) === arrow ? b.setMode(null) : b.armLine(arrow))),
  enabled: ON_BOARD, active: (ctx) => { const s = snapOf(ctx); return s?.mode === 'line' && isArrow(s.line) === arrow; },
  options: lineOptions,
  meta: { label, group: 'Board', icon, key, keywords: [...LINE_WORDS, ...keywords, 'colour', 'color', 'width', 'dash', 'dashed', 'dotted', 'opacity'] },
});

/** Arrange (§6d): align, distribute and same size, one Board call each, for two or more items: [id, label, icon, run(board), keywords]. */
const ALIGN_WORDS = ['align', 'alignment', 'line up', 'allign', 'arrange'];
export const ARRANGE = [
  [
    ['board.items.align.left', 'Align left', AlignStartVertical, (b) => b.align('left'), ALIGN_WORDS],
    ['board.items.align.centre', 'Align centre', AlignCenterVertical, (b) => b.align('centre'), [...ALIGN_WORDS, 'center']],
    ['board.items.align.right', 'Align right', AlignEndVertical, (b) => b.align('right'), ALIGN_WORDS],
    ['board.items.align.top', 'Align top', AlignStartHorizontal, (b) => b.align('top'), ALIGN_WORDS],
    ['board.items.align.middle', 'Align middle', AlignCenterHorizontal, (b) => b.align('middle'), ALIGN_WORDS],
    ['board.items.align.bottom', 'Align bottom', AlignEndHorizontal, (b) => b.align('bottom'), ALIGN_WORDS],
  ],
  [
    ['board.items.distribute.h', 'Distribute horizontally', AlignHorizontalDistributeCenter, (b) => b.distribute('h'),
      ['distribute', 'space evenly', 'equal spacing', 'even gaps', 'spread', 'arrange', 'horizontally']],
    ['board.items.distribute.v', 'Distribute vertically', AlignVerticalDistributeCenter, (b) => b.distribute('v'),
      ['distribute', 'space evenly', 'equal spacing', 'even gaps', 'spread', 'arrange', 'vertically']],
  ],
  [
    ['board.items.sameSize.w', 'Same width', MoveHorizontal, (b) => b.sameSize('w'), ['same size', 'match size', 'equal size', 'match', 'resize', 'arrange', 'width']],
    ['board.items.sameSize.h', 'Same height', MoveVertical, (b) => b.sameSize('h'), ['same size', 'match size', 'equal size', 'match', 'resize', 'arrange', 'height']],
  ],
];

// One shape kind (src/flow/shapes.mjs): arms the shape tool with it. Its icon is the kind drawn; its name the one every picker
// gives it (Word's for a preset), its own label a search word, so "box" finds the Rectangle.
const kindIcons = new Map(SHAPE_KINDS.map((k) => [k.kind, () => h(ShapeIcon, { shape: k.kind, className: 'size-4 text-muted-foreground' })]));
const kindCommand = ({ kind, group }) => {
  const { label, keywords } = kindEntry(kind);
  return [`board.shape.${kind}`, {
    run: act((b) => armTool(b, { kind })),
    enabled: ON_BOARD, active: (ctx) => { const s = snapOf(ctx); return s?.mode === 'shape' && !s.prefab && s.shape.shape === kind; },
    options: shapeOptions,
    meta: { label, group: 'Board', icon: kindIcons.get(kind), key: SHAPE_KEYS[kind], keywords: [...keywords, 'shape'], category: group === 'basic' ? 'basic' : 'flowchart' },
  }];
};

// One of Word's Lines (src/tooling/shape-picker.mjs): arms the connector tool with its route and heads (its ends glue to shapes, as
// Word's do in a canvas), or its board tool (Curve, Freeform: Shape: the shape tool's line and fill; Freeform: Scribble: the pen).
// The board's own Line and Arrow kinds are the free line tools (board.line, board.arrow), which take L and Shift+L.
const pathOptions = (ctx) => h(ShapeControls, { board: ctx.board, value: snapOf(ctx).path, set: (p) => ctx.board.setPathTool(p), picker: false });
const lineCommand = (name) => {
  const { conn, tool: mode } = LINE_SHAPES[name];
  const icon = () => h(LineIcon, { name, className: 'size-4 text-muted-foreground' });
  return [`board.lines.${lineSlug(name)}`, {
    run: act((b) => armTool(b, { line: name })),
    enabled: ON_BOARD, active: (ctx) => { const s = snapOf(ctx); return conn ? s?.mode === 'connector' && lineOf(s.conn) === name : s?.mode === mode; },
    options: conn ? connOptions : mode === 'pen' ? penOptions : pathOptions,
    meta: { label: name, group: 'Board', icon, keywords: lineEntry(name).keywords, category: 'basic' },
  }];
};

// The canvas edit bar's session when it edits `b`, else null (the library editor's board has none).
const sessionOf = (b) => (canvasEditor.get()?.board === b ? canvasEditor.get() : null);
function SizeFields({ board }) {
  const { w, h: ht } = board.size();
  const set = (W, H) => (sessionOf(board) ? sessionOf(board).setSize(W, H) : setArtboardSize(board, W, H));
  return [h(SizeInput, { key: 'w', board, label: 'W', value: w, onCommit: (v) => set(v, ht) }), h(SizeInput, { key: 'h', board, label: 'H', value: ht, onCommit: (v) => set(w, v) })];
}

register('board', {
  // Tools (§6c rail).
  'board.select': tool(null, 'Select', MousePointer2, 'board.select',
    ['pointer', 'cursor', 'move', 'selection', 'mouse', 'pick', 'hand', 'arrow tool', 'exit tool', 'stop drawing'], { run: act((b) => b.mode && b.setMode(null)) }),
  'board.pen': tool('pen', 'Pen', Pen, 'board.pen', ['draw', 'drawing', 'brush', 'pencil', 'freehand', 'free hand', 'sketch', 'ink', 'marker',
    'highlighter', 'scribble', 'doodle', 'paint', 'write', 'handwriting', 'stroke', 'line', 'width', 'thickness', 'opacity', ...COLOURS], { options: penOptions }),
  'board.eraser': tool('eraser', 'Eraser', Eraser, 'board.eraser', ['erase', 'rubber', 'remove stroke', 'delete stroke', 'erasor', 'errase', 'rub out', 'wipe', 'clear ink', 'undraw']),
  'board.shape': tool('shape', 'Shape', Shapes, 'board.shape', ['shapes', 'draw shape', 'geometry', 'figure', 'polygon', 'shap', 'fill', 'outline'], { options: shapeOptions }),
  'board.connector': tool('connector', 'Connector', Spline, 'board.connector', ['arrow', 'connect', 'connection', 'link', 'line', 'edge', 'flow',
    'flowchart', 'elbow', 'curve', 'wire', 'join', 'relationship', 'conector', 'arrowhead', 'dashed', 'dotted'],
  { options: connOptions }),
  'board.line': lineTool(false, 'Line', Slash, 'board.line', ['line', 'lines']),
  'board.arrow': lineTool(true, 'Arrow', MoveUpRight, 'board.arrow', ['arrow', 'arrows', 'pointer', 'arrowhead', 'point at', 'callout arrow']),
  'board.text': tool('text', 'Add text', Type, 'board.text', ['text', 'type', 'write', 'label', 'caption', 'text box', 'textbox', 'words', 'sticky note', 'note', 'title']),
  // arg: a hex colour or null (none). A selected text item (or several) takes it, else the Text tool's next text.
  'board.items.textBackground': {
    run: act((b, bg = null) => (textChosen(snapOf({ board: b })) ? b.setItem({ bg }) : b.setTextTool({ bg }))),
    enabled: (ctx) => ON_BOARD(ctx) && (textChosen(snapOf(ctx)) || snapOf(ctx).mode === 'text'),
    options: (ctx) => {
      const snap = snapOf(ctx);
      const text = textChosen(snap);
      return h(TextBackground, { board: ctx.board, value: text ? text.bg : snap.text?.bg,
        onChange: (bg) => (text ? ctx.board.setItem({ bg }) : ctx.board.setTextTool({ bg })) });
    },
    meta: { label: 'Text background colour', optionsFirst: true, group: 'Item', icon: PaintBucket, keywords: ['background', 'background colour',
      'background color', 'text background', 'highlight', 'fill', 'note', 'note colour', 'sticky note', 'none', 'transparent', ...COLOURS] },
  },
  'board.image': {
    run: act((b, a) => (a?.toggle && b.mode === 'image' ? b.setMode(null) : b.pickImages())),
    enabled: able('pickImages'), active: (ctx) => snapOf(ctx)?.mode === 'image',
    meta: { label: 'Add image', group: 'Board', icon: ImagePlus, key: 'board.image', headless: false, keywords: ['image', 'picture', 'photo', 'img', 'pic', 'upload', 'file', 'png', 'jpg', 'screenshot', 'imgae'] },
  },
  // A draft placed on the board as a live document (bd-instance). arg {draftId, at}: places that draft; with none, a dialog picks.
  'board.placeDraft': {
    run: act((b, a) => b.placeDraft(a)),
    enabled: able('placeDraft'),
    meta: { label: 'Place draft', group: 'Board', icon: FileInput, headless: false,
      keywords: ['place draft', 'add document', 'insert document', 'embed draft', 'link document'] },
  },
  'board.keepTool': {
    run: act((b) => b.setKeepTool(!snapOf({ board: b }).keepTool)), enabled: ON_BOARD, active: (ctx) => !!snapOf(ctx)?.keepTool,
    meta: { label: 'Keep tool', group: 'Board', icon: Pin, key: 'board.keepTool', toggle: true, keywords: ['keep tool on', 'lock tool', 'tool lock', 'sticky tool', 'stay', 'repeat', 'keep drawing', 'draw many', 'again'] },
  },
  ...Object.fromEntries(SHAPE_KINDS.filter((k) => !LINE_KINDS[k.kind]).map(kindCommand)),
  ...Object.fromEntries(Object.keys(LINE_SHAPES).map(lineCommand)),

  // Snapping, background, layers.
  'board.snap': {
    run: act((b, a) => b.setSnap(a ?? { on: !snapOf({ board: b }).snap.on })), enabled: ON_BOARD, active: (ctx) => !!snapOf(ctx)?.snap.on,
    options: (ctx) => h(SnapControls, { board: ctx.board, snap: snapOf(ctx).snap }),
    meta: { label: 'Snapping', optionsFirst: true, group: 'Board', icon: Magnet, key: 'board.snap', toggle: true, keywords: ['snap', 'magnet', 'magnetic', 'grid', 'guides', 'smart guides',
      'align', 'alignment', 'spacing', 'equal spacing', 'distance', 'measure', 'measurements', 'tolerance', 'sensitivity', 'sanp', 'snaping'] },
  },
  // arg: a background id (BG_OPTIONS); none steps to the next one.
  'board.background': {
    run: act((b, bg) => {
      const list = b.bgOptions ?? BG_OPTIONS;
      b.setBg(bg ?? list[(list.findIndex(([v]) => v === (b.bg ?? snapOf({ board: b }).bg)) + 1) % list.length][0]);
    }), enabled: ON_BOARD,
    options: (ctx) => h(BgSelect, { board: ctx.board, bg: snapOf(ctx).bg }),
    meta: { label: 'Background', optionsFirst: true, group: 'Board', icon: PaintBucket, keywords: ['bg', 'board colour', 'board color', 'background colour', 'background color', 'backdrop',
      'transparent', 'white', 'black', 'page', 'canvas', 'backround', 'backgroud'] },
  },
  'board.layers': {
    run: () => toggleLayers(), enabled: ON_BOARD, active: () => getState().settings?.layersPanel ?? true,
    meta: { label: 'Layers', group: 'Board', icon: Layers, toggle: true, keywords: ['layers panel', 'layer list', 'layer', 'outline', 'tree', 'objects', 'item list',
      'z order', 'order', 'reorder', 'stack', 'hide', 'lock', 'show', 'unlock', 'groups', 'layres', 'layrs'] },
  },
  'board.items.unlockAll': {
    run: act((b) => b.setLayer('locked', true)), enabled: (ctx) => ON_BOARD(ctx) && ctx.board.items.some((i) => i.locked),
    meta: { label: 'Unlock all', group: 'Board', icon: LockOpen, keywords: ['unlock', 'locked', 'unfreeze', 'all items'] },
  },
  'board.items.showAll': {
    run: act((b) => b.setLayer('hidden', true)), enabled: (ctx) => ON_BOARD(ctx) && ctx.board.items.some((i) => i.hidden),
    meta: { label: 'Show all', group: 'Board', icon: Eye, keywords: ['show', 'unhide', 'hidden', 'visible', 'reveal', 'all items'] },
  },

  // The selection (§6c ribbon, rail and board menu).
  'board.items.duplicate': {
    run: act((b) => b.duplicate()), enabled: able('duplicate', SELECTION),
    meta: { label: 'Duplicate', group: 'Item', icon: Copy, key: 'board.duplicate', keywords: ['copy', 'clone', 'duplicate item', 'dupe', 'double', 'repeat', 'duplicat', 'duplcate'] },
  },
  'board.items.cut': {
    run: act((b) => b.copyItem(true)), enabled: able('copyItem', SELECTION),
    meta: { label: 'Cut items', group: 'Item', icon: Scissors, key: 'board.cut', keywords: ['cut', 'clipboard', 'move'] },
  },
  'board.items.copy': {
    run: act((b) => b.copyItem()), enabled: able('copyItem', SELECTION),
    meta: { label: 'Copy items', group: 'Item', icon: CopyPlus, key: 'board.copy', keywords: ['copy', 'clipboard'] },
  },
  'board.items.paste': {
    run: act((b) => b.pasteItem()), enabled: able('pasteItem', (ctx) => ON_BOARD(ctx) && hasCopy(ctx)),
    meta: { label: 'Paste items', group: 'Item', icon: ClipboardPaste, keywords: ['paste', 'clipboard', 'insert copied'] },
  },
  'board.items.remove': {
    run: act((b) => b.removeItem()), enabled: SELECTION,
    meta: { label: 'Delete', group: 'Item', icon: Trash2, key: 'board.delete', risk: 'destructive', keywords: ['remove', 'delete item', 'remove item', 'trash', 'bin', 'erase item',
      'clear', 'del', 'backspace', 'destroy', 'delet'] },
  },
  'board.items.arrange.front': {
    run: act((b) => b.arrange('front')), enabled: SELECTION,
    meta: { label: 'Bring to front', group: 'Item', icon: BringToFront, key: 'board.front', keywords: ['front', 'top', 'raise', 'forward', 'bring forward', 'above',
      'z order', 'layer', 'arrange', 'order'] },
  },
  'board.items.arrange.back': {
    run: act((b) => b.arrange('back')), enabled: SELECTION,
    meta: { label: 'Send to back', group: 'Item', icon: SendToBack, key: 'board.back', keywords: ['back', 'bottom', 'lower', 'behind', 'backward', 'send backward', 'below',
      'z order', 'layer', 'arrange', 'order'] },
  },
  ...Object.fromEntries(ARRANGE.flat().map(([id, label, icon, fn, keywords]) => [id, { run: act(fn), enabled: MANY, meta: { label, group: 'Item', icon, keywords } }])),
  'board.items.flip.x': {
    run: act((b) => b.flip('x')), enabled: SELECTION,
    meta: { label: 'Flip horizontal', group: 'Item', icon: FlipHorizontal2, key: 'board.flipH', keywords: ['flip', 'mirror', 'horizontal', 'reverse'] },
  },
  'board.items.flip.y': {
    run: act((b) => b.flip('y')), enabled: SELECTION,
    meta: { label: 'Flip vertical', group: 'Item', icon: FlipVertical2, key: 'board.flipV', keywords: ['flip', 'mirror', 'vertical', 'upside down'] },
  },
  'board.items.rotate': {
    run: act((b) => b.rotate(90)), enabled: turnable,
    options: (ctx) => h(RotateControls, { board: ctx.board, value: snapOf(ctx).item?.rot ?? 0 }),
    meta: { label: 'Rotate 90 degrees', group: 'Item', icon: RotateCw, key: 'board.rotate', keywords: ['rotate', 'turn', 'spin', 'angle', 'degrees', 'tilt', 'clockwise',
      'rotation', 'orientation', 'rotat'] },
  },
  // Lock and Hide (§6 Layer fields) name the change: Unlock / Show when every selected item already has it.
  'board.items.lock': {
    run: act((b) => b.setLayer('locked')), enabled: SELECTION,
    label: (ctx) => (live(ctx)?.selectedItems().every((i) => i.locked) ? 'Unlock' : 'Lock'),
    meta: { label: 'Lock', group: 'Item', icon: Lock, key: 'board.lock', keywords: ['unlock', 'lock item', 'freeze', 'pin down', 'fix in place', 'protect', 'background', 'screenshot'] },
  },
  'board.items.hide': {
    run: act((b) => b.setLayer('hidden')), enabled: SELECTION,
    meta: { label: 'Hide', group: 'Item', icon: EyeOff, key: 'board.hide', keywords: ['show', 'hide item', 'invisible', 'visibility', 'conceal', 'unhide'] },
  },
  'board.items.group': {
    run: act((b) => b.group()), enabled: able('group', MANY),
    meta: { label: 'Group', group: 'Item', icon: Group, key: 'board.group', keywords: ['group items', 'combine', 'join', 'bundle', 'gather', 'keep together', 'link'] },
  },
  'board.items.ungroup': {
    run: act((b) => b.group(false)), enabled: able('canUngroup', (ctx) => SELECTION(ctx) && ctx.board.canUngroup()),
    meta: { label: 'Ungroup', group: 'Item', icon: Ungroup, key: 'board.ungroup', keywords: ['ungroup items', 'split', 'separate', 'break apart', 'unbundle'] },
  },
  'board.items.prefab': {
    run: (ctx) => createPrefab(ctx.board), enabled: SELECTION,
    meta: { label: 'Create prefab...', group: 'Item', icon: PackagePlus, headless: false, keywords: ['prefab', 'template', 'save selection', 'reusable', 'reuse', 'component', 'symbol',
      'stencil', 'snippet', 'save as', 'preset'] },
  },
  'board.items.reverse': {
    run: act((b) => b.reverseConnector()), enabled: able('reverseConnector', itemIs('connector')),
    meta: { label: 'Reverse connector', group: 'Item', icon: ArrowLeftRight, keywords: ['reverse', 'flip', 'swap', 'switch direction', 'invert', 'other way', 'turn around'] },
  },
  'board.items.straighten': {
    run: act((b) => b.straighten()), enabled: able('straighten', (ctx) => itemIs('connector')(ctx) && snapOf(ctx).item.points?.length > 0),
    meta: { label: 'Straighten connector', group: 'Item', icon: RouteOff, keywords: ['straighten', 'remove bends', 'remove waypoints', 'reset route', 'clear points', 'unbend', 'tidy'] },
  },
  // Word's Resize shape to fit text (Format Shape > Text Box) on every board: the label options' toggle, by the first selected shape.
  'board.items.fitText': {
    run: act((b) => b.fitText(!b.fitsText(firstShape(b)))), enabled: able('fitText', (ctx) => !!firstShape(live(ctx))),
    active: (ctx) => !!firstShape(live(ctx)) && ctx.board.fitsText(firstShape(ctx.board)),
    meta: { label: 'Resize shape to fit text', group: 'Item', icon: UnfoldVertical, keywords: ['autofit', 'auto fit', 'fit text', 'grow with text', 'shape grows',
      'do not autofit', 'keep size', 'text overflow', 'resize to text', 'expand shape'] },
  },
  'board.items.resetSize': {
    run: act((b) => b.resetSize()), enabled: able('resetSize', itemIs('image')),
    meta: { label: 'Reset size', group: 'Item', icon: Scaling, keywords: ['natural size', 'original size', 'actual size', '100%', 'restore size', 'full size', 'resize', 'reset'] },
  },
  'board.items.resetCrop': {
    run: act((b) => b.resetCrop()), enabled: able('resetCrop', (ctx) => itemIs('image')(ctx) && snapOf(ctx).item.cropped),
    meta: { label: 'Reset crop', group: 'Item', icon: Crop, keywords: ['uncrop', 'remove crop', 'undo crop', 'full image', 'whole image', 'restore image', 'crop'] },
  },

  // The canvas edit bar (§6b) and the library editor's header (§6f): artboard size, Fit to content, Done.
  // arg {w, h} (board px); with none, the options set them.
  'board.set': {
    run: (ctx, a) => {
      const b = live(ctx);
      if (!b || !a) return false;
      const { w, h: ht } = { ...b.size(), ...a };
      return sessionOf(b) ? sessionOf(b).setSize(w, ht) : setArtboardSize(b, w, ht);
    },
    enabled: ON_BOARD, options: (ctx) => h(SizeFields, { board: ctx.board }),
    meta: { label: 'Canvas size', optionsFirst: true, group: 'Board', icon: Frame, keywords: ['artboard', 'size', 'width', 'height', 'resize canvas', 'canvas size', 'dimensions', 'w', 'h'] },
  },
  'board.fit': {
    run: (ctx) => { const b = live(ctx); return b && (sessionOf(b) ? sessionOf(b).fitContent() : fitArtboard(b)); },
    enabled: ON_BOARD,
    meta: { label: 'Fit to content', group: 'Board', icon: Shrink, keywords: ['fit', 'shrink', 'trim', 'crop canvas', 'artboard', 'fit canvas', 'tight'] },
  },
  'board.done': {
    run: () => canvasEditor.get()?.close(true), enabled: () => !!canvasEditor.get(),
    meta: { label: 'Done editing the canvas', group: 'Board', icon: Check, keywords: ['done', 'finish', 'close canvas', 'exit canvas mode', 'back to document', 'leave'] },
  },
}, BOARDS);

// The flowchart a library command acts on: arg `id` (a card's own button), else the open one, else the list's selected card.
// None: the command does nothing. They have no `enabled`, so a card's button runs whatever is open or selected.
const openId = () => (getState().view?.type === 'flows' ? getState().view.flowId ?? null : null);
const target = (id) => id ?? openId() ?? selectedFlow();
const MARGIN = 40; // flows.js insertDiagram's

/** The open flowchart's title in a box, renamed when the tool search options panel closes (Enter or a click away); Escape, an
 * empty box or the same title renames nothing (as tools.js RenameBox, whose panel takes Enter and Escape first). */
function FlowTitle() {
  const id = useRef(target()).current;
  const value = useRef(flowList().find((f) => f.id === id)?.title ?? '');
  useEffect(() => {
    let cancelled = false;
    const onKey = (e) => { if (e.key === 'Escape') cancelled = true; };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (!cancelled && id && value.current.trim()) updateFlow(id, { title: value.current });
    };
  }, []);
  return h(Input, { autoFocus: true, size: 'xs', className: 'w-64 px-1', 'aria-label': 'Flowchart title', maxLength: 120, defaultValue: value.current,
    onFocus: (e) => e.target.select(), onChange: (e) => { value.current = e.target.value; } });
}

/** Library Import: Mermaid text (the Import diagram dialog) as a new library flowchart, opened in the editor. */
async function importFlow(threadUrl) {
  const r = await openDialog('importDiagram', { text: '', board: false });
  const d = r && diagramItems(r.text, { dir: r.dir });
  if (!d || d.error) return;
  const items = d.items.map((i) => moveItem(i, MARGIN, MARGIN));
  const f = createFlow({ threadUrl, board: { w: d.w + 2 * MARGIN, h: d.h + 2 * MARGIN, frame: null, items }, source: { format: 'mermaid', text: r.text } });
  openFlows(f.id);
}

register('flow', {
  // arg: the project (thread URL, null for none); default the open draft's.
  'flow.library.create': {
    run: (_ctx, threadUrl) => newFlow(threadUrl === undefined ? draftThread() : threadUrl),
    meta: { label: 'New flowchart', group: 'Flowchart', icon: FilePlus2, key: 'flows.new', keywords: ['new diagram', 'create flowchart', 'add flowchart', 'blank flowchart', 'library', 'flow chart'] },
  },
  // arg {id, title}: renames; with none, the options give a title box for the open flowchart.
  'flow.library.rename': {
    run: (_ctx, a) => (a?.title != null && target(a.id) ? updateFlow(target(a.id), { title: a.title }) : false), options: () => h(FlowTitle),
    meta: { label: 'Rename flowchart...', optionsFirst: true, group: 'Flowchart', icon: Pencil, keywords: ['rename', 'title', 'name', 'retitle', 'change title'] },
  },
  'flow.library.duplicate': {
    run: (_ctx, id) => target(id) && duplicateFlow(target(id)).then((r) => r && !id && openId() && openFlows(r.id)),
    meta: { label: 'Duplicate flowchart', group: 'Flowchart', icon: Copy, keywords: ['duplicate', 'copy flowchart', 'clone', 'make a copy'] },
  },
  'flow.library.delete': {
    run: (_ctx, id) => !!target(id) && removeFlow(target(id)),
    meta: { label: 'Delete flowchart...', group: 'Flowchart', icon: Trash2, risk: 'destructive', headless: false, keywords: ['delete', 'remove flowchart', 'trash', 'discard', 'bin'] },
  },
  // On an open flowchart: the diagram onto its board; in the list: a new flowchart holding it. arg: the project for a new one.
  'flow.library.import': {
    run: (ctx, threadUrl) => (live(ctx) ? importDiagram({ board: ctx.board }) : importFlow(threadUrl === undefined ? draftThread() : threadUrl)),
    meta: { label: 'Import diagram...', group: 'Flowchart', icon: FileInput, headless: false, keywords: ['mermaid', 'import', 'text to diagram', 'from text', 'paste diagram', 'code',
      'markdown', 'generate', 'flowchart', 'graph'] },
  },
  'flow.insert': {
    run: (_ctx, id) => !!target(id) && insertFlowchartDialog(target(id)),
    meta: { label: 'Insert into draft...', group: 'Flowchart', icon: SquarePlus, headless: false, keywords: ['insert', 'add to draft', 'put in post', 'synced', 'copy', 'embed'] },
  },
}, FLOW);

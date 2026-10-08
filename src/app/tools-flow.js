import { createElement as h } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import {
  ArrowLeftRight, BookPlus, Captions, ClipboardPaste, Code, FileInput, FilePlus2, ImageDown, LibraryBig, Network, Package, PackagePlus,
  PaintbrushVertical, RotateCw, RouteOff, SlidersHorizontal, Spline, Unlink, Workflow,
} from 'lucide-react';
import { canvasEditor } from '../canvas.js';
import { styleCopied } from '../whiteboard.js';
import { ARRANGE } from './components/board/BoardRail.jsx';
import { ConnectorControls, LabelsPanel, RotateControls, ShapePicker } from './components/board/controls.jsx';
import { ItemControls } from './components/board/ItemRibbon.jsx';
import { DIRECTIONS } from './components/flows/forms.jsx';
import { ToolButton } from './components/Toolbar.jsx';
import { autoLayout, copyMermaid, copyPng, importDiagram, newFlow, openFlows, saveToLibrary } from './flows.js';
import { can } from './gates.mjs';
import { createPrefab } from './prefabs.js';

// Tool search entries of flowcharts and the flowchart library (flowchart plan §5.9; roadmap B2–B4, C3), spread into TOOLS
// (tools.js). Entries as there: {id, label, icon, group, keywords, when(ctx), run?(ctx), options?(ctx), shortcut?}.

const inText = (c) => !c.board && can('doc.open', { editor: c.ed }) && can('view.editor', c); // as tools.js
const onBoard = (c) => can('board.active', c.snap);
const connectorIs = (c) => can('board.itemIs', c.snap, null, ['connector']); // one selected connector
const many = (c) => can('board.selectionMany', c.snap);
const styled = (c) => can('board.itemIs', c.snap, null, ['shape', 'connector', 'text', 'stroke']); // an item with a style to copy
const ARRANGE_WORDS = {
  align: ['align', 'alignment', 'line up', 'allign', 'arrange'],
  distribute: ['distribute', 'space evenly', 'equal spacing', 'even gaps', 'spread', 'arrange'],
  same: ['same size', 'match size', 'equal size', 'match', 'resize', 'arrange'],
};

// The document canvas a library entry acts on: the one edited in place, else the node-selected one (the editor view only).
function canvasOf(c) {
  if (!can('view.editor', c)) return null;
  const target = canvasEditor.get()?.target;
  if (target) return target.parent ? null : target.owner; // a canvas item of a whiteboard is never synced
  const sel = c.ed?.state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === 'canvas' ? c.ed.view.nodeDOM(sel.from)?.scView ?? null : null;
}

const canvasIs = (gate) => (c) => {
  const cv = canvasOf(c);
  return !!cv && can(gate, { type: 'canvas', attrs: cv.node.attrs });
};

export const FLOW_TOOLS = [
  // Connectors (§6d; roadmap B2).
  { id: 'connector', label: 'Connector', group: 'Board', icon: h(Spline), key: 'board.connector', when: onBoard, run: (c) => c.board.setMode('connector'),
    options: (c) => h(ConnectorControls, { board: c.board, value: c.snap.conn, set: (p) => c.board.setConnTool(p), live: true }),
    keywords: ['arrow', 'connect', 'connection', 'link', 'line', 'edge', 'flow', 'flowchart', 'sticky arrow', 'elbow', 'curve', 'wire',
      'join', 'relationship', 'conector', 'conecter', 'arrowhead', 'head', 'dashed', 'dotted'] },
  { id: 'connector-item', label: 'Connector properties', group: 'Item', icon: h(SlidersHorizontal), when: connectorIs,
    options: (c) => h(ItemControls, { board: c.board, item: c.snap.item }),
    keywords: ['properties', 'ribbon', 'style', 'route', 'elbow', 'curve', 'straight', 'head', 'arrowhead', 'colour', 'color', 'width', 'dash', 'dashed', 'dotted'] },
  { id: 'connector-label', label: 'Connector labels', group: 'Item', icon: h(Captions), when: connectorIs,
    options: (c) => h(LabelsPanel, { board: c.board, item: c.snap.item }),
    keywords: ['label', 'labels', 'text', 'caption', 'edge label', 'source label', 'target label', 'middle label', 'yes', 'no', 'cardinality', 'name'] },
  { id: 'reverse-connector', label: 'Reverse connector', group: 'Item', icon: h(ArrowLeftRight), when: connectorIs, notice: 'Reversed',
    run: (c) => c.board.reverseConnector(), keywords: ['reverse', 'flip', 'swap', 'switch direction', 'invert', 'other way', 'turn around'] },
  { id: 'straighten', label: 'Straighten connector', group: 'Item', icon: h(RouteOff), notice: 'Straightened',
    when: (c) => connectorIs(c) && c.snap.item.points?.length > 0, run: (c) => c.board.straighten(),
    keywords: ['straighten', 'remove bends', 'remove waypoints', 'reset route', 'clear points', 'unbend', 'tidy'] },
  // Arrange, rotation and style (§6d; roadmap B3). The Arrange slot's entries (BoardRail ARRANGE), for two or more items.
  ...ARRANGE.flat().map(([id, label, Icon, run]) => ({
    id, label, group: 'Item', icon: h(Icon), when: many, run: (c) => run(c.board), notice: label,
    keywords: [...ARRANGE_WORDS[id.split('-')[0]], ...label.toLowerCase().split(' ').slice(1)],
  })),
  { id: 'rotate', label: 'Rotate 90 degrees', group: 'Item', icon: h(RotateCw), key: 'board.rotate', notice: 'Rotated',
    when: (c) => can('board.itemIs', c.snap, null, ['shape']) || many(c), run: (c) => c.board.rotate(90),
    options: (c) => h(RotateControls, { board: c.board, value: c.snap.item?.rot ?? 0 }),
    keywords: ['rotate', 'turn', 'spin', 'angle', 'degrees', 'tilt', 'clockwise', 'rotation', 'orientation', 'rotat'] },
  { id: 'copy-style', label: 'Copy style', group: 'Item', icon: h(PaintbrushVertical), key: 'board.copyStyle', notice: 'Style copied', when: styled,
    run: (c) => c.board.copyStyle(), keywords: ['copy format', 'format painter', 'style', 'copy colours', 'copy colors', 'eyedropper', 'pick style'] },
  { id: 'paste-style', label: 'Paste style', group: 'Item', icon: h(ClipboardPaste), key: 'board.pasteStyle', notice: 'Style pasted',
    when: (c) => can('board.selection', c.snap) && styleCopied(), run: (c) => c.board.pasteStyle(),
    keywords: ['paste format', 'format painter', 'apply style', 'style', 'paste colours', 'paste colors', 'match style'] },
  // Prefabs (§6g; roadmap B5): Create prefab… from the selection; Insert prefab opens the shape list at Prefabs (a tile arms the
  // shape tool, a click places it).
  { id: 'create-prefab', label: 'Create prefab...', group: 'Item', icon: h(PackagePlus), when: (c) => can('board.selection', c.snap),
    run: (c) => createPrefab(c.board), notice: 'Create prefab',
    keywords: ['prefab', 'template', 'save selection', 'reusable', 'reuse', 'component', 'symbol', 'stencil', 'snippet', 'save as', 'preset'] },
  { id: 'insert-prefab', label: 'Insert prefab', group: 'Board', icon: h(Package), when: onBoard,
    options: (c) => h(ShapePicker, {
      board: c.board, value: c.snap.shape.shape, prefabs: true, openAt: 'prefabs',
      onChange: (shape) => {
        c.board.setShapeTool({ shape });
        c.board.setMode('shape');
      },
    }),
    keywords: ['prefab', 'prefabs', 'template', 'insert template', 'stencil', 'component', 'symbol', 'saved', 'favourites', 'favorites', 'reuse'] },
  // The toolbar's Insert flowchart (tools.js text() entry shape).
  { id: 'flowchart', label: 'Insert flowchart', group: 'Insert', icon: h(Workflow), key: 'insert.flowchart', when: inText,
    run: (c) => c.T.flowchart.onClick(),
    keywords: ['diagram', 'flow', 'flow chart', 'process', 'chart', 'graph', 'nodes', 'boxes and arrows', 'swimlane', 'uml'] },
  { id: 'flow-library-open', label: 'Flowchart library', group: 'Flowchart', icon: h(LibraryBig),
    when: (c) => !can('view.flows', c) || !!c.view.flowId, run: () => openFlows(),
    keywords: ['flowcharts', 'library', 'my flowcharts', 'all flowcharts', 'diagrams', 'open flowchart', 'flowchart list', 'flows'] },
  { id: 'flow-new', label: 'New flowchart', group: 'Flowchart', icon: h(FilePlus2), when: (c) => can('doc.open', { editor: c.ed }), run: () => newFlow(),
    keywords: ['new diagram', 'create flowchart', 'add flowchart', 'blank flowchart', 'library', 'flow chart'] },
  { id: 'flow-save-to-library', label: 'Save to library', group: 'Flowchart', icon: h(BookPlus), when: canvasIs('flow.unsynced'),
    run: (c) => saveToLibrary(canvasOf(c)),
    keywords: ['link', 'sync', 'synced', 'library', 'save flowchart', 'make flowchart', 'reuse', 'share between drafts'] },
  { id: 'flow-unlink', label: 'Unlink from library', group: 'Flowchart', icon: h(Unlink), when: canvasIs('flow.synced'),
    run: (c) => canvasOf(c).unlink(),
    keywords: ['unlink', 'unsync', 'detach', 'independent copy', 'break link', 'disconnect', 'stop syncing'] },
  // Diagram formats and layout (§6d Formats, §7 Import diagram; roadmap C3): on a board, or (import) in the text, where it
  // makes a new canvas.
  { id: 'import-diagram', label: 'Import diagram...', group: 'Flowchart', icon: h(FileInput), when: (c) => onBoard(c) || inText(c),
    run: (c) => importDiagram({ board: c.board }),
    keywords: ['mermaid', 'import', 'text to diagram', 'from text', 'paste diagram', 'code', 'markdown', 'generate', 'flowchart', 'graph'] },
  { id: 'auto-layout', label: 'Auto layout', group: 'Flowchart', icon: h(Network), when: onBoard,
    options: (c) => DIRECTIONS.map(([dir, title, Icon]) => h(ToolButton, { key: dir, title, onClick: () => autoLayout(c.board, dir) }, h(Icon))),
    keywords: ['layout', 'auto arrange', 'arrange', 'tidy', 'tidy up', 'organise', 'organize', 'sort out', 'dagre', 'left to right',
      'top to bottom', 'direction', 'layered', 'neaten'] },
  { id: 'copy-mermaid', label: 'Copy as Mermaid', group: 'Flowchart', icon: h(Code), when: onBoard, run: (c) => copyMermaid(c.board),
    keywords: ['mermaid', 'export', 'copy', 'text', 'code', 'markdown', 'share', 'diagram as text', 'flowchart', 'graph'] },
  { id: 'copy-png', label: 'Copy as PNG', group: 'Flowchart', icon: h(ImageDown), when: onBoard, run: (c) => copyPng(c.board),
    keywords: ['png', 'picture', 'image', 'screenshot', 'export', 'copy', 'clipboard', 'snapshot', 'copy image'] },
];

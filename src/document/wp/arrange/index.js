// Arrange (docs/plans/word plan.md §3 arrange, briefs/arrange.md): order, align and distribute, group, rotate and flip for
// floating objects and canvas items, the Selection pane, the drawing grid with Grid and Guides, object navigation keys and
// Select Objects. A canvas being edited in place takes the commands through its Board; pictures, text boxes and canvases in the
// text take them through their layout attribute (plan.md §1.8), patched, never rebuilt.
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { canvasEditor, fitArtboard, openCanvasEditor } from '../../../canvas.js';
import { paneOpen } from '../../../tooling/panes.jsx';
import { geometryOf } from '../../geometry.js';
import { GRID_LAYER, guides, saveGuides } from './grid.js';
import { GridDialog } from './GridDialog.jsx';
import { alignTo, isFloating, isObject, nextObject, objectsOf, rotateStep, zOps } from './order.mjs';
import { SelectionPane } from './SelectionPane.jsx';

const NO_OBJECT = 'Select a picture, text box or canvas first.';
const INLINE = 'Works on objects with text wrapping other than In Line with Text.';
const GROUP_REASON = 'Groups work on the items of a canvas being edited. Select two or more of them.';

// ---------------------------------------------------------------------------------------------
// Targets

/** The object the command acts on (ctx.obj when it is a picture, text box, canvas or plan chart), else null. */
const objOf = (ctx) => (ctx.obj && ctx.obj.kind !== 'equation' ? ctx.obj : null);

/** The Board of the canvas edited in place on the target editor, else null. */
function boardOf(ctx) {
  const s = canvasEditor.get();
  return s && ctx.obj?.kind === 'canvas' && s.editor === ctx.target ? s.board : null;
}

/** The page of `pos` in `state`, or 0 without page geometry. */
const pageAt = (state, pos) => geometryOf(state)?.pageOf(pos) ?? 0;

/** The floating objects on the page of `pos` (all of them in a view without pages) → [{pos, node, z}] in document order. */
function pageFloats(state, pos) {
  const page = pageAt(state, pos);
  return objectsAt(state).filter((o) => o.float && pageAt(state, o.pos) === page);
}

/** Patches the attributes of the nodes at `patches` ([[pos, partial attrs or (attrs) => partial attrs]]) in one transaction of
 * `view`. */
export function patch(view, patches) {
  const tr = view.state.tr;
  for (const [pos, p] of patches) {
    const node = tr.doc.nodeAt(Number(pos));
    if (!node) continue;
    for (const [k, v] of Object.entries(typeof p === 'function' ? p(node.attrs) : p)) tr.setNodeAttribute(Number(pos), k, v);
  }
  if (tr.docChanged) view.dispatch(tr);
  return true;
}

/** Patches object `pos`'s layout with `p` (or p(layout)). */
const layoutPatch = (ctx, pos, p) => patch(ctx.target.view, [[pos, (a) => ({ layout: { ...a.layout, ...(typeof p === 'function' ? p(a.layout) : p) } })]]);

// The ribbon follows the store and the target's transactions; a mode kept here is shown after a transaction that carries no step.
const nudge = (ctx) => ctx.target?.view.dispatch(ctx.target.state.tr.setMeta('arrange', true));

// ---------------------------------------------------------------------------------------------
// Order

/** Moves the selected object `op` ('forward' | 'backward' | 'front' | 'back') among its page's floating objects, or the edited
 * canvas's selected items among the canvas's. */
function order(op) {
  return {
    enabled: (ctx) => !!boardOf(ctx)?.sel.size || isFloating(objOf(ctx)?.node),
    reason: (ctx) => (objOf(ctx) ? INLINE : NO_OBJECT),
    run(ctx) {
      const board = boardOf(ctx);
      if (board) {
        board.arrange(op);
        return true;
      }
      const { pos } = objOf(ctx);
      const peers = pageFloats(ctx.target.state, pos);
      const changes = zOps(peers.map((o) => ({ id: o.pos, z: o.z })), pos, op);
      return patch(ctx.target.view, Object.entries(changes).map(([p, z]) => [p, (a) => ({ layout: { ...a.layout, z } })]));
    },
  };
}

/** Bring in Front of Text (`wrap` 'front') and Send Behind Text ('behind'): the wrap changes, the z stays. */
const textLayer = (wrap) => ({
  enabled: (ctx) => isFloating(objOf(ctx)?.node),
  reason: (ctx) => (objOf(ctx) ? INLINE : NO_OBJECT),
  run: (ctx) => layoutPatch(ctx, objOf(ctx).pos, { wrap }),
});

// ---------------------------------------------------------------------------------------------
// Align

let alignMode = 'margin'; // 'page' | 'margin' | 'selected': Word keeps it for the session
const BOARD_ALIGN = { left: 'left', center: 'centre', right: 'right', top: 'top', middle: 'middle', bottom: 'bottom' };

/** Align `where`: the edited canvas's selection onto its bounds, else one floating object to the page or the margin. */
const align = (where) => ({
  enabled: (ctx) => (boardOf(ctx) ? boardOf(ctx).sel.size > 1 : isFloating(objOf(ctx)?.node)),
  reason: (ctx) => (boardOf(ctx) ? 'Select two or more items to line up.' : objOf(ctx) ? INLINE : NO_OBJECT),
  run(ctx) {
    const board = boardOf(ctx);
    if (board) {
      // ponytail: always to the selection's bounds; Align to Page or Margin onto the artboard waits for a Board method that
      // takes target bounds (whiteboard.js is not this package's, and a smart artboard follows its content anyway).
      board.align(BOARD_ALIGN[where]);
      return true;
    }
    const { pos, node } = objOf(ctx);
    // ponytail: Align Selected Objects with one object aligns to the margin; several document objects cannot be selected at once.
    return layoutPatch(ctx, pos, alignTo(node.attrs.layout, where, alignMode === 'page' ? 'page' : 'margin'));
  },
});

const distribute = (axis) => ({
  enabled: (ctx) => (boardOf(ctx)?.sel.size ?? 0) > 2,
  reason: () => 'Spaces three or more selected items of a canvas being edited.',
  run: (ctx) => boardOf(ctx).distribute(axis) ?? true,
});

const mode = (m) => ({
  active: () => alignMode === m,
  run(ctx) {
    alignMode = m;
    nudge(ctx);
    return true;
  },
});

const gridToggle = {
  active: (ctx) => !!guides(ctx).gridlines,
  run: (ctx) => saveGuides({ gridlines: !guides(ctx).gridlines }),
};

// ---------------------------------------------------------------------------------------------
// Group

let ungrouped = null; // the item ids last ungrouped in this session (Regroup)

const group = {
  enabled: (ctx) => (boardOf(ctx)?.sel.size ?? 0) > 1,
  reason: () => GROUP_REASON,
  run: (ctx) => boardOf(ctx).group(true) ?? true,
};
const ungroup = {
  enabled: (ctx) => !!boardOf(ctx)?.canUngroup(),
  reason: () => 'Select a group of a canvas being edited.',
  run(ctx) {
    const board = boardOf(ctx);
    ungrouped = [...board.sel];
    board.group(false);
    return true;
  },
};
const regroup = {
  enabled: (ctx) => {
    const board = boardOf(ctx);
    return !!board && !!ungrouped && ungrouped.every((id) => board.items.some((i) => i.id === id));
  },
  reason: () => 'Ungroup a group of a canvas first.',
  run(ctx) {
    const board = boardOf(ctx);
    board.select(ungrouped);
    board.group(true);
    return true;
  },
};

// ---------------------------------------------------------------------------------------------
// Rotate

/** Runs `fn(board)` on the edited canvas, or on every item of a node-selected canvas opened for it (turned about its centre,
 * then fitted to its content) and closed again. */
function onCanvas(ctx, fn) {
  const board = boardOf(ctx);
  if (board) {
    fn(board);
    return true;
  }
  const { pos } = objOf(ctx);
  openCanvasEditor(ctx.target, pos);
  const s = canvasEditor.get();
  if (!s?.board) return false;
  s.board.selectAll();
  fn(s.board);
  fitArtboard(s.board);
  s.close(true);
  return true;
}

const rotate = (by) => ({
  enabled: (ctx) => !!objOf(ctx) && objOf(ctx).kind !== 'planChart',
  reason: (ctx) => (objOf(ctx) ? 'Plan charts do not turn.' : NO_OBJECT),
  run(ctx) {
    const { kind, pos } = objOf(ctx);
    if (kind === 'canvas') return onCanvas(ctx, (b) => b.rotate(by));
    return patch(ctx.target.view, [[pos, (a) => ({ rotate: rotateStep(a.rotate, by) })]]);
  },
});

const flip = (key, axis) => ({
  enabled: (ctx) => ['picture', 'graphic', 'canvas'].includes(objOf(ctx)?.kind),
  reason: (ctx) => ({ textbox: 'Text boxes turn but do not flip.', planChart: 'Plan charts do not flip.' })[objOf(ctx)?.kind] ?? NO_OBJECT,
  run(ctx) {
    const { kind, pos } = objOf(ctx);
    if (kind === 'canvas') return onCanvas(ctx, (b) => b.flip(axis));
    return patch(ctx.target.view, [[pos, (a) => ({ [key]: !a[key] })]]);
  },
});

// ---------------------------------------------------------------------------------------------
// Object navigation, the object layer and Select Objects

/** Node-selects the object at `pos` in `view` and scrolls it into view; `focus` false leaves the focus where it is (the
 * Selection pane keeps it, so F2 renames the row just clicked). */
export function selectAt(view, pos, focus = true) {
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)).scrollIntoView());
  if (focus) view.focus();
  return true;
}

const isObjectSel = (sel) => sel instanceof NodeSelection && isFloating(sel.node);

/** Alt+Down (`dir` 1) and Alt+Up (-1): the next or previous floating object in document order, wrapping at the ends. */
const step = (dir) => ({
  run(ctx) {
    const { state, view } = ctx.target;
    const floats = objectsAt(state).filter((o) => o.float).map((o) => o.pos);
    const p = nextObject(floats, state.selection.from, dir, isObjectSel(state.selection));
    return p != null && selectAt(view, p);
  },
});

let layer = null; // the object layer (Ctrl+Alt+5): {from, to} of the selection to return to on Esc
let selectMode = false; // Select Objects

const objectLayer = {
  run(ctx) {
    const { state, view } = ctx.target;
    const floats = pageFloats(state, state.selection.from);
    if (!floats.length) {
      ctx.toast('There are no floating objects on this page.');
      return false;
    }
    layer = { from: state.selection.from, to: state.selection.to };
    return selectAt(view, floats[0].pos);
  },
};

const selectObjects = {
  active: () => selectMode,
  run(ctx) {
    selectMode = !selectMode;
    nudge(ctx);
    return true;
  },
};

/** The floating object under a pointer event in `view`: the object node itself or the text box holding the point. */
function objectAt(view, e) {
  const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
  if (!hit) return null;
  const node = hit.inside >= 0 ? view.state.doc.nodeAt(hit.inside) : null;
  if (node && isFloating(node)) return hit.inside;
  const $p = view.state.doc.resolve(hit.pos);
  for (let d = $p.depth; d > 0; d--) if (isFloating($p.node(d))) return $p.before(d);
  return null;
}

const decoKey = new PluginKey('arrangeLayers');

/** The objects of `state`'s document ([{pos, node, float, z}], document order), kept by the layer plugin so a long document is
 * walked only when an object changes. */
export const objectsAt = (state) => decoKey.getState(state)?.objs ?? objectsOf(state.doc);

/** The layer state of `doc`: its objects and the decorations that draw each float's stacking and Selection pane visibility on
 * its node (float-layout positions it). The z-index is the float's rank, not its raw z: Send to Back can make z negative, and
 * inside the editor's isolated stacking context a negative z-index paints under the text, which only Behind Text may do. */
function layers(doc) {
  const objs = objectsOf(doc);
  const floats = objs.filter((o) => o.float);
  const ranked = floats.map((o, i) => ({ o, i })).sort((a, b) => a.o.z - b.o.z || a.i - b.i).map((r) => r.o); // a later one wins a tie
  const decos = ranked.map((o, k) => Decoration.node(o.pos, o.pos + o.node.nodeSize, {
    style: `z-index: ${o.node.attrs.layout.wrap === 'behind' ? k - floats.length : k + 1};${o.node.attrs.layout.hidden ? ' visibility: hidden;' : ''}`,
    'data-arrange-z': String(o.z),
  }));
  return { objs, decos: DecorationSet.create(doc, decos) };
}

/** Whether transaction `tr` changes an object: an attribute step, or a step whose range held, holds or sits in one (before
 * and after it). Typing in the text elsewhere does not, so the layer state is mapped instead of rebuilt. */
function touchesObject(tr) {
  if (tr.steps.some((st) => st.jsonID === 'attr')) return true;
  let hit = false;
  const scan = (doc, from, to) => !hit && doc.nodesBetween(from, to, (n) => !(hit ||= isObject(n)));
  tr.mapping.maps.forEach((map, i) => map.forEach((a, b, from, to) => {
    scan(tr.docs[i], a, b);
    scan(tr.docs[i + 1] ?? tr.doc, from, to);
  }));
  return hit;
}

const ArrangeKeys = Extension.create({
  name: 'wordArrange',
  priority: 1300, // ahead of WordKeys (1200), so Tab and Esc reach the object layer and Select Objects first
  addProseMirrorPlugins() {
    return [new Plugin({
      key: decoKey,
      state: {
        init: (_, state) => layers(state.doc),
        apply(tr, old) {
          if (!tr.docChanged) return old;
          if (touchesObject(tr)) return layers(tr.doc);
          return { objs: old.objs.map((o) => ({ ...o, pos: tr.mapping.map(o.pos) })), decos: old.decos.map(tr.mapping, tr.doc) };
        },
      },
      props: {
        decorations: (state) => decoKey.getState(state).decos,
        handleKeyDown(view, e) {
          if (selectMode && e.key === 'Escape') {
            selectMode = false;
            view.dispatch(view.state.tr.setMeta('arrange', true));
            return true;
          }
          if (!layer || !isObjectSel(view.state.selection)) return false;
          if (e.key === 'Escape') {
            const { from, to } = layer;
            layer = null;
            const max = view.state.doc.content.size;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(from, max), Math.min(to, max))).scrollIntoView());
            return true;
          }
          if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return false;
          const at = view.state.selection.from;
          const floats = pageFloats(view.state, at).map((o) => o.pos);
          const p = nextObject(floats, at, e.shiftKey ? -1 : 1, true);
          return p != null && selectAt(view, p);
        },
        handleDOMEvents: {
          mousedown(view, e) {
            if (!selectMode || e.button !== 0) return false;
            e.preventDefault(); // clicks pass over the text
            const pos = objectAt(view, e);
            if (pos != null) selectAt(view, pos);
            return true;
          },
        },
      },
      view(view) {
        // Leaving canvas edit mode clears the inline visibility it set on the canvas, which wipes the Selection pane's hide
        // (the decoration is unchanged, so ProseMirror does not write it again): put it back on the hidden floats.
        const off = canvasEditor.subscribe(() => {
          if (canvasEditor.get() || view.isDestroyed) return;
          for (const o of objectsAt(view.state)) {
            const el = o.float && o.node.attrs.layout.hidden && view.nodeDOM(o.pos);
            if (el) el.style.visibility = 'hidden';
          }
        });
        return {
          update(view) {
            if (layer && !(view.state.selection instanceof NodeSelection)) layer = null; // the caret moved on its own: the layer ends
          },
          destroy: off,
        };
      },
    })];
  },
});

// ---------------------------------------------------------------------------------------------
// The module

const MENU = { run: () => true }; // dropdowns: the renderer opens the menu
const selectionPane = { active: () => paneOpen('selection'), run: (ctx) => ctx.pane('selection') ?? true };
const A = 'layout.arrange';

export default {
  id: 'arrange',
  extensions: [ArrangeKeys],
  layers: [GRID_LAYER],
  dialogs: { gridSettings: GridDialog },
  panes: { selection: { title: 'Selection', side: 'right', width: 16, Component: SelectionPane } },
  commands: {
    [`${A}.bringForward`]: order('forward'),
    [`${A}.bringForward.bringForward`]: order('forward'),
    [`${A}.bringForward.bringToFront`]: order('front'),
    [`${A}.bringForward.bringInFrontOfText`]: textLayer('front'),
    [`${A}.sendBackward`]: order('backward'),
    [`${A}.sendBackward.sendBackward`]: order('backward'),
    [`${A}.sendBackward.sendToBack`]: order('back'),
    [`${A}.sendBackward.sendBehindText`]: textLayer('behind'),
    [`${A}.selectionPane`]: selectionPane,
    'home.editing.select.selectionPane': selectionPane,
    'panes.selection': selectionPane,
    [`${A}.align`]: MENU,
    [`${A}.align.alignLeft`]: align('left'),
    [`${A}.align.alignCenter`]: align('center'),
    [`${A}.align.alignRight`]: align('right'),
    [`${A}.align.alignTop`]: align('top'),
    [`${A}.align.alignMiddle`]: align('middle'),
    [`${A}.align.alignBottom`]: align('bottom'),
    [`${A}.align.distributeHorizontally`]: distribute('h'),
    [`${A}.align.distributeVertically`]: distribute('v'),
    [`${A}.align.alignToPage`]: mode('page'),
    [`${A}.align.alignToMargin`]: mode('margin'),
    [`${A}.align.alignSelectedObjects`]: mode('selected'),
    [`${A}.align.useAlignmentGuides`]: {
      active: (ctx) => !!guides(ctx).display,
      run: (ctx) => saveGuides({ display: !guides(ctx).display }),
    },
    [`${A}.align.viewGridlines`]: gridToggle,
    'view.show.gridlines': gridToggle,
    [`${A}.align.gridSettings`]: { run: (ctx) => !!ctx.dialog('gridSettings') },
    [`${A}.group`]: { ...MENU, enabled: (ctx) => !!boardOf(ctx), reason: () => GROUP_REASON },
    [`${A}.group.group`]: group,
    [`${A}.group.regroup`]: regroup,
    [`${A}.group.ungroup`]: ungroup,
    [`${A}.rotate`]: { ...MENU, enabled: (ctx) => !!objOf(ctx), reason: () => NO_OBJECT },
    [`${A}.rotate.rotateRight90`]: rotate(90),
    [`${A}.rotate.rotateLeft90`]: rotate(-90),
    [`${A}.rotate.flipVertical`]: flip('flipV', 'y'),
    [`${A}.rotate.flipHorizontal`]: flip('flipH', 'x'),
    [`${A}.rotate.moreRotationOptions`]: {
      enabled: (ctx) => !!objOf(ctx),
      reason: () => NO_OBJECT,
      run: (ctx) => !!ctx.dialog('layout', { tab: 'size' }),
    },
    'graphicsFormat.arrangeSize.arrange': MENU,
    'home.editing.select.selectObjects': selectObjects,
    'pictures.nextObject': step(1),
    'pictures.prevObject': step(-1),
    'pictures.objectLayer': objectLayer,
  },
};

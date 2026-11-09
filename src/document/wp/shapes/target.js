// The object Shape Format acts on (plan.md §1.3 ctx.obj) and its one write path. A canvas is changed through canvas.js
// (liveBoard, commitSynced: one undo step per change, never agent commands, which would record suggestions); a canvas that holds
// one shape refits its artboard after each change, so sizing the canvas sizes the shape. A text box is its node's attributes.
import { canvasEditor, commitSynced, liveBoard, openCanvasEditor } from '../../../canvas.js';
import { columnWidth } from '../../../whiteboard.js';
import { armTool, LINE_SHAPES } from '../../../tooling/shape-picker.mjs';
import { arm } from './crosshair.js';
import { lookFor } from './looks.js';
import { fitItems, PX, SHAPE_MAP } from './map.mjs';

/** The Shape Format target of `ctx`: {kind: 'canvas', pos, ed, view, cv, session, attrs, k} | {kind: 'textbox', pos, view, node} | null.
 * k: the canvas's display scale (layout px per board px), session: its in-place editor when open, ed: the editor holding it. */
export function targetOf(ctx) {
  const o = ctx?.obj;
  if (!o) return null;
  if (o.kind === 'textbox') {
    const view = ctx.target?.view;
    const node = view?.state.doc.nodeAt(o.pos);
    return node?.type.name === 'textBox' ? { kind: 'textbox', pos: o.pos, view, node } : null;
  }
  if (o.kind !== 'canvas') return null;
  for (const ed of [ctx.target, ctx.ed]) {
    const cv = ed?.view.nodeDOM(o.pos)?.scView;
    if (!cv || cv.node.type.name !== 'canvas') continue;
    const s = canvasEditor.get();
    const attrs = { ...cv.node.attrs, ...liveBoard(cv) };
    return { kind: 'canvas', pos: o.pos, ed, view: ed.view, cv, session: s?.target?.owner === cv ? s : null, attrs, k: attrs.dw / attrs.w || 1 };
  }
  return null;
}

// Drawing into a canvas (briefs/insert-shapes-in-canvas.md): with a drawing canvas being edited or selected, Word draws a shape
// picked from Insert Shapes inside it. Here the canvas's board arms its own tool for the shape, the one its rail arms (shape-picker
// armTool), so the shape is drawn there by a drag (a click drops one at its default size) in the document's default looks (looks.js
// through the board's host). A text box is a rectangle with text in the default text box look, as Word keeps one in a canvas.
// A lone shape (a one-shape canvas, edited or selected) is no drawing canvas: Insert Shapes draws a separate shape, as in Word.

/** What arms Word shape `name` on a board → {kind} (the shape tool with the preset's kind), {line} (a Lines entry: a connector,
 * Curve, Freeform: Shape or the pen), {textBox} (a text box, `vertical` for Vertical Text Box), or null for no Word shape. */
export function boardTool(name) {
  const m = SHAPE_MAP[name];
  if (m?.kind) return { kind: m.kind };
  if (m && LINE_SHAPES[name]) return { line: name };
  if (m?.tool === 'textBox' || m?.tool === 'verticalTextBox') return { textBox: true, vertical: m.tool === 'verticalTextBox' };
  return null;
}

/** Arms `name`'s tool (boardTool) on the board Insert Shapes draws into in `ctx` → true; false when there is none: no canvas
 * edited or selected, or a one-shape canvas (Word's lone shape, which no shape is drawn into). A selected drawing canvas opens for
 * editing first, as a pick in Word draws inside the selected canvas. */
export function drawIn(ctx, name) {
  const tool = boardTool(name);
  if (!tool) return false;
  let board = canvasEditor.get()?.board;
  if (board && oneShape(board)) return false; // a lone shape being edited (its text, its points)
  if (!board) {
    const t = targetOf(ctx);
    if (t?.kind !== 'canvas' || oneShape(t.attrs)) return false;
    openCanvasEditor(t.ed, t.pos);
    board = canvasEditor.get()?.board;
  }
  if (!board || board.destroyed) return false;
  endOutside?.();
  // ponytail: Vertical Text Box draws a horizontal one; give it a direction when a board shape's text takes one (export writes vert="horz").
  if (tool.textBox) board.setMode('shape', { look: lookFor(ctx.ed, 'textbox') });
  else armTool(board, tool);
  if (!SHAPE_MAP[name].tool) drawOutside(ctx.ed, name, canvasEditor.get(), board);
  return true;
}

let endOutside = null;

// While the picked shape is armed, a press on the page outside the canvas closes it (canvas.js onPointerDown) and draws the shape
// there through the crosshair, a separate one-shape canvas, as Word draws a shape beside a canvas; the page area shows the
// crosshair cursor meanwhile. The board's tool changing (the shape drawn, another tool, Esc) or the canvas closing ends it.
// ponytail: the board-only tools (Curve, Freeform, Scribble, text boxes) still just close the canvas on a press outside.
function drawOutside(ed, name, session, board) {
  const area = document.querySelector('#editor-area');
  const cursor = area?.style.cursor;
  // The armed tool: the mode and, for the shape and connector tools, the kind, since the board's rail picks another kind without
  // changing the mode (armTool). A look change (fill, line) keeps the pick.
  const toolKey = () => {
    const s = board.getSnapshot();
    return JSON.stringify([s.mode, s.mode === 'shape' && s.shape.shape, s.mode === 'connector' && [s.conn.route, s.conn.heads]]);
  };
  const key = toolKey();
  const offBoard = board.subscribe(() => (board.destroyed || toolKey() !== key) && endOutside?.());
  const offSession = canvasEditor.subscribe(() => canvasEditor.get() !== session && endOutside?.());
  endOutside = () => {
    endOutside = null;
    session.outside = null;
    offBoard();
    offSession();
    if (area) area.style.cursor = cursor;
  };
  if (area) area.style.cursor = 'crosshair';
  session.outside = (e) => e.target.closest?.('#editor-area') && arm(ed, name, undefined, e);
}

/** Whether canvas attrs `a` are a one-shape canvas (Insert > Shapes): one item with the frame bound to it. */
export const oneShape = (a) => a.items.length === 1 && a.frame?.item === a.items[0].id;

/** The items of canvas target `t` the commands change: the edited canvas's selected items, else every item. */
export function chosen(t) {
  const sel = t.session?.board?.sel;
  return sel?.size ? t.attrs.items.filter((i) => sel.has(i.id)) : t.attrs.items;
}

/** Commits canvas target `t` with `items` (and attrs `extra`) as one undo step; a one-shape canvas is refitted to its item and
 * keeps its display scale. */
export function commitCanvas(t, items, extra = {}) {
  let attrs = { ...t.attrs, ...extra, items };
  if (oneShape(t.attrs) && items.length >= 1 && !('frame' in extra)) {
    const f = fitItems(items);
    attrs = { ...attrs, ...f, dw: Math.max(1, Math.min(Math.round(t.k * f.w), columnWidth(t.view, t.pos))) };
  }
  commitSynced(t.cv, t.pos, attrs, true);
  return true;
}

/** Changes the chosen items of canvas target `t`: fn(item) → a patch or null (unchanged). → false when nothing changed. */
export function patchItems(t, fn) {
  const ids = new Set(chosen(t).map((i) => i.id));
  let changed = false;
  const items = t.attrs.items.map((it) => {
    const p = ids.has(it.id) ? fn(it) : null;
    if (!p) return it;
    changed = true;
    return { ...it, ...p };
  });
  return changed && commitCanvas(t, items);
}

/** Patches text box target `t`'s attributes (one undo step); `fn(attrs)` → a patch. */
export function patchBox(t, fn) {
  const node = t.view.state.doc.nodeAt(t.pos);
  if (node?.type.name !== 'textBox') return false;
  const patch = typeof fn === 'function' ? fn(node.attrs) : fn;
  t.view.dispatch(t.view.state.tr.setNodeMarkup(t.pos, undefined, { ...node.attrs, ...patch }));
  return true;
}

/** The look the controls show for target `t`: {fill: hex|null, line: hex|null, width (pt), dash, heads, opacity} of the first
 * chosen item (a canvas) or of the text box. */
export function lookOf(t) {
  if (!t) return null;
  if (t.kind === 'textbox') {
    const { fill, line } = t.node.attrs;
    return { fill: typeof fill === 'string' ? fill : null, line: line?.color ?? null, width: line?.width ?? 0, dash: line?.dash ?? 'solid', heads: null };
  }
  const it = chosen(t)[0];
  if (!it) return null;
  const fill = it.type === 'shape' && it.fill !== 'none' ? it.fillColor : null;
  const line = it.color === 'transparent' ? null : it.color ?? null;
  return { fill, line, width: ((it.width ?? 1) * t.k) / PX, dash: it.dash ?? 'solid', heads: it.heads ?? null, opacity: it.opacity ?? 1, item: it };
}

/** Size of target `t` in points: {w, h} of the shape (one-shape canvas), the canvas box, or the text box. */
export function sizeOf(t) {
  if (!t) return null;
  if (t.kind === 'textbox') return { w: t.node.attrs.w, h: t.node.attrs.h };
  const a = t.attrs;
  if (oneShape(a)) return { w: (a.items[0].w * t.k) / PX, h: (a.items[0].h * t.k) / PX };
  return { w: a.dw / PX, h: (a.h * t.k) / PX };
}

/** Sets target `t`'s width or height (`side` 'w' | 'h') to `pt` points. */
export function setSize(t, side, pt) {
  if (!t || !Number.isFinite(pt) || pt <= 0) return false;
  if (t.kind === 'textbox') return patchBox(t, { [side]: Math.round(pt * 100) / 100 });
  const a = t.attrs;
  const px = (pt * PX) / t.k; // board px
  if (oneShape(a)) {
    const it = a.items[0];
    if (it.type === 'connector') return false; // a line's size follows its ends
    return commitCanvas(t, [{ ...it, [side]: Math.max(1, Math.round(px * 100) / 100) }]);
  }
  if (side === 'w') return commitCanvas(t, a.items, { dw: Math.max(40, Math.min(Math.round(pt * PX), columnWidth(t.view, t.pos))), frame: a.frame });
  const h = Math.max(40, Math.round(px));
  return commitCanvas(t, a.items, { h, frame: { ...(a.frame ?? { x: 0, y: 0, w: a.w }), h } });
}

/** Why a canvas cannot take a fill, outline pattern or effect that a text box can (plan.md §1.3 reason). */
export const CANVAS_ONLY = 'Shapes on a canvas take solid and hatched fills and plain outlines. Text boxes take the rest.';

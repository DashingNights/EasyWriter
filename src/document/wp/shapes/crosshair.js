// Insert > Shapes' crosshair (briefs/shapes.md): picking a shape arms it over the page area; a drag draws the shape in that box
// (Shift keeps it square or the line at 45 degrees, Ctrl draws from the centre), a click inserts it at 1 x 1 in, Esc cancels.
// The result is a canvas holding the one shape, inserted after the top-level block under the pointer, In Front of Text. It serves
// with no drawing canvas edited or selected (in one, the canvas's own board draws the shape: target.js drawIn, and a press outside
// that canvas draws here), and with a lone shape edited, which it closes.
import { NodeSelection } from '@tiptap/pm/state';
import { canvasEditor } from '../../../canvas.js';
import { columnWidth, insertBoard, topLevelPos } from '../../../whiteboard.js';
import { scaleOf } from '../../geometry.js';
import { columnBoxAt, flowPos } from '../columns/model.mjs';
import { CLICK_SIZE, dragBox, fitItems, PX, SHAPE_MAP, shapeItem } from './map.mjs';
import { looksIn } from './looks.js';

const CLICK = 4; // screen px a press may move and still count as a click

let armed = null; // {el, cancel}

/** Cancels an armed crosshair. */
export const disarm = () => armed?.cancel();

/** Arms the crosshair for Word shape `name` on editor `ed`; `done(pos)` gets the inserted canvas's position. `press`: a pointerdown
 * already under way (a press outside an edited canvas, target.js drawIn), which starts the drag at once. */
export function arm(ed, name, done = () => {}, press = null) {
  disarm();
  canvasEditor.get()?.close(true); // Word leaves the shape it was editing
  const area = document.querySelector('#editor-area') ?? ed.view.dom.parentElement;
  const r = area.getBoundingClientRect();
  const el = document.createElement('div');
  el.dataset.shapeCrosshair = name;
  el.title = 'Drag to draw the shape, or click for a 1 inch shape. Esc cancels.';
  el.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:40;cursor:crosshair;touch-action:none`;
  const ghost = document.createElement('div');
  ghost.style.cssText = 'position:fixed;display:none;pointer-events:none;outline:1px dashed var(--ui-accent, #4f8cff);background:color-mix(in oklab, var(--ui-accent, #4f8cff) 12%, transparent)';
  el.append(ghost);
  let start = null;
  const box = (e) => {
    const s = start;
    return dragBox({ x: s.cx, y: s.cy }, { x: e.clientX, y: e.clientY }, { square: e.shiftKey, centre: e.ctrlKey, line: !!SHAPE_MAP[name]?.conn });
  };
  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    start = { cx: e.clientX, cy: e.clientY };
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const b = box(e);
    Object.assign(ghost.style, { display: 'block', left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  });
  el.addEventListener('pointerup', (e) => {
    if (!start) return;
    const click = Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < CLICK;
    const b = click ? null : box(e);
    const at = { x: start.cx, y: start.cy };
    cancel();
    const pos = insertShape(ed, name, at, b);
    if (pos != null) done(pos);
  });
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const cancel = () => {
    el.remove();
    window.removeEventListener('keydown', onKey, true);
    armed = null;
  };
  window.addEventListener('keydown', onKey, true);
  document.body.append(el);
  armed = { el, cancel };
  if (press) down(press);
}

/** Inserts the canvas for Word shape `name` drawn at client box `b` (null: a click at client point `at`) → its position. */
export function insertShape(ed, name, at, b) {
  const view = ed.view;
  const pm = view.dom.getBoundingClientRect();
  const s = scaleOf(view);
  const lay = (x, y) => ({ x: (x - pm.left) / s, y: (y - pm.top) / s }); // layout px
  const p = b ? lay(b.x, b.y) : lay(at.x, at.y);
  const r2 = (n) => Math.round(n * 100) / 100;
  const box = b ? { x: r2(p.x), y: r2(p.y), w: Math.max(1, r2(b.w / s)), h: Math.max(1, r2(b.h / s)) } : { x: r2(p.x), y: r2(p.y), w: CLICK_SIZE, h: CLICK_SIZE };
  const item = shapeItem(name, box, { flipX: !!b?.flipX, flipY: !!b?.flipY }, looksIn(ed));
  if (!item) return null;
  const fit = fitItems([item]);
  // The block under the pointer (in newspaper columns, the column's block): the canvas goes after it, and its offsets are from the
  // column's left (the newspaper column that block was drawn in, as float layout reads it) and that block's bottom.
  const hit = view.posAtCoords({ left: Math.min(Math.max(at.x, pm.left + 1), pm.right - 1), top: at.y });
  const $p = view.state.doc.resolve(hit?.pos ?? view.state.doc.content.size);
  const pos = topLevelPos($p);
  const start = flowPos($p, true);
  const blockRect = start !== pos ? view.nodeDOM(start)?.getBoundingClientRect?.() : null;
  const bottom = blockRect ? (blockRect.bottom - pm.top) / s : p.y;
  const left = parseFloat(getComputedStyle(view.dom).paddingLeft) || 0;
  const col = columnBoxAt(view.state.doc, $p.pos, blockRect ? ((blockRect.left + blockRect.right) / 2 - pm.left) / s - left : box.x - left);
  const layout = { wrap: 'front', h: { rel: 'column', offset: r2((box.x - left - (col?.left ?? 0)) / PX) }, v: { rel: 'paragraph', offset: r2((box.y - bottom) / PX) } };
  const node = view.state.schema.nodes.canvas.create({ ...fit, dw: Math.min(fit.w, columnWidth(view, $p.pos)), bg: 'transparent', layout });
  const tr = insertBoard(view.state.tr, pos, node);
  tr.setSelection(NodeSelection.create(tr.doc, pos)); // Word selects the new shape: Shape Format shows
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return pos;
}

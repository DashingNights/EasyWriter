// The text box pointer tools (docs/plans/word/plan.md §3 textbox): Draw Horizontal and Vertical Text Box (a crosshair over the page:
// a drag draws the box, Shift keeps it square, a click inserts the default size, Esc cancels) and Create Link (the pointer becomes
// a jug and a click on an empty text box links the box to it). One tool is armed at a time.
import { TextSelection } from '@tiptap/pm/state';
import { overlayOf, scaleOf } from '../../geometry.js';
import { flowPos } from '../columns/model.mjs';
import { boxId, newBox, PX_PER_PT } from './boxes.mjs';
import { boxOf } from './view.js';
import { defaultLooks } from '../shapes/map.mjs';

let disarm = null; // cancels the armed tool

/** Cancels the armed pointer tool, if any. */
export const cancelPointer = () => disarm?.();

/** Arms a tool on `view`: `setup(cancel)` installs it and returns its cleanup; Esc and a new tool cancel it. */
function arm(view, setup) {
  cancelPointer();
  let cleanup = null;
  const esc = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const cancel = () => {
    window.removeEventListener('keydown', esc, true);
    cleanup?.();
    if (disarm === cancel) disarm = null;
  };
  window.addEventListener('keydown', esc, true);
  cleanup = setup(cancel);
  disarm = cancel;
  return cancel;
}

const round = (n) => Math.round(n * 10) / 10;

/** Arms Draw Text Box on `editor` (dir 'lrTb' or 'tbRl'): a crosshair layer over the page in the overlay. The box goes before the
 * top-level block under the drop point, offset from that block's corner, and the caret goes inside. */
export function drawTextBox(editor, dir = 'lrTb') {
  const view = editor.view;
  const overlay = overlayOf(view);
  if (!overlay) return false;
  arm(view, (cancel) => {
    const layer = document.createElement('div');
    layer.setAttribute('data-textbox-draw', dir);
    Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', width: `${view.dom.offsetWidth}px`, height: `${view.dom.offsetHeight}px`,
      pointerEvents: 'auto', cursor: 'crosshair', zIndex: '20' });
    const band = document.createElement('div');
    band.setAttribute('data-textbox-band', '');
    layer.append(band);
    overlay.append(layer);
    let start = null;
    const at = (e) => {
      const r = layer.getBoundingClientRect();
      const s = scaleOf(view);
      return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s, cx: e.clientX, cy: e.clientY };
    };
    const rect = (a, b, square) => {
      let w = Math.abs(b.x - a.x);
      let h = Math.abs(b.y - a.y);
      if (square) w = h = Math.max(w, h);
      const x = b.x < a.x ? a.x - w : a.x;
      const y = b.y < a.y ? a.y - h : a.y;
      return { x, y, w, h };
    };
    const down = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { layer.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has no capture */ }
      start = at(e);
    };
    const move = (e) => {
      if (!start) return;
      const r = rect(start, at(e), e.shiftKey);
      Object.assign(band.style, { display: 'block', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    };
    const up = (e) => {
      if (!start) return;
      const end = at(e);
      const r = rect(start, end, e.shiftKey);
      const click = r.w < 4 && r.h < 4;
      // The client point of the box's top-left corner, found with the layer out of the way.
      const s = scaleOf(view);
      const lr = layer.getBoundingClientRect();
      const corner = click ? { left: start.cx, top: start.cy } : { left: lr.left + r.x * s, top: lr.top + r.y * s };
      cancel();
      place(editor, { dir, corner, w: click ? 144 : round(r.w / PX_PER_PT), h: click ? 72 : round(r.h / PX_PER_PT) });
    };
    layer.addEventListener('pointerdown', down);
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    return () => layer.remove();
  });
  return true;
}

/** Inserts a drawn box of `w` x `h` pt in direction `dir` whose top-left is the client point `corner`. */
function place(editor, { dir, corner, w, h }) {
  const view = editor.view;
  const { state } = view;
  const hit = view.posAtCoords(corner);
  const $p = state.doc.resolve(hit ? hit.pos : state.selection.from);
  const at = flowPos($p, true); // in newspaper columns, the column's block under the pointer
  // Offsets from the anchor block's top-left corner (Word: horizontal from the column, vertical from the paragraph's top, its
  // space before included, as float-layout measures it).
  const block = view.nodeDOM(at);
  const s = scaleOf(view);
  const br = block?.getBoundingClientRect?.() ?? view.dom.getBoundingClientRect();
  const top = br.top - (block instanceof HTMLElement ? parseFloat(getComputedStyle(block).marginTop) || 0 : 0) * s;
  const layout = { wrap: 'front', h: { rel: 'column', offset: round((corner.left - br.left) / s / PX_PER_PT) },
    v: { rel: 'paragraph', offset: round((corner.top - top) / s / PX_PER_PT) } };
  // A drawn box takes the document's default text box look (Set as Default Text Box; Word's own until one is set).
  const json = newBox('simple', { w, h, dir, layout, ...defaultLooks(state.doc.attrs.theme).txDef });
  json.content = [{ type: 'paragraph' }];
  const tr = state.tr.insert(at, state.schema.nodeFromJSON(json));
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Whether text box `node` holds no text and no objects (Create Link's targets must be empty). */
const isEmpty = (node) => node.childCount === 1 && node.firstChild.isTextblock && node.firstChild.content.size === 0;

/** Links the box at `from` to the box at `to` in `view` → a reason it cannot, or null when linked. */
export function linkBoxes(view, from, to) {
  const { doc } = view.state;
  const a = doc.nodeAt(from);
  const b = doc.nodeAt(to);
  if (a?.type.name !== 'textBox' || b?.type.name !== 'textBox') return 'Click a text box to link to.';
  if (from === to) return 'A text box cannot link to itself.';
  if (!isEmpty(b)) return 'The next text box must be empty.';
  let taken = false;
  doc.descendants((n) => {
    if (n.type.name === 'textBox' && b.attrs.id && n.attrs.link === b.attrs.id) taken = true;
    return !taken;
  });
  if (taken) return 'That text box already follows another one.';
  if (b.attrs.link && b.attrs.link === a.attrs.id) return 'That text box already links to this one.';
  const id = b.attrs.id || boxId();
  const tr = view.state.tr;
  if (!b.attrs.id) tr.setNodeMarkup(to, null, { ...b.attrs, id });
  tr.setNodeMarkup(from, null, { ...a.attrs, id: a.attrs.id || boxId(), link: id });
  view.dispatch(tr);
  return null;
}

/** Arms Create Link from the box holding the selection in `editor`: the next press on a text box links to it. `toast(text)` says
 * why a press could not link. */
export function createLink(editor, toast) {
  const view = editor.view;
  const src = boxOf(view.state);
  if (!src) return false;
  const id = src.node.attrs.id;
  arm(view, (cancel) => {
    view.dom.setAttribute('data-textbox-linking', '');
    const down = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
      const el = e.target.closest?.('[data-textbox]');
      // The source box may have moved since arming; find it again by its id (or position when it had none).
      let from = src.pos;
      let to = null;
      view.state.doc.descendants((n, pos) => {
        if (n.type.name !== 'textBox') return true;
        if (id && n.attrs.id === id) from = pos;
        if (el && view.nodeDOM(pos) === el) to = pos;
        return true;
      });
      const why = to == null ? 'Click a text box to link to.' : linkBoxes(view, from, to);
      if (why) toast(why);
    };
    view.dom.addEventListener('mousedown', down, true);
    return () => {
      view.dom.removeAttribute('data-textbox-linking');
      view.dom.removeEventListener('mousedown', down, true);
    };
  });
  return true;
}

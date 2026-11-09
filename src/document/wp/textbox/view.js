// The text box's node view and editing rules (docs/plans/word/plan.md §3 textbox, §1.2 node views, §1.3 stories). The box's text is
// part of the main document and is edited in place: while the selection is inside a box the story is 'textbox', so Home commands
// act on its text. A click on the box's edge node-selects it and shows resize handles in the page overlay; Esc from inside does the
// same. Word allows no page, column or section break, note or nested text box inside a box, so transactions that put one there are
// refused. Hidden session editors build the same kit, so everything here checks view.dom.isConnected and the active surface.
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { clearStory, setStory } from '../../../tooling/registry.js';
import { activeSurface } from '../../../tooling/surface.js';
import { onLayoutChange, overlayOf, scaleOf } from '../../geometry.js';
import { boxCss, PX_PER_PT } from './boxes.mjs';
import { markSelection, pressEnd, pressFlow, scheduleFlow } from './flow.js';

export const textboxKey = new PluginKey('textbox');
/** Nodes Word refuses inside a text box. */
export const NOT_IN_BOX = new Set(['pageBreak', 'columnBreak', 'sectionBreak', 'noteRef', 'textBox']);

/** The innermost textBox holding resolved position `$pos` → {pos, node, depth} or null. */
export function boxAt($pos) {
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === 'textBox') return { pos: $pos.before(d), node: $pos.node(d), depth: d };
  return null;
}

/** The box the selection is on (node-selected) or in → {pos, node} or null. */
export function boxOf(state) {
  const sel = state.selection;
  if (sel.node?.type.name === 'textBox') return { pos: sel.from, node: sel.node };
  return boxAt(sel.$from);
}

/** Writes `css` (property → value, null removes) onto `el`, dropping the properties `before` set that `css` no longer has. */
function paintCss(el, css, before = {}) {
  for (const k of Object.keys(before)) if (!(k in css) || css[k] == null) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(css)) if (v != null) el.style.setProperty(k, v);
  return css;
}

class TextBoxView {
  constructor(node, view, getPos) {
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement('div');
    this.dom.setAttribute('data-textbox', '');
    this.contentDOM = document.createElement('div');
    this.contentDOM.setAttribute('data-textbox-text', '');
    // A linked story's text that the box before could not fit (flow.js draws it; CSS shows it only in a chain's later boxes).
    this.flow = document.createElement('div');
    this.flow.setAttribute('data-textbox-flow', '');
    this.flow.contentEditable = 'false';
    this.dom.append(this.contentDOM, this.flow);
    this.css = { outer: {}, inner: {} };
    this.dom.addEventListener('mousedown', this.down);
    this.update(node);
  }

  update(node) {
    if (node.type !== this.node?.type && this.node) return false;
    this.node = node;
    const { outer, inner } = boxCss(node.attrs);
    this.css = { outer: paintCss(this.dom, outer, this.css.outer), inner: paintCss(this.contentDOM, inner, this.css.inner) };
    this.dom.dataset.dir = node.attrs.dir;
    this.dom.dataset.id = node.attrs.id ?? '';
    if (node.attrs.link) this.dom.dataset.link = node.attrs.link;
    else delete this.dom.dataset.link;
    return true;
  }

  // A press on the edge (outside the content box: the border and the internal margins) node-selects the box, as Word's border
  // click does; a press inside goes to ProseMirror and puts the caret in.
  down = (e) => {
    if (e.button !== 0 || !this.view.editable) return;
    if (this.flow.contains(e.target)) {
      if (pressFlow(this.view, this.flow, e)) e.preventDefault();
      return;
    }
    const r = this.dom.getBoundingClientRect();
    const cs = getComputedStyle(this.dom);
    const s = r.width / this.dom.offsetWidth || 1;
    const edge = (side) => (parseFloat(cs[`border${side}Width`]) + parseFloat(cs[`padding${side}`])) * s;
    const inside = e.clientX > r.left + edge('Left') && e.clientX < r.right - edge('Right') && e.clientY > r.top + edge('Top') && e.clientY < r.bottom - edge('Bottom');
    // A later linked box's own text is out of sight (flow.js): a press past the story it shows goes to the story's end.
    if (inside && this.later()) {
      if (pressEnd(this.view, this.dom)) e.preventDefault();
      return;
    }
    if (inside) return;
    e.preventDefault();
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    this.view.focus();
  };

  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  // Style changes this view makes (painting, a live resize) and the flow layer's copy are not content.
  ignoreMutation(m) { return (m.type === 'attributes' && (m.target === this.dom || m.target === this.contentDOM)) || this.flow.contains(m.target); }
  later() { return this.dom.dataset.chain === 'next'; }
  // ProseMirror leaves presses on the flow layer, and every press on a later linked box, to `down`.
  stopEvent(e) { return this.flow.contains(e.target) || (e.type === 'mousedown' && this.later()); }
  destroy() { this.dom.removeEventListener('mousedown', this.down); }
}

// ---------------------------------------------------------------------------------------------
// Resize handles: eight in the page overlay round a node-selected box; Shift on a corner keeps the ratio.

const HANDLES = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
const MIN_PT = 7.2;

class Handles {
  constructor(view) {
    this.view = view;
    this.el = null;
    this.offLayout = onLayoutChange(() => this.place());
  }

  place() {
    const { view } = this;
    const sel = view.state.selection;
    const on = view.dom.isConnected && view.editable && sel.node?.type.name === 'textBox';
    if (!on) return this.hide();
    const dom = view.nodeDOM(sel.from);
    const overlay = overlayOf(view);
    if (!dom || !overlay) return this.hide();
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.setAttribute('data-textbox-handles', '');
      for (const k of Object.keys(HANDLES)) {
        const h = document.createElement('div');
        h.dataset.handle = k;
        h.addEventListener('pointerdown', (e) => this.drag(e, k));
        this.el.append(h);
      }
    }
    if (this.el.parentElement !== overlay) overlay.append(this.el);
    const s = scaleOf(view);
    const o = overlay.getBoundingClientRect();
    const r = dom.getBoundingClientRect();
    Object.assign(this.el.style, { left: `${(r.left - o.left) / s}px`, top: `${(r.top - o.top) / s}px`, width: `${r.width / s}px`, height: `${r.height / s}px` });
  }

  hide() {
    this.el?.remove();
  }

  drag(e, k) {
    e.preventDefault();
    e.stopPropagation();
    const { view } = this;
    const pos = view.state.selection.from;
    const node = view.state.doc.nodeAt(pos);
    const dom = view.nodeDOM(pos);
    if (node?.type.name !== 'textBox' || !dom) return;
    const [dx, dy] = HANDLES[k];
    const s = scaleOf(view);
    const w0 = node.attrs.w;
    const h0 = node.attrs.h;
    let size = { w: w0, h: h0 };
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has no capture */ }
    const move = (ev) => {
      let w = Math.max(MIN_PT, w0 + (dx * (ev.clientX - e.clientX)) / s / PX_PER_PT);
      let h = Math.max(MIN_PT, h0 + (dy * (ev.clientY - e.clientY)) / s / PX_PER_PT);
      if (!dx) w = w0;
      if (!dy) h = h0;
      if (ev.shiftKey && dx && dy) { // keep the ratio on the larger change
        const f = Math.max(w / w0, h / h0);
        w = w0 * f;
        h = h0 * f;
      }
      size = { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
      dom.style.width = `${size.w * PX_PER_PT}px`;
      dom.style[node.attrs.autoFit ? 'minHeight' : 'height'] = `${size.h * PX_PER_PT}px`;
      this.place();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      const now = view.state.doc.nodeAt(pos);
      if (now?.type.name !== 'textBox' || (size.w === w0 && size.h === h0)) return;
      const tr = view.state.tr.setNodeMarkup(pos, null, { ...now.attrs, ...size });
      view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  destroy() {
    this.offLayout();
    this.hide();
  }
}

// ---------------------------------------------------------------------------------------------

/** Whether `tr` puts a node Word refuses inside a text box (NOT_IN_BOX). A whole-document replace (loading a draft) passes. */
export function breaksBoxRules(tr) {
  if (!tr.docChanged) return false;
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map, i) => map.forEach((_s, _e, ns, ne) => {
    const rest = tr.mapping.slice(i + 1);
    from = Math.min(from, rest.map(ns, -1));
    to = Math.max(to, rest.map(ne, 1));
  }));
  if (from > to || (from <= 0 && to >= tr.doc.content.size)) return false;
  let bad = false;
  tr.doc.nodesBetween(Math.max(0, from), Math.min(to, tr.doc.content.size), (node, pos) => {
    if (bad) return false;
    if (NOT_IN_BOX.has(node.type.name) && boxAt(tr.doc.resolve(pos))) bad = true;
    return !bad;
  });
  return bad;
}

/** The text box behaviour: node view, story switching, Esc, the inside rules and the resize handles. */
export const TextBoxEditing = Extension.create({
  name: 'wordTextBox',
  priority: 1000, // its Esc runs before the Word keys' Cancel
  addProseMirrorPlugins() {
    const editor = this.editor;
    // The story is 'textbox' while the selection is inside a box of the open Document's main editor.
    const sync = () => {
      const surf = activeSurface();
      if (!surf || surf.editor !== editor || editor.isDestroyed || !editor.view.dom.isConnected) return;
      const sel = editor.state.selection;
      const inside = !sel.node && !!boxAt(sel.$from);
      if (inside && surf.story?.editor !== editor) setStory('textbox', editor);
      else if (!inside && surf.story?.kind === 'textbox' && surf.story.editor === editor) clearStory(editor);
    };
    // The registry clears a story when its main editor takes the focus, which here is the story's own editor: set it again after.
    const onFocus = () => queueMicrotask(sync);
    return [new Plugin({
      key: textboxKey,
      filterTransaction: (tr) => !breaksBoxRules(tr),
      props: {
        nodeViews: { textBox: (node, view, getPos) => new TextBoxView(node, view, getPos) },
        handleKeyDown(view, e) {
          if (e.key !== 'Escape' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
          const sel = view.state.selection;
          const box = !sel.node && boxAt(sel.$from);
          if (!box) return false;
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, box.pos)));
          return true;
        },
      },
      view(view) {
        const handles = new Handles(view);
        editor.on('focus', onFocus);
        queueMicrotask(sync);
        scheduleFlow(view);
        document.fonts?.ready.then(() => scheduleFlow(view)); // a late font moves the line breaks
        return {
          update(v, prev) {
            queueMicrotask(sync);
            requestAnimationFrame(() => handles.place());
            if (v.state.doc !== prev.doc) scheduleFlow(v); // linked boxes: the story's overflow goes on into the next box
            else if (!v.state.selection.eq(prev.selection)) markSelection(v); // and the caret with it
          },
          destroy() {
            editor.off('focus', onFocus);
            handles.destroy();
          },
        };
      },
    })];
  },
});

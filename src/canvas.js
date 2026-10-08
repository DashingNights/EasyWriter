// Smart canvas: a whiteboard inside a resizable picture in the document, edited in place (SPEC §6b). The document NodeView
// shows a scaled preview; edit mode draws a fixed Board whose artboard follows its content (smart artboard) over the canvas,
// at its spot and scale in the post, for a canvas node or for a canvas item on a whiteboard.
// The React chrome (src/app/components/board/CanvasBar.jsx: the canvas bar and the edit bar) follows the `canvasEditor`
// and `activeCanvas` stores. A synced canvas (`flow` attr, flowchart plan §3.9) draws and edits the library flowchart it
// names through `flowSource`, which the app's flowchart store (src/app/flows.js) fills.
import { Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { stateOf, validFlow, validSource, writeBackOk } from './flow/library.mjs';
import { Board, contentWidth, dismissOnly, drawCanvas, edgeSpeed, injectStyle, insertBoard, make, parseBoard, parseFrame, scrollParent, smartArtboard, topLevelPos, withoutScroll } from './whiteboard.js';

const DEFAULT = { w: 800, h: 450 };
const MIN_SIZE = 40; // artboard sides and display width
const MAX_SIZE = 8000;
const CORNERS = ['nw', 'ne', 'sw', 'se'];
const fit = (v, min, max) => Math.max(min, Math.min(v, max));

// .sc-editing: the page while a canvas is edited (the rest of the document dimmed and inert); .sce-art: the edited board
// over the canvas, with its artboard edge strips.
const CSS = `
.sc{position:relative;box-sizing:border-box;margin:1em 0;user-select:none;-webkit-user-select:none}
.sc:not(.sc-selected){cursor:pointer}
.sc-hint{display:none;position:absolute;inset:0;align-items:center;justify-content:center;padding:8px;text-align:center;color:#8a8ca0;font:14px/1.3 system-ui,sans-serif}
.sc.sc-empty{outline:1px dashed #8a8ca0;outline-offset:-1px}
.sc.sc-empty .sc-hint{display:flex}
.sc.sc-selected{outline:calc(2px*var(--wb-inv,1)) solid #3d99f5;outline-offset:0}
.sc-editing{position:relative}
.sc-editing .ProseMirror{opacity:.45;pointer-events:none}
.sce-art{position:absolute;transform-origin:0 0}
.sce-art>.wb.wb-fixed{outline:calc(1px*var(--wb-inv,1)) solid #3d99f5;box-shadow:0 4px 24px rgba(0,0,0,.55)}
.sce-rs{position:absolute}
.sce-rs:hover{background:rgba(61,153,245,.45)}
.sce-rs-e{left:100%;top:0;height:100%;width:calc(10px*var(--sce-inv,1));cursor:ew-resize}
.sce-rs-s{top:100%;left:0;width:100%;height:calc(10px*var(--sce-inv,1));cursor:ns-resize}
.sce-rs-se{left:100%;top:100%;width:calc(14px*var(--sce-inv,1));height:calc(14px*var(--sce-inv,1));cursor:nwse-resize}
.sc-flow{position:absolute;left:6px;top:6px;display:flex;align-items:center;gap:4px;max-width:calc(100% - 12px);box-sizing:border-box;padding:1px 7px 1px 5px;border-radius:999px;background:rgba(20,21,28,.72);color:#a3a6b8;font:11px/16px system-ui,sans-serif;white-space:nowrap;pointer-events:none}
.sc-flow svg{flex:none;width:12px;height:12px}
.sc-flow span{overflow:hidden;text-overflow:ellipsis}
.sc-flow-missing{background:rgba(224,153,82,.16);color:#e09952;outline:1px dashed #e09952;outline-offset:-1px}
`;

function injectCanvasStyle() {
  if (document.getElementById('sc-style')) return;
  document.head.append(make('style', '', { id: 'sc-style', textContent: CSS }));
}

// Items and bg validated like a whiteboard's (without canvas items: canvases do not nest); non-finite or ≤ 0 sizes
// fall back to the defaults, an invalid frame to null (the whole artboard), an invalid `flow` to null (not synced), an
// invalid `source` (the Mermaid text it was imported from) to null.
function parseCanvas(json) {
  const { bg, items } = parseBoard(json);
  let data = null;
  try {
    data = JSON.parse(json);
  } catch { /* defaults */ }
  const size = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const w = size(data?.w, DEFAULT.w);
  return {
    w, h: size(data?.h, DEFAULT.h), dw: size(data?.dw, w), frame: parseFrame(data?.frame), bg, items: items.filter((i) => i.type !== 'canvas'),
    flow: validFlow(data?.flow), source: validSource(data?.source),
  };
}

const sameBox = (a, b) => ['x', 'y', 'w', 'h'].every((k) => a[k] === b[k]);

const scaleOf = (el) => {
  const s = el.getBoundingClientRect().width / el.offsetWidth;
  return s > 0 && Number.isFinite(s) ? s : 1;
};

// The pointer-down that leaves edit mode does nothing else: its mousedown (focus, caret) and click are swallowed too.
function swallowClick() {
  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  for (const type of ['mousedown', 'click']) window.addEventListener(type, stop, { capture: true, once: true });
  window.addEventListener('pointerup', () => setTimeout(() => {
    for (const type of ['mousedown', 'click']) window.removeEventListener(type, stop, true);
  }), { capture: true, once: true });
}

// ---------------------------------------------------------------------------------------------
// Stores the React chrome follows: the canvas being edited, and the canvas the document bar serves.

let session = null; // the CanvasSession of the canvas being edited
let opened = 0; // session ids
const sessionListeners = new Set();
export const canvasEditor = {
  get: () => session,
  subscribe(fn) {
    sessionListeners.add(fn);
    return () => sessionListeners.delete(fn);
  },
};

function setSession(s) {
  session = s;
  for (const fn of sessionListeners) fn();
  emitCanvas();
}

// The document bar serves the node-selected canvas only (hovering never shows it); nothing while a canvas is being edited.
// Snapshot: {view, dw, w, h, flow}, rebuilt on change; w × h is the artboard shown (a synced canvas: the library's), flow
// {id, title, missing} or null.
let selected = null;
let canvasSnap = null;
const canvasListeners = new Set();
export const activeCanvas = {
  get: () => canvasSnap,
  subscribe(fn) {
    canvasListeners.add(fn);
    return () => canvasListeners.delete(fn);
  },
};

function emitCanvas() {
  const view = session ? null : selected;
  const f = view?.flow();
  canvasSnap = view && {
    view, dw: view.dw, w: view.artSize.w, h: view.artSize.h,
    flow: f && { id: f.id, title: flowSource.title(f.id), missing: flowSource.isMissing(f.id) },
  };
  for (const fn of canvasListeners) fn();
}

// ---------------------------------------------------------------------------------------------
// The flowchart library as this layer sees it (flowchart plan §3.9, §4): the app's store (src/app/flows.js) fills it at
// startup, so this module never imports the app layer. Unfilled, nothing is synced: synced canvases draw their cache.

const flowListeners = new Set();
export const flowSource = {
  get: () => null, // (id) → the loaded record, else null
  load: async () => null, // (id) → the record, or null (then missing); its arrival is reported through changed()
  save: () => null, // (id, board, {origin, as?, by?}) → the new rev (§3.9)
  isMissing: () => false, // (id)
  title: () => null, // (id) → the record's title as far as known
  chain: () => new Map(), // (id) → this session's writes of the record (library.mjs)
  origin: () => null, // who a document write comes from: the open draft
  open: () => {}, // (id) → the record in the library editor
  subscribe(fn) {
    flowListeners.add(fn);
    return () => flowListeners.delete(fn);
  },
  /** The store reports a change of record `id` (a write, its arrival, its removal); `by`: the view that wrote it. */
  changed(id, by = null) {
    for (const fn of flowListeners) fn(id, by);
  },
};

const BOARD_KEYS = ['w', 'h', 'frame', 'bg', 'items'];
const pickBoard = (attrs) => Object.fromEntries(BOARD_KEYS.map((k) => [k, attrs[k]]));

/** What canvas view `cv` shows: while synced and loaded its library flowchart's board, else its own attrs (the cache). */
export function liveBoard(cv) {
  const f = validFlow(cv.node.attrs.flow);
  return (f && flowSource.get(f.id)?.board) || pickBoard(cv.node.attrs);
}

/** Commits `attrs` to the canvas node of view `cv` at `pos` (its own undo step when `newGroup`). Synced, with its record
 * loaded: the library write first, then the node with the new rev and the written board as its cache, so the edit is
 * live everywhere. A cache that lagged the library is first brought up to date in an undo step of its own, so undoing the
 * edit restores the state it was made on and writes it back (§3.9). Missing: the cache only. */
export function commitSynced(cv, pos, attrs, newGroup) {
  const pm = cv.view;
  const f = validFlow(cv.node.attrs.flow);
  const record = f && !flowSource.isMissing(f.id) && flowSource.get(f.id);
  if (record) {
    const before = { rev: record.rev, board: record.board };
    const chain = flowSource.chain(f.id);
    const rev = flowSource.save(f.id, pickBoard(attrs), { origin: flowSource.origin(), by: cv });
    if (stateOf(chain, f.rev) !== stateOf(chain, before.rev)) {
      pm.dispatch(closeHistory(pm.state.tr.setNodeMarkup(pos, undefined, { ...cv.node.attrs, ...before.board, flow: { id: f.id, rev: before.rev } })));
      newGroup = true;
    }
    attrs = { ...attrs, flow: { id: f.id, rev } };
  }
  const tr = pm.state.tr.setNodeMarkup(pos, undefined, attrs);
  if (newGroup) closeHistory(tr);
  pm.dispatch(tr);
}

// The badge glyph: lucide's Workflow icon.
const WORKFLOW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>';

// ---------------------------------------------------------------------------------------------
// Document NodeView: the scaled preview. Click selects, a corner handle changes dw, double-click / Enter / Edit edits it.

class CanvasView {
  constructor({ node, view, getPos, editor }) {
    Object.assign(this, { node, view, getPos, editor, session: null, drag: null });
    injectStyle(); // .wb-handle
    injectCanvasStyle();
    this.dom = make('div', 'sc');
    this.dom.scView = this; // openCanvasEditor and the canvas bar reach the view through it
    this.art = null; // .sc-art, drawn by render()
    this.dom.append(make('div', 'sc-hint', { textContent: 'Empty canvas. Double-click to edit.' }));
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    this.dom.addEventListener('mousedown', (e) => e.preventDefault()); // no caret or native selection in the document
    this.dom.addEventListener('dblclick', (e) => !e.target.classList.contains('wb-handle') && this.open());
    this.resizeObserver = new ResizeObserver(() => this.scaleArt());
    this.resizeObserver.observe(this.dom);
    this.unsubscribe = flowSource.subscribe(this.onFlow);
    this.render();
  }

  // The library flowchart this canvas is synced with ({id, rev}), or null.
  flow() {
    return validFlow(this.node.attrs.flow);
  }

  // Draws liveBoard(): a synced canvas shows the library flowchart (its record is loaded on first sight), dw stays its own.
  render() {
    const f = this.flow();
    if (f && !flowSource.get(f.id) && !flowSource.isMissing(f.id)) flowSource.load(f.id);
    const { w, h, bg, items } = liveBoard(this);
    this.dw = this.node.attrs.dw;
    this.artSize = { w, h };
    Object.assign(this.dom.style, { width: `min(${this.dw}px, 100%)`, aspectRatio: `${w} / ${h}` });
    this.art?.remove();
    this.art = drawCanvas(this.dom, { aw: w, ah: h, bg, items }); // the same drawing as a canvas item on a whiteboard
    this.dom.classList.toggle('sc-empty', !items.length);
    this.drawBadge(f);
    this.scaleArt();
  }

  // A synced canvas's badge (§5.11; editor DOM only, never exported): the live title, or "missing" while the record is
  // gone. Hidden with the canvas while it is edited in place.
  drawBadge(f) {
    this.badge?.remove();
    this.badge = null;
    if (!f) return;
    const missing = flowSource.isMissing(f.id);
    this.badge = make('div', missing ? 'sc-flow sc-flow-missing' : 'sc-flow', { innerHTML: WORKFLOW_ICON });
    this.badge.append(make('span', '', { textContent: missing ? 'missing' : flowSource.title(f.id) ?? 'Flowchart' }));
    this.dom.append(this.badge);
  }

  // The library flowchart changed (written elsewhere, arrived, removed, renamed): redraw; an open in-place editor follows.
  // Its own writes come back through update().
  onFlow = (id, by) => {
    if (by === this || id !== this.flow()?.id) return;
    if (!this.drag) this.render();
    this.session?.sync();
    emitCanvas();
  };

  // The artboard is drawn at the display width.
  scaleArt() {
    this.art.style.transform = `scale(${this.dom.offsetWidth / this.artSize.w})`;
  }

  // Handles and the outline keep their on-screen size under the page zoom.
  refreshScale() {
    this.dom.style.setProperty('--wb-inv', String(1 / scaleOf(this.dom)));
  }

  maxWidth() {
    return contentWidth(this.view);
  }

  setDw(dw) {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, dw: Math.round(fit(dw, MIN_SIZE, this.maxWidth())) }));
  }

  remove() {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    this.view.focus();
  }

  /** Unlink (§3.9): an ordinary canvas holding the picture shown; one undo step (undo links it again). */
  unlink() {
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, ...liveBoard(this), flow: null }));
  }

  open() {
    const pos = this.getPos();
    if (typeof pos === 'number') openCanvasEditor(this.editor, pos);
  }

  // The hover hint (src/app/components/HoverHint.jsx): what a click and a double-click do; none once selected or while a
  // canvas is edited.
  hint() {
    if (session || selected === this) return null;
    if (this.flow()) return 'Click to select. Double-click to edit the flowchart.';
    const { items } = liveBoard(this);
    return items.length === 1 && items[0].type === 'image' ? 'Click to select. Double-click to edit the image.' : 'Click to select. Double-click to edit.';
  }

  onPointerDown = (e) => {
    if (e.button !== 0) return;
    const corner = CORNERS.find((c) => e.target.classList.contains(`wb-h-${c}`));
    if (!corner) {
      const pos = this.getPos();
      if (typeof pos === 'number') this.editor.commands.setNodeSelection(pos);
      this.view.focus();
      return;
    }
    this.drag = { corner, x: e.clientX, y: e.clientY, w0: this.dom.offsetWidth, scale: scaleOf(this.dom) };
    e.target.setPointerCapture(e.pointerId);
  };

  // Aspect locked: the pointer is projected onto the diagonal (west / north handles grow when dragged outward).
  // Live in the DOM, one commit on pointerup.
  onPointerMove = (e) => {
    const g = this.drag;
    if (!g) return this.refreshScale(); // the page zoom may have changed since the handles were drawn
    const { w, h } = this.artSize;
    const h0 = (g.w0 * h) / w;
    const aw = g.w0 + ((g.corner.includes('w') ? -1 : 1) * (e.clientX - g.x)) / g.scale;
    const ah = h0 + ((g.corner.includes('n') ? -1 : 1) * (e.clientY - g.y)) / g.scale;
    this.dw = Math.round(fit((g.w0 * (aw * g.w0 + ah * h0)) / (g.w0 ** 2 + h0 ** 2), MIN_SIZE, this.maxWidth()));
    this.dom.style.width = `min(${this.dw}px, 100%)`;
    this.scaleArt();
    emitCanvas(); // the bar's size label
  };

  onPointerUp = () => {
    if (!this.drag) return;
    this.drag = null;
    if (this.dw !== this.node.attrs.dw) this.setDw(this.dw);
  };

  update(node) {
    if (node.type !== this.node.type) return false;
    const was = this.flow();
    this.node = node;
    this.writeBack(was);
    if (!this.drag) this.render();
    this.session?.sync();
    emitCanvas();
    return true;
  }

  // Draft undo / redo moved `flow.rev` from x (`was`) to y without a commit of the node's own: its restored cache goes back
  // to the library when writeBackOk allows (§3.9); otherwise the view keeps showing the live library.
  writeBack(was) {
    const f = this.flow();
    const record = f && was?.id === f.id && was.rev !== f.rev && !flowSource.isMissing(f.id) && flowSource.get(f.id);
    if (!record || f.rev === record.rev) return;
    const origin = flowSource.origin();
    const held = []; // the flow.rev of every canvas of this record in the draft (this one holds y, never x)
    this.view.state.doc.descendants((n) => void (n.attrs.flow?.id === f.id && held.push(n.attrs.flow.rev)));
    if (writeBackOk(flowSource.chain(f.id), record, origin, was.rev, f.rev, held)) {
      flowSource.save(f.id, pickBoard(this.node.attrs), { origin, as: f.rev, by: this });
    }
  }

  // Everything inside is ours, except paste/drop, which must reach WhiteboardPaste's handlers.
  stopEvent(event) {
    return !['paste', 'drop', 'dragover', 'dragenter', 'dragleave'].includes(event.type);
  }

  ignoreMutation() {
    return true;
  }

  selectNode() {
    if (this.dom.classList.contains('sc-selected')) return;
    this.dom.classList.add('sc-selected');
    this.dom.append(...CORNERS.map((c) => make('div', `wb-handle wb-h-${c}`, { title: 'Drag to resize' })));
    this.refreshScale();
    selected = this;
    emitCanvas();
  }

  deselectNode() {
    this.dom.classList.remove('sc-selected');
    for (const h of this.dom.querySelectorAll(':scope > .wb-handle')) h.remove();
    if (selected === this) selected = null;
    emitCanvas();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.unsubscribe();
    this.session?.close(); // the node is gone (undo, delete, draft switch, editor remount)
    if (selected === this) selected = null;
    emitCanvas();
  }
}

// ---------------------------------------------------------------------------------------------
// What a session edits, {owner, editor, parent, attrs(), el(), commit(attrs, newGroup, at), done()}: the document canvas
// node (a synced one: the live library board, written through, §3.9), or a canvas item of a whiteboard (committed through
// that whiteboard's Board; `parent` is that board's element).
// attrs() is null once the target is gone; el() is the canvas's element in the post (edit mode draws over it);
// commit keeps the displayed size's ratio to the artboard width as edit mode began (a capped size never compounds), and
// puts a canvas item `at` the place edit mode moved it to on its whiteboard (px); done() returns focus with the canvas
// selected. owner.session is the session editing it.

function nodeTarget(cv) {
  const ratio = cv.node.attrs.dw / liveBoard(cv).w;
  return {
    owner: cv,
    editor: cv.editor,
    parent: null,
    attrs: () => ({ ...cv.node.attrs, ...liveBoard(cv) }),
    el: () => cv.dom,
    commit(attrs, newGroup) {
      const pos = cv.getPos();
      if (typeof pos !== 'number') return;
      if (attrs.w !== liveBoard(cv).w) attrs = { ...attrs, dw: Math.min(Math.round(ratio * attrs.w), contentWidth(cv.view)) };
      commitSynced(cv, pos, attrs, newGroup);
    },
    done() {
      const pos = cv.getPos();
      if (typeof pos === 'number') cv.editor.commands.setNodeSelection(pos);
      cv.view.focus();
    },
  };
}

function itemTarget(wv, id) {
  const wb = wv.board;
  const find = (items) => (wb.destroyed ? null : items.find((i) => i.id === id && i.type === 'canvas') ?? null);
  const start = find(wb.items);
  const ratio = start.w / start.aw;
  return {
    owner: wv,
    editor: wv.editor,
    parent: wb.dom,
    attrs() {
      const i = find(wb.attrs.items);
      return i && { w: i.aw, h: i.ah, frame: i.frame, bg: i.bg, items: i.items };
    },
    el: () => wb.itemEl(id),
    commit({ w, h, frame, bg, items }, newGroup, at) {
      const i = find(wb.items);
      if (!i) return;
      const bottom = i.y + i.h;
      if (w !== i.aw || h !== i.ah) {
        i.w = Math.min(Math.round(ratio * w), wb.size().w);
        i.h = Math.max(1, Math.round((i.w * h) / w));
      }
      // Moved by the artboard's growth on the left / top, so its content stayed put (clamped below).
      [i.x, i.y] = [Math.round(at.x), Math.round(at.y)];
      Object.assign(i, { aw: w, ah: h, frame, bg, items });
      wb.clampItem(i);
      wb.pushDown(i, bottom); // a taller canvas moves the items under it down instead of covering them
      wb.commit(newGroup);
    },
    done() {
      if (wb.destroyed) return;
      if (find(wb.items)) wb.select(id);
      wb.focus();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Canvas edit mode (§6b): a fixed Board (smart artboard) drawn over the canvas in the post at its spot and display scale,
// inside the page, so the main view's scrolling and zoom apply; the rest of the document is dimmed and inert, and a
// pointer-down there leaves edit mode. Every change is committed live to the target. The edit bar (<CanvasEditBar/>)
// subscribes like a store ({w, h}).

class CanvasSession {
  constructor(target) {
    injectCanvasStyle(); // a canvas item is edited without any document canvas having injected it
    this.id = ++opened;
    this.target = target;
    const editor = (this.editor = target.editor);
    const pm = editor.view;
    pm.dispatch(closeHistory(pm.state.tr)); // the canvas's first change never merges into earlier typing
    this.live = null; // artboard size while an artboard edge is dragged
    this.listeners = new Set();
    this.page = pm.dom.closest('.page');
    // Artboard px → page px: the canvas's display scale, kept while editing (a size capped to the page or whiteboard width
    // never shrinks the content on screen). Its inverse is the board's unit: item sizes show and are set in post px (§6c).
    this.k = target.el().getBoundingClientRect().width / scaleOf(this.page) / target.attrs().w;
    this.board = new Board(target.attrs(), {
      commit: (attrs, newGroup) => target.commit(attrs, newGroup, this.min && { x: this.at.x - this.min.x, y: this.at.y - this.min.y }),
      undo: () => withoutScroll(() => editor.commands.undo()),
      redo: () => withoutScroll(() => editor.commands.redo()),
      canUndo: () => !!editor.can().undo?.(),
      canRedo: () => !!editor.can().redo?.(),
      emptyClick: () => this.board.dom.focus({ preventScroll: true }),
      deleteBoard: () => {},
      shift: (dx, dy) => this.move(dx, dy),
    }, { fixed: true, unit: 1 / this.k });
    this.art = make('div', 'sce-art');
    const strips = ['e', 's', 'se'].map((edge) => {
      const el = make('div', `sce-rs sce-rs-${edge}`, { title: 'Drag to resize the artboard' });
      el.addEventListener('pointerdown', (e) => this.startResize(e, edge));
      el.addEventListener('pointermove', this.moveResize);
      el.addEventListener('pointerup', this.endResize);
      el.addEventListener('pointercancel', this.endResize);
      return el;
    });
    this.art.append(...strips, this.board.dom); // the board paints over the strips, so items' edge handles win
    // The strips keep their on-screen size: the page zoom may have changed since show().
    this.art.addEventListener('pointermove', () => this.art.style.setProperty('--sce-inv', String(1 / this.board.scale())));
    this.art.addEventListener('dragover', (e) => e.dataTransfer.types.includes('Files') && e.preventDefault());
    this.art.addEventListener('drop', this.onDrop);
    this.page.classList.add('sc-editing');
    this.page.append(this.art);
    this.place();
    this.onTransaction = () => this.board.emit(); // undo / redo availability
    editor.on('transaction', this.onTransaction);
    this.board.subscribe(() => this.emit()); // the live artboard size
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('paste', this.board.pasteEvent, true);
    window.addEventListener('pointerdown', this.onPointerDown, true);
    this.emit();
    this.board.dom.focus({ preventScroll: true });
  }

  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  emit() {
    const { w, h } = this.live ?? this.board.size();
    if (this.snap?.w !== w || this.snap?.h !== h) this.snap = { w, h };
    for (const fn of this.listeners) fn();
  }

  // The target changed (a commit coming back, undo / redo): redraw and follow its place; ends when it is gone.
  sync() {
    const attrs = this.target.attrs();
    if (!attrs) return this.close(true);
    this.board.setAttrs(attrs);
    this.place();
    this.emit();
  }

  // Over the canvas's element in the post (hidden meanwhile), at its top-left in page px (`at`). A canvas item can move up
  // to its whiteboard's top-left (`min`, see move()); a document canvas stays where it is (no min).
  place() {
    const el = this.target.el();
    el.style.visibility = 'hidden';
    const z = scaleOf(this.page);
    const p = this.page.getBoundingClientRect();
    const at = (e) => {
      const r = e.getBoundingClientRect();
      return { x: (r.left - p.left) / z, y: (r.top - p.top) / z };
    };
    this.at = at(el);
    this.min = this.target.parent && at(this.target.parent);
    this.show();
  }

  show() {
    Object.assign(this.art.style, { left: `${this.at.x}px`, top: `${this.at.y}px`, transform: `scale(${this.k})` });
    this.board.refreshScale(); // handles keep their on-screen size
    this.art.style.setProperty('--sce-inv', String(1 / this.board.scale()));
  }

  // The artboard grew or shrank on the left / top by dx, dy (artboard px; its items shifted by that): a canvas item moves
  // the other way at its scale, so its content stays put on screen, but not past its whiteboard's top-left; a document
  // canvas stays at its place in the post. → the part it could not follow (its content shifts on screen by that).
  move(dx, dy) {
    if (!this.min) return { x: dx, y: dy };
    const { at, min, k } = this;
    this.at = { x: Math.max(min.x, at.x - dx * k), y: Math.max(min.y, at.y - dy * k) };
    this.show();
    return { x: dx - (at.x - this.at.x) / k, y: dy - (at.y - this.at.y) / k };
  }

  // done: Done, the final Escape, a pointer-down outside (commit an open text edit, return focus with the canvas
  // selected); otherwise the target is gone (with the focus on the canvas: back to the document, so its keys keep working).
  close(done = false) {
    if (this.closed) return;
    this.closed = true;
    const focused = this.board.dom.contains(document.activeElement);
    if (done) this.board.finishEdit();
    this.board.destroy();
    this.editor.off('transaction', this.onTransaction);
    this.art.remove();
    this.page.classList.remove('sc-editing');
    const el = this.target.el();
    if (el) el.style.visibility = '';
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('paste', this.board.pasteEvent, true);
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    this.target.owner.session = null;
    setSession(null);
    if (done) this.target.done();
    else if (focused) queueMicrotask(() => this.editor.isDestroyed || this.editor.view.focus());
  }

  // --- artboard size ---

  // W / H inputs and the artboard edges (setArtboardSize); dw keeps its ratio to w (the target).
  setSize(w, h) {
    if (!setArtboardSize(this.board, w, h)) this.emit();
  }

  fitContent() {
    fitArtboard(this.board);
  }

  // Dragging the right edge, bottom edge or corner: live size, one commit on pointerup; the editor area scrolls near its
  // edges.
  startResize(e, edge) {
    if (e.button !== 0 || dismissOnly(e)) return; // an open popup only closes (§6c)
    e.preventDefault();
    this.board.finishEdit();
    const r = this.board.dom.getBoundingClientRect();
    const s = this.board.scale();
    const { w, h } = this.board.size();
    this.resizing = {
      edge,
      id: e.pointerId,
      grab: { x: (e.clientX - r.left) / s - w, y: (e.clientY - r.top) / s - h }, // pointer offset from the edge
      content: this.board.contentBox(),
      frame: null, // the frame the drag sets
      last: null,
    };
    e.target.setPointerCapture(e.pointerId);
  }

  moveResize = (e) => {
    const g = this.resizing;
    if (g?.id !== e.pointerId) return;
    if (!g.last) this.autoScroll(g); // the drag has begun
    g.last = { clientX: e.clientX, clientY: e.clientY };
    this.followResize(g);
  };

  followResize(g) {
    const r = this.board.dom.getBoundingClientRect();
    const s = this.board.scale();
    const { w, h } = this.board.size();
    const side = (client, start, grab) => fit(Math.round((client - start) / s - grab), MIN_SIZE, MAX_SIZE);
    g.frame = {
      x: 0,
      y: 0,
      w: g.edge.includes('e') ? side(g.last.clientX, r.left, g.grab.x) : w,
      h: g.edge.includes('s') ? side(g.last.clientY, r.top, g.grab.y) : h,
    };
    const a = smartArtboard(g.frame, null, g.content);
    this.live = { w: a.w, h: a.h };
    Object.assign(this.board.dom.style, { width: `${a.w}px`, height: `${a.h}px` });
    this.emit();
  }

  endResize = (e) => {
    const g = this.resizing;
    if (g?.id !== e.pointerId) return;
    this.resizing = null;
    this.live = null;
    if (g.frame) this.setSize(g.frame.w, g.frame.h);
  };

  autoScroll(g) {
    const area = scrollParent(this.board.dom);
    const tick = () => {
      if (this.resizing !== g || this.closed) return;
      const r = area.getBoundingClientRect();
      const { clientX: x, clientY: y } = g.last;
      const vx = edgeSpeed(r.right - x) - edgeSpeed(x - r.left);
      const vy = edgeSpeed(r.bottom - y) - edgeSpeed(y - r.top);
      if (vx || vy) {
        area.scrollBy(vx, vy);
        this.followResize(g);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // --- keys, pointer, paste, drop ---

  // Window, bubble phase: after the board's own keys (its Escape steps call preventDefault) and the chrome's. The last
  // Escape leaves edit mode; in an input (W / H) it returns to the board.
  onKeyDown = (e) => {
    if (e.defaultPrevented || e.key !== 'Escape') return;
    e.preventDefault();
    if (e.target instanceof HTMLInputElement || e.target?.isContentEditable) this.board.focus();
    else this.close(true);
  };

  // Window, capture phase: a left pointer-down in the main column outside the canvas and the board chrome leaves edit mode
  // and does nothing else. The sidebar, the status bar (zoom), dialogs, the assistant's panel and button and the browser's pane
  // and tab strip (§7j) keep working.
  onPointerDown = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.button !== 0 || !t?.closest('main') || this.art.contains(t) || t.closest('[data-board-chrome], [data-assistant-panel], [data-chat-island], [data-browser-pane], [data-browser-tabs]')) return;
    e.stopPropagation();
    swallowClick();
    this.close(true);
  };

  onDrop = (e) => {
    e.preventDefault();
    this.board.addImageFiles([...e.dataTransfer.files], this.board.pointAt(e));
  };
}

// Artboard size of a fixed board (the in-place edit bar and the flowchart library editor's header).

/** Sets fixed board `b`'s frame to {0, 0, w, h} (40…8000) and commits; the artboard still holds the content beyond it plus
 * padding (§6b smart artboard). → false when nothing was committed (not numbers, or the same frame: drawn again). */
export function setArtboardSize(b, w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
  b.finishEdit();
  const frame = { x: 0, y: 0, w: fit(Math.round(w), MIN_SIZE, MAX_SIZE), h: fit(Math.round(h), MIN_SIZE, MAX_SIZE) };
  if (sameBox(frame, b.frame)) {
    b.render(); // drops a live size
    return false;
  }
  b.frame = frame; // the commit sizes the artboard; the host updates the displayed size
  b.commit();
  return true;
}

/** Fit to content: frame = the items' bounding box, items shifted so it starts at 0,0 (the host keeps them in place on
 * screen: a canvas item moves). */
export function fitArtboard(b) {
  b.finishEdit();
  const c = b.contentBox();
  if (!c) return;
  const frame = { x: 0, y: 0, w: fit(Math.ceil(c.w), MIN_SIZE, MAX_SIZE), h: fit(Math.ceil(c.h), MIN_SIZE, MAX_SIZE) };
  if (b.items.length === 1) frame.item = b.items[0].id; // fitted to its one item: the frame follows that item
  if (!c.x && !c.y && sameBox(frame, b.frame) && frame.item === b.frame?.item) return;
  b.shiftItems(-c.x, -c.y);
  b.frame = frame;
  b.commit();
}

// One canvas is edited at a time; makeTarget() runs after the previous one closed.
function open(owner, makeTarget) {
  if (owner.session) return;
  session?.close(true);
  owner.session = new CanvasSession(makeTarget());
  setSession(owner.session);
}

/** Enters edit mode for the canvas node at `pos`. */
export function openCanvasEditor(editor, pos) {
  const cv = editor.view.nodeDOM(pos)?.scView;
  if (cv) open(cv, () => nodeTarget(cv));
}

// Enters edit mode for canvas item `id` of a whiteboard (its WhiteboardView `wv`; reached through the node's storage, so
// whiteboard.js needs no import of this module).
function openItemEditor(wv, id) {
  if (wv.board.items.some((i) => i.id === id && i.type === 'canvas')) open(wv, () => itemTarget(wv, id));
}

// ---------------------------------------------------------------------------------------------
// Node

export const Canvas = Node.create({
  name: 'canvas',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      w: { default: DEFAULT.w, rendered: false },
      h: { default: DEFAULT.h, rendered: false },
      dw: { default: DEFAULT.w, rendered: false },
      frame: { default: null, rendered: false }, // the artboard the user chose (§6b smart artboard); null: the whole artboard
      bg: { default: 'post', rendered: false },
      items: { default: [], rendered: false },
      flow: { default: null, rendered: false }, // {id, rev}: synced with that library flowchart (§3.9); the attrs above are its cache
      source: { default: null, rendered: false }, // {format: 'mermaid', text}: what it was imported from (§6d Formats)
    };
  },

  addStorage() {
    return { openItem: openItemEditor }; // the whiteboard NodeView edits its canvas items with it
  },

  parseHTML() {
    return [{ tag: 'div[data-canvas]', getAttrs: (el) => parseCanvas(el.getAttribute('data-json')) }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-canvas': '', 'data-json': JSON.stringify(node.attrs) }];
  },

  addCommands() {
    return {
      insertCanvas:
        (attrs = {}) =>
        ({ state, tr, dispatch }) => {
          const { w = DEFAULT.w, h = DEFAULT.h } = attrs;
          const node = state.schema.nodes[this.name].create({ ...attrs, dw: attrs.dw ?? w, frame: attrs.frame ?? { x: 0, y: 0, w, h } });
          if (dispatch) insertBoard(tr, topLevelPos(state.selection.$to), node);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== this.name) return false;
        openCanvasEditor(editor, sel.from);
        return true;
      },
    };
  },

  addNodeView() {
    return (props) => new CanvasView(props);
  },
});

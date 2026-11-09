// The board draft's plane (docs/plans/board/briefs/bd-api.md): Board's public surface over the engine board's store, selection
// and view, so the chrome (BoardRail, ItemRibbon, LayersPanel, BoardMenu and pool-board.js) serves a board draft with no branch
// of its own. Board (whiteboard.js) draws items as elements; this one has none: an item is a surface the worker paints and the
// selection is a React overlay, so every read is a store read in points and every write is one store.change.
import { between } from './order.mjs';
import { kOf } from '../engine/view/camera.mjs';
import { GROUP_FIT, boardMenu, planeTools, setConnTool, setShapeTool } from '../whiteboard.js';
import { align as alignBoxes, distribute as distributeBoxes, sameSize as sameBoxes } from '../flow/model.mjs';
import { turns } from '../flow/shapes.mjs';
import { boxOf, turnedBox, unionBox } from './gestures.mjs';
import { legacyOf, patchOf } from './look.mjs';
import { tools } from './tools/registry.js';

const LINE_TYPES = new Set(['shape', 'connector', 'stroke']); // what a selection of mixed line items shares (Board.GROUP_FIT's 'lines')
const ZERO = { left: 0, top: 0, right: 0, bottom: 0 };
const NO_GROUP = { hidden: true, children: [] };
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const wrap = (deg) => ((deg % 360) + 360) % 360;

/** Methods a later module brings: its own tool file's `methods`, which the registry copies onto the prototype when it loads.
 * Until then each is a no-op that changes nothing, so a chrome click on one does not fall over; canUngroup answers false so its
 * menu item shows disabled. */
// A tool module that fills one of these deletes its name from LATER when it is imported (layers.js). Only bd-clip overrides
// can(): Paste also depends on the clipboard, and a second override would hide the first module's answers.
export const LATER = {
  group: 'bd-layers', canUngroup: 'bd-layers',
  fitText: 'bd-text', // read by nothing until a package makes the shape grow with its label
  straighten: 'bd-connect', reverseConnector: 'bd-connect',
};

/** The board of `draft` as the chrome sees it: the same names and meanings as Board (whiteboard.js), over `store`, `selection`
 * and the viewport (`vp`, a function while BoardArea mounts the view). */
/** A whiteboard draft's backgrounds (whiteboard.js WB_BG): the canvas colour first, as around a Document's pages. A canvas in a
 * post keeps BG_OPTIONS, whose Page is its post's colour. */
export const BOARD_BGS = [['canvas', 'Canvas'], ['white', 'White'], ['black', 'Black']];

export class PlaneBoard {
  constructor({ store, selection, vp, surfaces, client, draft }) {
    this.bgOptions = BOARD_BGS;
    this.store = store;
    this.selection = selection;
    this.vpOf = vp; // the viewport, a getter while the area mounts it
    this.surfaces = surfaces;
    this.client = client;
    this.draft = draft;
    this.destroyed = false;
    this.kind = 'canvas';
    this.mode = null;
    this.rev = 0; // +1 per flush: the layers panel rebuilds its rows on it
    this._editing = false; // bd-text's item session sets it; a focused session adds to it
    this._listeners = new Set();
    this._frame = 0;
    this._snap = null;
    this._snapKey = '';
    this._offStore = store.subscribe(() => this._changed());
    // The chrome reads the selection's ids; a drag's preview fields, a hover or a marquee change nothing it shows. Flushing
    // the chrome for those would rebuild the layers rows on every drag frame, which a big board cannot afford.
    this._selKey = selection.ids.join('\u0000');
    this._offSelection = selection.subscribe(() => {
      const key = selection.ids.join('\u0000');
      if (key === this._selKey) return;
      this._selKey = key;
      this._changed();
    });
    // A tool module's methods join the prototype, so a later package adds a method from its own file and never edits this one.
    for (const module of tools.list()) Object.assign(PlaneBoard.prototype, module.methods ?? {});
  }

  // --- observing ---

  get vp() {
    return typeof this.vpOf === 'function' ? this.vpOf() : this.vpOf;
  }

  /** True while bd-text's item session or another focused session (a document instance) has the keys: the board's own keys
   * and presses must not reach past it. */
  get editing() {
    const session = this.vp?.focus?.session;
    return this._editing || (session != null && session !== this.client?.id);
  }

  set editing(on) {
    this._editing = !!on;
  }

  /** The viewport's root: ToolFlyout reads it for a press outside the board, and layers rows scroll it into view. */
  get dom() {
    return this.vp?.root ?? null;
  }

  /** The selection's ids as a Set (the layers panel reads it as Board's own). */
  get sel() {
    return new Set(this.selection.ids);
  }

  /** Every live item in the chrome's old form, in paint order (look.mjs legacyOf). A group or an instance has no old form and
   * is left out. */
  get items() {
    return this.store.live().map((item) => this._legacy(item.id)).filter(Boolean);
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit() {
    for (const fn of [...this._listeners]) fn();
  }

  /** Subscribers hear store, selection and tool changes, batched to one call a frame; without a frame loop (node) at once. */
  _changed() {
    if (this.destroyed) return;
    if (typeof requestAnimationFrame !== 'function') return this._flush();
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._flush();
    });
  }

  _flush() {
    if (this.destroyed) return;
    this.rev++;
    this.emit();
  }

  /** Keeps its identity until something in it changes (useSyncExternalStore), as Board.getSnapshot. */
  getSnapshot() {
    const shape = planeTools.shape;
    const line = planeTools.line;
    const conn = planeTools.conn;
    const snap = {
      kind: 'canvas',
      mode: this.mode,
      keepTool: planeTools.keep(),
      prefab: null, // prefabs are a later module's
      item: this.selected(),
      group: this._groupProps(),
      count: this.selection.ids.length,
      editing: this.editing,
      pen: { ...planeTools.pen },
      text: { ...planeTools.text },
      shape: { ...shape },
      path: { ...shape, fill: 'none', width: shape.width || 2, shape: 'path' },
      conn: { ...conn, heads: { ...conn.heads } },
      line: { ...line, heads: { ...line.heads }, free: true },
      snap: { ...planeTools.snap },
      bg: this.store.board.bg ?? 'canvas',
      // The journal holds board steps beside document steps, so its stacks, not the store's, say whether Undo does anything.
      canUndo: this.journal ? !!this.journal.canUndo() : this.store.canUndo(),
      canRedo: this.journal ? !!this.journal.canRedo() : this.store.canRedo(),
    };
    const key = JSON.stringify(snap);
    if (key !== this._snapKey) [this._snapKey, this._snap] = [key, snap];
    return this._snap;
  }

  focus() {
    this.vp?.root?.focus?.({ preventScroll: true });
  }

  /** Board's own elements: the item ribbon asks whether a press is on the board. */
  owns(node) {
    return !!node && !!this.dom?.contains?.(node);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
    this._offStore?.();
    this._offSelection?.();
    this._listeners.clear();
  }

  // --- the selection in the chrome's old form ---

  /** The one selected item, old form, or null (a group or an instance has none). */
  selected() {
    const ids = this.selection.ids;
    if (ids.length !== 1) return null;
    const legacy = this._legacy(ids[0]);
    return legacy && { ...legacy, cropped: !!this.store.get(ids[0])?.crop };
  }

  /** The selected items in z-order, old form. */
  selectedItems() {
    const sel = new Set(this.selection.ids);
    return this.store.live().filter((item) => sel.has(item.id)).map((item) => this._legacy(item.id)).filter(Boolean);
  }

  /** Board.groupProps: several selected items' common controls, or null. */
  _groupProps() {
    const items = this.selectedItems();
    if (items.length < 2) return null;
    const types = [...new Set(items.map((i) => i.type))];
    const type = types.length === 1 && GROUP_FIT[types[0]] ? types[0] : types.every((t) => LINE_TYPES.has(t)) ? 'lines' : null;
    if (!type) return null;
    const keys = type === 'lines' ? ['color', 'width', 'opacity'] : GROUP_FIT[type];
    const mixed = keys.filter((k) => items.some((i) => JSON.stringify(i[k]) !== JSON.stringify(items[0][k])));
    return { type, item: items[0], mixed };
  }

  _legacy(id) {
    const item = this.store.get(id);
    if (!item || item.gone) return null;
    const ancestors = [];
    const seen = new Set([id]);
    for (let parent = item.at?.[0]; parent != null && !seen.has(parent);) {
      const p = this.store.get(parent);
      if (!p || p.gone) break;
      ancestors.push(parent);
      seen.add(parent);
      parent = p.at?.[0];
    }
    return legacyOf(item, ancestors);
  }

  /** The selection, as Board.select: a row of the layers panel sets the scope too, which version 1 has no groups to use. */
  select(ids, _scope = null) {
    this.selection.set(ids == null ? [] : Array.isArray(ids) ? ids : [ids]);
  }

  /** The item's element: the engine board has none, so the layers panel's scroll and the ribbon fall back on itemRect. */
  itemEl() {
    return null;
  }

  hover() {
    return false;
  }

  // --- tools and the tool settings ---

  /** Whether `name` does anything yet: false for a later module's method (LATER), so the chrome shows it disabled. */
  can(name) {
    return !(name in LATER);
  }

  /** The tool modes a registered module draws (`setMode` refuses any other): what the rail may arm, read at run time. */
  modes() {
    return [...new Set(tools.list().flatMap((module) => module.modes ?? []))];
  }

  /** `mode`: null (Select) | 'shape' | 'line' | 'hand'. Arms the tool, clears the selection and gives the board the focus. A
   * mode no registered tool declares (`modes`) is refused, so the rail never shows a tool that draws nothing as active. */
  setMode(mode) {
    const next = mode ?? null;
    if (next && !tools.list().some((module) => module.modes?.includes(next))) return;
    this.mode = next;
    this.selection.clear();
    if (this.dom) this.dom.style.cursor = this.mode === 'hand' ? 'grab' : this.mode ? 'crosshair' : '';
    this.focus();
    this._changed();
  }

  /** The hand tool's drag, and the pan it moves the camera by: `dx`, `dy` in CSS px. */
  panBy(dx, dy) {
    const v = this.vp;
    if (!v) return;
    const k = kOf(v.camera.zoom);
    v.setCamera({ x: v.camera.x - dx / k, y: v.camera.y - dy / k, zoom: v.camera.zoom });
  }

  setSnap(patch) {
    planeTools.setSnap(patch);
    this._changed();
  }

  setPen(patch) {
    planeTools.setPen(patch);
    this._changed();
  }

  setTextTool(patch) {
    planeTools.setText(patch);
    this._changed();
  }

  setShapeTool(patch) {
    setShapeTool(patch);
    this._changed();
  }

  /** Curve and Freeform share the shape tool's look, as on Board. */
  setPathTool(patch) {
    setShapeTool(patch);
    this._changed();
  }

  setConnTool(patch) {
    setConnTool(patch);
    this._changed();
  }

  setLineTool(patch) {
    planeTools.setLine(patch);
    this._changed();
  }

  setKeepTool(on) {
    planeTools.setKeep(!!on);
    this._changed();
  }

  /** Line (L) and Arrow (Shift+L): the line tool with an end arrow or none. */
  armLine(arrow) {
    planeTools.setLine({ heads: { start: 'none', end: arrow ? 'arrow' : 'none' } });
    this.setMode('line');
  }

  // --- items ---

  /** A ribbon change: each selected item takes the fields its old form names, in one undo step; the tool's look follows. */
  setItem(patch = {}) {
    const ids = this.selection.ids;
    const first = this.store.get(ids[0]);
    if (!first) return;
    // A text's own look (font, size, bold, italic, colour, alignment) is its story's, which bd-text maps; the rest is the
    // item's own fields (`patchOf` drops those keys).
    if (first.type === 'text' || first.type === 'shape') this.setText?.(patch);
    this.store.change('Style', (tx) => {
      for (const id of ids) {
        const item = this.store.get(id);
        if (!item || item.gone) continue;
        const fields = patchOf(item, patch);
        if (Object.keys(fields).length) tx.patch(id, fields);
      }
    });
    this._remember(first, patch);
  }

  /** The ribbon's change is the next new item's style, as Board does; a text item's look is bd-text's. */
  _remember(item, patch) {
    const type = item.free ? 'line' : item.type;
    const keys = type === 'shape' ? ['color', 'width', 'fill', 'fillColor'] : type === 'connector' ? ['color', 'width', 'dash', 'route', 'heads', 'jump'] : type === 'line' ? ['color', 'width', 'dash'] : null;
    if (!keys) return;
    const p = Object.fromEntries(keys.filter((k) => k in patch).map((k) => [k, structuredClone(patch[k])]));
    if (!Object.keys(p).length) return;
    if (type === 'shape') setShapeTool(p);
    else if (type === 'connector') setConnTool(p);
    else planeTools.setLine(p);
  }

  /** Lock or hide the selection (or, with `all`, every item that has it): set when not every one has it, else cleared. */
  setLayer(field, all = false, ids = this.selection.ids) {
    const list = all ? this.store.live().filter((i) => i[field]).map((i) => i.id) : ids;
    const items = list.map((id) => this.store.get(id)).filter((i) => i && !i.gone);
    if (!items.length) return;
    const on = !items.every((i) => i[field]);
    this.store.change(field === 'locked' ? 'Lock' : 'Hide', (tx) => {
      for (const item of items) tx.set(item.id, field, on);
    });
    if (on) this.selection.set(this.selection.ids.filter((id) => {
      const item = this.store.get(id);
      return item && !item.gone && !item[field];
    }));
  }

  /** The board's colour: one op and one undo step, as every change is (design section 4), so it merges and syncing carries it. */
  setBg(bg) {
    this.store.change('Background', (tx) => tx.board('bg', bg));
  }

  removeItem() {
    const ids = this.selection.ids;
    if (!ids.length) return;
    this.store.change('Delete', (tx) => {
      for (const id of ids) tx.remove(id);
    });
    this.selection.clear();
  }

  // --- arranging (one undo step each), over the items in points ---

  _selected(predicate = () => true) {
    const sel = new Set(this.selection.ids);
    return this.store.live().filter((item) => sel.has(item.id) && predicate(item));
  }

  _boxes(items) {
    return items.map((item) => turnedBox(boxOf(item, this.store), item.rot ?? 0));
  }

  _arrangeBoxes(fn) {
    // A group a merge left with no live children has no box: it is skipped rather than lined up from the origin.
    const items = this._selected((i) => i.type !== 'connector' && !!boxOf(i, this.store));
    if (items.length < 2) return;
    const boxes = this._boxes(items);
    // The exact move, to 1e-6 of a point: rounding it to whole points would leave items at 40, 40.5 and 40.25 out of line.
    const moves = fn(boxes.map((b) => ({ ...b }))).map((b, k) => [r6(b.x - boxes[k].x), r6(b.y - boxes[k].y)]);
    if (moves.every(([dx, dy]) => !dx && !dy)) return;
    this.store.change('Align', (tx) => {
      items.forEach((item, k) => tx.patch(item.id, { x: r6((item.x ?? 0) + moves[k][0]), y: r6((item.y ?? 0) + moves[k][1]) }));
    });
  }

  /** left | centre | right | top | middle | bottom, onto the selection's bounds. */
  align(where) {
    this._arrangeBoxes((boxes) => alignBoxes(boxes, where));
  }

  /** 'h' | 'v': equal gaps, the outermost items stay. */
  distribute(axis) {
    this._arrangeBoxes((boxes) => distributeBoxes(boxes, axis));
  }

  /** 'w' | 'h': every selected item takes the largest one. Connectors and, for 'h', text are left out. */
  sameSize(axis) {
    const items = this._selected((i) => i.type !== 'connector' && (axis === 'w' || i.type !== 'text') && !!boxOf(i, this.store));
    if (items.length < 2) return;
    const starts = items.map((i) => ({ x: i.x ?? 0, y: i.y ?? 0, w: i.w ?? 0, h: i.h ?? 0, rot: turns(i) ? i.rot ?? 0 : 0 }));
    const boxes = sameBoxes(starts, axis);
    if (boxes.every((b, k) => b[axis] === starts[k][axis])) return;
    this.store.change('Same size', (tx) => {
      items.forEach((item, k) => tx.patch(item.id, { x: r6(boxes[k].x), y: r6(boxes[k].y), [axis]: boxes[k][axis] }));
    });
  }

  /** The selection's place among its siblings, by `at[1]`: 'front' | 'back' | 'forward' | 'backward' | {index}. */
  arrange(where, ids = this.selection.ids, _scope = null) {
    const want = new Set(ids);
    if (!want.size) return;
    const parents = new Set();
    for (const id of want) {
      const item = this.store.get(id);
      if (!item || item.gone) continue;
      parents.add(item.at?.[0] ?? null);
    }
    if (!parents.size) return;
    this.store.change('Arrange', (tx) => {
      for (const parent of parents) {
        const kids = this.store.children(parent).filter((k) => !k.gone);
        const chosen = kids.filter((k) => want.has(k.id));
        if (!chosen.length) continue;
        const sel = new Set(chosen.map((k) => k.id));
        if (typeof where === 'object' && where?.index != null) {
          const rest = kids.filter((k) => !sel.has(k.id));
          let at = Math.max(0, Math.min(where.index, rest.length));
          for (const item of chosen) {
            let key;
            try {
              key = between(rest[at - 1]?.at?.[1] ?? null, rest[at]?.at?.[1] ?? null);
            } catch {
              continue; // keys past their length: the item keeps its place
            }
            tx.set(item.id, 'at', [parent, key]);
            rest.splice(at, 0, { at: [parent, key] });
            at++;
          }
        } else if (where === 'front') {
          for (const item of chosen) tx.set(item.id, 'at', [parent, this.store.orderKey(parent, this.store.children(parent).length, tx)]);
        } else if (where === 'back') {
          for (const item of [...chosen].reverse()) tx.set(item.id, 'at', [parent, this.store.orderKey(parent, 0, tx)]);
        } else if (where === 'forward' || where === 'backward') {
          this._step(kids, sel, where === 'forward' ? 1 : -1, parent, tx);
        }
      }
    });
  }

  /** Each selected unit swaps its order key with the sibling `step` places away when that one is not selected. */
  _step(kids, sel, step, parent, tx) {
    const keys = kids.map((k) => k.at?.[1] ?? '');
    const wanted = kids.map((k, i) => (sel.has(k.id) ? i : -1)).filter((i) => i >= 0);
    const order = step > 0 ? [...wanted].reverse() : wanted;
    const moved = new Set();
    for (const i of order) {
      const j = i + step;
      if (j < 0 || j >= kids.length || sel.has(kids[j].id) || moved.has(i) || moved.has(j)) continue;
      moved.add(i).add(j);
      tx.set(kids[i].id, 'at', [parent, keys[j]]);
      tx.set(kids[j].id, 'at', [parent, keys[i]]);
    }
  }

  /** x | y: the selection mirrored across its bounds' middle, as Board.flip and pointer.js's Shift+H / Shift+V. */
  flip(axis) {
    const field = axis === 'y' ? 'flipY' : 'flipX';
    const items = this._selected();
    const union = unionBox(this._boxes(items));
    if (!union) return;
    this.store.change('Flip', (tx) => {
      for (const item of items) {
        const box = boxOf(item, this.store);
        if (!box) continue;
        const patch = { [field]: !item[field], rot: -(item.rot ?? 0) };
        if (field === 'flipX') patch.x = union.x + union.w - (box.x - union.x) - box.w;
        else patch.y = union.y + union.h - (box.y - union.y) - box.h;
        tx.patch(item.id, patch);
      }
    });
  }

  /** `by` degrees on each selected shape, image, text or stroke, wrapped to 0..360; `to` sets the angle instead. */
  rotate(by, to = null) {
    const items = this._selected(turns);
    if (!items.length) return;
    this.store.change('Rotate', (tx) => {
      for (const item of items) {
        const rot = wrap(to == null ? (item.rot ?? 0) + by : to);
        if (rot !== (item.rot ?? 0)) tx.set(item.id, 'rot', rot);
      }
    });
  }

  undo() {
    this.store.undo();
  }

  redo() {
    this.store.redo();
  }

  /** Nothing edits text on the plane until bd-text. */
  finishEdit() {
    return false;
  }

  /** Resize shape to fit text: a shape grows by default, as on Board (bd-text sets it). */
  fitsText(item) {
    return item?.autoFit ?? true;
  }

  // --- the screen: what the item ribbon and the layers panel ask for (client px) ---

  _client(point) {
    const v = this.vp;
    if (!v) return null;
    const k = kOf(v.camera.zoom);
    const r = v.root.getBoundingClientRect();
    return { x: r.left + v.root.clientLeft + (point.x - v.camera.x) * k, y: r.top + v.root.clientTop + (point.y - v.camera.y) * k };
  }

  /** The selected items' box on screen {left, top, right, bottom}: what the item ribbon keeps clear of. */
  itemRect() {
    const box = unionBox(this._boxes(this._selected()));
    if (!box) return null;
    const a = this._client({ x: box.x, y: box.y });
    const b = this._client({ x: box.x + box.w, y: box.y + box.h });
    if (!a || !b) return null;
    return { left: a.x, top: a.y, right: b.x, bottom: b.y };
  }

  /** The visible area of the board, in client px. */
  viewRect() {
    const v = this.vp;
    if (!v) return { left: 0, top: 0, right: 0, bottom: 0 };
    const r = v.root.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.left + v.root.clientWidth, bottom: r.top + v.root.clientHeight };
  }

  /** The board point at the centre of what the view shows. */
  visibleCentre() {
    const v = this.vp;
    if (!v) return { x: 0, y: 0 };
    const k = kOf(v.camera.zoom);
    return { x: v.camera.x + v.root.clientWidth / 2 / k, y: v.camera.y + v.root.clientHeight / 2 / k };
  }

  /** The ribbon's pointer anchor: the engine board has none, so the ribbon places itself against the selection's box. */
  ribbonAnchor() {
    return null;
  }

  /** ItemRibbon.chrome reads Board's selection DOM. The engine board draws its selection in React, so it answers with the
   * selection's box as one outline and no handles or group box. */
  get layer() {
    const self = this;
    return {
      querySelectorAll: (selector) => (selector === ':scope > .wb-sel' ? [{ getBoundingClientRect: () => self.itemRect() ?? ZERO }] : []),
    };
  }

  get groupEl() {
    return NO_GROUP;
  }

  // --- the board menu ---

  /** The board's right click: BoardMenu opens at `at` (client px) with this board as the one it acts on. */
  menu(e) {
    boardMenu.open(this, { x: e.clientX, y: e.clientY });
  }

  /** An open text edit's caret: none on the plane until bd-text. */
  saveRange() {
    return false;
  }

  /** The view's world size, for the chrome's size fields (an infinite board has no artboard of its own). */
  size() {
    const v = this.vp;
    if (!v) return { w: 0, h: 0 };
    const k = kOf(v.camera.zoom);
    return { w: v.root.clientWidth / k, h: v.root.clientHeight / k };
  }
}

// A later module's method, as it stands before that module lands: a no-op that changes nothing, so a chrome click on one does
// not fall over. The module's own tool file replaces it with the real one (the registry copies `methods` onto the prototype).
for (const name of Object.keys(LATER)) PlaneBoard.prototype[name] = () => false;

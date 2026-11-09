// bd-clip (docs/plans/board/briefs/bd-clip.md): copy, cut, paste, Ctrl+D duplicate and Alt+drag duplicate. The clipboard is
// module state beside whiteboard.js's itemClipboard: {token, items, box, media}, where items are stored fields with their
// original ids (cloneItems makes the new ones at paste time). The system clipboard takes the copied text items as text/plain,
// so a Document pastes text or nothing, and the token only in the data-board-clip attribute of the text/html for another board.
import { toast } from 'sonner';
import { keyIs } from '../../app/keybinds.js';
import { kOf } from '../../engine/view/camera.mjs';
import { boxOf, unionBox } from '../gestures.mjs';
import { plainOf, textStory } from '../look.mjs';
import { after, between } from '../order.mjs';
import { newId as makeId } from '../store.mjs';
import { LATER } from '../api.js';
import { tools } from './registry.js';

const TOKEN = 'daf-writer-item:'; // as whiteboard.js's item clipboard
const PASTE_GAP = 16; // points a paste from a box in view lands right and down of it
const TEXT_LIMIT = 20000; // characters of a pasted text one item takes
const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ROLES = ['textbox', 'spinbutton', 'combobox', 'slider'];
// The port names old-form connectors use, as box fractions.
const NAMES = { n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5], nw: [0, 0] };

let clipboard = null; // { token, items: [stored fields], box, media }
let repeat = null; // the last Alt+drag's {dx, dy, ids}: Ctrl+D repeats it while that selection stays
let pasteTarget = null; // the node the last paste event was dispatched at: a field keeps its own paste

const nextKey = (a) => (a == null ? between(null, null) : after(a));

/**
 * The selected items with their descendants as new stored fields: new ids (`newId()`), parents and connector ends remapped.
 * `_s` is dropped, so the copies stamp their own fields. A connector end whose item was copied points at its copy; the free
 * points gather resolved are kept. Root copies go in order above `startKey` (default: the topmost copied item), each key from
 * `keyAfter`, which defaults to stepping past the one before. `dx, dy` moves every stored point: x, y, a free end, a waypoint.
 */
export function cloneItems(items, { dx = 0, dy = 0, newId = makeId, keyAfter = nextKey, startKey } = {}) {
  const live = (items ?? []).filter((item) => item && item.type !== 'doc');
  const ids = new Map(live.map((item) => [item.id, newId()]));
  const roots = live.filter((item) => !ids.has(item.at?.[0]))
    .sort((a, b) => ((a.at?.[1] ?? '') < (b.at?.[1] ?? '') ? -1 : (a.at?.[1] ?? '') > (b.at?.[1] ?? '') ? 1 : 0));
  const top = startKey !== undefined ? startKey : (roots.at(-1)?.at?.[1] ?? null);
  let key = roots.length ? keyAfter(top) : null;
  const rootKeys = new Map();
  for (const item of roots) {
    rootKeys.set(item.id, key);
    key = keyAfter(key);
  }
  const out = [];
  for (const item of live) {
    const copy = structuredClone(item);
    delete copy._s;
    delete copy.gone;
    copy.id = ids.get(item.id);
    copy.at = ids.has(item.at?.[0]) ? [ids.get(item.at[0]), item.at?.[1]] : [null, rootKeys.get(item.id)];
    for (const k of ['x', 'y']) if (typeof copy[k] === 'number') copy[k] += k === 'x' ? dx : dy;
    if (copy.type !== 'connector') {
      out.push(copy);
      continue;
    }
    const point = (p) => (Number.isFinite(p?.x) && Number.isFinite(p?.y) ? { ...p, x: p.x + dx, y: p.y + dy } : p);
    copy.from = end(copy.from, ids, point);
    copy.to = end(copy.to, ids, point);
    if (Array.isArray(copy.points)) copy.points = copy.points.map(point);
    out.push(copy);
  }
  return out;
}

/** A connector's copied end: the copied item's new id, or the free point it is (gather turns an end outside the copy into
 * one from its item's box, so there is never a geometry guess here). */
function end(e, ids, point) {
  if (!e || typeof e !== 'object') return e;
  if (e.item == null) return point(structuredClone(e));
  return ids.has(e.item) ? { ...structuredClone(e), item: ids.get(e.item) } : structuredClone(e);
}

/** Where a paste lands: {dx, dy} from `sourceBox` to the copy. A box inside the view goes 16 pt right and down; one outside it
 * is centred in the view. */
export function pasteSpot(sourceBox, view) {
  if (!sourceBox || !view) return { dx: 0, dy: 0 };
  const inside = sourceBox.x >= view.x && sourceBox.y >= view.y
    && sourceBox.x + sourceBox.w <= view.x + view.w && sourceBox.y + sourceBox.h <= view.y + view.h;
  if (inside) return { dx: PASTE_GAP, dy: PASTE_GAP };
  return { dx: view.x + (view.w - sourceBox.w) / 2 - sourceBox.x, dy: view.y + (view.h - sourceBox.h) / 2 - sourceBox.y };
}

/** A pasted text as one item takes: the first 20,000 characters, and whether the rest was left out. */
export function capText(text) {
  const body = String(text ?? '');
  return body.length > TEXT_LIMIT ? { text: body.slice(0, TEXT_LIMIT), cut: true } : { text: body, cut: false };
}

/** Whether `node` keeps its own paste: a field, an editable, or anything in a dialog. */
export function inField(node) {
  if (!node || node.nodeType == null) return false;
  if (node.isContentEditable || FIELDS.has(node.tagName)) return true;
  const role = node.getAttribute?.('role');
  if (role && ROLES.includes(role)) return true;
  return !!node.closest?.('[role="dialog"]');
}

/** The view's world box: what pasteSpot tests and centres in. */
function viewBox(api) {
  const v = api.vp;
  if (!v) return null;
  const k = kOf(v.camera.zoom);
  return { x: v.camera.x, y: v.camera.y, w: v.root.clientWidth / k, h: v.root.clientHeight / k };
}

/** The selected items and everything inside them, as stored item copies, with the top-level ids that were taken and the
 * pictures they name. A document stays where it is (one per board) and says so; a hidden item comes only as part of a group;
 * a connector end bound outside the copy becomes a free point at its item's box. */
function gather(api) {
  const { store, selection } = api;
  const chosen = selection.ids.map((id) => store.get(id)).filter((item) => item && !item.gone);
  if (!chosen.length) return null;
  const top = [];
  let doc = false;
  for (const item of chosen) {
    if (item.type === 'doc') { doc = true; continue; }
    if (item.hidden && !store.children(item.id).length) continue;
    top.push(item.id);
  }
  if (doc) toast('A document stays where it is.');
  if (!top.length) return null;
  const items = [];
  const seen = new Set();
  const walk = (id) => {
    const item = store.get(id);
    if (!item || item.gone || seen.has(id) || item.type === 'doc') return;
    seen.add(id);
    items.push(item);
    for (const child of store.children(id)) walk(child.id);
  };
  top.forEach(walk);
  if (!items.length) return null;
  const media = {};
  for (const item of items) {
    for (const key of [item.media, item.fill?.media]) {
      if (key == null || !Object.hasOwn(store.board.media ?? {}, key)) continue;
      media[key] = store.board.media[key];
    }
  }
  // An end bound to an item the copy leaves behind becomes a free point on that item's box, which is what the copy keeps.
  const inside = new Set(items.map((item) => item.id));
  const copied = items.map((item) => {
    if (item.type !== 'connector') return item;
    const copy = { ...item };
    for (const k of ['from', 'to']) {
      const e = copy[k];
      if (!e || e.item == null || inside.has(e.item)) continue;
      const free = endPoint(store, e);
      if (free) copy[k] = free;
    }
    return copy;
  });
  const box = unionBox(top.map((id) => boxOf(store.get(id), store)));
  return { items: copied, top, media, box };
}

/** Where a connector end bound to another item sits: its box's centre, or the anchor (a box fraction or a port name). */
function endPoint(store, end) {
  const target = store.get(end.item);
  if (!target || target.gone) return null;
  const box = boxOf(target, store);
  if (!box) return null; // a group a merge left with no live children has no centre to sit an end on
  const a = Array.isArray(end.anchor) ? end.anchor : NAMES[end.anchor];
  return a ? { x: box.x + a[0] * box.w, y: box.y + a[1] * box.h } : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

const fieldsOf = (items) => items.map((item) => { const { _s, ...fields } = structuredClone(item); return fields; });
const rootIds = (fields) => fields.filter((f) => f.at?.[0] == null).map((f) => f.id);

/** The copied items go on the board in one step, `label`, their pictures joining the board's table; the copies are selected.
 * Their keys go above `startKey` (default: the topmost copied item) and under the next sibling, so a repeat never ties. */
function addCopies(api, items, media, { dx = 0, dy = 0, label, fromTop = false }) {
  const copied = new Set(items.map((item) => item.id));
  const copiedTop = items.filter((item) => !copied.has(item.at?.[0])).map((item) => item.at?.[1] ?? '').sort().at(-1) ?? null;
  const siblings = api.store.children(null).map((item) => item.at?.[1] ?? '').sort();
  const start = fromTop ? siblings.at(-1) ?? null : copiedTop;
  const next = siblings.find((key) => key > (start ?? '')) ?? null;
  const fields = cloneItems(items, { dx, dy, newId: makeId, startKey: start, keyAfter: (prev) => between(prev, next) });
  if (!fields.length) return [];
  api.store.change(label, (tx) => {
    Object.assign((api.store.board.media ??= {}), media ?? {});
    for (const field of fields) tx.create(field);
  });
  api.selection.set(rootIds(fields));
  return fields;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textOf = (items) => items.filter((item) => item.story).map((item) => plainOf(item.story)).join('\n');

/** The copied items as data-board-clip HTML, which carries the token another board recognises. */
function clipHtml(token, items) {
  const lines = textOf(items).split('\n').filter(Boolean);
  return `<div data-board-clip="${token}">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>`;
}

/** `text` as text/plain and `html` as text/html; a text-only write when the clipboard API takes no fragments. */
function writeClipboard(text, html) {
  try {
    const write = globalThis.navigator?.clipboard?.write?.bind(globalThis.navigator.clipboard);
    if (write && typeof ClipboardItem !== 'undefined') {
      write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]).catch((err) => console.warn('Clipboard write failed:', err));
    } else {
      globalThis.navigator?.clipboard?.writeText?.(text).catch?.((err) => console.warn('Clipboard write failed:', err));
    }
  } catch (err) {
    console.warn('Clipboard write failed:', err);
  }
}

/** Copy (Ctrl+C) or cut (Ctrl+X): the selection and its descendants onto the clipboard, cut removing them in one step. */
function copyItems(api, cut = false) {
  const found = gather(api);
  if (!found) return false;
  const token = TOKEN + makeId();
  clipboard = { token, items: fieldsOf(found.items), box: found.box ?? { x: 0, y: 0, w: 0, h: 0 }, media: found.media };
  writeClipboard(textOf(clipboard.items), clipHtml(token, clipboard.items));
  if (cut) {
    api.store.change('Cut', (tx) => { for (const id of found.top) tx.remove(id); });
    api.selection.clear();
  }
  return true;
}

/** Paste (Ctrl+V, and the board menu): the clipboard's items at pasteSpot, or nothing without a copy of this board's. */
function pasteItems(api) {
  if (!clipboard?.items?.length) return false;
  const spot = pasteSpot(clipboard.box, viewBox(api));
  const fields = addCopies(api, clipboard.items, clipboard.media, { ...spot, label: 'Paste', fromTop: true });
  if (!fields.length) return false;
  clipboard.box = { ...clipboard.box, x: clipboard.box.x + spot.dx, y: clipboard.box.y + spot.dy };
  return true;
}

/** Plain text as one text item at the view's centre, in one step, up to 20,000 characters. */
function pasteText(api, text) {
  const { text: body, cut } = capText(text);
  const c = api.visibleCentre();
  let id = null;
  api.store.change('Paste', (tx) => {
    id = tx.create({ type: 'text', story: textStory(body), fit: 'width', x: c.x, y: c.y, at: [null, api.store.orderKey(null, api.store.children(null).length, tx)] });
  });
  if (id) api.selection.set([id]);
  if (cut) toast('The first 20,000 characters were pasted. The rest was left out.');
  return !!id;
}

const selKey = (api) => [...api.selection.ids].sort().join();

/** Ctrl+D: the selection copied in place, or again by the last Alt+drag's offset while that same selection is in hand. */
function duplicate(api) {
  if (repeat && repeat.ids !== selKey(api)) repeat = null;
  const found = gather(api);
  if (!found) return false;
  const { dx = 0, dy = 0 } = repeat ?? {};
  const fields = addCopies(api, found.items, found.media, { dx, dy, label: 'Duplicate' });
  if (fields.length && repeat) repeat = { ...repeat, ids: selKey(api) };
  return fields.length > 0;
}

/** A paste event's data: this board's token, else another module that takes it (pictures), else plain text as a text item. */
function pasteFrom(ctx, data) {
  const api = ctx.api;
  if (!api || api.editing || inField(pasteTarget) || !data?.getData) return false;
  const html = data.getData('text/html') ?? '';
  const token = /data-board-clip="([^"]*)"/.exec(html)?.[1] ?? null;
  if (clipboard && token === clipboard.token) {
    pasteItems(api);
    return true;
  }
  // Another board's copy (a DOM board's token, or one from before this session): nothing here to take.
  if (token?.startsWith(TOKEN)) return true;
  for (const module of tools.list()) {
    if (module === clip || typeof module.paste !== 'function') continue;
    const out = module.paste.call(module, ctx, data);
    if (out != null && out !== false) return true;
  }
  const text = data.getData('text/plain') ?? '';
  return text.trim() ? pasteText(api, text) : false;
}

const clip = {
  mount(ctx) {
    const root = ctx.vp?.root;
    if (!root) return;
    const press = () => { ctx.selection.lastDrop = null; };
    const drop = (e) => { ctx.selection.lastDrop = { altKey: !!e?.altKey }; };
    const target = (e) => { pasteTarget = e.target; };
    root.addEventListener('pointerdown', press, true);
    root.addEventListener('pointerup', drop, true);
    root.addEventListener('pointercancel', drop, true);
    root.addEventListener('paste', target, true);
    return () => {
      root.removeEventListener('pointerdown', press, true);
      root.removeEventListener('pointerup', drop, true);
      root.removeEventListener('pointercancel', drop, true);
      root.removeEventListener('paste', target, true);
    };
  },

  methods: {
    /** The methods this module fills stop being a later module's; Paste is there only while the clipboard holds this board's
     * copy of something it can take (another board's token is not it). */
    can(name) {
      if (name === 'pasteItem') return !!clipboard?.items?.length;
      return !(name in LATER);
    },

    copied() {
      return !!clipboard?.items?.length;
    },

    duplicate() {
      return duplicate(this);
    },

    copyItem(cut = false) {
      return copyItems(this, !!cut);
    },

    pasteItem() {
      return pasteItems(this);
    },
  },

  /** Ctrl+C, Ctrl+X and Ctrl+D (and Ctrl+J): the board's own keys, asked before pointer.js's. Ctrl+V is the paste event. */
  keydown(ctx, e) {
    if (!ctx.api) return false;
    if (keyIs('board.copy', e)) { ctx.api.copyItem(); return true; }
    if (keyIs('board.cut', e)) { ctx.api.copyItem(true); return true; }
    if (keyIs('board.duplicate', e)) { ctx.api.duplicate(); return true; }
    return false;
  },

  /**
   * A move's drop: with Alt held, the items are copied where they were dragged and the originals stay (the stored x and y
   * were never written, so returning no fields keeps them). One step, Duplicate. Releasing the mouse before Alt, as Figma's
   * rule has it, keeps the event's altKey true at the drop.
   */
  transform(ctx, ids, { kind, delta }) {
    if (kind !== 'move') return null;
    if (!ctx.selection.lastDrop?.altKey) {
      repeat = null;
      return null;
    }
    const found = gather(ctx.api);
    ctx.selection.lastDrop = null;
    if (!found) return null;
    const dx = delta?.dx ?? 0;
    const dy = delta?.dy ?? 0;
    const fields = addCopies(ctx.api, found.items, found.media, { dx, dy, label: 'Duplicate' });
    if (fields.length && (dx || dy)) repeat = { dx, dy, ids: selKey(ctx.api) };
    return []; // the originals were never written: nothing to move
  },

  paste(ctx, data) {
    return pasteFrom(ctx, data);
  },
};

export default clip;

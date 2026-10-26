// Board: the free-form surface of image, text, stroke, shape and connector items behind canvases and the flowchart library (SPEC §6).
import { Extension } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, PluginKey, NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import { toBlob } from 'html-to-image';
import { toast } from 'sonner';
import { anchorPoint, fillable, kindOf, portNormal, portsOf, rotatePoint, rotBox, rotOf, turns } from './flow/shapes.mjs';
import {
  align as alignBoxes, arrangeItems, boundIndex, cleanConnector, cleanLayers, cloneItems, containedIn, DASHES, defaultMeasure, distribute as distributeBoxes,
  groupItems, HEADS, hitTarget, JUMPS, flipItem, LABEL_SLOTS, MAX_POINTS, moveItem, normalizeGroups, repairEnds, resizeInFrame, ROUTES,
  sameSize as sameBoxes, selectable, toggleLayer, turnItem, unbindFrom, ungroupItems, unitOf, validConnector,
} from './flow/model.mjs';
import { headPath, LABEL_PAD, nearestT, polylineHitsRect, polylinePoint, resolveConnectors } from './flow/route.mjs';
import { isMermaid } from './flow/mermaid.mjs';
import { cleanPoints, dragSegment, labelSlotAt, midHandles, OPPOSITE, pickInDirection, reverseConnector, SIDES, sideToward } from './flow/edit.mjs';
import { keyAmong, keyLabel } from './app/keybinds.js';
import { DEFAULT_PAGE_WIDTH as DEFAULT_WIDTH } from './formats.mjs';
import { SHAPE_KEYS } from './app/keys.mjs';
import { INK, inkOn, surfaceOf } from './app/commands/item-style.mjs';

export const WB_BG = { post: { dark: '#303039', light: '#ffffff' }, transparent: null, white: '#ffffff', black: '#000000' };

const FONT = 'system-ui, Helvetica, Arial, sans-serif';
// Option lists of the board chrome (src/app/components/board).
export const TEXT_SIZES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72];
export const NOTE_COLORS = [['', 'No note'], ['#fff59d', 'Yellow note'], ['#c8e6c9', 'Green note'], ['#bbdefb', 'Blue note'], ['#f8bbd0', 'Pink note']];
export const BG_OPTIONS = [['post', 'Page'], ['transparent', 'Transparent'], ['white', 'White'], ['black', 'Black']];
const MIN_ITEM = 20;
const ARTBOARD_PAD = 32; // a canvas artboard reaches this far past content beyond its frame (§6b)
const CORNERS = ['nw', 'ne', 'sw', 'se'];
const EDGES = ['n', 'e', 's', 'w']; // edge handles (§6d; text: e and w only)
const GRID = 10;
const SNAP_PX = 6; // snap threshold in screen px
const EDGE = 48; // auto-scroll zone in screen px from the scrolling area's edge
const MAX_SCROLL = 24; // auto-scroll px per frame
const FULL = { x: 0, y: 0, w: 1, h: 1 }; // uncropped
export { DEFAULT_PAGE_WIDTH as DEFAULT_WIDTH } from './formats.mjs';
const DEFAULT_ATTRS = { height: 400, base: null, bg: 'post', items: [] };
export const PEN_WIDTHS = [1, 2, 3, 4, 6, 8, 12, 16, 24];
export const PEN_STYLES = [[1, 'Pen'], [0.7, 'Marker'], [0.35, 'Highlighter']]; // [opacity, label]
const STROKE_NUMS = ['x', 'y', 'w', 'h', 'vw', 'vh', 'width', 'opacity'];
export const FILLS = [['none', 'No fill'], ['solid', 'Filled'], ['hatch', 'Hatched']];
// Tool settings (sizes in post px), shared by every board and kept across sessions: the pen (also the eraser's flyout), the
// shape tool (label size / colour once Insert flowchart set them), the defaults of a new text item (the last size, colour,
// bold and note set on a text item; colour null: by theme) and the connector tool (§6d; colour null: by theme).
const TOOLS_KEY = 'daf-writer.tools';
const pen = { color: '#e05252', width: 4, opacity: 1 };
const shapeTool = { shape: 'rect', color: '#e05252', width: 4, opacity: 1, fill: 'none', fillColor: '#e05252' };
const textTool = { size: 20, color: null, bold: false, bg: null };
const connTool = { route: 'ortho', corner: 8, heads: { start: 'none', end: 'arrow' }, color: null, width: 2, opacity: 1, dash: 'solid', jump: 'none' };
const toolSettings = { pen, shape: shapeTool, text: textTool, conn: connTool };
let keepTool = false; // Keep tool on (§6c Spawning, Q): every board, this session only
{
  // Saved values are checked like parseBoard checks items, so new items always pass it.
  const size = (v) => Number.isFinite(v) && v > 0;
  const color = (v) => typeof v === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(v); // RGBA: #rrggbbaa below full opacity
  const none = (ok) => (v) => v === null || ok(v);
  const oneOf = (list) => (v) => list.some(([k]) => k === v);
  const among = (list) => (v) => list.includes(v);
  const checks = {
    pen: { color, width: size, opacity: oneOf(PEN_STYLES) },
    shape: { shape: (v) => !!kindOf(v), color, width: size, opacity: oneOf(PEN_STYLES), fill: oneOf(FILLS), fillColor: color, size, textColor: color },
    text: { size, color: none(color), bold: (v) => typeof v === 'boolean', bg: none(color) },
    conn: { route: among(ROUTES), heads: (v) => HEADS.includes(v?.start) && HEADS.includes(v?.end), color: none(color), width: size,
      opacity: oneOf(PEN_STYLES), dash: among(DASHES), jump: among(JUMPS) },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(TOOLS_KEY));
    for (const [name, fields] of Object.entries(checks)) {
      for (const [k, ok] of Object.entries(fields)) if (ok(saved?.[name]?.[k])) toolSettings[name][k] = saved[name][k];
    }
  } catch { /* no storage: defaults */ }
}
function saveTools() {
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(toolSettings));
  } catch { /* not persisted */ }
}
const ink = () => inkOn(null, pageTheme()); // text / line colour chosen by theme at creation
// The fields a ribbon change sets on each selected item of a type when several are selected (setItems); LINE_TYPES share colour,
// width and line style.
const GROUP_FIT = {
  text: ['color', 'size', 'bold', 'align', 'bg'],
  shape: ['color', 'width', 'opacity', 'fill', 'fillColor', 'size', 'textColor', 'bold', 'align', 'valign', 'shape'],
  connector: ['color', 'width', 'opacity', 'dash', 'route', 'corner', 'heads', 'jump'],
  stroke: ['color', 'width', 'opacity'],
};
const LINE_TYPES = new Set(['shape', 'connector', 'stroke']);
const SHAPE_NUMS = ['x', 'y', 'w', 'h', 'width', 'opacity'];
const CANVAS_NUMS = ['x', 'y', 'w', 'h', 'aw', 'ah'];
const UNIT_KEYS = ['size', 'width']; // item sizes the chrome shows and sets in post px (§6c Units)
// A shape label's style where the item has none (§6d); align / valign also by kind (a frame's label sits top-left). Its colour:
// the theme's text colour for what it sits on (labelInk).
const LABEL = { size: 16, align: 'center', valign: 'middle' };
const FLEX = { left: 'flex-start', top: 'flex-start', center: 'center', middle: 'center', right: 'flex-end', bottom: 'flex-end' };
// A gesture changed an item when one of these differs (compared as JSON: ends, waypoints and labels are objects).
const CHANGE_KEYS = ['x', 'y', 'w', 'h', 'crop', 'from', 'to', 'points', 'labels', 'rot', 'mirrorX', 'mirrorY', 'flipX', 'flipY'];
// Snapping rules, shared by every board and kept across sessions.
const SNAP_KEY = 'daf-writer.snap';
const snapRules = { on: true, items: true, board: true, grid: false };
try {
  const saved = JSON.parse(localStorage.getItem(SNAP_KEY));
  for (const k of Object.keys(snapRules)) if (typeof saved?.[k] === 'boolean') snapRules[k] = saved[k];
} catch { /* no storage: defaults */ }

const newId = () => Math.random().toString(36).slice(2, 9);
const fit = (v, min, max) => Math.max(min, Math.min(v, max));
const r2 = (n) => Math.round(n * 100) / 100; // a size converted to board px (§6c Units)

// An item copied to a board of another unit: its box, text size and line width × k, so it keeps its look in post px
// (also prefabs, src/flow/prefab.mjs).
export function scaleItem(item, k) {
  const i = { ...item, x: Math.round(item.x * k), y: Math.round(item.y * k), w: Math.max(1, Math.round(item.w * k)) };
  if ('h' in item) i.h = Math.max(1, Math.round(item.h * k));
  for (const key of UNIT_KEYS) if (key in item) i[key] = r2(item[key] * k);
  if (item.type === 'connector') {
    // Free ends, waypoints and labels too (the route is redone at the paste's commit).
    const pt = (p) => ({ x: Math.round(p.x * k), y: Math.round(p.y * k) });
    const end = (e) => (typeof e.item === 'string' ? e : pt(e));
    const labels = Object.entries(item.labels ?? {}).map(([s, l]) => [s, { ...l, size: r2((l.size ?? 14) * k), dx: r2((l.dx ?? 0) * k), dy: r2((l.dy ?? 0) * k) }]);
    Object.assign(i, { from: end(item.from), to: end(item.to), points: (item.points ?? []).map(pt), labels: Object.fromEntries(labels) });
    // The tips as well: an end bound outside the pasted set becomes free at its tip (cloneItems).
    if (item.tips) i.tips = item.tips.map((t) => ({ ...t, x: t.x * k, y: t.y * k }));
  }
  return i;
}

// Copied board items, shared by all boards. The system clipboard holds only `token`, so copying anything else
// afterwards (text, a screenshot) makes Ctrl+V paste that instead of stale items.
let itemClipboard = null; // { token, items }
// Copied style (Ctrl+Shift+C / V, §6d), shared by all boards: the visual keys of one item; sizes in board px of `unit`.
const STYLE_KEYS = {
  shape: ['color', 'width', 'opacity', 'fill', 'fillColor', 'size', 'textColor', 'bold', 'align', 'valign'],
  connector: ['route', 'corner', 'heads', 'color', 'width', 'opacity', 'dash', 'jump'],
  text: ['size', 'color', 'bold', 'align', 'bg'],
  stroke: ['color', 'width', 'opacity'],
};
let styleClipboard = null; // { unit, style: {key: value}, labels: {slot: {size, textColor, bold}} }
export const styleCopied = () => !!styleClipboard;
export const itemCopied = () => !!itemClipboard; // the board menu's Paste
// Boards always go at the top level: nested in a list/table/box/quote their width would differ from the export width.
export const topLevelPos = ($p) => ($p.depth ? $p.after(1) : $p.pos);

// Insert a board and put the caret in the block after it, so typing never replaces the (otherwise node-selected) board.
export function insertBoard(tr, at, node) {
  tr.insert(at, node);
  return caretAfter(tr, at + node.nodeSize);
}

// The caret into the textblock at `after`, a new paragraph if none follows.
function caretAfter(tr, after) {
  if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, tr.doc.type.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, after + 1));
}
const pageTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function resolveBg(bg, theme) {
  const value = Object.hasOwn(WB_BG, bg) ? WB_BG[bg] : WB_BG.post;
  return value && typeof value === 'object' ? value[theme === 'light' ? 'light' : 'dark'] : value;
}
/** What board background `bg` shows in `theme` as a colour: a transparent board shows the page (the post colour). */
export const boardSurface = (bg, theme) => resolveBg(bg, theme) ?? resolveBg('post', theme);
/** The CSS custom properties a board's items read from their container: --wb-bg (connector labels mask the line with it) and
 * --wb-ink (text with no colour of its own on the board, item-style.mjs inkOn). */
export function setBoardVars(el, bg, theme) {
  el.style.setProperty('--wb-bg', resolveBg(bg, theme) ?? 'transparent');
  el.style.setProperty('--wb-ink', inkOn(boardSurface(bg, theme), theme));
}
/** Shape `item`'s label colour: its own, else the theme's text colour on its fill laid over `board` (the board's background
 * hex); null on the board (styleText's --wb-ink). */
function labelInk(item, theme, board) {
  const s = surfaceOf(item, board);
  return item.textColor ?? (s !== board ? inkOn(s, theme) : null);
}

function validItem(i) {
  if (i?.type === 'image' || i?.type === 'text') return true;
  if (i?.type === 'canvas') return CANVAS_NUMS.every((k) => Number.isFinite(i[k])) && i.aw > 0 && i.ah > 0;
  if (i?.type === 'shape') {
    // Any registry kind (src/flow/shapes.mjs, the shape list).
    return !!kindOf(i.shape) && FILLS.some(([k]) => k === i.fill) && typeof i.color === 'string' &&
      typeof i.fillColor === 'string' && SHAPE_NUMS.every((k) => Number.isFinite(i[k])) && i.w > 0 && i.h > 0;
  }
  if (i?.type === 'connector') return validConnector(i);
  if (i?.type !== 'stroke' || typeof i.d !== 'string' || typeof i.color !== 'string') return false;
  return STROKE_NUMS.every((k) => Number.isFinite(i[k])) && i.vw > 0 && i.vh > 0;
}

// A crop is the visible region as fractions of the source image.
const validCrop = (c) => ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(c?.[k])) && c.x >= 0 && c.y >= 0 && c.w > 0 && c.h > 0 &&
  c.x + c.w <= 1 + 1e-9 && c.y + c.h <= 1 + 1e-9;

// A canvas frame (§6b): {x, y, w, h[, item]} in artboard px, or null (the whole artboard) when invalid or absent. `item`:
// the id of the item the frame is bound to (it follows that item's box, e.g. the image of an image-made canvas).
export const parseFrame = (f) => {
  if (!['x', 'y', 'w', 'h'].every((k) => Number.isFinite(f?.[k])) || f.w <= 0 || f.h <= 0) return null;
  return { x: f.x, y: f.y, w: f.w, h: f.h, ...(typeof f.item === 'string' && { item: f.item }) };
};

// The smallest box ({x, y, w, h}) holding box a (null: none) and box b.
const boxUnion = (a, b) => {
  if (!a) return b;
  const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

// Multi-selection (§6c). The group box: the smallest box holding all `boxes` ({x, y, w, h}), null for none.
export const groupBox = (boxes) => boxes.reduce(boxUnion, null);

// The selection rectangle between points a and b.
export const boxBetween = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });

// Marquee hit-test: the ids of `boxes` ({id, x, y, w, h}) that box `r` touches (edges included).
export const marqueeHits = (r, boxes) => boxes.filter((b) => b.x <= r.x + r.w && r.x <= b.x + b.w && b.y <= r.y + r.h && r.y <= b.y + b.h).map((b) => b.id);

// Smart artboard (§6b): the frame (null: the whole current artboard, `size` {w, h}) extended on each side where the
// content box `c` ({x, y, w, h}, null when empty) goes past it to c's edge plus `pad`, then normalised to start at 0,0.
// → {w, h, dx, dy, frame}: its size, the shift for every item and the frame, and the shifted frame.
export function smartArtboard(frame, size, c, pad = ARTBOARD_PAD) {
  const f = frame ?? { x: 0, y: 0, w: size.w, h: size.h };
  const l = c && c.x < f.x ? Math.floor(c.x - pad) : f.x;
  const t = c && c.y < f.y ? Math.floor(c.y - pad) : f.y;
  const r = c && c.x + c.w > f.x + f.w ? Math.ceil(c.x + c.w + pad) : f.x + f.w;
  const b = c && c.y + c.h > f.y + f.h ? Math.ceil(c.y + c.h + pad) : f.y + f.h;
  return { w: r - l, h: b - t, dx: 0 - l, dy: 0 - t, frame: { ...f, x: f.x - l, y: f.y - t } }; // 0 - l: never -0
}

// Shape label fields (§6d): a value of the wrong kind is dropped (the renderer then uses LABEL / the kind's default).
const LABEL_CHECKS = {
  html: (v) => typeof v === 'string', size: (v) => Number.isFinite(v) && v > 0, textColor: (v) => typeof v === 'string',
  bold: (v) => typeof v === 'boolean', align: (v) => ['left', 'center', 'right'].includes(v), valign: (v) => ['top', 'middle', 'bottom'].includes(v),
};

// Drops an invalid crop; a canvas item gets a valid frame and bg and its own items filtered like a board's (never a canvas),
// and loses `flow` (a library link is a canvas node attr only, §6b). Connectors get their defaults; every other item's rot is
// normalised to [0, 360) (non-finite: dropped); a shape's bad label fields are dropped; a text item's non-finite `h` is dropped;
// layer fields of the wrong kind are dropped (cleanLayers, §6 Layer fields).
function cleanItem(item) {
  if (item.type === 'connector') return cleanConnector(item);
  const out = cleanFields(item);
  if (Number.isFinite(out.rot)) out.rot = ((out.rot % 360) + 360) % 360;
  else delete out.rot;
  return out;
}
function cleanFields(item) {
  if (item.type === 'canvas') {
    const items = Array.isArray(item.items) ? item.items.filter((i) => i?.type !== 'canvas' && validItem(i)).map(cleanItem) : [];
    const { flow, ...rest } = item;
    return cleanLayers({ ...rest, frame: parseFrame(item.frame), bg: Object.hasOwn(WB_BG, item.bg) ? item.bg : DEFAULT_ATTRS.bg, items: repairEnds(items) });
  }
  const out = { ...item };
  if (item.type === 'shape') for (const [k, ok] of Object.entries(LABEL_CHECKS)) if (k in out && !ok(out[k])) delete out[k];
  if (item.type === 'text' && 'h' in out && !Number.isFinite(out.h)) delete out.h;
  if (item.type === 'image' && out.crop !== undefined && !validCrop(out.crop)) delete out.crop;
  for (const k of ['mirrorX', 'mirrorY']) if (out[k] !== true || item.type === 'text') delete out[k]; // §6d flips
  if (out.fit !== true || item.type !== 'text') delete out.fit; // a text item's width fitted to its text
  return cleanLayers(out);
}

export function parseBoard(json) {
  try {
    const data = JSON.parse(json);
    return {
      height: Number.isFinite(data.height) ? data.height : DEFAULT_ATTRS.height,
      base: Number.isFinite(data.base) ? data.base : null,
      bg: Object.hasOwn(WB_BG, data.bg) ? data.bg : DEFAULT_ATTRS.bg,
      items: Array.isArray(data.items) ? repairEnds(data.items.filter(validItem).map(cleanItem)) : [],
    };
  } catch {
    return { ...DEFAULT_ATTRS, items: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// Converted whiteboards (§6b; docs/plans/canvas-merge.md §2). Pure and deterministic (no newId, no DOM): an undo history
// replays only when the doc and its history file convert alike. They never throw: they run before `new Editor`.

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A whiteboard's attrs {height, base, bg, items} → canvas attrs, shown at 1:1. `width`: the page's (formats.mjs pageOf).
export function whiteboardToCanvas(a, width) {
  const h0 = Number.isFinite(a?.height) ? a.height : DEFAULT_ATTRS.height;
  const raw = (Array.isArray(a?.items) ? a.items : []).filter(isObject);
  const bg = Object.hasOwn(WB_BG, a?.bg) ? a.bg : 'post';
  try {
    const items = flattenCanvases(raw);
    const boxes = items.filter((i) => i.type !== 'connector').map((i) => rotBox({ ...defaultMeasure(i), rot: rotOf(i) }))
      .filter((b) => Number.isFinite(b.x + b.y + b.w + b.h));
    const w = Math.max(width, Math.ceil(Math.max(0, ...boxes.map((b) => b.x + b.w))));
    const h = Math.max(h0, Math.ceil(Math.max(0, ...boxes.map((b) => b.y + b.h))));
    return { w, h, dw: Math.min(w, width), frame: { x: 0, y: 0, w, h }, bg, items, flow: null, source: null };
  } catch {
    // A malformed node still becomes a canvas, with its items as they are: dropping them would lose data.
    return { w: width, h: h0, dw: width, frame: { x: 0, y: 0, w: width, h: h0 }, bg, items: raw, flow: null, source: null };
  }
}

// Board items with each canvas item replaced, at its place in the z-order, by its own items as drawn: scaled by w / aw and
// moved to it, mirrored then turned about its centre (placeItem's order), grouped under its id (2 or more items), its hidden /
// locked copied, a white or black bg as a backing rect first. Ids and inner group ids already on the board get `-<its id>`.
// Connectors lose their route (renderers redo it); ends bound to the canvas item are freed (repairEnds). An invalid canvas
// item is dropped, as parseBoard drops it. → `items` itself when there is none, or when the input is malformed.
export function flattenCanvases(items) {
  if (!items.some((i) => i?.type === 'canvas')) return items;
  try {
    const used = new Set(items.map((i) => i?.id));
    const usedGroups = new Set(items.flatMap((i) => (Array.isArray(i?.groups) ? i.groups : [])));
    const unique = (id, set, c) => (set.has(id) ? `${id}-${c.id}`.slice(0, 32) : id);
    const out = items.flatMap((c) => {
      if (c?.type !== 'canvas') return [c];
      const k = c.w / c.aw;
      if (!(Number.isFinite(k) && k > 0)) return [];
      const inner = flattenCanvases((Array.isArray(c.items) ? c.items : []).filter(isObject));
      if (c.bg === 'white' || c.bg === 'black') {
        const fill = WB_BG[c.bg];
        inner.unshift({ id: `${c.id}-bg`, type: 'shape', shape: 'rect', x: 0, y: 0, w: c.aw, h: c.ah, color: fill, width: 0, opacity: 1, fill: 'solid', fillColor: fill });
      }
      const ids = new Map(inner.map((i) => [i.id, unique(i.id, used, c)]));
      const groups = new Map(inner.flatMap((i) => i.groups ?? []).map((g) => [g, unique(g, usedGroups, c)]));
      for (const id of ids.values()) used.add(id);
      for (const g of [...groups.values(), c.id]) usedGroups.add(g);
      const centre = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
      return inner.map((i0) => {
        // A label or text with no size renders at 16 px (LABEL; the page's font size): it gets that size so it scales by k.
        let i = (i0.type === 'shape' && 'html' in i0) || i0.type === 'text' ? { size: LABEL.size, ...i0 } : i0;
        i = moveItem(scaleItem(i, k), c.x, c.y);
        for (const axis of ['x', 'y']) if (c[`mirror${axis.toUpperCase()}`]) i = flipItem(i, centre, axis, flipField(i, axis), defaultMeasure(i).h);
        if (rotOf(c)) i = turnItem(i, centre, c.rot, defaultMeasure(i).h);
        const end = (e) => (typeof e?.item === 'string' && ids.has(e.item) ? { ...e, item: ids.get(e.item) } : e);
        if (i.type === 'connector') {
          const { d, lps, ...rest } = i;
          i = { ...rest, from: end(i.from), to: end(i.to) };
        }
        const gs = [...(i.groups ?? []).map((g) => groups.get(g)), ...(inner.length > 1 ? [c.id] : []), ...(c.groups ?? [])];
        const { groups: _, ...rest } = i;
        return { ...rest, id: ids.get(i0.id), ...(gs.length && { groups: gs }), ...(c.hidden && { hidden: true }), ...(c.locked && { locked: true }) };
      });
    });
    return repairEnds(out);
  } catch {
    return items;
  }
}

// A doc, node or history file with every whiteboard node → a canvas node and every canvas node's canvas items flattened;
// the same object when there is nothing to change (only the changed path is copied). Board items never match: none has type
// whiteboard, and a canvas item has no attrs. `width`: the page's (formats.mjs pageOf).
export function migrateBoards(v, width) {
  if (!v || typeof v !== 'object') return v;
  if (v.type === 'whiteboard') return { ...v, type: 'canvas', attrs: whiteboardToCanvas(v.attrs, width) };
  if (v.type === 'canvas' && isObject(v.attrs) && Array.isArray(v.attrs.items)) {
    const items = flattenCanvases(v.attrs.items);
    return items === v.attrs.items ? v : { ...v, attrs: { ...v.attrs, items } };
  }
  let out = v;
  for (const [k, x] of Object.entries(v)) {
    const y = migrateBoards(x, width);
    if (y === x) continue;
    if (out === v) out = Array.isArray(v) ? v.slice() : { ...v };
    out[k] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Styles: board chrome lives in one injected stylesheet; item visuals are inline (shared with the rasterizer).

// Over the rotate zones just outside a selected item's corners (§6d): a turning arrow, black on a white halo.
const ROTATE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" stroke="white" stroke-width="4"/><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4" stroke="black" stroke-width="1.6"/></svg>';
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_ICON)}") 12 12, alias`;

const CSS = `
.wb{position:relative;outline:none;box-sizing:border-box;user-select:none;-webkit-user-select:none}
.wb[data-bg="post"]{background:var(--wb-post,${WB_BG.post.dark})}
:root[data-theme="light"]{--wb-post:${WB_BG.post.light};--wb-post-ink:${INK.light}}
.wb[data-bg="white"]{background:${WB_BG.white}}
.wb[data-bg="black"]{background:${WB_BG.black}}
.wb-layer{position:absolute;inset:0;overflow:clip}
.wb.wb-grid .wb-layer{background-image:radial-gradient(circle,rgba(140,142,160,.6) 1px,transparent 1.5px);background-size:${GRID}px ${GRID}px;background-position:-${GRID / 2}px -${GRID / 2}px}
.wb-guides{position:absolute;inset:0;z-index:3;pointer-events:none}
.wb-guide{position:absolute;background:#ff4d9d}
.wb-guide-x{top:0;bottom:0;width:calc(1px*var(--wb-inv,1))}
.wb-guide-y{left:0;right:0;height:calc(1px*var(--wb-inv,1))}
.wb-item{cursor:move}
.sc-art *{pointer-events:none}
.wb-item.wb-sel,.wb-item.wb-hover{outline:calc(2px*var(--wb-inv,1)) solid var(--ui-accent);outline-offset:calc(1px*var(--wb-inv,1))}
.wb-group{position:absolute;z-index:2;pointer-events:none;outline:calc(1px*var(--wb-inv,1)) dashed var(--ui-accent);outline-offset:calc(5px*var(--wb-inv,1))}
.wb-marquee{position:absolute;box-sizing:border-box;pointer-events:none;border:calc(1px*var(--wb-inv,1)) solid var(--ui-accent);background:color-mix(in oklab,var(--ui-accent) 10%,transparent)}
.wb-stroke,.wb-shape,.wb-conn{pointer-events:none}
.wb-stroke.wb-sel,.wb-shape.wb-sel{pointer-events:auto}
.wb-layer>.wb-conn .wb-text,.wb-layer>.wb-shape>.wb-label>.wb-text{pointer-events:auto}
.wb-locked,.wb-locked *,.wb-hidden,.wb-hidden *{pointer-events:none!important}
.wb .wb-layer{--wb-ink:var(--wb-post-ink,${INK.dark})}
.wb[data-bg="post"] .wb-layer{--wb-bg:var(--wb-post,${WB_BG.post.dark})}
.wb[data-bg="white"] .wb-layer{--wb-bg:${WB_BG.white};--wb-ink:${INK.light}}
.wb[data-bg="black"] .wb-layer{--wb-bg:${WB_BG.black};--wb-ink:${INK.dark}}
.wb.wb-drawing,.wb.wb-drawing .wb-item{cursor:crosshair;touch-action:none}
.wb.wb-drawing.wb-place-text,.wb.wb-drawing.wb-place-text .wb-item{cursor:text}
.wb-text p{margin:0!important}
.wb-text[contenteditable="true"]{cursor:text;user-select:text;-webkit-user-select:text;outline:none;overflow-anchor:none}
.wb-handle{position:absolute;width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));box-sizing:border-box;background:var(--ui-accent);border:calc(2px*var(--wb-inv,1)) solid #fff;border-radius:calc(2px*var(--wb-inv,1))}
.wb-h-nw,.wb-h-ne{top:0}.wb-h-sw,.wb-h-se{top:100%}.wb-h-nw,.wb-h-sw{left:0}.wb-h-ne,.wb-h-se{left:100%}
.wb-h-nw,.wb-h-se{cursor:nwse-resize}.wb-h-ne,.wb-h-sw{cursor:nesw-resize}
.wb-h-n,.wb-h-e,.wb-h-s,.wb-h-w{width:calc(10px*var(--wb-inv,1));height:calc(10px*var(--wb-inv,1));margin:calc(-5px*var(--wb-inv,1))}
.wb-h-n{top:0;left:50%}.wb-h-s{top:100%;left:50%}.wb-h-e{top:50%;left:100%}.wb-h-w{top:50%;left:0}
.wb-h-n,.wb-h-s{cursor:ns-resize}.wb-h-e,.wb-h-w{cursor:ew-resize}
.wb-group>.wb-rot{pointer-events:auto}
.wb-tip{position:absolute;z-index:1;width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));box-sizing:border-box;border-radius:50%;background:#fff;border:calc(2px*var(--wb-inv,1)) solid var(--ui-accent);pointer-events:auto;cursor:move}
.wb-rot{position:absolute;width:calc(22px*var(--wb-inv,1));height:calc(22px*var(--wb-inv,1));cursor:${ROTATE_CURSOR}}
.wb-rot-nw,.wb-rot-ne{top:calc(-22px*var(--wb-inv,1))}.wb-rot-sw,.wb-rot-se{top:100%}.wb-rot-nw,.wb-rot-sw{left:calc(-22px*var(--wb-inv,1))}.wb-rot-ne,.wb-rot-se{left:100%}
.wb-item.wb-target{outline:calc(2px*var(--wb-inv,1)) dashed var(--ui-accent);outline-offset:calc(2px*var(--wb-inv,1))}
.wb-port,.wb-end,.wb-wp,.wb-mid,.wb-qc{position:absolute;z-index:1;box-sizing:border-box;border-style:solid;border-width:calc(2px*var(--wb-inv,1))}
.wb-port{width:calc(9px*var(--wb-inv,1));height:calc(9px*var(--wb-inv,1));margin:calc(-4.5px*var(--wb-inv,1));border-radius:50%;background:#fff;border-color:var(--ui-accent);pointer-events:none}
.wb-port.on{background:var(--ui-accent);border-color:#fff;transform:scale(1.5)}
.wb-end,.wb-wp,.wb-mid,.wb-qc{pointer-events:auto;cursor:move}
.wb-item.wb-conn:is(.wb-sel,.wb-hover){outline:none}.wb-conn:is(.wb-sel,.wb-hover)>svg{filter:drop-shadow(0 0 calc(1.5px*var(--wb-inv,1)) var(--ui-accent))}
.wb-conn.wb-sel>.wb-text{z-index:1}
.wb-end{width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));border-radius:50%;background:#fff;border-color:var(--ui-accent)}
.wb-end.bound{background:var(--ui-accent);border-color:#fff}
.wb-wp{width:calc(10px*var(--wb-inv,1));height:calc(10px*var(--wb-inv,1));margin:calc(-5px*var(--wb-inv,1));border-radius:50%;background:var(--ui-accent);border-color:#fff}
.wb-mid{width:calc(10px*var(--wb-inv,1));height:calc(10px*var(--wb-inv,1));margin:calc(-5px*var(--wb-inv,1));border-radius:calc(2px*var(--wb-inv,1));background:#fff;border-color:var(--ui-accent)}
.wb-mid.h{cursor:ns-resize}.wb-mid.v{cursor:ew-resize}
.wb-qc{width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));border-radius:50%;background:var(--ui-accent);border-color:#fff;opacity:.7;cursor:crosshair}
.wb-qc:hover{opacity:1}
.wb-qc-n,.wb-qc-s{left:50%}.wb-qc-e,.wb-qc-w{top:50%}
.wb-qc-n{top:calc(-14px*var(--wb-inv,1))}.wb-qc-s{top:calc(100% + 14px*var(--wb-inv,1))}
.wb-qc-w{left:calc(-14px*var(--wb-inv,1))}.wb-qc-e{left:calc(100% + 14px*var(--wb-inv,1))}
`;

export function injectStyle() {
  if (document.getElementById('wb-style')) return;
  const style = document.createElement('style');
  style.id = 'wb-style';
  style.textContent = CSS;
  document.head.append(style);
}

function placeItem(el, item) {
  el.style.left = `${item.x}px`;
  el.style.top = `${item.y}px`;
  el.style.width = item.type === 'text' && item.fit ? 'max-content' : `${item.w}px`; // fit: the commit stores the width
  if (item.type !== 'text') el.style.height = `${item.h}px`;
  // A mirrored item (§6d flips) mirrors its content only: its label and handles stay as they are.
  const [mx, my] = [item.mirrorX ? -1 : 1, item.mirrorY ? -1 : 1];
  const mirror = mx < 0 || my < 0 ? `scale(${mx}, ${my})` : '';
  const content = item.type === 'image' ? el.querySelector(':scope > .wb-clip') : item.type === 'stroke' || item.type === 'shape' ? el.querySelector(':scope > svg') : null;
  if (content) content.style.transform = mirror;
  // A shape or image turns about its centre, label and handles included (§6d); every renderer draws it this way.
  el.style.transform = rotOf(item) ? `rotate(${item.rot}deg)` : '';
}

// Files and agents may hold connectors that were never routed: renderers route them (O(connectors)).
const routed = (items) => (items.some((i) => i.type === 'connector' && typeof i.d !== 'string') ? resolveConnectors(items).items : items);

// A canvas's artboard (aw × ah px, unscaled: the caller sets its transform) holding its items, put first into `box` on
// the canvas's background. Draws the document canvas preview and a dragged tile's ghost.
export function drawCanvas(box, { aw, ah, bg, items }) {
  const theme = pageTheme();
  box.style.background = resolveBg(bg, theme) ?? 'none';
  const art = make('div', 'sc-art');
  art.style.cssText = `position:absolute;left:0;top:0;width:${aw}px;height:${ah}px;transform-origin:0 0;overflow:hidden;pointer-events:none`;
  setBoardVars(art, bg, theme);
  art.append(...routed(items).map((i) => itemElement(i, theme, boardSurface(bg, theme))));
  box.prepend(art);
  return art;
}

function placeCrop(img, c = FULL) {
  img.style.cssText = `position:absolute;display:block;max-width:none;width:${100 / c.w}%;height:${100 / c.h}%;` +
    `left:${(-100 * c.x) / c.w}%;top:${(-100 * c.y) / c.h}%`;
}

// Text with no colour of its own: the theme's text colour on its note colour laid over `board` (the board's background hex),
// else on the board (--wb-ink, setBoardVars).
function styleText(text, item, theme = pageTheme(), board = boardSurface('post', theme)) {
  Object.assign(text.style, {
    boxSizing: 'border-box',
    minHeight: '1.3em',
    padding: '6px 8px',
    fontFamily: FONT,
    fontSize: `${item.size}px`,
    lineHeight: '1.3',
    fontWeight: item.bold ? '700' : '400',
    fontVariantLigatures: 'none',
    color: item.color || (item.bg ? inkOn(surfaceOf({ type: 'text', bg: item.bg }, board), theme) : `var(--wb-ink,${inkOn(null, theme)})`),
    textAlign: item.align,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    background: item.bg || 'transparent',
    borderRadius: item.bg ? '4px' : '0',
    boxShadow: item.bg ? '0 2px 6px rgba(0,0,0,.25)' : 'none',
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const inkAttrs = (s) => ({ fill: 'none', stroke: s.color, 'stroke-width': s.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: s.opacity });
// The transparent hit path's width: the line's, at least 14 post px (--wb-unit: the board's unit, §6c Units).
const hitWidth = (item) => `stroke-width:max(${item.width}px, calc(14px * var(--wb-unit, 1)))`;

// Quadratic curves through the midpoints of successive points; a single point is a zero-length dot (round cap).
function smoothPath(pts) {
  const p = ({ x, y }) => `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
  if (pts.length === 1) return `M${p(pts[0])}l0 0`;
  let d = `M${p(pts[0])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${p(pts[i])} ${p({ x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 })}`;
  return `${d}L${p(pts.at(-1))}`;
}

// --- Shapes: geometry is computed in item pixels (viewBox 0 0 w h) so arrowheads and bumps never distort.

const isLineish = (s) => s === 'line' || s === 'arrow';
export { fillable } from './flow/shapes.mjs';
const arrowHead = (width) => Math.max(12, width * 3.5);
// Line/arrow boxes are padded so the stroke and arrowhead fit; endpoints sit at opposite padded corners.
const linePad = (item) => (item.shape === 'arrow' ? arrowHead(item.width) * 0.6 : item.width / 2) + 1;

/** A line's or arrow's two ends in board px ([start, end], turned with it): where its tip handles sit. */
const lineEnds = (it) => {
  const p = linePad(it);
  const [x1, x2] = it.flipX ? [it.w - p, p] : [p, it.w - p];
  const [y1, y2] = it.flipY ? [it.h - p, p] : [p, it.h - p];
  const c = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  return [[x1, y1], [x2, y2]].map(([x, y]) => rotatePoint({ x: it.x + x, y: it.y + y }, c, rotOf(it)));
};

/** Whether item `i` mirrors its content on a flip (§6d): pictures, strokes and shapes but lines and arrows (whose
 * direction turns instead); text never mirrors. */
const mirrors = (i) => ['image', 'stroke'].includes(i.type) || (i.type === 'shape' && !isLineish(i.shape));
// The flag a flip of item `i` on `axis` toggles: a line's or arrow's direction, a mirroring item's mirror, none for text.
const flipField = (i, axis) => (i.type === 'shape' && isLineish(i.shape) ? (axis === 'x' ? 'flipX' : 'flipY')
  : mirrors(i) ? (axis === 'x' ? 'mirrorX' : 'mirrorY') : null);

// A resize gone past the fixed side on x (fx) / y (fy) mirrors the item from how it started (§6d flips).
const setMirror = (item, start, fx, fy) => {
  for (const [k, f] of [['mirrorX', fx], ['mirrorY', fy]]) {
    if (!!start[k] !== !!f) item[k] = true;
    else delete item[k];
  }
};

export function shapeGeometry(item) {
  const { w, h } = item;
  const r1 = (n) => Math.round(n * 10) / 10;
  const pt = (x, y) => `${r1(x)} ${r1(y)}`;
  if (isLineish(item.shape)) {
    const p = linePad(item);
    const [x1, x2] = item.flipX ? [w - p, p] : [p, w - p];
    const [y1, y2] = item.flipY ? [h - p, p] : [p, h - p];
    if (item.shape === 'line') return { d: `M${pt(x1, y1)}L${pt(x2, y2)}` };
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
    const L = Math.min(arrowHead(item.width), len);
    const [bx, by] = [x2 - ux * L, y2 - uy * L];
    const hw = L * 0.6;
    // Shaft stops at the head's base so its round cap never pokes through the tip.
    return { d: `M${pt(x1, y1)}L${pt(bx, by)}`, head: `M${pt(x2, y2)}L${pt(bx - uy * hw, by + ux * hw)}L${pt(bx + uy * hw, by - ux * hw)}Z` };
  }
  const i = item.width / 2;
  const [l, t, rgt, b] = [i, i, w - i, h - i];
  const roundRect = (l, t, rgt, b, r, tail = '') => `M${pt(l + r, t)}H${r1(rgt - r)}A${r} ${r} 0 0 1 ${pt(rgt, t + r)}V${r1(b - r)}` +
    `A${r} ${r} 0 0 1 ${pt(rgt - r, b)}${tail}H${r1(l + r)}A${r} ${r} 0 0 1 ${pt(l, b - r)}V${r1(t + r)}A${r} ${r} 0 0 1 ${pt(l + r, t)}Z`;
  switch (item.shape) {
    case 'rect': return { d: `M${pt(l, t)}H${r1(rgt)}V${r1(b)}H${r1(l)}Z` };
    case 'round': return { d: roundRect(l, t, rgt, b, r1(Math.max(0, Math.min(w, h) * 0.18 - i))) };
    case 'ellipse': {
      const [rx, ry, cy] = [Math.max(0.5, w / 2 - i), Math.max(0.5, h / 2 - i), h / 2];
      return { d: `M${pt(w / 2 - rx, cy)}A${r1(rx)} ${r1(ry)} 0 1 0 ${pt(w / 2 + rx, cy)}A${r1(rx)} ${r1(ry)} 0 1 0 ${pt(w / 2 - rx, cy)}Z` };
    }
    case 'triangle': return { d: `M${pt(w / 2, t)}L${pt(rgt, b)}L${pt(l, b)}Z` };
    case 'star': {
      const [cx, cy, rx, ry] = [w / 2, h / 2, w / 2 - i, h / 2 - i];
      const pts = Array.from({ length: 10 }, (_, k) => {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const s = k % 2 ? 0.45 : 1;
        return pt(cx + Math.cos(a) * rx * s, cy + Math.sin(a) * ry * s);
      });
      return { d: `M${pts.join('L')}Z` };
    }
    case 'speech': {
      const bb = b - (h - 2 * i) * 0.22; // body bottom; the tail fills the rest
      const r = r1(Math.max(0, Math.min(rgt - l, bb - t) * 0.15));
      return { d: roundRect(l, t, rgt, bb, r, `H${r1(l + (rgt - l) * 0.42)}L${pt(l + (rgt - l) * 0.16, b)}L${pt(l + (rgt - l) * 0.28, bb)}`) };
    }
    case 'thought': {
      // Scalloped cloud (arcs bulging outward between points on an ellipse) plus two trailing puffs.
      const [cx, cy] = [w / 2, t + (b - t) * 0.4];
      const [ex, ey] = [(w / 2 - i) * 0.84, (b - t) * 0.4 * 0.8];
      const n = 10;
      const pts = Array.from({ length: n }, (_, k) => {
        const a = (k * 2 * Math.PI) / n;
        return [cx + Math.cos(a) * ex, cy + Math.sin(a) * ey];
      });
      let d = `M${pt(...pts[0])}`;
      for (let k = 1; k <= n; k++) {
        const [a, c] = [pts[k - 1], pts[k % n]];
        const rr = r1(Math.hypot(c[0] - a[0], c[1] - a[1]) * 0.62);
        d += `A${rr} ${rr} 0 0 1 ${pt(...c)}`;
      }
      const puff = (x, y, r) => `M${pt(x - r, y)}A${r1(r)} ${r1(r)} 0 1 0 ${pt(x + r, y)}A${r1(r)} ${r1(r)} 0 1 0 ${pt(x - r, y)}Z`;
      const m = Math.min(w, h);
      return { d: `${d}Z${puff(l + (rgt - l) * 0.24, t + (b - t) * 0.87, m * 0.055)}${puff(l + (rgt - l) * 0.12, b - m * 0.035, m * 0.035)}` };
    }
  }
  return { d: kindOf(item.shape)?.path(w, h, i).d ?? '' }; // the flowchart kinds (src/flow/shapes.mjs)
}

// Box from a drag start/end point. Shift: square shapes, or 45° steps for lines/arrows.
function shapeBox(p0, p1, shift, tool) {
  let [dx, dy] = [p1.x - p0.x, p1.y - p0.y];
  const lineish = isLineish(tool.shape);
  const pad = lineish ? linePad(tool) : 0;
  if (shift) {
    if (lineish) {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      [dx, dy] = [Math.cos(a) * len, Math.sin(a) * len];
    } else {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      [dx, dy] = [Math.sign(dx || 1) * s, Math.sign(dy || 1) * s];
    }
  }
  const x = Math.round(Math.min(p0.x, p0.x + dx) - pad);
  const y = Math.round(Math.min(p0.y, p0.y + dy) - pad);
  return { x, y, w: Math.max(1, Math.round(Math.abs(dx) + 2 * pad)), h: Math.max(1, Math.round(Math.abs(dy) + 2 * pad)), flipX: dx < 0, flipY: dy < 0 };
}

// Hatch pattern ids are unique per drawing, not per item: the same item can be drawn twice at once (a canvas's static drawing,
// hidden while it is edited, and the editing board), and url(#id) takes the first element with that id in the document.
let hatches = 0;

function shapeSvg(item) {
  const { d, head } = shapeGeometry(item);
  const svg = svgEl('svg', { width: '100%', height: '100%', viewBox: `0 0 ${item.w} ${item.h}`, preserveAspectRatio: 'none', overflow: 'visible' });
  svg.style.display = 'block';
  let fill = 'none';
  const fills = fillable(item.shape);
  if (fills && item.fill === 'solid') fill = item.fillColor;
  if (fills && item.fill === 'hatch') {
    const id = `wbh-${++hatches}`;
    const pattern = svgEl('pattern', { id, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pattern.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: item.fillColor, 'stroke-width': 1.5 }));
    const defs = svgEl('defs', {});
    defs.append(pattern);
    svg.append(defs);
    fill = `url(#${id})`;
  }
  const ink = { stroke: item.color, 'stroke-width': item.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
  const dash = kindOf(item.shape)?.dash ? { 'stroke-dasharray': `${item.width * 4} ${item.width * 3}` } : {}; // a frame
  // A filled shape is clickable inside; the wide transparent hit path makes thin outlines easy to grab.
  svg.append(svgEl('path', { d, fill, ...ink, ...dash, 'pointer-events': fill === 'none' ? 'stroke' : 'visiblePainted' }));
  if (head) svg.append(svgEl('path', { d: head, fill: item.color, stroke: item.color, 'stroke-width': 1, 'stroke-linejoin': 'round', 'pointer-events': 'visiblePainted' }));
  svg.append(svgEl('path', { d, fill: 'none', ...ink, stroke: 'transparent', style: hitWidth(item), 'pointer-events': 'stroke' }));
  svg.style.opacity = item.opacity;
  return svg;
}

// A shape's label (§6d): a box inset by the kind's labelInset (a lane: its title band) holding the text, placed by align /
// valign; it turns with the shape. Only the words take the pointer (CSS), so an empty interior stays click-through.
function shapeLabel(item, theme, board) {
  const k = kindOf(item.shape);
  const ins = k?.labelInset ?? { x: 0.08, y: 0.08 };
  const box = k?.band ? `left:8px;right:8px;top:0;height:${Math.min(k.band, item.h)}px`
    : `left:${ins.x * 100}%;right:${ins.x * 100}%;top:${ins.y * 100}%;bottom:${ins.y * 100}%`;
  const wrap = make('div', 'wb-label');
  wrap.style.cssText = `position:absolute;${box};display:flex;pointer-events:none`;
  const text = make('div', 'wb-text', { innerHTML: item.html });
  wrap.append(text);
  styleLabel(text, item, theme, board);
  return wrap;
}

// A shape label's text and its box's alignment from the shape's label fields (defaults: LABEL, the kind's align / valign).
function styleLabel(text, item, theme = pageTheme(), board = boardSurface('post', theme)) {
  const k = kindOf(item.shape);
  const [align, valign] = [item.align ?? k?.align ?? LABEL.align, item.valign ?? k?.valign ?? LABEL.valign];
  styleText(text, { size: item.size ?? LABEL.size, color: labelInk(item, theme, board), bold: !!item.bold, align, bg: null }, theme);
  Object.assign(text.style, { padding: '2px 4px', maxWidth: '100%' });
  Object.assign(text.parentElement.style, { justifyContent: FLEX[align], alignItems: FLEX[valign] });
}

// The html a label holds: '' when nothing visible was typed (an emptied contenteditable keeps a <br>).
const labelHtml = (text) => (text.textContent.trim() ? text.innerHTML : '');

// A connector (§6d): its derived shaft path in an SVG the size of its bbox, a head per end drawn at its tip, a wide
// transparent hit path (only the line takes the pointer, never the bbox), and one label per present slot centred on its
// anchor, masking the line with the board colour (--wb-bg).
function connectorParts(el, item, theme) {
  el.classList.add('wb-conn');
  if (typeof item.d !== 'string') return; // never routed (renderers route first: routed())
  const { color = '#ffffff', width = 2, opacity = 1, dash = 'solid', heads = {} } = item;
  const svg = svgEl('svg', { width: '100%', height: '100%', viewBox: `0 0 ${item.w} ${item.h}`, overflow: 'visible' });
  svg.style.cssText = `display:block;position:absolute;left:0;top:0;opacity:${opacity}`;
  const line = { fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
  const dashes = { dashed: `${width * 4} ${width * 3}`, dotted: `0.1 ${width * 2.5}` }[dash];
  svg.append(svgEl('path', { d: item.d, ...line, ...(dashes && { 'stroke-dasharray': dashes }) }));
  [heads.start ?? 'none', heads.end ?? 'arrow'].forEach((kind, k) => {
    const { d, fill } = headPath(kind, item.tips[k], width);
    if (d) svg.append(svgEl('path', { d, ...line, ...(fill && { fill: color, 'stroke-width': 1 }) }));
  });
  svg.append(svgEl('path', { d: item.d, ...line, stroke: 'transparent', style: hitWidth({ width }), 'pointer-events': 'stroke' }));
  el.append(svg);
  for (const [slot, l] of Object.entries(item.labels ?? {})) {
    const p = item.lps?.[slot];
    if (!p) continue;
    const text = make('div', 'wb-text', { innerHTML: l.html });
    text.dataset.slot = slot;
    styleText(text, { size: l.size ?? 14, color: l.textColor, bold: !!l.bold, align: 'center', bg: null }, theme);
    Object.assign(text.style, {
      position: 'absolute', left: `${p.x}px`, top: `${p.y}px`, transform: 'translate(-50%, -50%)', whiteSpace: 'pre',
      padding: `${LABEL_PAD.y}px ${LABEL_PAD.x}px`, background: 'var(--wb-bg, transparent)',
    });
    el.append(text);
  }
}

/** Item `item` drawn in `theme` (the page theme by default; a rasterized board's own) on `board` (its background hex). */
export function itemElement(item, theme = pageTheme(), board = boardSurface('post', theme)) {
  const el = document.createElement('div');
  el.className = 'wb-item';
  el.dataset.id = item.id;
  el.style.position = 'absolute';
  el.style.boxSizing = 'border-box';
  if (item.type === 'image') {
    // The clip box shows the crop region; the picture inside is scaled up by 1 / crop size and offset by the crop origin.
    const clip = document.createElement('div');
    clip.className = 'wb-clip';
    clip.style.cssText = 'position:absolute;inset:0;overflow:hidden';
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = '';
    img.draggable = false;
    placeCrop(img, item.crop);
    clip.append(img);
    el.append(clip);
  } else if (item.type === 'stroke') {
    // The container ignores the pointer (CSS .wb-stroke) so its bounding box never covers items below; the
    // transparent, wider hit path makes the line itself clickable and erasable.
    el.classList.add('wb-stroke');
    const svg = svgEl('svg', { width: '100%', height: '100%', viewBox: `0 0 ${item.vw} ${item.vh}`, preserveAspectRatio: 'none', overflow: 'visible' });
    svg.style.display = 'block';
    const shape = { d: item.d, 'vector-effect': 'non-scaling-stroke' }; // a stretched stroke keeps its line width
    svg.append(
      svgEl('path', { ...inkAttrs(item), ...shape }),
      svgEl('path', { ...inkAttrs(item), ...shape, stroke: 'transparent', style: hitWidth(item), 'pointer-events': 'stroke' }),
    );
    el.append(svg);
  } else if (item.type === 'shape') {
    el.classList.add('wb-shape');
    el.append(shapeSvg(item));
    if (item.html) el.append(shapeLabel(item, theme, board));
  } else if (item.type === 'connector') {
    connectorParts(el, item, theme);
  } else {
    const text = document.createElement('div');
    text.className = 'wb-text';
    text.innerHTML = item.html;
    styleText(text, item, theme, board);
    el.append(text);
  }
  placeItem(el, item);
  // §6 Layer fields: hidden still lays out (text is measured, the board's size counts it), so not display:none.
  // The class also drops the pointer: hit paths with pointer-events:stroke ignore visibility.
  if (item.hidden) {
    el.style.visibility = 'hidden';
    el.classList.add('wb-hidden');
  }
  if (item.locked) el.classList.add('wb-locked');
  return el;
}

export function make(tag, className, props = {}) {
  const el = Object.assign(document.createElement(tag), props);
  if (className) el.className = className;
  return el;
}

// ---------------------------------------------------------------------------------------------
// Image files → board items (shared by paste, drop, the toolbar Image button and the rail's Image button).

function imageFiles(data) {
  return [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

// A video or GIF goes into the page as a media node (extensions.js Media), kept as it is, so it is capped at one core limit
// (the forum's attachment limit, SPEC §1, is the same).
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const isMedia = (f) => f.type.startsWith('video/') || f.type === 'image/gif';
const postFiles = (data) => [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));

const dataUrlOf = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

async function readMedia(file) {
  if (file.size > MAX_MEDIA_BYTES) {
    toast(`${file.name} is over 100 MB`);
    return null;
  }
  return { media: true, src: await dataUrlOf(file), name: file.name };
}

// The items of the smart canvases and whiteboards in copied document HTML, converted to a board of `unit` so they keep
// their look in post px (§6c Units; a canvas's unit is w / dw, a whiteboard's 1). A whiteboard's canvas items come flattened
// (§6b Converted whiteboards).
function copiedBoardItems(html, unit) {
  if (!html?.includes('data-json')) return [];
  const blocks = new DOMParser().parseFromString(html, 'text/html').querySelectorAll('div[data-canvas], div[data-whiteboard]');
  return [...blocks].flatMap((el) => {
    const json = el.getAttribute('data-json');
    let from = 1;
    try {
      const { w, dw } = JSON.parse(json);
      if (el.hasAttribute('data-canvas') && w > 0 && dw > 0) from = w / dw;
    } catch { /* parseBoard gives no items */ }
    return flattenCanvases(parseBoard(json).items).map((i) => scaleItem(i, unit / from));
  });
}

async function readImage(file) {
  try {
    const src = await dataUrlOf(file);
    const img = new Image();
    img.src = src;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('image has no size');
    return { src, w: img.naturalWidth, h: img.naturalHeight };
  } catch (err) {
    console.warn(`Skipped unreadable image "${file.name}":`, err);
    return null;
  }
}

export function contentWidth(view) {
  const cs = getComputedStyle(view.dom);
  return view.dom.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) || DEFAULT_WIDTH;
}

function scaled(img, maxW, maxH = Infinity) {
  const s = Math.min(1, maxW / img.w, maxH / img.h);
  return { w: Math.max(1, Math.round(img.w * s)), h: Math.max(1, Math.round(img.h * s)) };
}

function localPoint(wb, event) {
  const rect = wb.getBoundingClientRect();
  const scale = rect.width / wb.offsetWidth || 1;
  return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
}

// One new smart canvas (§6b) per image at `insertPos` or the selection (after a node-selected canvas): artboard = the
// image's natural size (≤ 8000 px), the image at 0,0, displayed at most as wide as the page content. A video or GIF is a
// media node instead.
async function addImages(view, files, insertPos = null) {
  if (view.state.schema.nodes.image) return addPictures(view, files, insertPos);
  const images = (await Promise.all(files.map((f) => (isMedia(f) ? readMedia(f) : readImage(f))))).filter(Boolean);
  if (!images.length || view.isDestroyed) return;
  const { state } = view;
  const width = contentWidth(view);
  const nodes = images.map((img) => {
    if (img.media) return state.schema.nodes.media.create({ src: img.src, name: img.name });
    const { w, h } = scaled(img, 8000, 8000);
    const items = [{ id: newId(), type: 'image', src: img.src, x: 0, y: 0, w, h }];
    return state.schema.nodes.canvas.create({ w, h, dw: Math.min(w, width), frame: { x: 0, y: 0, w, h, item: items[0].id }, bg: 'post', items });
  });
  const $p = insertPos !== null ? state.doc.resolve(Math.min(insertPos, state.doc.content.size)) : state.selection.$to;
  let at = topLevelPos($p);
  const tr = state.tr;
  for (const node of nodes.slice(0, -1)) {
    tr.insert(at, node);
    at += node.nodeSize;
  }
  view.dispatch(insertBoard(tr, at, nodes.at(-1)).scrollIntoView());
}

// A Document's pictures (only its schema has the image node): inline image nodes at `insertPos` or the selection (after a
// node-selected block), at most the text width wide (docs/plans/document.md Pictures). Word holds no video.
async function addPictures(view, files, insertPos) {
  const videos = files.filter((f) => f.type.startsWith('video/'));
  if (videos.length) toast(videos.length === 1 ? `${videos[0].name} is a video. A document holds pictures only.` : 'A document holds pictures only.');
  const images = (await Promise.all(files.filter((f) => !videos.includes(f)).map(readImage))).filter(Boolean);
  if (!images.length || view.isDestroyed) return;
  const { state } = view;
  const width = contentWidth(view);
  const nodes = images.map((img) => state.schema.nodes.image.create({ src: img.src, ...pictureSize(img, width) }));
  const tr = state.tr;
  const at = insertPos !== null ? Math.min(insertPos, tr.doc.content.size) : tr.selection instanceof NodeSelection ? tr.selection.to : null;
  if (at !== null) { // a caret in text: never a node selection, which the pictures would replace
    const $p = tr.doc.resolve(at);
    tr.setSelection($p.parent.inlineContent ? TextSelection.create(tr.doc, at) : Selection.findFrom($p, 1, true) ?? Selection.findFrom($p, -1, true));
  }
  view.dispatch(tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0)).scrollIntoView());
}

/** A picture's {width, height} in px: its natural size {w, h}, at most `maxW` wide. */
export function pictureSize(img, maxW) {
  const { w, h } = scaled(img, maxW);
  return { width: w, height: h };
}

export function addImageFilesToEditor(editor, files) {
  const list = postFiles({ files });
  if (!list.length) return Promise.resolve();
  return addImages(editor.view, list);
}

// Undo / redo started from a board (also a canvas being edited) must not scroll the document to its text selection, which can be
// anywhere (often the last line typed): the change being undone is on the board the user is looking at.
let quietScroll = false;
export function withoutScroll(fn) {
  quietScroll = true;
  try {
    return fn();
  } finally {
    quietScroll = false;
  }
}

export const WhiteboardPaste = Extension.create({
  name: 'whiteboardPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('whiteboardPaste'),
        props: {
          handleScrollToSelection: () => quietScroll,
          handlePaste(view, event) {
            if (itemClipboard && event.clipboardData.getData('text/plain') === itemClipboard.token) return true; // never paste the token text itself
            // Anything but images goes to the editor (a node-selected block refuses it: Notices.jsx PasteNotice).
            const files = postFiles(event.clipboardData);
            if (!files.length) return false;
            // Office apps put a bitmap next to the real HTML (e.g. Excel cells), and so does a block copied here (export.js
            // CopyPicture): keep the rich paste.
            const html = event.clipboardData.getData('text/html');
            if (/data-(canvas|plan-chart|media|whiteboard)\b/.test(html)) return false;
            if (html && new DOMParser().parseFromString(html, 'text/html').body.textContent.trim()) return false;
            addImages(view, files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = postFiles(event.dataTransfer);
            if (!files.length) return false;
            addImages(view, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
            return true;
          },
          // Typing never replaces a node-selected canvas (a click on it, a canvas edit's Done): letters do nothing.
          handleTextInput: ({ state: { selection: sel } }) => sel instanceof NodeSelection && sel.node.type.name === 'canvas',
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------------------------------------
// Snapping, auto-scroll and the active board (shared by every Board).

// The smallest offset that moves one of `edges` onto one of `lines` within `tol`: {d, at} or null.
function snapAxis(edges, lines, tol) {
  let best = null;
  for (const e of edges) {
    for (const at of lines) {
      const d = at - e;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at };
    }
  }
  return best;
}

// The nearest ancestor that scrolls (in the document: the editor area).
export function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    if (/auto|scroll/.test(overflowX + overflowY)) return p;
  }
  return document.scrollingElement;
}

// Auto-scroll speed for a pointer `d` screen px inside an edge (negative: beyond it); faster the closer. Canvas edit
// mode scrolls with it while an artboard edge is dragged.
// Half the original rate (the user found dragging past an edge too fast): at most MAX_SCROLL / 2 px per frame.
export const edgeSpeed = (d) => (d < EDGE ? Math.min(MAX_SCROLL / 2, Math.ceil((EDGE - d) / 4)) : 0);

const boards = new Set(); // live boards
let active = null;
const activeListeners = new Set();
// Chrome outside a board's DOM (React portals: rail, flyouts, ribbon and their popups) carries `data-board-chrome`;
// focus moving there never ends a text edit.
const isChrome = (node) => node instanceof Element && !!node.closest('[data-board-chrome]');

// The board the chrome serves: the one with focus, else one in a tool mode, else none (the
// rail's text mode). Hovering never changes it (§6c): only clicks into a board or back into the text do.
export const activeBoard = {
  get: () => active,
  subscribe(fn) {
    activeListeners.add(fn);
    return () => activeListeners.delete(fn);
  },
};

function updateActive() {
  const focus = document.activeElement;
  if (isChrome(focus) && active && !active.destroyed) return; // chrome in use keeps serving its board
  const list = [...boards];
  const next = list.find((b) => b.owns(focus)) ?? list.find((b) => b.mode) ?? null;
  if (next === active) return;
  active = next;
  for (const fn of activeListeners) fn();
}

function setSnapRules(patch) {
  Object.assign(snapRules, patch);
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snapRules));
  } catch { /* not persisted */ }
  for (const b of boards) b.showGrid();
}

/** The shared shape tool / connector tool settings (post px; kept): every board's chrome follows. Also set without a board
 * (Insert flowchart and the library editor apply the flowchart preset, §6d). */
export function setShapeTool(patch) {
  Object.assign(shapeTool, patch);
  saveTools();
  for (const b of boards) b.emit();
}

export function setConnTool(patch) {
  Object.assign(connTool, patch);
  saveTools();
  for (const b of boards) b.emit();
}

// The line style last set on a shape or connector in the ribbon is the next new one's (§6c Tool settings), as for text.
const STYLE_MEMORY = {
  shape: [['color', 'width', 'opacity', 'fill', 'fillColor'], setShapeTool],
  connector: [['color', 'width', 'opacity', 'dash', 'route', 'heads'], setConnTool],
};
function rememberStyle(type, patch) {
  const [keys, set] = STYLE_MEMORY[type] ?? [[]];
  const p = Object.fromEntries(keys.filter((k) => k in patch).map((k) => [k, structuredClone(patch[k])]));
  if (Object.keys(p).length) set(p);
}

/** The board menu (§6c): a right-click on a board calls open(board, {x, y}) (client px). The app fills it (BoardMenu.jsx), so
 * the editor layer imports no app code. */
export const boardMenu = { open: () => {} };

/** Mermaid flowchart text pasted onto a board (a canvas in Canvas Mode, the library editor) calls
 * offer(board, text): the app fills it (flows.js, the Import diagram dialog), so the editor layer imports no app code. */
export const diagramPaste = { offer: () => {} };

/** Commits every open text edit (also one the board chrome keeps open while it has focus); its board gets the focus. */
export function finishBoardEdits() {
  for (const b of boards) {
    if (!b.editingId) continue;
    b.finishEdit();
    b.focus();
  }
}

// Transient popups (§6c Dismiss-only clicks): selects, menus, popovers except a tool's options flyout, the tool search palette
// and its options panel, the quick tools island. The persistent chrome (rail, tool flyout, ribbon, bars) does not count.
const POPUPS = '[data-slot=select-content],[data-slot=dropdown-menu-content],[data-slot=dropdown-menu-sub-content],' +
  '[data-slot=popover-content]:not([data-tool-flyout]),[data-slot=dialog-content]';

/** A pointer-down on a board while a transient popup is open only closes the popup (Radix closes it on the document's
 * pointerdown or click): → true, default prevented (no focus change). `armed` (a board tool is on): the quick tools island
 * does not count, so the first press after picking a tool in it draws (§7d); that press closes it. */
export function dismissOnly(e, armed = false) {
  const open = [...document.querySelectorAll(armed ? POPUPS : `${POPUPS},[data-quick-tools]`)].some((el) => el.dataset.state !== 'closed');
  if (open) e.preventDefault();
  return open;
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  const refresh = () => queueMicrotask(updateActive);
  document.addEventListener('focusin', (e) => {
    if (isChrome(e.target)) active?.saveRange();
    // Focus leaving the chrome for anything but a board's own elements ends the edit (its focusout went to the chrome).
    else for (const b of boards) if (b.editingId && !b.owns(e.target)) b.finishEdit();
    refresh();
  }, true);
  // Not for focus moving into the chrome (a colour swatch): mid-move the focus is on no element, so the board would drop out
  // and the chrome serving it unmount under the pointer; the focusin after it refreshes.
  document.addEventListener('focusout', (e) => isChrome(e.relatedTarget) || refresh(), true);
  document.addEventListener('pointerdown', (e) => {
    if (isChrome(e.target)) active?.saveRange();
    refresh();
  }, true);
}

// ---------------------------------------------------------------------------------------------
// Board: the interactive surface (items, selection, tools, gestures). It knows nothing about ProseMirror or React;
// `host` stores the attrs: { commit(attrs, newGroup), undo(), redo(), emptyClick(), canUndo?(), canRedo?(),
// shift?(dx, dy) (every item moved by dx, dy; keep them in place on screen,
// → {x, y}: the part it could not, or nothing) }, and every commit must come back through setAttrs().
// Attrs {w, h, frame, bg, items, …}, no bounds: the artboard follows the content (§6b). Auto-scroll during a gesture
// scrolls the nearest scrolling ancestor (the editor area). The chrome (tool rail, flyouts, item ribbon:
// src/app/components/board) observes a board through subscribe() / getSnapshot() and drives it through the action methods.

export class Board {
  constructor(attrs, host, { unit = 1 } = {}) {
    this.attrs = attrs;
    this.host = host;
    this.unit = unit; // board px per post px (§6c Units): 1 / display scale on a canvas being edited, 1 in the library editor
    this.sel = new Set(); // ids of the selected items (§6c multi-selection)
    this.scope = null; // the group stepped into (§6c Groups), null at the top level
    this.editingId = null;
    this.editingSlot = null; // the connector label being edited (start | mid | end), else null
    this.savedRange = null; // caret inside the text being edited, restored after a chrome change
    // {id, alone} of the text item addText placed, until its first edit ends (finishEdit removes it untouched); alone:
    // nothing committed since, so undoing the placement removes it.
    this.newText = null;
    this.mode = null; // null | 'pen' | 'eraser' | 'shape' | 'connector' | placement: 'text' | 'image'
    this.pending = null; // 'image' mode: the picked files a click places; 'shape' mode: an armed prefab {id, items} (§6g)
    this.gesture = null;
    this.listeners = new Set();
    this.rev = 0; // +1 per render and commit: the layers panel rebuilds its rows on it (§6c Layers panel)
    injectStyle();

    this.dom = make('div', 'wb', { tabIndex: 0 });
    this.dom.wbView = this; // lets the flow commands reach the library editor's board (flow.mjs)
    this.dom.style.setProperty('--wb-unit', String(unit));
    this.layer = make('div', 'wb-layer');
    this.guides = make('div', 'wb-guides');
    this.groupEl = make('div', 'wb-group', { hidden: true }); // the group box of several selected items
    this.groupEl.append(...CORNERS.map((c) => make('div', `wb-rot wb-rot-${c}`, { title: 'Drag to rotate the selection, with Shift in 15 degree steps' }))); // §6d group turn
    this.fileInput = make('input', '', { type: 'file', accept: 'image/*', multiple: true }); // detached: pickImages() clicks it
    // Picked images wait for a click that places them ('image' mode); picking nothing ends that mode.
    const picked = () => {
      const files = imageFiles(this.fileInput);
      this.fileInput.value = '';
      if (files.length) this.setMode('image', files);
      else if (this.mode === 'image') this.setMode(null);
    };
    this.fileInput.addEventListener('change', picked);
    this.fileInput.addEventListener('cancel', picked);
    this.dom.append(this.layer, this.guides, this.groupEl);

    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerCancel);
    this.dom.addEventListener('pointerleave', () => this.gesture || this.showTarget(null)); // connector tool hover
    this.dom.addEventListener('mousedown', this.onMouseDown);
    this.dom.addEventListener('dblclick', this.onDblClick);
    this.dom.addEventListener('contextmenu', this.onContextMenu);
    this.dom.addEventListener('keydown', this.onKeyDown);
    this.dom.addEventListener('keyup', this.onKeyUp);
    this.dom.addEventListener('focusout', this.onFocusOut);
    boards.add(this);
    listen();
    this.showGrid();
    this.render();
  }

  // --- observing and driving (chrome) ---

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  // The board's background as a colour in the page theme.
  surface() {
    return boardSurface(this.bg, pageTheme());
  }

  // The colour text with none of its own draws in here (item-style.mjs inkOn): shape `item`'s own, else on what `item` (a shape,
  // a text note or none) puts under it on the board.
  inkOf(item = null) {
    return item?.textColor ?? inkOn(surfaceOf(item, this.surface()), pageTheme());
  }

  // Keeps its identity until something in it changes (useSyncExternalStore).
  // Item `item`'s properties as the ribbon shows them: no content (src, html, d, items), sizes in post px, a shape's label style
  // and a connector's label colours as drawn (§6d defaults), a connector's label sizes.
  itemProps(item) {
    const post = (v) => Math.max(1, Math.round(v / this.unit)); // a size in post px
    const { src, html, d, crop, items, ...rest } = item;
    let props = { ...rest, cropped: !!crop };
    if (item.type === 'shape') {
      const k = kindOf(item.shape);
      props = { size: LABEL.size, bold: false, align: k?.align ?? LABEL.align, valign: k?.valign ?? LABEL.valign, ...props, textColor: this.inkOf(item) };
    }
    if (item.type === 'text') props.color = item.color || this.inkOf(item); // an agent's text may have none: as drawn
    for (const k of UNIT_KEYS) if (k in props) props[k] = post(props[k]); // in post px
    if (item.type === 'connector') {
      props.labels = Object.fromEntries(Object.entries(item.labels ?? {}).map(([s, l]) => [s, { ...l, size: post(l.size ?? 14), textColor: l.textColor ?? this.inkOf() }]));
    }
    return props;
  }

  // Several items selected (2026-10-07, the user: "when i select things i should be able to edit things that are in common"):
  // {type, item, mixed}: one type → that type's controls; shapes, connectors and pen strokes together → 'lines' (colour, width,
  // line style); `item` the first one's properties, which the controls show; `mixed` the fields whose values differ (a mixed
  // shape kind hides the Shape picker). null for other mixes and for images.
  groupProps() {
    if (this.sel.size < 2) return null;
    const items = this.selectedItems();
    const types = [...new Set(items.map((i) => i.type))];
    const type = types.length === 1 && GROUP_FIT[types[0]] ? types[0] : types.every((t) => LINE_TYPES.has(t)) ? 'lines' : null;
    if (!type) return null;
    const keys = type === 'lines' ? ['color', 'width', 'opacity'] : GROUP_FIT[type];
    const mixed = keys.filter((k) => items.some((i) => JSON.stringify(i[k]) !== JSON.stringify(items[0][k])));
    return { type, item: this.itemProps(items[0]), mixed };
  }

  getSnapshot() {
    const item = this.selected();
    const props = item ? this.itemProps(item) : null;
    const snap = {
      kind: 'canvas',
      mode: this.mode,
      keepTool,
      prefab: (this.mode === 'shape' && this.pending?.id) || null, // the armed prefab (§6g)
      item: props, // only while exactly one item is selected
      group: this.groupProps(), // several selected: their common controls (groupProps)
      count: this.sel.size,
      editing: !!this.editingId,
      pen: { ...pen },
      shape: { ...shapeTool },
      conn: { ...connTool, heads: { ...connTool.heads }, color: connTool.color ?? ink() },
      snap: { ...snapRules },
      bg: this.bg,
      canUndo: this.host.canUndo?.() ?? true,
      canRedo: this.host.canRedo?.() ?? true,
    };
    const key = JSON.stringify(snap);
    if (key !== this.snapKey) [this.snapKey, this.snapshot] = [key, snap];
    return this.snapshot;
  }

  // The board's own elements (not the shared chrome).
  owns(node) {
    return !!node && this.dom.contains(node);
  }

  // The selected item's on-screen rect, or null; it reaches its quick-connect dots and rotate handle above and below, so
  // the ribbon never covers them.
  itemRect() {
    if (this.sel.size > 1) { // several selected: the box around them
      const rs = [...this.sel].map((id) => this.itemEl(id)?.getBoundingClientRect()).filter(Boolean);
      return rs.length ? { left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)),
        right: Math.max(...rs.map((r) => r.right)), bottom: Math.max(...rs.map((r) => r.bottom)) } : null;
    }
    const el = this.selectedId && this.itemEl(this.selectedId);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const dots = [...el.querySelectorAll(':scope > :is(.wb-qc, .wb-rot)')].map((d) => d.getBoundingClientRect());
    if (!dots.length) return r;
    return { left: r.left, right: r.right, top: Math.min(r.top, ...dots.map((d) => d.top)), bottom: Math.max(r.bottom, ...dots.map((d) => d.bottom)) };
  }

  // The on-screen area the board is seen through (the editor area).
  viewRect() {
    return scrollParent(this.dom).getBoundingClientRect();
  }

  // Chrome hands focus back after a change: the caret into the text being edited, else the board (its shortcuts).
  focus() {
    if (this.destroyed) return;
    const text = this.editText();
    if (text) this.restoreCaret(text);
    else this.dom.focus({ preventScroll: true });
  }

  setSnap(patch) {
    setSnapRules(patch);
  }

  showGrid() {
    this.dom.classList.toggle('wb-grid', snapRules.on && snapRules.grid);
    this.emit();
  }

  // A shared tool's settings (post px) at this board's unit: what a new stroke / shape / connector stores.
  tool(t) {
    return { ...t, width: r2(t.width * this.unit), ...(Number.isFinite(t.size) && { size: r2(t.size * this.unit) }) };
  }

  // Shared tool settings: every board's chrome follows.
  setPen(patch) {
    Object.assign(pen, patch);
    saveTools();
    for (const b of boards) b.emit();
  }

  // Picking a kind disarms a prefab (§6g).
  setShapeTool(patch) {
    if ('shape' in patch && this.mode === 'shape' && this.pending) this.pending = null;
    setShapeTool(patch);
  }

  setConnTool(patch) {
    setConnTool(patch);
  }

  setKeepTool(on) {
    keepTool = on;
    for (const b of boards) b.emit();
  }

  setBg(bg) {
    this.bg = bg;
    this.dom.dataset.bg = bg; // render() is held back during a text edit
    this.commit();
  }

  // An open text edit is committed first: setAttrs() would not show the undone state while it is open. When ending it
  // undoes an untouched new text's placement (finishEdit), that is the undo step.
  undo() {
    if (!this.finishEdit()) this.host.undo();
  }

  redo() {
    if (!this.finishEdit()) this.host.redo();
  }

  // --- rendering ---

  // External update (the document changed): re-render unless a gesture or text edit is in progress (finishEdit()
  // re-renders then).
  setAttrs(attrs) {
    this.attrs = attrs;
    if (this.editingId) this.stale = true;
    else if (!this.gesture) this.render();
  }

  render() {
    this.stale = false;
    this.rev++;
    const { bg, items } = this.attrs;
    const hadFocus = this.dom.contains(document.activeElement);
    const { w, h } = this.attrs;
    const f = this.attrs.frame ?? { x: 0, y: 0, w, h };
    // Undo / redo, or a live shift that was not committed, moving the frame without resizing it: a normalisation
    // shift, kept in place on screen.
    const o = this.frame;
    if (o && f.w === o.w && f.h === o.h && (f.x !== o.x || f.y !== o.y)) this.host.shift?.(f.x - o.x, f.y - o.y);
    [this.width, this.height, this.frame] = [w, h, f];
    this.dom.style.width = `${w}px`;
    this.bg = bg;
    this.els = new Map(); // id → element; empty while routing, so text heights are measured fresh
    this.targetKey = ''; // the sticking target shown (showTarget), gone with the old elements
    // Connectors are routed against the items as drawn (§6d); geo: their board px polylines (hit-testing, marquee). Groups made
    // whole first (§6 Layer fields).
    ({ items: this.items, geo: this.geo } = resolveConnectors(normalizeGroups(items).map((i) => ({ ...i })), this.measure));
    // Canvases made from an image before frames could be bound: a frame that is exactly the box of the only item binds to it.
    const one = !this.frame.item && this.items.length === 1 && this.items[0];
    if (one && one.type !== 'text' && ['x', 'y', 'w', 'h'].every((k) => Math.round(one[k]) === Math.round(this.frame[k]))) {
      this.frame = { ...this.frame, item: one.id };
    }
    for (const id of this.sel) if (!this.items.some((i) => i.id === id && !i.hidden)) this.sel.delete(id); // gone or hidden
    this.dom.style.height = `${this.size().h}px`;
    this.dom.dataset.bg = bg;
    this.layer.replaceChildren(...this.items.map((i) => this.addEl(i)));
    this.renderSelection();
    if (hadFocus && !this.dom.contains(document.activeElement)) this.dom.focus({ preventScroll: true });
  }

  // Every selected item has its outline; a single one also its handles (decorate), several the group box. The scope ends when
  // no selected item is inside it (§6c Groups: nothing selected, the group gone, copies made outside it).
  renderSelection() {
    if (this.scope && !this.selectedItems().some((i) => i.groups?.includes(this.scope))) this.scope = null;
    this.refreshScale();
    const one = this.selectedId;
    for (const el of this.layer.children) {
      el.classList.toggle('wb-sel', this.sel.has(el.dataset.id));
      for (const h of el.querySelectorAll(':scope > :is(.wb-handle, .wb-rot, .wb-tip, .wb-end, .wb-mid, .wb-wp, .wb-qc)')) h.remove();
      if (el.dataset.id === one) this.decorate(el, this.selected());
    }
    this.placeGroupBox();
    this.emit();
  }

  // The handles of the one selected item: a connector's end, segment and waypoint handles (its box is derived: no
  // corners); any other item's rotate zones just outside its corners (the corner handles over their inner corner, so near a
  // corner resizes and a little further out rotates), its corner and edge handles (text: e and w) and, except a stroke's, its
  // four quick-connect dots (§6d). Children of the item's element, they turn with a turned item.
  decorate(el, item) {
    if (!item) return;
    if (item.type === 'connector') {
      // Segment and waypoint handles under the labels (a label at a segment's middle stays draggable), the ends on top.
      const [parts, ends] = this.connectorHandles(item);
      el.querySelector(':scope > .wb-text') ? el.querySelector(':scope > .wb-text').before(...parts) : el.append(...parts);
      el.append(...ends);
      return;
    }
    if (item.type === 'shape' && isLineish(item.shape)) { // a line or arrow: a handle on each end, nothing else (§6d tips)
      const c = { x: item.x + item.w / 2, y: item.y + item.h / 2 };
      el.append(...lineEnds(item).map((p, k) => {
        const q = rotatePoint(p, c, -rotOf(item)); // into its element's own (unturned) frame
        const tip = make('div', 'wb-tip', { title: `Drag to point the ${k ? 'tip' : 'start'} elsewhere (Shift: 45 degree steps)` });
        Object.assign(tip.style, { left: `${q.x - item.x}px`, top: `${q.y - item.y}px` });
        tip.dataset.tip = k;
        return tip;
      }));
      return;
    }
    const title = item.type === 'image' ? 'Drag to resize, Ctrl + drag to crop' : 'Drag to resize';
    const turn = `Drag to rotate, with Shift in 15 degree steps${keyLabel('board.rotate') ? `. ${keyLabel('board.rotate')} turns it 90 degrees` : ''}`;
    if (turns(item)) el.append(...CORNERS.map((c) => make('div', `wb-rot wb-rot-${c}`, { title: turn })));
    el.append(...[...CORNERS, ...(item.type === 'text' ? ['e', 'w'] : EDGES)].map((c) => make('div', `wb-handle wb-h-${c}`, { title })));
    if (item.type === 'stroke') return;
    for (const s of Object.keys(SIDES)) {
      const dot = make('div', `wb-qc wb-qc-${s}`, { title: 'Drag to connect, click to add a connected copy (Ctrl+Arrow)' });
      dot.dataset.side = s;
      el.append(dot);
    }
  }

  // A selected connector's handles, at their board positions inside its element: [segment (ortho: the inner segments;
  // straight / curve: between control points) and waypoint handles, end handles (filled while the end sticks to an item)].
  connectorHandles(c) {
    const geo = this.geo.get(c.id);
    if (!geo || !Number.isFinite(c.x)) return [[], []];
    const at = (cls, p, data, title) => {
      const h = make('div', cls, { title });
      Object.assign(h.style, { left: `${p.x - c.x}px`, top: `${p.y - c.y}px` });
      Object.assign(h.dataset, data);
      return h;
    };
    const bound = (e) => typeof e.item === 'string';
    return [[
      ...midHandles(c.route ?? 'ortho', geo.pts, c.points ?? []).map((m) => at(`wb-mid${m.dir ? ` ${m.dir}` : ''}`, m, { k: m.k },
        c.route === 'ortho' || !c.route ? 'Drag to move this segment' : 'Drag to add a bend')),
      ...(c.points ?? []).map((p, k) => at('wb-wp', p, { k }, 'Drag to move the bend, double-click to remove it')),
    ], geo.tipsAbs.map((t, k) => at(`wb-end${bound([c.from, c.to][k]) ? ' bound' : ''}`, t, { end: k }, 'Drag to reconnect (Alt: do not stick, Shift: pin the tip right there)'))];
  }

  // One dashed box around several selected items with its rotate handle (live during a group move; during a group turn the
  // start box turned by the gesture's angle).
  placeGroupBox() {
    const turn = this.gesture?.kind === 'turn' && this.gesture;
    const box = turn ? turn.group : this.sel.size > 1 && groupBox(this.selectedItems().map((i) => this.itemBox(i)));
    this.groupEl.hidden = !box;
    if (box) placeItem(this.groupEl, { ...box, type: 'shape', rot: turn.delta ?? 0 });
  }

  // Handles and the selection outline keep their on-screen size at any zoom (CSS calc with --wb-inv); the layer clips
  // 8 screen px outside the board so handles on items at the edge stay whole (overflow-clip-margin rejects calc()).
  refreshScale() {
    const inv = 1 / this.scale();
    if (inv === this.inv) return;
    this.inv = inv;
    this.dom.style.setProperty('--wb-inv', String(inv));
    this.layer.style.overflowClipMargin = `${8 * inv}px`;
  }

  // Changes the selected item's properties (ribbon). Mid-edit: keeps the typed text, restyles the live
  // element (setAttrs() skips re-rendering while editing), commits, then puts the caret back into the text.
  setItem(patch) {
    if (this.sel.size > 1) return this.setItems(patch);
    const item = this.selected();
    if (!item) return;
    Object.assign(item, patch);
    for (const k of UNIT_KEYS) if (k in patch) item[k] = r2(patch[k] * this.unit); // from post px
    if (item.type === 'text') {
      // The last size, colour, bold and note chosen on a text item are the next new text's (shared, kept).
      for (const k of Object.keys(textTool)) if (k in patch) textTool[k] = patch[k];
      saveTools();
    } else rememberStyle(item.type, patch);
    const text = item.type === 'text' ? this.itemEl(item.id)?.querySelector('.wb-text') : null;
    if (text) styleText(text, item, pageTheme(), this.surface()); // the commit measures the restyled height
    // A shape whose label is being typed: the live label takes the style, the typed text is kept (as for text items).
    const label = item.type === 'shape' && item.id === this.editingId ? this.editText() : null;
    if (label) {
      styleLabel(label, item, pageTheme(), this.surface());
      item.html = labelHtml(label);
    }
    const live = text ?? label;
    if (!live || item.id !== this.editingId) return this.commit();
    if (text) item.html = text.innerHTML;
    this.commit();
    this.restoreCaret(live);
    this.emit();
  }

  // A ribbon change with several items selected: each takes the fields its type has (GROUP_FIT), sizes from post px; one commit,
  // one undo step.
  setItems(patch) {
    for (const item of this.selectedItems()) {
      const p = Object.fromEntries(Object.entries(patch).filter(([k]) => GROUP_FIT[item.type]?.includes(k)));
      if (!Object.keys(p).length) continue;
      Object.assign(item, p);
      for (const k of UNIT_KEYS) if (k in p) item[k] = r2(p[k] * this.unit);
      const text = item.type === 'text' ? this.itemEl(item.id)?.querySelector('.wb-text') : null;
      if (text) styleText(text, item, pageTheme(), this.surface()); // the commit measures the restyled height
    }
    for (const type of new Set(this.selectedItems().map((i) => i.type))) rememberStyle(type, patch); // as setItem
    this.commit();
  }

  // --- state helpers ---

  // The selected item's id while exactly one is selected, else null: the ribbon and item properties serve a single item.
  get selectedId() {
    return this.sel.size === 1 ? this.sel.values().next().value : null;
  }

  selected() {
    return this.items.find((i) => i.id === this.selectedId) ?? null;
  }

  // The selected items in z-order.
  selectedItems() {
    return this.items.filter((i) => this.sel.has(i.id));
  }

  itemEl(id) {
    return this.els.get(id) ?? null;
  }

  // A new element for `item`, kept in the id → element map.
  addEl(item) {
    const el = itemElement(item, pageTheme(), this.surface());
    this.els.set(item.id, el);
    return el;
  }

  // The text element of item `id` being edited (default: the edit in progress): a text item's, a shape's label, or the
  // connector label in `slot`; null when none.
  editText(id = this.editingId, slot = this.editingSlot) {
    const el = id ? this.itemEl(id) : null;
    if (!el) return null;
    return el.querySelector(slot ? `:scope > .wb-text[data-slot="${slot}"]` : el.classList.contains('wb-shape') ? ':scope > .wb-label > .wb-text' : '.wb-text');
  }

  // The unrotated box routing measures (text: its rendered height).
  measure = (i) => (i.type === 'text' ? { x: i.x, y: i.y, w: i.w, h: this.itemHeight(i) } : i);

  // ids: one id, an array of ids, or null (none); `scope`: the group they count in (§6c Groups; the layers panel sets it). A
  // hidden item is never selected (§6 Layer fields), nor one no longer on the board.
  select(ids, scope = this.scope) {
    this.scope = scope;
    this.sel = new Set(Array.isArray(ids) ? ids : ids ? [ids] : []);
    for (const id of this.sel) if (!this.items.some((i) => i.id === id && !i.hidden)) this.sel.delete(id); // gone or hidden
    this.renderSelection();
  }

  // The board's size in board px (live during a gesture).
  size() {
    return { w: this.width, h: this.height };
  }

  // The size follows the content (`box`: an item being drawn counts too): the smart artboard (§6b); when it grows or
  // shrinks on the left / top, the items, the frame and gesture `g` shift so it starts at 0,0 again.
  autoSize(box = null, g = null) {
    // A frame bound to an item follows it (moved, resized, cropped): the canvas of an image moves with the image instead
    // of leaving its old spot empty. A deleted item leaves the frame where it was, unbound.
    const f = this.frame;
    const bound = f?.item && this.items.find((i) => i.id === f.item);
    if (bound) this.frame = { ...this.itemBox(bound), item: bound.id };
    else if (f?.item) this.frame = { x: f.x, y: f.y, w: f.w, h: f.h };
    const c = this.contentBox();
    const a = smartArtboard(this.frame, this.size(), box ? boxUnion(c, box) : c);
    const resized = a.w !== this.width || a.h !== this.height;
    [this.width, this.height, this.frame] = [a.w, a.h, a.frame];
    this.dom.style.width = `${a.w}px`;
    if (a.dx || a.dy) this.shiftItems(a.dx, a.dy, g);
    if (resized) this.emit(); // the W / H readout
    this.dom.style.height = `${this.height}px`;
  }

  // Moves every item (and gesture `g`'s board coordinates) by dx, dy; the host keeps them in place on screen. What it
  // cannot (a canvas held at its place in the post) shifts the content on screen, and the pointer keeps its grip (g.off).
  shiftItems(dx, dy, g = null) {
    for (const i of this.items) {
      Object.assign(i, moveItem(i, dx, dy));
      const el = this.itemEl(i.id);
      if (el) placeItem(el, i);
    }
    if (this.anchor) Object.assign(this.anchor, { x: this.anchor.x + dx, y: this.anchor.y + dy }); // the ribbon's place
    if (g) {
      for (const s of g.starts) Object.assign(s, moveItem(s, dx, dy));
      if (g.conn) g.conn = moveItem(g.conn, dx, dy); // a connector being drawn: its free ends
      for (const p of [g.p0, g.start, g.end, g.box, g.group, ...g.boxes, ...(g.points ?? []), ...(g.points0 ?? []), ...(g.pts0 ?? [])]) {
        if (!p) continue;
        p.x += dx;
        p.y += dy;
      }
      for (const guide of g.guides) guide.at += guide.axis === 'x' ? dx : dy;
      g.path?.setAttribute('d', smoothPath(g.points));
      if (g.preview) placeItem(g.preview, { ...g.box, type: 'shape' });
    }
    const rest = this.host.shift?.(dx, dy);
    if (g && rest) {
      g.off.x += rest.x;
      g.off.y += rest.y;
    }
  }

  // Text: rendered height (measured hidden when the item is not drawn yet). Others: h.
  itemHeight(item) {
    if (item.type !== 'text') return item.h;
    let el = this.itemEl(item.id);
    if (el) return el.offsetHeight;
    el = itemElement(item, pageTheme(), this.surface());
    el.style.visibility = 'hidden';
    this.layer.append(el);
    const h = el.offsetHeight;
    el.remove();
    return h;
  }

  // The item's box (text: rendered height; a turned item: the bounds of its turned box, §6d).
  itemBox(item) {
    return rotBox({ x: item.x, y: item.y, w: item.w, h: this.itemHeight(item), rot: rotOf(item) });
  }

  // Moves `items` by dx, dy together.
  moveBy(items, dx, dy) {
    for (const i of items) Object.assign(i, moveItem(i, dx, dy));
  }

  // The union of all item boxes (text: rendered height), or null without items.
  contentBox() {
    return groupBox(this.items.map((i) => this.itemBox(i)));
  }

  scale() {
    const s = this.dom.getBoundingClientRect().width / this.dom.offsetWidth;
    return s > 0 && Number.isFinite(s) ? s : 1;
  }

  // Pointer position in board px (zoom- and scroll-aware); during a gesture plus the shift the host could not follow.
  local(e) {
    const p = localPoint(this.dom, e);
    const off = this.gesture?.off;
    return off ? { x: p.x + off.x, y: p.y + off.y } : p;
  }

  // Pointer position in board px, snapped when `g` (a gesture) is given.
  pointAt(e, g = null) {
    const p = this.local(e);
    return g ? this.snapPoint(g, p, e) : p;
  }

  // newGroup: own undo step, even right after another commit (history merges commits within 500 ms).
  commit(newGroup = false) {
    if (this.destroyed) return;
    if (this.newText) this.newText.alone = false;
    this.rev++;
    let capped;
    // Groups made whole (§6 Layer fields), then routed before autoSize: arrows count.
    ({ items: this.items, geo: this.geo, capped } = resolveConnectors(normalizeGroups(this.items), this.measure));
    if (capped) toast('Some line jumps are not drawn. Too many lines cross.', { id: 'wb-jump-cap' });
    // A text item fitted to its text (`fit`) stores its rendered width.
    for (const i of this.items) {
      const el = i.type === 'text' && i.fit && this.itemEl(i.id);
      if (!el) continue;
      placeItem(el, i);
      i.w = Math.max(1, Math.ceil(el.offsetWidth));
    }
    this.autoSize();
    // A text item stores its rendered height (`h`, §6d): pure code (routing outside the Board) reads it.
    const attrs = { ...this.attrs, bg: this.bg, items: this.items.map((i) => (i.type === 'text' ? { ...i, h: this.itemHeight(i) } : { ...i })) };
    Object.assign(attrs, { w: this.width, h: this.height, frame: this.frame });
    this.host.commit(attrs, newGroup);
  }

  // --- snapping (§6c) ---

  // Snap lines on one axis: other items' edges and centres, and the frame's edges and centre lines.
  snapLines(g, axis) {
    const lines = [];
    if (snapRules.items) {
      for (const b of g.boxes) lines.push(...(axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]));
    }
    // The frame, not the artboard (its edges follow the content), and not a frame bound to a moved item: that is the item's
    // own box a step ago, and snapping to it would hold the item back.
    if (snapRules.board && !(this.frame.item && g.starts.some((s) => s.id === this.frame.item))) {
      const f = this.frame;
      lines.push(...(axis === 'x' ? [f.x, f.x + f.w / 2, f.x + f.w] : [f.y, f.y + f.h / 2, f.y + f.h]));
    }
    return lines;
  }

  // Offset {d, at} that snaps one of `edges` (board px on `axis`), or null. Item and board lines win over the grid,
  // which snaps edges[0]; only they draw a guide. Ctrl turns snapping off, except while cropping (Ctrl is the crop key).
  snapHit(g, axis, edges, e) {
    if (!snapRules.on || (e.ctrlKey && g.kind !== 'crop')) return null;
    const tol = SNAP_PX / this.scale();
    const hit = snapAxis(edges, this.snapLines(g, axis), tol);
    if (hit) {
      g.guides.push({ axis, at: hit.at });
      return hit;
    }
    const d = Math.round(edges[0] / GRID) * GRID - edges[0];
    return snapRules.grid && Math.abs(d) <= tol ? { d } : null;
  }

  snapPoint(g, p, e) {
    return { x: p.x + (this.snapHit(g, 'x', [p.x], e)?.d ?? 0), y: p.y + (this.snapHit(g, 'y', [p.y], e)?.d ?? 0) };
  }

  showGuides(guides) {
    this.guides.replaceChildren(...guides.map(({ axis, at }) => {
      const el = make('div', `wb-guide wb-guide-${axis}`);
      el.style[axis === 'x' ? 'left' : 'top'] = `${at}px`;
      return el;
    }));
  }

  // --- actions ---

  // Placement tools ('text', 'image', a prefab armed in 'shape' mode): a click adds the item(s) with the top-left
  // at the (snapped) pointer, and the tool returns to Select unless it is kept on (keeps()). `e`: a
  // pointer event over the board.
  place(e) {
    const [mode, pending] = [this.mode, this.pending];
    const p = this.snapped(e);
    if (!this.keeps()) this.setMode(null);
    if (mode === 'text') this.addText(p, pending?.note);
    else if (mode === 'shape') this.addCopies(pending.items, p);
    else this.addImageFiles(pending, p, true);
    this.pin(e);
  }

  // The pointer of event `e` in board px, snapped like a shape start (no gesture under way; hidden items are no snap target).
  snapped(e) {
    return this.pointAt(e, { kind: 'place', boxes: this.items.filter((i) => !i.hidden).map((i) => this.itemBox(i)), starts: [], guides: [] });
  }

  // A new text item with its top-left at `p` (board px): 200 post px wide, the text defaults (textTool), note colour `bg`.
  textItem(p, bg = textTool.bg) {
    return {
      id: newId(),
      type: 'text',
      html: 'Text',
      x: Math.round(p.x),
      y: Math.round(p.y),
      w: Math.min(Math.round(200 * this.unit), this.size().w),
      size: r2(textTool.size * this.unit),
      color: textTool.color ?? this.inkOf({ type: 'text', bg }),
      bold: textTool.bold,
      align: 'left',
      bg,
    };
  }

  // A text item with its top-left at `p` (board px), edited at once (`note`: its note colour, default the text defaults').
  addText(p, note) {
    const item = this.textItem(p, note);
    this.finishEdit();
    this.items.push(item);
    this.sel = new Set([item.id]);
    this.commit(true);
    this.newText = { id: item.id, alone: true };
    this.startEdit(item.id);
  }

  // The file picker; the picked images are then placed by a click ('image' mode).
  pickImages() {
    this.fileInput.click();
  }

  // Adds image files centred at `point` (board px; `corner`: the first one's top-left there), else centred, each scaled
  // to ≤ 60 % of the board width, the next ones +20 px, kept inside; the board grows to hold them (one commit).
  async addImageFiles(files, point = null, corner = false) {
    const images = (await Promise.all(imageFiles({ files }).map(readImage))).filter(Boolean);
    if (!images.length || this.destroyed) return;
    this.finishEdit();
    const { w, h } = this.size();
    const c = point ?? { x: w / 2, y: h / 2 };
    const ids = images.map((img, i) => {
      const size = scaled(img, w * 0.6);
      const [ox, oy] = corner ? [0, 0] : [size.w / 2, size.h / 2];
      const item = { id: newId(), type: 'image', src: img.src, x: Math.round(c.x - ox + i * 20), y: Math.round(c.y - oy + i * 20), ...size };
      this.items.push(item);
      return item.id;
    });
    this.spawned(ids);
    this.commit(true);
  }

  // Pastes a copied board item (while the system clipboard holds its token) or image files; false if `data` has neither.
  pasteData(data, point = null) {
    if (itemClipboard && data.getData('text/plain') === itemClipboard.token) {
      this.pasteItem();
      return true;
    }
    const files = imageFiles(data);
    if (files.length) this.addImageFiles(files, point);
    return files.length > 0;
  }

  // A paste onto the board itself, centred in its visible part: the items of smart canvases and whiteboards copied from a
  // document (an image block is a canvas; their picture next to them is left), else a copied item or image files (pasteData),
  // else the text as a text item.
  pasteClipboard(data) {
    const c = this.visibleCentre();
    const items = copiedBoardItems(data.getData('text/html'), this.unit);
    if (items.length) {
      const box = groupBox(items.map((i) => this.itemBox(i)));
      this.addCopies(items, { x: c.x - box.w / 2, y: c.y - box.h / 2 });
      return;
    }
    if (this.pasteData(data, c)) return;
    const text = data.getData('text/plain').trim();
    if (!text) return;
    const item = { ...this.textItem(c), html: make('div', '', { innerText: text }).innerHTML };
    item.x = Math.round(c.x - item.w / 2);
    this.finishEdit();
    this.items.push(item);
    this.spawned([item.id]);
    this.commit(true);
  }

  // A window paste (capture phase) while this board is the working area outside ProseMirror (a canvas being edited in place,
  // the library editor): Mermaid flowchart text offers to import it (§6d Formats), anything else goes on the board
  // (pasteClipboard); a text being edited and the inputs (W / H, search, dialogs) paste themselves. Goes by the focus: the
  // event's target is where the document's selection is (the paragraph by a node-selected canvas), not the board.
  pasteEvent = (e) => {
    const f = document.activeElement;
    if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement || f?.isContentEditable) return;
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData.getData('text/plain');
    if (isMermaid(text)) diagramPaste.offer(this, text);
    else this.pasteClipboard(e.clipboardData);
  };

  // Natural pixel size of an image's visible region, capped to the board width; the board grows to hold it (commit).
  resetSize(item = this.selected()) {
    const size = this.naturalSize(item);
    if (!size) return;
    Object.assign(item, scaled(size, this.size().w));
    this.commit();
  }

  // Natural pixel size of an image item's visible region, or null while its picture is not loaded.
  naturalSize(item) {
    const img = item?.type === 'image' && this.itemEl(item.id)?.querySelector('img');
    const c = item?.crop ?? FULL;
    return img?.naturalWidth ? { w: img.naturalWidth * c.w, h: img.naturalHeight * c.h } : null;
  }

  // Board px at the centre of the part of the board that its scrolling area shows.
  visibleCentre() {
    const v = this.viewRect();
    const r = this.dom.getBoundingClientRect();
    const s = this.scale();
    const { w, h } = this.size();
    const x = (Math.max(v.left, r.left) + Math.min(v.right, r.right)) / 2;
    const y = (Math.max(v.top, r.top) + Math.min(v.bottom, r.bottom)) / 2;
    return { x: fit((x - r.left) / s, 0, w), y: fit((y - r.top) / s, 0, h) };
  }

  // The whole image again at the current scale (smaller only if it would be wider than the board), kept inside.
  resetCrop(item = this.selected()) {
    const c = item?.crop;
    if (!c) return;
    const full = { w: item.w / c.w, h: item.h / c.h };
    Object.assign(item, { x: Math.round(item.x - c.x * full.w), y: Math.round(item.y - c.y * full.h) }, scaled(full, this.size().w));
    delete item.crop;
    this.commit();
  }

  // Moves the selected items in z-order, keeping their order among themselves (model.mjs arrangeItems: a group moves whole;
  // inside a group stepped into, among its members, §6c Groups). where: 'front' | 'back' | 'forward' | 'backward' (one step
  // past the unit above / below) | {index} (the layers panel's drag: `ids` at `scope`, its own undo step).
  arrange(where, ids = this.sel, scope = this.scope) {
    const items = arrangeItems(this.items, ids, where, scope);
    if (items.every((i, k) => i === this.items[k])) return;
    this.items = items;
    this.commit(typeof where === 'object');
    if (!this.editingId) return;
    // setAttrs() skips re-rendering mid-edit: move the others around the edited (focused) element to keep the caret.
    const els = this.items.map((i) => this.itemEl(i.id));
    const k = els.indexOf(this.itemEl(this.editingId));
    els[k].before(...els.slice(0, k));
    els[k].after(...els.slice(k + 1));
  }

  // Lock / Hide (§6 Layer fields; Ctrl+Shift+L / Ctrl+Shift+H, the board menu): `field` ('locked' | 'hidden') set on the
  // selection (`ids`: a layers panel row's items), or cleared when every one has it; `all`: cleared on every item that has it
  // (Unlock all, Show all). The edit ends first; an item locked or hidden leaves the selection. Its own undo step.
  setLayer(field, all = false, ids = this.sel) {
    this.finishEdit();
    const items = toggleLayer(this.items, all ? this.items.filter((i) => i[field]).map((i) => i.id) : ids, field);
    if (items === this.items) return;
    this.items = items;
    for (const i of items) if (!selectable(i)) this.sel.delete(i.id);
    this.commit(true);
  }

  // Group (Ctrl+G) / Ungroup (`on` false, Ctrl+Shift+G) the selection (§6c Groups; model.mjs groupItems, ungroupItems): the new
  // group becomes the selection, the scope its parent group (or null); ungrouped items stay selected. The edit ends first. Its
  // own undo step.
  group(on = true) {
    this.finishEdit();
    let id = null;
    const items = on ? groupItems(this.items, this.sel, () => (id = newId())) : ungroupItems(this.items, this.sel);
    if (items === this.items) return;
    this.items = items;
    if (id) {
      const m = items.find((i) => i.groups?.includes(id));
      this.scope = m.groups[m.groups.indexOf(id) + 1] ?? null;
      this.sel = new Set(items.filter((i) => i.groups?.includes(id) && !i.hidden).map((i) => i.id));
    }
    this.commit(true);
  }

  // Whether Ungroup would change anything: the selection covers a whole group (the board menu and tool search enable it on this).
  canUngroup() {
    return ungroupItems(this.items, this.sel) !== this.items;
  }

  // The layers panel's hovered row (§6c Layers panel): its items outlined as selected ones are, without handles.
  hover(ids = []) {
    for (const el of this.layer.children) el.classList.toggle('wb-hover', ids.includes(el.dataset.id));
  }

  // Selects item `id`'s unit (§6c Groups: its outermost group at the scope, model.mjs unitOf); the scope becomes where it is.
  selectUnit(id) {
    const u = unitOf(this.items, id, this.scope);
    this.scope = u.scope;
    this.select(u.ids);
  }

  // Esc inside a group (§6c Groups): the group stepped into becomes the selection, the scope its parent group (or null).
  stepOut() {
    const s = this.scope;
    const m = this.items.find((i) => i.groups?.includes(s));
    this.scope = m?.groups[m.groups.indexOf(s) + 1] ?? null;
    this.select(this.items.filter((i) => i.groups?.includes(s)).map((i) => i.id));
  }

  // A double-click on a member of the selected group (§6c Groups) steps in: the scope becomes that group and the member's unit
  // there the selection. → true when the double-click ends there: that unit is a group (the next double-click goes on in), or
  // the member does not edit (an image, a stroke).
  stepIn(item) {
    const u = unitOf(this.items, item.id, this.scope);
    if (!u.group || !this.sel.has(item.id)) return false;
    const inner = unitOf(this.items, item.id, u.group);
    this.scope = u.group;
    this.select(inner.ids);
    return !!inner.group || !['text', 'shape', 'connector'].includes(item.type);
  }

  // --- arranging, rotating and style (§6d; one commit each) ---

  // Align / distribute: the selected items except connectors (their bound ends follow), each moved by the change of its
  // bounds (a turned shape: its turned box).
  arrangeBoxes(fn) {
    this.finishEdit();
    const items = this.selectedItems().filter((i) => i.type !== 'connector');
    if (items.length < 2) return;
    const boxes = items.map((i) => this.itemBox(i));
    const moves = fn(boxes).map((b, k) => [Math.round(b.x - boxes[k].x), Math.round(b.y - boxes[k].y)]);
    if (moves.every(([dx, dy]) => !dx && !dy)) return;
    items.forEach((i, k) => Object.assign(i, moveItem(i, ...moves[k])));
    this.commit();
  }

  // where: left | centre | right | top | middle | bottom (onto the selection's bounds).
  align(where) {
    this.arrangeBoxes((boxes) => alignBoxes(boxes, where));
  }

  // axis: 'h' | 'v': equal gaps, the outermost items stay.
  distribute(axis) {
    this.arrangeBoxes((boxes) => distributeBoxes(boxes, axis));
  }

  // axis: 'w' | 'h': every selected item takes the largest width / height among them (connectors and, for 'h', text, whose
  // height follows its text, are left out).
  sameSize(axis) {
    this.finishEdit();
    const items = this.selectedItems().filter((i) => i.type !== 'connector' && (axis === 'w' || i.type !== 'text'));
    if (items.length < 2) return;
    const boxes = sameBoxes(items.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, rot: rotOf(i) })), axis);
    if (boxes.every((b, k) => b[axis] === items[k][axis])) return;
    items.forEach((i, k) => {
      Object.assign(i, { x: Math.round(boxes[k].x), y: Math.round(boxes[k].y), [axis]: boxes[k][axis] });
    });
    this.commit();
  }

  // R (by 90), Shift+R (by −90), the ribbon's Rotate: every selected shape and image turns about its own centre. `to`: the
  // angle field.
  rotate(by, to = null) {
    this.finishEdit();
    const items = this.selectedItems();
    if (to === null) { // R, Shift+R, Rotate 90°: the selection turns as one about its group box's centre
      const starts = items.map((i) => ({ ...i }));
      this.turnItems(items, starts, by);
      if (items.some((i, k) => CHANGE_KEYS.some((p) => JSON.stringify(i[p]) !== JSON.stringify(starts[k][p])))) this.commit();
      return;
    }
    let turned = false;
    for (const s of items) {
      const rot = ((to % 360) + 360) % 360;
      if (!turns(s) || rot === (s.rot ?? 0)) continue;
      s.rot = rot;
      turned = true;
    }
    if (turned) this.commit();
  }

  // `items` set to `starts` turned `deg` degrees about the centre of the starts' group box (turnItem: each goes round it and
  // turns; a connector's free ends and bends go round).
  turnItems(items, starts, deg) {
    const b = groupBox(starts.map((s) => this.itemBox(s)));
    if (!b) return;
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    items.forEach((i, k) => Object.assign(i, turnItem(starts[k], c, deg, this.itemHeight(starts[k]))));
    for (const i of items) {
      const el = this.itemEl(i.id);
      if (el) placeItem(el, i);
    }
  }

  // Flip horizontal (axis 'x') / vertical ('y') (§6d flips; the board menu, Shift+H / Shift+V): the selection mirrored as one
  // across its group box's middle (one item: in place). Each item mirrors its content (mirrors()), a line or arrow turns its
  // direction, text keeps its words the right way round; angles are mirrored; a connector's free ends and bends move across.
  flip(axis) {
    this.finishEdit();
    const items = this.selectedItems();
    const b = groupBox(items.map((i) => this.itemBox(i)));
    if (!b) return;
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const starts = items.map((i) => ({ ...i }));
    items.forEach((i, k) => Object.assign(i, flipItem(starts[k], c, axis, flipField(i, axis), this.itemHeight(starts[k]))));
    if (items.some((i, k) => CHANGE_KEYS.some((p) => JSON.stringify(i[p]) !== JSON.stringify(starts[k][p])))) this.commit();
  }

  // The group's rotate handle (§6d): the selection turns as one by the angle the pointer has turned about its group box's
  // centre since the press, in whole degrees; Shift: 15° steps.
  turnGroup(g, e) {
    const c = { x: g.group.x + g.group.w / 2, y: g.group.y + g.group.h / 2 };
    const angle = (p) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
    const d = angle(this.local(e)) - angle(g.p0);
    g.delta = e.shiftKey ? Math.round(d / 15) * 15 : Math.round(d);
    this.turnItems(g.moving, g.starts, g.delta);
  }

  // Ctrl+Shift+C: the one selected item's visual keys (a connector: also each label's size, colour and bold).
  copyStyle() {
    const item = this.selected();
    const keys = STYLE_KEYS[item?.type];
    if (!keys) return;
    const style = structuredClone(Object.fromEntries(keys.filter((k) => item[k] !== undefined).map((k) => [k, item[k]])));
    const labels = Object.fromEntries(Object.entries(item.labels ?? {}).map(([s, l]) => [s, { size: l.size, textColor: l.textColor, bold: l.bold }]));
    styleClipboard = { unit: this.unit, style, labels };
  }

  // Ctrl+Shift+V: the copied keys each selected item's type has (sizes converted to this board's unit, §6c Units); a
  // connector's labels take the copied style of the same slot.
  pasteStyle() {
    const clip = styleClipboard;
    if (!clip) return;
    this.finishEdit();
    const k = this.unit / clip.unit;
    const items = this.selectedItems().filter((i) => STYLE_KEYS[i.type]);
    for (const i of items) {
      for (const key of STYLE_KEYS[i.type]) {
        if (key in clip.style) i[key] = UNIT_KEYS.includes(key) ? r2(clip.style[key] * k) : structuredClone(clip.style[key]);
      }
      if (i.type !== 'connector') continue;
      i.labels = Object.fromEntries(Object.entries(i.labels ?? {}).map(([s, l]) => {
        const c = clip.labels[s];
        return [s, c ? { ...l, ...c, size: r2((c.size ?? 14) * k) } : l];
      }));
    }
    if (items.length) this.commit();
  }

  // Adds copies of `sources` offset by 20 px, or with their group's top-left at `at` (a placed prefab: its own undo step),
  // kept inside the board together, and selects them; one commit.
  addCopies(sources, at = null) {
    this.finishEdit();
    const copies = cloneItems(sources, newId, this.items); // connectors between copies follow them; ends outside become free
    const box = at && groupBox(copies.map((i) => this.itemBox(i)));
    this.moveBy(copies, box ? Math.round(at.x - box.x) : 20, box ? Math.round(at.y - box.y) : 20);
    this.items.push(...copies);
    this.sel = new Set(copies.map((i) => i.id));
    this.commit(!!at);
    this.dom.focus({ preventScroll: true });
    return copies;
  }

  // --- spawning (§6c, §6g): every new item is the selection and the tool is Select, so the next drag moves or resizes it ---

  // Call before the commit that adds items `ids` (pen and eraser strokes stay continuous and do not call it).
  spawned(ids) {
    if (this.mode && !this.keeps()) this.setMode(null);
    this.sel = new Set(ids);
  }

  // Keep tool on (§6c Spawning): the tool stays on after it adds items, except Add image.
  keeps() {
    return keepTool && this.mode !== 'image';
  }

  // The box of a click-placed shape of `tool` (board px): 160 × 110 post px or its kind's own (a horizontal one for lines /
  // arrows), centred at p.
  clickBox(tool, { x, y }) {
    const [bw, bh] = kindOf(tool.shape)?.box ?? [160, 110];
    const [hw, hh] = [(bw / 2) * this.unit, (bh / 2) * this.unit];
    return isLineish(tool.shape)
      ? shapeBox({ x: x - hw, y }, { x: x + hw, y }, false, tool)
      : shapeBox({ x: x - hw, y: y - hh }, { x: x + hw, y: y + hh }, false, tool);
  }

  // New items for a shape list tile `what`, their group centred at board point p: {kind} a shape in the shape tool's style
  // at its click size; {conn} a free horizontal connector of 160 post px in the connector tool's style patched with conn;
  // {note} a text item (note colour, or null for none); {items} copies of these items (board px: a prefab's).
  spawnItems(what, p) {
    let items;
    if (what.items) items = cloneItems(what.items, newId);
    else if (what.kind) {
      const tool = { ...this.tool(shapeTool), shape: what.kind };
      items = [{ id: newId(), type: 'shape', ...tool, ...this.clickBox(tool, { x: 0, y: 0 }) }];
    } else if (what.conn) {
      const half = 80 * this.unit;
      items = resolveConnectors([{ ...this.newConnector({ x: -half, y: 0 }, { x: half, y: 0 }), ...structuredClone(what.conn) }]).items;
    } else items = [this.textItem({ x: 0, y: 0 }, what.note ?? null)];
    const b = groupBox(items.map((i) => this.itemBox(i)));
    return items.map((i) => moveItem(i, Math.round(p.x - b.x - b.w / 2), Math.round(p.y - b.y - b.h / 2)));
  }

  // Adds tile `what` centred at board point p, selected; one undo step. A text item is edited at once.
  insert(what, p) {
    this.finishEdit();
    const items = this.spawnItems(what, p);
    this.items.push(...items);
    this.spawned(items.map((i) => i.id));
    this.commit(true);
    this.dom.focus({ preventScroll: true });
    if (items.length === 1 && items[0].type === 'text') this.startEdit(items[0].id);
    return items;
  }

  // A tile dragged out of a shape list and released (pointer event `e`): over this board or its host's drop area (the library
  // editor's whole view), added centred at the snapped pointer → true; elsewhere nothing → false.
  drop(what, e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !(this.owns(el) || this.host.dropArea?.()?.contains(el))) return false;
    this.insert(what, this.snapped(e));
    this.pin(e);
    return true;
  }

  // A see-through picture of tile `what` as this board would add it, at its on-screen size (fixed, at 0,0; a drag moves it
  // with a translate centred on the pointer and removes it).
  ghost(what) {
    const items = this.spawnItems(what, { x: 0, y: 0 });
    const b = groupBox(items.map((i) => this.itemBox(i)));
    const s = this.scale();
    const el = make('div', 'wb-ghost');
    el.style.cssText = `position:fixed;left:0;top:0;z-index:60;pointer-events:none;opacity:.6;width:${b.w * s}px;height:${b.h * s}px`;
    drawCanvas(el, { aw: b.w, ah: b.h, bg: 'transparent', items: items.map((i) => moveItem(i, -b.x, -b.y)) }).style.transform = `scale(${s})`;
    return el;
  }

  // The item ribbon's place (§6c): where the pointer left the current selection, in board px (it follows scroll and zoom).
  pin(e) {
    this.anchor = { ...localPoint(this.dom, e), sel: [...this.sel].join() };
    this.emit();
  }

  // That point in client px while the selection is still the one it was pinned for; null after a keyboard selection.
  ribbonAnchor() {
    const a = this.anchor;
    if (!a || a.sel !== [...this.sel].join()) return null;
    const r = this.dom.getBoundingClientRect();
    const s = this.scale();
    return { x: r.left + a.x * s, y: r.top + a.y * s };
  }

  // Duplicate (Ctrl+J), copy / cut and remove act on every selected item.
  duplicate() {
    const items = this.selectedItems();
    if (items.length) this.addCopies(items);
  }

  copyItem(cut = false) {
    const items = this.selectedItems();
    if (!items.length) return;
    // Copies (cloneItems): a group copied in part loses its id here, wherever it is pasted.
    itemClipboard = { token: `daf-writer-item:${newId()}`, unit: this.unit, items: cloneItems(items, newId, this.items) };
    navigator.clipboard.writeText(itemClipboard.token).catch((err) => console.warn('Clipboard write failed:', err));
    if (cut) this.removeItem();
  }

  pasteItem() {
    if (!itemClipboard) return;
    // From a board of another unit: the clipboard takes this board's, so the copies keep their look in post px (§6c Units).
    const k = this.unit / itemClipboard.unit;
    if (k !== 1) Object.assign(itemClipboard, { unit: this.unit, items: itemClipboard.items.map((i) => scaleItem(i, k)) });
    const { items } = itemClipboard;
    if (!items?.length) return;
    // Advance the clipboard items with the copies so repeated pastes cascade instead of stacking on one spot.
    const [s, c] = [items[0], this.addCopies(items)[0]];
    const [dx, dy] = [c.x - s.x, c.y - s.y];
    for (const i of itemClipboard.items) Object.assign(i, moveItem(i, dx, dy));
  }

  removeItem() {
    if (!this.sel.size) return;
    if (this.sel.has(this.editingId)) {
      this.editingId = this.editingSlot = null; // let setAttrs() re-render the board without the edited element
      this.savedRange = null;
    }
    this.items = unbindFrom(this.items, this.sel); // connector ends on removed items become free where they were
    this.sel = new Set();
    this.commit();
  }

  // --- connectors and labels (§6d) ---

  // A connector from end `from` to end `to` in the connector tool's style (at this board's unit; colour by theme if unset).
  newConnector(from, to) {
    const t = this.tool(connTool);
    return {
      id: newId(), type: 'connector', from, to, route: t.route, corner: t.corner, points: [], heads: { ...t.heads }, color: t.color ?? ink(),
      width: t.width, opacity: t.opacity, dash: t.dash, jump: t.jump, labels: {},
    };
  }

  // The selected connectors (the ribbon's Reverse and Straighten act on them).
  selectedConnectors() {
    return this.selectedItems().filter((i) => i.type === 'connector');
  }

  // Reverse: ends, heads and waypoints swap; every label keeps its place. One commit.
  reverseConnector() {
    this.finishEdit(); // first: its commit re-renders, replacing the item objects
    const list = this.selectedConnectors();
    if (!list.length) return;
    for (const c of list) Object.assign(c, reverseConnector(c));
    this.commit();
  }

  // Straighten: the selected connectors lose their waypoints. One commit.
  straighten() {
    const list = this.selectedConnectors().filter((c) => c.points?.length);
    if (!list.length) return;
    for (const c of list) c.points = [];
    this.commit();
  }

  // Edits the label in `slot` of connector `id`; a missing one is added first ("Label", selected so typing replaces it) at
  // fraction `at` of the path (default: the slot's), in the theme's text colour, as its own undo step.
  editLabel(id, slot, at = null) {
    this.finishEdit(); // first: its commit re-renders, replacing the item objects
    const c = this.items.find((i) => i.id === id);
    if (c?.type !== 'connector') return;
    if (!c.labels?.[slot]) {
      const l = { html: 'Label', t: at ?? LABEL_SLOTS[slot], dx: 0, dy: 0, size: r2(14 * this.unit), textColor: this.inkOf(), bold: false };
      c.labels = { ...c.labels, [slot]: l };
      this.sel = new Set([id]);
      this.commit(true);
    }
    this.startEdit(id, slot);
  }

  // The Labels popover's checkbox: on adds the slot's label and edits it, off removes it. One commit each.
  toggleLabel(slot, on) {
    const c = this.selected();
    if (c?.type !== 'connector') return;
    if (on) return this.editLabel(c.id, slot);
    this.finishEdit();
    const live = this.selected();
    if (!live?.labels?.[slot]) return;
    const { [slot]: _, ...rest } = live.labels;
    live.labels = rest;
    this.commit();
  }

  // Style of the selected connector's label in `slot` ({size (post px), textColor, bold}). Mid-edit of that label: the
  // live text takes the style and keeps what was typed.
  setLabel(slot, patch) {
    const c = this.selected();
    const l = c?.type === 'connector' && c.labels?.[slot];
    if (!l) return;
    const next = { ...l, ...patch, ...('size' in patch && { size: r2(patch.size * this.unit) }) };
    const text = c.id === this.editingId && slot === this.editingSlot ? this.editText() : null;
    if (text) {
      styleText(text, { size: next.size, color: next.textColor, bold: !!next.bold, align: 'center', bg: null });
      Object.assign(text.style, { whiteSpace: 'pre', padding: `${LABEL_PAD.y}px ${LABEL_PAD.x}px`, background: 'var(--wb-bg, transparent)' });
      next.html = labelHtml(text) || l.html;
    }
    c.labels = { ...c.labels, [slot]: next };
    this.commit();
    if (text) this.restoreCaret(text);
  }

  // Double-click on a waypoint handle: that bend goes. One commit.
  removeWaypoint(c, k) {
    c.points = (c.points ?? []).filter((_, j) => j !== k);
    this.commit();
  }

  // Quick-connect (click on a dot, Ctrl+Arrow): a copy of the one selected item 60 post px past its side facing board
  // direction `dir` (n e s w), joined from that side to the copy's opposite side by a connector in the tool's style; the copy
  // is selected (so the next Ctrl+Arrow goes on from it). One commit.
  cloneConnect(dir) {
    const src = this.selected();
    if (!src || src.type === 'connector' || src.type === 'stroke') return;
    this.finishEdit();
    const side = sideToward((a) => portNormal(src, a), dir);
    const box = this.itemBox(src);
    const gap = Math.round(60 * this.unit);
    const off = { n: [0, -(box.h + gap)], s: [0, box.h + gap], e: [box.w + gap, 0], w: [-(box.w + gap), 0] }[dir];
    const [copy] = cloneItems([src], newId);
    Object.assign(copy, moveItem(copy, ...off));
    this.items.push(copy, this.newConnector({ item: src.id, anchor: [...SIDES[side]] }, { item: copy.id, anchor: [...SIDES[OPPOSITE[side]]] }));
    this.sel = new Set([copy.id]);
    this.commit(true);
    this.dom.focus({ preventScroll: true });
  }

  // Alt+Arrow: selects the item joined to the selected one by a connector that lies most in board direction `dir`.
  goConnected(dir) {
    const src = this.selected();
    if (!src) return;
    const ids = new Set();
    for (const c of this.items) {
      if (c.type !== 'connector') continue;
      if (c.from.item === src.id && typeof c.to.item === 'string') ids.add(c.to.item);
      if (c.to.item === src.id && typeof c.from.item === 'string') ids.add(c.from.item);
    }
    ids.delete(src.id);
    const centre = (i) => {
      const b = this.itemBox(i);
      return { id: i.id, x: b.x + b.w / 2, y: b.y + b.h / 2 };
    };
    const id = pickInDirection(centre(src), this.items.filter((i) => ids.has(i.id) && selectable(i)).map(centre), dir);
    if (id) this.selectUnit(id); // a group as one (§6c Groups)
  }

  // Shows sticking target `hit` ({item, anchor} | null): the item outlined and its ports as dots (children of its element,
  // so they turn with it), the port in use filled.
  showTarget(hit) {
    const key = hit ? `${hit.item}|${hit.anchor}` : '';
    if (key === this.targetKey) return;
    this.targetKey = key;
    for (const el of this.layer.querySelectorAll(':scope > .wb-target')) el.classList.remove('wb-target');
    for (const el of this.layer.querySelectorAll(':scope > * > .wb-port')) el.remove();
    const item = hit && this.items.find((i) => i.id === hit.item);
    const el = item && this.itemEl(item.id);
    if (!el) return;
    el.classList.add('wb-target');
    const b = this.measure(item);
    const flat = { ...item, rot: 0 }; // the element turns the dots
    for (const a of portsOf(item)) {
      const q = anchorPoint(flat, a, b);
      const dot = make('div', 'wb-port');
      Object.assign(dot.style, { left: `${q.x - b.x}px`, top: `${q.y - b.y}px` });
      dot.classList.toggle('on', !!hit.anchor && hit.anchor[0] === a[0] && hit.anchor[1] === a[1]);
      el.append(dot);
    }
  }

  // The ids connector ends never stick to: strokes (a freehand box is no node), hidden and locked items (§6 Layer fields) and
  // `skip`.
  noTargets(skip = null) {
    return new Set(this.items.filter((i) => i.type === 'stroke' || !selectable(i) || i.id === skip).map((i) => i.id));
  }

  // Where a dragged connector end goes (§6d Sticking): onto the topmost item under the pointer, at a port within 12 screen
  // px (fixed anchor) or anywhere inside its outline (floating); Alt: never. Else a free point, snapped (not with Ctrl).
  // The target shows its ports meanwhile.
  stickEnd(g, e) {
    if (e.altKey) this.altUsed = true; // releasing Alt must not open the window menu
    const hit = e.altKey ? null : hitTarget(this.items, this.local(e), { exclude: g.exclude, tol: 12 / this.scale(), measure: this.measure });
    this.showTarget(hit);
    if (hit && e.shiftKey) { // Shift: pinned, the tip at this very point of the item (it follows the item, §6d)
      const it = this.items.find((i) => i.id === hit.item);
      const b = { x: it.x, y: it.y, w: it.w, h: this.itemHeight(it) };
      const p = rotatePoint(this.local(e), { x: b.x + b.w / 2, y: b.y + b.h / 2 }, -rotOf(it));
      const frac = (v) => Math.round(fit(v, 0, 1) * 10000) / 10000;
      return { item: it.id, anchor: [frac((p.x - b.x) / b.w), frac((p.y - b.y) / b.h)], pin: true };
    }
    if (hit) return hit;
    const p = this.pointAt(e, g);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  // The connector tool's drag (also a quick-connect dot's): from `from` (default: where it starts, sticking) to the
  // pointer; a preview routed against the items follows it. `skip`: an item the ends never stick to (the dot's item).
  startConnector(e, from = null, skip = null) {
    const g = this.gesture;
    g.exclude = this.noTargets(skip);
    g.conn = { ...this.newConnector(from ?? this.stickEnd(g, e), null), id: 'preview' };
    this.extendConnector(g, e);
  }

  extendConnector(g, e) {
    g.conn.to = this.stickEnd(g, e);
    const { items, geo } = resolveConnectors([...this.items, g.conn], this.measure, new Set(['preview']));
    const c = items.find((i) => i.id === 'preview');
    g.geo = geo.get('preview');
    const el = itemElement(c);
    if (g.preview) g.preview.replaceWith(el);
    else this.layer.append(el);
    g.preview = el;
    g.box = { x: c.x, y: c.y, w: c.w, h: c.h }; // the artboard / board grows live to hold it
  }

  // Release: a connector at least 8 screen px long is added (one commit; selected, the tool back to Select). A quick-connect
  // dot clicked without a drag adds a connected copy instead.
  finishConnector(g) {
    g.preview?.remove();
    this.showTarget(null);
    if (g.qc && (!g.last || Math.hypot(g.last.clientX - g.x, g.last.clientY - g.y) < 4)) {
      // The board direction the dot's side faces (a turned shape's sides turn with it).
      const n = portNormal(g.qc.item, SIDES[g.qc.side]);
      this.cloneConnect(Math.abs(n.x) >= Math.abs(n.y) ? (n.x > 0 ? 'e' : 'w') : n.y > 0 ? 's' : 'n');
      return;
    }
    // Both ends on one item at one anchor (a click or a drag inside it): no loop (an elbow route would be 40 px long).
    const [f, t] = [g.conn.from, g.conn.to];
    if (typeof f.item === 'string' && f.item === t.item && JSON.stringify(f.anchor) === JSON.stringify(t.anchor)) return;
    const pts = g.geo?.pts ?? [];
    const len = pts.slice(1).reduce((s, p, k) => s + Math.hypot(p.x - pts[k].x, p.y - pts[k].y), 0);
    if (len * this.scale() < 8) return;
    const id = newId();
    this.items.push({ ...g.conn, id });
    this.spawned([id]);
    this.commit(true);
  }

  // One step of a gesture on a selected connector's part: an end ('end', re-sticking), a waypoint ('wp'), a segment
  // ('seg': ortho moves it across, keeping its corners as waypoints; straight / curve drags out a new waypoint) or a
  // label ('label': along the path, t, and beside it, dx / dy). The caller re-routes it.
  followConnector(g, e) {
    const c = g.moving[0];
    if (c?.type !== 'connector') return;
    if (g.kind === 'end') c[g.endK ? 'to' : 'from'] = this.stickEnd(g, e);
    else if (g.kind === 'wp') {
      const p = this.pointAt(e, g);
      c.points = c.points.map((q, k) => (k === g.k ? { x: Math.round(p.x), y: Math.round(p.y) } : q));
    } else if (g.kind === 'seg' && g.pts0) {
      const p = this.local(e);
      const axis = g.dir === 'h' ? 'y' : 'x';
      let v = Math.round(p[axis] - g.p0[axis]);
      v += this.snapHit(g, axis, [g.pts0[g.k][axis] + v], e)?.d ?? 0;
      c.points = dragSegment(g.points0, g.pts0, g.k, axis === 'x' ? { x: v, y: 0 } : { x: 0, y: v });
    } else if (g.kind === 'seg') {
      const p = this.pointAt(e, g);
      c.points = [...g.points0.slice(0, g.k), { x: Math.round(p.x), y: Math.round(p.y) }, ...g.points0.slice(g.k)].slice(0, MAX_POINTS);
    } else if (g.kind === 'label') {
      const l = c.labels?.[g.slot];
      const pts = this.geo.get(c.id)?.pts;
      if (!l || !pts) return;
      const p = this.local(e);
      const at = { x: p.x + g.grab.x, y: p.y + g.grab.y }; // where the label's anchor goes (the pointer keeps its grip)
      const t = nearestT(pts, at);
      const q = polylinePoint(pts, t);
      c.labels = { ...c.labels, [g.slot]: { ...l, t: Math.round(t * 1000) / 1000, dx: Math.round(at.x - q.x), dy: Math.round(at.y - q.y) } };
    }
  }

  // Release of a connector part: bends left on a straight line between their neighbours go (within 2 px); a label let go
  // within 8 screen px of the line sits on it (dx = dy = 0).
  settleConnector(g) {
    const c = g.moving[0];
    if (c?.type !== 'connector') return;
    const tips = this.geo.get(c.id)?.tipsAbs;
    if ((g.kind === 'seg' || g.kind === 'wp') && tips) c.points = cleanPoints(c.points, tips);
    const l = g.kind === 'label' && c.labels?.[g.slot];
    if (l && Math.hypot(l.dx, l.dy) * this.scale() < 8) c.labels = { ...c.labels, [g.slot]: { ...l, dx: 0, dy: 0 } };
  }

  // `pending`: the files an 'image' mode places, the prefab a 'shape' mode places (§6g); any mode change drops them.
  setMode(mode, pending = null) {
    this.mode = mode;
    this.pending = pending;
    this.finishEdit();
    this.showTarget(null);
    this.select(null);
    this.dom.classList.toggle('wb-drawing', !!mode);
    this.dom.classList.toggle('wb-place-text', mode === 'text');
    this.dom.focus({ preventScroll: true });
    updateActive();
    this.emit();
  }

  startStroke(e) {
    const ink = this.tool(pen);
    const path = svgEl('path', inkAttrs(ink));
    const svg = svgEl('svg', { width: '100%', height: '100%', overflow: 'visible' });
    svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
    svg.append(path);
    this.layer.append(svg);
    const pad = ink.width / 2 + 1; // the bbox padding
    const p = this.pointAt(e);
    Object.assign(this.gesture, { ink, points: [p], path, pad, box: { x: p.x - pad, y: p.y - pad, w: 2 * pad, h: 2 * pad } });
    path.setAttribute('d', smoothPath(this.gesture.points));
  }

  extendStroke(g, e) {
    // Coalesced events carry the samples the browser merged into this frame's pointermove.
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const p = this.pointAt(ev);
      const last = g.points.at(-1);
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5) continue;
      g.points.push(p);
      g.box = boxUnion(g.box, { x: p.x - g.pad, y: p.y - g.pad, w: 2 * g.pad, h: 2 * g.pad });
    }
    g.path.setAttribute('d', smoothPath(g.points));
  }

  finishStroke(g) {
    g.path.parentNode.remove();
    const { pad } = g;
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { x, y } of g.points) {
      [minX, minY, maxX, maxY] = [Math.min(minX, x), Math.min(minY, y), Math.max(maxX, x), Math.max(maxY, y)];
    }
    const x = Math.floor(minX - pad);
    const y = Math.floor(minY - pad);
    const w = Math.ceil(maxX + pad) - x;
    const h = Math.ceil(maxY + pad) - y;
    const d = smoothPath(g.points.map((p) => ({ x: p.x - x, y: p.y - y })));
    this.items.push({ id: newId(), type: 'stroke', x, y, w, h, vw: w, vh: h, d, ...g.ink });
    this.commit(true);
  }

  startShape(e) {
    const g = this.gesture;
    g.tool = this.tool(shapeTool);
    g.start = this.pointAt(e, g);
    this.extendShape(g, e);
  }

  extendShape(g, e) {
    g.end = this.pointAt(e, g);
    g.box = shapeBox(g.start, g.end, e.shiftKey, g.tool);
    const el = itemElement({ ...g.tool, ...g.box, id: 'preview', type: 'shape' });
    if (g.preview) g.preview.replaceWith(el);
    else this.layer.append(el);
    g.preview = el;
  }

  finishShape(g) {
    g.preview?.remove();
    // A click without a drag drops a default-size shape centred at the click.
    const box = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) < 6 ? this.clickBox(g.tool, g.start) : g.box;
    const item = { id: newId(), type: 'shape', ...g.tool, ...box };
    this.items.push(item);
    this.spawned([item.id]);
    this.commit(true);
  }

  // Hit-test along the pointer's path (not just at the sampled points) so fast drags miss nothing.
  eraseTo(g, clientX, clientY) {
    const steps = Math.max(1, Math.ceil(Math.hypot(clientX - g.x, clientY - g.y) / 4));
    for (let i = 1; i <= steps; i++) {
      const hit = document.elementFromPoint(g.x + ((clientX - g.x) * i) / steps, g.y + ((clientY - g.y) * i) / steps);
      const el = hit?.closest('.wb-stroke');
      if (!el || !this.layer.contains(el)) continue;
      g.erased.add(el.dataset.id);
      el.style.display = 'none'; // also lets the next hit-test reach strokes underneath
    }
    g.x = clientX;
    g.y = clientY;
  }

  // Edits a text item, a shape's label (an empty one is created for the edit, in the theme's text colour) or the label in
  // `slot` of a connector (§6d). The text being typed is never the scroll anchor (CSS overflow-anchor): Chromium anchors on
  // the focused editable, and a label growing around its middle would scroll the whole view by half of each new line.
  startEdit(id, slot = null) {
    const item = this.items.find((i) => i.id === id);
    const el = this.itemEl(id);
    if (item?.type === 'shape' && el && !this.editText(id)) {
      if (item.textColor == null) item.textColor = this.inkOf(item);
      if (item.size == null) item.size = r2(LABEL.size * this.unit);
      el.append(shapeLabel({ ...item, html: '' }, pageTheme(), this.surface()));
    }
    const text = this.editText(id, slot);
    if (!text) return;
    this.editingId = id;
    this.editingSlot = slot;
    this.editH = item?.h;
    text.contentEditable = 'true';
    text.focus();
    document.getSelection().selectAllChildren(text);
    text.oninput = () => {
      if (item?.type === 'shape') this.growLabel(item, text);
      if (!slot) this.autoSize(); // the board grows with the text (committed when the edit ends); a connector label: at the commit
      this.emit(); // the ribbon follows the growing text
    };
    this.emit();
    // Plain text only (rich markup and remote <img> break the export); pasted images become board items.
    text.onpaste = (e) => {
      e.preventDefault();
      if (!this.pasteData(e.clipboardData)) document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    };
  }

  // A shape label grows its shape while typed: the height that holds it inside the kind's label inset (a lane's band is
  // fixed). Its bound connectors follow live.
  growLabel(item, text) {
    const k = kindOf(item.shape);
    if (k?.band) return;
    const need = Math.ceil(text.offsetHeight / (1 - 2 * (k?.labelInset?.y ?? 0.08)));
    if (need <= item.h) return;
    item.h = need;
    placeItem(this.itemEl(item.id), item);
    this.refreshConnectors({ conns: this.attached([item]) });
  }

  finishEdit() {
    const [id, slot] = [this.editingId, this.editingSlot];
    if (!id) return;
    const fresh = id === this.newText?.id; // the first edit of a text addText placed
    const undoable = fresh && this.newText.alone && !this.stale; // the last undo step is its placement
    this.newText = null;
    this.editingId = this.editingSlot = null;
    this.savedRange = null;
    this.emit();
    let text = this.editText(id, slot);
    if (text) text.contentEditable = 'false';
    const label = !!text?.closest('.wb-label, .wb-conn');
    const typed = text ? (label ? labelHtml(text) : text.innerHTML) : undefined;
    if (this.stale) {
      // The document changed mid-edit (e.g. the toolbar's Undo): draw it, keeping the typed text if the item is still there.
      this.render();
      text = this.editText(id, slot);
      if (text && typed !== undefined && !label) text.innerHTML = typed;
    }
    const item = this.items.find((i) => i.id === id);
    if (!item || typed === undefined) return;
    if (item.type === 'connector') {
      // A label left empty goes.
      const l = item.labels?.[slot];
      if (!l || typed === l.html) return;
      const { [slot]: _, ...rest } = item.labels;
      item.labels = typed ? { ...rest, [slot]: { ...l, html: typed } } : rest;
    } else if (item.type === 'shape') {
      if (typed === (item.html ?? '') && item.h === this.editH) {
        if (!typed) text?.closest('.wb-label')?.remove(); // the empty label made for the edit
        return;
      }
      item.html = typed;
    } else if (fresh && ['', 'Text'].includes(text?.textContent.trim())) {
      // A new text still "Text" or emptied goes (§6c Placement tools): its placement is undone, so no undo step is left.
      // Returns true then (Board.undo / redo take it as their step).
      if (undoable) {
        this.host.undo();
        return true;
      }
      this.items = unbindFrom(this.items, new Set([id]));
    } else {
      if (!text || typed === item.html) return;
      item.html = typed;
    }
    this.commit();
  }

  saveRange = () => {
    const sel = document.getSelection();
    const text = this.editText();
    if (text && sel.rangeCount && text.contains(sel.anchorNode)) this.savedRange = sel.getRangeAt(0).cloneRange();
  };

  restoreCaret(text) {
    text.focus({ preventScroll: true });
    if (!this.savedRange || !text.contains(this.savedRange.startContainer)) return;
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(this.savedRange);
  }

  // --- events ---

  // Editing ends when focus leaves the board; board chrome keeps the edit open.
  onFocusOut = (e) => {
    if (this.editingId && !this.owns(e.relatedTarget) && !isChrome(e.relatedTarget)) this.finishEdit();
  };

  onPointerDown = (e) => {
    // A right-click while a popup is open only closes it (onContextMenu opens no menu then): Radix closes it right after this.
    if (e.button === 2) this.menuDismissed = dismissOnly(e);
    if (e.button !== 0 || dismissOnly(e, !!this.mode)) return;
    if (this.editingId && this.editText()?.contains(e.target)) return; // caret placement in the text being edited, also with a tool on
    if (this.mode) {
      this.finishEdit();
      e.preventDefault();
      this.dom.focus({ preventScroll: true });
      if (['text', 'image'].includes(this.mode) || (this.mode === 'shape' && this.pending)) return this.place(e);
      this.startGesture(e, this.mode, []);
      if (this.mode === 'pen') this.startStroke(e);
      else if (this.mode === 'shape') this.startShape(e);
      else if (this.mode === 'connector') this.startConnector(e);
      else this.eraseTo(Object.assign(this.gesture, { erased: new Set() }), e.clientX, e.clientY);
      this.showGuides(this.gesture.guides);
      return;
    }
    if (e.target.parentElement === this.groupEl) { // the group's rotate handle (§6d group turn)
      this.finishEdit();
      this.dom.focus({ preventScroll: true });
      this.startGesture(e, 'turn', this.selectedItems());
      return;
    }
    const itemEl = e.target.closest('.wb-item');
    if (!itemEl) {
      this.finishEdit();
      this.startGesture(e, 'marquee'); // a drag selects what it touches, a click deselects (finishMarquee)
      return;
    }
    // A resize handle (corner or edge) or a rotate zone ('rot').
    const corner = [...CORNERS, ...EDGES].find((c) => e.target.classList.contains(`wb-h-${c}`))
      ?? (e.target.classList.contains('wb-rot') ? 'rot' : e.target.classList.contains('wb-tip') ? 'tip' : undefined);
    const id = itemEl.dataset.id;
    this.finishEdit();
    if (!this.items.some((i) => i.id === id)) return; // a new text left untouched went (finishEdit)
    if (this.connectorPart(e, id)) return;
    // A click selects the item's unit: its outermost group at the scope, or the item (§6c Groups); Ctrl + click in a group the
    // item itself (deep select, at once). Shift + click adds the unit to the selection, or takes a selected one out on release
    // (so Shift + drag still moves it). Pressing one of several selected units moves them all; released without a drag, only
    // its unit stays selected.
    const unit = unitOf(this.items, id, this.scope);
    const deep = (e.ctrlKey || e.metaKey) && unit.group;
    const ids = deep ? [id] : unit.ids;
    let click = null; // the selection a release without a drag leaves
    if (!this.sel.has(id) || (deep && !e.shiftKey)) {
      if (!e.shiftKey) this.scope = deep ? this.items.find((i) => i.id === id).groups[0] : unit.scope;
      this.select(e.shiftKey ? [...this.sel, ...ids] : ids);
    } else if (e.shiftKey && !corner) click = [...this.sel].filter((s) => !ids.includes(s));
    else if (this.sel.size > 1) click = ids;
    this.dom.focus({ preventScroll: true });
    const crop = corner && (e.ctrlKey || e.metaKey) && this.selected()?.type === 'image';
    // A label of the one selected connector drags along / beside its path (§6d; the pointer keeps its grip on it); in a
    // multi-selection it moves the group.
    const slot = !corner && this.selectedId === id && e.target.closest('.wb-conn > .wb-text[data-slot]')?.dataset.slot;
    this.startGesture(e, slot ? 'label' : crop ? 'crop' : corner === 'rot' ? 'rotate' : corner === 'tip' ? 'tip' : corner ? 'resize' : 'move');
    Object.assign(this.gesture, { corner, copy: !corner && !slot && e.altKey, click, slot, tip: Number(e.target.dataset.tip) });
    const c = slot && this.selected();
    if (c?.lps?.[slot]) this.gesture.grab = { x: c.x + c.lps[slot].x - this.gesture.p0.x, y: c.y + c.lps[slot].y - this.gesture.p0.y };
  };

  // A pointer-down on a quick-connect dot (a connector drag from that side; a click adds a connected copy) or on a handle
  // of the selected connector (an end, a segment, a waypoint) starts that gesture → true.
  connectorPart(e, id) {
    const part = e.target.closest('.wb-qc, .wb-end, .wb-mid, .wb-wp');
    const item = part && this.selectedId === id ? this.selected() : null;
    if (!item) return false;
    this.dom.focus({ preventScroll: true });
    if (part.classList.contains('wb-qc')) {
      const side = part.dataset.side;
      this.startGesture(e, 'connector', []);
      this.gesture.qc = { item, side };
      this.startConnector(e, { item: id, anchor: [...SIDES[side]] }, id);
      return true;
    }
    const kind = part.classList.contains('wb-end') ? 'end' : part.classList.contains('wb-wp') ? 'wp' : 'seg';
    this.startGesture(e, kind, [item]);
    const g = this.gesture;
    Object.assign(g, { endK: Number(part.dataset.end), k: Number(part.dataset.k), exclude: this.noTargets() });
    if (kind === 'seg') {
      g.points0 = (item.points ?? []).map((p) => ({ ...p }));
      if ((item.route ?? 'ortho') === 'ortho') {
        g.pts0 = this.geo.get(id).pts.map((p) => ({ ...p }));
        g.dir = part.classList.contains('h') ? 'h' : 'v';
      }
    }
    return true;
  }

  // The board menu (§6c) in place of Electron's native menu, except over the text being edited (its spelling menu). A
  // right-click leaves the tool; on an item outside the selection it selects that item's unit alone, elsewhere it keeps the
  // selection.
  onContextMenu = (e) => {
    if (this.editingId && this.editText()?.contains(e.target)) return;
    e.preventDefault();
    if (this.menuDismissed || this.gesture) {
      this.menuDismissed = false;
      return;
    }
    this.finishEdit();
    if (this.mode) this.setMode(null);
    const id = e.target.closest('.wb-item')?.dataset.id;
    if (id && !this.sel.has(id)) this.selectUnit(id); // a group as one (§6c Groups)
    this.dom.focus({ preventScroll: true });
    boardMenu.open(this, { x: e.clientX, y: e.clientY });
  };

  // Keep focus on the editor (not the board) when the empty board area is clicked.
  onMouseDown = (e) => {
    if (e.target === this.dom || e.target === this.layer) e.preventDefault();
  };

  // Gestures work in board px from the pointer's board position at the start (p0), so scrolling or zooming during a
  // gesture keeps the item under the pointer.
  // `moving`: the items the gesture changes (default: move, the selection; resize / crop / a connector part, the one item).
  startGesture(e, kind, moving = kind === 'move' ? this.selectedItems() : [this.selected()].filter(Boolean)) {
    if (kind === 'move' && !e.altKey) moving = this.withContents(moving);
    const others = this.items.filter((i) => !moving.includes(i) || (kind === 'move' && e.altKey)); // Alt + drag: the originals stay
    this.gesture = {
      kind,
      pointerId: e.pointerId,
      p0: localPoint(this.dom, e),
      x: e.clientX, // eraser: the last client point; marquee: the start
      y: e.clientY,
      moving, // the items the gesture changes
      starts: moving.map((i) => ({ ...i })), // the same at the start
      group: groupBox(moving.map((i) => this.itemBox(i))), // their box at the start
      boxes: others.filter((i) => !i.hidden).map((i) => this.itemBox(i)), // snap targets (a locked item is one, §6 Layer fields)
      guides: [],
      last: null, // pointer state of the last move, replayed while auto-scrolling
      off: { x: 0, y: 0 }, // see local()
    };
    this.gesture.conns = this.attached(moving);
    this.dom.setPointerCapture(e.pointerId);
  }

  // `moving` plus what lies fully inside a moving lane or frame (§6d containment, by geometry at the drag's start): items by
  // their turned bounds, connectors by their box (so their bends move too); hidden and locked items stay. Nothing is re-parented.
  withContents(moving) {
    const take = new Set(moving);
    const live = this.items.filter(selectable);
    for (const box of moving.filter((i) => i.type === 'shape' && kindOf(i.shape)?.group === 'container')) {
      const ids = new Set(containedIn(box, live, this.measure));
      const c = this.itemBox(box);
      const inside = (b) => b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h;
      for (const i of live) if (ids.has(i.id) || (i.type === 'connector' && inside(this.itemBox(i)))) take.add(i);
    }
    return take.size === moving.length ? moving : this.items.filter((i) => take.has(i));
  }

  // The ids of the connectors among `moving` or bound to one of them: re-routed live while they change (§6d live path).
  attached(moving) {
    const index = boundIndex(this.items);
    return new Set(moving.flatMap((i) => [...(i.type === 'connector' ? [i.id] : []), ...(index.get(i.id) ?? [])]));
  }

  // Re-routes the gesture's connectors (against the items as they are now) and replaces their elements, and those of other
  // connectors whose line jumps changed. Their objects are updated in place: the gesture holds them.
  refreshConnectors(g) {
    if (!g.conns?.size) return;
    const { items, geo } = resolveConnectors(this.items, this.measure, g.conns);
    const byId = new Map(this.items.map((i) => [i.id, i]));
    for (const c of items) {
      if (!byId.has(c.id) || !(g.conns.has(c.id) || (c.type === 'connector' && c.d !== byId.get(c.id).d))) continue;
      Object.assign(byId.get(c.id), c);
      this.geo.set(c.id, geo.get(c.id));
      const old = this.itemEl(c.id);
      const el = this.addEl(byId.get(c.id));
      el.classList.toggle('wb-sel', this.sel.has(c.id));
      if (c.id === this.selectedId) this.decorate(el, byId.get(c.id)); // its handles follow
      old?.replaceWith(el);
    }
  }

  onPointerMove = (e) => {
    const g = this.gesture;
    if (!g) {
      // The connector tool shows where a drag would start sticking.
      if (this.mode === 'connector') this.showTarget(e.altKey ? null : hitTarget(this.items, this.local(e), { exclude: this.noTargets(), tol: 12 / this.scale(), measure: this.measure }));
      return this.refreshScale(); // the zoom may have changed since the handles were drawn
    }
    if (e.pointerId !== g.pointerId) return;
    if (!g.last) this.autoScroll(g); // the drag has begun
    g.last = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey, altKey: e.altKey };
    this.follow(g, e);
  };

  // One gesture step for pointer event `e` (or the last pointer state, while auto-scrolling).
  follow(g, e) {
    if (g.kind === 'marquee') return this.followMarquee(g, e);
    g.guides = [];
    if (g.kind === 'pen') this.extendStroke(g, e);
    else if (g.kind === 'shape') this.extendShape(g, e);
    else if (g.kind === 'connector') this.extendConnector(g, e);
    else if (g.kind === 'eraser') this.eraseTo(g, e.clientX, e.clientY);
    else {
      const p = this.local(e);
      const [dx, dy] = [p.x - g.p0.x, p.y - g.p0.y];
      if (['end', 'wp', 'seg', 'label'].includes(g.kind)) this.followConnector(g, e);
      else this.followItem(g, e, dx, dy);
      this.refreshConnectors(g);
    }
    this.autoSize(g.box, g); // live; the commit on pointerup stores it
    this.showGuides(g.guides);
    this.placeGroupBox();
  }

  // Past 4 screen px, a drag on empty board area draws the selection rectangle (kept inside the board).
  followMarquee(g, e) {
    if (!g.marquee && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return;
    g.marquee ??= this.layer.appendChild(make('div', 'wb-marquee'));
    const { w, h } = this.size();
    const p = this.local(e);
    g.rect = boxBetween(g.p0, { x: fit(p.x, 0, w), y: fit(p.y, 0, h) });
    placeItem(g.marquee, { ...g.rect, type: 'shape' });
  }

  // Release on empty board area: the units of the items the rectangle touches become the selection (Shift: are added; a group
  // whole at the scope, §6c Groups; hidden and locked items touch nothing); a click without a drag deselects (the host's
  // emptyClick).
  finishMarquee(g, add) {
    if (!g.marquee) {
      this.select(null);
      this.host.emptyClick();
      return;
    }
    g.marquee.remove();
    const live = this.items.filter(selectable);
    const [conns, rest] = [live.filter((i) => i.type === 'connector'), live.filter((i) => i.type !== 'connector')];
    const hits = [...marqueeHits(g.rect, rest.map((i) => ({ id: i.id, ...this.itemBox(i) }))),
      ...conns.filter((c) => polylineHitsRect(this.geo.get(c.id)?.pts ?? [], g.rect)).map((c) => c.id)] // by their line
      .flatMap((id) => unitOf(this.items, id, this.scope).ids);
    this.select(add ? [...this.sel, ...hits] : hits);
    this.dom.focus({ preventScroll: true });
  }

  // While a drag is near or beyond an edge of the scrolling area, scroll toward that edge every frame and keep the
  // gesture following the (possibly resting) pointer.
  autoScroll(g) {
    const tick = () => {
      if (this.gesture !== g || this.destroyed) return;
      const s = (g.scroller ??= scrollParent(this.dom));
      if (!s) return;
      const r = s.getBoundingClientRect();
      const { clientX: x, clientY: y } = g.last;
      const vx = s.scrollWidth > s.clientWidth ? edgeSpeed(r.right - x) - edgeSpeed(x - r.left) : 0;
      const vy = s.scrollHeight > s.clientHeight ? edgeSpeed(r.bottom - y) - edgeSpeed(y - r.top) : 0;
      // Not over chrome that takes board items (the shape panel's Prefabs): the drag is heading there, not past the edge.
      if ((vx || vy) && !document.elementFromPoint(x, y)?.closest('[data-board-drop]')) {
        s.scrollBy(vx, vy);
        this.follow(g, g.last);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Move: every selected item, by the move of their group box, which snaps. Resize / crop: the one selected item.
  followItem(g, e, dx, dy) {
    if (!g.moving.length) return;
    let box; // the changed box: its edges keep the guides
    if (g.kind === 'move') {
      if (g.copy && !g.copied) {
        // Alt + drag: copies move, the originals stay.
        g.copied = this.altCopied = true;
        g.moving = cloneItems(g.starts, newId, this.items);
        g.starts = g.moving.map((i) => ({ ...i }));
        this.items.push(...g.moving);
        this.layer.append(...g.moving.map((i) => this.addEl(i)));
        this.select(g.moving.map((i) => i.id));
        g.conns = this.attached(g.moving);
      }
      const lock = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'y' : 'x') : null; // Shift: that axis stays put
      const b = g.group;
      let x = b.x + (lock === 'x' ? 0 : dx);
      let y = b.y + (lock === 'y' ? 0 : dy);
      if (lock !== 'x') x += this.snapHit(g, 'x', [x, x + b.w / 2, x + b.w], e)?.d ?? 0;
      if (lock !== 'y') y += this.snapHit(g, 'y', [y, y + b.h / 2, y + b.h], e)?.d ?? 0;
      const d = { dx: Math.round(x) - b.x, dy: Math.round(y) - b.y };
      g.moving.forEach((i, k) => {
        Object.assign(i, moveItem(g.starts[k], d.dx, d.dy));
        const el = this.itemEl(i.id);
        if (el) placeItem(el, i);
      });
      box = { ...b, x: b.x + d.dx, y: b.y + d.dy };
    } else if (g.kind === 'turn') {
      this.turnGroup(g, e);
      box = groupBox(g.moving.map((i) => this.itemBox(i)));
    } else {
      const item = g.moving[0];
      if (g.kind === 'crop') this.cropItem(item, g, dx, dy, e);
      else if (g.kind === 'rotate') this.rotateItem(item, g, e);
      else if (g.kind === 'tip') this.tipItem(item, g, e);
      else this.resizeItem(item, g, dx, dy, e);
      const el = this.itemEl(item.id);
      placeItem(el, item);
      if (g.kind === 'crop') placeCrop(el.querySelector('img'), item.crop);
      box = this.itemBox(item);
    }
    // A guide stays only while its snap survived (a minimum size, the picture's edges).
    const edges = { x: [box.x, box.x + box.w / 2, box.x + box.w], y: [box.y, box.y + box.h / 2, box.y + box.h] };
    g.guides = g.guides.filter(({ axis, at }) => edges[axis].some((v) => Math.abs(v - at) < 0.6));
    this.emit(); // the ribbon follows
  }

  // Corner (edge) resize from the gesture's start box with the opposite corner (edge) fixed; stops at the minimum size,
  // except that an item that mirrors (mirrors()) goes on past the fixed side, mirrored. Minimum: MIN_ITEM per side, or the
  // start size if already smaller. The moving edges snap. A turned shape or image resizes in its own frame (resizeInFrame,
  // §6d): no snapping.
  resizeItem(item, g, dx, dy, e) {
    const start = g.starts[0];
    if (item.type === 'text') delete item.fit; // a width set by hand
    if (start.rot && item.type === 'text') { // width only, about the middle of the opposite side; the text then reflows
      const r = resizeInFrame({ ...start, h: this.itemHeight(start) }, g.corner.includes('w') ? 'w' : 'e', dx, dy, { min: MIN_ITEM });
      Object.assign(item, { x: r.x, y: r.y, w: r.w });
      placeItem(this.itemEl(item.id), item);
      return;
    }
    if (start.rot) {
      const aspect = g.corner.length === 2 && (item.type === 'shape' ? e.shiftKey : !e.shiftKey); // the rule below
      const { fx, fy, ...box } = resizeInFrame(start, g.corner, dx, dy, { aspect, min: MIN_ITEM, flip: mirrors(item) });
      Object.assign(item, box);
      if (mirrors(item)) setMirror(item, start, fx, fy);
      return;
    }
    const [sx, sy] = [g.corner.includes('w') ? -1 : g.corner.includes('e') ? 1 : 0, g.corner.includes('n') ? -1 : g.corner.includes('s') ? 1 : 0];
    const ax = sx > 0 ? start.x : start.x + start.w; // the fixed corner
    const size = (n, min) => Math.max(min, Math.round(n));
    // The size whose moving edge (fixed edge a, direction s) lands on a snap line.
    const snapSize = (axis, a, s, n) => n + s * (this.snapHit(g, axis, [a + s * n], e)?.d ?? 0);
    if (item.type === 'text') {
      // Width only.
      item.w = size(snapSize('x', ax, sx, start.w + sx * dx), Math.min(MIN_ITEM, start.w));
      item.x = sx > 0 ? ax : ax - item.w;
      placeItem(this.itemEl(item.id), item);
      return;
    }
    const ay = sy > 0 ? start.y : start.y + start.h;
    const [w, h] = [start.w + sx * dx, start.h + sy * dy]; // the box the pointer asks for (negative: past the fixed side)
    const flip = mirrors(item); // past the fixed side the box goes on there, mirrored (§6d flips)
    let [ex, ey] = [sx, sy]; // the side the box grows to from the fixed corner (edge)
    if (sx && sy && (item.type === 'shape' ? e.shiftKey : !e.shiftKey)) {
      // Images and strokes keep their aspect unless Shift; shapes resize freely unless Shift. One
      // scale for both axes (the corner follows the pointer along the diagonal, snapped on x), its minimum on the larger
      // side only, so thin strokes and dots keep their shape.
      let p = (start.w * (w * start.w + h * start.h)) / (start.w ** 2 + start.h ** 2); // the pointer on the diagonal, as a width
      if (flip && p < 0) [p, ex, ey] = [-p, -sx, -sy];
      const k = snapSize('x', ax, ex, p) / start.w;
      const s = Math.max(Math.min(1, MIN_ITEM / Math.max(start.w, start.h)), k);
      item.w = Math.max(1, Math.round(start.w * s));
      item.h = Math.max(1, Math.round(start.h * s));
    } else {
      // An edge handle (sx or sy 0) leaves the other side as it was.
      if (flip && w < 0) ex = -sx;
      if (flip && h < 0) ey = -sy;
      item.w = sx ? size(snapSize('x', ax, ex, flip ? Math.abs(w) : w), Math.min(MIN_ITEM, start.w)) : start.w;
      item.h = sy ? size(snapSize('y', ay, ey, flip ? Math.abs(h) : h), Math.min(MIN_ITEM, start.h)) : start.h;
    }
    item.x = ex > 0 ? ax : ex < 0 ? ax - item.w : start.x;
    item.y = ey > 0 ? ay : ey < 0 ? ay - item.h : start.y;
    if (flip) setMirror(item, start, ex !== sx, ey !== sy);
  }

  // A line's or arrow's tip handle (§6d tips): that end goes to the pointer (snapped; Shift: 45° steps about the other end),
  // the other end stays; the line is then drawn unturned between them.
  tipItem(item, g, e) {
    const s = g.starts[0];
    const ends = lineEnds(s);
    const box = shapeBox(ends[g.tip ? 0 : 1], this.pointAt(e, g), e.shiftKey, s);
    if (!g.tip) [box.flipX, box.flipY] = [!box.flipX, !box.flipY]; // drawn from the fixed end: the start moved
    Object.assign(item, box, { rot: 0 });
  }

  // The rotate handle (§6d): the item turns by the angle the pointer has turned about its centre since the press, in whole
  // degrees; Shift: 15° steps.
  rotateItem(item, g, e) {
    const s = g.starts[0];
    const c = { x: s.x + s.w / 2, y: s.y + this.itemHeight(s) / 2 };
    const angle = (p) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
    const rot = (s.rot ?? 0) + angle(this.local(e)) - angle(g.p0);
    item.rot = (((e.shiftKey ? Math.round(rot / 15) * 15 : Math.round(rot)) % 360) + 360) % 360;
    Object.assign(item, { x: s.x, y: s.y });
  }

  // Ctrl + corner (edge) on an image: that corner's two edges (that edge) move over the picture, which stays where it is at its scale.
  // Edges stop at the picture's own edges (dragging outward un-crops) and the minimum size; they snap. A turned image crops in
  // its own frame (as resizeInFrame): the move turned by −rot, no snapping.
  cropItem(item, g, dx, dy, e) {
    const s = g.starts[0];
    const rot = s.rot || 0;
    if (rot) ({ x: dx, y: dy } = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -rot));
    const c = s.crop ?? FULL;
    const [fw, fh] = [s.w / c.w, s.h / c.h]; // the whole picture on the board
    const [x0, y0] = rot ? [0, 0] : [s.x, s.y]; // a turned image: its own frame, from its top-left
    const [ox, oy] = [x0 - c.x * fw, y0 - c.y * fh];
    const edge = (axis, v, min, max) => fit(Math.round(v + ((!rot && this.snapHit(g, axis, [v], e)?.d) || 0)), min, max);
    let [l, t, r, b] = [x0, y0, x0 + s.w, y0 + s.h];
    const [mw, mh] = [Math.min(MIN_ITEM, s.w), Math.min(MIN_ITEM, s.h)];
    if (g.corner.includes('w')) l = edge('x', l + dx, ox, r - mw);
    else if (g.corner.includes('e')) r = edge('x', r + dx, l + mw, ox + fw);
    if (g.corner.includes('n')) t = edge('y', t + dy, oy, b - mh);
    else if (g.corner.includes('s')) b = edge('y', b + dy, t + mh, oy + fh);
    const crop = { x: (l - ox) / fw, y: (t - oy) / fh, w: (r - l) / fw, h: (b - t) / fh };
    if ([crop.x, crop.y, 1 - crop.w, 1 - crop.h].every((v) => Math.abs(v) < 1e-6)) delete item.crop;
    else item.crop = crop;
    if (!rot) {
      Object.assign(item, { x: l, y: t, w: r - l, h: b - t });
      return;
    }
    // The cropped box's centre turned about the start centre: the edges not dragged keep their board position.
    const m = rotatePoint({ x: s.x + (l + r) / 2, y: s.y + (t + b) / 2 }, { x: s.x + s.w / 2, y: s.y + s.h / 2 }, rot);
    Object.assign(item, { x: r2(m.x - (r - l) / 2), y: r2(m.y - (b - t) / 2), w: r - l, h: b - t });
  }

  onPointerUp = (e) => {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    this.showGuides([]);
    // A move released over chrome that takes board items (the shape panel's Prefabs, §6g): they go back and it gets the board.
    const el = g.kind === 'move' && g.last ? document.elementFromPoint(e.clientX, e.clientY) : null;
    const out = el && !this.owns(el) && el.closest('[data-board-drop]');
    if (out) {
      this.render();
      out.dispatchEvent(new CustomEvent('boarddrop', { detail: this, bubbles: true }));
      return;
    }
    this.endGesture(g, e);
    if (!this.destroyed) this.pin(e);
  };

  endGesture(g, e) {
    if (g.kind === 'pen') return this.finishStroke(g);
    if (g.kind === 'shape') return this.finishShape(g);
    if (g.kind === 'marquee') return this.finishMarquee(g, e.shiftKey);
    if (g.kind === 'eraser') {
      this.items = this.items.filter((i) => !g.erased.has(i.id));
      if (g.erased.size) this.commit(true);
      return;
    }
    if (g.kind === 'connector') return this.finishConnector(g);
    this.showTarget(null);
    this.settleConnector(g);
    const changed = g.copied || g.moving.some((i, k) => CHANGE_KEYS.some((p) => JSON.stringify(i[p]) !== JSON.stringify(g.starts[k][p])));
    if (changed) this.commit(); // one undo step, also for a group
    else if (g.last) this.render(); // drop the live size
    if (!changed && g.click) this.select(g.click);
  }

  onPointerCancel = (e) => {
    if (!this.gesture || e.pointerId !== this.gesture.pointerId) return;
    this.gesture = null;
    this.showGuides([]);
    this.render();
  };

  onDblClick = (e) => {
    if (this.mode) return;
    // Pointer capture retargets the dblclick to the board, so hit-test instead of using e.target.
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const el = hit?.closest('.wb-item');
    let item = el && this.dom.contains(el) ? this.items.find((i) => i.id === el.dataset.id) : null;
    if (item?.type === 'connector') {
      if (this.stepIn(item)) return; // a member of the selected group: in, then its label as below (§6c Groups)
      // A waypoint handle: that bend goes. A label: edit it. The line: the slot by where it was hit (§6d).
      if (hit.classList.contains('wb-wp')) return this.removeWaypoint(item, Number(hit.dataset.k));
      const slot = hit.closest('.wb-text[data-slot]')?.dataset.slot;
      if (slot) return item.id === this.editingId && slot === this.editingSlot ? undefined : this.editLabel(item.id, slot);
      const pts = this.geo.get(item.id)?.pts;
      if (!pts) return;
      const t = nearestT(pts, this.local(e));
      const at = labelSlotAt(t);
      return this.editLabel(item.id, at, at === 'mid' && Math.abs(t - 0.5) < 0.1 ? 0.5 : Math.round(t * 1000) / 1000);
    }
    // Where no item takes the pointer (or only a line does), the topmost shape whose outline holds it, also where it is
    // unfilled (geometric hit; strokes, lines and arrows count by their line only), so its label can be edited. Hidden and
    // locked items take no pointer and no geometric hit: a double-click there acts as on empty board (§6 Layer fields).
    const lineish = (i) => i.type === 'stroke' || (i.type === 'shape' && isLineish(i.shape));
    const skip = new Set(this.items.filter((i) => lineish(i) || !selectable(i)).map((i) => i.id));
    const geo = hitTarget(this.items, this.local(e), { exclude: skip, measure: this.measure });
    const inside = geo && this.items.find((i) => i.id === geo.item);
    if (inside && (!item || (lineish(item) && this.items.indexOf(inside) > this.items.indexOf(item)))) item = inside;
    if (!item) return hit === this.dom || hit === this.layer ? this.addText(this.snapped(e)) : undefined; // empty board: a text (§6c)
    if (item.id === this.editingId || this.stepIn(item)) return; // a member of the selected group: in, a text or shape edited
    if (item.type === 'text') this.startEdit(item.id);
    else if (item.type === 'shape') this.editShapeLabel(item);
  };

  // Every unit that holds an item not hidden or locked (§6 Layer fields); inside a group stepped into, its members (§6c Groups).
  selectAll() {
    if (this.mode) this.setMode(null);
    const live = this.items.filter((i) => selectable(i) && (!this.scope || i.groups?.includes(this.scope)));
    this.select(live.flatMap((i) => unitOf(this.items, i.id, this.scope).ids));
  }

  // Edits a text, a shape's label or a connector's middle label (added if missing): Enter, F2, a double-click on its layers
  // panel row.
  editItem(item) {
    if (item.type === 'text') this.startEdit(item.id);
    else if (item.type === 'shape') this.editShapeLabel(item);
    else if (item.type === 'connector') this.editLabel(item.id, 'mid');
  }

  // Edits a shape's label (double-click, Enter, F2); the shape becomes the selection.
  editShapeLabel(item) {
    if (this.selectedId !== item.id) this.select(item.id);
    this.startEdit(item.id);
  }

  onKeyDown = (e) => {
    if (e.key === 'Alt' && this.gesture) e.preventDefault(); // Alt during a drag must not open the window menu
    if (this.editingId) {
      // Select-all inside the text box only (the browser would otherwise select the surrounding document).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const text = this.editText();
        if (text) document.getSelection().selectAllChildren(text);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.finishEdit();
        if (this.scope) this.stepOut(); // the edited member's group stays selected (§6c Groups)
        this.dom.focus({ preventScroll: true });
      }
      return;
    }
    const arrow = { ArrowLeft: 'w', ArrowRight: 'e', ArrowUp: 'n', ArrowDown: 's' }[e.key];
    // Escape: end a text edit (above) → leave the tool → step out of a group (§6c Groups) → deselect.
    if (e.key === 'Escape' && (this.mode || this.sel.size)) {
      e.preventDefault();
      if (this.mode) this.setMode(null);
      else if (this.scope) this.stepOut();
      else this.select(null);
      this.dom.focus({ preventScroll: true });
      return;
    }
    if (e.target !== this.dom) return;
    // The board's commands and tools by binding (SPEC §7k keybinds). Fixed: arrows (nudge, Ctrl+Arrow quick-connect, Alt+Arrow to
    // the connected item), Tab, Enter / F2 and Escape. stopEvent hides keys from ProseMirror while the board has focus, so undo and
    // redo are routed here.
    const commands = {
      'edit.undo': () => this.undo(),
      'edit.redo': () => this.redo(),
      'board.selectAll': () => this.selectAll(),
      'board.deselect': () => this.select(null),
      'board.duplicate': () => this.duplicate(),
      'board.copy': () => this.copyItem(),
      'board.cut': () => this.copyItem(true),
      'board.copyStyle': () => this.copyStyle(), // style (§6d)
      'board.pasteStyle': () => this.pasteStyle(),
      'board.forward': () => this.arrange('forward'),
      'board.front': () => this.arrange('front'),
      'board.backward': () => this.arrange('backward'),
      'board.back': () => this.arrange('back'),
      'board.snap': () => this.setSnap({ on: !snapRules.on }),
      'board.grid': () => this.setSnap({ grid: !snapRules.grid }),
      ...(this.sel.size && {
        'board.delete': () => this.removeItem(),
        'board.rotate': () => this.rotate(90), // the selection turns 90° clockwise / back as one (§6d)
        'board.rotateBack': () => this.rotate(-90),
        'board.flipH': () => this.flip('x'), // §6d flips
        'board.flipV': () => this.flip('y'),
        'board.lock': () => this.setLayer('locked'), // §6 Layer fields
        'board.hide': () => this.setLayer('hidden'),
        'board.group': () => this.group(), // §6c Groups
        'board.ungroup': () => this.group(false),
      }),
    };
    const id = keyAmong(Object.keys(commands), e);
    if (id) {
      e.preventDefault();
      commands[id]();
      return;
    }
    if (this.toolKey(e)) {
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      // Ctrl+Arrow: a connected copy of the one selected item that way (quick-connect, §6d).
      const one = this.selected();
      if (arrow && !e.shiftKey && one && one.type !== 'connector' && one.type !== 'stroke') {
        e.preventDefault();
        this.cloneConnect(arrow);
      }
      return;
    }
    if (arrow && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && this.selectedId) {
      // Alt+Arrow: to the connected item that way; the Alt keyup must not open the window menu.
      e.preventDefault();
      this.altUsed = true;
      this.goConnected(arrow);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab' && this.items.some(selectable)) {
      // Next / previous unit in z-order at the scope (a group as one, §6c Groups), past hidden and locked items (§6 Layer
      // fields); from the unit of the first selected item.
      e.preventDefault();
      if (this.mode) this.setMode(null);
      const units = new Map(); // group id or item id → its ids
      for (const it of this.items.filter((i) => selectable(i) && (!this.scope || i.groups?.includes(this.scope)))) {
        const u = unitOf(this.items, it.id, this.scope);
        if (!units.has(u.group ?? it.id)) units.set(u.group ?? it.id, u.ids);
      }
      const list = [...units.values()];
      const n = list.length;
      const i = list.findIndex((ids) => ids.includes([...this.sel][0]));
      if (n) this.select(list[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n]);
      return;
    }
    if (!this.sel.size) return;
    const item = this.selected();
    // Enter / F2: edit the text, the shape's label or the connector's middle label (added if missing).
    if ((e.key === 'Enter' || e.key === 'F2') && ['text', 'shape', 'connector'].includes(item?.type)) {
      e.preventDefault();
      this.editItem(item);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const delta = arrow && { w: [-step, 0], e: [step, 0], n: [0, -step], s: [0, step] }[arrow];
    if (!delta) return;
    e.preventDefault();
    this.moveBy(this.selectedItems(), ...delta);
    this.commit();
  };

  // Tool keys (§6c Keyboard, §7k keybinds; `e` a key event): the board takes the focus and runs the tool → true; false for other
  // keys.
  toolKey(e) {
    const tools = {
      'board.select': () => this.mode && this.setMode(null),
      'board.text': () => this.setMode(this.mode === 'text' ? null : 'text'),
      'board.image': () => this.pickImages(),
      'board.pen': () => this.setMode('pen'),
      'board.eraser': () => this.setMode('eraser'),
      'board.shape': () => this.setMode('shape'),
      'board.connector': () => this.setMode('connector'),
      'board.keepTool': () => this.setKeepTool(!keepTool),
      // B, O, L, Shift+L: the shape tool with that kind (S keeps the last kind used)
      ...Object.fromEntries(Object.entries(SHAPE_KEYS).map(([shape, id]) => [id, () => {
        this.setShapeTool({ shape });
        this.setMode('shape');
      }])),
    };
    const id = keyAmong(Object.keys(tools), e);
    if (!id) return false;
    this.focus();
    tools[id]();
    return true;
  }

  onKeyUp = (e) => {
    if (e.key === 'Alt' && (this.altCopied || this.altUsed)) {
      e.preventDefault(); // releasing Alt after Alt + drag, Alt+Arrow or a non-sticking end must not open the window menu
      this.altCopied = this.altUsed = false;
    }
  };

  destroy() {
    // Listeners live on this.dom (pointer capture keeps drags on it); the shared ones serve whichever boards are live.
    this.destroyed = true;
    this.gesture = null;
    this.editingId = this.editingSlot = null;
    boards.delete(this);
    updateActive();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Rasterizer

export async function rasterizeWhiteboard(attrs, { width, theme, scale = 2 }) {
  injectStyle();
  const height = attrs.height;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  const board = document.createElement('div');
  board.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px`;
  setBoardVars(board, attrs.bg, theme);
  board.append(...routed(attrs.items).filter((i) => !i.hidden).map((i) => itemElement(i, theme, boardSurface(attrs.bg, theme)))); // routed first: a hidden item still binds ends
  host.append(board);
  document.body.append(host);
  // html-to-image waits an animation frame for its picture, and a hidden or minimized window draws none (an agent's render
  // hung there, 2026-10-24): a timer stands in while it is hidden.
  const raf = window.requestAnimationFrame;
  if (document.hidden) window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0);
  try {
    await Promise.all([...board.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
    const blob = await toBlob(board, {
      pixelRatio: scale,
      width,
      height,
      backgroundColor: resolveBg(attrs.bg, theme) ?? undefined,
      skipFonts: true, // items only use system fonts
      imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', // unfetchable <img> in old drafts
    });
    if (!blob) throw new Error('Board rasterization produced no image');
    return { blob, width, height };
  } finally {
    window.requestAnimationFrame = raf;
    host.remove();
  }
}

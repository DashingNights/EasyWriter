// Whiteboard: a free-form board of image, text and pen-stroke items that is flattened to a PNG on export (SPEC §6).
import { Node, Extension } from '@tiptap/core';
import { Plugin, PluginKey, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { toBlob } from 'html-to-image';
import { toast } from 'sonner';
import { anchorPoint, kindOf, portNormal, portsOf, rotBox } from './flow/shapes.mjs';
import {
  align as alignBoxes, boundIndex, cleanConnector, cloneItems, containedIn, DASHES, distribute as distributeBoxes, HEADS, hitTarget, JUMPS,
  LABEL_SLOTS, MAX_POINTS, moveItem, repairEnds, resizeInFrame, ROUTES, sameSize as sameBoxes, unbindFrom, validConnector,
} from './flow/model.mjs';
import { headPath, LABEL_PAD, nearestT, polylineHitsRect, polylinePoint, resolveConnectors } from './flow/route.mjs';
import { isMermaid } from './flow/mermaid.mjs';
import { cleanPoints, dragSegment, labelSlotAt, midHandles, OPPOSITE, pickInDirection, reverseConnector, SIDES, sideToward } from './flow/edit.mjs';
import { keyAmong, keyLabel } from './app/keybinds.js';

export const WB_BG = { post: { dark: '#303039', light: '#ffffff' }, transparent: null, white: '#ffffff', black: '#000000' };

const FONT = 'system-ui, Helvetica, Arial, sans-serif';
// Option lists of the board chrome (src/app/components/board).
export const TEXT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72];
export const NOTE_COLORS = [['', 'No note'], ['#fff59d', 'Yellow note'], ['#c8e6c9', 'Green note'], ['#bbdefb', 'Blue note'], ['#f8bbd0', 'Pink note']];
export const BG_OPTIONS = [['post', 'Post'], ['transparent', 'Transparent'], ['white', 'White'], ['black', 'Black']];
const MIN_ITEM = 20;
const MIN_HEIGHT = 80;
const HEIGHT_PAD = 20; // a whiteboard is never shorter than its lowest item bottom + this
const ARTBOARD_PAD = 32; // a canvas artboard reaches this far past content beyond its frame (§6b)
const CORNERS = ['nw', 'ne', 'sw', 'se'];
const EDGES = ['n', 'e', 's', 'w']; // a shape's edge handles (§6d)
const GRID = 10;
const SNAP_PX = 6; // snap threshold in screen px
const EDGE = 48; // auto-scroll zone in screen px from the scrolling area's edge
const MAX_SCROLL = 24; // auto-scroll px per frame
const FULL = { x: 0, y: 0, w: 1, h: 1 }; // uncropped
const DEFAULT_WIDTH = 1454;
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
{
  // Saved values are checked like parseBoard checks items, so new items always pass it.
  const size = (v) => Number.isFinite(v) && v > 0;
  const color = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
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
const ink = () => (pageTheme() === 'light' ? '#111111' : '#ffffff'); // text / line colour chosen by theme at creation
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
// A shape label's style where the item has none (§6d); align / valign also by kind (a frame's label sits top-left).
const LABEL = { size: 16, textColor: '#ffffff', align: 'center', valign: 'middle' };
const FLEX = { left: 'flex-start', top: 'flex-start', center: 'center', middle: 'center', right: 'flex-end', bottom: 'flex-end' };
// A gesture changed an item when one of these differs (compared as JSON: ends, waypoints and labels are objects).
const CHANGE_KEYS = ['x', 'y', 'w', 'h', 'crop', 'from', 'to', 'points', 'labels', 'rot'];
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

// The move dx, dy of a group with box `box`, cut so the box stays inside `limits` ({l, t, r, b}); a box wider than them
// is pinned to l (like clampItem).
export const clampMove = (box, dx, dy, { l, t, r, b }) => ({ dx: fit(box.x + dx, l, r - box.w) - box.x, dy: fit(box.y + dy, t, b - box.h) - box.y });

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
// and loses `flow` (a library link is a canvas node attr only, §6b). Connectors get their defaults; a shape's rot is
// normalised to [0, 360) (non-finite: dropped) and bad label fields dropped; a text item's non-finite `h` is dropped.
function cleanItem(item) {
  if (item.type === 'canvas') {
    const items = Array.isArray(item.items) ? item.items.filter((i) => i?.type !== 'canvas' && validItem(i)).map(cleanItem) : [];
    const { flow, ...rest } = item;
    return { ...rest, frame: parseFrame(item.frame), bg: Object.hasOwn(WB_BG, item.bg) ? item.bg : DEFAULT_ATTRS.bg, items: repairEnds(items) };
  }
  if (item.type === 'connector') return cleanConnector(item);
  if (item.type === 'shape') {
    const out = { ...item };
    for (const [k, ok] of Object.entries(LABEL_CHECKS)) if (k in out && !ok(out[k])) delete out[k];
    if (Number.isFinite(out.rot)) out.rot = ((out.rot % 360) + 360) % 360;
    else delete out.rot;
    return out;
  }
  if (item.type === 'text' && 'h' in item && !Number.isFinite(item.h)) {
    const { h, ...rest } = item;
    return rest;
  }
  if (item.type !== 'image' || item.crop === undefined || validCrop(item.crop)) return item;
  const { crop, ...rest } = item;
  return rest;
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
// Styles: board chrome lives in one injected stylesheet; item visuals are inline (shared with the rasterizer).

const CSS = `
.wb{position:relative;width:100%;box-sizing:border-box;margin:1em 0;outline:1px dashed transparent;outline-offset:3px;user-select:none;-webkit-user-select:none}
.wb[data-bg="post"]{background:var(--wb-post,${WB_BG.post.dark})}
:root[data-theme="light"]{--wb-post:${WB_BG.post.light}}
.wb[data-bg="white"]{background:${WB_BG.white}}
.wb[data-bg="black"]{background:${WB_BG.black}}
.wb:hover,.wb:focus-within{outline-color:#8a8ca0}
.wb:where(:not(.wb-fixed,.wb-selected,:focus-within)){cursor:pointer}
.wb.wb-selected,.wb:focus{outline:2px dashed #3d99f5}
.wb.wb-fixed{margin:0;outline:none}
.wb-layer{position:absolute;inset:0;overflow:clip}
.wb.wb-grid .wb-layer{background-image:radial-gradient(circle,rgba(140,142,160,.6) 1px,transparent 1.5px);background-size:${GRID}px ${GRID}px;background-position:-${GRID / 2}px -${GRID / 2}px}
.wb-guides{position:absolute;inset:0;z-index:3;pointer-events:none}
.wb-guide{position:absolute;background:#ff4d9d}
.wb-guide-x{top:0;bottom:0;width:calc(1px*var(--wb-inv,1))}
.wb-guide-y{left:0;right:0;height:calc(1px*var(--wb-inv,1))}
.wb-item{cursor:move}
.sc-art *{pointer-events:none}
.wb .wb-canvas-empty{outline:calc(1px*var(--wb-inv,1)) dashed #8a8ca0;outline-offset:calc(-1px*var(--wb-inv,1))}
.wb-item.wb-sel{outline:calc(2px*var(--wb-inv,1)) solid #3d99f5;outline-offset:calc(1px*var(--wb-inv,1))}
.wb-group{position:absolute;z-index:2;pointer-events:none;outline:calc(1px*var(--wb-inv,1)) dashed #3d99f5;outline-offset:calc(5px*var(--wb-inv,1))}
.wb-marquee{position:absolute;box-sizing:border-box;pointer-events:none;border:calc(1px*var(--wb-inv,1)) solid #3d99f5;background:rgba(61,153,245,.1)}
.wb-stroke,.wb-shape,.wb-conn{pointer-events:none}
.wb-stroke.wb-sel,.wb-shape.wb-sel{pointer-events:auto}
.wb-layer>.wb-conn .wb-text,.wb-layer>.wb-shape>.wb-label>.wb-text{pointer-events:auto}
.wb[data-bg="post"] .wb-layer{--wb-bg:var(--wb-post,${WB_BG.post.dark})}
.wb[data-bg="white"] .wb-layer{--wb-bg:${WB_BG.white}}
.wb[data-bg="black"] .wb-layer{--wb-bg:${WB_BG.black}}
.wb.wb-drawing,.wb.wb-drawing .wb-item{cursor:crosshair;touch-action:none}
.wb.wb-drawing.wb-place-text,.wb.wb-drawing.wb-place-text .wb-item{cursor:text}
.wb-text p{margin:0!important}
.wb-text[contenteditable="true"]{cursor:text;user-select:text;-webkit-user-select:text;outline:none;overflow-anchor:none}
.wb-handle{position:absolute;width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));box-sizing:border-box;background:#3d99f5;border:calc(2px*var(--wb-inv,1)) solid #fff;border-radius:calc(2px*var(--wb-inv,1))}
.wb-h-nw,.wb-h-ne{top:0}.wb-h-sw,.wb-h-se{top:100%}.wb-h-nw,.wb-h-sw{left:0}.wb-h-ne,.wb-h-se{left:100%}
.wb-h-nw,.wb-h-se{cursor:nwse-resize}.wb-h-ne,.wb-h-sw{cursor:nesw-resize}
.wb-h-n,.wb-h-e,.wb-h-s,.wb-h-w{width:calc(10px*var(--wb-inv,1));height:calc(10px*var(--wb-inv,1));margin:calc(-5px*var(--wb-inv,1))}
.wb-h-n{top:0;left:50%}.wb-h-s{top:100%;left:50%}.wb-h-e{top:50%;left:100%}.wb-h-w{top:50%;left:0}
.wb-h-n,.wb-h-s{cursor:ns-resize}.wb-h-e,.wb-h-w{cursor:ew-resize}
.wb-rot{position:absolute;left:calc(100% + 18px*var(--wb-inv,1));top:calc(-18px*var(--wb-inv,1));width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));box-sizing:border-box;border-radius:50%;background:#fff;border:calc(2px*var(--wb-inv,1)) solid #3d99f5;cursor:grab}
.wb-hbar{position:absolute;left:0;right:0;bottom:-4px;height:8px;z-index:4;cursor:row-resize}
.wb-hbar:hover{background:rgba(61,153,245,.45)}
.wb-item.wb-target{outline:calc(2px*var(--wb-inv,1)) dashed #3d99f5;outline-offset:calc(2px*var(--wb-inv,1))}
.wb-port,.wb-end,.wb-wp,.wb-mid,.wb-qc{position:absolute;z-index:1;box-sizing:border-box;border-style:solid;border-width:calc(2px*var(--wb-inv,1))}
.wb-port{width:calc(9px*var(--wb-inv,1));height:calc(9px*var(--wb-inv,1));margin:calc(-4.5px*var(--wb-inv,1));border-radius:50%;background:#fff;border-color:#3d99f5;pointer-events:none}
.wb-port.on{background:#3d99f5;border-color:#fff;transform:scale(1.5)}
.wb-end,.wb-wp,.wb-mid,.wb-qc{pointer-events:auto;cursor:move}
.wb-item.wb-conn.wb-sel{outline:none}.wb-conn.wb-sel>svg{filter:drop-shadow(0 0 calc(1.5px*var(--wb-inv,1)) #3d99f5)}
.wb-conn.wb-sel>.wb-text{z-index:1}
.wb-end{width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));border-radius:50%;background:#fff;border-color:#3d99f5}
.wb-end.bound{background:#3d99f5;border-color:#fff}
.wb-wp{width:calc(10px*var(--wb-inv,1));height:calc(10px*var(--wb-inv,1));margin:calc(-5px*var(--wb-inv,1));border-radius:50%;background:#3d99f5;border-color:#fff}
.wb-mid{width:calc(10px*var(--wb-inv,1));height:calc(10px*var(--wb-inv,1));margin:calc(-5px*var(--wb-inv,1));border-radius:calc(2px*var(--wb-inv,1));background:#fff;border-color:#3d99f5}
.wb-mid.h{cursor:ns-resize}.wb-mid.v{cursor:ew-resize}
.wb-qc{width:calc(12px*var(--wb-inv,1));height:calc(12px*var(--wb-inv,1));margin:calc(-6px*var(--wb-inv,1));border-radius:50%;background:#3d99f5;border-color:#fff;opacity:.7;cursor:crosshair}
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
  el.style.width = `${item.w}px`;
  if (item.type !== 'text') el.style.height = `${item.h}px`;
  if (item.type === 'canvas') el.querySelector(':scope > .sc-art').style.transform = `scale(${item.w / item.aw})`;
  // A shape turns about its centre, label and handles included (§6d); every renderer draws it this way.
  el.style.transform = item.type === 'shape' && item.rot ? `rotate(${item.rot}deg)` : '';
}

// Files and agents may hold connectors that were never routed: renderers route them (O(connectors)).
const routed = (items) => (items.some((i) => i.type === 'connector' && typeof i.d !== 'string') ? resolveConnectors(items).items : items);

// A canvas's artboard (aw × ah px, unscaled: the caller sets its transform) holding its items, put first into `box` on
// the canvas's background. Draws canvas items (so their whiteboard's export too) and the document canvas preview.
export function drawCanvas(box, { aw, ah, bg, items }) {
  box.style.background = resolveBg(bg, pageTheme()) ?? 'none';
  const art = make('div', 'sc-art');
  art.style.cssText = `position:absolute;left:0;top:0;width:${aw}px;height:${ah}px;transform-origin:0 0;overflow:hidden;pointer-events:none`;
  art.style.setProperty('--wb-bg', resolveBg(bg, pageTheme()) ?? 'transparent'); // connector labels mask the line with it
  art.append(...routed(items).map(itemElement));
  box.prepend(art);
  return art;
}

function placeCrop(img, c = FULL) {
  img.style.cssText = `position:absolute;display:block;max-width:none;width:${100 / c.w}%;height:${100 / c.h}%;` +
    `left:${(-100 * c.x) / c.w}%;top:${(-100 * c.y) / c.h}%`;
}

function styleText(text, item) {
  Object.assign(text.style, {
    boxSizing: 'border-box',
    minHeight: '1.3em',
    padding: '6px 8px',
    fontFamily: FONT,
    fontSize: `${item.size}px`,
    lineHeight: '1.3',
    fontWeight: item.bold ? '700' : '400',
    fontVariantLigatures: 'none',
    color: item.color,
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
const arrowHead = (width) => Math.max(12, width * 3.5);
// Line/arrow boxes are padded so the stroke and arrowhead fit; endpoints sit at opposite padded corners.
const linePad = (item) => (item.shape === 'arrow' ? arrowHead(item.width) * 0.6 : item.width / 2) + 1;

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

// Box from a drag start/end point (both inside `bounds`). Shift: square shapes, or 45° steps for lines/arrows; that
// constrained drag is shortened, keeping its direction, so the box stays inside `bounds` ({l, t, r, b}).
function shapeBox(p0, p1, shift, tool, bounds) {
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
    const room = (d, p, min, max) => (d ? Math.max(0, d < 0 ? p - pad - min : max - pad - p) / Math.abs(d) : 1);
    const k = Math.min(1, room(dx, p0.x, bounds.l, bounds.r), room(dy, p0.y, bounds.t, bounds.b));
    [dx, dy] = [dx * k, dy * k];
  }
  const x = Math.round(Math.min(p0.x, p0.x + dx) - pad);
  const y = Math.round(Math.min(p0.y, p0.y + dy) - pad);
  return { x, y, w: Math.max(1, Math.round(Math.abs(dx) + 2 * pad)), h: Math.max(1, Math.round(Math.abs(dy) + 2 * pad)), flipX: dx < 0, flipY: dy < 0 };
}

function shapeSvg(item) {
  const { d, head } = shapeGeometry(item);
  const svg = svgEl('svg', { width: '100%', height: '100%', viewBox: `0 0 ${item.w} ${item.h}`, preserveAspectRatio: 'none', overflow: 'visible' });
  svg.style.display = 'block';
  let fill = 'none';
  const fills = !isLineish(item.shape) && !kindOf(item.shape)?.open; // an open outline (the annotation brace) is never filled
  if (fills && item.fill === 'solid') fill = item.fillColor;
  if (fills && item.fill === 'hatch') {
    const id = `wbh-${item.id}`;
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
function shapeLabel(item) {
  const k = kindOf(item.shape);
  const ins = k?.labelInset ?? { x: 0.08, y: 0.08 };
  const box = k?.band ? `left:8px;right:8px;top:0;height:${Math.min(k.band, item.h)}px`
    : `left:${ins.x * 100}%;right:${ins.x * 100}%;top:${ins.y * 100}%;bottom:${ins.y * 100}%`;
  const wrap = make('div', 'wb-label');
  wrap.style.cssText = `position:absolute;${box};display:flex;pointer-events:none`;
  const text = make('div', 'wb-text', { innerHTML: item.html });
  wrap.append(text);
  styleLabel(text, item);
  return wrap;
}

// A shape label's text and its box's alignment from the shape's label fields (defaults: LABEL, the kind's align / valign).
function styleLabel(text, item) {
  const k = kindOf(item.shape);
  const [align, valign] = [item.align ?? k?.align ?? LABEL.align, item.valign ?? k?.valign ?? LABEL.valign];
  styleText(text, { size: item.size ?? LABEL.size, color: item.textColor ?? LABEL.textColor, bold: !!item.bold, align, bg: null });
  Object.assign(text.style, { padding: '2px 4px', maxWidth: '100%' });
  Object.assign(text.parentElement.style, { justifyContent: FLEX[align], alignItems: FLEX[valign] });
}

// The html a label holds: '' when nothing visible was typed (an emptied contenteditable keeps a <br>).
const labelHtml = (text) => (text.textContent.trim() ? text.innerHTML : '');

// A connector (§6d): its derived shaft path in an SVG the size of its bbox, a head per end drawn at its tip, a wide
// transparent hit path (only the line takes the pointer, never the bbox), and one label per present slot centred on its
// anchor, masking the line with the board colour (--wb-bg).
function connectorParts(el, item) {
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
    styleText(text, { size: l.size ?? 14, color: l.textColor ?? '#ffffff', bold: !!l.bold, align: 'center', bg: null });
    Object.assign(text.style, {
      position: 'absolute', left: `${p.x}px`, top: `${p.y}px`, transform: 'translate(-50%, -50%)', whiteSpace: 'pre',
      padding: `${LABEL_PAD.y}px ${LABEL_PAD.x}px`, background: 'var(--wb-bg, transparent)',
    });
    el.append(text);
  }
}

export function itemElement(item) {
  const el = document.createElement('div');
  el.className = 'wb-item';
  el.dataset.id = item.id;
  el.style.position = 'absolute';
  el.style.boxSizing = 'border-box';
  if (item.type === 'image') {
    // The clip box shows the crop region; the picture inside is scaled up by 1 / crop size and offset by the crop origin.
    const clip = document.createElement('div');
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
    if (item.html) el.append(shapeLabel(item));
  } else if (item.type === 'connector') {
    connectorParts(el, item);
  } else if (item.type === 'canvas') {
    // Its inner items never take the pointer (CSS .sc-art *): the board sees only the canvas item.
    el.classList.add('wb-canvas');
    el.classList.toggle('wb-canvas-empty', !item.items.length); // editor-only outline (CSS needs a .wb ancestor)
    drawCanvas(el, item);
  } else {
    const text = document.createElement('div');
    text.className = 'wb-text';
    text.innerHTML = item.html;
    styleText(text, item);
    el.append(text);
  }
  placeItem(el, item);
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

// The items of the smart canvases and whiteboards in copied document HTML, converted to a board of `unit` so they keep
// their look in post px (§6c Units; a canvas's unit is w / dw, a whiteboard's 1).
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
    return parseBoard(json).items.map((i) => scaleItem(i, unit / from));
  });
}

async function readImage(file) {
  try {
    const src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
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

function boardPosAt(view, target) {
  const wb = target instanceof Element ? target.closest('.wb') : null;
  if (!wb || !view.dom.contains(wb)) return null;
  let found = null;
  view.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'whiteboard' && view.nodeDOM(pos) === wb) found = pos;
  });
  return found;
}

function localPoint(wb, event) {
  const rect = wb.getBoundingClientRect();
  const scale = rect.width / wb.offsetWidth || 1;
  return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
}

// boardPos: add to that whiteboard (at `point`, else centred). Otherwise insert one new smart canvas (§6b) per image at
// `insertPos` or the selection (after a node-selected canvas): artboard = the image's natural size (≤ 8000 px), the
// image at 0,0, displayed at most as wide as the page content.
async function addImages(view, files, { boardPos = null, point = null, insertPos = null } = {}) {
  const board = boardPos !== null ? view.nodeDOM(boardPos)?.wbView : null;
  if (board) return board.addImageFiles(files, point);
  const images = (await Promise.all(files.map(readImage))).filter(Boolean);
  if (!images.length || view.isDestroyed) return;
  const { state } = view;
  const width = contentWidth(view);
  const nodes = images.map((img) => {
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

function selectedBoardPos(state) {
  const sel = state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === 'whiteboard' ? sel.from : null;
}

export function addImageFilesToEditor(editor, files) {
  const list = imageFiles({ files });
  if (!list.length) return Promise.resolve();
  return addImages(editor.view, list, { boardPos: selectedBoardPos(editor.state) });
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
            // Clicking an item focuses its board without moving PM's selection, so go by focus, not event.target.
            const focusedBoard = boardPosAt(view, document.activeElement);
            if (itemClipboard && event.clipboardData.getData('text/plain') === itemClipboard.token) {
              const target = focusedBoard ?? selectedBoardPos(view.state);
              if (target !== null) view.nodeDOM(target)?.wbView?.pasteItem();
              return true; // never paste the token text itself
            }
            // Mermaid flowchart text onto a focused or node-selected whiteboard offers to import it (§6d Formats).
            const textBoard = focusedBoard ?? selectedBoardPos(view.state);
            const board = textBoard !== null && isMermaid(event.clipboardData.getData('text/plain')) && view.nodeDOM(textBoard)?.wbView;
            if (board) {
              diagramPaste.offer(board, event.clipboardData.getData('text/plain'));
              return true;
            }
            const files = imageFiles(event.clipboardData);
            if (!files.length && textBoard !== null) {
              // Copied canvases / whiteboards or text onto the focused or node-selected board: never replacing it, never
              // into a stale document selection.
              view.nodeDOM(textBoard)?.wbView?.pasteClipboard(event.clipboardData);
              return true;
            }
            if (!files.length) return false;
            const boardPos = focusedBoard ?? selectedBoardPos(view.state) ?? boardPosAt(view, event.target);
            if (boardPos === null) {
              // Office apps put a bitmap next to the real HTML (e.g. Excel cells): keep the rich paste.
              const html = event.clipboardData.getData('text/html');
              if (html && new DOMParser().parseFromString(html, 'text/html').body.textContent.trim()) return false;
            }
            addImages(view, files, { boardPos });
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = imageFiles(event.dataTransfer);
            if (!files.length) return false;
            const boardPos = boardPosAt(view, event.target);
            const point = boardPos !== null ? localPoint(event.target.closest('.wb'), event) : null;
            const insertPos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
            addImages(view, files, { boardPos, point, insertPos });
            return true;
          },
          // A node-selected whiteboard (a click on its empty area) is the working area: its tool keys go to it (focus and
          // key, as on the board itself), so T starts placing text instead of typing a "t".
          handleKeyDown(view, event) {
            const sel = view.state.selection;
            if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'whiteboard') return false;
            return !!view.nodeDOM(sel.from)?.wbView?.toolKey(event); // a tool's chord only (§7k): Shift+T types a capital after it
          },
          // Typing never replaces a node-selected board: on a whiteboard it goes into the block after it; on a canvas (a
          // click on it, a canvas edit's Done) letters do nothing.
          handleTextInput(view, _from, _to, text) {
            const sel = view.state.selection;
            const type = sel instanceof NodeSelection && sel.node.type.name;
            if (type === 'canvas') return true;
            if (type !== 'whiteboard') return false;
            view.dispatch(caretAfter(view.state.tr, sel.to).insertText(text).scrollIntoView());
            return true;
          },
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

// The board the chrome serves: the one with focus, else the node-selected one, else one in a tool mode, else none (the
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
  const next = list.find((b) => b.owns(focus)) ?? list.find((b) => b.nodeSelected) ?? list.find((b) => b.mode) ?? null;
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

/** The board menu (§6c): a right-click on a board calls open(board, {x, y}) (client px). The app fills it (BoardMenu.jsx), so
 * the editor layer imports no app code. */
export const boardMenu = { open: () => {} };

/** Mermaid flowchart text pasted onto a board (a whiteboard here, a canvas being edited in canvas.js) calls
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
  '[data-slot=popover-content]:not([data-tool-flyout]),[data-slot=dialog-content],[data-quick-tools]';

// The native picker of a chrome colour swatch (ColorSwatch) counts as one: open from the input's click until 300 ms after it
// closes (change, focus leaving the input, the window back in front), as Chromium may fire change before or after the
// pointer-down that closed it, and keeps the focus on the input when it closes without a change.
let pickerOpen = false;
let pickerTimer = 0;
export const colorPicker = {
  open() {
    clearTimeout(pickerTimer);
    pickerOpen = true;
  },
  closed() {
    clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => (pickerOpen = false), 300);
  },
};

/** A pointer-down on a board while a transient popup is open only closes the popup (Radix closes it on the document's
 * pointerdown or click, the native picker itself): → true, default prevented (no focus change). It ends the picker state. */
export function dismissOnly(e) {
  const open = pickerOpen || [...document.querySelectorAll(POPUPS)].some((el) => el.dataset.state !== 'closed');
  pickerOpen = false;
  if (open) e.preventDefault();
  return open;
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('focus', colorPicker.closed); // the picker may have taken the window's focus
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
// `host` stores the attrs: { commit(attrs, newGroup), undo(), redo(), emptyClick(), deleteBoard(), canUndo?(),
// canRedo?(), openCanvas?(id) (edit a canvas item), shift?(dx, dy) (canvas: every item moved by dx, dy; keep them in
// place on screen, → {x, y}: the part it could not, or nothing) }, and every commit must come back through setAttrs().
// Fluid (whiteboard): width 100 %, attrs {height, base, bg, items}, height bar, the height follows the content (§6c).
// Fixed (canvas): attrs {w, h, frame, bg, items, …}, no bounds: the artboard follows the content (§6b); no height bar,
// Fit height or Delete board. Auto-scroll during a gesture scrolls the nearest scrolling ancestor (the editor area). The
// chrome (tool rail, flyouts, item ribbon: src/app/components/board) observes a board through subscribe() /
// getSnapshot() and drives it through the action methods.

export class Board {
  constructor(attrs, host, { fixed = false, unit = 1 } = {}) {
    this.attrs = attrs;
    this.host = host;
    this.fixed = fixed;
    this.unit = unit; // board px per post px (§6c Units): 1 on a whiteboard, 1 / display scale on a canvas being edited
    this.sel = new Set(); // ids of the selected items (§6c multi-selection)
    this.editingId = null;
    this.editingSlot = null; // the connector label being edited (start | mid | end), else null
    this.savedRange = null; // caret inside the text being edited, restored after a chrome change
    this.mode = null; // null | 'pen' | 'eraser' | 'shape' | 'connector' | placement: 'text' | 'canvas' | 'image'
    this.pending = null; // 'image' mode: the picked files a click places; 'shape' mode: an armed prefab {id, items} (§6g)
    this.gesture = null;
    this.nodeSelected = false;
    this.listeners = new Set();
    injectStyle();

    this.dom = make('div', fixed ? 'wb wb-fixed' : 'wb', { tabIndex: 0 });
    this.dom.wbView = this; // lets the paste plugin reach the board it pastes into
    this.dom.style.setProperty('--wb-unit', String(unit));
    this.layer = make('div', 'wb-layer');
    this.guides = make('div', 'wb-guides');
    this.groupEl = make('div', 'wb-group', { hidden: true }); // the group box of several selected items
    this.hbar = fixed ? null : make('div', 'wb-hbar', { title: 'Drag to change board height' });
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
    if (this.hbar) this.dom.append(this.hbar);

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

  // Keeps its identity until something in it changes (useSyncExternalStore).
  // Item `item`'s properties as the ribbon shows them: no content (src, html, d, items), sizes in post px, a shape's label style
  // as drawn (§6d defaults), a connector's label sizes.
  itemProps(item) {
    const post = (v) => Math.max(1, Math.round(v / this.unit)); // a size in post px
    const { src, html, d, crop, items, ...rest } = item;
    let props = { ...rest, cropped: !!crop };
    if (item.type === 'shape') {
      const k = kindOf(item.shape);
      props = { size: LABEL.size, textColor: LABEL.textColor, bold: false, align: k?.align ?? LABEL.align, valign: k?.valign ?? LABEL.valign, ...props };
    }
    for (const k of UNIT_KEYS) if (k in props) props[k] = post(props[k]); // in post px
    if (item.type === 'connector') {
      props.labels = Object.fromEntries(Object.entries(item.labels ?? {}).map(([s, l]) => [s, { ...l, size: post(l.size ?? 14) }]));
    }
    return props;
  }

  // Several items selected (2026-10-07, the user: "when i select things i should be able to edit things that are in common"):
  // {type, item, mixed}: one type → that type's controls; shapes, connectors and pen strokes together → 'lines' (colour, width,
  // line style); `item` the first one's properties, which the controls show; `mixed` the fields whose values differ (a mixed
  // shape kind hides the Shape picker). null for other mixes and for canvases and images.
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
      kind: this.fixed ? 'canvas' : 'whiteboard',
      mode: this.mode,
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

  // The hover hint (src/app/components/HoverHint.jsx) for element `t` of a whiteboard in the document: its empty area and its
  // image and canvas items. None while the board is in use (focused, node-selected, a tool on) and on a canvas's board.
  hint(t) {
    if (this.fixed || this.nodeSelected || this.mode || this.owns(document.activeElement)) return null;
    const el = t.closest('.wb-item');
    if (!el) return t === this.hbar ? null : 'Click to select.';
    const type = this.items.find((i) => i.id === el.dataset.id)?.type;
    if (type === 'image') return 'Click to select. Double-click to edit the image.';
    return type === 'canvas' ? 'Click to select. Double-click to edit.' : null;
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

  setNodeSelected(on) {
    this.nodeSelected = on;
    this.dom.classList.toggle('wb-selected', on);
    updateActive();
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

  setBg(bg) {
    this.bg = bg;
    this.dom.dataset.bg = bg; // render() is held back during a text edit
    this.commit();
  }

  // An open text edit is committed first: setAttrs() would not show the undone state while it is open.
  undo() {
    this.finishEdit();
    this.host.undo();
  }

  redo() {
    this.finishEdit();
    this.host.redo();
  }

  deleteBoard() {
    if (!this.fixed) this.host.deleteBoard();
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
    const { bg, items } = this.attrs;
    const hadFocus = this.dom.contains(document.activeElement);
    if (this.fixed) {
      const { w, h } = this.attrs;
      const f = this.attrs.frame ?? { x: 0, y: 0, w, h };
      // Undo / redo, or a live shift that was not committed, moving the frame without resizing it: a normalisation
      // shift, kept in place on screen.
      const o = this.frame;
      if (o && f.w === o.w && f.h === o.h && (f.x !== o.x || f.y !== o.y)) this.host.shift?.(f.x - o.x, f.y - o.y);
      [this.width, this.height, this.frame] = [w, h, f];
      this.dom.style.width = `${w}px`;
    } else {
      // Drawn as stored; the next commit applies the smart height (old drafts have no base: their height is it).
      this.height = this.attrs.height;
      this.base = this.attrs.base ?? this.attrs.height;
    }
    this.bg = bg;
    this.els = new Map(); // id → element; empty while routing, so text heights are measured fresh
    this.targetKey = ''; // the sticking target shown (showTarget), gone with the old elements
    // Connectors are routed against the items as drawn (§6d); geo: their board px polylines (hit-testing, marquee).
    ({ items: this.items, geo: this.geo } = resolveConnectors(items.map((i) => ({ ...i })), this.measure));
    // Canvases made from an image before frames could be bound: a frame that is exactly the box of the only item binds to it.
    const one = this.fixed && !this.frame.item && this.items.length === 1 && this.items[0];
    if (one && one.type !== 'text' && ['x', 'y', 'w', 'h'].every((k) => Math.round(one[k]) === Math.round(this.frame[k]))) {
      this.frame = { ...this.frame, item: one.id };
    }
    for (const id of this.sel) if (!this.items.some((i) => i.id === id)) this.sel.delete(id);
    this.dom.style.height = `${this.size().h}px`;
    this.dom.dataset.bg = bg;
    this.layer.replaceChildren(...this.items.map((i) => this.addEl(i)));
    this.renderSelection();
    if (hadFocus && !this.dom.contains(document.activeElement)) this.dom.focus({ preventScroll: true });
  }

  // Every selected item has its outline; a single one also its handles (decorate), several the group box.
  renderSelection() {
    this.refreshScale();
    const one = this.selectedId;
    for (const el of this.layer.children) {
      el.classList.toggle('wb-sel', this.sel.has(el.dataset.id));
      for (const h of el.querySelectorAll(':scope > :is(.wb-handle, .wb-rot, .wb-end, .wb-mid, .wb-wp, .wb-qc)')) h.remove();
      if (el.dataset.id === one) this.decorate(el, this.selected());
    }
    this.placeGroupBox();
    this.emit();
  }

  // The handles of the one selected item: a connector's end, segment and waypoint handles (its box is derived: no
  // corners); any other item's corner handles (a shape's also its edge handles and rotate handle) and, except a stroke's,
  // its four quick-connect dots (§6d). Children of the item's element, they turn with a turned shape.
  decorate(el, item) {
    if (!item) return;
    if (item.type === 'connector') {
      // Segment and waypoint handles under the labels (a label at a segment's middle stays draggable), the ends on top.
      const [parts, ends] = this.connectorHandles(item);
      el.querySelector(':scope > .wb-text') ? el.querySelector(':scope > .wb-text').before(...parts) : el.append(...parts);
      el.append(...ends);
      return;
    }
    const title = item.type === 'image' ? 'Drag to resize, Ctrl + drag to crop' : 'Drag to resize';
    el.append(...CORNERS.map((c) => make('div', `wb-handle wb-h-${c}`, { title })));
    if (item.type === 'shape') {
      el.append(...EDGES.map((c) => make('div', `wb-handle wb-h-${c}`, { title })), make('div', 'wb-rot', { title: `Drag to rotate (Shift: 15 degree steps)${keyLabel('board.rotate') ? `, ${keyLabel('board.rotate')}: 90 degrees` : ''}` }));
    }
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
    ], geo.tipsAbs.map((t, k) => at(`wb-end${bound([c.from, c.to][k]) ? ' bound' : ''}`, t, { end: k }, 'Drag to reconnect (Alt: do not stick)'))];
  }

  // One dashed box around several selected items, without handles (live during a group move).
  placeGroupBox() {
    const box = this.sel.size > 1 && groupBox(this.selectedItems().map((i) => this.itemBox(i)));
    this.groupEl.hidden = !box;
    if (box) placeItem(this.groupEl, { ...box, type: 'shape' });
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
    }
    const text = item.type === 'text' ? this.itemEl(item.id)?.querySelector('.wb-text') : null;
    if (text) styleText(text, item); // the commit measures the restyled height
    // A shape whose label is being typed: the live label takes the style, the typed text is kept (as for text items).
    const label = item.type === 'shape' && item.id === this.editingId ? this.editText() : null;
    if (label) {
      styleLabel(label, item);
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
      if (text) styleText(text, item); // the commit measures the restyled height
    }
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
    const el = itemElement(item);
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

  // ids: one id, an array of ids, or null (none).
  select(ids) {
    this.sel = new Set(Array.isArray(ids) ? ids : ids ? [ids] : []);
    this.renderSelection();
  }

  // The board's size in board px (live during a gesture).
  size() {
    return { w: this.fixed ? this.width : this.dom.offsetWidth || DEFAULT_WIDTH, h: this.height };
  }

  // The bounds every item stays inside ({l, t, r, b}, board px): a whiteboard's left, top and right edges (its bottom
  // grows instead, §6c); a canvas has none (its artboard follows the content, §6b).
  limits() {
    return this.fixed ? { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity } : { l: 0, t: 0, r: this.size().w, b: Infinity };
  }

  // The size follows the content (`box`: an item being drawn counts too). Whiteboard: drawn height = max(base, lowest
  // item bottom + HEIGHT_PAD). Canvas: the smart artboard (§6b); when it grows or shrinks on the left / top, the items,
  // the frame and gesture `g` shift so it starts at 0,0 again.
  autoSize(box = null, g = null) {
    if (this.fixed) {
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
    } else this.height = Math.max(this.base, Math.ceil(Math.max(box ? box.y + box.h : 0, this.extent().h) + HEIGHT_PAD));
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
    el = itemElement(item);
    el.style.visibility = 'hidden';
    this.layer.append(el);
    const h = el.offsetHeight;
    el.remove();
    return h;
  }

  // The item's box (text: rendered height; a turned shape: the bounds of its turned box, §6d).
  itemBox(item) {
    if (item.type === 'shape' && item.rot) return rotBox(item);
    return { x: item.x, y: item.y, w: item.w, h: this.itemHeight(item) };
  }

  // Keeps the item (a turned shape: its turned bounds) inside the bounds; an item wider than the board is pinned to 0. A
  // connector's box is derived from its ends.
  clampItem(item) {
    if (item.type === 'connector') return;
    const { l, t, r } = this.limits();
    const b = item.type === 'shape' && item.rot ? rotBox(item) : item;
    item.x += fit(b.x, l, r - b.w) - b.x;
    item.y += Math.max(t, b.y) - b.y;
  }

  // Moves `items` by dx, dy together, no further than their group box stays inside the bounds.
  moveBy(items, dx, dy) {
    const d = clampMove(groupBox(items.map((i) => this.itemBox(i))), dx, dy, this.limits());
    for (const i of items) Object.assign(i, moveItem(i, d.dx, d.dy));
  }

  // The union of all item boxes (text: rendered height), or null without items.
  contentBox() {
    return groupBox(this.items.map((i) => this.itemBox(i)));
  }

  // Largest item right and bottom edge (text: rendered height).
  extent() {
    const boxes = this.items.map((i) => this.itemBox(i));
    return { w: Math.max(0, ...boxes.map((b) => b.x + b.w)), h: Math.max(0, ...boxes.map((b) => b.y + b.h)) };
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

  // Pointer position in board px, snapped when `g` (a gesture) is given, then kept `pad` px inside the bounds.
  pointAt(e, pad = 0, g = null) {
    let p = this.local(e);
    if (g) p = this.snapPoint(g, p, e);
    const { l, t, r, b } = this.limits();
    return { x: fit(p.x, l + pad, r - pad), y: fit(p.y, t + pad, b - pad) };
  }

  // newGroup: own undo step, even right after another commit (history merges commits within 500 ms).
  commit(newGroup = false) {
    if (this.destroyed) return;
    let capped;
    ({ items: this.items, geo: this.geo, capped } = resolveConnectors(this.items, this.measure)); // before autoSize: arrows count
    if (capped) toast('Too many crossing lines: some line jumps are not drawn', { id: 'wb-jump-cap' });
    this.autoSize();
    // A text item stores its rendered height (`h`, §6d): pure code (routing outside the Board) reads it.
    const attrs = { ...this.attrs, bg: this.bg, items: this.items.map((i) => (i.type === 'text' ? { ...i, h: this.itemHeight(i) } : { ...i })) };
    Object.assign(attrs, this.fixed ? { w: this.width, h: this.height, frame: this.frame } : { height: this.height, base: this.base });
    this.host.commit(attrs, newGroup);
  }

  // --- snapping (§6c) ---

  // Snap lines on one axis: other items' edges and centres, and the board's edges and centre lines (a whiteboard's
  // bottom moves with its content: there only the top edge counts on y).
  snapLines(g, axis) {
    const lines = [];
    if (snapRules.items) {
      for (const b of g.boxes) lines.push(...(axis === 'x' ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h]));
    }
    // A canvas snaps to its frame (its artboard edges follow the content), except to a frame bound to a moved item: that
    // is the item's own box a step ago, and snapping to it would hold the item back.
    if (snapRules.board && !(this.fixed && this.frame.item && g.starts.some((s) => s.id === this.frame.item))) {
      const f = this.fixed ? this.frame : { x: 0, y: 0, ...this.size() };
      lines.push(...(axis === 'x' ? [f.x, f.x + f.w / 2, f.x + f.w] : this.fixed ? [f.y, f.y + f.h / 2, f.y + f.h] : [0]));
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

  // Placement tools ('text', 'canvas', 'image', a prefab armed in 'shape' mode): a click adds the item(s) with the top-left
  // at the (snapped) pointer, kept inside the bounds, and the tool returns to Select. `e`: a pointer event over the board.
  place(e) {
    const [mode, pending] = [this.mode, this.pending];
    const p = this.snapped(e);
    this.setMode(null);
    if (mode === 'text') this.addText(p, pending?.note);
    else if (mode === 'canvas') this.addCanvas(p);
    else if (mode === 'shape') this.addCopies(pending.items, p);
    else this.addImageFiles(pending, p, true);
    this.pin(e);
  }

  // The pointer of event `e` in board px, snapped like a shape start (no gesture under way).
  snapped(e) {
    return this.pointAt(e, 0, { kind: 'place', boxes: this.items.map((i) => this.itemBox(i)), starts: [], guides: [] });
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
      color: textTool.color ?? (pageTheme() === 'light' ? '#111111' : '#ffffff'),
      bold: textTool.bold,
      align: 'left',
      bg,
    };
  }

  // A text item with its top-left at `p` (board px), edited at once (`note`: its note colour, default the text defaults').
  addText(p, note) {
    const item = this.textItem(p, note);
    this.finishEdit();
    this.clampItem(item);
    this.items.push(item);
    this.sel = new Set([item.id]);
    this.commit(true);
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
      this.clampItem(item);
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

  // A paste onto the board itself, centred in its visible part: a copied item or image files (pasteData), else the items of
  // smart canvases and whiteboards copied from a document (an image block is a canvas), else the text as a text item.
  pasteClipboard(data) {
    const c = this.visibleCentre();
    if (this.pasteData(data, c)) return;
    const items = copiedBoardItems(data.getData('text/html'), this.unit).filter((i) => !this.fixed || i.type !== 'canvas');
    if (items.length) {
      const box = groupBox(items.map((i) => this.itemBox(i)));
      this.addCopies(items, { x: c.x - box.w / 2, y: c.y - box.h / 2 });
      return;
    }
    const text = data.getData('text/plain').trim();
    if (!text) return;
    const item = { ...this.textItem(c), html: make('div', '', { innerText: text }).innerHTML };
    item.x = Math.round(c.x - item.w / 2);
    this.finishEdit();
    this.clampItem(item);
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

  fitHeight() {
    if (this.fixed) return;
    this.base = Math.max(MIN_HEIGHT, Math.ceil(this.extent().h + HEIGHT_PAD));
    this.commit();
  }

  // Natural pixel size of the visible region (a canvas item: its artboard size), capped to the board width; the board
  // grows to hold it (commit).
  resetSize(item = this.selected()) {
    const size = item?.type === 'canvas' ? { w: item.aw, h: item.ah } : this.naturalSize(item);
    if (!size) return;
    Object.assign(item, scaled(size, this.size().w));
    this.clampItem(item);
    this.commit();
  }

  // Natural pixel size of an image item's visible region, or null while its picture is not loaded.
  naturalSize(item) {
    const img = item?.type === 'image' && this.itemEl(item.id)?.querySelector('img');
    const c = item?.crop ?? FULL;
    return img?.naturalWidth ? { w: img.naturalWidth * c.w, h: img.naturalHeight * c.h } : null;
  }

  // Items under a grown item move down with its bottom edge (a canvas item growing with its artboard, §6b), so it never
  // covers them: every item that starts at or below the old bottom and shares columns with the grown item, transitively.
  pushDown(item, oldBottom) {
    const d = item.y + this.itemHeight(item) - oldBottom;
    if (d <= 0) return;
    const cols = [[item.x, item.x + item.w]];
    for (const i of this.items.filter((o) => o !== item && o.y >= oldBottom - 1).sort((a, b) => a.y - b.y)) {
      if (!cols.some(([l, r]) => i.x < r && i.x + i.w > l)) continue;
      Object.assign(i, moveItem(i, 0, d)); // a connector: its free ends and waypoints too
      cols.push([i.x, i.x + i.w]);
    }
  }

  // --- canvas items (§6b): the host edits them in place; canvases do not nest, so a fixed board has none ---

  // An empty canvas (artboard 800 × 450 shown at 400 × 225) with its top-left at `p` (board px); it is edited at once.
  addCanvas(p) {
    if (this.fixed) return;
    this.finishEdit();
    const size = scaled({ w: 400, h: 225 }, this.size().w);
    const item = { id: newId(), type: 'canvas', x: Math.round(p.x), y: Math.round(p.y), ...size, aw: 800, ah: 450, frame: { x: 0, y: 0, w: 800, h: 450 }, bg: 'post', items: [] };
    this.clampItem(item);
    this.items.push(item);
    this.sel = new Set([item.id]);
    this.commit(true);
    this.editCanvas(item);
  }

  // A double-clicked image becomes a canvas in its place and displayed size, holding just that image (its visible
  // region fills the artboard at natural size, crop kept); one undo step, then it is edited.
  imageToCanvas(item) {
    if (this.fixed) return;
    const { id, src, crop, x, y, w, h } = item;
    const art = scaled(this.naturalSize(item) ?? { w, h }, 8000, 8000);
    const image = { id: newId(), type: 'image', src, x: 0, y: 0, ...art, ...(crop && { crop }) };
    const canvas = { id, type: 'canvas', x, y, w, h, aw: art.w, ah: art.h, frame: { x: 0, y: 0, ...art, item: image.id }, bg: 'transparent', items: [image] };
    this.items[this.items.indexOf(item)] = canvas;
    this.sel = new Set([id]);
    this.commit(true);
    this.editCanvas(canvas);
  }

  editCanvas(item = this.selected()) {
    if (item?.type === 'canvas') this.host.openCanvas?.(item.id);
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
    this.clampItem(item);
    this.commit();
  }

  // Moves the selected items in z-order, keeping their order among themselves. where: 'front' | 'back' | 'forward' |
  // 'backward' (one step: each selected item swaps with the unselected item above / below it).
  arrange(where) {
    const on = (i) => this.sel.has(i.id);
    const up = (list) => {
      for (let k = list.length - 2; k >= 0; k--) if (on(list[k]) && !on(list[k + 1])) [list[k], list[k + 1]] = [list[k + 1], list[k]];
      return list;
    };
    const [sel, rest] = [this.items.filter(on), this.items.filter((i) => !on(i))];
    const items = {
      front: () => [...rest, ...sel],
      back: () => [...sel, ...rest],
      forward: () => up([...this.items]),
      backward: () => up([...this.items].reverse()).reverse(),
    }[where]();
    if (items.every((i, k) => i === this.items[k])) return;
    this.items = items;
    this.commit();
    if (!this.editingId) return;
    // setAttrs() skips re-rendering mid-edit: move the others around the edited (focused) element to keep the caret.
    const els = this.items.map((i) => this.itemEl(i.id));
    const k = els.indexOf(this.itemEl(this.editingId));
    els[k].before(...els.slice(0, k));
    els[k].after(...els.slice(k + 1));
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

  // axis: 'w' | 'h': every selected item takes the largest width / height among them (connectors, canvases, which keep
  // their aspect, and for 'h' text, whose height follows its text, are left out).
  sameSize(axis) {
    this.finishEdit();
    const items = this.selectedItems().filter((i) => i.type !== 'connector' && i.type !== 'canvas' && (axis === 'w' || i.type !== 'text'));
    if (items.length < 2) return;
    const boxes = sameBoxes(items.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h, rot: i.type === 'shape' ? i.rot : 0 })), axis);
    if (boxes.every((b, k) => b[axis] === items[k][axis])) return;
    items.forEach((i, k) => {
      Object.assign(i, { x: Math.round(boxes[k].x), y: Math.round(boxes[k].y), [axis]: boxes[k][axis] });
      this.clampItem(i);
    });
    this.commit();
  }

  // R (by 90), Shift+R (by −90), the ribbon's Rotate: every selected shape turns about its own centre. `to`: the angle field.
  rotate(by, to = null) {
    this.finishEdit();
    let turned = false;
    for (const s of this.selectedItems()) {
      const rot = (((to ?? (s.rot ?? 0) + by) % 360) + 360) % 360;
      if (s.type !== 'shape' || rot === (s.rot ?? 0)) continue;
      s.rot = rot;
      this.clampItem(s);
      turned = true;
    }
    if (turned) this.commit();
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
    const copies = cloneItems(sources, newId); // connectors between copies follow them; ends outside become free
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
    if (this.mode) this.setMode(null);
    this.sel = new Set(ids);
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

  // Adds tile `what` centred at board point p (kept inside the bounds), selected; one undo step. A text item is edited at once.
  insert(what, p) {
    this.finishEdit();
    const items = this.spawnItems(what, p);
    this.moveBy(items, 0, 0);
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
    itemClipboard = { token: `daf-writer-item:${newId()}`, unit: this.unit, items: structuredClone(items) };
    navigator.clipboard.writeText(itemClipboard.token).catch((err) => console.warn('Clipboard write failed:', err));
    if (cut) this.removeItem();
  }

  pasteItem() {
    if (!itemClipboard) return;
    // From a board of another unit: the clipboard takes this board's, so the copies keep their look in post px (§6c Units).
    const k = this.unit / itemClipboard.unit;
    if (k !== 1) Object.assign(itemClipboard, { unit: this.unit, items: itemClipboard.items.map((i) => scaleItem(i, k)) });
    const items = itemClipboard.items.filter((i) => !this.fixed || i.type !== 'canvas'); // canvases do not nest
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
      const l = { html: 'Label', t: at ?? LABEL_SLOTS[slot], dx: 0, dy: 0, size: r2(14 * this.unit), textColor: ink(), bold: false };
      c.labels = { ...c.labels, [slot]: l };
      this.sel = new Set([id]);
      this.commit(true);
    }
    this.startEdit(id, slot);
  }

  // The Labels popover's switch: on adds the slot's label and edits it, off removes it. One commit each.
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
    this.clampItem(copy);
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
    const id = pickInDirection(centre(src), this.items.filter((i) => ids.has(i.id)).map(centre), dir);
    if (id) this.select(id);
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

  // The ids connector ends never stick to: strokes (a freehand box is no node) and `skip`.
  noTargets(skip = null) {
    return new Set(this.items.filter((i) => i.type === 'stroke' || i.id === skip).map((i) => i.id));
  }

  // Where a dragged connector end goes (§6d Sticking): onto the topmost item under the pointer, at a port within 12 screen
  // px (fixed anchor) or anywhere inside its outline (floating); Alt: never. Else a free point, snapped (not with Ctrl) and
  // kept inside the bounds. The target shows its ports meanwhile.
  stickEnd(g, e) {
    if (e.altKey) this.altUsed = true; // releasing Alt must not open the window menu
    const hit = e.altKey ? null : hitTarget(this.items, this.local(e), { exclude: g.exclude, tol: 12 / this.scale(), measure: this.measure });
    this.showTarget(hit);
    if (hit) return hit;
    const p = this.pointAt(e, 0, g);
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
      const p = this.pointAt(e, 0, g);
      c.points = c.points.map((q, k) => (k === g.k ? { x: Math.round(p.x), y: Math.round(p.y) } : q));
    } else if (g.kind === 'seg' && g.pts0) {
      const p = this.local(e);
      const axis = g.dir === 'h' ? 'y' : 'x';
      let v = Math.round(p[axis] - g.p0[axis]);
      v += this.snapHit(g, axis, [g.pts0[g.k][axis] + v], e)?.d ?? 0;
      c.points = dragSegment(g.points0, g.pts0, g.k, axis === 'x' ? { x: v, y: 0 } : { x: 0, y: v });
    } else if (g.kind === 'seg') {
      const p = this.pointAt(e, 0, g);
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
    // Points stay half a line width (+1, the bbox padding) inside the bounds, so the stroke's box (g.box) does too.
    const pad = ink.width / 2 + 1;
    const p = this.pointAt(e, pad);
    Object.assign(this.gesture, { ink, points: [p], path, pad, box: { x: p.x - pad, y: p.y - pad, w: 2 * pad, h: 2 * pad } });
    path.setAttribute('d', smoothPath(this.gesture.points));
  }

  extendStroke(g, e) {
    // Coalesced events carry the samples the browser merged into this frame's pointermove.
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const p = this.pointAt(ev, g.pad);
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
    g.pad = isLineish(g.tool.shape) ? linePad(g.tool) : 0;
    g.start = this.pointAt(e, g.pad, g);
    this.extendShape(g, e);
  }

  extendShape(g, e) {
    g.end = this.pointAt(e, g.pad, g);
    g.box = shapeBox(g.start, g.end, e.shiftKey, g.tool, this.limits());
    const el = itemElement({ ...g.tool, ...g.box, id: 'preview', type: 'shape' });
    if (g.preview) g.preview.replaceWith(el);
    else this.layer.append(el);
    g.preview = el;
  }

  finishShape(g) {
    g.preview?.remove();
    // A click without a drag drops a default-size shape centred at the click.
    const box = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y) < 6 ? this.clickBox(g.tool, g.start) : g.box;
    const { l, t, r, b } = this.limits();
    const item = { id: newId(), type: 'shape', ...g.tool, ...box, w: Math.min(box.w, r - l), h: Math.min(box.h, b - t) };
    this.clampItem(item);
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
      if (item.textColor == null) item.textColor = ink();
      if (item.size == null) item.size = r2(LABEL.size * this.unit);
      el.append(shapeLabel({ ...item, html: '' }));
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
    if (e.button !== 0 || dismissOnly(e)) return;
    if (e.target === this.hbar) {
      this.finishEdit();
      this.startGesture(e, 'height');
      return;
    }
    if (this.mode) {
      this.finishEdit();
      e.preventDefault();
      this.dom.focus({ preventScroll: true });
      if (['text', 'canvas', 'image'].includes(this.mode) || (this.mode === 'shape' && this.pending)) return this.place(e);
      this.startGesture(e, this.mode, []);
      if (this.mode === 'pen') this.startStroke(e);
      else if (this.mode === 'shape') this.startShape(e);
      else if (this.mode === 'connector') this.startConnector(e);
      else this.eraseTo(Object.assign(this.gesture, { erased: new Set() }), e.clientX, e.clientY);
      this.showGuides(this.gesture.guides);
      return;
    }
    const itemEl = e.target.closest('.wb-item');
    if (!itemEl) {
      this.finishEdit();
      this.startGesture(e, 'marquee'); // a drag selects what it touches, a click deselects (finishMarquee)
      return;
    }
    // A resize handle (corner, a shape's edge) or the rotate handle ('rot').
    const corner = [...CORNERS, ...EDGES].find((c) => e.target.classList.contains(`wb-h-${c}`))
      ?? (e.target.classList.contains('wb-rot') ? 'rot' : undefined);
    const id = itemEl.dataset.id;
    if (id === this.editingId && this.editText()?.contains(e.target)) return; // caret placement inside the text being edited
    this.finishEdit();
    if (this.connectorPart(e, id)) return;
    // Shift + click adds the item to the selection, or takes a selected one out on release (so Shift + drag still moves
    // it). Pressing one of several selected items moves them all; released without a drag, only it stays selected.
    let click = null; // the selection a release without a drag leaves
    if (!this.sel.has(id)) this.select(e.shiftKey ? [...this.sel, id] : id);
    else if (e.shiftKey && !corner) click = [...this.sel].filter((s) => s !== id);
    else if (this.sel.size > 1) click = [id];
    this.dom.focus({ preventScroll: true });
    const crop = corner && (e.ctrlKey || e.metaKey) && this.selected()?.type === 'image';
    // A label of the one selected connector drags along / beside its path (§6d; the pointer keeps its grip on it); in a
    // multi-selection it moves the group.
    const slot = !corner && this.selectedId === id && e.target.closest('.wb-conn > .wb-text[data-slot]')?.dataset.slot;
    this.startGesture(e, slot ? 'label' : crop ? 'crop' : corner === 'rot' ? 'rotate' : corner ? 'resize' : 'move');
    Object.assign(this.gesture, { corner, copy: !corner && !slot && e.altKey, click, slot });
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
  // right-click leaves the tool; on an item outside the selection it selects that item alone, elsewhere it keeps the selection.
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
    if (id && !this.sel.has(id)) this.select(id);
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
      boxes: others.map((i) => this.itemBox(i)), // snap targets
      base: this.base,
      height: this.height,
      guides: [],
      last: null, // pointer state of the last move, replayed while auto-scrolling
      off: { x: 0, y: 0 }, // see local()
    };
    this.gesture.conns = this.attached(moving);
    this.dom.setPointerCapture(e.pointerId);
  }

  // `moving` plus what lies fully inside a moving lane or frame (§6d containment, by geometry at the drag's start): items by
  // their turned bounds, connectors by their box (so their bends move too). Nothing is re-parented.
  withContents(moving) {
    const take = new Set(moving);
    for (const box of moving.filter((i) => i.type === 'shape' && kindOf(i.shape)?.group === 'container')) {
      const ids = new Set(containedIn(box, this.items, this.measure));
      const c = this.itemBox(box);
      const inside = (b) => b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h;
      for (const i of this.items) if (ids.has(i.id) || (i.type === 'connector' && inside(this.itemBox(i)))) take.add(i);
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
      if (g.kind === 'height') this.base = Math.max(MIN_HEIGHT, Math.round(g.base + dy));
      else {
        if (['end', 'wp', 'seg', 'label'].includes(g.kind)) this.followConnector(g, e);
        else this.followItem(g, e, dx, dy);
        this.refreshConnectors(g);
      }
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

  // Release on empty board area: the items the rectangle touches become the selection (Shift: are added); a click
  // without a drag deselects (a whiteboard becomes node-selected).
  finishMarquee(g, add) {
    if (!g.marquee) {
      this.select(null);
      this.host.emptyClick();
      return;
    }
    g.marquee.remove();
    const [conns, rest] = [this.items.filter((i) => i.type === 'connector'), this.items.filter((i) => i.type !== 'connector')];
    const hits = [...marqueeHits(g.rect, rest.map((i) => ({ id: i.id, ...this.itemBox(i) }))),
      ...conns.filter((c) => polylineHitsRect(this.geo.get(c.id)?.pts ?? [], g.rect)).map((c) => c.id)]; // by their line
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

  // Move: every selected item, by the move of their group box, which snaps and stays inside the bounds. Resize / crop:
  // the one selected item.
  followItem(g, e, dx, dy) {
    if (!g.moving.length) return;
    let box; // the changed box: its edges keep the guides
    if (g.kind === 'move') {
      if (g.copy && !g.copied) {
        // Alt + drag: copies move, the originals stay.
        g.copied = this.altCopied = true;
        g.moving = cloneItems(g.starts, newId);
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
      const d = clampMove(b, Math.round(x) - b.x, Math.round(y) - b.y, this.limits());
      g.moving.forEach((i, k) => {
        Object.assign(i, moveItem(g.starts[k], d.dx, d.dy));
        const el = this.itemEl(i.id);
        if (el) placeItem(el, i);
      });
      box = { ...b, x: b.x + d.dx, y: b.y + d.dy };
    } else {
      const item = g.moving[0];
      if (g.kind === 'crop') this.cropItem(item, g, dx, dy, e);
      else if (g.kind === 'rotate') this.rotateItem(item, g, e);
      else this.resizeItem(item, g, dx, dy, e);
      const el = this.itemEl(item.id);
      placeItem(el, item);
      if (g.kind === 'crop') placeCrop(el.querySelector('img'), item.crop);
      box = this.itemBox(item);
    }
    // A guide stays only while its snap survived the bounds.
    const edges = { x: [box.x, box.x + box.w / 2, box.x + box.w], y: [box.y, box.y + box.h / 2, box.y + box.h] };
    g.guides = g.guides.filter(({ axis, at }) => edges[axis].some((v) => Math.abs(v - at) < 0.6));
    this.emit(); // the ribbon follows
  }

  // Corner (a shape: also edge) resize from the gesture's start box with the opposite corner (edge) fixed; stops at the
  // bounds and at the minimum size (never flips). Minimum: MIN_ITEM per side, or the start size if already smaller. The
  // moving edges snap. A turned shape resizes in its own frame (resizeInFrame, §6d): no snapping, no size cap; a whiteboard
  // then pulls its turned box back inside.
  resizeItem(item, g, dx, dy, e) {
    const start = g.starts[0];
    if (start.rot) {
      Object.assign(item, resizeInFrame(start, g.corner, dx, dy, { aspect: e.shiftKey, min: MIN_ITEM }));
      this.clampItem(item);
      return;
    }
    const [sx, sy] = [g.corner.includes('w') ? -1 : g.corner.includes('e') ? 1 : 0, g.corner.includes('n') ? -1 : g.corner.includes('s') ? 1 : 0];
    const bounds = this.limits();
    const ax = sx > 0 ? start.x : start.x + start.w; // the fixed corner
    const maxW = sx > 0 ? bounds.r - ax : ax - bounds.l;
    const size = (n, min, max) => Math.max(min, Math.min(Math.round(n), max));
    // The size whose moving edge (fixed edge a, direction s) lands on a snap line.
    const snapSize = (axis, a, s, n) => n + s * (this.snapHit(g, axis, [a + s * n], e)?.d ?? 0);
    if (item.type === 'text') {
      // Width only; the reflowed text is then kept inside the bounds.
      item.w = size(snapSize('x', ax, sx, start.w + sx * dx), Math.min(MIN_ITEM, start.w), maxW);
      item.x = sx > 0 ? ax : ax - item.w;
      placeItem(this.itemEl(item.id), item);
      this.clampItem(item);
      return;
    }
    const ay = sy > 0 ? start.y : start.y + start.h;
    const maxH = sy > 0 ? bounds.b - ay : ay - bounds.t;
    const [w, h] = [start.w + sx * dx, start.h + sy * dy]; // the box the pointer asks for
    if (sx && sy && (item.type === 'canvas' || (item.type === 'shape' ? e.shiftKey : !e.shiftKey))) {
      // Images and strokes keep their aspect unless Shift, canvases always; shapes resize freely unless Shift. One
      // scale for both axes (the corner follows the pointer along the diagonal, snapped on x), clamped on the larger
      // side only, so thin strokes and dots keep their shape.
      const k = snapSize('x', ax, sx, (start.w * (w * start.w + h * start.h)) / (start.w ** 2 + start.h ** 2)) / start.w;
      const s = Math.max(Math.min(1, MIN_ITEM / Math.max(start.w, start.h)), Math.min(k, maxW / start.w, maxH / start.h));
      item.w = Math.max(1, Math.round(start.w * s));
      item.h = Math.max(1, Math.round(start.h * s));
    } else {
      // An edge handle (sx or sy 0) leaves the other side as it was.
      item.w = sx ? size(snapSize('x', ax, sx, w), Math.min(MIN_ITEM, start.w), maxW) : start.w;
      item.h = sy ? size(snapSize('y', ay, sy, h), Math.min(MIN_ITEM, start.h), maxH) : start.h;
    }
    item.x = sx > 0 ? ax : sx < 0 ? ax - item.w : start.x;
    item.y = sy > 0 ? ay : sy < 0 ? ay - item.h : start.y;
  }

  // The rotate handle (§6d): the shape turns by the angle the pointer has turned about its centre since the press, in whole
  // degrees; Shift: 15° steps. On a whiteboard its turned box is kept inside.
  rotateItem(item, g, e) {
    const s = g.starts[0];
    const c = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const angle = (p) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
    const rot = (s.rot ?? 0) + angle(this.local(e)) - angle(g.p0);
    item.rot = (((e.shiftKey ? Math.round(rot / 15) * 15 : Math.round(rot)) % 360) + 360) % 360;
    Object.assign(item, { x: s.x, y: s.y });
    this.clampItem(item);
  }

  // Ctrl + corner on an image: that corner's two edges move over the picture, which stays where it is at its scale.
  // Edges stop at the picture's own edges (dragging outward un-crops), the bounds and the minimum size; they snap.
  cropItem(item, g, dx, dy, e) {
    const s = g.starts[0];
    const c = s.crop ?? FULL;
    const [fw, fh] = [s.w / c.w, s.h / c.h]; // the whole picture on the board
    const [ox, oy] = [s.x - c.x * fw, s.y - c.y * fh];
    const bounds = this.limits();
    const edge = (axis, v, min, max) => fit(Math.round(v + (this.snapHit(g, axis, [v], e)?.d ?? 0)), min, max);
    let [l, t, r, b] = [s.x, s.y, s.x + s.w, s.y + s.h];
    const [mw, mh] = [Math.min(MIN_ITEM, s.w), Math.min(MIN_ITEM, s.h)];
    if (g.corner.includes('w')) l = edge('x', l + dx, Math.max(ox, bounds.l), r - mw);
    else r = edge('x', r + dx, l + mw, Math.min(ox + fw, bounds.r));
    if (g.corner.includes('n')) t = edge('y', t + dy, Math.max(oy, bounds.t), b - mh);
    else b = edge('y', b + dy, t + mh, Math.min(oy + fh, bounds.b));
    Object.assign(item, { x: l, y: t, w: r - l, h: b - t });
    const crop = { x: (l - ox) / fw, y: (t - oy) / fh, w: item.w / fw, h: item.h / fh };
    if ([crop.x, crop.y, 1 - crop.w, 1 - crop.h].every((v) => Math.abs(v) < 1e-6)) delete item.crop;
    else item.crop = crop;
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
    const changed = g.kind === 'height' ? this.base !== g.base
      : g.copied || g.moving.some((i, k) => CHANGE_KEYS.some((p) => JSON.stringify(i[p]) !== JSON.stringify(g.starts[k][p])));
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
    // unfilled (geometric hit; strokes, lines and arrows count by their line only), so its label can be edited.
    const lineish = (i) => i.type === 'stroke' || (i.type === 'shape' && isLineish(i.shape));
    const geo = hitTarget(this.items, this.local(e), { exclude: new Set(this.items.filter(lineish).map((i) => i.id)), measure: this.measure });
    const inside = geo && this.items.find((i) => i.id === geo.item);
    if (inside && (!item || (lineish(item) && this.items.indexOf(inside) > this.items.indexOf(item)))) item = inside;
    if (!item || item.id === this.editingId) return;
    if (item.type === 'text') this.startEdit(item.id);
    else if (item.type === 'shape') this.editShapeLabel(item);
    else if (item.type === 'image') this.imageToCanvas(item);
    else this.editCanvas(item);
  };

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
        this.dom.focus({ preventScroll: true });
      }
      return;
    }
    const arrow = { ArrowLeft: 'w', ArrowRight: 'e', ArrowUp: 'n', ArrowDown: 's' }[e.key];
    // Escape: end a text edit (above) → leave the tool → deselect.
    if (e.key === 'Escape' && (this.mode || this.sel.size)) {
      e.preventDefault();
      if (this.mode) this.setMode(null);
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
      'board.selectAll': () => {
        if (this.mode) this.setMode(null);
        this.select(this.items.map((i) => i.id));
      },
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
        'board.rotate': () => this.rotate(90), // the selected shapes turn 90° clockwise / back (§6d)
        'board.rotateBack': () => this.rotate(-90),
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
    if (e.key === 'Tab' && this.items.length) {
      // Next / previous item in z-order.
      e.preventDefault();
      if (this.mode) this.setMode(null);
      const n = this.items.length;
      const i = this.items.findIndex((it) => it.id === this.selectedId);
      this.select(this.items[i < 0 ? (e.shiftKey ? n - 1 : 0) : (i + (e.shiftKey ? n - 1 : 1)) % n].id);
      return;
    }
    if (!this.sel.size) return;
    const item = this.selected();
    // Enter / F2: edit the text, the shape's label or the connector's middle label (added if missing); Enter opens a canvas.
    if ((e.key === 'Enter' || e.key === 'F2') && ['text', 'shape', 'connector'].includes(item?.type)) {
      e.preventDefault();
      if (item.type === 'text') this.startEdit(item.id);
      else if (item.type === 'shape') this.editShapeLabel(item);
      else this.editLabel(item.id, 'mid');
      return;
    }
    if (e.key === 'Enter' && item?.type === 'canvas') {
      e.preventDefault();
      this.editCanvas(item);
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
  // keys. Also reached from the document while the whiteboard is node-selected (WhiteboardPaste).
  toolKey(e) {
    const tools = {
      'board.select': () => this.mode && this.setMode(null),
      'board.text': () => this.setMode(this.mode === 'text' ? null : 'text'),
      'board.image': () => this.pickImages(),
      'board.pen': () => this.setMode('pen'),
      'board.eraser': () => this.setMode('eraser'),
      'board.shape': () => this.setMode('shape'),
      'board.connector': () => this.setMode('connector'),
      'board.canvas': () => this.fixed || this.setMode('canvas'), // canvases do not nest
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
// NodeView: ProseMirror adapter around Board.

class WhiteboardView {
  constructor({ node, view, getPos, editor }) {
    this.node = node;
    this.board = new Board(node.attrs, {
      commit: (attrs, newGroup) => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const tr = view.state.tr.setNodeMarkup(pos, undefined, attrs);
        if (newGroup) closeHistory(tr);
        view.dispatch(tr);
      },
      undo: () => withoutScroll(() => editor.commands.undo?.()),
      redo: () => withoutScroll(() => editor.commands.redo?.()),
      canUndo: () => !!editor.can().undo?.(),
      canRedo: () => !!editor.can().redo?.(),
      emptyClick: () => {
        const pos = getPos();
        if (typeof pos === 'number') editor.commands.setNodeSelection(pos);
        view.focus();
      },
      deleteBoard: () => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        view.dispatch(view.state.tr.delete(pos, pos + this.node.nodeSize));
        view.focus();
      },
      openCanvas: (id) => editor.storage.canvas?.openItem(this, id), // src/canvas.js; it sets this.session
    });
    this.dom = this.board.dom; // dom.wbView is the Board
    this.editor = editor;
    this.session = null; // the edit mode of one of the board's canvas items (src/canvas.js)
    this.onTransaction = () => this.board.emit(); // undo / redo availability (snapshot) follows the whole document
    editor.on('transaction', this.onTransaction);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.board.setAttrs(node.attrs);
    this.session?.sync(); // closes when its item is gone
    return true;
  }

  // Everything inside the board is ours, except paste/drop, which must reach WhiteboardPaste's handlers.
  stopEvent(event) {
    if (this.board.editingId) return true;
    return !['paste', 'drop', 'dragover', 'dragenter', 'dragleave'].includes(event.type);
  }

  ignoreMutation() {
    return true;
  }

  selectNode() {
    this.board.setNodeSelected(true);
  }

  deselectNode() {
    this.board.setNodeSelected(false);
  }

  destroy() {
    this.editor.off('transaction', this.onTransaction);
    this.session?.close(); // the whiteboard is gone
    this.board.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Node

export const Whiteboard = Node.create({
  name: 'whiteboard',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      height: { default: DEFAULT_ATTRS.height, rendered: false },
      base: { default: DEFAULT_ATTRS.base, rendered: false },
      bg: { default: DEFAULT_ATTRS.bg, rendered: false },
      items: { default: DEFAULT_ATTRS.items, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-whiteboard]', getAttrs: (el) => parseBoard(el.getAttribute('data-json')) }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-whiteboard': '', 'data-json': JSON.stringify(node.attrs) }];
  },

  addCommands() {
    return {
      insertWhiteboard:
        (attrs = {}) =>
        ({ state, tr, dispatch }) => {
          if (dispatch) insertBoard(tr, topLevelPos(state.selection.$to), state.schema.nodes[this.name].create(attrs));
          return true;
        },
    };
  },

  addNodeView() {
    return (props) => new WhiteboardView(props);
  },
});

// ---------------------------------------------------------------------------------------------
// Rasterizer

export async function rasterizeWhiteboard(attrs, { width, theme, scale = 2 }) {
  injectStyle();
  const height = attrs.height;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
  const board = document.createElement('div');
  board.style.cssText = `position:relative;overflow:hidden;width:${width}px;height:${height}px`;
  board.style.setProperty('--wb-bg', resolveBg(attrs.bg, theme) ?? 'transparent'); // connector labels mask the line with it
  board.append(...routed(attrs.items).map(itemElement));
  host.append(board);
  document.body.append(host);
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
    if (!blob) throw new Error('Whiteboard rasterization produced no image');
    return { blob, width, height };
  } finally {
    host.remove();
  }
}

import { closeHistory } from '@tiptap/pm/history';
import { commitSynced, liveBoard } from '../../canvas.js';
import { pathOfPos, posOfPath } from '../../doc-path.mjs';
import { withCall } from '../../suggest/extension.js';
import { drawTheme, pageOf } from '../../formats.mjs';
import { validFlow } from '../../flow/library.mjs';
import {
  arrangeItems, cleanConnector, groupItems, moveItem, normalizeGroups, repairEnds, unbindFrom, ungroupItems, validConnector,
} from '../../flow/model.mjs';
import { resolveConnectors } from '../../flow/route.mjs';
import { KINDS, rotBox, rotOf } from '../../flow/shapes.mjs';
import {
  boardSurface, contentWidth, groupBox, injectStyle, itemElement, make, parseBoard, rasterizeWhiteboard, smartArtboard, topLevelPos, WB_BG,
} from '../../whiteboard.js';
import { endSide } from '../assistant/attach.mjs';
import { keyLabel } from '../keybinds.js';
import { validate } from '../schema.mjs';
import { define, fail, failGates } from './define.mjs';
import { boardStyles, contrastWarnings, inkOn, matchStyle, pageItems, styledText } from './item-style.mjs';
import { DRAFT_ID, ITEM, ITEM_ID, ref } from './schema-defs.mjs';

// board.* (SPEC §8 Catalogue; agent-automation plan §6.3): the items of a canvas block of the open draft. Every write is one
// undo step: the canvas is measured offscreen with its smart artboard and committed through canvas.js commitSynced (a synced
// canvas also writes its library flowchart). whiteboard.js and canvas.js are imported, never changed.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const newId = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');
const IDS = { type: 'array', items: ITEM_ID, minItems: 1, maxItems: 500 };
const BOARD_PATH = ref('PATH', 'Board block path, from board_list');
const BOARD_NEEDS = ['doc.open', 'node.board'];
const CANVAS_DEFAULT = { w: 800, h: 450 }; // canvas.js DEFAULT
const busy = (ctx, a) => ctx.lib.boardBusy(a.path);

/** The canvas block at `path` → {pos, node, cv (its NodeView), board (what it shows: a synced canvas's library board)}. */
export function target(ctx, path) {
  const ed = ctx.editor;
  const pos = posOfPath(ed.state.doc, path);
  if (pos === null) fail('not_found', `No block at [${path}]`, { path });
  const node = ed.state.doc.nodeAt(pos);
  if (node.type.name !== 'canvas') failGates(['node.board']);
  const cv = ed.view.nodeDOM(pos)?.scView ?? null;
  return { pos, node, cv, board: cv ? liveBoard(cv) : node.attrs };
}

export const itemsOf = (t) => t.board.items;
/** The theme the draft's canvases draw in (formats.mjs drawTheme: light on a Document's paper). */
const themeOf = (ctx) => drawTheme(ctx.state.draft, ctx.state.settings);
const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', amp: '&' };
const plain = (i) => String(i?.html ?? i?.labels?.mid?.html ?? '').replace(/<[^>]*>/g, ' ').replace(/&(nbsp|lt|gt|quot|amp);/g, (_, e) => ENTITIES[e])
  .replace(/\s+/g, ' ').trim();
const int = (v) => (typeof v === 'number' ? Math.round(v) : undefined); // undefined fields drop out of the JSON

/** Item `i` in board.get's brief form (`byId`: the board's items, for a connector's ends): id, type, shape, label, the box in
 * whole px, hidden, locked and groups when set (§6 Layer fields); a connector's ends ({item, label, side (attach.mjs endSide)} | {x, y}), route, end head and bends (its waypoint count, as the attachment's item
 * lines name it, attach.mjs itemLines). No d, src, vw / vh or html; a label past 120 characters is
 * cut (a long text item stays one short line; board.find matches the whole). */
function briefItem(i, byId) {
  const short = (it) => {
    const s = plain(it);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s || undefined;
  };
  const label = short(i);
  const end = (e) => (typeof e?.item === 'string' ? { item: e.item, label: short(byId.get(e.item)), side: endSide(e.anchor) } : { x: int(e?.x), y: int(e?.y) });
  return {
    id: i.id, type: i.type, shape: i.shape, label, x: int(i.x), y: int(i.y), w: int(i.w), h: int(i.h),
    ...(i.hidden && { hidden: true }), ...(i.locked && { locked: true }), ...(i.groups && { groups: i.groups }),
    ...(i.type === 'connector' && { from: end(i.from), to: end(i.to), route: i.route, heads: i.heads, bends: i.points?.length ?? 0 }),
  };
}

// board.find: words a user may say for a type (beside the type, the shape kind and its name), and words that match nothing.
const FIND_WORDS = { connector: 'arrow line', image: 'picture', stroke: 'pen drawing' };
const KIND_NAMES = new Map(KINDS.map((k) => [k.kind, k.label]));
const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'to', 'and']);
const MAX_FOUND = 40;

/** The words board.find matches item `i` against (lower case): its label, type, shape and, for a connector, its ends' labels. */
function findText(i, byId) {
  const ends = i.type === 'connector' ? `from ${plain(byId.get(i.from?.item))} to ${plain(byId.get(i.to?.item))}` : '';
  return `${plain(i)} ${i.type} ${FIND_WORDS[i.type] ?? ''} ${i.shape ?? ''} ${KIND_NAMES.get(i.shape) ?? ''} ${ends}`.toLowerCase();
}

/** The defaults an agent may leave out: the board's own style first (item-style.mjs matchStyle, `items` the target's items, `page`
 * the draft's other boards' items), then a new text item's (Board.textItem): lines in the theme's ink on `board` (the board's
 * background colour in `theme`). Text left without a colour stays without one: it draws in the theme's text colour for what it
 * sits on at every draw (whiteboard.js, inkOn), so a theme switch, a new background or a Document's paper keeps it readable.
 * Also flow.mjs. */
export function itemDefaults(item, theme, board, items = [], page = []) {
  const i = matchStyle(item, items, page, board);
  const color = inkOn(board, theme);
  if (i.type === 'text') return { size: 20, bold: false, align: 'left', bg: null, ...i };
  if (i.type === 'shape') return { color, width: 2, opacity: 1, fill: 'none', fillColor: color, ...i };
  if (i.type === 'connector') return { color, ...i };
  return i;
}

/** `items` with ids unused among `used` (which grows): a given id is kept when free; connector ends that name an item of the
 * same call follow its final id (cloneItems). */
function freshIds(items, used) {
  const ids = new Map();
  const out = items.map((i) => {
    let id = typeof i.id === 'string' && !used.has(i.id) ? i.id : newId();
    while (used.has(id)) id = newId();
    used.add(id);
    if (typeof i.id === 'string' && !ids.has(i.id)) ids.set(i.id, id);
    return { ...i, id };
  });
  const end = (e) => (typeof e?.item === 'string' && ids.has(e.item) ? { ...e, item: ids.get(e.item) } : e);
  return out.map((i) => (i.type === 'connector' ? { ...i, from: end(i.from), to: end(i.to) } : i));
}

/** Item `i` as the board keeps it (whiteboard.js validItem + cleanItem, through parseBoard), or invalid_args at `at`. */
function checked(i, at) {
  const kept = i.type === 'connector' ? (validConnector(i) ? [cleanConnector(i)] : []) : parseBoard(JSON.stringify({ items: [i] })).items;
  if (kept.length !== 1) fail('invalid_args', `${at.slice(1) || 'the item'} is not a valid ${i.type} item`, { path: at, message: 'is not a valid board item', expected: ITEM });
  return kept[0];
}

/** Warnings for the connectors among `ids` whose ends repairEnds freed or dropped between `before` and `after`. */
function endWarnings(before, after, ids) {
  const now = new Map(after.map((i) => [i.id, i]));
  const out = [];
  for (const c of before) {
    if (c.type !== 'connector' || !ids.has(c.id)) continue;
    const a = now.get(c.id);
    if (!a) out.push({ id: c.id, message: 'dropped: neither end is on the board' });
    else for (const k of ['from', 'to']) if (typeof c[k]?.item === 'string' && typeof a[k]?.item !== 'string') out.push({ id: c.id, end: k, message: `freed: no item ${c[k].item} on the board` });
  }
  return out;
}

/** The artboard of board `b` ({w, h, frame}) after its items became `items` (§6b smart artboard, as Board.autoSize): groups
 * made whole (§6 Layer fields, as Board.commit), connectors routed, text measured offscreen (Board.itemHeight without a Board), a
 * frame bound to an item following it, everything shifted so the artboard starts at 0,0 → {w, h, dx, dy, frame, items} (text
 * items carry their measured h). `fit`: the frame becomes the items' box first (canvas.js fitArtboard, the edit bar's Fit). */
function settle(b, items, fit = false) {
  injectStyle();
  const host = make('div', 'wb');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:8000px;height:0;margin:0;visibility:hidden;pointer-events:none';
  const layer = make('div', 'wb-layer');
  host.append(layer);
  document.body.append(host);
  const heights = new Map();
  const measure = (i) => {
    if (i.type !== 'text') return i;
    if (!heights.has(i.id)) {
      const el = itemElement(i);
      layer.append(el);
      heights.set(i.id, el.offsetHeight);
      el.remove();
    }
    return { x: i.x, y: i.y, w: i.w, h: heights.get(i.id) };
  };
  try {
    let list = resolveConnectors(normalizeGroups(items), measure).items;
    const box = (i) => {
      const r = rotBox({ ...measure(i), rot: rotOf(i) });
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    };
    let frame = b.frame ?? null;
    const content = groupBox(list.map(box));
    const side = (v) => Math.max(40, Math.min(Math.ceil(v), 8000)); // canvas.js MIN_SIZE, MAX_SIZE
    if (fit && content) frame = { x: content.x, y: content.y, w: side(content.w), h: side(content.h), ...(list.length === 1 && { item: list[0].id }) };
    const bound = frame?.item && list.find((i) => i.id === frame.item);
    if (bound) frame = { ...box(bound), item: bound.id };
    else if (frame?.item) frame = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    const a = smartArtboard(frame, { w: b.w, h: b.h }, content);
    if (a.dx || a.dy) list = list.map((i) => moveItem(i, a.dx, a.dy));
    return { ...a, items: list.map((i) => (i.type === 'text' ? { ...i, h: measure(i).h } : i)) };
  } finally {
    host.remove();
  }
}

// coords of board.items.add / .update. Qwen Cloud (2026-10-08) answers every box on a picture in thousandths of it whatever the
// prompt asks (a probe asked for pixels: IoU 0; for 0..1000: 0.95 to 0.99), so the app converts them (SPEC §7i Board coordinates in thousandths).
const COORDS = { enum: ['px', 'thousandths'], default: 'px', description: "thousandths: x, y, w, h are 0 to 1000 of the board's width and height" };
const scaled = (o, { w, h }) => {
  if (!isObject(o)) return o;
  const out = { ...o };
  for (const [k, s] of [['x', w], ['y', h], ['w', w], ['h', h]]) {
    if (typeof o[k] !== 'number') continue;
    const r = Math.round((o[k] * s) / 1000);
    // A w or h of 1 on a board under 500 px rounds to 0, which checked rejects (SIZE minimum 1): a thin line shape stays 1 px.
    out[k] = k === 'w' || k === 'h' ? Math.max(1, r) : r;
  }
  return out;
};
/** Item or patch `o` with its coordinates in thousandths of a `size` ({w, h}) board turned into whole board px: x y w h, a
 * connector's free ends and waypoints. Label offsets stay px. */
export function fromThousandths(o, size) {
  const out = scaled(o, size);
  for (const k of ['from', 'to']) if (k in o) out[k] = scaled(o[k], size); // a bound end has no x, y and stays as it is
  if (Array.isArray(o.points)) out.points = o.points.map((p) => scaled(p, size));
  return out;
}

/** Runs `edit(items, {size}) → {items, result, bg?, frame?, fit?, dw?}` on the items of the canvas at `a.path` and commits it as
 * one undo step (header); `size` ({w, h}) is the artboard's, as view.render draws it. → edit's result. */
function write(ctx, a, edit) {
  const t = target(ctx, a.path);
  const view = ctx.editor.view;
  const cv = t.cv ?? fail('failed', 'The canvas is not drawn');
  const out = edit(t.board.items, { size: { w: t.board.w, h: t.board.h }, bg: t.board.bg });
  const s = settle({ ...t.board, ...(out.frame !== undefined && { frame: out.frame }) }, out.items, out.fit);
  // A new artboard width keeps the displayed width's ratio to it (canvas.js nodeTarget); a set one or a changed one is never
  // wider than the page.
  const page = contentWidth(view);
  const dw = out.dw != null ? Math.min(out.dw, page)
    : s.w === t.board.w ? t.node.attrs.dw : Math.min(Math.round((t.node.attrs.dw / t.board.w) * s.w), page);
  // A suggesting call's change is recorded as its suggestion (suggest/extension.js); a linked canvas writes its library at once,
  // and a reject writes the old board back (CanvasView.update).
  withCall(ctx.editor, ctx.suggest, 'exact', () => {
    commitSynced(cv, t.pos, { ...t.node.attrs, w: s.w, h: s.h, frame: s.frame, bg: out.bg ?? t.board.bg, items: s.items, dw }, true);
    view.dispatch(closeHistory(view.state.tr)); // the user's next typing starts its own undo step
  });
  return out.result;
}

/** Item `old` with board.items.update's `patch` merged in: fields replaced, `labels` and `heads` merged per slot (null removes
 * a slot); a connector patched to route straight without points of its own loses its waypoints, which would keep it bent. */
export function patched(old, patch) {
  const merged = { ...old, ...patch };
  if (old.type === 'connector' && patch.route === 'straight' && !('points' in patch)) merged.points = [];
  for (const key of ['labels', 'heads']) {
    if (!isObject(patch[key])) continue;
    const slots = { ...(old[key] ?? {}) };
    for (const [s, v] of Object.entries(patch[key])) {
      if (v === null) delete slots[s];
      else slots[s] = isObject(v) ? { ...slots[s], ...v } : v;
    }
    merged[key] = slots;
  }
  return merged;
}

/** board.items.place: the top-left corner that puts box `A` ({x, y, w, h}) `relation` ('left' | 'right' | 'above' | 'below') of box
 * `B` with `gap` px between them; `align` lines up the tops (left, right) or the left edges (above, below), else that coordinate
 * stays A's. */
export function placeAt(A, B, relation, gap, align) {
  const x = relation === 'left' ? B.x - gap - A.w : relation === 'right' ? B.x + B.w + gap : align ? B.x : A.x;
  const y = relation === 'above' ? B.y - gap - A.h : relation === 'below' ? B.y + B.h + gap : align ? B.y : A.y;
  return { x, y };
}

/** board.items.group, flow.items.group: `items` with a new group around `ids`, as whole units (model.mjs groupItems, as the
 * board's Ctrl+G) → {items, result: {group, ids (its members)}}; fewer than two different items → invalid_args. */
export function grouped(items, ids) {
  const group = newId();
  const next = groupItems(items, ids, () => group);
  if (next === items) fail('invalid_args', 'Give two or more different items', { path: '/ids', message: 'needs two or more different items', expected: {} });
  return { items: next, result: { group, ids: next.filter((i) => i.groups?.includes(group)).map((i) => i.id) } };
}

/** board.items.ungroup, flow.items.ungroup: `items` without the outermost group of each item `ids` names (model.mjs
 * ungroupItems over those groups' members) → {items, result: {ungrouped (the group ids)}}; none in a group → invalid_args. */
export function ungrouped(items, ids) {
  const outer = new Set(items.filter((i) => ids.includes(i.id)).map((i) => i.groups?.at(-1)).filter(Boolean));
  if (!outer.size) fail('invalid_args', 'None of these items is in a group', { path: '/ids', message: 'holds no grouped item', expected: {} });
  return { items: ungroupItems(items, items.filter((i) => outer.has(i.groups?.at(-1))).map((i) => i.id)), result: { ungrouped: [...outer] } };
}

/** The ids of `ids` that are not among `items`, as not_found. */
function mustHave(items, ids) {
  const missing = ids.filter((id) => !items.some((i) => i.id === id));
  if (missing.length) fail('not_found', `No item has the id ${missing.join(', ')} on that board`, { ids: missing });
}

const blobBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const BG = { enum: Object.keys(WB_BG) };

export const defs = [
  define({
    id: 'board.list',
    title: 'List the canvases of the open draft',
    brief: 'Use it to get the block path of a board. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'read',
    undo: 'none',
    needs: ['doc.open'],
    args: { type: 'object', additionalProperties: false, properties: { draftId: DRAFT_ID } },
    result: { type: 'object', required: ['rev', 'boards'] },
    examples: [{ args: {} }],
    run: (ctx) => {
      const { doc } = ctx.editor.state;
      const boards = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== 'canvas') return true;
        const a = node.attrs;
        boards.push({ path: pathOfPos(doc, pos), kind: 'canvas', items: a.items.length, w: a.w, h: a.h, dw: a.dw, flow: validFlow(a.flow)?.id ?? null });
        return false;
      });
      return { rev: ctx.state.rev, draftId: ctx.state.draft?.id ?? null, boards };
    },
  }),
  define({
    id: 'board.get',
    title: 'Read the items of a canvas with their ids and labels',
    brief: 'A sparse answer lists the ids left out in next. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    notFor: 'draft text',
    guide: { errors: 'precondition_failed means that path is not a board. Call board_list' },
    group: 'board',
    risk: 'read',
    undo: 'none',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: {
        path: BOARD_PATH,
        format: { enum: ['brief', 'full'], default: 'brief', description: 'full adds every field' },
        images: { type: 'boolean', default: false, description: 'Keep pictures (full only)' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['rev', 'board'] },
    examples: [{ args: { path: [4] } }, { args: { path: [4], format: 'full', images: true } }],
    run: (ctx, a) => {
      const t = target(ctx, a.path);
      const { w, h, frame, bg, items } = t.board;
      if (a.format === 'brief') {
        const byId = new Map(items.map((i) => [i.id, i]));
        // styles: the most common style per item type (item-style.mjs), which new items left without one take.
        const board = { kind: 'canvas', w, h, bg, styles: boardStyles(items), items: items.map((i) => briefItem(i, byId)) };
        return { rev: ctx.state.rev, draftId: ctx.state.draft?.id ?? null, board };
      }
      const board = { kind: 'canvas', w, h, dw: t.node.attrs.dw, frame, bg, items, flow: validFlow(t.node.attrs.flow)?.id ?? null };
      return { rev: ctx.state.rev, draftId: ctx.state.draft?.id ?? null, board: a.images ? board : ctx.lib.stripImages(board) };
    },
  }),
  define({
    id: 'board.find',
    title: 'Find items of a canvas by words',
    brief: 'Use it for the id of an item the user names. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    notFor: 'draft text',
    guide: { errors: 'hits 0 means no match. Try fewer words, or board_get' },
    group: 'board',
    risk: 'read',
    undo: 'none',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'q'], additionalProperties: false,
      properties: {
        path: BOARD_PATH,
        q: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to match, such as yes arrow' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['rev', 'hits', 'items'] },
    examples: [{ args: { path: [4], q: 'yes' } }, { args: { path: [4], q: 'arrow from start' } }],
    run: (ctx, a) => {
      const items = itemsOf(target(ctx, a.path));
      const byId = new Map(items.map((i) => [i.id, i]));
      const words = a.q.toLowerCase().split(/\s+/).filter((w) => w && !STOP.has(w));
      // q that is an item's id (a sparse answer's next, wave 2b) puts that item first: an id such as "a" (a skipped word) or
      // "rect" (every rect's word) would else match nothing or leave it past MAX_FOUND again.
      const exact = byId.get(a.q.trim());
      const hits = items.filter((i) => {
        const text = findText(i, byId);
        return i !== exact && words.every((w) => text.includes(w));
      });
      if (exact) hits.unshift(exact);
      // Past MAX_FOUND the answer is sparse (wave 2b, as the assistant's clipResult): the ids left out and how to read one.
      const left = hits.slice(MAX_FOUND).map((i) => i.id);
      const sparse = left.length ? { sparse: true, next: left, hint: `Read one with board_find ${JSON.stringify({ path: a.path, q: left[0] })}.` } : {};
      return { rev: ctx.state.rev, draftId: ctx.state.draft?.id ?? null, hits: hits.length, items: hits.slice(0, MAX_FOUND).map((i) => briefItem(i, byId)), ...sparse };
    },
  }),
  define({
    id: 'board.insert',
    title: 'Insert an empty canvas into the open draft (at the top level)',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['at'], additionalProperties: false,
      properties: {
        // whiteboard: an older name, kept for agents that still send it (a page-wide canvas shown at 1:1, SPEC §6b).
        kind: { enum: ['canvas', 'whiteboard'], default: 'canvas' },
        at: { oneOf: [ref('PATH'), { enum: ['start', 'end', 'cursor'] }], description: 'A block path such as [3], or one of start, end, cursor' },
        position: { enum: ['before', 'after'], default: 'after' },
        // Items go in with board.items.add, which measures them.
        attrs: {
          type: 'object', additionalProperties: false,
          properties: {
            bg: BG, w: { type: 'integer', minimum: 40, maximum: 8000, description: 'artboard' }, h: { type: 'integer', minimum: 40, maximum: 8000 },
            dw: { type: 'integer', minimum: 40, description: 'displayed width' },
          },
        },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: { at: 'end' } }, { args: { at: [2], position: 'before', attrs: { w: 1200, h: 675, dw: 600 } } }],
    plan: (ctx, a) => {
      const { state, view } = ctx.editor;
      const { doc, selection: sel } = state;
      let pos;
      if (a.at === 'start') pos = 0;
      else if (a.at === 'end') pos = doc.content.size;
      else if (a.at === 'cursor') pos = sel.node ? sel.to : sel.$from.depth ? sel.$from.after(sel.$from.depth) : sel.$from.pos;
      else {
        pos = posOfPath(doc, a.at);
        if (pos === null) fail('not_found', `No block at [${a.at}]`, { path: a.at });
        if (a.position === 'after') pos += doc.nodeAt(pos).nodeSize;
      }
      pos = topLevelPos(doc.resolve(pos));
      const size = a.kind === 'whiteboard' ? { w: pageOf(ctx.state.draft, ctx.state.settings).width, h: 400 } : CANVAS_DEFAULT;
      const { w = size.w, h = size.h, dw = w, bg = 'post' } = a.attrs ?? {};
      const attrs = { w, h, dw: Math.min(dw, contentWidth(view)), frame: { x: 0, y: 0, w, h }, bg, items: [] };
      const tr = state.tr.insert(pos, state.schema.nodes.canvas.create(attrs));
      return { tr, result: { path: pathOfPos(tr.doc, pos) } };
    },
  }),
  define({
    id: 'board.items.add',
    title: 'Add items to a canvas',
    brief: 'Use it to draw only the new items the user asked for. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    guide: { errors: 'one of 5 forms means a field is wrong for its type', playbook: 'change-board-item' },
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'items'], additionalProperties: false,
      properties: {
        path: BOARD_PATH,
        items: { type: 'array', items: ref('ITEM'), minItems: 1, maxItems: 500, description: 'New items. Your ids link connectors. Left-out styles match the board.' },
        coords: COORDS, draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['ids'] },
    examples: [
      { args: { path: [4], items: [{ type: 'text', html: 'Start here', x: 40, y: 30, w: 240 }] } },
      {
        args: {
          path: [4],
          items: [
            { id: 'a', type: 'shape', shape: 'round', x: 40, y: 40, w: 160, h: 80, html: 'Start' },
            { id: 'b', type: 'shape', shape: 'diam', x: 40, y: 200, w: 160, h: 110, html: 'Ready?' },
            { type: 'connector', from: { item: 'a', anchor: 's' }, to: { item: 'b', anchor: 'n' }, labels: { mid: { html: 'next' } } },
          ],
        },
      },
    ],
    busy,
    run: (ctx, a) => write(ctx, a, (items, { size, bg }) => {
      const theme = themeOf(ctx);
      const board = boardSurface(bg, theme);
      const page = pageItems(ctx.editor?.state.doc);
      const given = a.coords === 'thousandths' ? a.items.map((i) => fromThousandths(i, size)) : a.items;
      const added = freshIds(given.map((i) => itemDefaults(i, theme, board, items, page)), new Set(items.map((i) => i.id))).map((i, k) => checked(i, `/items/${k}`));
      const ids = new Set(added.map((i) => i.id));
      const all = repairEnds([...items, ...added]);
      const warnings = [...endWarnings(added, all, ids), ...contrastWarnings(all, ids, theme, board)];
      return { items: all, result: { ids: [...ids], ...(warnings.length && { warnings }) } };
    }),
  }),
  define({
    id: 'board.items.update',
    title: 'Change one item of a canvas',
    brief: 'Use it to move or restyle an item. route straight also drops an arrow\'s bends. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    notFor: 'straightening. Use board_items_straighten',
    guide: {
      args: 'patch holds only the fields to change',
      errors: 'not_found means a wrong id. Call board_find',
    },
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'id', 'patch'], additionalProperties: false,
      properties: {
        path: BOARD_PATH, id: { ...ITEM_ID, description: 'Item id from board_find or board_get' },
        patch: { type: 'object', minProperties: 1, description: 'Item fields to set, such as x, y, html or route. A null label slot removes it.' },
        coords: COORDS, draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['id', 'item'] },
    examples: [
      { args: { path: [4], id: 'k3j9x0a', patch: { x: 300, y: 140 } } },
      { args: { path: [4], id: 'c81hd0q', patch: { labels: { mid: { html: 'yes' }, end: null }, heads: { end: 'triangle' } } } },
    ],
    busy,
    run: (ctx, a) => {
      const result = write(ctx, a, (items, { size, bg }) => {
        const k = items.findIndex((i) => i.id === a.id);
        if (k < 0) mustHave(items, [a.id]);
        const old = items[k];
        const bad = ['id', 'type'].find((key) => key in a.patch);
        if (bad) fail('invalid_args', `patch.${bad} cannot change here`, { path: `/patch/${bad}`, message: 'cannot change', expected: {} });
        const branch = ITEM.oneOf.find((b) => b.title === old.type);
        const patch = a.coords === 'thousandths' ? fromThousandths(a.patch, size) : a.patch;
        const errs = validate({ type: 'object', properties: branch.properties }, patch);
        if (errs.length) fail('invalid_args', `patch${errs[0].path} ${errs[0].message}`, { ...errs[0], path: `/patch${errs[0].path}` });
        const item = checked(patched(old, patch), '/patch');
        const next = items.map((i, j) => (j === k ? item : i));
        const all = repairEnds(next);
        const theme = themeOf(ctx);
        const looks = styledText(patch) ? new Set([item.id]) : new Set(); // a move never warns about a colour the user chose
        const warnings = [...endWarnings(next, all, new Set([item.id])), ...contrastWarnings(all, looks, theme, boardSurface(bg, theme))];
        return { items: all, result: { id: item.id, ...(warnings.length && { warnings }) } };
      });
      // The item as stored: its route redone.
      const item = itemsOf(target(ctx, a.path)).find((i) => i.id === a.id);
      return { ...result, item: ctx.lib.stripImages(item) };
    },
  }),
  define({
    id: 'board.items.place',
    title: 'Place an item left of, right of, above or below another',
    brief: 'The app works out x and y. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'id', 'relation', 'of'], additionalProperties: false,
      properties: {
        path: BOARD_PATH,
        id: { ...ITEM_ID, description: 'Item to move' },
        relation: { enum: ['left', 'right', 'above', 'below'], description: 'Side of the other item' },
        of: { ...ITEM_ID, description: 'The other item' },
        gap: { type: 'integer', minimum: 0, maximum: 2000, default: 24, description: 'Space between the boxes, px' },
        align: { type: 'boolean', default: true, description: 'Line up tops (left, right) or left edges (above, below)' },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['id', 'item', 'of'] },
    examples: [
      { args: { path: [4], id: 'k3j9x0a', relation: 'left', of: 'q2m1f8z' } },
      { args: { path: [4], id: 'a1b2c3d', relation: 'below', of: 'q2m1f8z', gap: 40, align: false } },
    ],
    busy,
    run: (ctx, a) => {
      if (a.id === a.of) fail('invalid_args', 'id and of name the same item', { path: '/of', message: 'is the item itself', expected: {} });
      // A stored text height is used (settle stores it on every board write).
      // ponytail: a canvas text item never written through board.* has no h and counts as 0 high; measure it if that shows.
      const boxOf = (i) => rotBox({ x: i.x, y: i.y, w: i.w, h: i.h ?? 0, rot: rotOf(i) });
      write(ctx, a, (items) => {
        mustHave(items, [a.id, a.of]);
        const k = items.findIndex((i) => i.id === a.id);
        const it = items[k];
        if (it.type === 'connector') fail('invalid_args', 'A connector moves with the items it joins: place one of those', { path: '/id', message: 'is a connector', expected: {} });
        const of = items.find((i) => i.id === a.of);
        // A connector has no box: x and y would come out NaN, and a reload drops the item.
        if (of.type === 'connector') fail('invalid_args', 'A connector has no box: place the item beside one of the items it joins', { path: '/of', message: 'is a connector', expected: {} });
        const [A, B] = [boxOf(it), boxOf(of)];
        const { x, y } = placeAt(A, B, a.relation, a.gap, a.align);
        const next = items.map((i, j) => (j === k ? moveItem(it, x - A.x, y - A.y) : i));
        return { items: repairEnds(next), result: null };
      });
      // Both boxes as stored (connectors routed again).
      const after = itemsOf(target(ctx, a.path));
      const box = (id) => {
        const b = boxOf(after.find((i) => i.id === id));
        return { id, x: int(b.x), y: int(b.y), w: int(b.w), h: int(b.h) };
      };
      return { id: a.id, item: box(a.id), of: box(a.of) };
    },
  }),
  define({
    id: 'board.items.remove',
    title: 'Remove items from a canvas',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    notFor: 'a whole board block',
    guide: { args: 'Every id in one call', errors: 'denied means the user said no. Do not try again' },
    group: 'board',
    risk: 'destructive',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'ids'], additionalProperties: false,
      properties: { path: BOARD_PATH, ids: { ...IDS, description: 'Item ids from board_find or board_get' }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['removed'] },
    examples: [{ args: { path: [4], ids: ['k3j9x0a'] } }],
    ask: (ctx, a) => {
      const items = itemsOf(target(ctx, a.path));
      const n = a.ids.length;
      return {
        title: `remove ${n === 1 ? 'an item' : `${n} items`} from the board at [${a.path}] (${keyLabel('edit.undo') || 'Undo'} restores ${n === 1 ? 'it' : 'them'})`,
        description: a.ids.map((id) => {
          const i = items.find((x) => x.id === id);
          const text = i && plain(i).slice(0, 60);
          return i ? `${i.type === 'shape' ? i.shape : i.type} ${id}${text ? ` "${text}"` : ''}` : `${id} (not on the board)`;
        }).join('\n'),
      };
    },
    busy,
    run: (ctx, a) => write(ctx, a, (items) => {
      mustHave(items, a.ids);
      return { items: unbindFrom(items, new Set(a.ids)), result: { removed: a.ids } };
    }),
  }),
  define({
    id: 'board.items.arrange',
    title: 'Move items of a canvas to the front or back, or one step forward or backward',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'ids', 'where'], additionalProperties: false,
      properties: { path: BOARD_PATH, ids: IDS, where: { enum: ['front', 'back', 'forward', 'backward'] }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['order'] },
    examples: [{ args: { path: [4], ids: ['k3j9x0a'], where: 'front' } }],
    busy,
    run: (ctx, a) => write(ctx, a, (items) => {
      mustHave(items, a.ids);
      const next = arrangeItems(items, a.ids, a.where); // Board.arrange over `ids` instead of the selection: a group moves whole
      return { items: next, result: { order: next.map((i) => i.id) } };
    }),
  }),
  define({
    id: 'board.items.group',
    title: 'Group items of a canvas',
    brief: 'A group selects and moves as one. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'ids'], additionalProperties: false,
      properties: { path: BOARD_PATH, ids: { ...IDS, minItems: 2, description: 'Two or more items. An item in a group brings its group' }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['group', 'ids'] },
    examples: [{ args: { path: [4], ids: ['k3j9x0a', 'q2m1f8z'] } }],
    busy,
    run: (ctx, a) => write(ctx, a, (items) => {
      mustHave(items, a.ids);
      return grouped(items, a.ids);
    }),
  }),
  define({
    id: 'board.items.ungroup',
    title: 'Ungroup items of a canvas',
    brief: 'Each item\'s outermost group goes. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'ids'], additionalProperties: false,
      properties: { path: BOARD_PATH, ids: IDS, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['ungrouped'] },
    examples: [{ args: { path: [4], ids: ['k3j9x0a'] } }],
    busy,
    run: (ctx, a) => write(ctx, a, (items) => {
      mustHave(items, a.ids);
      return ungrouped(items, a.ids);
    }),
  }),
  define({
    id: 'board.set',
    title: 'Change a canvas\'s background, artboard size, frame or displayed width',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path', 'attrs'], additionalProperties: false,
      properties: {
        path: BOARD_PATH,
        attrs: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            bg: BG, w: { type: 'integer', minimum: 40, maximum: 8000, description: 'artboard width (the frame becomes 0,0,w,h)' },
            h: { type: 'integer', minimum: 40, maximum: 8000 },
            frame: { type: 'object', required: ['x', 'y', 'w', 'h'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number', minimum: 1 }, h: { type: 'number', minimum: 1 } } },
            dw: { type: 'integer', minimum: 40, description: 'displayed width in the post' },
          },
        },
        draftId: DRAFT_ID,
      },
    },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: { path: [4], attrs: { bg: 'white' } } }, { args: { path: [6], attrs: { w: 1200, h: 675, dw: 600 } } }],
    busy,
    run: (ctx, a) => {
      const t = target(ctx, a.path);
      const { bg, w, h, frame, dw } = a.attrs;
      return write(ctx, a, (items) => {
        let f;
        if (frame) f = { ...frame };
        else if (w || h) f = { x: 0, y: 0, w: w ?? t.board.frame?.w ?? t.board.w, h: h ?? t.board.frame?.h ?? t.board.h };
        // A new background: text with a colour of its own may no longer read on it.
        const theme = themeOf(ctx);
        const warnings = bg ? contrastWarnings(items, new Set(items.map((i) => i.id)), theme, boardSurface(bg, theme)) : [];
        return { items, bg, frame: f, dw, result: { path: a.path, ...(warnings.length && { warnings }) } };
      });
    },
  }),
  define({
    id: 'board.fit',
    title: 'Fit a canvas\'s artboard to its items',
    brief: 'Use it to resize or shrink a canvas to fit, as the edit bar\'s Fit.',
    group: 'board',
    risk: 'write',
    undo: 'doc',
    needs: BOARD_NEEDS,
    args: { type: 'object', required: ['path'], additionalProperties: false, properties: { path: BOARD_PATH, draftId: DRAFT_ID } },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: { path: [4] } }],
    busy,
    run: (ctx, a) => write(ctx, a, (items) => ({ items, fit: true, result: { path: a.path } })),
  }),
  define({
    id: 'board.render',
    title: 'Draw a canvas as a PNG (base64)',
    brief: 'draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: 'board',
    risk: 'read',
    undo: 'none',
    needs: BOARD_NEEDS,
    args: {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: BOARD_PATH, scale: { type: 'number', minimum: 0.25, maximum: 4, description: 'pixels per board px' }, draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['png', 'width', 'height', 'bytes'] },
    examples: [{ args: { path: [4] } }, { args: { path: [4], scale: 1 } }],
    run: async (ctx, a) => {
      const { pos, node, board: b } = target(ctx, a.path);
      // export.js: the artboard at its own size, at the pixel ratio giving 2× its drawn size.
      const shown = ctx.editor.view.nodeDOM(pos)?.offsetWidth || Math.min(node.attrs.dw, pageOf(ctx.state.draft, ctx.state.settings).width);
      const scale = a.scale ?? Math.min(4, Math.max(0.25, (2 * shown) / b.w));
      const { blob } = await rasterizeWhiteboard({ height: b.h, bg: b.bg, items: b.items }, { width: b.w, theme: themeOf(ctx), scale });
      const ihdr = new DataView(await blob.slice(16, 24).arrayBuffer()); // the PNG's own pixel size
      return { png: await blobBase64(blob), width: ihdr.getUint32(0), height: ihdr.getUint32(4), bytes: blob.size };
    },
  }),
];

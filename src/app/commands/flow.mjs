import { canvasEditor } from '../../canvas.js';
import { pathOfPos, posOfPath } from '../../doc-path.mjs';
import { toGraph } from '../../flow/graph.mjs';
import { layout } from '../../flow/layout.mjs';
import { FLOW_SIZE } from '../../flow/library.mjs';
import { cleanConnector, defaultMeasure, moveItem, repairEnds, unbindFrom, validConnector } from '../../flow/model.mjs';
import { resolveConnectors } from '../../flow/route.mjs';
import { KINDS, rotBox } from '../../flow/shapes.mjs';
import {
  contentWidth, groupBox, injectStyle, itemElement, make, parseBoard, smartArtboard, topLevelPos, WB_BG,
} from '../../whiteboard.js';
import { validate } from '../schema.mjs';
import { endSide } from '../assistant/attach.mjs';
import { patched, placeAt } from './board.mjs';
import { connectorOf, endBoxes, straightPatch } from './connectors.mjs';
import { define, fail, failGates } from './define.mjs';
import { matchStyle } from './item-style.mjs';
import { DRAFT_ID, ITEM, ITEM_ID, ref } from './schema-defs.mjs';

// flow.* (SPEC §8 Catalogue, §6f; assistant-coverage plan §3.6): the flowchart library by flowId, through the store
// (ctx.flows = src/app/flows.js; this module never imports it, so node --test can load the catalogue). Item writes take the
// record's board, settle it as board.mjs does for a canvas (connectors routed, text measured, the smart artboard) and commit
// it through commitLibrary: one step of the record's own undo stack (the library editor's Undo), a new rev, and every view of
// the record follows (the library editor's Board and the synced canvases in drafts, through flowSource.changed).

// ponytail: category 'board' until tool-sets.mjs CATEGORIES gets a 'flow' line; then this becomes 'flow'.
const GROUP = 'flow';
const FLOW_ID = ref('ID', 'From flow_library_list');
const EX = '5f0c2a9e-7b1d-4c3e-9a8f-1d2e3f4a5b6c';
const THREAD = 'https://daf.staffs.ac.uk/topic/88136-level-design/';
const IDS = { type: 'array', items: ITEM_ID, minItems: 1, maxItems: 500 };
const TITLE = { type: 'string', minLength: 1, maxLength: 120 };
const SYNCED = 'Synced canvases update too.';

/** The tools of the Flowcharts page (tool-sets.mjs VIEW_SETS.flows, wired by the orchestrator). */
export const FLOW_VIEW_SET = ['flow.library.list', 'flow.library.get', 'flow.find', 'flow.items.add', 'flow.items.update', 'flow.items.remove',
  'flow.items.place', 'flow.items.straighten', 'flow.insert', 'flow.layout'];

/** The record `id`, loaded; else not_found (no flow.present gate: the executor cannot read a flow subject from the args). */
const recordOf = async (ctx, id) => (await ctx.flows.loadFlow(id)) ?? fail('not_found', `No flowchart has the id ${id}. Call flow_library_list`, { flowId: id });
const titleOf = (ctx, id) => ctx.flows.getFlow(id)?.title ?? ctx.flows.flowList().find((s) => s.id === id)?.title ?? 'Flowchart';

/** busy: the library editor's Board on `flowId` mid-gesture or editing text, or a synced canvas of it in Canvas Mode. */
function busy(ctx, a) {
  const v = ctx.state.view;
  const b = v.type === 'flows' && v.flowId === a.flowId ? document.querySelector('#flow-area .wb')?.wbView : null;
  if (b && (b.gesture || b.editingId)) return true;
  const s = canvasEditor.get();
  return !!s && !s.target.parent && s.target.owner?.flow?.()?.id === a.flowId;
}

// --- copied from board.mjs (private there; wave 2 edits that file): plain, int, briefItem, findText, itemDefaults, freshIds,
// checked, endWarnings, settle, mustHave. Export them from board.mjs and delete these copies once it is free. ---

const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', amp: '&' };
const plain = (i) => String(i?.html ?? i?.labels?.mid?.html ?? '').replace(/<[^>]*>/g, ' ').replace(/&(nbsp|lt|gt|quot|amp);/g, (_, e) => ENTITIES[e])
  .replace(/\s+/g, ' ').trim();
const int = (v) => (typeof v === 'number' ? Math.round(v) : undefined);
const newId = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');
const ink = (ctx) => (ctx.state.settings.theme === 'light' ? '#111111' : '#ffffff');

function briefItem(i, byId) {
  const short = (it) => {
    const s = plain(it);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s || undefined;
  };
  const end = (e) => (typeof e?.item === 'string' ? { item: e.item, label: short(byId.get(e.item)), side: endSide(e.anchor) } : { x: int(e?.x), y: int(e?.y) });
  return {
    id: i.id, type: i.type, shape: i.shape, label: short(i), x: int(i.x), y: int(i.y), w: int(i.w), h: int(i.h),
    ...(i.type === 'connector' && { from: end(i.from), to: end(i.to), route: i.route, head: i.heads?.end, bends: i.points?.length ?? 0 }),
  };
}

const FIND_WORDS = { connector: 'arrow line', image: 'picture', stroke: 'pen drawing' };
const KIND_NAMES = new Map(KINDS.map((k) => [k.kind, k.label]));
const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'in', 'to', 'and']);

function findText(i, byId) {
  const ends = i.type === 'connector' ? `from ${plain(byId.get(i.from?.item))} to ${plain(byId.get(i.to?.item))}` : '';
  return `${plain(i)} ${i.type} ${FIND_WORDS[i.type] ?? ''} ${i.shape ?? ''} ${KIND_NAMES.get(i.shape) ?? ''} ${ends}`.toLowerCase();
}

function itemDefaults(item, color, items = []) {
  const i = matchStyle(item, items); // the flowchart's own style first (item-style.mjs)
  if (i.type === 'text') return { size: 20, color, bold: false, align: 'left', bg: null, ...i };
  if (i.type === 'shape') return { color, width: 2, opacity: 1, fill: 'none', fillColor: color, textColor: color, ...i };
  if (i.type === 'connector') return { color, ...i };
  return i;
}

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

function checked(i, at) {
  const kept = i.type === 'connector' ? (validConnector(i) ? [cleanConnector(i)] : []) : parseBoard(JSON.stringify({ items: [i] })).items;
  if (kept.length !== 1) fail('invalid_args', `${at.slice(1) || 'the item'} is not a valid ${i.type} item`, { path: at, message: 'is not a valid board item', expected: ITEM });
  return kept[0];
}

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

function settle(b, items) {
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
    let list = resolveConnectors(items, measure).items;
    const box = (i) => {
      const r = i.type === 'shape' && i.rot ? rotBox(i) : measure(i);
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    };
    let frame = b.frame ?? null;
    const bound = frame?.item && list.find((i) => i.id === frame.item);
    if (bound) frame = { ...box(bound), item: bound.id };
    else if (frame?.item) frame = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
    const a = smartArtboard(frame, { w: b.w, h: b.h }, groupBox(list.map(box)));
    if (a.dx || a.dy) list = list.map((i) => moveItem(i, a.dx, a.dy));
    return { ...a, items: list.map((i) => (i.type === 'text' ? { ...i, h: measure(i).h } : i)) };
  } finally {
    host.remove();
  }
}

function mustHave(items, ids) {
  const missing = ids.filter((id) => !items.some((i) => i.id === id));
  if (missing.length) fail('not_found', `No item has the id ${missing.join(', ')} on that flowchart`, { ids: missing });
}

// --- end of the copies ---

/** `items` plus the new items `add` (defaults, fresh ids, the board's checks; `at`: their args pointer) → {items, result}. */
function added(ctx, items, add, at = '/items') {
  if (add.some((i) => i.type === 'canvas')) failGates(['board.whiteboard']); // a flowchart is a canvas: no canvas items
  const color = ink(ctx);
  const fresh = freshIds(add.map((i) => itemDefaults(i, color, items)), new Set(items.map((i) => i.id))).map((i, k) => checked(i, `${at}/${k}`));
  const ids = new Set(fresh.map((i) => i.id));
  const all = repairEnds([...items, ...fresh]);
  const warnings = endWarnings(fresh, all, ids);
  return { items: all, result: { ids: [...ids], ...(warnings.length && { warnings }) } };
}

/** Runs `edit(items) → {items, result}` on the record's items, settles and commits them (header) → edit's result. */
async function write(ctx, flowId, edit) {
  const r = await recordOf(ctx, flowId);
  const out = edit(r.board.items);
  const s = settle(r.board, out.items);
  ctx.flows.commitLibrary(r.id, { w: s.w, h: s.h, frame: s.frame, bg: r.board.bg, items: s.items }, true);
  return out.result;
}

// The box of item `i` as stored (a text item without a stored h: its estimate).
const boxOf = (i) => (i.type === 'shape' && i.rot ? rotBox(i) : defaultMeasure(i));
const drawnBox = (items) => groupBox(items.filter((i) => i.type !== 'connector' || Number.isFinite(i.h))
  .map((i) => rotBox({ ...defaultMeasure(i), rot: i.type === 'shape' ? i.rot : 0 }))); // flows.js drawnBox

/** flows.js autoLayout on a fixed board without a Board: the shapes, text, images and groups laid out by dagre in direction
 * `dir`, starting where the drawing began; connectors between them lose their bends (settle routes them again). */
function laidOut(items, dir) {
  const graph = toGraph(items, { unit: 1 });
  if (!graph.nodes.length) fail('refused', 'The flowchart has no shapes to lay out', { code: 'no_shapes' });
  const r = layout(graph, { dir });
  if (r.error) fail('failed', r.error.message);
  const byId = new Map(items.map((i) => [i.id, i]));
  const laid = [...graph.nodes, ...graph.groups].map((n) => byId.get(n.id));
  const before = drawnBox(laid);
  const moved = laid.map((i) => {
    const p = r.nodes[i.id] ?? r.groups[i.id];
    return { ...i, x: Math.round(p.x), y: Math.round(p.y), ...(r.groups[i.id] && { w: Math.round(p.w), h: Math.round(p.h) }) };
  });
  const now = drawnBox(moved);
  const at = new Map(moved.map((m) => [m.id, moveItem(m, before.x - now.x, before.y - now.y)]));
  return items.map((i) => at.get(i.id) ?? (i.type === 'connector' && at.has(i.from?.item) && at.has(i.to?.item) ? { ...i, points: [] } : i));
}

export const defs = [
  define({
    id: 'flow.library.list',
    title: 'List the flowcharts in the library',
    brief: 'Use it to get a flowchart id by its title.',
    group: GROUP,
    risk: 'read',
    undo: 'none',
    args: { type: 'object', additionalProperties: false, properties: { threadUrl: ref('URL', 'Forum thread URL. Omit it for all.') } },
    result: { type: 'array' },
    examples: [{ args: {} }, { args: { threadUrl: THREAD } }],
    run: (ctx, a) => ctx.flows.flowList().filter((s) => !a.threadUrl || s.threadUrl === a.threadUrl)
      .map((s) => ({ flowId: s.id, title: s.title, items: s.items, updated: s.updated })),
  }),
  define({
    id: 'flow.library.get',
    title: 'Read the items of a library flowchart with ids and labels',
    notFor: 'canvases in a draft. Use board_get',
    group: GROUP,
    risk: 'read',
    undo: 'none',
    args: {
      type: 'object', required: ['flowId'], additionalProperties: false,
      properties: { flowId: FLOW_ID, format: { enum: ['brief', 'full'], default: 'brief', description: 'full adds every field' } },
    },
    result: { type: 'object', required: ['flowId', 'title', 'rev', 'board'] },
    examples: [{ args: { flowId: EX } }, { args: { flowId: EX, format: 'full' } }],
    run: async (ctx, a) => {
      const r = await recordOf(ctx, a.flowId);
      const { w, h, frame, bg, items } = r.board;
      const byId = new Map(items.map((i) => [i.id, i]));
      const board = a.format === 'brief' ? { w, h, bg, items: items.map((i) => briefItem(i, byId)) } : ctx.lib.stripImages({ w, h, frame, bg, items });
      return { flowId: r.id, title: r.title, rev: r.rev, board };
    },
  }),
  define({
    id: 'flow.find',
    title: 'Find flowchart items by words',
    brief: 'Use it to get the id of a named item.',
    group: GROUP,
    risk: 'read',
    undo: 'none',
    args: {
      type: 'object', required: ['flowId', 'q'], additionalProperties: false,
      properties: { flowId: FLOW_ID, q: { type: 'string', minLength: 1, maxLength: 200, description: 'Words, such as yes arrow' } },
    },
    result: { type: 'object', required: ['hits', 'items'] },
    examples: [{ args: { flowId: EX, q: 'yes' } }, { args: { flowId: EX, q: 'arrow from start' } }],
    run: async (ctx, a) => {
      const { items } = (await recordOf(ctx, a.flowId)).board;
      const byId = new Map(items.map((i) => [i.id, i]));
      const words = a.q.toLowerCase().split(/\s+/).filter((w) => w && !STOP.has(w));
      const hits = items.filter((i) => words.every((w) => findText(i, byId).includes(w)));
      return { hits: hits.length, items: hits.slice(0, 40).map((i) => briefItem(i, byId)) };
    },
  }),
  define({
    id: 'flow.items.add',
    title: 'Add items to a library flowchart',
    brief: `Draw only the new items the user asked for. ${SYNCED}`,
    guide: { args: 'Each item needs x y w h. Add it before you place it.' },
    group: GROUP,
    risk: 'write',
    undo: 'own',
    args: {
      type: 'object', required: ['flowId', 'items'], additionalProperties: false,
      properties: {
        flowId: FLOW_ID,
        items: { type: 'array', items: ref('ITEM'), minItems: 1, maxItems: 500, description: 'New items. Your ids link connectors.' },
      },
    },
    result: { type: 'object', required: ['ids'] },
    examples: [
      { args: { flowId: EX, items: [{ type: 'shape', shape: 'rect', x: 40, y: 40, w: 160, h: 80, html: 'Check' }] } },
      {
        args: {
          flowId: EX,
          items: [
            { id: 'a', type: 'shape', shape: 'round', x: 40, y: 40, w: 160, h: 80, html: 'Start' },
            { id: 'b', type: 'shape', shape: 'diam', x: 40, y: 200, w: 160, h: 110, html: 'Ready?' },
            { type: 'connector', from: { item: 'a', anchor: 's' }, to: { item: 'b', anchor: 'n' }, labels: { mid: { html: 'next' } } },
          ],
        },
      },
    ],
    busy,
    run: (ctx, a) => write(ctx, a.flowId, (items) => added(ctx, items, a.items)),
  }),
  define({
    id: 'flow.items.update',
    title: 'Change one flowchart item',
    brief: `route straight also drops an arrow's bends. ${SYNCED}`,
    group: GROUP,
    risk: 'write',
    undo: 'own',
    args: {
      type: 'object', required: ['flowId', 'id', 'patch'], additionalProperties: false,
      properties: {
        flowId: FLOW_ID, id: { ...ITEM_ID, description: 'Item id from flow_find' },
        patch: { type: 'object', minProperties: 1, description: 'Fields to set, such as x, y, html or route' },
      },
    },
    result: { type: 'object', required: ['id', 'item'] },
    examples: [
      { args: { flowId: EX, id: 'k3j9x0a', patch: { html: 'Done' } } },
      { args: { flowId: EX, id: 'c81hd0q', patch: { labels: { mid: { html: 'yes' }, end: null }, heads: { end: 'triangle' } } } },
    ],
    busy,
    run: async (ctx, a) => {
      const result = await write(ctx, a.flowId, (items) => {
        const k = items.findIndex((i) => i.id === a.id);
        if (k < 0) mustHave(items, [a.id]);
        const old = items[k];
        const bad = ['id', 'type'].find((key) => key in a.patch);
        if (bad) fail('invalid_args', `patch.${bad} cannot change`, { path: `/patch/${bad}`, message: 'cannot change', expected: {} });
        const branch = ITEM.oneOf.find((b) => b.title === old.type);
        const errs = validate({ type: 'object', properties: branch.properties }, a.patch);
        if (errs.length) fail('invalid_args', `patch${errs[0].path} ${errs[0].message}`, { ...errs[0], path: `/patch${errs[0].path}` });
        const item = checked(patched(old, a.patch), '/patch');
        const next = items.map((i, j) => (j === k ? item : i));
        const all = repairEnds(next);
        const warnings = endWarnings(next, all, new Set([item.id]));
        return { items: all, result: { id: item.id, ...(warnings.length && { warnings }) } };
      });
      // The item as stored: its route redone, the artboard grown round it.
      return { ...result, item: ctx.lib.stripImages(ctx.flows.getFlow(a.flowId).board.items.find((i) => i.id === a.id)) };
    },
  }),
  define({
    id: 'flow.items.place',
    title: 'Place a flowchart item next to another',
    brief: 'The app works out x and y.',
    group: GROUP,
    risk: 'write',
    undo: 'own',
    args: {
      type: 'object', required: ['flowId', 'id', 'relation', 'of'], additionalProperties: false,
      properties: {
        flowId: FLOW_ID,
        id: { ...ITEM_ID, description: 'An existing item' },
        relation: { enum: ['left', 'right', 'above', 'below'], description: 'Side of the other item' },
        of: { ...ITEM_ID, description: 'The other item' },
        gap: { type: 'integer', minimum: 0, maximum: 2000, default: 24, description: 'Space in px' },
        align: { type: 'boolean', default: true, description: 'Line up edges' },
      },
    },
    result: { type: 'object', required: ['id', 'item', 'of'] },
    examples: [
      { args: { flowId: EX, id: 'k3j9x0a', relation: 'right', of: 'q2m1f8z' } },
      { args: { flowId: EX, id: 'a1b2c3d', relation: 'below', of: 'q2m1f8z', gap: 40, align: false } },
    ],
    busy,
    run: async (ctx, a) => {
      if (a.id === a.of) fail('invalid_args', 'id and of name the same item', { path: '/of', message: 'is the item itself', expected: {} });
      await write(ctx, a.flowId, (items) => {
        mustHave(items, [a.id, a.of]);
        const k = items.findIndex((i) => i.id === a.id);
        const it = items[k];
        if (it.type === 'connector') fail('invalid_args', 'A connector moves with the items it joins. Place one of those', { path: '/id', message: 'is a connector', expected: {} });
        const [A, B] = [boxOf(it), boxOf(items.find((i) => i.id === a.of))];
        const { x, y } = placeAt(A, B, a.relation, a.gap, a.align);
        return { items: repairEnds(items.map((i, j) => (j === k ? moveItem(it, x - A.x, y - A.y) : i))), result: null };
      });
      const after = ctx.flows.getFlow(a.flowId).board.items;
      const box = (id) => {
        const b = boxOf(after.find((i) => i.id === id));
        return { id, x: int(b.x), y: int(b.y), w: int(b.w), h: int(b.h) };
      };
      return { id: a.id, item: box(a.id), of: box(a.of) };
    },
  }),
  define({
    id: 'flow.items.straighten',
    title: 'Straighten a flowchart arrow',
    brief: 'Its ends move to face each other.',
    group: GROUP,
    risk: 'write',
    undo: 'own',
    args: { type: 'object', required: ['flowId', 'id'], additionalProperties: false, properties: { flowId: FLOW_ID, id: { ...ITEM_ID, description: 'Arrow id' } } },
    result: { type: 'object', required: ['id', 'item', 'from', 'to'] },
    examples: [{ args: { flowId: EX, id: 'c81hd0q' } }],
    busy,
    run: async (ctx, a) => {
      await write(ctx, a.flowId, (items) => {
        const c = connectorOf(items, a.id, 'flowchart');
        const item = checked(patched(c, straightPatch(items, c, boxOf)), '/id');
        return { items: items.map((i) => (i === c ? item : i)), result: null };
      });
      const after = ctx.flows.getFlow(a.flowId).board.items;
      const item = after.find((i) => i.id === a.id);
      return { id: a.id, item: ctx.lib.stripImages(item), ...endBoxes(after, item, boxOf) };
    },
  }),
  define({
    id: 'flow.items.remove',
    title: 'Remove flowchart items',
    notFor: 'the whole flowchart',
    guide: { errors: 'denied means the user said no' },
    group: GROUP,
    risk: 'destructive',
    undo: 'own',
    args: {
      type: 'object', required: ['flowId', 'ids'], additionalProperties: false,
      properties: { flowId: FLOW_ID, ids: { ...IDS, description: 'Item ids from flow_find' } },
    },
    result: { type: 'object', required: ['removed'] },
    examples: [{ args: { flowId: EX, ids: ['k3j9x0a'] } }],
    ask: (ctx, a) => {
      const items = ctx.flows.getFlow(a.flowId)?.board.items; // not loaded yet: the ids alone, never "not on the flowchart"
      const n = a.ids.length;
      return {
        title: `remove ${n === 1 ? 'an item' : `${n} items`} from the flowchart "${titleOf(ctx, a.flowId)}" (Undo in the library restores ${n === 1 ? 'it' : 'them'})`,
        description: a.ids.map((id) => {
          const i = items?.find((x) => x.id === id);
          const text = i && plain(i).slice(0, 60);
          return i ? `${i.type === 'shape' ? i.shape : i.type} ${id}${text ? ` "${text}"` : ''}` : items ? `${id} (not on the flowchart)` : id;
        }).join('\n'),
      };
    },
    busy,
    run: (ctx, a) => write(ctx, a.flowId, (items) => {
      mustHave(items, a.ids);
      return { items: unbindFrom(items, new Set(a.ids)), result: { removed: a.ids } };
    }),
  }),
  define({
    id: 'flow.layout',
    title: 'Lay out a library flowchart automatically',
    brief: 'Arrows between shapes lose their bends.',
    group: GROUP,
    risk: 'write',
    undo: 'own',
    args: {
      type: 'object', required: ['flowId'], additionalProperties: false,
      properties: { flowId: FLOW_ID, dir: { enum: ['TB', 'LR', 'BT', 'RL'], default: 'TB', description: 'TB top down, LR left to right' } },
    },
    result: { type: 'object', required: ['laid'] },
    examples: [{ args: { flowId: EX, dir: 'LR' } }, { args: { flowId: EX } }],
    busy,
    run: (ctx, a) => write(ctx, a.flowId, (items) => {
      const all = laidOut(items, a.dir);
      return { items: all, result: { laid: all.filter((i, k) => i !== items[k] && i.type !== 'connector').length } };
    }),
  }),
  define({
    id: 'flow.insert',
    title: 'Insert a library flowchart into the open draft, synced',
    brief: 'Its later edits show in the draft. draftId: another draft to work on without opening it (drafts_list gives it); leave it out for the open draft.',
    group: GROUP,
    risk: 'write',
    undo: 'doc',
    needs: ['doc.open'],
    args: {
      type: 'object', required: ['flowId'], additionalProperties: false,
      properties: { flowId: FLOW_ID, at: ref('PATH', 'Block to insert after. Omit it for the end'), draftId: DRAFT_ID },
    },
    result: { type: 'object', required: ['path'] },
    examples: [{ args: { flowId: EX } }, { args: { flowId: EX, at: [2] } }],
    // As the library's Insert into draft... with Synced, without the dialog and Canvas Mode: one undo step of the draft.
    plan: async (ctx, a) => {
      const r = await recordOf(ctx, a.flowId);
      const { state, view } = ctx.editor;
      const { doc } = state;
      let pos = doc.content.size;
      if (a.at) {
        pos = posOfPath(doc, a.at);
        if (pos === null) fail('not_found', `No block at [${a.at}]`, { path: a.at });
        pos += doc.nodeAt(pos).nodeSize;
      }
      pos = topLevelPos(doc.resolve(pos));
      const board = structuredClone(r.board);
      const node = state.schema.nodes.canvas.create({ ...board, dw: Math.min(board.w, contentWidth(view)), flow: { id: r.id, rev: r.rev }, source: r.source ?? null });
      const tr = state.tr.insert(pos, node);
      return { tr, result: { path: pathOfPos(tr.doc, pos) } };
    },
  }),
  define({
    id: 'flow.open',
    title: 'Open a library flowchart in the flowchart library editor',
    brief: 'Use it to show the flowchart to the user.',
    group: GROUP,
    risk: 'write',
    undo: 'none',
    headless: false,
    args: { type: 'object', required: ['flowId'], additionalProperties: false, properties: { flowId: FLOW_ID } },
    result: { type: 'object', required: ['flowId'] },
    examples: [{ args: { flowId: EX } }],
    run: async (ctx, a) => {
      await recordOf(ctx, a.flowId);
      if (!(await ctx.flows.openFlows(a.flowId, { remember: false }))) fail('failed', 'The flowchart library did not open');
      return { flowId: a.flowId };
    },
  }),
  define({
    id: 'flow.library.create',
    title: 'Create a library flowchart',
    brief: 'Use it when the user asks for a new flowchart in the library.',
    group: GROUP,
    risk: 'write',
    undo: 'none',
    args: {
      type: 'object', required: ['title'], additionalProperties: false,
      properties: {
        title: { ...TITLE, description: 'Its title' },
        threadUrl: { anyOf: [ref('URL'), { type: 'null' }], description: 'Forum thread URL, or null for none. Omit it for the draft\'s thread' },
        board: {
          type: 'object', additionalProperties: false, description: 'Artboard and first items',
          properties: {
            w: { type: 'integer', minimum: 40, maximum: 8000 }, h: { type: 'integer', minimum: 40, maximum: 8000 },
            bg: { enum: Object.keys(WB_BG) }, items: { type: 'array', items: ref('ITEM'), maxItems: 500 },
          },
        },
      },
    },
    result: { type: 'object', required: ['flowId'] },
    examples: [
      { args: { title: 'Login flow' } },
      { args: { title: 'Door puzzle', threadUrl: null, board: { w: 1200, h: 675, items: [{ type: 'shape', shape: 'round', x: 40, y: 40, w: 160, h: 80, html: 'Start' }] } } },
    ],
    run: (ctx, a) => {
      const b = a.board ?? {};
      let board = { w: b.w ?? FLOW_SIZE.w, h: b.h ?? FLOW_SIZE.h, frame: null, ...(b.bg && { bg: b.bg }), items: [] };
      if (b.items?.length) {
        const s = settle(board, added(ctx, [], b.items, '/board/items').items);
        board = { ...board, w: s.w, h: s.h, frame: s.frame, items: s.items };
      }
      const r = ctx.flows.createFlow({ title: a.title, threadUrl: a.threadUrl === undefined ? ctx.flows.draftThread() : a.threadUrl, board });
      return { flowId: r.id, title: r.title, threadUrl: r.threadUrl };
    },
  }),
  define({
    id: 'flow.library.rename',
    title: 'Rename a library flowchart',
    brief: 'Drafts that show it take the new title.',
    group: GROUP,
    risk: 'write',
    undo: 'none',
    args: { type: 'object', required: ['flowId', 'title'], additionalProperties: false, properties: { flowId: FLOW_ID, title: { ...TITLE, description: 'The new title' } } },
    result: { type: 'object', required: ['flowId', 'title', 'previous'] },
    examples: [{ args: { flowId: EX, title: 'Login flow' } }],
    run: async (ctx, a) => {
      const r = await recordOf(ctx, a.flowId);
      const previous = r.title;
      await ctx.flows.updateFlow(r.id, { title: a.title });
      return { flowId: r.id, title: ctx.flows.getFlow(r.id)?.title ?? r.title, previous };
    },
  }),
  define({
    id: 'flow.library.delete',
    title: 'Delete a library flowchart (moved to the flowcharts trash)',
    notFor: 'removing items. Use flow_items_remove',
    group: GROUP,
    risk: 'destructive',
    undo: 'none',
    args: { type: 'object', required: ['flowId'], additionalProperties: false, properties: { flowId: FLOW_ID } },
    result: { type: 'object', required: ['flowId', 'deleted'] },
    examples: [{ args: { flowId: EX } }],
    ask: (ctx, a) => {
      let here = 0;
      ctx.editor?.state.doc.descendants((n) => {
        if (n.type.name === 'canvas' && n.attrs.flow?.id === a.flowId) here++;
      });
      const draft = here === 1 ? 'Its synced canvas in this draft becomes a plain copy.' : here ? `Its ${here} synced canvases in this draft become plain copies.` : 'It is not in this draft.';
      return {
        title: `delete the flowchart "${titleOf(ctx, a.flowId)}" (moved to the flowcharts trash)`,
        description: `${draft} Synced canvases in other drafts keep their last picture and show "missing".`,
      };
    },
    run: async (ctx, a) => {
      await recordOf(ctx, a.flowId);
      if (!(await ctx.flows.removeFlow(a.flowId, { ask: false }))) fail('failed', 'The flowchart could not be deleted');
      return { flowId: a.flowId, deleted: true };
    },
  }),
];

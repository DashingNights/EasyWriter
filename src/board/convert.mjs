// bd-convert (docs/plans/board/briefs/bd-convert.md, design section 10): an old canvas (whiteboard.js's item form, in the DOM
// editor's px) → the board form the Canvas engine paints (ew_doc keys, points). Pure but for the three engine-backed steps the
// caller gives (`story`, `mediaOf`, `preset`), so node tests load it with fakes. Nothing a refusal leaves behind is changed:
// `checkConvert` proves every id, box, text and picture came through before `convertBoxes` writes a box.
import { after } from './order.mjs';
import { blankBoard, readForm } from './store.mjs';
import { kindOf, patchOf, plainOf, rgb, toPt } from './look.mjs';
import { inkFields } from './tools/pen.js';
import { normalizeGroups } from '../flow/model.mjs';
import { htmlToText } from '../flow/graph.mjs';
import { parseFrame } from '../whiteboard.js';
import { DOCUMENTS_ON_ENGINE } from '../formats.mjs';
import { POSTS_ON_ENGINE } from '../document/canvas/post.js';

const GROUP = 'group';
const SLOTS = ['start', 'mid', 'end'];
const WIDE = 16000; // a width-fitted text's layout width (bd-text)
const ALIGN = { left: 'para.alignLeft', center: 'para.alignCenter', right: 'para.alignRight' };
// The old root fields the board keeps as they are: its own size and place in the Document, and what a Word drawing brought.
const KEEP = ['dw', 'w', 'h', 'source', 'docPr', 'layout', 'run'];
// The old fields each item's translation reads; every other old field is carried over unchanged.
const READ = new Set([
  'id', 'type', 'groups', 'html', 'x', 'y', 'w', 'h', 'rot', 'mirrorX', 'mirrorY', 'flipX', 'flipY', 'opacity', 'hidden', 'locked',
  'color', 'width', 'fill', 'fillColor', 'shape', 'prst', 'av', 'crop', 'src', 'd', 'vw', 'vh',
  'from', 'to', 'route', 'corner', 'points', 'heads', 'dash', 'jump', 'labels', 'size', 'bold', 'align', 'font', 'bg', 'fit', 'textColor',
]);

/** Whether the engine hosts Documents and posts, so a box may move to the board form: the shipped constants alone. A profile
 * setting never turns conversion on; `globalThis.__boardConvertOn` is the harness runs' own switch. */
export const convertOn = () => (globalThis.__boardConvertOn ?? (DOCUMENTS_ON_ENGINE && POSTS_ON_ENGINE)) === true;

/** null when the old canvas `attrs` can convert, else why not: 'flow' (a flowchart library canvas), 'newer' (a board form a newer
 * build wrote) or 'bad' (no items array). A board form is not an old canvas: convertBoxes checks readForm first. */
export function canConvert(attrs) {
  if (attrs?.flow) return 'flow';
  if (readForm(attrs) === 'newer') return 'newer';
  if (!Array.isArray(attrs?.items)) return 'bad';
  return null;
}

/** `attrs` (the old canvas form) → the board's stored form, its `frame` the whole artboard in points or the box of the item
 * `attrs.frame.item` names. `deps`: `story(html, width, steps)` (the item session's paste, then the old text's style steps),
 * `mediaOf(src)` (a picture's bytes stored unchanged → its key) and `preset(prst, av, w, h)` (a DrawingML preset's fields). */
export async function canvasToBoard(attrs, { story, mediaOf, preset }) {
  const items = Array.isArray(attrs?.items) ? attrs.items.filter((i) => i && typeof i === 'object') : [];
  const board = { ...blankBoard() };
  for (const k of KEEP) if (attrs && Object.hasOwn(attrs, k)) board[k] = attrs[k];
  board.bg = attrs && Object.hasOwn(attrs, 'bg') ? attrs.bg : blankBoard().bg;
  board.frame = frameOf(attrs, items);
  board.items = {};
  board.media = {};
  const ordered = normalizeGroups(items.map((i) => ({ ...i })));
  const keys = new Map(); // parent → its last order key
  const groups = new Map(); // group id → its item
  const nextKey = (parent) => {
    const k = keys.has(parent) ? after(keys.get(parent)) : 'V';
    keys.set(parent, k);
    return k;
  };
  const placeGroups = (chain) => { // old groups run innermost first

    let parent = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const id = chain[i];
      let g = groups.get(id);
      if (!g) {
        g = { id, type: GROUP, at: [parent, nextKey(parent)] };
        groups.set(id, g);
        board.items[id] = g;
      }
      parent = id;
    }
    return parent;
  };
  for (const item of ordered) {
    const chain = Array.isArray(item.groups) ? item.groups.filter((g) => typeof g === 'string' && g) : [];
    const parent = chain.length ? placeGroups(chain) : null;
    const fields = await fromLegacy(item, { story, mediaOf, preset, board });
    board.items[item.id] = { ...fields, id: item.id, at: [parent, nextKey(parent)] };
  }
  return board;
}

/** The old canvas `attrs` against the converted `board`: null when everything came through, else a line saying what did not.
 * Each item keeps its id, box, group parent, text and picture; the non-group items keep their old paint order. */
export function checkConvert(attrs, board) {
  const olds = (Array.isArray(attrs?.items) ? attrs.items : []).filter((i) => i && typeof i === 'object');
  for (const o of olds) if (typeof o.id !== 'string' || !o.id) return 'An item has no id';
  const items = board?.items ?? {};
  const news = new Map(Object.values(items).filter((i) => i && i.type !== GROUP && !i.gone).map((i) => [i.id, i]));
  if (news.size !== olds.length) return `${olds.length} items were there and ${news.size} came out`;
  const sorted = normalizeGroups(olds.map((i) => ({ ...i }))); // the conversion's own order and group chains
  const want = sorted.map((i) => i.id);
  const order = paintOrder(items);
  if (order.length !== want.length || order.some((id, i) => id !== want[i])) return 'The paint order differs';
  for (const o of sorted) {
    const n = news.get(o.id);
    if (!n) return `Item ${o.id} was lost`;
    if (o.type === 'connector') {
      if (endMoved(o.from, n.from) || endMoved(o.to, n.to)) return `Connector ${o.id} moved`;
    } else {
      for (const k of ['x', 'y', 'w', 'h']) {
        if (!Number.isFinite(o[k]) || !Number.isFinite(n[k])) continue;
        if (Math.abs(n[k] - toPt(o[k])) > 0.5) return `Item ${o.id} ${k} moved`;
      }
    }
    const chain = (o.groups ?? []).filter((g) => typeof g === 'string' && g);
    if ((n.at?.[0] ?? null) !== (chain[0] ?? null)) return `Item ${o.id} is not in its group`;
    for (let i = 0; i < chain.length; i++) {
      const g = items[chain[i]];
      if (!g || g.type !== GROUP) return `Group ${chain[i]} was lost`;
      if ((g.at?.[0] ?? null) !== (chain[i + 1] ?? null)) return `Group ${chain[i]} is nested wrong`;
    }
    if (typeof o.html === 'string' && plainOf(n.story ?? null) !== htmlToText(o.html)) return `The text of ${o.id} differs`;
    for (const slot of SLOTS) {
      const l = o.labels?.[slot];
      if (l && typeof l.html === 'string' && plainOf(n.labels?.[slot] ?? null) !== htmlToText(l.html)) return `The ${slot} label of ${o.id} differs`;
    }
    if (o.type === 'image') {
      const [a, b] = [bytesOf(o.src), bytesOf(board?.media?.[n.media])];
      if (a == null || b == null || a !== b) return `Picture ${o.id} differs`;
    }
  }
  return null;
}

/** The ids of the non-group items in the order they paint: depth first, each parent's children by their order key. */
function paintOrder(items) {
  const kids = new Map();
  for (const item of Object.values(items)) {
    if (!item || item.gone || typeof item.type !== 'string') continue;
    const parent = item.at?.[0] ?? null;
    const list = kids.get(parent) ?? [];
    list.push(item);
    kids.set(parent, list);
  }
  for (const list of kids.values()) list.sort((a, b) => {
    const [ka, kb] = [a.at?.[1] ?? '', b.at?.[1] ?? ''];
    return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const out = [];
  const walk = (parent) => {
    for (const item of kids.get(parent) ?? []) {
      if (item.type !== GROUP) out.push(item.id);
      walk(item.id);
    }
  };
  walk(null);
  return out;
}

/** Convert every old canvas box `client` lists, once convertOn(). `deps` is the engine-backed steps, or a function giving them
 * on the first box that can convert (so an open with no old canvas starts nothing). A box that cannot convert, throws, is
 * edited while it converts, or whose box.fill fails stays byte for byte as it was; `say` gets one line when any did. */
export async function convertBoxes(client, deps, say) {
  if (!convertOn()) return;
  let boxes;
  try {
    boxes = (await client.query('box.list', {}))?.value?.boxes;
  } catch {
    return;
  }
  if (!Array.isArray(boxes)) return;
  let kept = 0;
  const todo = [];
  for (const box of boxes) {
    if (box?.kind !== 'canvas') continue;
    let attrs;
    try {
      attrs = JSON.parse(box.data);
    } catch {
      continue;
    }
    if (readForm(attrs) !== 'old') continue;
    if (canConvert(attrs) !== null) {
      kept += 1;
      continue;
    }
    todo.push({ box, attrs });
  }
  if (todo.length) {
    let d = null;
    try {
      d = typeof deps === 'function' ? await deps() : deps;
    } catch {
      kept += todo.length;
    }
    if (d) {
      try {
        for (const { box, attrs } of todo) {
          try {
            const board = await canvasToBoard(attrs, d);
            const why = checkConvert(attrs, board);
            if (why) throw new Error(why);
            // The box may have changed while it converted: fill only the data this board was made from.
            const now = (await client.query('box.get', { id: box.id }))?.value;
            if (!now || now.data !== box.data) continue;
            const r = await client.exec('box.fill', { id: box.id, data: JSON.stringify(board) });
            if (!r?.ok) throw new Error(r?.error ?? 'box.fill failed');
          } catch {
            kept += 1;
          }
        }
      } finally {
        d.done?.();
      }
    }
  }
  if (kept) say(kept === 1
    ? '1 canvas stays in its old form. It still shows and edits as before.'
    : `${kept} canvases stay in their old form. They still show and edit as before.`);
}

// --- items ---

/** An old item → its stored fields (no id or at). The old `image` and `stroke` are the board's `picture` and `ink`. */
async function fromLegacy(item, deps) {
  const type = item.type === 'image' ? 'picture' : item.type === 'stroke' ? 'ink' : item.type;
  let fields;
  if (item.type === 'stroke') fields = inkOf(item);
  else if (item.type === 'image') fields = await pictureOf(item, deps);
  else fields = patchOf({ type: item.type }, item);
  fields.type = type;

  if (item.type === 'shape') {
    const prst = item.prst ?? kindOf(item.shape)?.prst ?? null;
    if (prst) Object.assign(fields, await deps.preset(prst, item.av ?? [], toPt(item.w ?? 0), toPt(item.h ?? 0)));
    if (typeof item.html === 'string') fields.story = await deps.story(item.html, labelWidth(item), stepsOf(item, 'shape'));
  }
  if (item.type === 'text') {
    // An old `fit` text (whiteboard.js draws it at max-content) fits its width and lays out unwrapped; one with a fixed width
    // fits its height. Only a fixed text stores its height.
    const widthFits = item.fit === true || !(Number.isFinite(item.w) && item.w > 0);
    fields.fit = widthFits ? 'width' : 'height';
    delete fields.h;
    if (typeof item.html === 'string') fields.story = await deps.story(item.html, widthFits ? WIDE : toPt(item.w), stepsOf(item, 'text'));
    const fill = solidOf(item.bg);
    if (fill) fields.fill = fill;
  }
  for (const k of ['hidden', 'locked']) if (fields[k] !== true) delete fields[k];
  for (const [k, v] of Object.entries(item)) if (!READ.has(k) && !(k in fields)) fields[k] = structuredClone(v);
  return fields;
}

/** An old text item's `bg` as a stored solid fill, or null (no background, or not a colour). */
function solidOf(color) {
  if (!rgb(color)) return null;
  return patchOf(null, { fill: 'solid', fillColor: color }).fill;
}

/** The engine steps an old item's own look becomes (bd-text's restyle table; the old size is px). Bold is only ever turned on: an
 * off step would strip the inline `<b>` a Word label's html carries. Size and colour stay global, as the old html has no per-run
 * size or colour unless it came from Word, where the item's own look is the first run's (session.js keeps the runs' own). */
function stepsOf(item, kind) {
  const steps = [];
  if (typeof item.font === 'string' && item.font.trim()) steps.push(['format.font', { name: item.font }]);
  if (Number.isFinite(item.size) && item.size > 0) steps.push(['format.size', { size: toPt(item.size) }]);
  if (item.bold === true) steps.push(['format.bold', { value: true }]);
  const c = rgb(kind === 'text' ? item.color : item.textColor);
  if (c) steps.push(['format.color', { color: c.map((v) => v.toString(16).padStart(2, '0')).join('') }]);
  if (ALIGN[item.align]) steps.push([ALIGN[item.align], {}]);
  return steps;
}

/** The width a shape's label lays out at, points (bd-text's 7.2 pt side insets; a preset's own rectangle is not to hand here). */
const labelWidth = (item) => Math.max(1, toPt(item.w ?? 0) - 14.4);

/** An old picture → a stored `picture`, its bytes kept as the source data URL under mediaOf's key. */
async function pictureOf(item, { mediaOf, board }) {
  const key = await mediaOf(item.src);
  board.media[key] = item.src;
  return patchOf({ type: 'picture' }, { ...item, src: `media:${key}` });
}

/** An old stroke → a stored `ink` keeping the item's own box: the old pen frames a stroke with `width / 2 + 1` px of padding
 * (whiteboard.js finishStroke), so inkFields' tighter framing would move its edges. Its points are local to that box. */
function inkOf(item) {
  const [x, y, w, h] = [toPt(item.x ?? 0), toPt(item.y ?? 0), toPt(item.w ?? 0), toPt(item.h ?? 0)];
  const points = strokePoints(item);
  const base = inkFields(points, { color: item.color, width: item.width, opacity: item.opacity });
  const fields = {
    type: 'ink', x, y, w, h,
    freeform: { ...base.freeform, w, h, paths: [{ pts: points.map((p) => [r2(p.x - x), r2(p.y - y)]), closed: false }] },
    stroke: base.stroke,
    strokeWidth: base.strokeWidth,
    extra: base.extra,
  };
  if (Number.isFinite(item.rot)) fields.rot = ((item.rot % 360) + 360) % 360;
  if (item.mirrorX) fields.flipX = true;
  if (item.mirrorY) fields.flipY = true;
  return fields;
}

const r2 = (n) => Math.round(n * 100) / 100; // a stored point to 0.01 pt (inkFields)

/** The world points of an old stroke's `d`: every coordinate pair in its path commands, in the item's `vw` × `vh` viewBox,
 * scaled to its box (old px) and then to points. */
function strokePoints(item) {
  const vw = Number.isFinite(item.vw) && item.vw > 0 ? item.vw : item.w;
  const vh = Number.isFinite(item.vh) && item.vh > 0 ? item.vh : item.h;
  const kx = vw > 0 ? (item.w ?? 0) / vw : 1;
  const ky = vh > 0 ? (item.h ?? 0) / vh : 1;
  const out = [];
  for (const m of String(item.d ?? '').matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const nums = (m[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: toPt((item.x ?? 0) + nums[i] * kx), y: toPt((item.y ?? 0) + nums[i + 1] * ky) });
  }
  return out;
}

/** The board's frame for the old canvas: the box of the item `frame.item` names, else the old frame itself (a crop of the
 * artboard, whiteboard.js parseFrame), else the whole artboard, all in points. */
function frameOf(attrs, items) {
  const f = parseFrame(attrs?.frame);
  if (f?.item) {
    const it = items.find((i) => i?.id === f.item);
    if (it && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(it[k]))) return { x: toPt(it.x), y: toPt(it.y), w: toPt(it.w), h: toPt(it.h) };
  }
  if (f) return { x: toPt(f.x), y: toPt(f.y), w: toPt(f.w), h: toPt(f.h) };
  const w = Number.isFinite(attrs?.aw) ? attrs.aw : Number.isFinite(attrs?.w) ? attrs.w : 0;
  const h = Number.isFinite(attrs?.ah) ? attrs.ah : Number.isFinite(attrs?.h) ? attrs.h : 0;
  return { x: 0, y: 0, w: toPt(w), h: toPt(h) };
}

/** Whether connector end `old` maps to `next`: a free end scaled, a bound one kept (the same item and anchor). */
function endMoved(old, next) {
  const free = (e) => (e && Number.isFinite(e.x) && Number.isFinite(e.y) ? e : null);
  const [a, b] = [free(old), free(next)];
  if (!!a !== !!b) return true;
  return !!a && (Math.abs(b.x - toPt(a.x)) > 0.5 || Math.abs(b.y - toPt(a.y)) > 0.5);
}

/** A data URL or a stored reference's byte length, or null. */
function bytesOf(src) {
  if (typeof src !== 'string') return null;
  const m = /^data:([^,]*),(.*)$/s.exec(src);
  if (!m) return null;
  try {
    return /;base64$/i.test(m[1]) ? atob(m[2]).length : new TextEncoder().encode(decodeURIComponent(m[2])).length;
  } catch {
    return null;
  }
}

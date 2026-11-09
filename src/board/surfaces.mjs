// The board's surfaces (docs/plans/board/design.md section 3, briefs/bd-area.md): each item is one surface of the board session,
// its stamp the display list the worker paints. A type registers how it derives fields and places; this module keeps the handles,
// sends a model for each item whose paint changed and gives the viewport its placements.

import { modelOf } from './model.mjs';

/** Fields that change no paint: a write of one of these sends the worker nothing. */
export const MOVE_ONLY = new Set(['x', 'y', 'at', 'name', 'locked', 'hidden', 'gone']);

/** The width a `fit: 'width'` text lays out at: wide enough that no line wraps, so its stamp gives the text's own width
 * (bd-text). */
const TEXT_WIDE = 16000;

const types = new Map();

/** Per type: derive(item, store) → fields computed on read; placements(item, ctx) → placements; paints: whether it has a stamp. */
export function registerType(type, rule) {
  types.set(type, rule);
}

export const ruleOf = (type) => types.get(type);

/** The item with its type's derive fields merged in, never written back. `stampOf(id)` lets a rule read the last stamp (a fitted
 * text's size). */
export function derived(item, store, stampOf = null) {
  if (!item) return item;
  const fields = types.get(item.type)?.derive?.(item, store, stampOf);
  return fields ? { ...item, ...fields } : item;
}

registerType('shape', { paints: true });
registerType('picture', { paints: true });
registerType('ink', { paints: true });
// A text's own size comes from its stamp: the widest line and the page the laid-out text needs.
registerType('text', {
  paints: true,
  derive: (item, _store, stampOf) => {
    const stamp = stampOf?.(item.id);
    if (!stamp) return null;
    if (item.fit === 'width') return { w: stamp.textW, h: stamp.textH };
    if (item.fit === 'height') return { h: stamp.textH };
    return null;
  },
});

/** The board's pictures as a Map key → bytes: each data URL decoded once. */
export function mediaOf(media) {
  const out = new Map();
  mergeMedia(out, media);
  return out;
}

/** Adds the pictures of `media` the map lacks, decoded → the keys it added. A picture that arrives after the open joins the map
 * here, so the next stamp of an item that names it draws it. */
export function mergeMedia(map, media) {
  const added = [];
  for (const [key, value] of Object.entries(media ?? {})) {
    if (map.has(key)) continue;
    const m = typeof value === 'string' ? /^data:[^;,]*;base64,(.*)$/s.exec(value) : null;
    if (!m) continue;
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    map.set(key, bytes);
    added.push(key);
  }
  return added;
}

/** The paint of `item`: every field but the ones that move or hide it. A change that leaves these the same sends nothing. */
const paintOf = (item) => {
  const out = {};
  for (const k of Object.keys(item)) if (k !== 'id' && k !== '_s' && !MOVE_ONLY.has(k)) out[k] = item[k];
  return JSON.stringify(out);
};

/** What a stamp is made of: the item's painted fields, and whether its picture is in the board's media yet (one that arrives
 * after the open changes this, so the item stamps again and draws it). */
const sigOf = (item, media) => `${paintOf(item)}|${item.media == null ? '' : media.has(item.media) ? 'm' : '-'}`;

/** The width a text lays out at (`Look::text`), -1 for anything else. */
const layoutWidth = (item) => (item.type !== 'text' ? -1 : item.fit === 'width' ? TEXT_WIDE : Math.max(1, item.w ?? TEXT_WIDE));

/**
 * The board's surfaces over one board session. `apply(list)` sends entries to the worker's `boardApply` → the stamps
 * [{handle, ok, ox, oy, w, h, textW, textH, error}]; `base` is the item session's blank model; `media` the board's pictures.
 */
export function createSurfaces({ apply, base, media }) {
  const handles = new Map(); // item id → surface handle, never reused
  const stamps = new Map(); // item id → the worker's last stamp
  const paint = new Map(); // item id → the painted fields last sent
  let next = 1; // 0 is the board session's own blank document's first surface
  let store = null; // the store the last sync read, for preview

  const handleOf = (id) => {
    let handle = handles.get(id);
    if (handle == null) handles.set(id, (handle = next++));
    return handle;
  };
  const stampOf = (id) => stamps.get(id);

  const entryOf = (item) => ({ handle: handleOf(item.id), model: modelOf(item, base, media), rot: item.rot ?? 0,
    flipX: !!item.flipX, flipY: !!item.flipY, opacity: item.opacity ?? 1, text: layoutWidth(item),
    widthFit: item.type === 'text' && item.fit === 'width' });

  const forget = (id) => {
    stamps.delete(id);
    paint.delete(id);
  };

  /** Records the worker's answers by handle; a failed stamp logs and leaves the item without a placement. */
  const record = async (result, byHandle) => {
    for (const r of result ?? []) {
      const id = byHandle.get(r.handle);
      if (id == null) continue;
      if (r.ok) stamps.set(id, r);
      else {
        stamps.delete(id);
        paint.delete(id);
        console.warn(`The board could not stamp item ${id}: ${r.error}`);
      }
    }
    return result;
  };

  /** The items in `ids` whose painted fields changed, as models the worker stamps → its answers. Never throws. */
  async function sync(board, ids) {
    store = board;
    const list = [];
    const byHandle = new Map();
    for (const id of ids ?? []) {
      if (id == null) continue; // a board field (the background), no surface
      const item = board.get(id);
      if (!item || item.gone) {
        if (!handles.has(id)) continue;
        list.push({ handle: handleOf(id), gone: true });
        forget(id);
        continue;
      }
      if (!types.get(item.type)?.paints) continue;
      const d = derived(item, board, stampOf);
      const next = sigOf(d, media);
      if (paint.get(id) === next) continue; // a move, a rename, a lock or a hide
      paint.set(id, next);
      const entry = entryOf(d);
      list.push(entry);
      byHandle.set(entry.handle, id);
    }
    if (!list.length) return [];
    try {
      return await record(await apply(list), byHandle);
    } catch (e) {
      console.warn('The board could not send its items', e);
      for (const id of byHandle.values()) paint.delete(id);
      return [];
    }
  }

  /** A stamp of item `id` with `fields` over it, for a drag's frames: no store op, so nothing is saved or undone. */
  async function preview(id, fields = {}) {
    const item = store?.get(id);
    if (!item) return [];
    const d = { ...derived(item, store, stampOf), ...fields };
    const entry = entryOf(d);
    try {
      return await record(await apply([entry]), new Map([[entry.handle, id]]));
    } catch {
      return [];
    }
  }

  /** Takes item `id`'s surface away. */
  async function drop(id) {
    if (!handles.has(id)) return [];
    const handle = handleOf(id);
    forget(id);
    try {
      return await apply([{ handle, gone: true }]);
    } catch {
      return [];
    }
  }

  return { handleOf, stampOf, sync, preview, drop };
}

/** The placements of the board's items, bottom first: the live items in paint order, each of a type with a stamp (or the
 * placements its type gives), hidden ones and their children left out. `over` (item id → fields) shows a drag's preview
 * fields in place of the stored ones, since a resize or a turn moves the page the stamp was made from. */
export function placementsOf(store, surfaces, session, ctx, over = null) {
  const hidden = (item) => {
    const seen = new Set();
    for (let cur = item; cur && !seen.has(cur.id);) {
      if (cur.hidden) return true;
      seen.add(cur.id);
      const parent = cur.at?.[0] != null ? store.get(cur.at[0]) : null;
      cur = parent && !parent.gone ? parent : null;
    }
    return false;
  };
  const out = [];
  for (const item of store.live()) {
    if (hidden(item)) continue;
    const rule = ruleOf(item.type);
    if (rule?.placements) {
      out.push(...rule.placements(item, ctx));
      continue;
    }
    const stamp = surfaces.stampOf(item.id);
    if (!stamp) continue;
    // A type that derives its own box (a connector from its ends) places by that box, not by a stored x and y.
    const box = rule?.derive ? derived(item, store, surfaces.stampOf) ?? item : item;
    const at = over?.[item.id];
    out.push({ key: item.id, session, surface: surfaces.handleOf(item.id), x: (at?.x ?? box.x ?? 0) + stamp.ox,
      y: (at?.y ?? box.y ?? 0) + stamp.oy, w: stamp.w, h: stamp.h });
  }
  return out;
}

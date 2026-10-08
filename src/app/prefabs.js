import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { makePrefab, parsePrefab, prefabItems, summaryOfPrefab } from '../flow/prefab.mjs';
import { KINDS } from '../flow/shapes.mjs';
import { rasterizeWhiteboard } from '../whiteboard.js';
import { confirmDialog, saveSettings } from './actions.js';
import { cleanRefs, defaultFavourites, liveRefs, moveRef, resetOrder, shapeSections, toggleFavourite } from './shape-list.mjs';
import { getState, setState } from './store.js';

// The user's prefabs (flowchart plan §3.10, §4, §5.12; SPEC §6g): one record per `userData/prefabs/<uuid>.json` (api.prefabs),
// listed the first time a shape list subscribes (no init() call), loaded lazily, each write saved at once. Also the shape
// list's favourites and section order (settings.shapeFavourites / shapeOrder), one saveSettings call per change.

const api = window.api;
const state = getState();
const THUMB = 192; // px on a thumbnail's long side

let summaries = []; // summaryOfPrefab of every prefab, as listed
let loaded = false;
let listing = null;
const records = new Map(); // id → loaded record
const listeners = new Set();
let version = 0;

const openDialog = (type, props = {}) => new Promise((resolve) => setState({ dialog: { type, props, resolve } }));

function notify() {
  version++;
  for (const fn of listeners) fn();
}

function list() {
  listing ??= api.prefabs.list().then((rows) => {
    summaries = rows.filter((s) => typeof s?.id === 'string').map((s) => ({
      ...s, name: typeof s.name === 'string' ? s.name : 'Prefab', keywords: Array.isArray(s.keywords) ? s.keywords : [],
      thumb: typeof s.thumb === 'string' ? s.thumb : null,
    }));
    loaded = true;
    notify();
    fillThumbs();
  }, () => {
    listing = null; // the next subscribe asks again
  });
  return listing;
}

/** Calls `fn` on every change of the prefabs; the first subscriber lists them. */
export function subscribePrefabs(fn) {
  listeners.add(fn);
  list();
  return () => listeners.delete(fn);
}

/** Re-renders the calling component on every prefab change. */
export const usePrefabs = () => useSyncExternalStore(subscribePrefabs, () => version);
export const prefabList = () => summaries;

/** The prefab `id`, loaded once; null when it does not exist. */
export async function loadPrefab(id) {
  if (!records.has(id)) {
    const r = parsePrefab(await api.prefabs.load(id).catch(() => null));
    if (r?.id === id) records.set(id, r);
  }
  return records.get(id) ?? null;
}

// Saves `record` (a new one has no id) → the saved record, or null after a toast.
async function write(record) {
  try {
    const { id, created, updated } = await api.prefabs.save(record);
    const r = { ...record, id, created, updated };
    records.set(id, r);
    summaries = [summaryOfPrefab(r), ...summaries.filter((s) => s.id !== id)];
    notify();
    return r;
  } catch (e) {
    toast.error(`Could not save the prefab: ${e.message || e}`);
    return null;
  }
}

// A PNG data URL of the prefab's items, ≤ THUMB px on the long side; null when it cannot be drawn.
async function thumbOf({ w, h, items }) {
  try {
    const { blob } = await rasterizeWhiteboard({ height: h, items, bg: 'transparent' },
      { width: w, theme: state.settings?.theme, scale: Math.min(2, THUMB / Math.max(w, h)) });
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// Prefabs saved without a thumbnail (by an agent, or a failed render) get one the first time the list is shown.
async function fillThumbs() {
  for (const s of summaries.filter((x) => !x.thumb)) {
    const r = await loadPrefab(s.id);
    const thumb = r && (await thumbOf(r));
    if (thumb) await write({ ...r, thumb });
  }
}

/** Create prefab… (board menu, tool search): the name, then the board's selected items as a new prefab with its thumbnail. */
export async function createPrefab(board) {
  board.finishEdit();
  const items = board.selectedItems();
  if (!items.length) return;
  await list(); // the default name counts them
  const name = await openDialog('prefabName', { name: `Prefab ${summaries.length + 1}` });
  board.focus();
  if (name == null) return;
  const p = makePrefab(items, board.unit);
  if (await write({ version: 1, name, keywords: [], ...p, thumb: await thumbOf(p) })) toast('Prefab saved');
}

export async function renamePrefab(id) {
  const r = await loadPrefab(id);
  if (!r) return;
  const name = await openDialog('prefabName', { name: r.name, rename: true });
  if (name != null && name !== r.name) await write({ ...r, name });
}

export async function duplicatePrefab(id) {
  const r = await loadPrefab(id);
  if (!r) return;
  const { id: _, created, updated, ...rest } = r;
  await write({ ...rest, name: `${r.name} (copy)`.slice(0, 80) });
}

/** Delete… (asks): the file goes to the trash; placed copies stay, and its refs leave the shape list's settings on the next
 * write (cleanRefs). */
export async function removePrefab(id) {
  const s = summaries.find((x) => x.id === id);
  if (!s) return;
  const ok = await confirmDialog({ title: `Delete prefab "${s.name}"?`, description: 'Items already placed stay.', confirmText: 'Delete', destructive: true });
  if (!ok) return;
  try {
    await api.prefabs.remove(id);
  } catch (e) {
    toast.error(`Could not delete the prefab: ${e.message || e}`);
    return;
  }
  records.delete(id);
  summaries = summaries.filter((x) => x.id !== id);
  notify();
}

/** Arms `board`'s shape tool with prefab `id`: its next click places it (§6g). A canvas drops canvas items (they do not nest). */
export async function armPrefab(board, id) {
  const what = await prefabTile(board, id);
  if (what) board.setMode('shape', { id, ...what });
  return !!what;
}

/** What prefab `id` adds to `board` ({items} at its unit, Board.spawnItems), or null after a toast. */
export async function prefabTile(board, id) {
  const r = await loadPrefab(id);
  if (!r || board.destroyed) return null;
  const items = prefabItems(r, board.unit).filter((i) => !board.fixed || i.type !== 'canvas');
  if (items.length) return { items };
  toast.error('Canvases cannot go inside a canvas');
  return null;
}

// --- the shape list's order (settings.shapeFavourites, settings.shapeOrder) ---

const favourites = () => state.settings?.shapeFavourites ?? [];
const sectionOrder = () => state.settings?.shapeOrder ?? {};
/** The shape list's sections (shape-list.mjs shapeSections) for prefab summaries `prefabs`. */
export const shapeLayout = (prefabs = summaries) => shapeSections(KINDS, prefabs, favourites(), sectionOrder());

// One saveSettings call per change; refs to deleted prefabs and unknown kinds go (all prefab refs stay until the list is in).
function writeShapeList(favs, order) {
  const live = liveRefs(KINDS, summaries);
  if (!loaded) for (const r of [...favs, ...Object.values(order).flat()]) if (String(r).startsWith('prefab:')) live.add(r);
  const c = cleanRefs(favs, order, live);
  return saveSettings({ shapeFavourites: c.favs, shapeOrder: c.order });
}

export const toggleShapeFavourite = (ref) => writeShapeList(toggleFavourite(favourites(), ref), sectionOrder());

/** A tile `ref` dropped in `section` just before `target` (after it with `after`; no target: on the section itself).
 * Favourites: starred at that place (or at the end). Its own section: moved there. A favourite on another section: unstarred. */
export function dropShape(ref, section, target = null, after = false) {
  const favs = favourites();
  if (section === 'favourites') {
    if (target) return writeShapeList(moveRef(favs, ref, target, after), sectionOrder());
    return favs.includes(ref) ? null : writeShapeList([...favs, ref], sectionOrder());
  }
  if (favs.includes(ref)) return writeShapeList(favs.filter((r) => r !== ref), sectionOrder());
  const all = shapeLayout().find((s) => s.id === section)?.all ?? [];
  if (!target || !all.includes(ref) || !all.includes(target)) return null;
  return writeShapeList(favs, { ...sectionOrder(), [section]: moveRef(all, ref, target, after) });
}

/** Whether `section` shows the user's own order (its Reset order button). */
export function customOrder(section) {
  if (section !== 'favourites') return Array.isArray(sectionOrder()[section]);
  const live = shapeLayout()[0].refs;
  return live.join() !== defaultFavourites(live, KINDS, summaries).join();
}

export function resetShapeSection(section) {
  if (section === 'favourites') return writeShapeList(defaultFavourites(shapeLayout()[0].refs, KINDS, summaries), sectionOrder());
  return writeShapeList(favourites(), resetOrder(sectionOrder(), section));
}

// Prefabs (flowchart plan §3.10, SPEC §6g): the user's saved groups of board items, placed as independent copies. Pure: no DOM,
// no app state. Stored sizes are post px; a board's unit converts them (SPEC §6c Units).
import { groupBox, parseBoard, scaleItem } from '../whiteboard.js';
import { cloneItems, defaultMeasure, moveItem } from './model.mjs';
import { resolveConnectors } from './route.mjs';
import { rotBox } from './shapes.mjs';

const ID_RE = /^[a-f0-9-]{36}$/; // the uuid pattern of file-family.js
const NAME_MAX = 80;
const DERIVED = ['x', 'y', 'w', 'h', 'd', 'tips', 'lps']; // a connector's, written again by every resolve

// An item's box: a turned shape by its turned bounds, a connector by its derived bbox, text by its stored height.
const boxOf = (i) => (i.type === 'shape' && i.rot ? rotBox(i) : defaultMeasure(i));
const strip = (i) => (i.type === 'connector' ? Object.fromEntries(Object.entries(i).filter(([k]) => !DERIVED.includes(k))) : i);
const sizeOf = (items) => {
  const b = groupBox(resolveConnectors(items).items.map(boxOf));
  return b ? { w: Math.max(1, Math.round(b.x + b.w)), h: Math.max(1, Math.round(b.y + b.h)) } : { w: 1, h: 1 };
};

/** {w, h, items} of board items `items` (board px of a board of `unit`): ids local to the prefab (p1, p2, …), a connector
 * bound only while both its ends are among them (else free at its tip), the group's top-left at 0,0, sizes in post px,
 * connector routes dropped (every renderer routes them again). */
export function makePrefab(items, unit = 1) {
  let n = 0;
  const copies = resolveConnectors(cloneItems(items, () => `p${++n}`)).items; // dangling ends freed, bboxes fresh
  const box = groupBox(copies.map(boxOf)) ?? { x: 0, y: 0, w: 1, h: 1 };
  const out = copies.map((i) => strip(scaleItem(moveItem(i, -box.x, -box.y), 1 / unit)));
  return { w: Math.max(1, Math.round(box.w / unit)), h: Math.max(1, Math.round(box.h / unit)), items: out };
}

/** The items of `prefab` for a board of `unit`: sizes × unit, connectors routed (the board's insert gives them new ids). */
export const prefabItems = (prefab, unit = 1) => resolveConnectors(prefab.items.map((i) => scaleItem(strip(i), unit))).items;

/** A prefab record (JSON text or object) with every field valid, or null without an object or a uuid id. Never throws. */
export function parsePrefab(json) {
  let r = json;
  try {
    if (typeof json === 'string') r = JSON.parse(json);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  const items = parseBoard(JSON.stringify({ items: Array.isArray(r.items) ? r.items : [] })).items.map(strip);
  const size = Number.isFinite(r.w) && Number.isFinite(r.h) && r.w > 0 && r.h > 0 ? { w: r.w, h: r.h } : sizeOf(items);
  const stamp = (v) => (Number.isFinite(v) ? v : null);
  return {
    version: Number.isInteger(r.version) ? r.version : 1,
    id: r.id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, NAME_MAX) : 'Prefab',
    keywords: Array.isArray(r.keywords) ? r.keywords.filter((k) => typeof k === 'string' && k && k.length <= 40).slice(0, 10) : [],
    ...size,
    items,
    thumb: typeof r.thumb === 'string' && r.thumb.startsWith('data:image/png;base64,') ? r.thumb : null,
    created: stamp(r.created),
    updated: stamp(r.updated),
  };
}

/** What the shape list shows of a prefab (as main's prefabs.list summary). */
export const summaryOfPrefab = (p) => ({
  id: p.id, name: p.name, keywords: p.keywords, w: p.w, h: p.h, items: p.items.length, thumb: p.thumb, created: p.created, updated: p.updated,
});

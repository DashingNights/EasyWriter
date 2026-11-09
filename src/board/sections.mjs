// A document on a board as a section (docs/plans/board/design.md section 6): its pages' slots, the box round them, their
// reading order and the arrows that show it. Pure, so the node test and the board read the same rules. A slot is keyed by the
// stable id of the block the page starts in (`surfaces()` `first`: "<id>#<n>"), so a hard break that shifts text keeps each
// paragraph's page where it was. Slots are relative to the item's point, so a move of x or y carries every page.
import { GAP, freeSpot, grid } from './place.mjs';

/** The room round the pages a section's fill keeps, points. */
export const PAD = 32;

/** The page keys of `pages` ([{first}]): what `item.slots` names the pages by. */
export const keysOf = (pages) => pages.map((page) => page.first);

/**
 * Each page's top left: its stored slot (relative to the item's point) added to `item.x` and `item.y`, else a spot right of
 * the page before it, `GAP` away; the first page of a section with no stored slot at the item's own point. A page that would
 * land on one of its document's pages takes the nearest free spot to the right in that row, so stored pages never move. A key
 * no page has any more is ignored, and dropped at a page's move. With `item.slots` null, the import grid.
 */
export function slotsOf(item, pages, keys = keysOf(pages)) {
  if (!item.slots) return grid(pages, item);
  const x0 = item.x ?? 0;
  const y0 = item.y ?? 0;
  const rects = pages.map((page, k) => {
    const slot = keys[k] != null ? item.slots[keys[k]] : null;
    return slot ? { x: x0 + slot[0], y: y0 + slot[1], w: page.w, h: page.h } : null;
  });
  const placed = () => rects.filter(Boolean);
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let k = 0; k < pages.length; k++) {
    if (rects[k]) continue;
    const prev = k > 0 ? rects[k - 1] : null;
    let want = prev ? { x: prev.x + prev.w + GAP, y: prev.y } : { x: x0, y: y0 };
    const size = { w: pages[k].w, h: pages[k].h };
    let box = { ...want, ...size };
    if (placed().some((r) => overlap(box, r))) {
      // To the right in that row: a free spot the search put on another row steps the want along the row again.
      let spot = freeSpot(size, placed(), want);
      for (let i = 0; i < 64 && Math.abs(spot.y - want.y) > 0.01; i++) {
        want = { x: want.x + size.w + GAP, y: want.y };
        spot = freeSpot(size, placed(), want);
      }
      box = { ...spot, ...size };
    }
    rects[k] = box;
  }
  return rects.map(({ x, y }) => ({ x, y }));
}

/** The pages' boxes, in page order: their slots and their own sizes. */
export function rectsOf(item, pages) {
  return slotsOf(item, pages).map((slot, k) => ({ x: slot.x, y: slot.y, w: pages[k].w, h: pages[k].h }));
}

/** The box round `rects`, or null for none. */
export function boundsOf(rects) {
  if (!rects?.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The box round `rects` grown by PAD each way, or null for none. */
export function sectionRect(rects) {
  const b = boundsOf(rects);
  return b && { x: b.x - PAD, y: b.y - PAD, w: b.w + 2 * PAD, h: b.h + 2 * PAD };
}

/** Page indexes in reading order: the unplaced page with the smallest y (ties smallest x) starts a row as tall as itself; a
 * page joins it when more than half of its own height is inside that band, and the row runs left to right. */
export function readingOrder(rects) {
  const rest = rects.map((_, i) => i);
  const out = [];
  while (rest.length) {
    let p = 0;
    for (let j = 1; j < rest.length; j++) {
      const a = rects[rest[j]];
      const b = rects[rest[p]];
      if (a.y < b.y || (a.y === b.y && a.x < b.x)) p = j;
    }
    const [start] = rest.splice(p, 1);
    const band = { y: rects[start].y, end: rects[start].y + rects[start].h };
    const row = [start];
    for (let j = rest.length - 1; j >= 0; j--) {
      const r = rects[rest[j]];
      const overlap = Math.min(r.y + r.h, band.end) - Math.max(r.y, band.y);
      if (overlap > r.h / 2) row.push(rest.splice(j, 1)[0]);
    }
    row.sort((a, b) => rects[a].x - rects[b].x);
    out.push(...row);
  }
  return out;
}

/** The flow's arrows: page k of the reading order's right middle to the next's left middle ([{from, to}] points). */
export function arrows(rects) {
  const order = readingOrder(rects);
  const out = [];
  for (let i = 1; i < order.length; i++) {
    const a = rects[order[i - 1]];
    const b = rects[order[i]];
    out.push({ from: { x: a.x + a.w, y: a.y + a.h / 2 }, to: { x: b.x, y: b.y + b.h / 2 } });
  }
  return out;
}

/** The page under world point `w`, the topmost drawn first, or null. */
export function pageAt(rects, w) {
  for (let k = rects.length - 1; k >= 0; k--) {
    const r = rects[k];
    if (w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h) return k;
  }
  return null;
}

/** The slots to store for `rects` under `keys` ({key: [x, y]}, relative to `at`): every page that has a key. */
export function keyedSlots(rects, keys, at = { x: 0, y: 0 }) {
  const out = {};
  rects.forEach((r, k) => {
    const key = keys?.[k];
    if (key != null) out[key] = [r.x - at.x, r.y - at.y];
  });
  return out;
}

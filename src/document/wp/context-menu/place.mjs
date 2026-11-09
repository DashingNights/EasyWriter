// Where the mini toolbar sits and how it fades, and which page band a right-click hit (docs/plans/word/briefs/context-menu.md,
// index-editing.md "Mini toolbar"). Pure: node tests load it.

export const NEAR = 30; // px: the pointer this close to the bar turns it solid
export const FAR = 100; // px: the pointer this far away hides it
const GAP = 8; // px between the bar and what it sits above or below

/** The bar's look with the pointer `d` px from it: 'solid' within NEAR, 'hidden' beyond FAR, else 'faded'. */
export const fadeAt = (d) => (d <= NEAR ? 'solid' : d > FAR ? 'hidden' : 'faded');

/** The distance in px from point `p` ({x, y}) to rect `r` ({left, top, right, bottom}); 0 inside it. */
export function distance(p, r) {
  const dx = Math.max(r.left - p.x, 0, p.x - r.right);
  const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
  return Math.hypot(dx, dy);
}

/** The union of `rects` ({left, top, right, bottom}), or null for none. */
export function union(rects) {
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

/** The bar's top-left for a `w` x `h` bar over the selection `rects` (and the point `at`, the pointer or the menu's corner, when
 * given) inside `view` ({left, top, right, bottom}) → {left, top, below}: GAP above all of them, or GAP below them when there is no
 * room above (below: true); centred on `at` (else on the rects) and kept inside the view. Above or below the union, it never
 * covers a selection rect. */
export function placeBar({ rects = [], at = null, w, h, view }) {
  const box = union(at ? [...rects, { left: at.x, top: at.y, right: at.x, bottom: at.y }] : rects) ?? { left: view.left, top: view.top, right: view.left, bottom: view.top };
  const cx = at ? at.x : (box.left + box.right) / 2;
  const left = Math.max(view.left, Math.min(cx - w / 2, view.right - w));
  const above = box.top - GAP - h;
  const below = above < view.top;
  return { left, top: below ? box.bottom + GAP : above, below };
}

/** The band of a page that layout y `y` (px in the editor's zoom-free coordinates) falls in → 'header' above a page's body,
 * 'footer' below it, or null in the body or between pages. `pages`: geometry PageBoxes {top, bodyTop, bodyHeight, box: {h}}. */
export function areaAt(pages, y) {
  const page = (pages ?? []).find((p) => y >= p.top && y < p.top + (p.box?.h ?? 0));
  if (!page) return null;
  if (y < page.bodyTop) return 'header';
  if (y > page.bodyTop + page.bodyHeight) return 'footer';
  return null;
}

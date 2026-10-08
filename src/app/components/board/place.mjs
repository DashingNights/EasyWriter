// Item ribbon placement (pure; unit tested in test/place.test.mjs). Rects are client px {left, top, right, bottom}.

const GAP = 12; // between the selection's chrome box (outlines, handles) and the ribbon, and between the pointer and the ribbon
const MARGIN = 8; // from the edges of the visible area

const fit = (v, min, max) => Math.max(min, Math.min(v, max));

// Top-left {x, y} of a ribbon of `size` {w, h} for a selection whose chrome (outlines, resize handles, rotate handle,
// quick-connect dots, group box) spans `box`: above it, else below it, else beside it, else (a selection taller than the
// visible area) next to the pointer or pinned to the top or bottom of the visible area, wherever it covers none of the
// `avoid` rects (the handles themselves, other bars, e.g. the canvas edit bar). Its left edge at `at.x` (after a keyboard
// selection the item's left, no `at.y`; after a pointer selection its first control at the pointer, `at.y` the pointer's
// y). Always inside `view` (the visible area, already clipped to the window) as far as the ribbon fits.
export function placeRibbon(box, size, view, avoid = [], at = { x: box.left }) {
  const [minX, minY] = [view.left + MARGIN, view.top + MARGIN];
  const maxX = Math.max(minX, view.right - MARGIN - size.w);
  const maxY = Math.max(minY, view.bottom - MARGIN - size.h);
  const x = fit(at.x, minX, maxX);
  const ptr = at.y != null;
  const centred = fit((box.left + box.right - size.w) / 2, minX, maxX);
  const inside = (y) => y >= minY && y <= maxY;
  const side = fit(ptr ? at.y - size.h / 2 : box.top, minY, maxY);
  const spots = [
    ...[box.top - GAP - size.h, box.bottom + GAP].filter(inside).map((y) => ({ x, y })),
    ...[box.right + GAP, box.left - GAP - size.w].filter((bx) => bx >= minX && bx <= maxX).map((bx) => ({ x: bx, y: side })),
    ...(ptr ? [at.y - GAP - size.h, at.y + GAP].filter(inside).map((y) => ({ x, y })) : []),
    { x, y: minY }, { x: centred, y: minY }, { x, y: maxY }, { x: centred, y: maxY },
  ];
  const covers = (p) => avoid.some((a) => p.x < a.right && p.x + size.w > a.left && p.y < a.bottom && p.y + size.h > a.top);
  return spots.find((p) => !covers(p)) ?? spots[0];
}

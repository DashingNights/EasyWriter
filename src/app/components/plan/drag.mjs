// Drop target of a Board card drag (Gantt plan §6.3); drag.js runs the pointer events and auto-scrolls the column strip
// with edgeSpeed (whiteboard.js). Pure, no imports. Rects are client px {left, top, right, bottom}.

/** Where cards dropped at (x, y) go: {column, beforeId} = the column under x (its whole height counts, so a drop below the
 * last card lands at the end) and the first of its cards whose middle is below y (null: the end); null over no column.
 * `cards` = [{id, column, rect}] without the dragged ones; `columns` = [{id, rect}] (id null = "No status"). */
export function dropTarget(cards, columns, x, y) {
  const col = columns.find((c) => x >= c.rect.left && x <= c.rect.right);
  if (!col) return null;
  const below = cards.filter((c) => c.column === col.id && (c.rect.top + c.rect.bottom) / 2 > y).sort((a, b) => a.rect.top - b.rect.top);
  return { column: col.id, beforeId: below[0]?.id ?? null };
}

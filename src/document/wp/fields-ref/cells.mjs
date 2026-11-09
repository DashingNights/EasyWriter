// Table cells for the = field (the `cells` provider, docs/plans/word/briefs/fields-ref.md): a table as a grid of rows and
// columns, a merged cell in every slot it covers as one object (so it counts once), each cell's text with field results in
// it (a formula's own result counts in B:B, as in Word). Pure.
import { bookmarkNamed, textOf } from './bookmarks.mjs';

const CELL = new Set(['tableCell', 'tableHeader']);

/** The grid of table node `table` at `pos` in `doc` → {grid: {text, pos}[][], cells: [{cell, r, c}]}. */
export function gridOf(doc, table, pos) {
  const grid = [];
  const cells = [];
  let r = 0;
  table.forEach((row, rowOffset) => {
    grid[r] ??= [];
    let c = 0;
    row.forEach((cellNode, cellOffset) => {
      if (!CELL.has(cellNode.type.name)) return;
      while (grid[r][c]) c++;
      const at = pos + 1 + rowOffset + 1 + cellOffset;
      const cell = { text: textOf(doc, at + 1, at + cellNode.nodeSize - 1), pos: at, size: cellNode.nodeSize };
      const span = cellNode.attrs.colspan ?? 1;
      const down = cellNode.attrs.rowspan ?? 1;
      for (let dr = 0; dr < down; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < span; dc++) grid[r + dr][c + dc] = cell;
      }
      cells.push({ cell, r, c });
      c += span;
    });
    r++;
  });
  return { grid: grid.map((row) => [...row]), cells };
}

// The innermost table holding position `pos` of `doc` → {node, pos} or null.
function tableAt(doc, pos) {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === 'table') return { node: $p.node(d), pos: $p.before(d) };
  return null;
}

/** The table the = field at `pos` reads → {grid, here: {r, c}} or null outside a table; with `bookmark`, the table holding that
 * bookmark (here null), or null when it is not defined or not in a table. */
export function cellsAt(doc, pos, bookmark = null) {
  if (bookmark) {
    const b = bookmarkNamed(doc, bookmark);
    const t = b && tableAt(doc, b.from);
    return t ? { grid: gridOf(doc, t.node, t.pos).grid, here: null } : null;
  }
  const t = tableAt(doc, pos);
  if (!t) return null;
  const { grid, cells } = gridOf(doc, t.node, t.pos);
  const hit = cells.find(({ cell }) => cell.pos < pos && pos < cell.pos + cell.size);
  return { grid, here: hit ? { r: hit.r, c: hit.c } : null };
}

/** What the Formula dialog proposes in the cell at `pos`: =SUM(ABOVE) when the cell above holds a number, else =SUM(LEFT) when
 * the cell to the left does, else = (Word's rule). */
export function proposedFormula(doc, pos) {
  const t = cellsAt(doc, pos);
  if (!t?.here) return '=';
  const num = (cell) => cell && /^[-+($€£¥]*[0-9.,]+\)?%?$/.test(cell.text.trim());
  const { grid, here: { r, c } } = t;
  if (num(grid[r - 1]?.[c])) return '=SUM(ABOVE)';
  if (num(grid[r]?.[c - 1])) return '=SUM(LEFT)';
  return '=';
}

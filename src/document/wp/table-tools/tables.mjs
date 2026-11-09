// Table tools' pure logic (docs/plans/word/plan.md §3 table-tools): Convert Text to Table's split, Insert Table's limits, the cell
// moves of Alt+Home, End, PageUp and PageDown, Alt+Shift+Up and Down's row order, and Draw Table and Eraser on a grid model.
// No DOM and no ProseMirror: ops.js turns tables into the model and back, and Node tests load this file.
//
// The model of a table: {cols: px widths, rows: px heights, cells: [{r, c, rs, cs, src}]}, cells in reading order. `src` lists
// the indexes of the original cells whose content a cell holds: a split's new half holds none, a merge holds both halves'.
// An optional `rowSrc` names the original row each row takes its attributes from (a row a split adds copies its neighbour's).

// ---------- Convert Text to Table ----------
const SEPARATORS = { tabs: '\t', commas: ',' };

/** The character `sep` ('tabs' | 'commas' | 'other' | 'paragraphs') splits at; `other` is the Other box's text. → '' for paragraphs. */
export const sepChar = (sep, other = '-') => (sep === 'other' ? (other || '-')[0] : SEPARATORS[sep] ?? '');

/** The fields of paragraph `text` split at `sep` → [[from, to]] offsets into `text` (one field for paragraphs). */
export function splitRanges(text, sep, other) {
  const ch = sepChar(sep, other);
  if (!ch) return [[0, text.length]];
  const out = [];
  let from = 0;
  for (let i = text.indexOf(ch); i >= 0; i = text.indexOf(ch, from)) {
    out.push([from, i]);
    from = i + 1;
  }
  out.push([from, text.length]);
  return out;
}

/** Word's preselected separator for paragraphs `texts`: Tabs when one holds a tab, else Paragraphs (as the probe shows). */
export const detectSep = (texts) => (texts.some((s) => s.includes('\t')) ? 'tabs' : 'paragraphs');

/** The Number of columns Word proposes: the largest field count for `sep` (1 for paragraphs). */
export const colsFor = (texts, sep, other) => (sep === 'paragraphs' ? 1 : Math.max(1, ...texts.map((s) => splitRanges(s, sep, other).length)));

/** The table cells, as [paragraph index, from, to] or null for an empty cell, row by row: each paragraph is a row (a longer one
 * wraps onto the next rows), or with Paragraphs each paragraph is a cell, `cols` to a row. */
export function cellRanges(texts, sep, { other, cols } = {}) {
  const n = Math.max(1, cols ?? colsFor(texts, sep, other));
  const rows = [];
  const chunk = (cells) => {
    for (let i = 0; i < cells.length; i += n) rows.push([...cells.slice(i, i + n), ...Array(Math.max(0, i + n - cells.length)).fill(null)]);
  };
  if (sep === 'paragraphs') chunk(texts.map((s, i) => [i, 0, s.length]));
  else texts.forEach((s, i) => chunk(splitRanges(s, sep, other).map(([a, b]) => [i, a, b])));
  return rows;
}

/** The cell texts of paragraphs `texts` split at `sep` → rows of strings, short rows padded with ''. */
export const textToRows = (texts, sep, opts) => cellRanges(texts, sep, opts).map((row) => row.map((x) => (x ? texts[x[0]].slice(x[1], x[2]) : '')));

/** The Number of rows Convert Text to Table shows for `cols` columns. */
export const rowsFor = (texts, sep, other, cols) => cellRanges(texts, sep, { other, cols }).length;

// ---------- Insert Table ----------
export const MAX_COLS = 63;
export const MAX_ROWS = 32767;

/** Why `cols` and `rows` cannot make a table (Word's limits 1 to 63 and 1 to 32767), in our words, or null when they can. */
export function validateInsert({ cols, rows }) {
  if (!Number.isInteger(cols) || cols < 1 || cols > MAX_COLS) return `A table has between 1 and ${MAX_COLS} columns.`;
  if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) return `A table has between 1 and ${MAX_ROWS} rows.`;
  return null;
}

// ---------- Cell moves ----------
/** The cell `where` ('rowStart' | 'rowEnd' | 'colStart' | 'colEnd') of the row or column through grid cell (`r`, `c`), where `grid`
 * is rows of cell ids (a merged cell repeats its id) → that cell's top-left {r, c}. */
export function cellNav(grid, r, c, where) {
  const pick = { rowStart: [r, 0], rowEnd: [r, grid[r].length - 1], colStart: [0, c], colEnd: [grid.length - 1, c] }[where];
  if (!pick) return null;
  const id = grid[pick[0]][pick[1]];
  for (let y = 0; y < grid.length; y++) for (let x = 0; x < grid[y].length; x++) if (grid[y][x] === id) return { r: y, c: x };
  return null;
}

/** The new row order after moving rows `from`..`to` one place `dir` ('up' | 'down') past their neighbour in a table of `n` rows
 * → [old row index per new place], or null at the table's edge or when `grid` has a cell spanning rows the move touches. */
export function moveRows(n, from, to, dir, grid = null) {
  const up = dir === 'up';
  if (from < 0 || to >= n || from > to || (up ? from === 0 : to === n - 1)) return null;
  const lo = up ? from - 1 : from;
  const hi = up ? to : to + 1;
  if (grid) {
    // A cell spanning rows inside the moved range, or crossing its ends, would be cut apart.
    for (let y = lo; y <= hi + 1 && y < grid.length; y++) {
      if (y === 0) continue;
      if (grid[y].some((id, x) => id === grid[y - 1][x])) return null;
    }
  }
  const order = [...Array(n).keys()];
  const block = order.slice(from, to + 1);
  order.splice(from, block.length);
  order.splice(up ? from - 1 : from + 1, 0, ...block);
  return order;
}

// ---------- The model and its geometry ----------
const sum = (a, from = 0, to = a.length) => a.slice(from, to).reduce((s, v) => s + v, 0);

/** The grid of model `m`: rows of indexes into m.cells (a spanning cell repeats). */
export function gridOf(m) {
  const g = m.rows.map(() => Array(m.cols.length).fill(-1));
  m.cells.forEach((cell, i) => {
    for (let y = cell.r; y < cell.r + cell.rs; y++) for (let x = cell.c; x < cell.c + cell.cs; x++) if (g[y]) g[y][x] = i;
  });
  return g;
}

/** The box of each cell of model `m` in its px: [{id: index, left, top, right, bottom}]. */
export const rectsOf = (m) => m.cells.map((cell, id) => ({ id, left: sum(m.cols, 0, cell.c), right: sum(m.cols, 0, cell.c + cell.cs),
  top: sum(m.rows, 0, cell.r), bottom: sum(m.rows, 0, cell.r + cell.rs) }));

const SIDES = [['left', 'v'], ['right', 'v'], ['top', 'h'], ['bottom', 'h']];
const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

/** The cell beside rect `a` across its `side` that touches point (`x`, `y`) along that edge → its id or null. */
function across(rects, a, side, x, y) {
  const at = a[side];
  const v = side === 'left' || side === 'right';
  const b = rects.find((o) => o !== a && Math.abs(o[OPPOSITE[side]] - at) <= 1 && (v ? y >= o.top && y <= o.bottom : x >= o.left && x <= o.right));
  return b ? b.id : null;
}

/** The cell edge nearest point (`x`, `y`) within `tol` px among `rects` ([{id, left, top, right, bottom}]) → {dir: 'v' | 'h', a: {id,
 * side}, b: {id, side} | null (an outer edge), at} or null. An inner edge names the cell before it (left or above) as a. */
export function edgeAt(rects, x, y, tol = 4) {
  let best = null;
  for (const r of rects) {
    for (const [side, dir] of SIDES) {
      const v = dir === 'v';
      const d = Math.abs((v ? x : y) - r[side]);
      const along = v ? y >= r.top - tol && y <= r.bottom + tol : x >= r.left - tol && x <= r.right + tol;
      if (d > tol || !along || (best && d >= best.d)) continue;
      best = { d, r, side, dir };
    }
  }
  if (!best) return null;
  const { r, side, dir } = best;
  const other = across(rects, r, side, x, y);
  const first = side === 'left' || side === 'top';
  const a = other != null && first ? { id: other, side: OPPOSITE[side] } : { id: r.id, side };
  const b = other == null ? null : first ? { id: r.id, side } : { id: other, side: OPPOSITE[side] };
  return { dir, a, b, at: r[side] };
}

const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

// ---------- Draw Table and Eraser ----------
/** Splits model `m`'s cell `i` along `dir` ('v': a vertical line, new columns; 'h': rows) at offset `at` px from the table's
 * origin; at a boundary the cell already spans, no column or row is added. → a new model. */
export function splitCell(m, i, dir, at) {
  const v = dir === 'v';
  const [P, S, sizes] = v ? ['c', 'cs', 'cols'] : ['r', 'rs', 'rows'];
  const cell = m.cells[i];
  const edges = sizes === 'cols' ? m.cols : m.rows;
  let k = cell[P] + 1; // the boundary at the split
  const next = { ...m, [sizes]: [...edges], cells: m.cells.map((x) => ({ ...x })) };
  for (; k < cell[P] + cell[S] && Math.abs(sum(edges, 0, k) - at) > 0.5; k++);
  if (k >= cell[P] + cell[S]) {
    // Inside one track: that track splits in two and every other cell crossing it spans one more.
    const j = edges.findIndex((_, t) => sum(edges, 0, t + 1) > at);
    if (j < cell[P] || j >= cell[P] + cell[S]) return m;
    const start = sum(edges, 0, j);
    next[sizes].splice(j, 1, at - start, edges[j] - (at - start));
    if (!v && m.rowSrc) next.rowSrc = [...m.rowSrc.slice(0, j + 1), ...m.rowSrc.slice(j)];
    next.cells.forEach((x, n) => {
      if (n === i) return;
      if (x[P] <= j && j < x[P] + x[S]) x[S] += 1;
      else if (x[P] > j) x[P] += 1;
    });
    next.cells[i][S] += 1;
    k = j + 1;
  }
  const own = next.cells[i];
  const half = { ...own, [P]: k, [S]: own[P] + own[S] - k, src: [] };
  own[S] = k - own[P];
  next.cells.splice(i + 1, 0, half);
  next.cells.sort((a, b) => a.r - b.r || a.c - b.c);
  return next;
}

/** Joins model `m`'s cells `a` and `b` across their shared edge, a's content first → a new model, or null when the two do not
 * line up (Word refuses that merge too). Tracks no cell starts at any more are joined. */
export function mergeCells(m, a, b) {
  const [x, y] = [m.cells[a], m.cells[b]];
  const row = x.r === y.r && x.rs === y.rs && (x.c + x.cs === y.c || y.c + y.cs === x.c);
  const col = x.c === y.c && x.cs === y.cs && (x.r + x.rs === y.r || y.r + y.rs === x.r);
  if (!row && !col) return null;
  const [first, second] = row ? (x.c < y.c ? [x, y] : [y, x]) : x.r < y.r ? [x, y] : [y, x];
  const merged = { ...first, rs: row ? first.rs : first.rs + second.rs, cs: row ? first.cs + second.cs : first.cs, src: [...x.src, ...y.src] };
  const cells = m.cells.filter((c) => c !== x && c !== y).concat(merged).sort((p, q) => p.r - q.r || p.c - q.c);
  return normalize({ ...m, cells });
}

/** Joins the columns and rows of `m` that no cell starts in (left over after a merge) → a new model. */
export function normalize(m) {
  const out = { ...m, cols: [...m.cols], rows: [...m.rows], cells: m.cells.map((c) => ({ ...c })), ...(m.rowSrc && { rowSrc: [...m.rowSrc] }) };
  for (const [P, S, sizes] of [['c', 'cs', 'cols'], ['r', 'rs', 'rows']]) {
    for (let k = out[sizes].length - 1; k >= 1; k--) {
      if (out.cells.some((c) => c[P] === k)) continue;
      out[sizes][k - 1] += out[sizes][k];
      out[sizes].splice(k, 1);
      if (sizes === 'rows') out.rowSrc?.splice(k, 1);
      for (const c of out.cells) {
        if (c[P] < k && k < c[P] + c[S]) c[S] -= 1;
        else if (c[P] > k) c[P] -= 1;
      }
    }
  }
  return out;
}

// Draw Table: a line covering at least this share of the cell it crosses counts; a diagonal starts this near a corner.
const COVER = 0.5;
const CORNER = 0.3;

/** What Draw Table does with `line` ({x1, y1, x2, y2} in the model's px) on model `m`; `paint` (Border Painter) only sets borders.
 * → {op: {kind: 'split', cell, dir, at} | {kind: 'border', edge} | {kind: 'diagonal', cell, which: 'tl2br' | 'tr2bl'}, model} or null.
 * ponytail: lines snap to the nearest cell edge or midline and a free line elsewhere is not drawn; follow the pointer exactly
 * (Word's free lines) if snapping gets in the way. */
export function drawOp(m, line, { paint = false } = {}) {
  const rects = rectsOf(m);
  const mx = (line.x1 + line.x2) / 2;
  const my = (line.y1 + line.y2) / 2;
  const dx = Math.abs(line.x2 - line.x1);
  const dy = Math.abs(line.y2 - line.y1);
  if (Math.max(dx, dy) < 3) return null;
  const v = dy >= dx;
  // The cell under the line's middle; Border Painter also takes the nearest cell when the line runs just outside the table.
  const dist = (x) => Math.hypot(Math.max(x.left - mx, 0, mx - x.right), Math.max(x.top - my, 0, my - x.bottom));
  const r = rects.find((x) => inside(x, mx, my)) ?? (paint ? rects.reduce((a, b) => (dist(b) < dist(a) ? b : a), rects[0]) : null);
  if (!r) return null;
  const edgeOn = (spot) => edgeAt(rects, v ? spot : Math.min(Math.max(mx, r.left), r.right), v ? Math.min(Math.max(my, r.top), r.bottom) : spot, 1);
  if (paint) {
    const [lo, hi] = v ? [r.left, r.right] : [r.top, r.bottom];
    const at = v ? mx : my;
    const edge = edgeOn(Math.abs(at - lo) <= Math.abs(at - hi) ? lo : hi);
    return edge ? { op: { kind: 'border', edge }, model: m } : null;
  }
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  // A corner-to-corner line inside one cell: its diagonal border.
  if (dx >= w * COVER && dy >= h * COVER) {
    const near = (px, py) => Math.abs(line.x1 - px) <= w * CORNER && Math.abs(line.y1 - py) <= h * CORNER;
    const corner = [[r.left, r.top], [r.right, r.bottom], [r.right, r.top], [r.left, r.bottom]].findIndex(([px, py]) => near(px, py));
    if (corner < 0) return null;
    return { op: { kind: 'diagonal', cell: r.id, which: corner < 2 ? 'tl2br' : 'tr2bl' }, model: m };
  }
  if ((v ? dy : dx) < (v ? h : w) * COVER) return null;
  // Snap: the cell's own edges (a border), the boundaries it spans and its midline (a split).
  const cell = m.cells[r.id];
  const tracks = v ? m.cols : m.rows;
  const [P, S, lo, hi] = v ? ['c', 'cs', r.left, r.right] : ['r', 'rs', r.top, r.bottom];
  const inner = [];
  for (let k = cell[P] + 1; k < cell[P] + cell[S]; k++) inner.push(sum(tracks, 0, k));
  const at = v ? mx : my;
  const spots = [[lo, 'edge'], [hi, 'edge'], [(lo + hi) / 2, 'split'], ...inner.map((p) => [p, 'split'])];
  const [spot, kind] = spots.reduce((best, s) => (Math.abs(s[0] - at) < Math.abs(best[0] - at) ? s : best));
  if (kind === 'edge') {
    const edge = edgeOn(spot);
    return edge ? { op: { kind: 'border', edge }, model: m } : null;
  }
  return { op: { kind: 'split', cell: r.id, dir: v ? 'v' : 'h', at: spot }, model: splitCell(m, r.id, v ? 'v' : 'h', spot) };
}

/** What Eraser does at point (`x`, `y`) on model `m` within `tol` px of an edge: an inner edge merges its two cells, an outer one
 * loses its border. → {op: {kind: 'merge', a, b} | {kind: 'clear', edge}, model} or null. */
export function eraseOp(m, x, y, tol = 4) {
  const edge = edgeAt(rectsOf(m), x, y, tol);
  if (!edge) return null;
  if (!edge.b) return { op: { kind: 'clear', edge }, model: m };
  const model = mergeCells(m, edge.a.id, edge.b.id);
  return model ? { op: { kind: 'merge', a: edge.a.id, b: edge.b.id }, model } : null;
}

// ---------- Column border drag ----------
/** Column widths after dragging the border right of column `col` by `d` px with modifiers: 'shift' resizes that column only (the
 * table width changes), 'ctrl' shares the change among the columns to its right in proportion, 'ctrlShift' makes them equal; the
 * table width stays in both. Columns stay at least `min` px. */
export function borderDrag(widths, col, d, mode, min = 20) {
  const out = [...widths];
  const right = out.slice(col + 1);
  const room = sum(right) - min * right.length;
  const delta = mode === 'shift' || !right.length ? Math.max(d, min - out[col]) : Math.min(Math.max(d, min - out[col]), room);
  out[col] += delta;
  if (mode === 'shift' || !right.length) return out.map(Math.round);
  const total = sum(right) - delta;
  if (mode === 'ctrlShift') right.forEach((_, i) => { out[col + 1 + i] = total / right.length; });
  else {
    const was = sum(right);
    right.forEach((w, i) => { out[col + 1 + i] = was ? (w / was) * total : total / right.length; });
  }
  return out.map(Math.round);
}

// Table Layout's pure model (docs/plans/word/briefs/table-layout.md): the table grid with its spans, Split Cells, Insert and
// Delete Cells, Distribute, Sort and Convert to Text, on node JSON (a table's toJSON()), so node tests load it without an editor.
// index.js turns the result back into a node and replaces the table in one transaction (one undo step).

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const spanOf = (cell) => ({ cs: cell.attrs?.colspan ?? 1, rs: cell.attrs?.rowspan ?? 1 });

/** A new row's attributes from neighbour `row`: its height and options, but not its tracked change or header flag. */
const freshRow = (row) => ({ ...clone(row), attrs: { ...row?.attrs, rev: null, header: false } });

/** An empty cell of `type` spanning one column of `width` px (null = no set width). */
export const emptyCell = (width = null, type = 'tableCell') => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: width == null ? null : [width] }, content: [{ type: 'paragraph' }] });

/** The grid of `table` (JSON) → {rows, cols, cells: [{row, index, y, x, cs, rs}], map: map[y][x] = index into cells}. */
export function gridOf(table) {
  const rowsJ = table.content ?? [];
  const map = rowsJ.map(() => []);
  const cells = [];
  rowsJ.forEach((row, y) => {
    let x = 0;
    (row.content ?? []).forEach((cell, index) => {
      while (map[y][x] != null) x++;
      const { cs, rs } = spanOf(cell);
      const i = cells.push({ row: y, index, y, x, cs, rs }) - 1;
      for (let dy = 0; dy < rs && y + dy < rowsJ.length; dy++) for (let dx = 0; dx < cs; dx++) map[y + dy][x + dx] = i;
      x += cs;
    });
  });
  const cols = Math.max(0, ...map.map((r) => r.length));
  return { rows: rowsJ.length, cols, cells, map };
}

/** Whether `table` has a merged cell (a span over one). */
export const hasSpans = (table) => gridOf(table).cells.some((c) => c.cs > 1 || c.rs > 1);

/** The column widths of `table` in px from its cells' colwidth (null where none says). */
export function widthsOf(table) {
  const g = gridOf(table);
  const out = Array(g.cols).fill(null);
  for (const c of g.cells) {
    const cw = table.content[c.row].content[c.index].attrs?.colwidth;
    for (let i = 0; i < c.cs; i++) if (out[c.x + i] == null && cw?.[i]) out[c.x + i] = cw[i];
  }
  return out;
}

/** `table` with every cell's colwidth set from `widths` (px per column; null clears). */
export function setWidths(table, widths) {
  const t = clone(table);
  const g = gridOf(t);
  for (const c of g.cells) {
    const ws = widths.slice(c.x, c.x + c.cs);
    t.content[c.row].content[c.index].attrs.colwidth = ws.every((w) => w != null) ? ws : null;
  }
  return t;
}

/** Splits `parts` units into `n` near-equal integer spans, the extra on the first ones. */
const shares = (parts, n) => Array.from({ length: n }, (_, i) => Math.floor(parts / n) + (i < parts % n ? 1 : 0));

/** `table` with the cell whose top left is grid (`y`, `x`) split into `cols` columns by `rows` rows. Within the cell's own spans
 * the pieces share them; past them new grid columns (or rows) are added after its last one, and the cells of other rows (or
 * columns) crossing that line span the new ones too. The content stays in the first piece. */
export function splitCell(table, y, x, cols, rows) {
  let t = clone(table);
  let g = gridOf(t);
  const at = g.cells[g.map[y]?.[x]];
  if (!at || at.y !== y || at.x !== x) return null;
  const cell = t.content[at.row].content[at.index];
  const widths = widthsOf(t);
  // Columns: add (cols - cs) grid columns after the cell's last column, splitting that column's width.
  if (cols > at.cs) {
    const add = cols - at.cs;
    const last = x + at.cs - 1;
    const w = widths[last];
    const part = w == null ? null : w / (add + 1);
    for (const c of g.cells) {
      if (c === at || c.x > last || c.x + c.cs - 1 < last) continue;
      const n = t.content[c.row].content[c.index];
      n.attrs.colspan = c.cs + add;
      const cw = n.attrs.colwidth;
      if (cw) n.attrs.colwidth = [...cw.slice(0, last - c.x), ...Array(add + 1).fill(part ?? cw[last - c.x] / (add + 1))];
    }
    widths.splice(last, 1, ...Array(add + 1).fill(part));
  }
  // Rows: add (rows - rs) table rows after the cell's last row; the other cells crossing that row span them.
  const addRows = Math.max(0, rows - at.rs);
  if (addRows) {
    const last = y + at.rs - 1;
    for (const c of g.cells) {
      if (c === at || c.y > last || c.y + c.rs - 1 < last) continue;
      t.content[c.row].content[c.index].attrs.rowspan = c.rs + addRows;
    }
  }
  // The pieces: a cols x rows block over the cell's area (now max(cols, cs) columns by max(rows, rs) rows).
  const colSpans = cols > at.cs ? Array(cols).fill(1) : shares(at.cs, cols);
  const rowSpans = rows > at.rs ? Array(rows).fill(1) : shares(at.rs, rows);
  const xs = colSpans.map((_, i) => x + colSpans.slice(0, i).reduce((a, b) => a + b, 0));
  const piece = (j, i, first) => {
    const p = first ? clone(cell) : { type: cell.type, attrs: clone(cell.attrs), content: [{ type: 'paragraph' }] };
    p.attrs.colspan = colSpans[i];
    p.attrs.rowspan = rowSpans[j];
    const ws = widths.slice(xs[i], xs[i] + colSpans[i]);
    p.attrs.colwidth = ws.every((w) => w != null) ? ws : null;
    return p;
  };
  const rowOf = (j) => y + rowSpans.slice(0, j).reduce((a, b) => a + b, 0);
  // Row y: the cell becomes the first row of pieces, in place.
  t.content[at.row].content.splice(at.index, 1, ...colSpans.map((_, i) => piece(0, i, i === 0)));
  // Later piece rows: inserted into existing rows (inside the cell's spans) or into new rows.
  const newRows = Array.from({ length: addRows }, () => ({ ...freshRow(t.content[y + at.rs - 1]), content: [] }));
  if (newRows.length) t.content.splice(y + at.rs, 0, ...newRows);
  g = gridOf(table); // the original grid places pieces among the old cells of rows inside the span
  for (let j = 1; j < rowSpans.length; j++) {
    const ry = rowOf(j);
    const pieces = colSpans.map((_, i) => piece(j, i, false));
    if (ry < y + at.rs) {
      // An old row inside the cell's span: before the first cell of that row that starts right of the cell.
      const after = g.cells.filter((c) => c.y === ry && c.x > x).map((c) => c.index);
      const idx = after.length ? Math.min(...after) : t.content[ry].content.length;
      t.content[ry].content.splice(idx, 0, ...pieces);
    } else {
      t.content[ry].content.push(...pieces);
    }
  }
  return t;
}

/** The cells of a span-free `table` as a matrix [y][x] of cell JSON. */
const matrixOf = (table) => table.content.map((r) => r.content.map(clone));
const rebuild = (table, m) => ({ ...clone(table), content: m.map((cells, y) => ({ ...(table.content[y] ? clone(table.content[y]) : freshRow(table.content.at(-1))), content: cells })) });
const isEmptyCell = (c) => (c.content ?? []).every((b) => b.type === 'paragraph' && !(b.content ?? []).length);
const rect = (r) => ({ top: r.top, left: r.left, h: r.bottom - r.top, w: r.right - r.left });

/** `table` (span free) after Insert Cells on grid rectangle `r` ({top, left, bottom, right}, ends exclusive) with `mode`:
 * 'right' shifts the cells right (the other rows get empty cells at their end, since rows stay rectangular), 'down' shifts the
 * columns' cells down and adds rows at the end, 'row' inserts whole rows above, 'column' whole columns to the left. */
export function insertCells(table, r, mode) {
  const { top, left, h, w } = rect(r);
  const m = matrixOf(table);
  const widths = widthsOf(table);
  const cols = m[0]?.length ?? 0;
  if (mode === 'right' || mode === 'column') {
    for (let y = 0; y < m.length; y++) {
      const fresh = Array.from({ length: w }, (_, i) => emptyCell(widths[left + i]));
      if (mode === 'column' || (y >= top && y < top + h)) m[y].splice(left, 0, ...fresh);
      else m[y].push(...fresh);
    }
  } else if (mode === 'down') {
    for (let i = 0; i < h; i++) m.push(Array.from({ length: cols }, (_, x) => emptyCell(widths[x])));
    for (let x = left; x < left + w; x++) {
      for (let y = m.length - 1; y >= top + h; y--) m[y][x] = m[y - h][x];
      for (let y = top; y < top + h; y++) m[y][x] = emptyCell(widths[x]);
    }
  } else if (mode === 'row') {
    const t = clone(table);
    t.content.splice(top, 0, ...Array.from({ length: h }, () => ({ ...freshRow(table.content[top]), content: Array.from({ length: cols }, (_, x) => emptyCell(widths[x])) })));
    return t;
  }
  return rebuild(table, m);
}

/** `table` (span free) after Delete Cells on grid rectangle `r` with `mode`: 'left' removes the cells and pads each row's end with
 * empty cells, 'up' moves the columns' cells up and drops trailing rows the shift left empty, 'row' and 'column' remove them whole. */
export function deleteCells(table, r, mode) {
  const { top, left, h, w } = rect(r);
  let m = matrixOf(table);
  const widths = widthsOf(table);
  if (mode === 'left') {
    for (let y = top; y < top + h; y++) {
      m[y].splice(left, w);
      m[y].push(...Array.from({ length: w }, (_, i) => emptyCell(widths[widths.length - w + i])));
    }
  } else if (mode === 'up') {
    for (let x = left; x < left + w; x++) {
      for (let y = top; y < m.length - h; y++) m[y][x] = m[y + h][x];
      for (let y = m.length - h; y < m.length; y++) m[y][x] = emptyCell(widths[x]);
    }
    // Word keeps the rows; we drop the padded rows at the end that the shift emptied, so Delete Cells undoes Insert Cells down.
    // A row that was empty before stays.
    const emptied = (y) => m[y].every(isEmptyCell) && !table.content[y].content.every(isEmptyCell);
    for (let n = h; n > 0 && m.length > top + 1 && emptied(m.length - 1); n--) m.pop();
  } else if (mode === 'row') {
    const content = table.content.filter((_, y) => y < top || y >= top + h);
    return content.length ? { ...clone(table), content: clone(content) } : null;
  } else if (mode === 'column') {
    m = m.map((row) => row.filter((_, x) => x < left || x >= left + w));
    if (!m[0]?.length) return null;
  }
  return rebuild(table, m);
}

/** `values` all set to their average (Distribute Rows and Columns: the total stays). */
export function distribute(values) {
  const avg = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return values.map(() => avg);
}

// ---------- sorting ----------
const NUMBER = /[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?/g;

/** The first number in `text` → a number or null. */
export function numberOf(text) {
  for (const m of String(text).matchAll(NUMBER)) if (/\d/.test(m[0])) return Number(m[0].replace(/,/g, ''));
  return null;
}

/** The date in `text` → its time or null (what Date.parse reads, and d/m/y or d.m.y). */
export function dateOf(text) {
  const s = String(text).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return Date.UTC(y, Number(m[2]) - 1, Number(m[1]));
}

/** The order of `items` (arrays of field texts) by `keys` ([{field, type: 'text'|'number'|'date', desc}]) → indices. Text compares
 * with Intl.Collator in `lang` (case sensitive only with `caseSensitive`), Number by the first number, Date by the parsed date;
 * keys without a number or date sort first ascending. Stable; with `header` the first item stays first. */
export function sortRows(items, keys, { header = false, caseSensitive = false, lang } = {}) {
  const coll = new Intl.Collator(lang || undefined, caseSensitive ? { sensitivity: 'variant', caseFirst: 'upper', numeric: false } : { sensitivity: 'accent' });
  const idx = items.map((_, i) => i);
  const head = header ? idx.splice(0, 1) : [];
  const cmp = (a, b) => {
    for (const k of keys) {
      const ta = items[a][k.field] ?? '';
      const tb = items[b][k.field] ?? '';
      let d;
      if (k.type === 'number' || k.type === 'date') {
        const f = k.type === 'number' ? numberOf : dateOf;
        const va = f(ta);
        const vb = f(tb);
        // A key without a number or date sorts first ascending.
        d = va == null || vb == null ? (vb == null) - (va == null) : va - vb;
      } else d = coll.compare(ta, tb);
      if (d) return k.desc ? -d : d;
    }
    return 0;
  };
  return [...head, ...idx.sort((a, b) => cmp(a, b) || a - b)];
}

/** The order of paragraphs `texts` by `keys` → indices, each key's field being 0 for the whole paragraph, else field n of the
 * text split at `sep` (Sort Options: '\t', ',' or another character). */
export function sortParagraphs(texts, keys, { sep = ',', ...opts } = {}) {
  const items = texts.map((t) => [t, ...String(t).split(sep).map((s) => s.trim())]);
  return sortRows(items, keys, opts);
}

// ---------- Convert to Text ----------

/** Paragraphs from `rows` (rows of cells, a cell a list of paragraphs as block JSON) with `sep`: 'para' gives each cell paragraph
 * its own paragraph; any other string joins a row's cells with a text item of it, and a cell's own paragraph breaks stay breaks,
 * as Word keeps the cell's paragraph marks. A joined paragraph keeps the type and attributes of its first source paragraph
 * → a list of paragraphs (block JSON). */
export function tableToText(rows, sep, text = (s) => ({ type: 'text', text: s })) {
  const parasOf = (cell) => (cell.length ? cell : [{ type: 'paragraph' }]);
  if (sep === 'para') return rows.flatMap((cells) => cells.flatMap(parasOf));
  return rows.flatMap((cells) => {
    const out = [];
    cells.forEach((cell, i) => parasOf(cell).forEach((p, j) => {
      if (!out.length || j) out.push({ ...clone(p), content: clone(p.content) ?? [] });
      else out.at(-1).content.push(...(i ? [text(sep)] : []), ...(clone(p.content) ?? []));
    }));
    return out;
  });
}

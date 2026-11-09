// The Document's table node view (docs/plans/word/plan.md §1.8 Tables). columnResizing builds it without the node's HTML
// attributes, so it applies them itself: the table's data attributes (data-style for the table style's rules in stylesheet.js,
// data-look for its conditional formats, and the v2 table attributes) and, on the wrapper, data-align and --table-indent, which
// document.css places the table by. Rows and cells draw their own attributes (their renderHTML runs as usual).
// Pages split a table between rows, and a row that may split between its lines (pagination.js): each row is a grid of its own
// (document.css), its columns copied from the colgroup into --cols on the wrapper, also while a column is dragged (the colgroup
// changes without a transaction). A table with a row that cannot split (layout.mjs rowSplits) taller than a page's text area
// (document.css --fit-h), which no page could hold, moves whole (data-whole). A whole table taller than that is scaled down to
// fit one page, as a picture is, since it cannot cross a page end.
// A cell that spans rows (Word's vertical merge) splits with its rows as Word splits it: it sits in its first row's grid at no
// height of its own and is drawn down to the last row it spans on that page, and each row below holds a slot of its look in the
// columns it covers (mergeSlots, a widget decoration), so the row's cells keep their grid columns and the column conditions of the
// table style (first column, last column, bands, which select by place in the row) count the slot. When the merged cell's text is
// taller than its rows, its last row grows by the rest, as Word grows it. ponytail: the rows of a merged cell that crosses a page
// end grow only by the text that does not fit them all, and the cell's text stays on the first page.
// An AutoFit table's column is never narrower than its longest word, as Word sizes it (readFloors): a preferred width or a column
// width below that widens the column instead of breaking the word.
// Word gives every cell of a row the largest top margin any of them has (the Word fixture's cell margin case): rows whose cells
// differ get it from a rule in a shared sheet (rowTops), since the rows and cells are the editor's to draw.
// Fitting reads a table's boxes and writes its attributes, and each read after a write lays the whole document out, so tables fit
// together (fitTables): every table's reads, then every table's writes, at most three layouts for any number of tables. Only a
// table that changed, resized or never fitted fits again, unless the zoom or the page's text height moved (a document of 500
// tables read every table's boxes and styles in every pagination round).
import { TableView } from '@tiptap/extension-table';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { columnResizingPluginKey, TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { edgesPt } from '../office.mjs';
import { resolvedAll } from './model/resolved.mjs';
import { tableStyleClass } from './stylesheet.js';
import { rowSplits, rowTop } from './wp/page-engine/layout.mjs';
import { floorTrack } from './wp/table-tools/autofit.mjs';

// Attributes this view or the pagination fit own on the table element; the node's rendered attributes never remove them.
const OWN = new Set(['data-whole']);

// The tables that changed or resized fit together next frame.
const waiting = new Set();
let frame = 0;
const fitSoon = (v) => {
  v.stale = true;
  waiting.add(v);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const vs = [...waiting].filter((x) => x.dom.isConnected);
    waiting.clear();
    if (vs.length) fitViews(vs, keyOf(vs[0]));
  });
};

/** Fits the tables of elements `els` (their wrappers, [data-pg-fit]) in one batch: pagination calls it before each measure. Only
 * the stale ones, or every one when the zoom or --fit-h (one style read, inherited from the text) moved since they fitted. */
export function fitTables(els) {
  const vs = els.map((el) => el.pgTable).filter(Boolean);
  if (!vs.length) return;
  // A style edit reaches no table node: the row tops follow the styles here, before the page measure.
  for (const v of vs) if (v.tops?.styles !== v.editorView?.state.doc.attrs.styles) v.rowTops(v.node);
  const key = keyOf(vs[0]);
  fitViews(vs.filter((v) => v.stale || v.fitKey !== key), key);
  // Merged cells follow the page ends, which move without the table changing: every round, reads first, then writes.
  const merged = vs.filter((v) => v.merged?.length);
  const rows = merged.map((v) => v.readRows());
  merged.forEach((v, i) => v.writeMerges(rows[i]));
}

// The cells' margins of each drawn border width as literal rules, one per width in a shared sheet: with var(--cell-bx) in the
// cells' own margins the browser could not reuse any cell's style, and restyling a document of 20,000 cells took seconds (each
// cell matches dozens of table style rules). The wrapper carries the class of its width; --cell-bx stays for the rows (document.css).
const bxRules = new Set();
let bxSheet = null;
function bxClass(bx) {
  const cls = `pg-bx-${bx.replace(/[^0-9a-z]/g, '_')}`;
  if (!bxRules.has(cls)) {
    bxRules.add(cls);
    bxSheet ??= document.head.appendChild(Object.assign(document.createElement('style'), { id: 'pg-cell-bx' }));
    // :where() keeps document.css's specificity for these rules (the margins they replace).
    const at = `.page[data-format="document"] .ProseMirror :where(.${cls}) > table:not([data-whole]) > tbody > tr >`;
    bxSheet.append(`${at} td, ${at} th, ${at} .pg-vm { margin-right: -${bx}; }
${at} td:first-child, ${at} th:first-child, ${at} .pg-vm:first-child { margin-left: -${bx}; }
`);
  }
  return cls;
}

// Rules per table in shared sheets, keyed by a table id on its wrapper: the row-wide top margins (a padding-top per row whose
// cells' top margins differ, data-row-tops; !important beats a cell's own margins, drawn inline) and the merged cells (data-merges:
// the cells, and their heights and slots' look the fit measures).
function sheetOf(name) {
  const rules = new Map(); // table id → its rules
  let sheet = null;
  return (id, text) => {
    if ((rules.get(id) ?? '') === text) return;
    if (text) rules.set(id, text);
    else rules.delete(id);
    sheet ??= document.head.appendChild(Object.assign(document.createElement('style'), { id: name }));
    sheet.textContent = [...rules.values()].join('\n');
  };
}
const writeTops = sheetOf('pg-row-tops');
const mergeAt = (id, r) => `.page[data-format="document"] .ProseMirror .tableWrapper[data-merges="${id}"] > table:not([data-whole]) > tbody > tr:nth-child(${r + 1})`;
const writePlaces = sheetOf('pg-merge-places');
const writeMerges = sheetOf('pg-merge-heights');
let tableIds = 0;

/** The grid's column widths in px over every row (null where no cell gives one): tiptap's colgroup reads the first row only. */
function gridWidths(node, map) {
  const w = Array(map.width).fill(null);
  map.map.forEach((pos, i) => {
    const col = i % map.width;
    w[col] ??= node.nodeAt(pos)?.attrs.colwidth?.[col - map.colCount(pos)] || null;
  });
  return w;
}

/** The slots of table `node` at `pos`: a widget in each row where a cell from a row above covers columns, before the row's next
 * cell (or at its end), spanning those columns. data-vm names the merged cell (its row and its index among that row's cells). */
function slotsOf(node, pos) {
  let spans = false;
  node.forEach((row) => row.forEach((c) => { spans ||= (c.attrs.rowspan ?? 1) > 1; }));
  if (!spans) return [];
  const map = TableMap.get(node);
  const rowOffs = [];
  node.forEach((_, off) => rowOffs.push(off));
  const indexIn = (r, p) => {
    let k = -1;
    node.child(r).forEach((_, off, i) => { if (rowOffs[r] + 1 + off === p) k = i; });
    return k;
  };
  const out = [];
  node.forEach((row, rowOff, r) => {
    for (let c = 0; c < map.width;) {
      const p = map.map[r * map.width + c];
      if (!p) { // a row short of the grid (Word's w:gridAfter): no cell there
        c++;
        continue;
      }
      const rect = map.findCell(p);
      if (rect.top < r) {
        let at = pos + 1 + rowOff + row.nodeSize - 1; // the row's end
        for (let x = rect.right; x < map.width; x++) {
          const q = map.map[r * map.width + x];
          if (q && map.findCell(q).top === r) {
            at = pos + 1 + q;
            break;
          }
        }
        const id = `${rect.top}-${indexIn(rect.top, p)}`;
        const span = rect.right - c;
        const last = r === rect.bottom - 1;
        out.push(Decoration.widget(at, () => {
          const el = document.createElement('span');
          el.className = 'pg-vm';
          el.dataset.vm = id;
          if (last) el.dataset.vmLast = '';
          el.style.gridColumn = `span ${span}`;
          return el;
        }, { side: -1, ignoreSelection: true, key: `vm-${id}-${span}-${last}` }));
      }
      c = rect.right;
    }
  });
  return out;
}

/** The merged cells' slots (slotsOf) of every table, kept up to date for the tables a transaction touches. */
export const mergeSlots = new Plugin({
  key: new PluginKey('tableMergeSlots'),
  state: {
    init: (_, state) => DecorationSet.create(state.doc, [...tablesIn(state.doc, [[0, state.doc.content.size]])].flatMap(([p, n]) => slotsOf(n, p))),
    apply(tr, set) {
      if (!tr.docChanged) return set;
      const ranges = [];
      tr.mapping.maps.forEach((m, i) => m.forEach((_a, _b, from, to) => {
        const rest = tr.mapping.slice(i + 1);
        ranges.push([rest.map(from, -1), rest.map(to, 1)]);
      }));
      const found = tablesIn(tr.doc, ranges);
      let next = set.map(tr.mapping, tr.doc);
      for (const [p, n] of found) next = next.remove(next.find(p, p + n.nodeSize));
      return next.add(tr.doc, [...found].flatMap(([p, n]) => slotsOf(n, p)));
    },
  },
  props: { decorations(state) { return this.getState(state); } },
});

/** The tables `ranges` ([from, to] in `doc`) touch, each whole with the tables inside it: a range inside a table takes its
 * outermost table. → Map pos → node. */
function tablesIn(doc, ranges) {
  const found = new Map();
  const at = (x) => Math.max(0, Math.min(x, doc.content.size));
  for (const [from, to] of ranges) {
    const $f = doc.resolve(at(from));
    let [a, b] = [from, to];
    for (let d = 1; d <= $f.depth; d++) {
      if ($f.node(d).type.name !== 'table') continue;
      [a, b] = [$f.before(d), $f.before(d) + $f.node(d).nodeSize];
      break;
    }
    doc.nodesBetween(at(a), at(Math.max(a, b)), (n, p) => {
      if (n.type.name === 'table') found.set(p, n);
      return !n.isTextblock;
    });
  }
  return found;
}

/** The row segments of a merged cell's rows `first` to `last`, from the table's rows `rows` ({top, bottom} px, in order): a new
 * segment starts at a row more than 4 px below the row above, which a page end put there (rows touch, or overlap by a border).
 * → [{from, to, h}] (row indexes, the segment's height in px). */
export function mergeSegments(rows, first, last) {
  const out = [];
  for (let r = first; r <= last && rows[r]; r++) {
    const seg = out.at(-1);
    if (seg && rows[r].top - rows[r - 1].bottom <= 4) seg.to = r;
    else out.push({ from: r, to: r });
  }
  for (const seg of out) seg.h = Math.max(0, rows[seg.to].bottom - rows[seg.from].top);
  return out;
}

/** What every table's fit depends on besides its own content: the zoom (the drawn border width) and the page's text height. */
const keyOf = (v) => `${v.dom.currentCSSZoom}|${getComputedStyle(v.dom).getPropertyValue('--fit-h')}`;

function fitViews(vs, key) {
  if (!vs.length) return;
  for (const v of vs) {
    v.stale = false;
    v.fitKey = key;
  }
  const reads = vs.map((v) => v.readBorder());
  vs.forEach((v, i) => v.writeBorder(reads[i]));
  const floors = vs.map((v) => v.readFloors());
  vs.forEach((v, i) => v.writeFloors(floors[i]));
  const whole = vs.map((v, i) => v.readWhole(reads[i].max));
  vs.forEach((v, i) => v.writeWhole(whole[i]));
  const heights = vs.map((v) => v.table.offsetHeight);
  vs.forEach((v, i) => v.writeScale(heights[i], reads[i].max));
}

export class DocTableView extends TableView {
  constructor(node, ...rest) {
    super(node, ...rest);
    this.editorView = rest[1]; // columnResizing builds it as (node, cellMinWidth, view)
    this.stale = true;
    this.fitKey = null;
    this.applied = [];
    this.apply(node);
    this.cols = new MutationObserver(() => this.sync());
    this.cols.observe(this.colgroup, { attributes: true, childList: true, subtree: true });
    this.cols.observe(this.table, { attributes: true, attributeFilter: ['style'] });
    // The table's own height (a transform does not change it) while no transaction runs, a font arriving say; next frame,
    // since fit() may change the observed size. Pagination fits it before each measure too (pagination.js), after every
    // change and resize, so a page count never counts it unscaled, and a split table's rows (display: contents) are seen.
    this.tall = new ResizeObserver(() => fitSoon(this));
    this.tall.observe(this.table);
    this.dom.dataset.pgFit = '';
    this.dom.pgTable = this;
    this.dom.pgFitAll = fitTables;
    this.dom.pgFit = () => this.fit();
    this.sync();
  }

  update(node) {
    if (!super.update(node)) return false;
    this.apply(node);
    this.sync();
    return true;
  }

  /** The node's rendered data attributes on the table (the same renderHTML a copy uses), its placement on the wrapper, and its
   * cell margins as --tbl-cell-margin, which the table style's padding falls back from (stylesheet.js). */
  apply(node) {
    const spec = node.type.spec.toDOM?.(node);
    const attrs = Object.entries((Array.isArray(spec) && spec[1]) || {}).filter(([k, v]) => k.startsWith('data-') && !OWN.has(k) && v != null);
    for (const k of this.applied) if (!attrs.some(([n]) => n === k)) this.table.removeAttribute(k);
    for (const [k, v] of attrs) if (this.table.getAttribute(k) !== String(v)) this.table.setAttribute(k, v);
    this.applied = attrs.map(([k]) => k);
    // The table style's class, which stylesheet.js keys its rules on.
    const ts = this.table.getAttribute('data-style');
    const cls = ts ? tableStyleClass(ts) : null;
    if (this.tsCls !== cls) {
      if (this.tsCls) this.table.classList.remove(this.tsCls);
      if (cls) this.table.classList.add(cls);
      this.tsCls = cls;
    }
    const { align, indent, cellMargin: m } = node.attrs;
    if (align && align !== 'left') this.dom.dataset.align = align;
    else delete this.dom.dataset.align;
    this.dom.style.setProperty('--table-indent', `${indent ?? 0}pt`);
    // data-cell-margin marks it for document.css: a [style*=] selector there read every styled element's style attribute.
    if (m) this.dom.style.setProperty('--tbl-cell-margin', edgesPt(m));
    else this.dom.style.removeProperty('--tbl-cell-margin');
    this.dom.toggleAttribute('data-cell-margin', !!m);
    this.rowTops(node);
  }

  /** Word's row-wide top margin: every cell of a row takes the largest top margin of its cells (a cell's own, else the table's,
   * else its table style's), written for the rows whose cells differ (writeTops). */
  rowTops(node) {
    const styles = this.editorView?.state.doc.attrs.styles;
    this.tops = { styles };
    const base = node.attrs.cellMargin?.top ?? resolvedAll(styles)[node.attrs.styleId ?? 'TableNormal']?.table?.cellMargin?.top ?? 0;
    const rows = [];
    node.forEach((row, _, r) => {
      const tops = [];
      row.forEach((cell) => tops.push(cell.attrs.margins?.top ?? base));
      const top = rowTop(tops);
      if (top != null) rows.push([r + 1, top]);
    });
    if (rows.length) this.topsId ??= ++tableIds;
    if (this.topsId == null) return;
    const at = `.page[data-format="document"] .ProseMirror .tableWrapper[data-row-tops="${this.topsId}"] > table > tbody > tr:nth-child`;
    writeTops(this.topsId, rows.map(([n, top]) => `${at}(${n}) > td, ${at}(${n}) > th { padding-top: ${top}pt !important; }`).join('\n'));
    if (rows.length) this.dom.dataset.rowTops = String(this.topsId);
    else delete this.dom.dataset.rowTops;
  }

  /** The merged cells: each takes no height in its first row (contain: size; the fit sets its height) and draws over the slots
   * below it. this.merged lists them for the fit. */
  places(map) {
    const merged = [];
    const id = (this.mergeId ??= ++tableIds);
    this.node.forEach((row, rowOff, r) => row.forEach((cell, cellOff, k) => {
      if (Math.min(cell.attrs.rowspan ?? 1, map.height - r) > 1) merged.push({ r, k, last: r + cell.attrs.rowspan - 1 });
    }));
    this.merged = merged;
    writePlaces(id, merged.map(({ r, k }) => `${mergeAt(id, r)} > :nth-child(${k + 1} of td, th) { contain: size; align-self: start; position: relative; z-index: 1; }`).join('\n'));
    if (merged.length) this.dom.dataset.merges = String(id);
    else {
      delete this.dom.dataset.merges;
      writeMerges(id, '');
    }
  }

  /** The rows' boxes ({top, bottom} px, unzoomed) as drawn, or where pagination last read them while the table is culled. */
  readRows() {
    if (this.dom.pgCull) return this.dom.pgRows?.node === this.node ? { rows: this.dom.pgRows.rows, text: null } : null;
    const rows = [...this.table.rows].map((tr) => ({ top: tr.offsetTop, bottom: tr.offsetTop + tr.offsetHeight }));
    // Each merged cell's text height: its blocks' extent and its padding (none for turned text, which runs along the cell).
    const text = this.merged.map(({ r, k }) => {
      const cell = this.table.rows[r]?.cells[k];
      const kids = [...(cell?.children ?? [])].filter((el) => el.offsetHeight);
      if (!kids.length || getComputedStyle(cell).writingMode !== 'horizontal-tb') return 0;
      const cs = getComputedStyle(cell);
      return kids.at(-1).offsetTop + kids.at(-1).offsetHeight - kids[0].offsetTop + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    });
    return { rows, text };
  }

  /** Each merged cell drawn down to the last row it spans on its page (a negative margin cancels the height, so it never changes
   * a row's height or the page ends that place it), and its slots in its look: background, sides, and the bottom of the last. */
  writeMerges(read) {
    if (!read || this.table.hasAttribute('data-whole')) return;
    const { rows, text } = read;
    const id = this.mergeId;
    const px = (h) => `${Math.round(h * 100) / 100}px`;
    const rules = [];
    // Word grows a merged cell's last row when the cell's text is taller than its rows: a minimum height on that row. The row's own
    // height is read back from the last round (the minimum set, less what it added, while the row stands at that minimum).
    const was = this.grown ?? new Map();
    const grown = new Map();
    this.merged.forEach((m, i) => {
      const L = Math.min(m.last, rows.length - 1);
      const t = text?.[i];
      const p = was.get(L);
      if (t == null) {
        if (p) grown.set(L, p); // a culled table keeps what it had
        return;
      }
      const h = rows[L].bottom - rows[L].top;
      const own = p && Math.abs(h - p.min) < 0.5 ? p.min - p.add : h;
      const add = t - (rows[L].top - rows[m.r].top + own);
      if (add > 0.5 && !(grown.get(L)?.add >= add)) grown.set(L, { min: own + add, add });
    });
    this.grown = grown;
    for (const [L, g] of grown) rules.push(`${mergeAt(id, L)} { min-height: ${px(g.min)} !important; }`);
    // The rows as they will stand once grown, for the merged cells' drawn heights.
    let shift = 0;
    const after = rows.map((b, r) => {
      const grow = Math.max(0, (grown.get(r)?.min ?? 0) - (b.bottom - b.top));
      const box = { top: b.top + shift, bottom: b.bottom + shift + grow };
      shift += grow;
      return box;
    });
    for (const m of this.merged) {
      const h = mergeSegments(after, m.r, m.last)[0]?.h;
      const cell = this.table.rows[m.r]?.cells[m.k];
      if (h == null || !cell) continue;
      rules.push(`${mergeAt(id, m.r)} > :nth-child(${m.k + 1} of td, th) { height: ${px(h)}; margin-bottom: -${px(h)}; box-sizing: border-box; }`);
      const cs = getComputedStyle(cell);
      const side = (e) => `${cs[`border${e}Width`]} ${cs[`border${e}Style`]} ${cs[`border${e}Color`]}`;
      const slot = `.page[data-format="document"] .ProseMirror .tableWrapper[data-merges="${id}"] > table:not([data-whole]) > tbody > tr > .pg-vm[data-vm="${m.r}-${m.k}"]`;
      rules.push(`${slot} { background: ${cs.backgroundColor}; border-left: ${side('Left')}; border-right: ${side('Right')}; }`);
      rules.push(`${slot}[data-vm-last] { border-bottom: ${side('Bottom')}; }`);
    }
    writeMerges(id, rules.join('\n'));
  }

  /** The columns as a grid template: a set width in px, else an equal share with the column's minimum. A table with a preferred
   * width (table.width, Table Properties and AutoFit Window) is drawn that wide, its columns as shares in proportion to their
   * widths, as Word scales them. */
  sync() {
    const map = TableMap.get(this.node);
    this.columns(map);
    this.places(map);
    const { width } = this.node.attrs;
    const tw = width?.w && (width.type === 'pct' ? `${width.w}%` : width.type === 'dxa' ? `${width.w}pt` : null);
    const px = [...this.colgroup.children].map((c) => parseFloat(c.style.width) || 0);
    const avg = px.filter(Boolean).reduce((s, w, _, a) => s + w / a.length, 0) || 1;
    this.tracks = tw
      ? px.map((w) => `minmax(0, ${Math.round(((w || avg) / avg) * 1e4) / 1e4}fr)`)
      : [...this.colgroup.children].map((c) => c.style.width || `minmax(${c.style.minWidth || '0px'}, 1fr)`);
    // A whole table (table layout) takes the width on the element; the column resizer rewrites it on each update, so it is set again.
    if (tw && this.table.style.width !== tw) this.table.style.width = tw;
    this.tableW = tw || this.table.style.width || '100%';
    this.floors = null; // the content may have changed: the fit measures them again
    this.drawCols();
    this.dom.style.setProperty('--table-min', this.table.style.minWidth || '0px');
    fitSoon(this);
  }

  /** The colgroup on the whole grid at the cells' own widths: tiptap's has the first row's columns, each at least the resizer's
   * 20 px, so a row with more grid columns than the first (Word's w:gridAfter on the first row: the Word fixture's Calendar 3)
   * wrapped its last cells onto a line of their own, and a narrow Word column (that calendar's 11 pt spacers) widened. While a
   * column is dragged the colgroup is the drag's: only missing columns are added. */
  columns(map) {
    const w = gridWidths(this.node, map);
    const cols = this.colgroup.children;
    while (cols.length < w.length) this.colgroup.append(document.createElement('col'));
    if (this.editorView && columnResizingPluginKey.getState(this.editorView.state)?.dragging) return;
    const min = this.cellMinWidth ?? 0;
    w.forEach((px, i) => {
      const c = cols[i];
      const [width, minWidth] = px ? [`${px}px`, ''] : ['', `${min}px`];
      if (c.style.width !== width) c.style.width = width;
      if (c.style.minWidth !== minWidth) c.style.minWidth = minWidth;
    });
    // The table's width as tiptap sets it from the columns: set when every column has a width, else a minimum. A preferred
    // width (sync) owns it.
    const pref = this.node.attrs.width;
    if (pref?.w && (pref.type === 'pct' || pref.type === 'dxa')) return;
    const total = w.reduce((sum, px) => sum + (px || min), 0);
    const [width, minWidth] = w.every(Boolean) ? [`${total}px`, ''] : ['', `${total}px`];
    if (this.table.style.width !== width) this.table.style.width = width;
    if (this.table.style.minWidth !== minWidth) this.table.style.minWidth = minWidth;
  }

  /** The row grid's columns (sync's tracks) with the AutoFit floors the fit measured (floorTrack). A table of set column widths
   * that a floor widens is as wide as its columns, past the margin if need be, as Word draws it. */
  drawCols() {
    const f = this.floors ?? [];
    this.dom.style.setProperty('--cols', this.tracks.map((t, i) => floorTrack(t, f[i])).join(' '));
    this.dom.style.setProperty('--table-w', f.some(Boolean) && this.tableW.endsWith('px') ? 'max-content' : this.tableW);
  }

  /** Each grid column's floor in an AutoFit table (Word sizes no column below its longest word): a cell whose content runs past
   * it (a word does not break there, table-tools style.css) needs its content's right edge plus its margins, read only from cells
   * that overflow. The floors only grow until the table changes (sync), so a widened column stays wide. → px per column or null. */
  readFloors() {
    if (this.node.attrs.layout === 'fixed' || this.table.hasAttribute('data-whole')) return null;
    let out = null;
    const map = TableMap.get(this.node);
    this.node.forEach((row, rowOff, r) => row.forEach((cell, cellOff, k) => {
      const td = this.table.rows[r]?.cells[k];
      if (!td || (cell.attrs.colspan ?? 1) > 1 || ![...td.children].some((c) => c.scrollWidth > c.clientWidth)) return; // a cell's own scrollWidth stays its width
      const z = td.currentCSSZoom || 1;
      const box = td.getBoundingClientRect();
      const cs = getComputedStyle(td);
      const left = box.left + (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) * z;
      let right = left;
      const range = document.createRange();
      const walk = document.createTreeWalker(td, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        let rect = null;
        if (n.nodeType === 3) {
          range.selectNodeContents(n);
          rect = range.getBoundingClientRect();
        } else if (!n.classList.contains('column-resize-handle')) rect = n.getBoundingClientRect(); // the resizer's hover widget
        else continue;
        if (rect.width) right = Math.max(right, rect.right);
      }
      const need = (right - left) / z + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const col = map.colCount(rowOff + 1 + cellOff);
      out ??= Array(map.width).fill(0);
      out[col] = Math.max(out[col], need);
    }));
    return out;
  }

  writeFloors(floors) {
    if (!floors) return;
    const was = this.floors ?? [];
    const next = floors.map((f, i) => Math.max(f, was[i] ?? 0));
    if (next.every((f, i) => f === (was[i] ?? 0))) return;
    this.floors = next;
    this.drawCols();
  }

  /** Whole when a row is taller than a page's text area; a whole table taller than that is drawn scaled
   * to it, the wrapper as tall as the drawing. This table alone; fitTables fits many with shared layouts. */
  fit() {
    fitViews([this], keyOf(this));
  }

  /** The width Chrome draws a cell's border at (one device pixel at least, so a 0.5 pt border at 78% zoom takes 0.96 pt), and
   * the page text area's height --fit-h less 2 px: style reads only. */
  readBorder() {
    const cell = this.table.querySelector(':scope > tbody > tr > :is(td, th)');
    return { bx: cell ? `${parseFloat(getComputedStyle(cell).borderRightWidth) || 0}px` : null,
      max: parseFloat(getComputedStyle(this.dom).getPropertyValue('--fit-h')) - 2 };
  }

  /** The border width as --cell-bx, which document.css takes back out of the row grid, so a cell's text keeps Word's width and
   * a row Word's pitch. */
  writeBorder({ bx }) {
    if (bx && this.dom.style.getPropertyValue('--cell-bx') !== bx) this.dom.style.setProperty('--cell-bx', bx);
    const cls = bx ? bxClass(bx) : null;
    if (this.bxCls === cls) return;
    if (this.bxCls) this.dom.classList.remove(this.bxCls);
    if (cls) this.dom.classList.add(cls);
    this.bxCls = cls;
  }

  /** The wrapper's attributes are this view's and the fit's (data-align, --cols, --cell-bx and its class): ProseMirror reading
   * them as edits parsed the table again after every fit (seconds over 500 tables). */
  ignoreMutation(m) {
    return (m.type === 'attributes' && m.target === this.dom) || super.ignoreMutation(m);
  }

  /** Whether the table moves whole: a row taller than a page's text that cannot split, or whose at-least height alone is taller
   * (a row splits between its lines, and Word carries no empty height over to the next page). Rows are measured unscaled in either
   * layout; 4 px of slack keeps a row near the limit from switching back and forth. */
  readWhole(max) {
    const was = this.table.hasAttribute('data-whole');
    const lim = max - (was ? 4 : 0);
    const stiff = (a) => !rowSplits(a) || (a.height?.rule !== 'auto' && (a.height?.value ?? 0) * (4 / 3) > lim);
    return ((was || this.dom.offsetHeight > max)
      && [...this.table.rows].some((r, i) => r.offsetHeight > lim && stiff(this.node.maybeChild(i)?.attrs ?? {})));
  }

  writeWhole(whole) {
    if (this.table.hasAttribute('data-whole') !== whole) this.table.toggleAttribute('data-whole', whole);
  }

  /** A whole table taller than `max` drawn scaled to it, from its unscaled height `h`. */
  writeScale(h, max) {
    const s = this.table.hasAttribute('data-whole') && h > max ? Math.floor((max / h) * 1e4) / 1e4 : 1; // 4 places read back as written
    const transform = s === 1 ? '' : `scale(${s})`;
    if (this.table.style.transform === transform) return; // also ends the style observer's round trip
    this.table.style.transformOrigin = s === 1 ? '' : '0 0';
    this.table.style.transform = transform;
    this.dom.style.height = s === 1 ? '' : `${h * s}px`;
  }

  destroy() {
    if (this.topsId != null) writeTops(this.topsId, '');
    if (this.mergeId != null) {
      writePlaces(this.mergeId, '');
      writeMerges(this.mergeId, '');
    }
    waiting.delete(this);
    this.cols.disconnect();
    this.tall.disconnect();
  }
}

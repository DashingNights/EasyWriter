// Table Properties on a canvas draft (docs/plans/engine/stage2.md gap G31): the dialog's value (dialogs.jsx TableProperties, the
// shape index.js propsValue gives on the DOM editor) from the engine's table.get, and its result as engine steps run as one undo
// step. Pure: node tests and the row table (src/document/canvas/rows/page.mjs) load it.

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const round2 = (n) => Math.round(n * 100) / 100;
const MARGIN_KEYS = ['top', 'left', 'bottom', 'right'];
/** The engine's [top, left, bottom, right] → the dialog's {top, left, bottom, right}, or null. */
const marginsOf = (m) => (Array.isArray(m) ? Object.fromEntries(MARGIN_KEYS.map((k, i) => [k, m[i]])) : null);

/** The dialog's value from table.get `t` and layout.section `sect` (for the text width a percent is of). */
export function tablePropsValue(t, sect) {
  const p = t.props ?? {};
  const cols = (t.grid ?? []).map(round2);
  const rows = (t.rows ?? []).map((r) => {
    const rp = r.props ?? {};
    const h = rp.height == null || rp.heightRule === 'auto' ? null : { value: rp.height, rule: rp.heightRule === 'exact' ? 'exact' : 'atLeast' };
    return { height: h, cantSplit: !!rp.cantSplit, header: !!rp.header, drawn: rp.height ?? 0 };
  });
  let headerRun = 0;
  while (headerRun < rows.length && rows[headerRun].header) headerRun++;
  const sel = t.selection;
  const caret = t.rows?.[t.row]?.cells?.[t.cell];
  const rowsAt = sel ? sel.rows : [t.row, t.row];
  const colsAt = sel ? sel.cols : [caret?.col ?? 0, caret?.col ?? 0];
  const picked = cols.slice(colsAt[0], colsAt[1] + 1);
  const cp = caret?.props ?? {};
  const tableWidth = round2(cols.reduce((a, w) => a + w, 0));
  const textWidth = sect ? round2(sect.pageW - sect.marginLeft - sect.marginRight - (sect.gutter ?? 0)) : tableWidth;
  return {
    table: {
      width: p.widthPct ? { w: p.widthPct, type: 'pct' } : p.width ? { w: p.width, type: 'dxa' } : null,
      align: p.align ?? 'left', indent: p.indent ?? 0, cellMargin: marginsOf(p.cellMargins), cellSpacing: 0, layout: p.fixed ? 'fixed' : 'autofit',
      caption: p.caption ?? '', description: p.description ?? '', float: !!p.float,
    },
    rows, headerRun, rowsAt, cols, colsAt,
    cell: { vAlign: cp.valign ?? 'top', margins: marginsOf(cp.margins), noWrap: !!cp.noWrap, fitText: false,
      width: picked.length && picked.every((w) => w === picked[0]) ? picked[0] : null },
    tableWidth, textWidth, drawnWidth: tableWidth,
  };
}

/** The engine steps [[id, params]] that write the dialog's result `out` over `was` (what it opened with): only what changed. */
export function tablePropsSteps(out, was) {
  const steps = [];
  const props = {};
  const a = out.table;
  const b = was.table;
  if (!same(a.width, b.width)) Object.assign(props, a.width?.type === 'pct' ? { widthPct: a.width.w } : { width: a.width ? a.width.w : null });
  if (a.align !== b.align) props.align = a.align;
  if (a.indent !== b.indent && a.align === 'left') props.indent = a.indent;
  const rows = out.rows.map((r, index) => ({ r, index })).filter(({ r, index }) => !same(r, was.rows[index])).map(({ r, index }) => ({
    index, height: r.height ? r.height.value : null, heightRule: r.height?.rule ?? 'atLeast', allowBreak: !r.cantSplit, headerRow: !!r.header,
  }));
  if (rows.length) props.rows = rows;
  // The Cell tab's width is its columns' width (the DOM editor's applyProps): the Column tab's first, then the Cell tab's.
  let cols = out.cols;
  if (!same(out.cell.width, was.cell.width) && out.cell.width) cols = cols.map((w, x) => (x >= was.colsAt[0] && x <= was.colsAt[1] ? out.cell.width : w));
  const columns = cols.map((w, index) => ({ index, width: w })).filter(({ width, index }) => width != null && width !== was.cols[index]);
  if (columns.length) props.columns = columns;
  const c = out.cell;
  const d = was.cell;
  if (c.vAlign !== d.vAlign) props.valign = c.vAlign;
  if (!same(c.margins, d.margins)) props.cellMargins = c.margins;
  if (!!c.noWrap !== !!d.noWrap) props.noWrap = !!c.noWrap;
  if (Object.keys(props).length) steps.push(['table.properties', props]);
  if (a.layout !== b.layout) steps.push(['table.autofit', { mode: a.layout === 'fixed' ? 'fixed' : 'contents' }]);
  if (!same(a.cellMargin, b.cellMargin) && a.cellMargin) steps.push(['table.cellMargins', a.cellMargin]);
  if (a.caption !== b.caption || a.description !== b.description) steps.push(['table.altText', { title: a.caption, text: a.description }]);
  return steps;
}

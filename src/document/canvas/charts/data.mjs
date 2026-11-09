// ph-charts-1: the pure chart data helpers the canvas Chart dialogs and rows share, with no React and nothing from the DOM
// editor (src/document/chart). A grid is rows of strings, as the data sheet shows it: row 0 is the blank corner and the series
// names, each next row a category and its values; a value cell's text reads as a number, or is blank for a gap.

export const MAX_EDIT_CELLS = 10000; // the data dialogs draw one input per cell
export const MAX_ROWS = 4001; // 4000 categories and the header (ew_doc::chart::MAX_POINTS)
export const MAX_COLS = 256; // 255 series and the label column (MAX_SERIES)

/** Word's Insert Chart groups, only the types the engine makes. */
export const CHART_GROUPS = [
  { label: 'Column', types: [['column', 'Clustered Column'], ['columnStacked', 'Stacked Column']] },
  { label: 'Line', types: [['line', 'Line']] },
  { label: 'Pie', types: [['pie', 'Pie'], ['doughnut', 'Doughnut']] },
  { label: 'Bar', types: [['bar', 'Clustered Bar'], ['barStacked', 'Stacked Bar']] },
  { label: 'Area', types: [['area', 'Area']] },
  { label: 'X Y (Scatter)', types: [['scatter', 'Scatter']] },
];

/** The group `type` belongs to. */
export const groupOf = (type) => CHART_GROUPS.find((g) => g.types.some(([id]) => id === type)) ?? CHART_GROUPS[0];

/** Cells a data dialog draws: a header row and column, and every value. */
export const cellCount = (chart) => (chart.series.length + 1) * (chart.categories.length + 1);

const text = (v) => (v == null ? '' : String(v));

/** The chart's data as grid rows: ['', ...series names], then [category, ...values] per category. At least two rows and two
 * columns, all blank, so an empty chart still has cells to type in. */
export function gridOf(chart) {
  const rows = [['', ...chart.series.map((s) => text(s.name))]];
  for (let i = 0; i < chart.categories.length; i++) rows.push([text(chart.categories[i]), ...chart.series.map((s) => text(s.values[i]))]);
  while (rows.length < 2) rows.push(['', ...chart.series.map(() => '')]);
  for (const row of rows) while (row.length < 2) row.push('');
  return rows;
}

/** [r, c] of every value cell (r >= 1, c >= 1) whose text is neither blank nor a finite number. */
export function badCells(rows) {
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    for (let c = 1; c < (rows[r]?.length ?? 0); c++) {
      const t = text(rows[r][c]).trim();
      if (t !== '' && !Number.isFinite(Number(t))) out.push([r, c]);
    }
  }
  return out;
}

/** The {categories, series} the grid holds: column 0 of rows 1 on are the categories, and each column c >= 1 is a series named
 * by row 0. A blank value is null, anything else reads as a number. */
export function chartOfGrid(rows) {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const categories = rows.slice(1).map((row) => text(row[0]));
  const series = [];
  for (let c = 1; c < width; c++) {
    series.push({
      name: text(rows[0]?.[c]),
      values: rows.slice(1).map((row) => {
        const t = text(row[c]);
        return t.trim() === '' ? null : Number(t);
      }),
    });
  }
  return { categories, series };
}

/** The chart with its series and categories swapped: one series per old category, named by it, and one category per old series. */
export function transpose(chart) {
  return {
    categories: chart.series.map((s) => s.name),
    series: chart.categories.map((category, i) => ({ name: category, values: chart.series.map((s) => s.values[i] ?? null) })),
  };
}

/** TSV text as rows of strings: one trailing line break goes, then lines split on their tabs. */
export function parseTsv(s) {
  return String(s).replace(/\r?\n$/, '').split(/\r?\n/).map((line) => line.split('\t'));
}

/** `rows` with `cells` written from (r, c), each row grown with '' to fit them; what falls past MAX_ROWS or MAX_COLS is dropped. */
export function pasteInto(rows, r, c, cells) {
  const out = rows.map((row) => [...row]);
  for (let i = 0; i < cells.length && r + i < MAX_ROWS; i++) {
    const at = r + i;
    while (out.length <= at) out.push([]);
    const row = out[at];
    for (let j = 0; j < cells[i].length && c + j < MAX_COLS; j++) {
      while (row.length < c + j) row.push('');
      row[c + j] = cells[i][j];
    }
  }
  return out;
}

/** Numbers from comma separated text: '' is a gap (null), and bad text keeps its NaN so a dialog can refuse it. */
export function valuesOf(s) {
  return String(s).split(',').map((part) => {
    const t = part.trim();
    return t === '' ? null : Number(t);
  });
}

/** `values` as comma separated text. */
export const textOf = (values) => values.map((v) => v ?? '').join(', ');

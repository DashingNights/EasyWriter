// ph-charts-1: the Chart dialogs on the canvas engine, Word's names and layout (the probes hold no Chart tabs, so the labels
// are Word 365's). The chart data sheet is a table of inputs, and Select Data Source edits a copy the row writes back as one
// chart.editData step.
import { useState } from 'react';
import { openDialog } from '../../../app/actions.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Fieldset, ListPick, Row } from '../../../tooling/kit/controls.jsx';
import { AccessText, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { CHART_GROUPS, MAX_COLS, MAX_ROWS, badCells, chartOfGrid, gridOf, groupOf, parseTsv, pasteInto, textOf, transpose, valuesOf } from './data.mjs';
import { ChartThumb } from './thumb.jsx';

const FIELD = 'min-w-0 flex-1';

/** Word's column letter for a zero-based column: 0 A, 25 Z, 26 AA. */
const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Insert Chart and Change Chart Type: the groups on the left, the group's types and a large preview on the right. */
function ChartTypeDialog({ heading, type = 'column', onClose }) {
  const [sel, setSel] = useState(type);
  const group = groupOf(sel);
  const label = group.types.find(([id]) => id === sel)?.[1] ?? group.types[0][1];
  // A double click is OK: press the footer's button, as a click on it would.
  const okNow = (e) => {
    const root = e.currentTarget.closest('[data-word-dialog]');
    [...(root?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim().toLowerCase() === 'ok')?.click();
  };
  return (
    <WordDialog title={heading} size="lg" result={() => ({ type: sel })} onClose={onClose}>
      <div className="flex gap-4">
        <div className="flex w-40 shrink-0 flex-col gap-1">
          {CHART_GROUPS.map((g) => (
            <Button key={g.label} type="button" variant="outline" size="xs" aria-pressed={g === group} onClick={() => setSel(g.types[0][0])}
              className="justify-start aria-pressed:border-border aria-pressed:bg-accent">
              <AccessText label={g.label} />
            </Button>
          ))}
        </div>
        <div className="flex h-[18rem] min-w-0 flex-1 flex-col gap-2">
          <div className="flex gap-2">
            {group.types.map(([id, title]) => (
              <button key={id} type="button" aria-label={title} aria-pressed={id === sel} onClick={() => setSel(id)} onDoubleClick={okNow}
                className="rounded-md border border-input p-1 hover:bg-accent aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-ring/50">
                <ChartThumb type={id} />
              </button>
            ))}
          </div>
          <h3 className="text-sm font-medium">{label}</h3>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <ChartThumb type={sel} width={320} height={200} />
          </div>
        </div>
      </div>
    </WordDialog>
  );
}

/** The data sheet: one input per cell, inserts and deletes under the focused cell, a paste of TSV cells filling from it. */
function ChartDataDialog({ chart, onClose }) {
  const [rows, setRows] = useState(() => gridOf(chart));
  const [at, setAt] = useState([1, 1]);
  const cols = Math.max(2, ...rows.map((row) => row.length));
  const bad = new Set(badCells(rows).map(([r, c]) => `${r},${c}`));
  const setCell = (r, c, v) => setRows((old) => old.map((row, ri) => (ri === r ? row.map((t, ci) => (ci === c ? v : t)) : row)));
  const insertRow = () => {
    if (rows.length >= MAX_ROWS) return;
    const blank = Array.from({ length: cols }, () => '');
    setRows((old) => [...old.slice(0, at[0] + 1), blank, ...old.slice(at[0] + 1)]);
  };
  const insertColumn = () => {
    if (cols >= MAX_COLS) return;
    const i = Math.max(1, at[1] + 1);
    setRows((old) => old.map((row) => [...row.slice(0, i), '', ...row.slice(i)]));
  };
  const deleteRow = () => {
    const next = rows.filter((_, i) => i !== at[0]);
    setRows(next);
    setAt(([r, c]) => [Math.min(r, next.length - 1), c]);
  };
  const deleteColumn = () => {
    setRows((old) => old.map((row) => row.filter((_, i) => i !== at[1])));
    setAt(([r, c]) => [r, Math.min(c, cols - 2)]);
  };
  const left = [
    { label: 'Insert Row', onClick: insertRow, disabled: rows.length >= MAX_ROWS },
    { label: 'Insert Column', onClick: insertColumn, disabled: cols >= MAX_COLS },
    { label: 'Delete Row', onClick: deleteRow, disabled: at[0] === 0 || rows.length <= 2 },
    { label: 'Delete Column', onClick: deleteColumn, disabled: at[1] === 0 || cols <= 2 },
  ];
  return (
    <WordDialog title="Chart Data" size="md" left={left} validate={() => (bad.size ? 'Values must be numbers.' : null)}
      result={() => chartOfGrid(rows)} onClose={onClose}>
      <div className="max-h-[24rem] overflow-auto">
        <table className="border-collapse text-xs">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {Array.from({ length: cols }, (_, c) => {
                  if (r === 0 && c === 0) {
                    return <td key={c} className="p-0.5"><div aria-hidden="true" className="h-6 w-20 rounded border border-input bg-muted" /></td>;
                  }
                  return (
                    <td key={c} className="p-0.5">
                      <Input id={`chart-cell-${r}-${c}`} data-cell={`${r},${c}`} aria-label={`Cell ${colName(c)}${r + 1}`} size="xs"
                        aria-invalid={bad.has(`${r},${c}`) || undefined} value={row[c] ?? ''} spellCheck={false}
                        onChange={(e) => setCell(r, c, e.target.value)} onFocus={() => setAt([r, c])}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          e.stopPropagation(); // WordDialog's Enter is OK: moving down a cell must not close the sheet
                          const next = Math.min(rows.length - 1, r + 1);
                          setAt([next, c]);
                          document.getElementById(`chart-cell-${next}-${c}`)?.focus();
                        }}
                        onPaste={(e) => {
                          const text = e.clipboardData.getData('text/plain');
                          if (!/[\t\r\n]/.test(text)) return;
                          e.preventDefault();
                          setRows((old) => pasteInto(old, r, c, parseTsv(text)));
                        }}
                        className="w-20 min-w-0" />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WordDialog>
  );
}

/** Word's Select Data Source: the series list and the category labels, edited on a copy the row writes back. */
function SelectDataSourceDialog({ chart, onClose }) {
  const [state, setState] = useState(() => ({
    categories: [...chart.categories],
    series: chart.series.map((s) => ({ name: s.name, values: [...s.values] })),
  }));
  const [pick, setPick] = useState(0);
  const [catPick, setCatPick] = useState(0);
  const series = state.series;
  const setSeries = (next) => setState((old) => ({ ...old, series: next }));
  const add = async () => {
    const r = await openDialog('editSeries', { name: `Series ${series.length + 1}`, values: [] });
    if (!r) return;
    setSeries([...series, r]);
    setPick(series.length);
  };
  const edit = async () => {
    const s = series[pick];
    if (!s) return;
    const r = await openDialog('editSeries', { name: s.name, values: s.values });
    if (r) setSeries(series.map((old, i) => (i === pick ? r : old)));
  };
  const remove = () => {
    if (series.length <= 1) return;
    setSeries(series.filter((_, i) => i !== pick));
    setPick(Math.min(pick, series.length - 2));
  };
  const move = (d) => {
    const at = pick + d;
    if (at < 0 || at >= series.length) return;
    const next = [...series];
    [next[pick], next[at]] = [next[at], next[pick]];
    setSeries(next);
    setPick(at);
  };
  const editLabels = async () => {
    const r = await openDialog('axisLabels', { labels: state.categories });
    if (r) setState((old) => ({ ...old, categories: r.labels }));
  };
  return (
    <WordDialog title="Select Data Source" size="lg" result={() => state} onClose={onClose}>
      <div>
        <Button type="button" variant="outline" size="xs" disabled={chart.type === 'scatter'} onClick={() => { setState(transpose(state)); setPick(0); }}>
          Switch Row/Column
        </Button>
      </div>
      <div className="flex gap-6">
        <Fieldset legend="Legend Entries (Series)">
          <ListPick items={series.map((s, i) => [i, s.name])} value={pick} onChange={setPick} height="8rem" />
          <div className="flex flex-wrap gap-1">
            <Button type="button" variant="outline" size="xs" onClick={add}>Add</Button>
            <Button type="button" variant="outline" size="xs" disabled={!series[pick]} onClick={edit}>Edit</Button>
            <Button type="button" variant="outline" size="xs" disabled={series.length <= 1} onClick={remove}>Remove</Button>
            <Button type="button" variant="outline" size="xs" disabled={pick <= 0} onClick={() => move(-1)}>Move Up</Button>
            <Button type="button" variant="outline" size="xs" disabled={pick >= series.length - 1} onClick={() => move(1)}>Move Down</Button>
          </div>
        </Fieldset>
        <Fieldset legend="Horizontal (Category) Axis Labels">
          <ListPick items={state.categories.map((c, i) => [i, c])} value={catPick} onChange={setCatPick} height="8rem" />
          <div>
            <Button type="button" variant="outline" size="xs" onClick={editLabels}>Edit</Button>
          </div>
        </Fieldset>
      </div>
    </WordDialog>
  );
}

/** Word's Edit Series: a name and its comma separated values. */
function EditSeriesDialog({ name = '', values = [], onClose }) {
  const [seriesName, setSeriesName] = useState(name);
  const [text, setText] = useState(() => textOf(values));
  return (
    <WordDialog title="Edit Series" size="sm" validate={() => (valuesOf(text).some(Number.isNaN) ? 'Values must be numbers.' : null)}
      result={() => ({ name: seriesName, values: valuesOf(text) })} onClose={onClose}>
      <Row label="Series name" htmlFor="edit-series-name">
        <Input id="edit-series-name" size="xs" value={seriesName} spellCheck={false} onChange={(e) => setSeriesName(e.target.value)} className={FIELD} />
      </Row>
      <Row label="Series values" htmlFor="edit-series-values">
        <Input id="edit-series-values" size="xs" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} className={FIELD} />
      </Row>
    </WordDialog>
  );
}

/** Word's Axis Labels: the category labels, comma separated. */
function AxisLabelsDialog({ labels = [], onClose }) {
  const [text, setText] = useState(labels.join(', '));
  return (
    <WordDialog title="Axis Labels" size="sm" result={() => ({ labels: text.split(',').map((s) => s.trim()) })} onClose={onClose}>
      <Row label="Axis labels" htmlFor="axis-labels">
        <Input id="axis-labels" size="xs" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} className={FIELD} />
      </Row>
    </WordDialog>
  );
}

/** Word's Chart Title and Axis Title text box: one labelled box per field, its texts back by field id. */
function ChartTitleTextDialog({ heading, fields = [], onClose }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.id, f.value ?? ''])));
  return (
    <WordDialog title={heading} size="sm" result={() => values} onClose={onClose}>
      {fields.map((f) => (
        <Row key={f.id} label={f.label} htmlFor={`chart-title-${f.id}`}>
          <Input id={`chart-title-${f.id}`} size="xs" value={values[f.id] ?? ''} spellCheck={false}
            onChange={(e) => setValues((old) => ({ ...old, [f.id]: e.target.value }))} className={FIELD} />
        </Row>
      ))}
    </WordDialog>
  );
}

export const CHART_DIALOGS = {
  insertChart: (p) => <ChartTypeDialog heading="Insert Chart" type="column" {...p} />,
  changeChartType: (p) => <ChartTypeDialog heading="Change Chart Type" {...p} />,
  chartData: ChartDataDialog,
  selectDataSource: SelectDataSourceDialog,
  editSeries: EditSeriesDialog,
  axisLabels: AxisLabelsDialog,
  chartTitleText: ChartTitleTextDialog,
};

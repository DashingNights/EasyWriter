// The recipient list dialogs (docs/plans/word/briefs/mailings.md Select Recipients, Edit Recipient List): Type a New List (also the
// data source's Edit...), Customize Address List, Mail Merge Recipients, Filter and Sort, Find Duplicates and Find Entry. Each
// resolves with plain data; the commands (commands.js) write it to the draft record or doc.attrs.merge.
import { useMemo, useState } from 'react';
import { cn } from 'cn';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CheckboxInput } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { openDialog } from '../../../app/actions.js';
import { Fieldset, Pick, Radio, rowClass, Row } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { columnFilter, COMPARISONS, duplicates, findIn, listed, TYPED_FIELDS } from './data.mjs';

const CELL = 'h-6 min-w-24 rounded-none border-0 border-r border-b px-1 text-xs focus-visible:ring-1';
const TH = 'sticky top-0 z-10 border-r border-b bg-muted px-1 py-0.5 text-left font-normal whitespace-nowrap';

/** A small push button inside a dialog body, with its access key. */
export const Btn = ({ label, onClick, disabled, className }) => (
  <Button type="button" variant="outline" size="sm" className={cn('h-6 px-2 text-xs', className)} disabled={disabled} onClick={onClick} {...accessProps(label)}>
    <AccessText label={label} />
  </Button>
);

/** A link-style action (Word's blue links in Edit Recipient List and the wizard pane). */
export const Link = ({ label, onClick, disabled }) => (
  <button type="button" disabled={disabled} onClick={onClick} {...accessProps(label)}
    className="w-fit text-left text-xs text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline">
    <AccessText label={label} />
  </button>
);

/** Type a New List, and the data source's Edit...: a grid of entries under the list's columns. → {name, fields, records} or null. */
export function TypeANewList({ source = null, onClose }) {
  const [fields, setFields] = useState(() => source?.fields ?? TYPED_FIELDS);
  const [rows, setRows] = useState(() => (source?.records?.length ? source.records.map((r) => [...r]) : [TYPED_FIELDS.map(() => '')]));
  const [sel, setSel] = useState(0);
  const set = (r, c, v) => setRows((old) => old.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)));
  const add = () => {
    setRows((old) => [...old, fields.map(() => '')]);
    setSel(rows.length);
  };
  const remove = () => {
    setRows((old) => (old.length > 1 ? old.filter((_, i) => i !== sel) : [fields.map(() => '')]));
    setSel((s) => Math.max(0, Math.min(s, rows.length - 2)));
  };
  const find = async () => {
    const list = rows.map((values) => ({ values }));
    await openDialog('findEntry', { fields, onFind: (text, field) => {
      const i = findIn(fields, list, text, field, sel);
      if (i >= 0) setSel(i);
      return i >= 0;
    } });
  };
  const customize = async () => {
    const r = await openDialog('customizeAddressList', { fields });
    if (!r) return;
    setFields(r.fields);
    setRows((old) => old.map((row) => r.from.map((j) => (j >= 0 ? row[j] ?? '' : ''))));
  };
  const result = () => ({ name: source?.name ?? 'Typed list', fields, records: rows.filter((r) => r.some((v) => v.trim())) });
  return (
    <WordDialog title={source ? 'Edit Data Source' : 'New Address List'} size="lg" onClose={onClose} result={result}
      validate={() => (result().records.length ? null : 'Type at least one entry.')}
      left={[{ label: '&New Entry', onClick: add }, { label: '&Find...', onClick: find }, { label: '&Delete Entry', onClick: remove },
        { label: '&Customize Columns...', onClick: customize }]}>
      <p className="text-xs">Type recipient information in the table. To add more entries, click New Entry.</p>
      <div className="max-h-72 overflow-auto border-t border-l" data-merge-grid="">
        <table className="border-separate border-spacing-0 text-xs">
          <thead><tr>{fields.map((f) => <th key={f} className={TH}>{f}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, r) => (
              // eslint-disable-next-line react/no-array-index-key -- entries have no identity but their place
              <tr key={r} aria-selected={r === sel} className={cn(r === sel && 'bg-accent')} onFocus={() => setSel(r)}>
                {fields.map((f, c) => (
                  <td key={f} className="p-0">
                    <Input size="xs" aria-label={`${f} ${r + 1}`} className={CELL} value={row[c] ?? ''} onChange={(e) => set(r, c, e.target.value)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Entries: {rows.length}</p>
    </WordDialog>
  );
}

/** Customize Address List: add, delete, rename and order the columns. → {fields, from (per new column, its old index or -1)}. */
export function CustomizeAddressList({ fields: initial, onClose }) {
  const [cols, setCols] = useState(() => initial.map((name, i) => ({ name, from: i })));
  const [sel, setSel] = useState(0);
  const [name, setName] = useState('');
  const taken = (n) => cols.some((c) => c.name.toLowerCase() === n.trim().toLowerCase());
  const move = (d) => {
    const j = sel + d;
    if (j < 0 || j >= cols.length) return;
    setCols((old) => {
      const next = [...old];
      [next[sel], next[j]] = [next[j], next[sel]];
      return next;
    });
    setSel(j);
  };
  const add = () => {
    if (!name.trim() || taken(name)) return;
    setCols((old) => [...old, { name: name.trim(), from: -1 }]);
    setName('');
  };
  const rename = () => {
    if (!name.trim() || taken(name) || !cols[sel]) return;
    setCols((old) => old.map((c, i) => (i === sel ? { ...c, name: name.trim() } : c)));
    setName('');
  };
  const remove = () => {
    if (cols.length <= 1) return;
    setCols((old) => old.filter((_, i) => i !== sel));
    setSel((s) => Math.max(0, s - 1));
  };
  return (
    <WordDialog title="Customize Address List" size="sm" onClose={onClose} result={() => ({ fields: cols.map((c) => c.name), from: cols.map((c) => c.from) })}>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <span><AccessText label="Field Names" /></span>
          <div role="listbox" aria-label="Field Names" className="h-48 overflow-auto border text-xs">
            {cols.map((c, i) => (
              <div key={`${c.name}:${c.from}`} role="option" aria-selected={i === sel} onClick={() => setSel(i)}
                className={cn('cursor-default px-1.5 py-0.5', rowClass(i === sel))}>{c.name}</div>
            ))}
          </div>
          <Row label="Na&me:" htmlFor="mm-colname"><Input id="mm-colname" size="xs" value={name} onChange={(e) => setName(e.target.value)} /></Row>
        </div>
        <div className="flex w-28 flex-col gap-1.5">
          <Btn label="&Add" onClick={add} disabled={!name.trim() || taken(name)} />
          <Btn label="&Delete" onClick={remove} disabled={cols.length <= 1} />
          <Btn label="&Rename" onClick={rename} disabled={!name.trim() || taken(name)} />
          <Btn label="Move &Up" onClick={() => move(-1)} disabled={sel <= 0} />
          <Btn label="Move Do&wn" onClick={() => move(1)} disabled={sel >= cols.length - 1} />
        </div>
      </div>
    </WordDialog>
  );
}

const SPECIAL = ['(All)', '(Blanks)', '(Nonblanks)', '(Advanced...)'];

/** Mail Merge Recipients (Edit Recipient List): tick the records to merge, sort by a column, filter per column, refine. Props
 * {source, merge}. → {exclude, filter, sort, source (when Edit... changed the list)} or null. */
export function MailMergeRecipients({ source: initial, merge, onClose }) {
  const [source, setSource] = useState(initial);
  const [state, setState] = useState(() => ({ filter: merge?.filter ?? [], sort: merge?.sort ?? [], exclude: merge?.exclude ?? [] }));
  const [sel, setSel] = useState(0);
  const [edited, setEdited] = useState(false);
  const rows = useMemo(() => listed(source, state), [source, state]);
  const { fields } = source;
  const patch = (p) => setState((old) => ({ ...old, ...p }));
  const tick = (n, on) => patch({ exclude: on ? state.exclude.filter((x) => x !== n) : [...state.exclude, n] });
  const all = rows.every((r) => r.included);
  const tickAll = (on) => {
    const shown = new Set(rows.map((r) => r.n));
    patch({ exclude: on ? state.exclude.filter((x) => !shown.has(x)) : [...new Set([...state.exclude, ...shown])] });
  };
  const sortBy = (field) => {
    const cur = state.sort[0];
    patch({ sort: [{ field, desc: cur?.field === field ? !cur.desc : false }] });
  };
  const refine = async (tab) => {
    const r = await openDialog('filterAndSort', { fields, filter: state.filter, sort: state.sort, tab });
    if (r) patch(r);
  };
  const filterColumn = (field, pick) => {
    if (pick === '(Advanced...)') return refine('filterRecords');
    patch({ filter: columnFilter(state.filter, field, pick === '(All)' ? null : pick) });
  };
  const current = (field) => {
    const row = state.filter.find((r) => r.field === field);
    if (!row) return '(All)';
    if (state.filter.length > 1 && state.filter.some((r) => r.join === 'or')) return '(Advanced...)';
    return row.op === 'blank' ? '(Blanks)' : row.op === 'nonblank' ? '(Nonblanks)' : row.op === 'eq' ? row.value : '(Advanced...)';
  };
  const valuesOf = (i) => [...new Set(source.records.map((r) => r[i]).filter((v) => v.trim()))].sort((a, b) => a.localeCompare(b)).slice(0, 200);
  const edit = async () => {
    const next = await openDialog('typeANewList', { source });
    if (!next) return;
    setSource(next);
    setEdited(true);
  };
  const dups = async () => {
    const r = await openDialog('findDuplicates', { source, exclude: state.exclude });
    if (r) patch(r);
  };
  const findRecipient = () => openDialog('findEntry', { fields, onFind: (text, field) => {
    const i = findIn(fields, rows, text, field, sel);
    if (i >= 0) setSel(i);
    return i >= 0;
  } });
  return (
    <WordDialog title="Mail Merge Recipients" size="lg" onClose={onClose} result={() => ({ ...state, ...(edited && { source }) })}>
      <p className="text-xs">This is the list of recipients for your merge. Untick a recipient to leave them out, or use the column headings to sort and filter the list.</p>
      <div className="max-h-64 overflow-auto border text-xs" data-merge-recipients="">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className={cn(TH, 'w-6')}>
                <CheckboxInput aria-label="Include all" className="align-middle" checked={all} onChange={(e) => tickAll(e.target.checked)} />
              </th>
              {fields.map((f, i) => (
                <th key={f} className={TH}>
                  <span className="flex items-center gap-1">
                    <button type="button" className="hover:underline" aria-label={`Sort by ${f}`} onClick={() => sortBy(f)}>{f}</button>
                    {state.sort[0]?.field === f && (state.sort[0].desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    <select aria-label={`Filter ${f}`} value={current(f)} onChange={(e) => filterColumn(f, e.target.value)}
                      className="ml-auto h-4 w-4 cursor-pointer appearance-none rounded-sm border bg-background text-[0px]">
                      {[SPECIAL[0], ...valuesOf(i), ...SPECIAL.slice(1)].map((v) => <option key={v} value={v} className="text-xs">{v}</option>)}
                      {!['(All)', '(Blanks)', '(Nonblanks)', '(Advanced...)', ...valuesOf(i)].includes(current(f)) && <option value={current(f)}>{current(f)}</option>}
                    </select>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.n} aria-selected={i === sel} onClick={() => setSel(i)} className={cn(i === sel && 'bg-accent')} data-record={r.n}>
                <td className="border-r border-b px-1">
                  <CheckboxInput aria-label={`Include record ${r.n}`} className="align-middle" checked={r.included}
                    onChange={(e) => tick(r.n, e.target.checked)} />
                </td>
                {fields.map((f, c) => <td key={f} className="max-w-48 truncate border-r border-b px-1">{r.values[c]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-6">
        <Fieldset legend="Data Source">
          <div className="flex items-start gap-2">
            <div className="h-14 w-48 overflow-auto border px-1.5 py-0.5 text-xs">{source.name}</div>
            <div className="flex flex-col gap-1">
              <Btn label="Edi&t..." onClick={edit} />
              <Btn label="Refre&sh" disabled />
            </div>
          </div>
        </Fieldset>
        <Fieldset legend="Refine recipient list">
          <Link label="S&ort..." onClick={() => refine('sortRecords')} />
          <Link label="&Filter..." onClick={() => refine('filterRecords')} />
          <Link label="Find &duplicates..." onClick={dups} />
          <Link label="Find recipie&nt..." onClick={findRecipient} />
          <Link label="&Validate addresses..." disabled />
        </Fieldset>
      </div>
    </WordDialog>
  );
}

const OPS_NO_VALUE = new Set(['blank', 'nonblank']);
const FILTER_ROWS = 6;

/** Filter and Sort: rows of And/Or, Field, Comparison and Compare to; three sort keys. Props {fields, filter, sort, tab}.
 * → {filter, sort} or null. */
export function FilterAndSort({ fields, filter, sort, tab = 'filterRecords', onClose }) {
  const blankRow = { join: 'and', field: '', op: 'eq', value: '' };
  const [rows, setRows] = useState(() => Array.from({ length: FILTER_ROWS }, (_, i) => ({ ...blankRow, ...filter?.[i] })));
  const [keys, setKeys] = useState(() => Array.from({ length: 3 }, (_, i) => ({ field: '', desc: false, ...sort?.[i] })));
  const [shown, setShown] = useState(tab);
  const fieldOpts = [['', ''], ...fields.map((f) => [f, f])];
  const setRow = (i, p) => setRows((old) => old.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const setKey = (i, p) => setKeys((old) => old.map((k, j) => (j === i ? { ...k, ...p } : k)));
  const filterTab = () => (
    <div className="grid grid-cols-[4.5rem_1fr_1fr_1fr] items-center gap-1.5 text-xs">
      <span /><span>Field:</span><span>Comparison:</span><span>Compare to:</span>
      {rows.map((r, i) => {
        const live = i === 0 || rows[i - 1].field;
        return [
          i ? <Pick key={`j${i}`} aria-label={`And or Or ${i + 1}`} value={r.join} options={[['and', 'And'], ['or', 'Or']]} onChange={(v) => setRow(i, { join: v })} disabled={!live} />
            : <span key="j0" />,
          <Pick key={`f${i}`} aria-label={`Field ${i + 1}`} value={r.field} options={fieldOpts} onChange={(v) => setRow(i, { field: v })} disabled={!live} />,
          <Pick key={`o${i}`} aria-label={`Comparison ${i + 1}`} value={r.op} options={COMPARISONS} onChange={(v) => setRow(i, { op: v })} disabled={!r.field} />,
          <Input key={`v${i}`} size="xs" aria-label={`Compare to ${i + 1}`} value={r.value} disabled={!r.field || OPS_NO_VALUE.has(r.op)}
            onChange={(e) => setRow(i, { value: e.target.value })} />,
        ];
      })}
    </div>
  );
  const sortTab = () => (
    <div className="flex flex-col gap-3 text-xs">
      {keys.map((k, i) => (
        <Fieldset key={['&Sort by', '&Then by', 'Then &by'][i]} legend={['&Sort by', '&Then by', 'Then &by'][i]}>
          <div className="flex items-center gap-3">
            <Pick aria-label={`Sort field ${i + 1}`} value={k.field} options={fieldOpts} width="12rem" onChange={(v) => setKey(i, { field: v })} />
            <Radio name={`mm-sort-${i}`} value={k.desc} options={[[false, 'Ascending'], [true, 'Descending']]} onChange={(v) => setKey(i, { desc: v })} />
          </div>
        </Fieldset>
      ))}
    </div>
  );
  const clear = () => {
    if (shown === 'filterRecords') setRows(Array.from({ length: FILTER_ROWS }, () => ({ ...blankRow })));
    else setKeys(Array.from({ length: 3 }, () => ({ field: '', desc: false })));
  };
  return (
    <WordDialog title="Filter and Sort" size="lg" onClose={onClose} tab={shown} onTab={setShown} left={[{ label: '&Clear All', onClick: clear }]}
      tabs={[{ id: 'filterRecords', label: '&Filter Records', render: filterTab }, { id: 'sortRecords', label: 'S&ort Records', render: sortTab }]}
      result={() => ({ filter: rows.filter((r) => r.field).map((r, i) => ({ ...r, join: i ? r.join : 'and' })), sort: keys.filter((k) => k.field) })} />
  );
}

/** Find Duplicates: the records equal in every column, ticked to keep. Props {source, exclude}. → {exclude} or null. */
export function FindDuplicates({ source, exclude, onClose }) {
  const groups = useMemo(() => duplicates(source), [source]);
  const [out, setOut] = useState(() => new Set(exclude ?? []));
  const flip = (n, on) => setOut((old) => {
    const next = new Set(old);
    if (on) next.delete(n);
    else next.add(n);
    return next;
  });
  return (
    <WordDialog title="Find Duplicates" size="lg" onClose={onClose} result={() => ({ exclude: [...out].sort((a, b) => a - b) })}>
      <p className="text-xs">{groups.length ? 'Untick the entries you want to leave out of the merge.' : 'The list has no duplicate entries.'}</p>
      <div className="max-h-64 overflow-auto border text-xs">
        <table className="w-full border-separate border-spacing-0">
          <thead><tr><th className={cn(TH, 'w-6')} />{source.fields.map((f) => <th key={f} className={TH}>{f}</th>)}</tr></thead>
          <tbody>
            {groups.flatMap((g, gi) => g.map((n) => (
              <tr key={n} className={cn(gi % 2 && 'bg-muted/50')}>
                <td className="border-r border-b px-1">
                  <CheckboxInput aria-label={`Include record ${n}`} checked={!out.has(n)} onChange={(e) => flip(n, e.target.checked)} />
                </td>
                {source.records[n - 1].map((v, c) => <td key={source.fields[c]} className="border-r border-b px-1">{v}</td>)}
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </WordDialog>
  );
}

/** Find Entry: Find in all fields or one; Find Next calls onFind(text, field | null), which moves to the match → whether found (or
 * a promise of it, from the canvas engine). */
export function FindEntry({ fields, onFind, onClose }) {
  const [text, setText] = useState('');
  const [where, setWhere] = useState('all');
  const [field, setField] = useState(fields[0] ?? '');
  const [note, setNote] = useState('');
  const next = () => {
    if (!text.trim()) return;
    Promise.resolve(onFind(text, where === 'all' ? null : field)).then((found) => setNote(found ? '' : 'No recipient matches.'));
  };
  return (
    <WordDialog title="Find Entry" size="sm" okText="Close" onClose={onClose} result={() => true} left={[{ label: '&Find Next', onClick: next }]}>
      <Row label="Fi&nd:" htmlFor="mm-find">
        <Input id="mm-find" size="xs" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); next(); } }} />
      </Row>
      <Fieldset legend="Look in:">
        <Radio name="mm-find-where" value={where} options={[['all', '&All fields'], ['field', '&This field:']]} onChange={setWhere} />
        <Pick aria-label="This field" value={field} options={fields.map((f) => [f, f])} onChange={setField} disabled={where !== 'field'} />
      </Fieldset>
      <p role="status" className="text-xs text-muted-foreground">{note}</p>
    </WordDialog>
  );
}


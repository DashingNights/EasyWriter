// Table Layout's dialogs (briefs/table-layout.md; labels, defaults and access keys from probe/dialogs.md and probe/dialogs/*.json):
// Table Properties with its Table Options and Cell Options stacked over it, Insert Cells, Delete Cells, Split Cells, Sort with
// Sort Options, and Convert Table to Text. Each returns its values; the commands in index.js apply them in one transaction.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openDialog } from '../../../app/actions.js';
import { Help } from '../../../app/components/Tip.jsx';
import { Check, Fieldset, Pick, Radio, Row, Spin, TextArea, useUnit } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';

export const TABLE_NORMAL = { top: 0, right: 5.4, bottom: 0, left: 5.4 }; // Normal Table's cell margins, 0.19 cm at the sides (Word 16)
const UNIT_NAMES = { cm: 'Centimeters', in: 'Inches', mm: 'Millimeters', pt: 'Points', pi: 'Picas' };
const FLOAT_REASON = 'Text wrapping around a table is not built yet.';
// On a canvas draft (`engine`) the engine has no cell spacing or Fit text yet: those controls stay off with this reason.
const SPACING_REASON = 'Spacing between cells is not on the canvas engine yet.';
const FIT_REASON = 'Fit text is not on the canvas engine yet.';
const round2 = (n) => Math.round(n * 100) / 100;

/** The values Table Options shows for table attributes `a`. */
export const optionsValue = (a) => ({
  cellMargin: { ...TABLE_NORMAL, ...a.cellMargin }, spacing: a.cellSpacing ?? 0, spacingOn: !!a.cellSpacing, autofit: (a.layout ?? 'autofit') !== 'fixed',
});
/** Table Options' result `o` as table attributes. */
export const optionsPatch = (o) => ({ cellMargin: o.cellMargin, cellSpacing: o.spacingOn && o.spacing ? o.spacing : null, layout: o.autofit ? 'autofit' : 'fixed' });

/** A dialog button with an access key. */
const Btn = ({ label, onClick, disabled, title }) => (
  <Button type="button" variant="outline" size="sm" disabled={disabled} title={title} onClick={onClick} {...accessProps(label)}><span><AccessText label={label} /></span></Button>
);
/** Controls that are off as one block (a native disabled fieldset turns off every control inside). */
const Off = ({ off, children, title }) => <fieldset disabled={off} title={title} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 disabled:opacity-50">{children}</fieldset>;
/** An unlabelled box Word names only in its accessibility tree; data-label lets the harness find it. */
const Named = ({ name, children }) => <div data-label={name} className="contents">{children}</div>;

/** A preferred width: the check box, the box in the length unit or percent of `whole` (pt), and Measure in. `value` is pt or
 * {pct}; null is unchecked. */
function PreferredWidth({ value, onChange, whole, initial }) {
  const unit = useUnit();
  const pct = value != null && typeof value === 'object';
  const shown = value == null ? initial : pct ? value.pct : value;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Check label="Preferred &width:" checked={value != null} onChange={(on) => onChange(on ? initial : null)} />
      <Off off={value == null}>
        <Named name="Preferred width"><Spin label={null} value={shown} unit={pct ? 'pct' : 'len'} min={0} max={pct ? 600 : 1584} onChange={(v) => onChange(pct ? { pct: v } : v)} /></Named>
      </Off>
      <Off off={value == null}>
        <Row label="&Measure in:" htmlFor="tl-measure">
          <Pick id="tl-measure" value={pct ? 'pct' : 'len'} options={[['pct', 'Percent'], ['len', UNIT_NAMES[unit] ?? unit]]}
            onChange={(m) => onChange(m === 'pct' ? { pct: round2(((pct ? 0 : value) / (whole || 1)) * 100) } : round2(((pct ? value.pct : 0) / 100) * whole))} />
        </Row>
      </Off>
    </div>
  );
}

/** Table Properties: Table, Row, Column, Cell and Alt Text tabs over `value` (index.js propsValue) → the edited value. `borders`:
 * whether the Borders and Shading dialog is registered; `engine`: a canvas draft (its Options dialogs turn off what it lacks). */
export function TableProperties({ value, tab = 'table', borders = false, engine = false, onClose }) {
  const [v, setV] = useState(() => structuredClone(value));
  const [tabNow, setTab] = useState(tab);
  const [rowAt, setRowAt] = useState(value.rowsAt);
  const [colAt, setColAt] = useState(value.colsAt);
  const setT = (patch) => setV((o) => ({ ...o, table: { ...o.table, ...patch } }));
  const setRows = (patch) => setV((o) => ({ ...o, rows: o.rows.map((r, y) => (y >= rowAt[0] && y <= rowAt[1] ? { ...r, ...patch } : r)) }));
  const setCols = (w) => setV((o) => ({ ...o, cols: o.cols.map((c, x) => (x >= colAt[0] && x <= colAt[1] ? w : c)) }));
  const setCell = (patch) => setV((o) => ({ ...o, cell: { ...o.cell, ...patch } }));
  const range = (word, [a, b]) => `${word}${a === b ? '' : 's'} ${a + 1}${a === b ? '' : `-${b + 1}`}:`;

  const tw = v.table.width;
  const tableWidth = tw?.type === 'pct' ? { pct: tw.w } : tw?.type === 'dxa' ? tw.w : null;
  const tableTab = () => (
    <>
      <Fieldset legend="Size">
        <PreferredWidth value={tableWidth} whole={value.textWidth || value.tableWidth} initial={value.drawnWidth || value.tableWidth}
          onChange={(w) => setT({ width: w == null ? null : typeof w === 'object' ? { w: w.pct, type: 'pct' } : { w, type: 'dxa' } })} />
      </Fieldset>
      <Fieldset legend="Alignment">
        <div className="flex items-start gap-6">
          <Radio value={v.table.align} options={[['left', '&Left'], ['center', '&Center'], ['right', 'Rig&ht']]} onChange={(align) => setT({ align })} />
          <Off off={v.table.align !== 'left'}><Spin label="&Indent from left:" value={v.table.indent} unit="len" min={-1584} max={1584} onChange={(indent) => setT({ indent })} /></Off>
        </div>
      </Fieldset>
      <Fieldset legend="Text wrapping">
        <div className="flex items-start gap-6">
          <Radio value="none" options={[['none', '&None']]} onChange={() => {}} />
          <Off off title={FLOAT_REASON}><Radio value={null} options={[['around', '&Around']]} onChange={() => {}} /></Off>
          <Btn label="&Positioning..." disabled title={FLOAT_REASON} />
        </div>
      </Fieldset>
      <div className="flex justify-end gap-2">
        <Btn label="&Borders and Shading..." disabled={!borders} title={borders ? undefined : 'Arrives with Borders and Shading.'}
          onClick={() => openDialog('bordersAndShading', { apply: 'table' })} />
        <Btn label="&Options..." onClick={async () => {
          const o = await openDialog('tableOptions', { value: optionsValue(v.table), mode: 'value', engine });
          if (o) setT(optionsPatch(o));
        }} />
      </div>
    </>
  );

  const r = v.rows[rowAt[0]];
  let headerRun = 0;
  while (headerRun < v.rows.length && v.rows[headerRun].header) headerRun++;
  const heightOn = !!r.height && r.height.rule !== 'auto';
  const rowTab = () => (
    <>
      <p className="font-medium">{range('Row', rowAt)}</p>
      <Fieldset legend="Size">
        <div className="flex flex-wrap items-center gap-3">
          <Check label="&Specify height:" checked={heightOn} onChange={(on) => setRows({ height: on ? { value: round2(r.drawn ?? 0), rule: 'atLeast' } : null })} />
          <Off off={!heightOn}>
            <Named name="Height"><Spin label={null} value={r.height?.value ?? 0} unit="len" min={0} max={1584} onChange={(value) => setRows({ height: { rule: 'atLeast', ...r.height, value } })} /></Named>
          </Off>
          <Off off={!heightOn}>
            <Row label="Row he&ight is:" htmlFor="tl-rule">
              <Pick id="tl-rule" value={r.height?.rule === 'exact' ? 'exact' : 'atLeast'} options={[['atLeast', 'At least'], ['exact', 'Exactly']]}
                onChange={(rule) => setRows({ height: { value: 0, ...r.height, rule } })} />
            </Row>
          </Off>
        </div>
      </Fieldset>
      <Fieldset legend="&Options">
        <Check label="Allow row to brea&k across pages" checked={!r.cantSplit} onChange={(on) => setRows({ cantSplit: !on })} />
        <Check label="Repeat as &header row at the top of each page" checked={r.header} disabled={rowAt[0] > headerRun} onChange={(header) => setRows({ header })} />
      </Fieldset>
      <div className="flex gap-2">
        <Btn label="&Previous Row" disabled={rowAt[0] === 0} onClick={() => setRowAt([rowAt[0] - 1, rowAt[0] - 1])} />
        <Btn label="&Next Row" disabled={rowAt[1] >= v.rows.length - 1} onClick={() => setRowAt([rowAt[1] + 1, rowAt[1] + 1])} />
      </div>
    </>
  );

  const colTab = () => (
    <>
      <p className="font-medium">{range('Column', colAt)}</p>
      <Fieldset legend="Size">
        <PreferredWidth value={v.cols[colAt[0]]} whole={value.tableWidth} initial={value.cols[colAt[0]]}
          onChange={(w) => setCols(w == null ? null : typeof w === 'object' ? round2((w.pct / 100) * value.tableWidth) : w)} />
        <div className="flex gap-2">
          <Btn label="&Previous Column" disabled={colAt[0] === 0} onClick={() => setColAt([colAt[0] - 1, colAt[0] - 1])} />
          <Btn label="&Next Column" disabled={colAt[1] >= v.cols.length - 1} onClick={() => setColAt([colAt[1] + 1, colAt[1] + 1])} />
        </div>
      </Fieldset>
    </>
  );

  const cellTab = () => (
    <>
      <Fieldset legend="Size">
        <PreferredWidth value={v.cell.width} whole={value.tableWidth} initial={value.cell.width ?? value.cols[value.colsAt[0]]}
          onChange={(w) => setCell({ width: w == null ? null : typeof w === 'object' ? round2((w.pct / 100) * value.tableWidth) : w })} />
      </Fieldset>
      <Fieldset legend="Vertical alignment">
        <Radio value={v.cell.vAlign} options={[['top', 'To&p'], ['center', '&Center'], ['bottom', '&Bottom']]} onChange={(vAlign) => setCell({ vAlign })} />
      </Fieldset>
      <div className="flex justify-end">
        <Btn label="&Options..." onClick={async () => {
          const o = await openDialog('cellOptions', {
            value: { same: !v.cell.margins, margins: v.cell.margins ?? { ...TABLE_NORMAL, ...v.table.cellMargin }, wrap: !v.cell.noWrap, fit: v.cell.fitText }, engine,
          });
          if (o) setCell({ margins: o.same ? null : o.margins, noWrap: !o.wrap, fitText: o.fit });
        }} />
      </div>
    </>
  );

  const altTab = () => (
    <>
      <Row label="T&itle" htmlFor="tl-title" />
      <Input id="tl-title" size="xs" value={v.table.caption} onChange={(e) => setT({ caption: e.target.value })} />
      <Row label="&Description" htmlFor="tl-desc" />
      <TextArea id="tl-desc" rows={5} value={v.table.description} onChange={(e) => setT({ description: e.target.value })} />
      <Help className="self-end">A title and description give people who cannot see the table a text version of it, which screen readers read out.</Help>
    </>
  );

  return (
    <WordDialog title="Table Properties" size="md" onClose={onClose} result={() => v} tab={tabNow} onTab={setTab}
      tabs={[{ id: 'table', label: '&Table', render: tableTab }, { id: 'row', label: '&Row', render: rowTab }, { id: 'column', label: 'Col&umn', render: colTab },
        { id: 'cell', label: 'C&ell', render: cellTab }, { id: 'altText', label: '&Alt Text', render: altTab }]} />
  );
}

/** Four margin boxes, Top and Bottom left of Left and Right. */
function Margins({ value, onChange }) {
  const set = (k) => (n) => onChange({ ...value, [k]: n });
  return (
    <div className="grid grid-cols-2 gap-2">
      <Spin label="&Top:" value={value.top} unit="len" min={0} max={1584} onChange={set('top')} />
      <Spin label="&Left:" value={value.left} unit="len" min={0} max={1584} onChange={set('left')} />
      <Spin label="&Bottom:" value={value.bottom} unit="len" min={0} max={1584} onChange={set('bottom')} />
      <Spin label="&Right:" value={value.right} unit="len" min={0} max={1584} onChange={set('right')} />
    </div>
  );
}

/** Table Options (Cell Margins, and Options... in Table Properties): default cell margins, spacing and automatic resize → the value. */
export function TableOptions({ value, engine = false, onClose }) {
  const [v, setV] = useState(value);
  return (
    <WordDialog title="Table Options" size="sm" onClose={onClose} result={() => v}>
      <Fieldset legend="Default cell margins"><Margins value={v.cellMargin} onChange={(cellMargin) => setV({ ...v, cellMargin })} /></Fieldset>
      <Fieldset legend="Default cell spacing">
        <Off off={engine} title={engine ? SPACING_REASON : undefined}>
          <div className="flex items-center gap-3">
            <Check label="Allow &spacing between cells" checked={v.spacingOn} onChange={(spacingOn) => setV({ ...v, spacingOn })} />
            <Off off={!v.spacingOn}><Named name="Spacing"><Spin label={null} value={v.spacing} unit="len" min={0} max={1584} onChange={(spacing) => setV({ ...v, spacing })} /></Named></Off>
          </div>
        </Off>
      </Fieldset>
      <Fieldset legend="Options">
        <Check label="Automatically resi&ze to fit contents" checked={v.autofit} onChange={(autofit) => setV({ ...v, autofit })} />
      </Fieldset>
    </WordDialog>
  );
}

/** Cell Options (Table Properties > Cell > Options...): its own margins or the table's, Wrap text and Fit text → the value. */
export function CellOptions({ value, engine = false, onClose }) {
  const [v, setV] = useState(value);
  return (
    <WordDialog title="Cell Options" size="sm" onClose={onClose} result={() => v}>
      <Fieldset legend="Cell margins">
        <Check label="&Same as the whole table" checked={v.same} onChange={(same) => setV({ ...v, same })} />
        <Off off={v.same}><Margins value={v.margins} onChange={(margins) => setV({ ...v, margins })} /></Off>
      </Fieldset>
      <Fieldset legend="Options">
        <Check label="&Wrap text" checked={v.wrap} onChange={(wrap) => setV({ ...v, wrap })} />
        <Off off={engine} title={engine ? FIT_REASON : undefined}><Check label="&Fit text" checked={v.fit} onChange={(fit) => setV({ ...v, fit })} /></Off>
      </Fieldset>
    </WordDialog>
  );
}

/** A dialog of one radio group → the picked value. */
const choice = (title, options, initial) => function Choice({ onClose }) {
  const [v, setV] = useState(initial);
  return <WordDialog title={title} size="sm" onClose={onClose} result={() => v}><Radio value={v} options={options} onChange={setV} /></WordDialog>;
};
export const InsertCells = choice('Insert Cells',
  [['right', 'Sh&ift cells right'], ['down', 'Shift cells &down'], ['row', 'Inse&rt entire row'], ['column', 'Insert entire &column']], 'down');
export const DeleteCells = choice('Delete Cells',
  [['left', 'Shift ce&lls left'], ['up', 'Shift cells &up'], ['row', 'Delete enti&re row'], ['column', 'Delete entire &column']], 'left');

/** Split Cells: columns and rows, and Merge cells before split with several cells selected → {cols, rows, merge}. */
export function SplitCells({ several = false, onClose }) {
  const [v, setV] = useState({ cols: 2, rows: 1, merge: several });
  return (
    <WordDialog title="Split Cells" size="sm" onClose={onClose} result={() => v}>
      <Spin label="Number of &columns:" value={v.cols} unit="int" min={1} max={63} onChange={(cols) => setV({ ...v, cols: Math.round(cols) })} />
      <Spin label="Numbe&r of rows:" value={v.rows} unit="int" min={1} max={63} onChange={(rows) => setV({ ...v, rows: Math.round(rows) })} />
      <Check label="&Merge cells before split" checked={v.merge} disabled={!several} onChange={(merge) => setV({ ...v, merge })} />
    </WordDialog>
  );
}

const TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date']];
// Sorting languages offered (Word lists 261); the collator takes any BCP 47 tag.
const LANGS = [['', '(none)'], ['en-US', 'English (United States)'], ['en-GB', 'English (United Kingdom)'], ['zh-HK', 'Chinese (Hong Kong SAR)'],
  ['zh-TW', 'Chinese (Traditional, Taiwan)'], ['zh-CN', 'Chinese (Simplified, China)'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['fr-FR', 'French (France)'],
  ['de-DE', 'German (Germany)'], ['es-ES', 'Spanish (Spain)'], ['it-IT', 'Italian (Italy)'], ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch (Netherlands)'],
  ['sv-SE', 'Swedish (Sweden)']];
/** LANGS with `lang` added when the list lacks it, so the box shows the paragraph's language. */
const langsWith = (lang) => (LANGS.some(([v]) => v === lang) ? LANGS : [...LANGS, [lang, lang]]);
// The access keys of the three key rows: [Sort by, Type, Ascending, Descending].
const KEY_LABELS = [['&Sort by', 'T&ype:', '&Ascending', '&Descending'], ['&Then by', 'Ty&pe:', 'As&cending', 'Desce&nding'], ['Then &by', 'Typ&e:', 'Ascend&ing', 'Descendin&g']];

/** Sort: up to three keys over table columns (`mode` 'table', `cols`, `heads`, `header`) or paragraphs (`mode` 'text', `texts`),
 * My list has, and Options... → {keys: [{field, type, desc}], header, sep, columnOnly, caseSensitive, lang}. A paragraph key's
 * field is 0 (the paragraph), 'headings', or n (field n). */
export function SortDialog({ mode = 'table', lang = 'en-US', cols = 1, heads = [], header = false, columnSel = false, column = 0, texts = [], onClose }) {
  const table = mode === 'table';
  const [keys, setKeys] = useState([{ field: table ? (columnSel ? column : 0) : 0, type: 'text', desc: false }, { field: null, type: 'text', desc: false }, { field: null, type: 'text', desc: false }]);
  const [head, setHead] = useState(header);
  const [opts, setOpts] = useState({ sep: ',', columnOnly: true, caseSensitive: false, lang });
  const fieldCount = table ? cols : Math.max(1, ...texts.map((t) => String(t).split(opts.sep).length));
  const fields = table
    ? Array.from({ length: cols }, (_, i) => [i, (head && heads[i]) || `Column ${i + 1}`])
    : [[0, 'Paragraphs'], ['headings', 'Headings'], ...(fieldCount > 1 ? Array.from({ length: fieldCount }, (_, i) => [i + 1, `Field ${i + 1}`]) : [])];
  const set = (i, patch) => setKeys((ks) => ks.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  const keyRow = (i) => {
    const [sortBy, type, asc, desc] = KEY_LABELS[i];
    const k = keys[i];
    const off = i > 0 && keys[i - 1].field == null;
    return (
      <Off key={i} off={off}>
        <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`tl-sort-${i}`} {...accessProps(sortBy)}><AccessText label={sortBy} /></label>
            <Pick id={`tl-sort-${i}`} value={k.field ?? ''} options={i ? [['', '(none)'], ...fields] : fields}
              onChange={(f) => set(i, { field: f === '' ? null : f })} />
          </div>
          <div className="flex flex-col gap-1">
            <Row label={type} htmlFor={`tl-type-${i}`}><Pick id={`tl-type-${i}`} value={k.type} options={TYPES} onChange={(t) => set(i, { type: t })} /></Row>
            {table && <Row label="Using:" htmlFor={`tl-using-${i}`}><Pick id={`tl-using-${i}`} value="p" options={[['p', 'Paragraphs']]} onChange={() => {}} /></Row>}
          </div>
          <Radio value={k.desc} options={[[false, asc], [true, desc]]} onChange={(d) => set(i, { desc: d })} />
        </div>
      </Off>
    );
  };
  const result = () => ({ keys: keys.filter((k) => k.field != null), header: head, ...opts, columnOnly: columnSel && opts.columnOnly });
  return (
    <WordDialog title="Sort" size="lg" onClose={onClose} result={result}
      left={[{ label: '&Options...', onClick: async () => { const o = await openDialog('sortOptions', { value: opts, columnSel }); if (o) setOpts(o); } }]}>
      {[0, 1, 2].map(keyRow)}
      <Fieldset legend="My list has">
        <Radio value={head} options={[[true, 'Heade&r row'], [false, 'No header ro&w']]} onChange={setHead} />
      </Fieldset>
    </WordDialog>
  );
}

/** A separator choice: radios with an Other box of one character → the separator string. */
function Separator({ value, onChange, options }) {
  const known = options.some(([v]) => v === value);
  const [other, setOther] = useState(known ? '-' : value);
  return (
    <div className="flex items-end gap-2">
      <Radio value={known ? value : 'other'} options={[...options, ['other', '&Other:']]} onChange={(v) => onChange(v === 'other' ? other || '-' : v)} />
      <Named name="Other"><Input value={other} maxLength={1} size="xs" className="w-8 px-0 text-center"
        onChange={(e) => { setOther(e.target.value); if (!known) onChange(e.target.value || '-'); }} /></Named>
    </div>
  );
}

/** Sort Options: fields' separator, Sort column only, Case sensitive and the sorting language → the options. */
export function SortOptions({ value, columnSel = false, onClose }) {
  const [v, setV] = useState(value);
  return (
    <WordDialog title="Sort Options" size="sm" onClose={onClose} result={() => v}>
      <Fieldset legend="Separate fields at">
        <Separator value={v.sep} options={[['\t', '&Tabs'], [',', 'Co&mmas']]} onChange={(sep) => setV({ ...v, sep })} />
      </Fieldset>
      <Fieldset legend="Sort options">
        <Check label="So&rt column only" checked={v.columnOnly} disabled={!columnSel} onChange={(columnOnly) => setV({ ...v, columnOnly })} />
        <Check label="&Case sensitive" checked={v.caseSensitive} onChange={(caseSensitive) => setV({ ...v, caseSensitive })} />
      </Fieldset>
      <Row label="Sorting &language" htmlFor="tl-lang"><Pick id="tl-lang" value={v.lang} options={langsWith(v.lang)} onChange={(lang) => setV({ ...v, lang })} /></Row>
    </WordDialog>
  );
}

/** Convert Table to Text: the separator and Convert nested tables (nested tables always flatten here) → {sep}. */
export function ConvertTableToText({ nested = false, onClose }) {
  const [sep, setSep] = useState('\t');
  return (
    <WordDialog title="Convert Table To Text" size="sm" onClose={onClose} result={() => ({ sep })}>
      <Fieldset legend="Separate text with">
        <Separator value={sep} options={[['para', '&Paragraph marks'], ['\t', '&Tabs'], [',', 'Co&mmas']]} onChange={setSep} />
      </Fieldset>
      <Check label="&Convert nested tables" checked disabled={!nested} onChange={() => {}} />
    </WordDialog>
  );
}

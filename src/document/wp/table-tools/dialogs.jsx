// Insert Table and Convert Text to Table (docs/plans/word/probe/dialogs/insert-table.json and convert-text-to-table.json): the
// labels, defaults and access keys as captured. Both return their values; the commands in index.js make the table.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Check, Fieldset, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { colsFor, detectSep, MAX_COLS, MAX_ROWS, rowsFor, validateInsert } from './tables.mjs';

const NAME = 'autofit';

/** AutoFit behavior: Fixed column width with its box (null = Auto), AutoFit to contents, AutoFit to window. */
function AutoFit({ fit, onChange }) {
  const pick = (kind) => onChange(kind === 'fixed' ? { kind, width: fit.width ?? null } : { kind });
  return (
    <Fieldset legend="AutoFit behavior">
      <div className="flex items-center justify-between gap-2">
        <Radio name={NAME} value={fit.kind} options={[['fixed', 'Fixed column &width:']]} onChange={pick} />
        <Spin value={fit.kind === 'fixed' ? fit.width ?? null : null} auto="Auto" unit="len" min={0} max={1584}
          onChange={(width) => onChange({ kind: 'fixed', width })} />
      </div>
      <Radio name={NAME} value={fit.kind} options={[['contents', 'Auto&Fit to contents']]} onChange={pick} />
      <Radio name={NAME} value={fit.kind} options={[['window', 'AutoFit to win&dow']]} onChange={pick} />
    </Fieldset>
  );
}

/** Insert Table → {cols, rows, fit, remember} or null. `initial` holds the remembered dimensions (settings.word.insertTable). */
export function InsertTableDialog({ initial, onClose }) {
  const [v, setV] = useState(() => ({ cols: initial?.cols ?? 5, rows: initial?.rows ?? 2, fit: initial?.autofit ?? { kind: 'fixed', width: null },
    remember: !!initial }));
  const set = (key) => (value) => setV((o) => ({ ...o, [key]: value }));
  return (
    <WordDialog title="Insert Table" size="sm" onClose={onClose} result={() => v} validate={() => validateInsert(v)}>
      <Fieldset legend="Table size">
        <Spin label="Number of &columns:" value={v.cols} onChange={set('cols')} unit="int" min={0} max={MAX_COLS + 1} />
        <Spin label="Numbe&r of rows:" value={v.rows} onChange={set('rows')} unit="int" min={0} max={MAX_ROWS + 1} />
      </Fieldset>
      <AutoFit fit={v.fit} onChange={set('fit')} />
      <Check label="Remember dimen&sions for new tables" checked={v.remember} onChange={set('remember')} />
    </WordDialog>
  );
}

const SEPS = [['paragraphs', '&Paragraphs'], ['tabs', '&Tabs'], ['commas', 'Co&mmas'], ['other', '&Other:']];

/** Convert Text to Table for paragraphs `texts` → {cols, sep, other, fit} or null. The separator starts as Word picks it, the
 * column count follows the separator, and the row count is derived (shown disabled, as in Word). */
export function ConvertTextToTableDialog({ texts = [], onClose }) {
  const [v, setV] = useState(() => {
    const sep = detectSep(texts);
    return { sep, other: '-', cols: colsFor(texts, sep, '-'), fit: { kind: 'fixed', width: null } };
  });
  const sepTo = (sep, other = v.other) => setV((o) => ({ ...o, sep, other, cols: colsFor(texts, sep, other) }));
  const rows = v.cols >= 1 ? rowsFor(texts, v.sep, v.other, v.cols) : '';
  return (
    <WordDialog title="Convert Text to Table" size="sm" onClose={onClose} result={() => v} validate={() => validateInsert({ cols: v.cols, rows: rows || 0 })}>
      <Fieldset legend="Table size">
        {/* Keyed by the separator: a focused spin box keeps its typed text, and the count a new separator gives must show. */}
        <Spin key={v.sep + v.other} label="Number of &columns:" value={v.cols} onChange={(cols) => setV((o) => ({ ...o, cols }))} unit="int" min={0} max={MAX_COLS + 1} />
        <Row label="Numbe&r of rows:" htmlFor="tt-convert-rows">
          <Input id="tt-convert-rows" size="xs" disabled value={rows} className="w-28 tabular-nums" />
        </Row>
      </Fieldset>
      <AutoFit fit={v.fit} onChange={(fit) => setV((o) => ({ ...o, fit }))} />
      <Fieldset legend="Separate text at">
        <div className="grid grid-cols-2 gap-1.5">
          {SEPS.map(([sep, label]) => (
            <div key={sep} className="flex items-center gap-2">
              <Radio name="tt-sep" value={v.sep} options={[[sep, label]]} onChange={() => sepTo(sep)} />
              {sep === 'other' && (
                <Input aria-label="Other separator" size="xs" value={v.other} maxLength={1} spellCheck={false}
                  className="w-8 px-0 text-center"
                  onChange={(e) => sepTo('other', e.target.value)} />
              )}
            </div>
          ))}
        </div>
      </Fieldset>
    </WordDialog>
  );
}

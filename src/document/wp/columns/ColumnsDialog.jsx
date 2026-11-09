// More Columns (probe/dialogs/columns.json, 588 x 452 px): presets, number of columns, line between, the width and spacing rows,
// equal column width, Apply to, Start new column and a preview. Opened with {value: model.mjs dialog state, text: the text width in
// pt, applyTo: [[value, label]]}; resolves {attrs (null: one column), scope, newColumn}.
import { useState } from 'react';
import { cn } from 'cn';
import { Check, Fieldset, Pick, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { attrsOf, countError, MAX_COLS, maxColumns, preset, presetOf, setCount, setEqual, setSpace, setWidth, stateOf } from './model.mjs';

const PRESETS = [['one', '&One'], ['two', 'T&wo'], ['three', '&Three'], ['left', '&Left'], ['right', '&Right']];

/** Columns drawn as grey text lines in boxes `widths` (fractions of the width), a rule between them with `sep`. */
function Sample({ widths, gaps, sep, className }) {
  return (
    <div className={cn('flex h-full', className)}>
      {widths.map((w, i) => (
        <div key={i} className="flex" style={{ width: `${(w + (gaps[i] ?? 0)) * 100}%` }}>
          <div className="flex flex-col gap-1" style={{ width: `${(w / (w + (gaps[i] ?? 0) || 1)) * 100}%` }}>
            {Array.from({ length: 8 }, (_, k) => <div key={k} className="h-0.5 bg-neutral-400" />)}
          </div>
          {gaps[i] > 0 && <div className="flex flex-1 justify-center">{sep && <div className="w-px bg-neutral-600" />}</div>}
        </div>
      ))}
    </div>
  );
}

const fractions = (st, text) => ({ widths: st.cols.map((c) => c.w / text), gaps: st.cols.map((c) => c.space / text) });

export function ColumnsDialog({ value, text, applyTo, onClose }) {
  const [st, setSt] = useState(value);
  const [typed, setTyped] = useState(null); // a count past the limit, shown as the error on OK
  const [scope, setScope] = useState(applyTo[0][0]);
  const [newColumn, setNewColumn] = useState(false);
  const one = st.count <= 1;
  const pick = (id) => {
    setTyped(null);
    setSt(stateOf(preset(id, text), text));
  };
  return (
    <WordDialog title="Columns" size="md" onClose={onClose} validate={() => (typed != null ? countError(typed, text) : null)}
      result={() => ({ attrs: attrsOf(st), scope, newColumn: scope === 'forward' && newColumn })}>
      <Fieldset legend="Presets">
        <div role="radiogroup" className="flex justify-around">
          {PRESETS.map(([id, label]) => {
            const s = stateOf(preset(id, text), text);
            const on = presetOf(attrsOf(st)) === id;
            return (
              <label key={id} className="flex cursor-default flex-col items-center gap-1" {...accessProps(label)}>
                <input type="radio" name="columns-preset" className="sr-only" checked={on} onChange={() => pick(id)} />
                <span className={cn('block h-10 w-9 border bg-white p-1', on ? 'border-primary ring-2 ring-primary/40' : 'border-neutral-400')}>
                  <Sample {...fractions(s, text)} sep={false} />
                </span>
                <AccessText label={label} />
              </label>
            );
          })}
        </div>
      </Fieldset>
      <div className="flex items-center justify-between">
        <Spin label="&Number of columns:" unit="int" min={1} max={MAX_COLS} value={typed ?? st.count} width="4.5rem"
          onChange={(n) => {
            if (n == null) return;
            if (n > maxColumns(text)) return setTyped(n);
            setTyped(null);
            setSt((o) => setCount(o, n, text));
          }} />
        <Check label="Line &between" checked={st.sep} disabled={one} onChange={(on) => setSt((o) => ({ ...o, sep: on }))} />
      </div>
      <div className="flex gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Fieldset legend="Width and spacing">
            <div className="grid grid-cols-[3rem_1fr_1fr] items-center gap-x-2 text-xs">
              <span><AccessText label="&Col #:" /></span><span><AccessText label="W&idth:" /></span><span><AccessText label="&Spacing:" /></span>
            </div>
            <div className="flex max-h-[6.5rem] flex-col gap-1 overflow-y-auto" data-columns-rows="">
              {/* Word always shows three rows: those past the count are blank and disabled. */}
              {Array.from({ length: Math.max(3, st.count) }, (_, i) => {
                const c = st.cols[i];
                return (
                  <fieldset key={`${st.count}-${i}`} disabled={!c || (st.equal && i > 0)} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-x-2 disabled:opacity-50">
                    <span>{c ? `${i + 1}:` : ''}</span>
                    <Spin label={null} unit="len" min={36} max={1584} value={c ? c.w : null} auto={c ? undefined : ''} width="6.5rem"
                      onChange={(v) => v != null && setSt((o) => setWidth(o, i, v, text))} />
                    <fieldset disabled={one || i >= st.count - 1} className="disabled:opacity-50">
                      <Spin label={null} unit="len" min={0} max={1584} value={i >= st.count - 1 ? null : c.space} auto="" width="6.5rem"
                        onChange={(v) => v != null && setSt((o) => setSpace(o, i, v, text))} />
                    </fieldset>
                  </fieldset>
                );
              })}
            </div>
            <Check label="&Equal column width" checked={st.equal} disabled={one} onChange={(on) => setSt((o) => setEqual(o, on, text))} />
          </Fieldset>
          <Row label="&Apply to:" htmlFor="columns-apply">
            <Pick id="columns-apply" value={scope} options={applyTo} onChange={setScope} />
          </Row>
        </div>
        <div className="flex w-44 flex-col gap-2">
          <Fieldset legend="Preview">
            <div className="h-28 border border-neutral-300 bg-white p-2" data-columns-preview="">
              <Sample {...fractions(st, text)} sep={st.sep && !one} />
            </div>
          </Fieldset>
          <Check label="Start new col&umn" checked={newColumn} disabled={scope !== 'forward'} onChange={setNewColumn} />
        </div>
      </div>
    </WordDialog>
  );
}

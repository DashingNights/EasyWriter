// The Zoom dialog (docs/plans/word/probe/dialogs/zoom.json, 381 x 258 px): Zoom to 200%, 100%, 75%, Page width, Text width, Whole
// page and Many pages with its pages grid, Percent 10 to 500 and a preview. Text width, Whole page and Many pages only in Print
// Layout, as Word. Resolves {kind, pct, grid}; the command applies it (state.js applyZoom).
import { useState } from 'react';
import { cn } from 'cn';
import { RadioInput } from '@/components/ui/radio';
import { getState } from '../../../app/store.js';
import { Fieldset, Preview, Radio, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { measure } from './state.js';
import { zoomFor, ZOOM_MAX, ZOOM_MIN } from './views.mjs';

const LEFT = [['200', '&200%'], ['100', '&100%'], ['75', '&75%']];
const MIDDLE = [['pageWidth', '&Page width'], ['textWidth', '&Text width'], ['wholePage', '&Whole page']];

/** Word's Many pages picker: a grid of small pages; hovering picks cols x rows. */
function PagesGrid({ grid, onPick, disabled }) {
  const [hover, setHover] = useState(null);
  const shown = hover ?? grid;
  return (
    <div role="grid" aria-label="Multiple Pages" title="Show multiple pages" className={cn('inline-grid w-fit grid-cols-4 gap-0.5 border bg-background p-1', disabled && 'opacity-50')}
      onPointerLeave={() => setHover(null)}>
      {[1, 2].flatMap((r) => [1, 2, 3, 4].map((c) => (
        <button key={`${r}-${c}`} type="button" disabled={disabled} data-grid={`${c}x${r}`} aria-label={`${c} by ${r} pages`}
          onPointerEnter={() => setHover({ cols: c, rows: r })} onClick={() => onPick({ cols: c, rows: r })}
          className={cn('h-4 w-3 border border-neutral-400', c <= shown.cols && r <= shown.rows ? 'bg-primary' : 'bg-white')} />
      )))}
    </div>
  );
}

export function ZoomDialog({ onClose }) {
  const print = getState().word.view === 'print';
  const now = getState().zoomPct;
  const [kind, setKind] = useState(['200', '100', '75'].find((k) => Number(k) === now) ?? 'percent');
  const [pct, setPct] = useState(now);
  const [grid, setGrid] = useState({ cols: 2, rows: 1 });
  const pick = (k, g = grid) => {
    setKind(k);
    setPct(zoomFor(k, { ...measure(), grid: g }));
  };
  // Outside Print Layout the choices that need pages show disabled (Word's).
  const off = (label) => <span key={label} className="flex items-center gap-2 opacity-50"><RadioInput disabled />{label.replace('&', '')}</span>;
  return (
    <WordDialog title="Zoom" size="sm" onClose={onClose} result={() => ({ kind, pct, grid })}>
      <Fieldset legend="Zoom to">
        <div className="grid grid-cols-3 gap-2">
          <Radio name="zoom-left" value={kind} options={LEFT} onChange={pick} />
          <div className="flex flex-col gap-1.5">
            <Radio name="zoom-middle" value={kind} options={print ? MIDDLE : MIDDLE.slice(0, 1)} onChange={pick} />
            {!print && MIDDLE.slice(1).map(([, label]) => off(label))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Radio name="zoom-many" value={kind} options={print ? [['manyPages', '&Many pages:']] : []} onChange={(k) => pick(k)} />
            {!print && off('Many pages:')}
            <PagesGrid grid={grid} disabled={!print} onPick={(g) => { setGrid(g); pick('manyPages', g); }} />
          </div>
        </div>
        <Spin label="P&ercent:" unit="pct" value={pct} min={ZOOM_MIN} max={ZOOM_MAX} step={1} width="5.5rem"
          onChange={(v) => { if (Number.isFinite(v)) { setPct(v); setKind('percent'); } }} />
      </Fieldset>
      <Preview height="5rem">
        <div className="origin-left whitespace-nowrap" style={{ transform: `scale(${Math.min(2, pct / 100)})` }}>AaBbCcDdEeXxYyZz</div>
      </Preview>
    </WordDialog>
  );
}

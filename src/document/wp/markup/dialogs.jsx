// Track Changes Options and Advanced Track Changes Options (docs/plans/word plan.md §1.6, §3 markup; probe/dialogs/
// track-changes-options.json and advanced-track-changes-options.json). Both write settings.word.tracking on OK with saveWord, under
// the key names tracking draws from (§1.12). Ink is stored only; Highlight Updates and Other Authors need the cloud, as in Word.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWordCtx } from '../../../tooling/registry.js';
import { Check, Fieldset, Pick, Preview, Row, Spin, useUnit } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { saveWord } from '../../word/settings.mjs';
import { advancedOf, BALLOONS, CELLS, COLOR_HEX, COLORS, convertWidth, DEL_MARKS, LINES, MARKS, ORIENTATION, PANE, UNIT_NAMES } from './options.mjs';
import { paneSideNow, setReviewingPane } from './pane.js';

/** A button inside a dialog's body, with Word's access key. */
const BodyButton = ({ label, onClick }) => (
  <Button type="button" variant="outline" size="sm" className="w-fit" onClick={onClick} {...accessProps(label)}><AccessText label={label} /></Button>
);

/** Track Changes Options → the tracking patch it saved, or null. */
export function TrackChangesOptions({ onClose }) {
  const ctx = useWordCtx();
  const t = ctx.settings.word.tracking;
  const [v, setV] = useState(() => ({ show: { ...t.show }, balloons: t.balloons, pane: paneSideNow() ?? 'off' }));
  const show = (key) => (on) => setV((o) => ({ ...o, show: { ...o.show, [key]: on } }));
  const result = () => {
    const patch = { show: v.show, balloons: v.balloons, ...(v.pane !== 'off' && { paneSide: v.pane }) };
    saveWord({ tracking: patch });
    setReviewingPane(v.pane);
    return patch;
  };
  return (
    <WordDialog title="Track Changes Options" size="sm" onClose={onClose} result={result}>
      <Fieldset legend="Show">
        {/* Column by column, so the DOM and Tab order follow the probe's. */}
        <div className="grid grid-flow-col grid-cols-2 grid-rows-3 gap-2">
          <Check label="&Ink" checked={v.show.ink} onChange={show('ink')} />
          <Check label="Insertions and &Deletions" checked={v.show.insDel} onChange={show('insDel')} />
          <Check label="&Formatting" checked={v.show.formatting} onChange={show('formatting')} />
          <Check label="&Highlight Updates" checked disabled onChange={() => {}} />
          <Check label="&Other Authors" checked disabled onChange={() => {}} />
        </div>
        <Row label="&Balloons in All Markup view show" htmlFor="tco-balloons">
          <Pick id="tco-balloons" value={v.balloons} options={BALLOONS} onChange={(x) => setV((o) => ({ ...o, balloons: x }))} />
        </Row>
        <Row label="Reviewing &Pane" htmlFor="tco-pane">
          <Pick id="tco-pane" value={v.pane} options={PANE} onChange={(x) => setV((o) => ({ ...o, pane: x }))} />
        </Row>
      </Fieldset>
      <div className="flex gap-2">
        <BodyButton label="&Advanced Options..." onClick={() => ctx.dialog('advancedTrackChangesOptions')} />
        <BodyButton label="Change User &Name..." onClick={() => ctx.dialog('wordOptions', { page: 'general' })} />
      </div>
    </WordDialog>
  );
}

const swatch = (c) => COLOR_HEX[c] && <span aria-hidden className="inline-block size-3 shrink-0 border border-border" style={{ background: COLOR_HEX[c] }} />;

/** A mark list and its colour list on one line (Insertions, Deletions, Moved from, Moved to, Formatting). */
function MarkRow({ label, id, marks, value, onChange }) {
  return (
    <div className="grid grid-cols-[8rem_9rem_auto_8rem] items-center gap-2">
      <Row label={label} htmlFor={`atco-${id}`} />
      <Pick id={`atco-${id}`} value={value.mark} options={marks} onChange={(mark) => onChange({ ...value, mark })} />
      <Row label="&Color:" htmlFor={`atco-${id}-c`} />
      <span className="flex items-center gap-1">
        {swatch(value.color)}
        <Pick id={`atco-${id}-c`} value={value.color} options={COLORS} onChange={(color) => onChange({ ...value, color })} />
      </span>
    </div>
  );
}

/** The changed lines preview: a changed line with its bar at the left, right or both sides. */
const LinesSample = ({ lines }) => {
  const bar = '2px solid #000';
  return <div className="h-1.5 bg-neutral-500" style={{ borderLeft: lines === 'left' || lines === 'outside' ? bar : undefined, borderRight: lines === 'right' ? bar : undefined }} />;
};

/** Advanced Track Changes Options → the tracking patch it saved, or null. */
export function AdvancedTrackChangesOptions({ onClose }) {
  const ctx = useWordCtx();
  const unit = useUnit();
  const [v, setV] = useState(() => advancedOf(ctx.settings.word.tracking));
  const set = (key) => (x) => setV((o) => ({ ...o, [key]: x }));
  const cell = (key) => (x) => setV((o) => ({ ...o, cells: { ...o.cells, [key]: x } }));
  const sheet = ctx.sect?.w ?? 595.3;
  const measure = (to) => setV((o) => ({ ...o, balloonUnit: to, balloonWidth: convertWidth(o.balloonWidth, o.balloonUnit, to, sheet) }));
  const result = () => {
    saveWord({ tracking: v });
    return v;
  };
  return (
    <WordDialog title="Advanced Track Changes Options" size="md" onClose={onClose} result={result}>
      <Fieldset legend="Markup">
        <MarkRow label="&Insertions:" id="ins" marks={MARKS} value={v.ins} onChange={set('ins')} />
        <MarkRow label="&Deletions:" id="del" marks={DEL_MARKS} value={v.del} onChange={set('del')} />
        <div className="flex items-center gap-4">
          <Row label="Ch&anged lines:" htmlFor="atco-lines"><Pick id="atco-lines" value={v.lines} options={LINES} onChange={set('lines')} /></Row>
          <div className="w-40"><Preview height="4rem"><LinesSample lines={v.lines} /></Preview></div>
        </div>
      </Fieldset>
      <Fieldset legend="Moves">
        <Check label="Trac&k moves" checked={v.moves} onChange={set('moves')} />
        <MarkRow label="M&oved from:" id="moveFrom" marks={DEL_MARKS} value={v.moveFrom} onChange={set('moveFrom')} />
        <MarkRow label="Mo&ved to:" id="moveTo" marks={MARKS} value={v.moveTo} onChange={set('moveTo')} />
      </Fieldset>
      <Fieldset legend="Table cell highlighting">
        <div className="grid grid-cols-[8rem_9rem_8rem_9rem] items-center gap-2">
          <Row label="Inserted ce&lls:" htmlFor="atco-ci" /><Pick id="atco-ci" value={v.cells.inserted} options={CELLS} onChange={cell('inserted')} />
          <Row label="Merged ce&lls:" htmlFor="atco-cm" /><Pick id="atco-cm" value={v.cells.merged} options={CELLS} onChange={cell('merged')} />
          <Row label="De&leted cells:" htmlFor="atco-cd" /><Pick id="atco-cd" value={v.cells.deleted} options={CELLS} onChange={cell('deleted')} />
          <Row label="Sp&lit cells:" htmlFor="atco-cs" /><Pick id="atco-cs" value={v.cells.split} options={CELLS} onChange={cell('split')} />
        </div>
      </Fieldset>
      <Fieldset legend="Formatting">
        <Check label="&Track formatting" checked={v.formatting} onChange={set('formatting')} />
        <MarkRow label="&Formatting:" id="fmt" marks={MARKS} value={v.fmt} onChange={set('fmt')} />
      </Fieldset>
      <Fieldset legend="Balloons">
        <div className="flex items-center gap-4">
          <Spin label="Preferred &width:" value={v.balloonWidth} onChange={set('balloonWidth')} unit={v.balloonUnit === 'pct' ? 'pct' : 'len'} min={0} />
          <Row label="M&easure in:" htmlFor="atco-unit">
            <Pick id="atco-unit" value={v.balloonUnit} options={[['pct', 'Percent'], ['len', UNIT_NAMES[unit] ?? 'Centimeters']]} onChange={measure} />
          </Row>
        </div>
        <Check label="&Show lines connecting to text" checked={v.balloonLines} onChange={set('balloonLines')} />
        <Row label="&Paper orientation in printing:" htmlFor="atco-orient">
          <Pick id="atco-orient" value={v.printOrientation} options={ORIENTATION} onChange={set('printOrientation')} />
        </Row>
      </Fieldset>
    </WordDialog>
  );
}

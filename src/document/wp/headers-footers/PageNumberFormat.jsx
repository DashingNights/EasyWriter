// Format Page Numbers (docs/plans/word/plan.md §3 headers-footers; probe/dialogs/page-number-format.json, 332 x 374 px): number
// format, chapter number with its style and separator, and continue or start at. Opened with {value: sect.pgNum}; resolves the new
// pgNum {fmt, start, chapStyle, chapSep}, which the command writes to the section.
import { useState } from 'react';
import { Check, Fieldset, Pick, Radio, Row, Spin } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { NUMBER_FORMATS, SEPARATORS } from './model.mjs';

const STYLES = Array.from({ length: 9 }, (_, i) => [i + 1, `Heading ${i + 1}`]);
const SEPARATOR_ITEMS = [['hyphen', '- (hyphen)'], ['period', '. (period)'], ['colon', ': (colon)'], ['emDash', `${SEPARATORS.emDash} (em-dash)`],
  ['enDash', `${SEPARATORS.enDash} (en-dash)`]];

export function PageNumberFormat({ value, onClose }) {
  const [v, setV] = useState(() => ({ fmt: 'decimal', start: null, chapStyle: null, chapSep: 'hyphen', ...value }));
  const [style, setStyle] = useState(v.chapStyle ?? 1);
  const set = (key) => (x) => setV((o) => ({ ...o, [key]: x }));
  const chapter = v.chapStyle != null;
  const sep = SEPARATORS[v.chapSep] ?? '-';
  return (
    <WordDialog title="Page Number Format" size="sm" onClose={onClose} result={() => ({ ...v, start: v.start == null ? null : Math.round(v.start) })}>
      <Row label="Number &format:" htmlFor="hf-pgnum-fmt">
        <Pick id="hf-pgnum-fmt" value={v.fmt} options={NUMBER_FORMATS} onChange={set('fmt')} optionsId="pageNumberFormat.numberFormat" />
      </Row>
      <Check label="I&nclude chapter number" checked={chapter} onChange={(on) => set('chapStyle')(on ? style : null)} />
      <div className="flex flex-col gap-2 pl-6">
        <Row label="Cha&pter starts with style:" htmlFor="hf-pgnum-style">
          <Pick id="hf-pgnum-style" value={style} options={STYLES} disabled={!chapter}
            onChange={(s) => { setStyle(s); set('chapStyle')(s); }} />
        </Row>
        <Row label="Us&e separator:" htmlFor="hf-pgnum-sep">
          <Pick id="hf-pgnum-sep" value={v.chapSep} options={SEPARATOR_ITEMS} disabled={!chapter} onChange={set('chapSep')} />
        </Row>
        <div className={chapter ? 'flex gap-6' : 'flex gap-6 opacity-50'}>
          <span>Examples:</span>
          <span>{`1${sep}1, 1${sep}A`}</span>
        </div>
      </div>
      <Fieldset legend="Page numbering">
        <Radio name="hf-pgnum-start" value={v.start == null ? 'continue' : 'start'}
          options={[['continue', '&Continue from previous section'], ['start', 'St&art at:']]}
          onChange={(k) => set('start')(k === 'continue' ? null : v.start ?? 1)} />
        <div className="pl-6" data-hf-start="">
          <Spin label={null} unit="int" min={0} max={2147483646} value={v.start ?? 1}
            onChange={(n) => set('start')(n == null ? null : n)} width="5rem" />
        </div>
      </Fieldset>
    </WordDialog>
  );
}

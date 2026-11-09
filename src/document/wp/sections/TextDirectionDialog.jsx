// Layout > Text Direction > Text Direction Options (probe/dialogs/text-direction.json, "Text Direction - Main Document"): the
// section's text direction. On a canvas draft the row passes `engine` {value: layout.textDirection's, target: section, cell or
// textbox} and the dialog writes through the engine; the DOM editor's dialog is unchanged.
import { useState } from 'react';
import { toast } from '../../../app/actions.js';
import { REASONS } from '../../../tooling/reasons.mjs';
import { ctxOf } from '../../../tooling/registry.js';
import { RadioInput } from '@/components/ui/radio';
import { Fieldset, Pick, Row } from '../../../tooling/kit/controls.jsx';
import { AccessText, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { defaultSect } from '../../defaults.mjs';
import { sectionsOf } from '../../model/sections.mjs';
import { touched, updateSect } from './model.mjs';

const CHOICES = [['lrTb', 'Horizontal'], ['tbRl', 'Vertical'], ['btLr', 'Rotate all text 270 degrees'], ['tbRlV', 'Rotate all text 90 degrees'],
  ['lrTbV', 'Rotate Asian characters 270 degrees']];
const ENGINE_CHOICES = [['horizontal', 'Horizontal'], ['down', 'Vertical'], ['up', 'Rotate all text 270 degrees'], ['rotate90', 'Rotate all text 90 degrees'],
  ['asian270', 'Rotate Asian characters 270 degrees']];
const TITLES = { section: 'Text Direction - Main Document', cell: 'Text Direction - Table Cell', textbox: 'Text Direction - Text Box' };
const PREVIEW = { down: { writingMode: 'vertical-rl' }, rotate90: { writingMode: 'vertical-rl', textOrientation: 'sideways' }, up: { writingMode: 'sideways-lr' } };

function DomDialog({ onClose }) {
  const ctx = ctxOf();
  const [apply, setApply] = useState('selected');
  const result = () => {
    const ed = ctx.ed;
    ed?.chain().focus().command(({ tr }) => {
      const list = apply === 'whole' ? sectionsOf(tr.doc).map((s) => s.index) : touched(tr.doc, tr.selection.from, tr.selection.to);
      for (const i of list) updateSect(tr, i, (old) => (old.textDir === 'lrTb' ? old : { ...old, textDir: 'lrTb' }), defaultSect(ctx.settings?.paper));
      return true;
    }).run();
    return null; // applied here, as Page Setup does
  };
  return (
    <WordDialog title="Text Direction - Main Document" size="sm" result={result} onClose={onClose}>
      <div className="flex gap-3">
        <div className="flex-1">
          <Fieldset legend="&Orientation">
            <div role="radiogroup" className="flex flex-col gap-1.5">
              {CHOICES.map(([v, label]) => (
                <label key={v} title={v === 'lrTb' ? undefined : REASONS.verticalText} className="flex w-fit items-center gap-2 has-disabled:opacity-50">
                  <RadioInput name="textDirection" checked={v === 'lrTb'} disabled={v !== 'lrTb'} readOnly />
                  <span><AccessText label={label} /></span>
                </label>
              ))}
            </div>
          </Fieldset>
        </div>
        <div className="flex-1">
          <Fieldset legend="Preview">
            <div className="flex h-24 flex-col justify-center gap-1 border border-neutral-300 bg-white px-3 text-[10px] text-black">Text</div>
          </Fieldset>
        </div>
      </div>
      <Row label="Appl&y to:" htmlFor="textDirectionApply">
        <Pick id="textDirectionApply" value={apply} onChange={setApply} options={[['selected', 'Selected text'], ['whole', 'Whole document']]} />
      </Row>
    </WordDialog>
  );
}

/** The canvas draft's dialog: the engine's direction, written through the engine on OK. */
function EngineDialog({ engine: { value, target }, onClose }) {
  const [choice, setChoice] = useState(value);
  const [apply, setApply] = useState('selected');
  const disabled = (v) => (target === 'section' && (v === 'up' || v === 'rotate90')) || (target === 'textbox' && v === 'asian270');
  const result = () => {
    Promise.resolve(ctxOf().engine?.exec('layout.textDirection', { value: choice, ...(target === 'section' && apply === 'whole' ? { all: true } : {}) }))
      .then((r) => r?.ok === false && toast(`Could not change the text direction: ${r.error ?? 'the engine refused it'}`, true));
    return null; // applied here, as Page Setup does
  };
  return (
    <WordDialog title={TITLES[target] ?? TITLES.section} size="sm" result={result} onClose={onClose}>
      <div className="flex gap-3">
        <div className="flex-1">
          <Fieldset legend="&Orientation">
            <div role="radiogroup" className="flex flex-col gap-1.5">
              {ENGINE_CHOICES.map(([v, label]) => (
                <label key={v} className="flex w-fit items-center gap-2 has-disabled:opacity-50">
                  <RadioInput name="textDirection" value={v} checked={choice === v} disabled={disabled(v)}
                    onChange={() => setChoice(v)} />
                  <span><AccessText label={label} /></span>
                </label>
              ))}
            </div>
          </Fieldset>
        </div>
        <div className="flex-1">
          <Fieldset legend="Preview">
            <div className="flex h-24 flex-col justify-center gap-1 border border-neutral-300 bg-white px-3 text-[10px] text-black" style={PREVIEW[choice]}>
              文字 Text
            </div>
          </Fieldset>
        </div>
      </div>
      <div className={target === 'section' ? undefined : 'invisible'}>
        <Row label="Appl&y to:" htmlFor="textDirectionApply">
          <Pick id="textDirectionApply" value={apply} onChange={setApply} options={[['selected', 'Selected text'], ['whole', 'Whole document']]} />
        </Row>
      </div>
    </WordDialog>
  );
}

export function TextDirectionDialog({ engine, onClose }) {
  return engine ? <EngineDialog engine={engine} onClose={onClose} /> : <DomDialog onClose={onClose} />;
}

// The Compare Documents and Combine Documents dialogs (docs/plans/word plan.md §3 compare; probe/dialogs/compare-documents.json and
// combine-documents.json): the original and revised drafts with their labels, Swap, << Less and More >>, the Comparison settings and
// Show changes. It resolves {original, revised (draft ids), label, opts}; the command does the work (run.js compareDrafts).
// Deviations: Word's combo boxes list recent files, ours list Documents newest first, and Browse opens that list; OK refuses (with a
// message) instead of being disabled until two different documents are picked.
import { useId, useRef, useState } from 'react';
import { ArrowLeftRight, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useStore } from '../../../app/store.js';
import { Check, Fieldset, Pick, Radio } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { DEFAULTS, SETTINGS } from './compare.mjs';
import { userName } from './run.js';

const LEVELS = [['char', '&Character level'], ['word', '&Word level']];
const WHERE = [['original', 'Original documen&t'], ['revised', 'Rev&ised document'], ['new', 'New doc&ument']];

// One side: the document box with its Browse button, and its label box (enabled once a document is picked).
function Side({ label, pickLabel, browse, value, onPick, text, onText, docs, side }) {
  const id = useId();
  const box = useRef(null);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={`${id}-doc`} {...accessProps(label)}><AccessText label={label} /></label>
      <div className="flex gap-1">
        <Pick id={`${id}-doc`} ref={box} data-compare={side} value={value} onChange={onPick} options={[['', ''], ...docs]} className="min-w-0 flex-1" />
        <Button type="button" variant="outline" size="icon-xs" aria-label={browse} title={browse}
          onClick={() => { box.current?.focus(); box.current?.showPicker?.(); }}><FolderOpen className="size-3.5" /></Button>
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-label`} className="shrink-0" {...accessProps(pickLabel)}><AccessText label={pickLabel} /></label>
        <Input id={`${id}-label`} size="xs" data-compare={`${side}Label`} disabled={!value} value={text} onChange={(e) => onText(e.target.value)}
          className="min-w-0 flex-1" />
      </div>
    </div>
  );
}

/** The dialog; `kind` 'compare' or 'combine'. */
export function CompareDialog({ kind = 'compare', onClose }) {
  const drafts = useStore((s) => s.drafts);
  // Documents newest first (the store keeps drafts by last update); Word lists recent files here.
  const docs = drafts.filter((d) => d.format === 'document').map((d) => [d.id, d.title || 'Untitled']);
  const [original, setOriginal] = useState('');
  const [revised, setRevised] = useState('');
  const [labels, setLabels] = useState({ original: userName(), revised: userName() });
  const [opts, setOpts] = useState(DEFAULTS);
  const [more, setMore] = useState(true); // Word opens it with the settings shown
  const combine = kind === 'combine';
  const pickLabel = (word) => `${word} ${combine ? 'unmarked changes with:' : 'changes with'}`;
  const set = (k) => (v) => setOpts((o) => ({ ...o, [k]: v }));
  const swap = () => {
    setOriginal(revised);
    setRevised(original);
    setLabels((l) => ({ original: l.revised, revised: l.original }));
  };
  return (
    <WordDialog title={combine ? 'Combine Documents' : 'Compare Documents'} size="lg" onClose={onClose}
      left={[{ label: more ? '<< &Less' : 'More >>', onClick: () => setMore(!more) }]}
      validate={() => (!original || !revised ? 'Pick an original and a revised document.' : original === revised ? 'Pick two different documents.' : '')}
      result={() => ({ original, revised, label: labels.revised.trim() || userName(), opts })}>
      <div data-compare-dialog={combine ? 'combineDocuments' : 'compareDocuments'} className="flex flex-col gap-3">
        <div className="flex items-end gap-3">
          <Side side="original" label="&Original document" pickLabel={pickLabel('Lab&el')} browse="Browse for Original" docs={docs} value={original}
            onPick={(v) => setOriginal(v ?? '')} text={labels.original} onText={(v) => setLabels((l) => ({ ...l, original: v }))} />
          <Button type="button" variant="outline" size="icon-xs" aria-label="Swap Documents" title="Swap Documents" disabled={!original || !revised} onClick={swap}
            className="mb-8"><ArrowLeftRight className="size-3.5" /></Button>
          <Side side="revised" label="&Revised document" pickLabel={pickLabel('La&bel')} browse="Browse for Revised" docs={docs}
            value={revised} onPick={(v) => setRevised(v ?? '')} text={labels.revised} onText={(v) => setLabels((l) => ({ ...l, revised: v }))} />
        </div>
        {more && (
          <>
            <Fieldset legend="Comparison settings">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                <Check label="Insertions and deletions" checked disabled onChange={() => {}} />
                {SETTINGS.map(([k, label]) => <Check key={k} label={label} checked={opts[k]} onChange={set(k)} />)}
              </div>
            </Fieldset>
            <Fieldset legend="Show changes">
              <div className="grid grid-cols-2 gap-x-6">
                <div className="flex flex-col gap-1.5" data-compare="level"><span>Show changes at:</span><Radio value={opts.level} options={LEVELS} onChange={set('level')} /></div>
                <div className="flex flex-col gap-1.5" data-compare="where"><span>Show changes in:</span><Radio value={opts.where} options={WHERE} onChange={set('where')} /></div>
              </div>
            </Fieldset>
          </>
        )}
      </div>
    </WordDialog>
  );
}

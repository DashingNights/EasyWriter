// Paste Special (docs/plans/word plan.md §3 clipboard; probe/dialogs/paste-special.json): the Source line, Paste and Paste link
// (disabled: linked objects), the As list built from the clipboard, Display as icon (disabled) and the Result line in our words.
// Resolves with the picked format id ('html', 'text', 'unicode', 'png') or null; the command pastes it.
import { useState } from 'react';
import { cn } from 'cn';
import { RadioInput } from '@/components/ui/radio';
import { REASONS } from '../../../tooling/reasons.mjs';
import { Check, Fieldset, rowClass } from '../../../tooling/kit/controls.jsx';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { sourceKind } from './modes.mjs';

const RESULTS = {
  object: REASONS.ole,
  html: 'Inserts the contents of the clipboard as HTML.',
  text: 'Inserts the contents of the clipboard as text without any formatting.',
  unicode: 'Inserts the contents of the clipboard as Unicode text without any formatting.',
  png: 'Inserts the contents of the clipboard as a picture.',
};
const SOURCES = { ours: 'A document', word: 'Another program', html: 'A web page or another program' };

/** The As list for clipboard `data` → [{id, label, disabled}]. The object format names a document object generically (plan.md §1.4
 * Names: Word's label is Microsoft Word Document Object). */
export function formatsOf(data) {
  const kind = sourceKind(data);
  const out = [];
  if (kind === 'ours' || kind === 'word') out.push({ id: 'object', label: 'Document Object', disabled: true });
  if (data.html && kind !== 'text') out.push({ id: 'html', label: 'HTML Format' });
  if (data.text) out.push({ id: 'text', label: 'Unformatted Text' }, { id: 'unicode', label: 'Unformatted Unicode Text' });
  if (data.image) out.push({ id: 'png', label: 'Picture (PNG)' });
  return out;
}

/** The Paste Special dialog for clipboard `data`. */
export function PasteSpecialDialog({ data = {}, onClose }) {
  const formats = formatsOf(data);
  const [as, setAs] = useState(formats.find((f) => !f.disabled)?.id ?? null);
  const move = (d) => {
    const live = formats.filter((f) => !f.disabled);
    const i = live.findIndex((f) => f.id === as);
    const next = live[Math.min(live.length - 1, Math.max(0, i + d))];
    if (next) setAs(next.id);
  };
  return (
    <WordDialog title="Paste Special" size="md" onClose={onClose} result={() => as} validate={() => (as ? null : 'The clipboard is empty.')}>
      <div className="flex gap-2"><span>Source:</span><span data-source="">{SOURCES[sourceKind(data)] ?? 'Unknown'}</span></div>
      <div className="flex gap-4">
        <div role="radiogroup" className="flex flex-col gap-1.5 pt-1">
          <label className="flex w-fit items-center gap-2" {...accessProps('&Paste:')}>
            <RadioInput name="pasteSpecialHow" checked readOnly />
            <AccessText label="&Paste:" />
          </label>
          <label className="flex w-fit items-center gap-2 opacity-50" title={REASONS.ole}>
            <RadioInput name="pasteSpecialHow" disabled checked={false} readOnly />
            <AccessText label="Paste &link:" />
          </label>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="paste-special-as" {...accessProps('&As:')}><AccessText label="&As:" /></label>
          <div id="paste-special-as" role="listbox" tabIndex={0} aria-label="As" data-as=""
            onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); move(e.key === 'ArrowUp' ? -1 : 1); } }}
            className="h-36 overflow-auto rounded-md border border-input bg-background text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            {formats.map((f) => (
              <div key={f.id} role="option" data-format={f.id} aria-selected={f.id === as} aria-disabled={f.disabled || undefined}
                title={f.disabled ? REASONS.ole : undefined} onClick={() => !f.disabled && setAs(f.id)}
                className={cn('cursor-default truncate px-1.5 py-0.5', f.disabled ? 'text-muted-foreground' : rowClass(f.id === as))}>
                {f.label}
              </div>
            ))}
          </div>
        </div>
        <div className="pt-6"><Check label="&Display as icon" checked={false} disabled onChange={() => {}} /></div>
      </div>
      <Fieldset legend="Result">
        <p data-result="" className="text-xs">{as ? RESULTS[as] : 'The clipboard holds nothing to paste.'}</p>
      </Fieldset>
    </WordDialog>
  );
}

// The Number dialog (Insert > Number, probe/dialogs/number.json): a number and Word's 18 number types. OK inserts the number as plain
// text through the shared number formatter (fields/numfmt.mjs numberText, plan.md §1.10), so it matches \* field formats and lists.
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { NativeListBox } from '@/components/ui/select';
import { numberText } from '../../fields/numfmt.mjs';
import { AccessText, accessProps, WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ctxOf } from '../../../tooling/registry.js';
import { NUMBER_TYPES, numberIn } from './chars.mjs';
import { insertText } from './insert.js';

const MAX = 999999;

/** Typed text `t` as a whole number from 0 to MAX, else null. */
const wholeOf = (t) => (/^\s*\d{1,6}\s*$/.test(t) ? Number(t) : null);

/** → the inserted text, or null when cancelled. */
export function NumberDialog({ onClose }) {
  const [text, setText] = useState('');
  const [type, setType] = useState(0);
  const numId = useId();
  const typeId = useId();
  const n = wholeOf(text);
  const out = n == null ? null : numberIn(n, NUMBER_TYPES[type][1], numberText);

  const validate = () => {
    if (n == null) return `Type a whole number from 0 to ${MAX}.`;
    if (out == null) return `This number type can't show ${n}.`;
    return null;
  };
  const result = () => (insertText(ctxOf(), out) ? out : null);

  return (
    <WordDialog title="Number" size="sm" onClose={onClose} validate={validate} result={result}>
      <div className="flex flex-col gap-1">
        <label htmlFor={numId} {...accessProps('&Number')}><AccessText label="&Number" /></label>
        <Input id={numId} autoFocus value={text} spellCheck={false} inputMode="numeric" onChange={(e) => setText(e.target.value)} size="xs" className="tabular-nums" />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={typeId} {...accessProps('Number &type')}><AccessText label="Number &type" /></label>
        {/* A list box (size), as Word's: the harness and the keyboard pick by its option text. */}
        <NativeListBox id={typeId} size={6} value={String(type)} options={NUMBER_TYPES.map(([label], i) => [i, label])} onChange={(e) => setType(Number(e.target.value))} />
      </div>
    </WordDialog>
  );
}

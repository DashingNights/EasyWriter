// The Navigation pane's Find Options dialog (search menu > Options...). OK applies the options for this session; Set As Default
// also saves them to settings.word.find, which the Find and Replace dialog seeds from. No probe captured this dialog, so the
// access keys are ours (Word's labels).
import { useState } from 'react';
import { saveWord } from '../../word/settings.mjs';
import { Check } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';

let session = null; // the options OK applied, over settings.word.find, until the app restarts

/** The search options in force: settings.word.find (`word`, wordSettings') with this session's changes over it. */
export const findOpts = (word) => ({ ...word?.find, ...session });

const LEFT = [['matchCase', 'Match &case'], ['wholeWord', 'Find &whole words only'], ['wildcards', '&Use wildcards'],
  ['soundsLike', 'Sounds li&ke (English)'], ['allForms', 'Find all word f&orms (English)'], ['highlightAll', '&Highlight all'],
  ['incremental', '&Incremental find']];
const RIGHT = [['prefix', 'Match &prefix'], ['suffix', 'Match &suffix'], ['ignorePunct', 'Ignore pu&nctuation characters'],
  ['ignoreSpace', 'Ignore white-space charac&ters']];
// Use wildcards turns these off, as in Find and Replace.
const WILD_OFF = new Set(['matchCase', 'wholeWord', 'soundsLike', 'allForms', 'prefix', 'suffix', 'ignorePunct', 'ignoreSpace']);

/** → the options object, or null on Cancel. Props: {value} the options in force. */
export function FindOptions({ value, onClose }) {
  const [v, setV] = useState(value ?? {});
  const box = ([key, label]) => (
    <Check key={key} label={label} checked={!!v[key]} disabled={v.wildcards && WILD_OFF.has(key)}
      onChange={(on) => setV((o) => ({ ...o, [key]: on }))} />
  );
  const done = (keep) => {
    session = { ...v };
    if (keep) saveWord({ find: session });
    return session;
  };
  return (
    <WordDialog title="Find Options" size="md" onClose={(r) => onClose(r ? done(false) : null)} result={() => true}
      left={[{ label: 'Set As &Default', onClick: () => onClose(done(true)) }]}>
      <div data-find-options="" className="grid grid-cols-2 gap-x-6 gap-y-2">
        <div className="flex flex-col gap-2">{LEFT.map(box)}</div>
        <div className="flex flex-col gap-2">{RIGHT.map(box)}</div>
      </div>
    </WordDialog>
  );
}

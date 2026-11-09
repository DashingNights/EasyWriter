// The Date and Time dialog (docs/plans/word/plan.md §1.6; probe/dialogs/date-and-time.json): Available formats, Language, Use full
// width characters (East Asian languages only), Update automatically, Set As Default. → {code} for a DATE (or TIME) field when
// Update automatically is on, else {text}; OK also records the picture DATE \l reads.
import { useMemo, useState } from 'react';
import { getState } from '../../../app/store.js';
import { Check, ListPick, Pick, Row } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { saveWord, wordSettings } from '../../word/settings.mjs';
import { dateCode } from './commands.js';
import { DATE_PICTURES } from './FieldDialog.jsx';
import { datePicture } from './format.mjs';
import { fullWidth } from './numbers.mjs';

const EAST_ASIAN = /^(zh|ja|ko)\b/;

/** The language's display name in English ('English (United States)'), or the tag itself. */
function languageName(tag) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export function DateTimeDialog({ onClose }) {
  const word = wordSettings(getState().settings);
  const langs = word.proofing?.languages?.length ? word.proofing.languages : ['en-US'];
  const [lang, setLang] = useState(word.dateTime?.lang && langs.includes(word.dateTime.lang) ? word.dateTime.lang : langs[0]);
  const [pic, setPic] = useState(word.dateTime?.format ?? DATE_PICTURES[0]);
  const [full, setFull] = useState(false);
  const [update, setUpdate] = useState(!!word.dateTime?.update);
  const now = useMemo(() => new Date(), []);
  const east = EAST_ASIAN.test(lang);
  // ponytail: the 17 en-US pictures in every language, with names through Intl; another language's own list is unverified.
  const items = DATE_PICTURES.map((x) => [x, datePicture(now, x, { lang })]);
  const result = () => {
    saveWord({ dateTime: { ...word.dateTime, last: pic } });
    if (update) return { code: dateCode(pic) };
    const text = datePicture(new Date(), pic, { lang });
    return { text: full && east ? fullWidth(text) : text };
  };
  return (
    <WordDialog title="Date and Time" size="md" onClose={onClose} result={result}
      left={[{ label: 'Set As &Default', onClick: () => saveWord({ dateTime: { ...word.dateTime, format: pic, lang, update } }) }]}>
      <div className="flex gap-4">
        <Row label="&Available formats:" htmlFor="dt-formats">
          <ListPick id="dt-formats" width="18rem" height="18rem" items={items} value={pic} onChange={setPic} />
        </Row>
        <div className="flex flex-1 flex-col gap-2">
          <Row label="&Language:" htmlFor="dt-lang">
            <Pick id="dt-lang" value={lang} options={langs.map((l) => [l, languageName(l)])} onChange={setLang} />
          </Row>
          <div className="flex-1" />
          {east ? <Check label="Use full &width characters" checked={full} onChange={setFull} /> : null}
          <Check label="&Update automatically" checked={update} onChange={setUpdate} />
        </div>
      </div>
    </WordDialog>
  );
}

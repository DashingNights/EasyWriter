// Word's Enclose Characters dialog (docs/plans/word/probe/dialogs/enclose-characters.json): Style None, Shrink text or Enlarge
// symbol, the Text box over a list of characters and the Enclosure list. → {style, text, enclosure}; the command writes the field.
import { useState } from 'react';
import { Fieldset, ListPick, Radio, Row } from '../../../tooling/kit/controls.jsx';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { ENCLOSURES } from './eq.mjs';

// The list under Text as Word fills it before any use (probe).
const RECENT = ['A', 'a', '!', '1', '21', '一', '壹', '印'];

/** Props: text (the selection's first character), enclosure and style (an enclosed character's own, else Word's defaults). */
export function EncloseDialog({ text = '', enclosure = ENCLOSURES[0], style = 'shrink', onClose }) {
  const [v, setV] = useState({ style, text, enclosure });
  const set = (key) => (value) => setV((o) => ({ ...o, [key]: value }));
  const recent = [...new Set([text, ...RECENT].filter(Boolean))].map((c) => [c, c]);
  return (
    <WordDialog title="Enclose Characters" size="sm" onClose={onClose} result={() => v}
      validate={() => (v.style !== 'none' && !v.text ? 'Type the character to enclose.' : null)}>
      <Fieldset legend="Style">
        <Radio value={v.style} onChange={set('style')} options={[['none', '&None'], ['shrink', '&Shrink text'], ['enlarge', '&Enlarge symbol']]} />
      </Fieldset>
      <Fieldset legend="Enclosure">
        <div className="flex gap-4">
          <Row label="&Text:" htmlFor="fd-enclose-text">
            <ListPick id="fd-enclose-text" aria-label="Text" items={recent} value={v.text} text={v.text} width="8rem"
              onChange={set('text')} onText={set('text')} />
          </Row>
          <Row label="Encl&osure:" htmlFor="fd-enclose-shape">
            <ListPick id="fd-enclose-shape" aria-label="Enclosure" items={ENCLOSURES.map((e) => [e, e])} value={v.enclosure} width="8rem"
              onChange={set('enclosure')} />
          </Row>
        </div>
      </Fieldset>
    </WordDialog>
  );
}

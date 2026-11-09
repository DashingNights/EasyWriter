// Table Layout > Data > Formula (probe/dialogs/formula.json): Formula (=SUM(ABOVE) or =SUM(LEFT) by what the cell sees, else =),
// Number format (the seven pictures, editable), Paste function and Paste bookmark. OK writes the = field in the cell and computes it.
import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { targetEditor } from '../../../tooling/registry.js';
import { WordDialog } from '../../../tooling/kit/WordDialog.jsx';
import { Pick } from '../../../tooling/kit/controls.jsx';
import { insertField } from '../../fields/engine.js';
import { listedBookmarks } from './bookmarks.mjs';
import { Label } from './BookmarkDialog.jsx';
import { proposedFormula } from './cells.mjs';
import { FUNCTIONS, PICTURES } from './formula.mjs';

/** The field code OK writes for `formula` ("=SUM(ABOVE)") and number format `picture`. */
export function formulaCode(formula, picture) {
  const body = String(formula).trim().replace(/^=?\s*/, '');
  return `=${body ? ` ${body}` : ''}${picture ? ` \\# "${picture.replace(/"/g, '\\"')}"` : ''}`;
}

/** On a canvas draft (`engine`: {formula}) OK returns the field code for table.formula and Paste bookmark lists none. */
export function FormulaDialog({ editor = targetEditor(), engine = null, onClose }) {
  const [formula, setFormula] = useState(() => (engine ? engine.formula : editor ? proposedFormula(editor.state.doc, editor.state.selection.from) : '='));
  const [picture, setPicture] = useState('');
  const box = useRef(null);
  if (!editor && !engine) return null;
  // Paste function and Paste bookmark put their text at the caret in the Formula box, as Word does.
  const paste = (text, inside = 0) => {
    const el = box.current;
    const at = el?.selectionStart ?? formula.length;
    const end = el?.selectionEnd ?? at;
    setFormula(formula.slice(0, at) + text + formula.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length - inside, at + text.length - inside);
    });
  };
  const result = () => {
    if (engine) return formulaCode(formula, picture);
    insertField(editor, formulaCode(formula, picture));
    return formula;
  };
  return (
    <WordDialog title="Formula" size="sm" onClose={onClose} result={result} validate={() => (formula.trim().replace(/^=/, '').trim() ? null : 'Type a formula first.')}>
      <Label htmlFor="fr-formula" label="&Formula:" />
      <Input id="fr-formula" ref={box} size="xs" value={formula} autoFocus onChange={(e) => setFormula(e.target.value)} />
      <Label htmlFor="fr-formula-format" label="&Number format:" />
      <Input id="fr-formula-format" size="xs" value={picture} list="fr-formula-pictures" onChange={(e) => setPicture(e.target.value)} />
      <datalist id="fr-formula-pictures">{PICTURES.map((p) => <option key={p} value={p} />)}</datalist>
      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="fr-formula-fn" label="Paste f&unction:" />
          <Pick id="fr-formula-fn" value="" options={[['', ''], ...FUNCTIONS.map((f) => [f, f])]} onChange={(f) => f && paste(`${f}()`, 1)} />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="fr-formula-bm" label="Paste &bookmark:" />
          <Pick id="fr-formula-bm" value="" options={[['', ''], ...(editor ? listedBookmarks(editor.state.doc) : []).map((b) => [b.name, b.name])]} onChange={(b) => b && paste(b)} />
        </div>
      </div>
    </WordDialog>
  );
}
